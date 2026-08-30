const { ERROR_CODES, ProxyError } = require("./errors");
const { isolatedProxyOrigin } = require("./originIsolation");

const BROWSER_ROUTE_PREFIX = "/__proxyweb/browser";
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const ORIGIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const INVALID_PERCENT_ENCODING = /%(?![0-9A-Fa-f]{2})/;
const RAW_CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;
const MAX_ORIGIN_TOKEN_LENGTH = 4096;

function invalidBrowserUrl(reason) {
    return new ProxyError(ERROR_CODES.BROWSER_URL_INVALID, "Browser proxy URL is invalid", {
        statusCode: 400,
        details: { reason }
    });
}

function parseHttpUrl(value) {
    if (typeof value !== "string" || !value || value !== value.trim()) {
        throw invalidBrowserUrl("missing-or-noncanonical-url");
    }

    let url;
    try {
        url = new URL(value);
    } catch {
        throw invalidBrowserUrl("url-parse-failed");
    }
    if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) {
        throw invalidBrowserUrl("unsupported-or-credentialed-url");
    }
    return url;
}

function encodeOrigin(origin) {
    const url = parseHttpUrl(origin);
    if (url.pathname !== "/" || url.search || url.hash || url.href !== `${url.origin}/`) {
        throw invalidBrowserUrl("origin-required");
    }
    return Buffer.from(url.origin, "utf8").toString("base64url");
}

function decodeOrigin(token) {
    if (
        typeof token !== "string"
        || !token
        || token.length > MAX_ORIGIN_TOKEN_LENGTH
        || !ORIGIN_TOKEN_PATTERN.test(token)
    ) {
        throw invalidBrowserUrl("invalid-origin-token");
    }

    let origin;
    try {
        origin = Buffer.from(token, "base64url").toString("utf8");
    } catch {
        throw invalidBrowserUrl("invalid-origin-token");
    }
    if (Buffer.from(origin, "utf8").toString("base64url") !== token) {
        throw invalidBrowserUrl("noncanonical-origin-token");
    }

    const url = parseHttpUrl(origin);
    if (url.origin !== origin || url.href !== `${origin}/`) {
        throw invalidBrowserUrl("invalid-origin-value");
    }
    return origin;
}

function toProxyUrl(targetUrl, options = {}) {
    const url = parseHttpUrl(targetUrl);
    const token = encodeOrigin(url.origin);
    const path = `${BROWSER_ROUTE_PREFIX}/${token}${url.pathname}${url.search}${url.hash}`;
    const proxyOrigin = isolatedProxyOrigin(url.origin, options.originIsolation);
    return proxyOrigin ? `${proxyOrigin}${path}` : path;
}

function fromProxyRequest(req) {
    const rawUrl = typeof req?.url === "string" ? req.url : "";
    if (
        !rawUrl.startsWith("/")
        || RAW_CONTROL_OR_SPACE.test(rawUrl)
        || rawUrl.includes("\\")
        || rawUrl.includes("#")
        || INVALID_PERCENT_ENCODING.test(rawUrl)
    ) {
        throw invalidBrowserUrl("invalid-request-target");
    }

    const queryIndex = rawUrl.indexOf("?");
    const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    const rawSearch = queryIndex === -1 ? "" : rawUrl.slice(queryIndex);
    const tokenEnd = rawPath.indexOf("/", 1);
    if (tokenEnd <= 1) throw invalidBrowserUrl("missing-origin-or-path");

    const origin = decodeOrigin(rawPath.slice(1, tokenEnd));
    const upstreamPath = rawPath.slice(tokenEnd);
    const target = parseHttpUrl(`${origin}${upstreamPath}${rawSearch}`);
    if (target.origin !== origin) throw invalidBrowserUrl("origin-boundary-violation");
    return target.href;
}

function resolveTargetUrl(value, documentUrl) {
    if (typeof value !== "string") return null;
    const candidate = value.trim();
    if (!candidate || candidate.startsWith("#")) return null;

    let resolved;
    try {
        resolved = new URL(candidate, documentUrl);
    } catch {
        return null;
    }
    if (!HTTP_PROTOCOLS.has(resolved.protocol) || resolved.username || resolved.password) return null;
    return resolved.href;
}

module.exports = {
    BROWSER_ROUTE_PREFIX,
    decodeOrigin,
    encodeOrigin,
    fromProxyRequest,
    resolveTargetUrl,
    toProxyUrl
};
