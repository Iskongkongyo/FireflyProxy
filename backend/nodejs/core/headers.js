const { validateHeaderValue } = require("node:http");

const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "trailers",
    "transfer-encoding",
    "upgrade"
]);

const PROXY_AUTHENTICATION_HEADERS = new Set([
    "proxy-authenticate",
    "proxy-authorization"
]);

const UPSTREAM_AUTHORIZATION_HEADER = "x-fireflyproxy-upstream-authorization";
const LEGACY_UPSTREAM_AUTHORIZATION_HEADER = "x-proxyweb-upstream-authorization";
const UPSTREAM_REFERER_HEADER = "x-fireflyproxy-upstream-referer";
const UPSTREAM_HEADERS_HEADER = "x-fireflyproxy-upstream-headers";
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_UPSTREAM_HEADER_ENVELOPE_BYTES = 8 * 1024;
const MAX_UPSTREAM_HEADER_COUNT = 100;
const MAX_UPSTREAM_HEADER_VALUE_BYTES = 4 * 1024;
const SENSITIVE_UPSTREAM_HEADERS = Symbol.for("fireflyproxy.sensitiveUpstreamHeaders");

const PROXY_RESPONSE_CONTROL_HEADERS = new Set([
    "x-proxyweb-final-url",
    "x-proxyweb-redirect-chain",
    "x-proxyweb-redirect-count",
    "x-proxyweb-follow-redirects",
    "x-proxyweb-max-redirects",
    "x-proxyweb-diagnostics-truncated",
    "x-proxyweb-cache"
]);

const LEGACY_REQUEST_EXCLUDED_HEADERS = new Set([
    "host",
    "origin",
    "referer",
    "cookie"
]);

function normalizeHeaderName(name) {
    return String(name).trim().toLowerCase();
}

function isHopByHopHeader(name) {
    return HOP_BY_HOP_HEADERS.has(normalizeHeaderName(name));
}

function isProxyAuthenticationHeader(name) {
    return PROXY_AUTHENTICATION_HEADERS.has(normalizeHeaderName(name));
}

function connectionHeaderNames(headers) {
    const connection = Object.entries(headers || {}).find(
        ([name]) => normalizeHeaderName(name) === "connection"
    );
    if (!connection) return [];
    return String(connection[1] || "")
        .split(",")
        .map(normalizeHeaderName)
        .filter(Boolean);
}

function omitHeaders(headers, excludedNames) {
    const excluded = new Set([...excludedNames].map(normalizeHeaderName));
    const result = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (!excluded.has(normalizeHeaderName(name))) result[name] = value;
    }
    return result;
}

function getHeader(headers, targetName) {
    const normalizedTarget = normalizeHeaderName(targetName);
    const entry = Object.entries(headers || {}).find(
        ([name]) => normalizeHeaderName(name) === normalizedTarget
    );
    return entry ? entry[1] : undefined;
}

function normalizeUpstreamReferer(value) {
    if (typeof value !== "string" || !value || value.length > 4096) return undefined;
    try {
        const referer = new URL(value);
        if (!["http:", "https:"].includes(referer.protocol)) return undefined;
        if (referer.username || referer.password || referer.hash) return undefined;
        return referer.href;
    } catch {
        return undefined;
    }
}

function normalizeUpstreamOrigin(value) {
    if (value === "null") return "null";
    if (typeof value !== "string" || !value || value.length > 4096) return undefined;
    try {
        const origin = new URL(value);
        if (
            !["http:", "https:"].includes(origin.protocol)
            || origin.username
            || origin.password
            || origin.pathname !== "/"
            || origin.search
            || origin.hash
        ) return undefined;
        return origin.origin;
    } catch {
        return undefined;
    }
}

function isBlockedUpstreamHeader(name) {
    const normalized = normalizeHeaderName(name);
    return !HEADER_NAME_PATTERN.test(String(name || ""))
        || HOP_BY_HOP_HEADERS.has(normalized)
        || [
            "host",
            "content-length",
            "authorization",
            "set-cookie",
            "forwarded",
            "x-real-ip"
        ].includes(normalized)
        || normalized.startsWith("proxy-")
        || normalized.startsWith("sec-")
        || normalized.startsWith("access-control-")
        || normalized.startsWith("x-forwarded-")
        || normalized.startsWith("x-fireflyproxy-")
        || normalized.startsWith("x-proxyweb-");
}

function normalizeUpstreamHeaderValue(name, value) {
    if (typeof value !== "string") return undefined;
    if (Buffer.byteLength(value, "utf8") > MAX_UPSTREAM_HEADER_VALUE_BYTES || /[\r\n\0]/.test(value)) {
        return undefined;
    }
    const normalized = normalizeHeaderName(name);
    if (normalized === "referer") return normalizeUpstreamReferer(value);
    if (normalized === "origin") return normalizeUpstreamOrigin(value);
    try {
        validateHeaderValue(normalized, value);
    } catch {
        return undefined;
    }
    return value;
}

function decodeUpstreamHeaders(value) {
    const maxEncodedLength = Math.ceil(MAX_UPSTREAM_HEADER_ENVELOPE_BYTES / 3) * 4;
    if (typeof value !== "string" || !value || value.length > maxEncodedLength) {
        return {};
    }
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return {};

    try {
        const decoded = Buffer.from(value, "base64url");
        if (decoded.length > MAX_UPSTREAM_HEADER_ENVELOPE_BYTES) return {};
        const entries = JSON.parse(decoded.toString("utf8"));
        if (!Array.isArray(entries) || entries.length > MAX_UPSTREAM_HEADER_COUNT) return {};

        const headers = {};
        const sensitiveHeaderNames = new Set();
        for (const entry of entries) {
            if (!Array.isArray(entry) || ![2, 3].includes(entry.length)) continue;
            const [name, rawValue] = entry;
            if (typeof name !== "string" || isBlockedUpstreamHeader(name)) continue;
            const normalizedValue = normalizeUpstreamHeaderValue(name, rawValue);
            if (normalizedValue === undefined) continue;
            const normalizedName = normalizeHeaderName(name);
            headers[normalizedName] = normalizedValue;
            if (entry[2] === true) sensitiveHeaderNames.add(normalizedName);
        }
        if (sensitiveHeaderNames.size) {
            Object.defineProperty(headers, SENSITIVE_UPSTREAM_HEADERS, {
                value: sensitiveHeaderNames,
                enumerable: true
            });
        }
        return headers;
    } catch {
        return {};
    }
}

function buildUpstreamRequestHeaders(inboundHeaders, customHeaders = {}, options = {}) {
    const merged = { ...(inboundHeaders || {}), ...(customHeaders || {}) };
    const upstreamAuthorization = getHeader(inboundHeaders, UPSTREAM_AUTHORIZATION_HEADER)
        || getHeader(inboundHeaders, LEGACY_UPSTREAM_AUTHORIZATION_HEADER);
    const upstreamReferer = options.allowUpstreamReferer
        ? normalizeUpstreamReferer(getHeader(inboundHeaders, UPSTREAM_REFERER_HEADER))
        : undefined;
    const structuredHeaders = options.allowUpstreamHeaders
        ? decodeUpstreamHeaders(getHeader(inboundHeaders, UPSTREAM_HEADERS_HEADER))
        : {};
    const legacyAuthorization = getHeader(customHeaders, "authorization");
    const excluded = new Set([
        ...HOP_BY_HOP_HEADERS,
        ...LEGACY_REQUEST_EXCLUDED_HEADERS,
        "authorization",
        UPSTREAM_AUTHORIZATION_HEADER,
        LEGACY_UPSTREAM_AUTHORIZATION_HEADER,
        UPSTREAM_REFERER_HEADER,
        UPSTREAM_HEADERS_HEADER,
        ...connectionHeaderNames(inboundHeaders),
        ...connectionHeaderNames(customHeaders)
    ]);
    const result = omitHeaders(merged, excluded);
    for (const name of Object.keys(result)) {
        const normalized = normalizeHeaderName(name);
        if (normalized.startsWith("sec-") || normalized.startsWith("access-control-")) {
            delete result[name];
        }
    }
    Object.assign(result, structuredHeaders);
    const authorization = upstreamAuthorization || legacyAuthorization;
    if (authorization) result.authorization = authorization;
    if (upstreamReferer && !result.referer) result.referer = upstreamReferer;
    return result;
}

function filterUpstreamResponseHeaders(headers, options = {}) {
    const excluded = new Set([
        ...HOP_BY_HOP_HEADERS,
        ...PROXY_RESPONSE_CONTROL_HEADERS,
        ...connectionHeaderNames(headers)
    ]);
    if (!options.preserveContentLength) excluded.add("content-length");
    const result = omitHeaders(headers, excluded);
    if (!options.stripCors) return result;
    return Object.fromEntries(
        Object.entries(result).filter(([name]) => !normalizeHeaderName(name).startsWith("access-control-"))
    );
}

module.exports = {
    HOP_BY_HOP_HEADERS,
    PROXY_RESPONSE_CONTROL_HEADERS,
    PROXY_AUTHENTICATION_HEADERS,
    UPSTREAM_AUTHORIZATION_HEADER,
    LEGACY_UPSTREAM_AUTHORIZATION_HEADER,
    UPSTREAM_REFERER_HEADER,
    UPSTREAM_HEADERS_HEADER,
    SENSITIVE_UPSTREAM_HEADERS,
    buildUpstreamRequestHeaders,
    decodeUpstreamHeaders,
    filterUpstreamResponseHeaders,
    getHeader,
    isHopByHopHeader,
    isProxyAuthenticationHeader,
    normalizeHeaderName,
    normalizeUpstreamOrigin,
    normalizeUpstreamReferer,
    isBlockedUpstreamHeader,
    omitHeaders
};
