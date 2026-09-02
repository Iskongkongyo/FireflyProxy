const { ERROR_CODES, ProxyError } = require("../core/errors");

const ALLOWED_METHODS = Object.freeze([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS"
]);

const DEFAULT_ALLOWED_HEADERS = Object.freeze([
    "content-type",
    "authorization",
    "x-fireflyproxy-upstream-authorization",
    "x-proxyweb-upstream-authorization"
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function normalizeRequestOrigin(value) {
    if (typeof value !== "string" || !value) return null;
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) return null;
        return url.origin;
    } catch {
        return null;
    }
}

function parseRequestedHeaders(value) {
    if (value === undefined) return [];
    const headers = String(value).split(",").map(name => name.trim().toLowerCase());
    if (headers.some(name => !name || !HEADER_NAME_PATTERN.test(name))) return null;
    return [...new Set(headers)];
}

function resolveCorsOrigin(origin, corsConfig) {
    if (corsConfig.allowedOrigins.includes("*")) return "*";
    return corsConfig.allowedOrigins.includes(origin) ? origin : null;
}

function createCorsMiddleware(options) {
    const getConfig = options.getConfig;

    return (req, res, next) => {
        const originHeader = req.headers.origin;
        if (originHeader === undefined) return next();

        res.vary("Origin");
        const origin = normalizeRequestOrigin(originHeader);
        const corsConfig = getConfig().cors;
        const allowedOrigin = origin && resolveCorsOrigin(origin, corsConfig);
        if (!allowedOrigin) {
            return next(new ProxyError(
                ERROR_CODES.CORS_ORIGIN_DENIED,
                "Request Origin is not allowed",
                { statusCode: 403 }
            ));
        }

        req.cors = Object.freeze({ origin: allowedOrigin });
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        if (corsConfig.allowCredentials) {
            res.setHeader("Access-Control-Allow-Credentials", "true");
        }

        const requestedMethod = req.headers["access-control-request-method"];
        const isPreflight = req.method === "OPTIONS" && requestedMethod !== undefined;
        if (!isPreflight) return next();

        const method = String(requestedMethod).toUpperCase();
        if (!ALLOWED_METHODS.includes(method)) {
            return next(new ProxyError(
                ERROR_CODES.CORS_METHOD_DENIED,
                "Requested CORS method is not allowed",
                { statusCode: 403 }
            ));
        }

        const requestedHeaders = parseRequestedHeaders(req.headers["access-control-request-headers"]);
        if (requestedHeaders === null) {
            return next(new ProxyError(
                ERROR_CODES.CORS_HEADERS_INVALID,
                "Requested CORS headers are invalid",
                { statusCode: 400 }
            ));
        }

        res.vary("Access-Control-Request-Method");
        res.vary("Access-Control-Request-Headers");
        res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS.join(","));
        res.setHeader(
            "Access-Control-Allow-Headers",
            (requestedHeaders.length ? requestedHeaders : DEFAULT_ALLOWED_HEADERS).join(", ")
        );
        return res.status(204).end();
    };
}

function exposeCorsHeaders(req, res, headerNames) {
    if (!req.cors) return;
    const names = [...new Set(headerNames.map(name => String(name).toLowerCase()))];
    if (names.length) res.setHeader("Access-Control-Expose-Headers", names.join(", "));
}

module.exports = {
    ALLOWED_METHODS,
    DEFAULT_ALLOWED_HEADERS,
    createCorsMiddleware,
    exposeCorsHeaders,
    normalizeRequestOrigin,
    parseRequestedHeaders,
    resolveCorsOrigin
};
