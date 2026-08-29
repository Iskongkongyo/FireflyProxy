const express = require("express");
const { apiPolicy } = require("./policy");

function createApiRouter({ proxyExecutor }) {
    const router = express.Router();

    router.all("/", async (req, res, next) => {
        try {
            await proxyExecutor.execute(req, res, {
                targetValue: req.query.url,
                policy: apiPolicy
            });
        } catch (error) {
            next(error);
        }
    });

    return router;
}

module.exports = {
    createApiRouter
};
