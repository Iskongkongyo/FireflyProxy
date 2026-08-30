const { createHmac, timingSafeEqual } = require("node:crypto");
const { BROWSER_ROUTE_PREFIX, fromProxyRequest } = require("../core/urlMapper");
const { ERROR_CODES, ProxyError } = require("../core/errors");

const WEB_SOCKET_CONTEXT_PREFIX = "proxyweb-origin";
const WEB_SOCKET_PROTOCOLS = new Set(["ws:", "wss:"]);

function invalidWebSocketUrl(reason) {
    return new ProxyError(ERROR_CODES.BROWSER_URL_INVALID, "Browser WebSocket URL is invalid", {
        statusCode: 400,
        details: { reason }
    });
}

function toHttpUrl(value) {
    let url;
    try {
        url = value instanceof URL ? new URL(value.href) : new URL(value);
    } catch {
        throw invalidWebSocketUrl("url-parse-failed");
    }
    if (!WEB_SOCKET_PROTOCOLS.has(url.protocol) || url.username || url.password) {
        throw invalidWebSocketUrl("unsupported-or-credentialed-url");
    }
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url;
}

function toWebSocketUrl(value) {
    let url;
    try {
        url = value instanceof URL ? new URL(value.href) : new URL(value);
    } catch {
        throw invalidWebSocketUrl("url-parse-failed");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw invalidWebSocketUrl("unsupported-or-credentialed-url");
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
}

function fromWebSocketProxyRequest(req) {
    const rawUrl = typeof req?.url === "string" ? req.url : "";
    if (!rawUrl.startsWith(`${BROWSER_ROUTE_PREFIX}/`)) {
        throw invalidWebSocketUrl("route-prefix-mismatch");
    }
    const canonicalHttpUrl = fromProxyRequest({ url: rawUrl.slice(BROWSER_ROUTE_PREFIX.length) });
    return toWebSocketUrl(canonicalHttpUrl).href;
}

function signOrigin(origin, secret) {
    return createHmac("sha256", secret).update(origin, "utf8").digest("base64url");
}

function createWebSocketOriginContext(origin, secret) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
        throw new TypeError("WebSocket source context requires an HTTP(S) origin");
    }
    if (typeof secret !== "string" || !secret) {
        throw new TypeError("WebSocket source context requires a signing secret");
    }
    const encodedOrigin = Buffer.from(origin, "utf8").toString("base64url");
    return `${WEB_SOCKET_CONTEXT_PREFIX}.${encodedOrigin}.${signOrigin(origin, secret)}`;
}

function verifyWebSocketOriginContext(protocol, secret) {
    if (typeof protocol !== "string" || typeof secret !== "string" || !secret) return null;
    const parts = protocol.split(".");
    if (parts.length !== 3 || parts[0] !== WEB_SOCKET_CONTEXT_PREFIX) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;

    let origin;
    try {
        origin = Buffer.from(parts[1], "base64url").toString("utf8");
        if (Buffer.from(origin, "utf8").toString("base64url") !== parts[1]) return null;
        const parsed = new URL(origin);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return null;
    } catch {
        return null;
    }

    const expected = Buffer.from(signOrigin(origin, secret));
    const actual = Buffer.from(parts[2]);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return origin;
}

module.exports = {
    WEB_SOCKET_CONTEXT_PREFIX,
    createWebSocketOriginContext,
    fromWebSocketProxyRequest,
    toHttpUrl,
    toWebSocketUrl,
    verifyWebSocketOriginContext
};
