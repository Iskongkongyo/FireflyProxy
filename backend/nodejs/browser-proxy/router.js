const express = require("express");
const { ERROR_CODES, ProxyError } = require("../core/errors");
const {
    BROWSER_ROUTE_PREFIX,
    fromProxyRequest,
    toProxyUrl
} = require("../core/urlMapper");
const { browserPolicy } = require("./policy");
const { applyBrowserPreferences, parseBrowserPreferences } = require("./preferences");
const { validateTargetProxyOrigin } = require("../core/originIsolation");

function mapperOptions(config) {
    return { originIsolation: config.browser.originIsolation };
}

function createBrowserRouter({ proxyExecutor, getConfig, sessionStateStore, originIsolationRegistry }) {
    const router = express.Router();

    router.all("/", async (req, res, next) => {
        try {
            const requestConfig = getConfig();
            if (!requestConfig.browser.enabled) {
                throw new ProxyError(ERROR_CODES.BROWSER_DISABLED, "Browser proxy mode is disabled", {
                    statusCode: 404
                });
            }
            if (requestConfig.browser.originIsolation.enabled
                && req.fireflyProxyOriginIsolation?.scope !== "base") {
                throw new ProxyError(ERROR_CODES.ORIGIN_ISOLATION_DENIED, "Browser entry requires the configured base origin", {
                    statusCode: 421
                });
            }
            const target = await proxyExecutor.resolveTarget(req.query.url, requestConfig);
            const preferences = parseBrowserPreferences(req.query);
            if (Object.keys(preferences).length > 0) {
                req.session.fireflyProxyBrowserPreferences = preferences;
            } else if (req.session.fireflyProxyBrowserPreferences) {
                delete req.session.fireflyProxyBrowserPreferences;
            }
            return res.redirect(302, toProxyUrl(target.url, mapperOptions(requestConfig)));
        } catch (error) {
            next(error);
        }
    });

    router.use(async (req, res, next) => {
        try {
            const configuredRequest = getConfig();
            if (!configuredRequest.browser.enabled) {
                throw new ProxyError(ERROR_CODES.BROWSER_DISABLED, "Browser proxy mode is disabled", {
                    statusCode: 404
                });
            }
            const requestConfig = applyBrowserPreferences(
                configuredRequest,
                req.session.fireflyProxyBrowserPreferences
            );

            const targetValue = fromProxyRequest(req);
            const targetOrigin = new URL(targetValue).origin;
            const isolationResult = validateTargetProxyOrigin(
                req,
                targetOrigin,
                requestConfig.browser.originIsolation
            );
            if (requestConfig.browser.originIsolation.enabled) {
                originIsolationRegistry.register(targetOrigin);
                req.session.fireflyProxyOriginIsolation = true;
            }
            const canonicalUrl = toProxyUrl(targetValue, mapperOptions(requestConfig));
            const currentUrl = `${BROWSER_ROUTE_PREFIX}${req.url}`;
            if (isolationResult.redirect) return res.redirect(308, canonicalUrl);
            const canonicalPath = new URL(canonicalUrl, "http://fireflyproxy.invalid");
            if (currentUrl !== `${canonicalPath.pathname}${canonicalPath.search}`) {
                return res.redirect(308, canonicalUrl);
            }

            let sessionState;
            if (requestConfig.browser.cookieJar) {
                req.session.fireflyProxyBrowser = true;
                sessionState = await sessionStateStore.get(req.sessionID, requestConfig.session.maxAgeMs);
            } else if (!configuredRequest.browser.cookieJar) {
                await sessionStateStore.delete(req.sessionID);
            }

            await proxyExecutor.execute(req, res, {
                targetValue,
                policy: browserPolicy,
                requestConfig,
                sessionState,
                originIsolationRegistry,
                allowQueryControls: false
            });
        } catch (error) {
            next(error);
        }
    });

    return router;
}

module.exports = {
    createBrowserRouter
};
