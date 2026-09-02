const { createHash } = require("node:crypto");
const { ERROR_CODES, ProxyError } = require("./errors");

const ISOLATED_LABEL_PATTERN = /^o-[0-9a-f]{32}$/;

function originIsolationConfig(config) {
    return config?.browser?.originIsolation?.enabled
        ? config.browser.originIsolation
        : null;
}

function isolationLabel(upstreamOrigin) {
    const url = new URL(upstreamOrigin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== upstreamOrigin) {
        throw new TypeError("Origin isolation requires a canonical HTTP(S) upstream origin");
    }
    return `o-${createHash("sha256").update(upstreamOrigin, "utf8").digest("hex").slice(0, 32)}`;
}

function isolatedProxyOrigin(upstreamOrigin, isolation) {
    if (!isolation?.enabled) return null;
    const base = new URL(isolation.baseOrigin);
    base.hostname = `${isolationLabel(upstreamOrigin)}.${base.hostname}`;
    return base.origin;
}

function requestOrigin(request) {
    const host = request?.headers?.host;
    if (typeof host !== "string" || !host || host.includes(",")) return null;
    try {
        const protocol = request.fireflyProxyExternalProtocol
            || request.protocol
            || (request.socket?.encrypted ? "https" : "http");
        return new URL(`${protocol}://${host}`).origin;
    } catch {
        return null;
    }
}

function classifyProxyOrigin(origin, isolation) {
    if (!isolation?.enabled || typeof origin !== "string") return null;
    let value;
    let base;
    try {
        value = new URL(origin);
        base = new URL(isolation.baseOrigin);
    } catch {
        return null;
    }
    if (value.origin === base.origin) return { scope: "base", origin: value.origin };
    if (value.protocol !== base.protocol || value.port !== base.port) return null;
    const suffix = `.${base.hostname}`;
    if (!value.hostname.endsWith(suffix)) return null;
    const label = value.hostname.slice(0, -suffix.length);
    if (!ISOLATED_LABEL_PATTERN.test(label)) return null;
    return { scope: "isolated", origin: value.origin, label };
}

function originIsolationError(reason) {
    return new ProxyError(
        ERROR_CODES.ORIGIN_ISOLATION_DENIED,
        "Browser proxy origin is not allowed",
        { statusCode: 421, details: { reason } }
    );
}

function validateTargetProxyOrigin(request, upstreamOrigin, isolation) {
    if (!isolation?.enabled) return { canonicalOrigin: null, redirect: false };
    const actualOrigin = requestOrigin(request);
    const classified = classifyProxyOrigin(actualOrigin, isolation);
    const canonicalOrigin = isolatedProxyOrigin(upstreamOrigin, isolation);
    if (classified?.scope === "base") return { canonicalOrigin, redirect: true };
    if (classified?.scope !== "isolated" || actualOrigin !== canonicalOrigin) {
        throw originIsolationError("target-host-mismatch");
    }
    return { canonicalOrigin, redirect: false };
}

function createOriginIsolationRegistry(options = {}) {
    const maxEntries = options.maxEntries || 4096;
    const ttlMs = options.ttlMs || Infinity;
    const now = options.now || Date.now;
    const origins = new Map();
    const prune = current => {
        for (const [label, entry] of origins) {
            if (entry.expiresAt <= current) origins.delete(label);
        }
    };
    return Object.freeze({
        register(upstreamOrigin) {
            const label = isolationLabel(upstreamOrigin);
            const current = now();
            prune(current);
            origins.delete(label);
            origins.set(label, { upstreamOrigin, expiresAt: current + ttlMs });
            while (origins.size > maxEntries) origins.delete(origins.keys().next().value);
            return label;
        },
        resolve(proxyOrigin, isolation) {
            const classified = classifyProxyOrigin(proxyOrigin, isolation);
            if (classified?.scope !== "isolated") return null;
            const current = now();
            prune(current);
            const entry = origins.get(classified.label);
            const upstreamOrigin = entry?.upstreamOrigin;
            if (!upstreamOrigin || isolatedProxyOrigin(upstreamOrigin, isolation) !== proxyOrigin) return null;
            origins.delete(classified.label);
            origins.set(classified.label, { upstreamOrigin, expiresAt: current + ttlMs });
            return upstreamOrigin;
        },
        clear() {
            origins.clear();
        }
    });
}

function createOriginIsolationMiddleware({ getConfig }) {
    return (req, res, next) => {
        try {
            const isolation = originIsolationConfig(getConfig());
            if (!isolation) return next();
            const classified = classifyProxyOrigin(requestOrigin(req), isolation);
            if (!classified) throw originIsolationError("unconfigured-host");
            req.fireflyProxyOriginIsolation = classified;
            if (classified.scope === "base") return next();

            const browserRoute = req.path.startsWith("/__proxyweb/browser/");
            const runtimeRoute = req.path === "/__proxyweb/runtime.js";
            const recoveredBrowserRoot = Boolean(req.fireflyProxyBrowserRootRecovery);
            if (!browserRoute && !runtimeRoute && !recoveredBrowserRoot) {
                throw originIsolationError("isolated-host-route");
            }
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

function createSharedSessionDomainMiddleware({ getConfig }) {
    return (req, res, next) => {
        const config = getConfig();
        const isolation = originIsolationConfig(config);
        if (isolation && req.session?.cookie) {
            req.session.cookie.domain = new URL(isolation.baseOrigin).hostname;
            req.session.cookie.secure = config.session.secure;
            req.session.cookie.httpOnly = config.session.httpOnly;
            req.session.cookie.sameSite = config.session.sameSite;
        }
        next();
    };
}

module.exports = {
    ISOLATED_LABEL_PATTERN,
    classifyProxyOrigin,
    createOriginIsolationMiddleware,
    createOriginIsolationRegistry,
    createSharedSessionDomainMiddleware,
    isolatedProxyOrigin,
    isolationLabel,
    originIsolationConfig,
    requestOrigin,
    validateTargetProxyOrigin
};
