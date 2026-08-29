const express = require("express");
const { ERROR_CODES, ProxyError } = require("../core/errors");
const { browserPolicy } = require("./policy");

function createBrowserRouter({ proxyExecutor, getConfig }) {
    const router = express.Router();

    router.all("/", async (req, res, next) => {
        try {
            const requestConfig = getConfig();
            if (!requestConfig.browser.enabled) {
                throw new ProxyError(ERROR_CODES.BROWSER_DISABLED, "Browser proxy mode is disabled", {
                    statusCode: 404
                });
            }
            await proxyExecutor.execute(req, res, {
                targetValue: req.query.url,
                policy: browserPolicy,
                requestConfig
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
