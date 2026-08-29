/**
 * proxyWeb Express application factory.
 *
 * This module assembles the staged vNext components while route and proxy
 * extraction continues.
 */

const path = require("path");
const express = require("express");
const axios = require("axios"); // [Changed] Use axios for manual proxying
const rateLimit = require("express-rate-limit");
const chokidar = require("chokidar");
const session = require("express-session");
const { createDefaultConfig } = require("./config/defaults");
const { loadConfigFile, parseConfigObject } = require("./config/loader");
const { createErrorMiddleware } = require("./core/errors");
const { buildUpstreamRequestHeaders, filterUpstreamResponseHeaders } = require("./core/headers");
const { createLogger } = require("./core/logger");
const { validateTarget } = require("./core/targetValidator");
const { createProxyAuth } = require("./middleware/auth");
const { createCorsMiddleware, exposeCorsHeaders } = require("./middleware/cors");
const { createRequestLogger } = require("./middleware/requestLogger");

/**
 * Create an isolated Express application runtime.
 *
 * @param {Object} [options]
 * @param {string} [options.configPath] configuration path, resolved from cwd by default
 * @param {boolean} [options.watchConfig=true] watch configuration changes
 * @param {NodeJS.ProcessEnv|Object} [options.env] environment source for interpolation
 * @param {import('winston').Logger} [options.logger] injected logger
 * @param {Object} [options.loggerOptions] logger factory options
 * @param {Function} [options.requestIdFactory] injected request ID factory
 * @returns {{app: import('express').Express, logger: import('winston').Logger, getConfig: Function, reloadConfig: Function, close: Function}}
 */
function createApp(options = {}) {

const ownsLogger = !options.logger;
const logger = options.logger || createLogger(options.loggerOptions);

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
            logger.warn(`[Config] ${warning.message}`);
        }
        if (loaded.source === "defaults") {
            logger.warn("[Config] Config file not found, using defaults.");
        } else {
            logger.info(`[Config] Configuration loaded. Timeout: ${config.timeoutMs}ms`);
        }
        logger.info("[System] RateLimiter reloaded dynamically.");
        return { ok: true, config, warnings: loaded.warnings };
    } catch (err) {
        logger.error("[Config] Error loading config", {
            code: err.code || "CONFIG_UNKNOWN",
            error: err
        });
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
        // 保留 express-rate-limit 的默认 keyGenerator；它基于 Express 按 trustProxy 计算的 req.ip。
        handler: (req, res) => {
            logger.warn("[RateLimit] Blocked request", { requestId: req.id, ip: req.ip });
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
    logger.warn("[Config] Invalid startup configuration; continuing with validated defaults.");
}

// 信任反向代理 (Nginx/Cloudflare 等前置时必须开启)
// 'loopback' 仅信任本机，'linklocal' 信任本地网络，数字代表代理层数
// 如果您直接暴露在公网，请设为 false；如果在 Nginx 后，设为 1
app.set('trust proxy', config.trustProxy);

const configWatcher = options.watchConfig === false
    ? null
    : chokidar.watch(CONFIG_PATH).on("change", () => {
        logger.info("[Config] File changed, reloading...");
        loadConfig();
    });

// ---------------------------
// 3. 基础中间件
// ---------------------------

app.use(createRequestLogger({ logger, requestIdFactory: options.requestIdFactory }));

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

app.use(createCorsMiddleware({ getConfig: () => config }));

// ---------------------------
// 4. 安全鉴权模块
// ---------------------------
app.use(createProxyAuth({ getConfig: () => config, logger }));

// ---------------------------
// 5. 业务逻辑：URL 设置与检查
// ---------------------------
app.use(async (req, res, next) => {
    if (req.path.startsWith("/web")) return next();

    if (req.query.headers) {
        res.setHeader("Deprecation", "true");
        res.setHeader("Warning", '299 proxyWeb "headers query parameter is deprecated; send upstream Authorization with X-ProxyWeb-Upstream-Authorization"');
        logger.warn("[Proxy] Deprecated headers query parameter used", { requestId: req.id });
    }

    // 处理 ?url= 参数
    if (Object.prototype.hasOwnProperty.call(req.query, "url")) {
        try {
            const target = await validateTarget(req.query.url, {
                blockedHostnames: config.security.blockedHostnames
            });
            req.validatedTarget = target;
            logger.info("[Session] Target updated", { requestId: req.id, targetUrl: target.url });
            req.session.targetUrl = target.url;
            // 设置完 URL 后重定向移除 query 参数，直接代理req.session.targetUrl
            //return res.redirect("/");
        } catch (error) {
            return next(error);
        }
    }

    // 检查 Session 状态
    if (!req.session.targetUrl && !req.path.startsWith("/web")) {
        if (config.defaultSkip) return res.redirect(config.defaultSkip);
        return res.status(400).send(`
            <h3>Proxy Service Ready</h3>
            <p>支持的参数： <code>url:请求地址</code> <code>method:可选，默认为发送请求时的请求方法</code></p>
            <p>上游认证请使用请求头 <code>X-ProxyWeb-Upstream-Authorization</code>；普通 <code>Authorization</code> 只用于代理自身鉴权。</p>
            <p><code>headers</code> 查询参数仅为旧客户端保留，已弃用。</p>
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
// 6. 动态中间件执行
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
    const reqUrl = req.validatedTarget?.url || req.session.targetUrl;

    if (!reqUrl) return next();

    try {
        const candidateUrl = req.validatedTarget
            ? req.validatedTarget.url
            : getTargetUrl(req.session.targetUrl, req.originalUrl);
        const target = req.validatedTarget || await validateTarget(candidateUrl, {
            blockedHostnames: config.security.blockedHostnames
        });
        const fullUrl = target.url;

        logger.info("[Proxy] Dispatching request", { requestId: req.id, targetUrl: fullUrl });

        // 1. 准备请求头
        let customHeaders = {};
        if (req.query.headers) {
            try {
                customHeaders = JSON.parse(req.query.headers);
            } catch (e) {
                logger.warn("[Proxy] Failed to parse custom headers JSON", { requestId: req.id });
            }
        }
        const headers = buildUpstreamRequestHeaders(req.headers, customHeaders);

        // 解析请求方法：优先使用查询字符串 ?method=XXX，否则使用前端实际请求方法
        const VALID_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
        const methodParam = (req.query.method || "").toUpperCase();
        const proxyMethod = VALID_METHODS.includes(methodParam) ? methodParam : req.method;

        logger.info("[Proxy] Method selected", { requestId: req.id, method: proxyMethod });

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
            logger.info("[Session] Redirect detected; updating target", {
                requestId: req.id,
                previousTargetUrl: req.session.targetUrl,
                targetUrl: finalUrl
            });
            req.session.targetUrl = finalUrl;
        }

        // 4. 设置响应头
        // 注意：Content-Length 通常由 Node.js 重新计算（如果流式传输）或者我们透传数据且 decompress:false 时可能可以保留，
        // 但如果 Transfer-Encoding 是 chunked，则不应有 Content-Length。
        // 为了安全起见，对于流式管道转发，最好移除 upstream 的 Content-Length 和 Transfer-Encoding，
        // 让 Node.js 自动管理（Node.js 会自动添加 Transfer-Encoding: chunked）。

        const responseHeaders = filterUpstreamResponseHeaders(response.headers);
        Object.entries(responseHeaders).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        if (req.query.headers) {
            res.setHeader("Deprecation", "true");
            res.setHeader("Warning", '299 proxyWeb "headers query parameter is deprecated; send upstream Authorization with X-ProxyWeb-Upstream-Authorization"');
        }

        exposeCorsHeaders(req, res, [
            ...new Set([
                ...Object.keys(responseHeaders),
                "x-request-id",
                ...(req.query.headers ? ["deprecation", "warning"] : [])
            ])
        ]);
        res.removeHeader('x-frame-options');
        res.removeHeader('content-security-policy');

        // 5. 管道转发
        res.status(response.status);
        response.data.pipe(res);

    } catch (error) {
        next(error);
    }
});

app.use(createErrorMiddleware({ logger }));

    return {
        app,
        logger,
        getConfig: () => config,
        reloadConfig: loadConfig,
        async close() {
            if (configWatcher) await configWatcher.close();
            if (ownsLogger) logger.close();
        }
    };
}

module.exports = {
    createApp
};
