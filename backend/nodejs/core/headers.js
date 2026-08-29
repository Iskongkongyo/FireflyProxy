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

const UPSTREAM_AUTHORIZATION_HEADER = "x-proxyweb-upstream-authorization";

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

function buildUpstreamRequestHeaders(inboundHeaders, customHeaders = {}) {
    const merged = { ...(inboundHeaders || {}), ...(customHeaders || {}) };
    const upstreamAuthorization = getHeader(inboundHeaders, UPSTREAM_AUTHORIZATION_HEADER);
    const legacyAuthorization = getHeader(customHeaders, "authorization");
    const excluded = new Set([
        ...HOP_BY_HOP_HEADERS,
        ...LEGACY_REQUEST_EXCLUDED_HEADERS,
        "authorization",
        UPSTREAM_AUTHORIZATION_HEADER,
        ...connectionHeaderNames(inboundHeaders),
        ...connectionHeaderNames(customHeaders)
    ]);
    const result = omitHeaders(merged, excluded);
    const authorization = upstreamAuthorization || legacyAuthorization;
    if (authorization) result.authorization = authorization;
    return result;
}

function filterUpstreamResponseHeaders(headers) {
    const excluded = new Set([
        ...HOP_BY_HOP_HEADERS,
        ...connectionHeaderNames(headers),
        "content-length"
    ]);
    return omitHeaders(headers, excluded);
}

module.exports = {
    HOP_BY_HOP_HEADERS,
    PROXY_AUTHENTICATION_HEADERS,
    UPSTREAM_AUTHORIZATION_HEADER,
    buildUpstreamRequestHeaders,
    filterUpstreamResponseHeaders,
    isHopByHopHeader,
    isProxyAuthenticationHeader,
    normalizeHeaderName,
    omitHeaders
};
