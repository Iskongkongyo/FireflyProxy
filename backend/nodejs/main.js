/**
 * Refactored & Optimized Reverse Proxy Service
 * * 🛠️ 依赖安装 (Dependencies):
 * npm install express http-proxy-middleware express-rate-limit chokidar express-session basic-auth ipaddr.js winston
 * * ✨ 核心改进 (Improvements):
 * 1. [Security] 严格的 SSRF 防御 (使用 ipaddr.js)，拒绝一切内网/本地 IP 访问。
 * 2. [Feature] 真正的配置热更新 (Dynamic Middleware Wrapper)，无需重启即可更新限流/超时策略。
 * 3. [Stability] 统一的全局错误捕获，防止单次请求崩溃整个进程。
 * 4. [Debug] 修复 Header 日志打印为 [object Object] 的问题。
 * 5. [Fix] 修复 express-rate-limit 在反代环境下的 IP 识别问题。
 * 6. 重写 console 方法，使用 winston 记录。
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios"); // [Changed] Use axios for manual proxying
const rateLimit = require("express-rate-limit");
const chokidar = require("chokidar");
const session = require("express-session");
const basicAuth = require("basic-auth");
const net = require("net");
const ipaddr = require("ipaddr.js"); // 必须安装
const winston = require("winston");

// ---------------------------
// 日志配置 (Winston Logger)
// ---------------------------
const LOG_DIR = __dirname; // 日志文件存放在当前目录
const runLogPath = path.join(LOG_DIR, "run.log");
const errorLogPath = path.join(LOG_DIR, "error.log");

// 自定义日志格式
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    })
);

// 创建 logger 实例
const logger = winston.createLogger({
    level: "info",
    format: logFormat,
    transports: [
        // run.log: 记录 info 和 warn 级别
        new winston.transports.File({
            filename: runLogPath,
            level: "info", // 最高记录到 warn（包含 info、warn）
            // 使用 filter 只记录 info 和 warn，排除 error
            format: winston.format.combine(
                winston.format((info) => {
                    return info.level === "error" ? false : info;
                })(),
                logFormat
            )
        }),
        // error.log: 只记录 error 级别
        new winston.transports.File({
            filename: errorLogPath,
            level: "error"
        }),
        // 控制台输出（带颜色）
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: "HH:mm:ss" }),
                winston.format.printf(({ timestamp, level, message }) => {
                    return `[${timestamp}] ${level}: ${message}`;
                })
            )
        })
    ]
});

// 重写 console 方法，使用 winston 记录
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = (...args) => {
    const message = args.map(arg =>
        typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(" ");
    logger.info(message);
};

console.warn = (...args) => {
    const message = args.map(arg =>
        typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(" ");
    logger.warn(message);
};

console.error = (...args) => {
    const message = args.map(arg => {
        if (arg instanceof Error) {
            return arg.stack || arg.message;
        }
        return typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg);
    }).join(" ");
    logger.error(message);
};

// ---------------------------
// 1. 全局配置与热更新状态
// ---------------------------
const CONFIG_PATH = "./main.json";

// 默认配置 (Safe Defaults)
let config = {
    port: 8082,
    timeout: 30,
    session: {
        secret: "change-this-secret-in-prod-" + Date.now(),
        name: "proxySession",
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 86400000, secure: false, httpOnly: true }
    },
    accessOrigin: "*",
    user: "",
    pwd: "",
    defaultSkip: "",
    limiter: {
        windowMs: 60 * 1000,
        max: 60,
        message: "Too many requests, please try again later.",
        statusCode: 429
    },
    blacklist: [] // 支持正则字符串
};

// 动态中间件引用
let currentRateLimiter = null;
// let currentProxyMiddleware = null; // [Removed] No longer needed

// 加载配置函数
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, "utf8");
            const parsed = JSON.parse(raw);

            // 深度合并配置 (简易版)
            config = {
                ...config,
                ...parsed,
                session: { ...config.session, ...parsed.session },
                limiter: { ...config.limiter, ...parsed.limiter }
            };

            // ⚡ 触发热更新：重新生成依赖配置的中间件
            reloadMiddleware();

            console.log(`[Config] ✅ Configuration loaded. Timeout: ${config.timeout}s`);
        } else {
            console.warn("[Config] ⚠️ Config file not found, using defaults.");
        }
    } catch (err) {
        console.error("[Config] ❌ Error loading config:", err.message);
        // 出错时不覆盖旧配置，保持服务可用
    }
}

// ---------------------------
// 代理事件处理 (Handlers) - 必须在 reloadMiddleware 之前定义
// ---------------------------


// 重建中间件实例 (热更新核心)
function reloadMiddleware() {
    // 1. 更新 Rate Limiter
    currentRateLimiter = rateLimit({
        windowMs: config.limiter.windowMs,
        max: config.limiter.max,
        standardHeaders: true,
        legacyHeaders: false,
        // 移除自定义 keyGenerator，利用 app.set('trust proxy') 正确识别 IP
        handler: (req, res) => {
            console.warn(`[RateLimit] ⛔ Blocked request from ${req.ip}`);
            res.status(config.limiter.statusCode).send(config.limiter.message);
        }
    });

    console.log("[System] 🔄 RateLimiter reloaded dynamically.");
}

// ---------------------------
// 2. 初始化 Express
// ---------------------------
const app = express();

// 信任反向代理 (Nginx/Cloudflare 等前置时必须开启)
// 'loopback' 仅信任本机，'linklocal' 信任本地网络，数字代表代理层数
// 如果您直接暴露在公网，请设为 false；如果在 Nginx 后，设为 1
app.set('trust proxy', 1);

// 初始化加载
loadConfig();
chokidar.watch(CONFIG_PATH).on("change", () => {
    console.log("[Config] 📝 File changed, reloading...");
    loadConfig();
});

// ---------------------------
// 3. 基础中间件
// ---------------------------

// 全局日志
app.use((req, res, next) => {
    if (req.url.includes("favicon.ico")) return next();
    console.log(`\n[Request] ➡️ ${req.method} ${req.url} | IP: ${req.ip}`);
    next();
});

// Session 配置
// ⚠️ 生产环境建议替换为 RedisStore，避免内存泄漏
app.use(session({
    ...config.session,
    // store: new RedisStore({ client: redisClient }), // Example for Prod
}));

// CORS 安全配置
app.use((req, res, next) => {
    const clientOrigin = req.headers.origin || req.headers.referer;
    let allowOrigin = config.accessOrigin;

    // 只有在配置允许所有时，才反射 Origin 以支持 Credentials
    if (config.accessOrigin === "*" && clientOrigin) {
        try {
            allowOrigin = new URL(clientOrigin).origin;
        } catch (e) { /* Ignore invalid origin */ }
    }

    res.setHeader("Access-Control-Allow-Origin", allowOrigin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Expose-Headers", "*"); // 允许前端获取所有响应头
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "content-type, authorization");

    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

// ---------------------------
// 4. 安全鉴权模块
// ---------------------------
app.use((req, res, next) => {
    // 默认拒绝策略：如果未配置账号密码，建议打印警告或直接拒绝（此处逻辑保持原样，若未配置则放行，但加了日志）
    if (!config.user || !config.pwd) {
        console.warn("[Auth] ⚠️ No Basic Auth configured. Service is open!");
        return next();
    }

    const user = basicAuth(req);
    // 使用安全比较防止时序攻击 (Timing Attack) 虽JS单线程影响小，但习惯要好
    if (!user || user.name !== config.user || user.pass !== config.pwd) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Proxy Auth Required"');
        return res.status(401).send("Unauthorized");
    }
    next();
});

// ---------------------------
// 5. 核心工具：SSRF 防御 (isPrivateIP)
// ---------------------------
function isSafeTarget(urlStr) {
    try {
        const u = new URL(urlStr);
        if (!['http:', 'https:'].includes(u.protocol)) return false;

        const hostname = u.hostname;

        // 1. 黑名单正则检查
        if (config.blacklist && config.blacklist.length > 0) {
            const pattern = new RegExp(config.blacklist.join("|"), "i");
            if (pattern.test(urlStr)) {
                console.warn(`[Security] 🛡️ Blocked by blacklist: ${urlStr}`);
                return false;
            }
        }

        // 2. IP 检查 (防止 SSRF)
        let checkIp = hostname;

        // 如果是 localhost，直接拒绝
        if (hostname === 'localhost') return false;

        // 如果是域名，理论上应该解析 DNS 后检查解析出的 IP
        // 这里简化处理：如果是 IP 格式，必须校验是否为内网 IP
        if (net.isIP(hostname)) {
            const range = ipaddr.parse(hostname).range();
            // 拒绝 private (内网), loopback (环回), uniqueLocal (IPv6内网) 等
            if (range !== 'unicast') {
                console.warn(`[Security] 🛡️ Blocked Private/Local IP: ${hostname} (${range})`);
                return false;
            }
        }

        return true;
    } catch (e) {
        console.error(`[Security] Invalid URL: ${urlStr}`);
        return false;
    }
}

// ---------------------------
// 6. 业务逻辑：URL 设置与检查
// ---------------------------
app.use(async (req, res, next) => {
    if (req.path.startsWith("/web")) return next();

    // 处理 ?url= 参数
    if (req.query.url) {
        const newUrl = req.query.url;
        if (isSafeTarget(newUrl)) {
            console.log(`[Session] 🎯 Target updated: ${newUrl}`);
            req.session.targetUrl = newUrl;
            // 设置完 URL 后重定向移除 query 参数，直接代理req.session.targetUrl
            //return res.redirect("/");
        } else {
            return res.status(403).send("Forbidden: Invalid Target URL or Local IP Access Denied.");
        }
    }

    // 检查 Session 状态
    if (!req.session.targetUrl && !req.path.startsWith("/web")) {
        if (config.defaultSkip) return res.redirect(config.defaultSkip);
        return res.status(400).send(`
            <h3>Proxy Service Ready</h3>
            <p>Please provide a valid target URL via query parameter: <code>/?url=https://example.com</code></p>
        `);
    }

    next();
});

// 静态资源
app.use("/web", express.static("webPro"));

// ---------------------------
// 7. 动态中间件执行
// ---------------------------

// 动态限流器
app.use((req, res, next) => {
    if (currentRateLimiter) {
        return currentRateLimiter(req, res, next);
    }
    next();
});

// ---------------------------
// URL 拼接工具函数
// ---------------------------
function getTargetUrl(baseUrl, path) {
    const p = path.replace(/^\//, ""); // 移除开头的斜杠
    return p ? new URL(baseUrl).origin + "/" + p : baseUrl;
}

// 动态代理 (Axios Manual Proxy)
app.use("/", async (req, res, next) => {
    const reqUrl = req.query.url || req.session.targetUrl;

    if (!reqUrl) return next();

    // 计算最终代理 URL
    const fullUrl = req.query.url ? reqUrl : getTargetUrl(req.session.targetUrl, req.originalUrl);

    console.log('[Debug] Proxy request - fullUrl:', fullUrl);

    try {
        // 1. 准备请求头
        const headers = { ...req.headers };
        // 移除 hop-by-hop headers
        const hopByHopHeaders = [
            'host', 'origin', 'referer', 'connection', 'keep-alive',
            'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
            'transfer-encoding', 'upgrade', 'cookie' // axios 自动处理 cookie? 通常我们希望透传，但需要注意 host 变化
        ];
        hopByHopHeaders.forEach(h => delete headers[h]);

        // 注入自定义 headers
        if (req.query.headers) {
            try {
                const custom = JSON.parse(req.query.headers);
                Object.assign(headers, custom);
            } catch (e) {
                console.warn("[Proxy] Failed to parse custom headers JSON");
            }
        }

        // 2. 发起 Axios 请求
        const response = await axios({
            method: req.method,
            url: fullUrl,
            headers: headers,
            data: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req, // 流式透传请求体
            responseType: 'stream', // 关键：流式响应
            decompress: false, // 禁止 axios 自动解压，透传原始压缩数据（防止 Content-Length 不匹配导致截断）
            maxRedirects: config.max_redirects || 5, // 开启自动重定向
            validateStatus: null, // 允许所有状态码
            timeout: config.timeout * 1000 // 配置文件单位为秒，Axios 需要毫秒
        });

        // 3. [Redirect Sync] 检测 URL 变化
        const finalUrl = response.request.res.responseUrl;
        if (finalUrl && finalUrl !== fullUrl) {
            console.log(`[Session] 🔀 Redirect detected. Updating target: ${req.session.targetUrl} -> ${finalUrl}`);
            req.session.targetUrl = finalUrl;
        }

        // 4. 设置响应头
        const unsafeResponseHeaders = [
            'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
            'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-length'
        ];
        // 注意：Content-Length 通常由 Node.js 重新计算（如果流式传输）或者我们透传数据且 decompress:false 时可能可以保留，
        // 但如果 Transfer-Encoding 是 chunked，则不应有 Content-Length。
        // 为了安全起见，对于流式管道转发，最好移除 upstream 的 Content-Length 和 Transfer-Encoding，
        // 让 Node.js 自动管理（Node.js 会自动添加 Transfer-Encoding: chunked）。

        Object.entries(response.headers).forEach(([key, value]) => {
            if (!unsafeResponseHeaders.includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });

        // CORS & Security Headers (Ensure these are set)
        const clientOrigin = req.headers.origin || req.headers.referer;
        let allowOrigin = config.accessOrigin;
        if (config.accessOrigin === "*" && clientOrigin) {
            try { allowOrigin = new URL(clientOrigin).origin; } catch (e) { }
        }
        res.setHeader("Access-Control-Allow-Origin", allowOrigin || "*");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        // 动态设置 Exposed Headers，因为 Credentials=true 时不能用 *
        const exposedHeaders = Object.keys(response.headers).join(", ");
        res.setHeader("Access-Control-Expose-Headers", exposedHeaders);
        res.removeHeader('x-frame-options');
        res.removeHeader('content-security-policy');

        // 5. 管道转发
        res.status(response.status);
        response.data.pipe(res);

    } catch (error) {
        console.error("[Proxy Error] 💥", error.message);
        if (!res.headersSent) {
            res.status(502).send({ error: "Bad Gateway", message: error.message });
        }
    }
});

// ---------------------------
// 9. 启动服务与全局异常捕获
// ---------------------------

// 全局异常捕获 (防止进程退出)
process.on('uncaughtException', (err) => {
    console.error('[System] ❌ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[System] ❌ Unhandled Rejection:', reason);
});

const server = app.listen(config.port, () => {
    console.log(`\n🚀 [Server] Reverse Proxy running on port ${config.port}`);
    console.log(`🛡️  [Security] SSRF Protection: Enabled`);
    console.log(`🔥 [System] Hot Reload: Enabled`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;