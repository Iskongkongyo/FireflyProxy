/**
 * proxyWeb Express application factory.
 *
 * This module assembles the staged vNext components while route and proxy
 * extraction continues.
 */

const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const chokidar = require("chokidar");
const session = require("express-session");
const { createApiRouter } = require("./api-proxy/router");
const { createBrowserRouter } = require("./browser-proxy/router");
const { createSessionStateStore } = require("./browser-proxy/sessionStateStore");
const { createDefaultConfig } = require("./config/defaults");
const { loadConfigFile, parseConfigObject } = require("./config/loader");
const { createDnsResolver } = require("./core/dnsResolver");
const { ERROR_CODES, ProxyError, createErrorMiddleware } = require("./core/errors");
const { createLogger } = require("./core/logger");
const { createPinnedConnection } = require("./core/pinnedConnection");
const { createProxyExecutor } = require("./core/proxyExecutor");
const { createProxyAuth } = require("./middleware/auth");
const { createCorsMiddleware } = require("./middleware/cors");
const { createLegacyAdapter, createLegacyReadiness } = require("./middleware/legacyAdapter");
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
 * @param {{resolve: Function}} [options.dnsResolver] injected DNS resolver
 * @param {Function} [options.connectionFactory] injected pinned connection factory
 * @returns {{app: import('express').Express, logger: import('winston').Logger, getConfig: Function, reloadConfig: Function, close: Function}}
 */
function createApp(options = {}) {

const ownsLogger = !options.logger;
const logger = options.logger || createLogger(options.loggerOptions);
const dnsResolver = options.dnsResolver || createDnsResolver();
if (!dnsResolver || typeof dnsResolver.resolve !== "function") {
    throw new TypeError("dnsResolver.resolve must be a function");
}
const connectionFactory = options.connectionFactory || createPinnedConnection;
if (typeof connectionFactory !== "function") {
    throw new TypeError("connectionFactory must be a function");
}
const sessionStateStore = options.sessionStateStore || createSessionStateStore();
if (
    !sessionStateStore
    || typeof sessionStateStore.get !== "function"
    || typeof sessionStateStore.delete !== "function"
) {
    throw new TypeError("sessionStateStore must provide get and delete functions");
}

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

const corsMiddleware = createCorsMiddleware({ getConfig: () => config });
app.use((req, res, next) => {
    const browserRoute = req.path === "/__proxyweb/browser"
        || req.path.startsWith("/__proxyweb/browser/");
    if (browserRoute) return next();
    return corsMiddleware(req, res, next);
});

// ---------------------------
// 4. 安全鉴权模块
// ---------------------------
app.use(createProxyAuth({ getConfig: () => config, logger }));

app.use(createLegacyReadiness({ getConfig: () => config }));

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

const proxyExecutor = createProxyExecutor({
    getConfig: () => config,
    dnsResolver,
    connectionFactory,
    logger
});

app.use("/__proxyweb/api", createApiRouter({ proxyExecutor }));
app.use("/__proxyweb/browser", createBrowserRouter({
    proxyExecutor,
    getConfig: () => config,
    sessionStateStore
}));
app.use("/__proxyweb", (req, res, next) => next(new ProxyError(
    ERROR_CODES.ROUTE_NOT_FOUND,
    "Reserved proxy route was not found",
    { statusCode: 404 }
)));
app.use(createLegacyAdapter({
    proxyExecutor,
    getConfig: () => config,
    logger
}));

app.use(createErrorMiddleware({ logger }));

    return {
        app,
        logger,
        getConfig: () => config,
        reloadConfig: loadConfig,
        async close() {
            proxyExecutor.close();
            await sessionStateStore.clear?.();
            if (configWatcher) await configWatcher.close();
            if (ownsLogger) logger.close();
        }
    };
}

module.exports = {
    createApp
};
