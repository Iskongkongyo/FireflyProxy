const express = require("express");
const { ERROR_CODES, ProxyError } = require("../core/errors");
const {
    BROWSER_ROUTE_PREFIX,
    fromProxyRequest,
    toProxyUrl
} = require("../core/urlMapper");
const { browserPolicy } = require("./policy");
const { applyBrowserPreferences, parseBrowserPreferences } = require("./preferences");

function createBrowserRouter({ proxyExecutor, getConfig, sessionStateStore }) {
    const router = express.Router();

    router.all("/", async (req, res, next) => {
        try {
            const requestConfig = getConfig();
            if (!requestConfig.browser.enabled) {
                throw new ProxyError(ERROR_CODES.BROWSER_DISABLED, "Browser proxy mode is disabled", {
                    statusCode: 404
                });
            }
            const target = await proxyExecutor.resolveTarget(req.query.url, requestConfig);
            const preferences = parseBrowserPreferences(req.query);
            if (Object.keys(preferences).length > 0) {
                req.session.proxyWebBrowserPreferences = preferences;
            } else if (req.session.proxyWebBrowserPreferences) {
                delete req.session.proxyWebBrowserPreferences;
            }
            return res.redirect(302, toProxyUrl(target.url));
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
                req.session.proxyWebBrowserPreferences
            );

            const targetValue = fromProxyRequest(req);
            const canonicalUrl = toProxyUrl(targetValue);
            const currentUrl = `${BROWSER_ROUTE_PREFIX}${req.url}`;
            if (currentUrl !== canonicalUrl) return res.redirect(308, canonicalUrl);

            let sessionState;
            if (requestConfig.browser.cookieJar) {
                req.session.proxyWebBrowser = true;
                sessionState = await sessionStateStore.get(req.sessionID, requestConfig.session.maxAgeMs);
            } else if (!configuredRequest.browser.cookieJar) {
                await sessionStateStore.delete(req.sessionID);
            }

            await proxyExecutor.execute(req, res, {
                targetValue,
                policy: browserPolicy,
                requestConfig,
                sessionState,
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
