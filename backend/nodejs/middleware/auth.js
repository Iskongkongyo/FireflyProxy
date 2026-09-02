const basicAuth = require("basic-auth");

function clearProxyAuthorization(req) {
    if (!req.headers) return;
    for (const name of Object.keys(req.headers)) {
        if (name.toLowerCase() === "authorization") delete req.headers[name];
    }
}

function authenticateProxyRequest(req, config) {
    const credentials = basicAuth(req);
    clearProxyAuthorization(req);
    if (!config.user || !config.pwd) return { ok: true, open: true };
    if (!credentials || credentials.name !== config.user || credentials.pass !== config.pwd) {
        return { ok: false, open: false };
    }
    req.proxyAuth = Object.freeze({ user: credentials.name });
    return { ok: true, open: false };
}

function createProxyAuth(options) {
    const getConfig = options.getConfig;
    const logger = options.logger;

    return (req, res, next) => {
        if (req.fireflyProxyAdminRoute || req.fireflyProxyAdminHome) return next();
        const config = getConfig();
        const authentication = authenticateProxyRequest(req, config);
        if (authentication.open) {
            logger.warn("[Auth] No Basic Auth configured. Service is open!", { requestId: req.id });
            return next();
        }
        if (!authentication.ok) {
            res.setHeader("WWW-Authenticate", 'Basic realm="Proxy Auth Required"');
            return res.status(401).send("Unauthorized");
        }
        next();
    };
}

module.exports = {
    authenticateProxyRequest,
    clearProxyAuthorization,
    createProxyAuth
};
