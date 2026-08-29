const SENSITIVE_HEADER_NAMES = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "x-access-token"
]);

export const UPSTREAM_AUTHORIZATION_HEADER = "X-ProxyWeb-Upstream-Authorization";

export function normalizeHeaderName(name) {
    return String(name || "").trim().toLowerCase();
}

export function isSensitiveHeaderName(name) {
    const normalized = normalizeHeaderName(name);
    if (SENSITIVE_HEADER_NAMES.has(normalized)) return true;
    return /(^|[-_])(authorization|cookie|token|secret|password|api[-_]?key)($|[-_])/.test(normalized);
}

export function omitSensitiveHeaders(headers = {}) {
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) => !isSensitiveHeaderName(name))
    );
}

export function omitSensitiveHeaderRows(rows = []) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => row && row.key && !isSensitiveHeaderName(row.key));
}

export function buildProxyTransport(baseUrl, targetUrl, headers = {}, upstreamAuthorization = "") {
    const transportHeaders = {};
    let authorization = upstreamAuthorization;

    for (const [name, value] of Object.entries(headers)) {
        if (normalizeHeaderName(name) === "authorization") {
            authorization = value || authorization;
        } else {
            transportHeaders[name] = value;
        }
    }
    if (authorization) transportHeaders[UPSTREAM_AUTHORIZATION_HEADER] = authorization;

    return {
        url: `${baseUrl}/?url=${encodeURIComponent(String(targetUrl))}`,
        headers: transportHeaders
    };
}
