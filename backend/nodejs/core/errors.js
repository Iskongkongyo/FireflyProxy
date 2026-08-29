const ERROR_CODES = Object.freeze({
    INVALID_URL: "PROXY_INVALID_URL",
    PROTOCOL_BLOCKED: "PROXY_PROTOCOL_BLOCKED",
    SSRF_BLOCKED: "PROXY_SSRF_BLOCKED",
    DNS_FAILED: "PROXY_DNS_FAILED",
    CONNECT_TIMEOUT: "PROXY_CONNECT_TIMEOUT",
    REQUEST_TIMEOUT: "PROXY_REQUEST_TIMEOUT",
    REQUEST_BODY_LIMIT: "PROXY_REQUEST_BODY_LIMIT",
    CONCURRENCY_LIMIT: "PROXY_CONCURRENCY_LIMIT",
    REDIRECT_BLOCKED: "PROXY_REDIRECT_BLOCKED",
    REDIRECT_LIMIT: "PROXY_REDIRECT_LIMIT",
    UPSTREAM_ERROR: "PROXY_UPSTREAM_ERROR",
    REWRITE_LIMIT: "PROXY_REWRITE_LIMIT",
    CORS_ORIGIN_DENIED: "PROXY_CORS_ORIGIN_DENIED",
    CORS_METHOD_DENIED: "PROXY_CORS_METHOD_DENIED",
    CORS_HEADERS_INVALID: "PROXY_CORS_HEADERS_INVALID",
    INTERNAL_ERROR: "PROXY_INTERNAL_ERROR"
});

class ProxyError extends Error {
    constructor(code, message, options = {}) {
        super(message, { cause: options.cause });
        this.name = "ProxyError";
        this.code = code;
        this.statusCode = options.statusCode || 500;
        this.publicMessage = options.publicMessage || message;
        this.details = options.details;
    }
}

function normalizeProxyError(error) {
    if (error instanceof ProxyError) return error;
    let cause = error && error.cause;
    while (cause) {
        if (cause instanceof ProxyError) return cause;
        cause = cause.cause;
    }
    if (error && ["ECONNABORTED", "ETIMEDOUT"].includes(error.code)) {
        return new ProxyError(ERROR_CODES.REQUEST_TIMEOUT, "Upstream request timed out", {
            statusCode: 504,
            cause: error
        });
    }
    return new ProxyError(ERROR_CODES.UPSTREAM_ERROR, "Upstream request failed", {
        statusCode: 502,
        cause: error
    });
}

function errorPayload(error) {
    const normalized = normalizeProxyError(error);
    return {
        error: {
            code: normalized.code,
            message: normalized.publicMessage
        }
    };
}

function createErrorMiddleware({ logger }) {
    return (error, req, res, next) => {
        const normalized = normalizeProxyError(error);
        logger.error("Request failed", {
            requestId: req.id,
            code: normalized.code,
            error: normalized.cause || error
        });

        if (res.destroyed) return;
        if (res.headersSent) {
            if (!res.destroyed) res.destroy();
            return;
        }
        res.status(normalized.statusCode).json(errorPayload(normalized));
    };
}

module.exports = {
    ERROR_CODES,
    ProxyError,
    createErrorMiddleware,
    errorPayload,
    normalizeProxyError
};
