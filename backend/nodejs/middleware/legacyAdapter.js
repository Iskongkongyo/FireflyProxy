const { markDeprecated } = require("../core/deprecation");
const { legacyPolicy } = require("../browser-proxy/policy");

const LEGACY_ROUTE_WARNING = '299 FireflyProxy "legacy /?url route is deprecated; use /__proxyweb/api"';

function getTargetUrl(baseUrl, requestPath) {
    const path = requestPath.replace(/^\//, "");
    return path ? new URL(baseUrl).origin + "/" + path : baseUrl;
}

function readinessResponse(res) {
    return res.status(400).send(`
        <h3>Proxy Service Ready</h3>
        <p>新 API：<code>/__proxyweb/api?url=请求地址</code></p>
        <p>旧接口 <code>/?url=...</code> 仅作为兼容 Adapter 保留并已弃用。</p>
        <p>上游认证请使用请求头 <code>X-FireflyProxy-Upstream-Authorization</code>；普通 <code>Authorization</code> 只用于代理自身鉴权。</p>
    `);
}

function createLegacyReadiness({ getConfig }) {
    return (req, res, next) => {
        if (req.fireflyProxyAdminRoute) return next();
        if (req.fireflyProxyBrowserRootRecovery) return next();
        if (
            req.path.startsWith("/web")
            || req.path === "/__proxyweb"
            || req.path.startsWith("/__proxyweb/")
        ) return next();
        if (Object.prototype.hasOwnProperty.call(req.query, "url") || req.session.targetUrl) return next();
        const { defaultSkip } = getConfig();
        if (defaultSkip) return res.redirect(defaultSkip);
        const { admin } = getConfig();
        if (admin.enabled) return res.redirect(admin.path);
        return readinessResponse(res);
    };
}

function createLegacyAdapter({ proxyExecutor, getConfig, logger }) {
    return async (req, res, next) => {
        const hasTargetQuery = Object.prototype.hasOwnProperty.call(req.query, "url");
        if (!hasTargetQuery && !req.session.targetUrl) {
            const { defaultSkip } = getConfig();
            if (defaultSkip) return res.redirect(defaultSkip);
            return readinessResponse(res);
        }

        markDeprecated(res, LEGACY_ROUTE_WARNING, "/__proxyweb/api");
        try {
            const requestConfig = getConfig();
            const targetValue = hasTargetQuery
                ? req.query.url
                : getTargetUrl(req.session.targetUrl, req.originalUrl);

            await proxyExecutor.execute(req, res, {
                targetValue,
                policy: legacyPolicy,
                requestConfig,
                onTargetValidated(target) {
                    if (!hasTargetQuery) return;
                    req.session.targetUrl = target.url;
                    logger.info("[Session] Target updated", {
                        requestId: req.id,
                        targetUrl: target.url
                    });
                },
                onRedirect(finalTarget) {
                    logger.info("[Session] Redirect detected; updating target", {
                        requestId: req.id,
                        previousTargetUrl: req.session.targetUrl,
                        targetUrl: finalTarget.url
                    });
                    req.session.targetUrl = finalTarget.url;
                }
            });
        } catch (error) {
            next(error);
        }
    };
}

module.exports = {
    LEGACY_ROUTE_WARNING,
    createLegacyAdapter,
    createLegacyReadiness,
    getTargetUrl,
    readinessResponse
};
