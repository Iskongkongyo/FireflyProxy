const basicAuth = require("basic-auth");

function clearProxyAuthorization(req) {
    if (!req.headers) return;
    for (const name of Object.keys(req.headers)) {
        if (name.toLowerCase() === "authorization") delete req.headers[name];
    }
}

function createProxyAuth(options) {
    const getConfig = options.getConfig;
    const logger = options.logger;

    return (req, res, next) => {
        const credentials = basicAuth(req);
        clearProxyAuthorization(req);

        const config = getConfig();
        if (!config.user || !config.pwd) {
            logger.warn("[Auth] No Basic Auth configured. Service is open!", { requestId: req.id });
            return next();
        }

        if (!credentials || credentials.name !== config.user || credentials.pass !== config.pwd) {
            res.setHeader("WWW-Authenticate", 'Basic realm="Proxy Auth Required"');
            return res.status(401).send("Unauthorized");
        }

        req.proxyAuth = Object.freeze({ user: credentials.name });
        next();
    };
}

module.exports = {
    clearProxyAuthorization,
    createProxyAuth
};
