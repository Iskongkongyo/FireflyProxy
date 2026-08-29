const { randomUUID } = require("node:crypto");
const { redactString } = require("../core/redact");

function createRequestLogger(options) {
    const logger = options.logger;
    const requestIdFactory = options.requestIdFactory || randomUUID;

    return (req, res, next) => {
        const requestId = requestIdFactory();
        req.id = requestId;
        res.setHeader("X-Request-ID", requestId);

        if (!req.url.includes("favicon.ico")) {
            logger.info("Incoming request", {
                requestId,
                method: req.method,
                path: redactString(req.originalUrl || req.url),
                ip: req.ip
            });
        }
        next();
    };
}

module.exports = {
    createRequestLogger
};
