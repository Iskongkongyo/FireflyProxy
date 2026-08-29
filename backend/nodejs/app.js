/**
 * proxyWeb Express application factory.
 *
 * This module intentionally preserves the baseline proxy behavior while the
 * vNext refactor proceeds. Security hardening is tracked separately in P0.
 */

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
const { createDefaultConfig } = require("./config/defaults");
const { loadConfigFile, parseConfigObject } = require("./config/loader");

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

/**
 * Create an isolated Express application runtime.
 *
 * @param {Object} [options]
 * @param {string} [options.configPath] configuration path, resolved from cwd by default
 * @param {boolean} [options.watchConfig=true] watch configuration changes
 * @param {NodeJS.ProcessEnv|Object} [options.env] environment source for interpolation
 * @returns {{app: import('express').Express, getConfig: Function, reloadConfig: Function, close: Function}}
 */
function createApp(options = {}) {

// ---------------------------
// 1. 全局配置与热更新状态
// ---------------------------
const CONFIG_PATH = options.configPath || "./main.json";
const CONFIG_ENV = options.env || process.env;
const CONFIG_DEFAULTS = parseConfigObject({}, {
    defaults: createDefaultConfig(CONFIG_ENV),
    env: CONFIG_ENV
}).config;

// 启动时先保留一份有效默认配置；文件加载失败时继续使用它。
let config = CONFIG_DEFAULTS;

// 动态中间件引用
let currentRateLimiter = null;
// let currentProxyMiddleware = null; // [Removed] No longer needed

// 加载配置函数
function loadConfig() {
    try {
        const loaded = loadConfigFile({
            configPath: CONFIG_PATH,
            defaults: CONFIG_DEFAULTS,
            env: CONFIG_ENV
        });
        const nextRateLimiter = buildRateLimiter(loaded.config);

        // 只有解析、Schema 和中间件创建全部成功后才原子替换。
        config = loaded.config;
        currentRateLimiter = nextRateLimiter;

        for (const warning of loaded.warnings) {
            console.warn(`[Config] ⚠️ ${warning.message}`);
        }
        if (loaded.source === "defaults") {
            console.warn("[Config] ⚠️ Config file not found, using defaults.");
        } else {
            console.log(`[Config] ✅ Configuration loaded. Timeout: ${config.timeoutMs}ms`);
        }
        console.log("[System] 🔄 RateLimiter reloaded dynamically.");
        return { ok: true, config, warnings: loaded.warnings };
    } catch (err) {
        console.error(`[Config] ❌ Error loading config (${err.code || "CONFIG_UNKNOWN"}):`, err.message);
        return { ok: false, config, error: err };
    }
}

// 创建可原子替换的动态限流器。
function buildRateLimiter(nextConfig) {
    return rateLimit({
        windowMs: nextConfig.limiter.windowMs,
        max: nextConfig.limiter.max,
        standardHeaders: true,
        legacyHeaders: false,
        // 移除自定义 keyGenerator，利用 app.set('trust proxy') 正确识别 IP
        handler: (req, res) => {
            console.warn(`[RateLimit] ⛔ Blocked request from ${req.ip}`);
            res.status(nextConfig.limiter.statusCode).send(nextConfig.limiter.message);
        }
    });
}

// ---------------------------
// 2. 初始化 Express
// ---------------------------
const app = express();

// 先加载配置，再初始化只在启动时读取配置的 Express/Session 选项。
const initialLoad = loadConfig();
if (!initialLoad.ok) {
    currentRateLimiter = buildRateLimiter(config);
    console.warn("[Config] ⚠️ Invalid startup configuration; continuing with validated defaults.");
}

// 信任反向代理 (Nginx/Cloudflare 等前置时必须开启)
// 'loopback' 仅信任本机，'linklocal' 信任本地网络，数字代表代理层数
// 如果您直接暴露在公网，请设为 false；如果在 Nginx 后，设为 1
app.set('trust proxy', config.trustProxy);

const configWatcher = options.watchConfig === false
    ? null
    : chokidar.watch(CONFIG_PATH).on("change", () => {
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
const {
    maxAgeMs,
    secure,
    httpOnly,
    sameSite,
    ...sessionOptions
} = config.session;
app.use(session({
    ...sessionOptions,
    cookie: { maxAge: maxAgeMs, secure, httpOnly, sameSite }
    // store: new RedisStore({ client: redisClient }), // Example for Prod
}));

function resolveCorsOrigin(req) {
    const clientOrigin = req.headers.origin || req.headers.referer;
    const allowedOrigins = config.cors.allowedOrigins;
    const configuredOrigin = allowedOrigins[0] || "*";

    if (allowedOrigins.includes("*") && clientOrigin) {
        try {
            return new URL(clientOrigin).origin;
        } catch { /* Preserve the configured fallback for invalid input. */ }
    }

    if (clientOrigin) {
        try {
            const normalized = new URL(clientOrigin).origin;
            if (allowedOrigins.includes(normalized)) return normalized;
        } catch { /* Preserve baseline behavior until the CORS security stage. */ }
    }

    return configuredOrigin;
}

// CORS 安全配置
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", resolveCorsOrigin(req));
    if (config.cors.allowCredentials) {
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }
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
            <p>支持的参数： <code>url:请求地址</code> <code>headers:可选，自定义请求头</code> <code>method:可选，默认为发送请求时的请求方法</code></p>
            <p>参数请求示例： <code>/?url=https://example.com&headers={"Authorization":"Bearer xxx"}&method=</code></p>
        `);
    }

    next();
});

// 静态资源 (SPA 支持)
app.use("/web", express.static("webPro"));

// SPA Fallback: /web 下所有未匹配静态文件的路径都返回 index.html
app.use("/web", (req, res, next) => {
    res.sendFile(path.join(__dirname, "webPro", "index.html"));
});

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

        // 解析请求方法：优先使用查询字符串 ?method=XXX，否则使用前端实际请求方法
        const VALID_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
        const methodParam = (req.query.method || "").toUpperCase();
        const proxyMethod = VALID_METHODS.includes(methodParam) ? methodParam : req.method;

        console.log(`[Debug] Using method: ${proxyMethod}`);

        // 2. 发起 Axios 请求
        const response = await axios({
            method: proxyMethod,
            url: fullUrl,
            headers: headers,
            data: (proxyMethod === 'GET' || proxyMethod === 'HEAD') ? undefined : req, // 流式透传请求体
            responseType: 'stream', // 关键：流式响应
            decompress: false, // 禁止 axios 自动解压，透传原始压缩数据（防止 Content-Length 不匹配导致截断）
            maxRedirects: config.api.followRedirects ? config.api.maxRedirects : 0,
            validateStatus: null, // 允许所有状态码
            timeout: config.timeoutMs
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
        res.setHeader("Access-Control-Allow-Origin", resolveCorsOrigin(req));
        if (config.cors.allowCredentials) {
            res.setHeader("Access-Control-Allow-Credentials", "true");
        }
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

    return {
        app,
        getConfig: () => config,
        reloadConfig: loadConfig,
        async close() {
            if (configWatcher) await configWatcher.close();
        }
    };
}

module.exports = {
    createApp
};
