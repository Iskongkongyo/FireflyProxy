const { getHeader } = require("../core/headers");
const { requestOrigin } = require("../core/originIsolation");
const { toProxyUrl } = require("../core/urlMapper");
const { mapBrowserReferer } = require("./policy");

const INVALID_PERCENT_ENCODING = /%(?![0-9A-Fa-f]{2})/;
const RAW_CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

function isReservedProxyPath(pathname, adminPath) {
    return pathname === "/__proxyweb"
        || pathname.startsWith("/__proxyweb/")
        || pathname === "/web"
        || pathname.startsWith("/web/")
        || pathname === adminPath
        || pathname.startsWith(`${adminPath}/`);
}

function hasLegacyTargetQuery(req) {
    return Boolean(
        req?.query
        && Object.prototype.hasOwnProperty.call(req.query, "url")
    );
}

function resolveBrowserRootRecovery(req, config, originIsolationRegistry) {
    if (!config?.browser?.enabled || hasLegacyTargetQuery(req)) return null;

    const rawUrl = typeof req?.originalUrl === "string" ? req.originalUrl : req?.url;
    if (
        typeof rawUrl !== "string"
        || !rawUrl.startsWith("/")
        || rawUrl.startsWith("//")
        || rawUrl.includes("\\")
        || rawUrl.includes("#")
        || RAW_CONTROL_OR_SPACE.test(rawUrl)
        || INVALID_PERCENT_ENCODING.test(rawUrl)
    ) return null;

    const queryIndex = rawUrl.indexOf("?");
    const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    if (isReservedProxyPath(pathname, config.admin.path)) return null;

    const proxyOrigin = requestOrigin(req);
    const sourceUrl = mapBrowserReferer(
        getHeader(req.headers, "referer"),
        proxyOrigin,
        config,
        originIsolationRegistry
    );
    if (!sourceUrl) return null;

    try {
        const sourceOrigin = new URL(sourceUrl).origin;
        const target = new URL(rawUrl, `${sourceOrigin}/`);
        if (target.origin !== sourceOrigin) return null;
        return Object.freeze({ sourceUrl, targetUrl: target.href });
    } catch {
        return null;
    }
}

function createBrowserRootRecoveryMarker({ getConfig, originIsolationRegistry }) {
    return (req, res, next) => {
        const recovery = resolveBrowserRootRecovery(req, getConfig(), originIsolationRegistry);
        if (recovery) req.proxyWebBrowserRootRecovery = recovery;
        next();
    };
}

function createBrowserRootRecoveryAdapter({ proxyExecutor, getConfig }) {
    return async (req, res, next) => {
        const recovery = req.proxyWebBrowserRootRecovery;
        if (!recovery) return next();

        try {
            const requestConfig = getConfig();
            if (!requestConfig.browser.enabled) return next();
            const target = await proxyExecutor.resolveTarget(recovery.targetUrl, requestConfig);
            const location = toProxyUrl(target.url, {
                originIsolation: requestConfig.browser.originIsolation
            });
            res.vary("Referer");
            res.setHeader("Cache-Control", "no-store");
            return res.redirect(307, location);
        } catch (error) {
            return next(error);
        }
    };
}

module.exports = {
    createBrowserRootRecoveryAdapter,
    createBrowserRootRecoveryMarker,
    isReservedProxyPath,
    resolveBrowserRootRecovery
};
