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

export const UPSTREAM_AUTHORIZATION_HEADER = "X-FireflyProxy-Upstream-Authorization";
export const UPSTREAM_REFERER_HEADER = "X-FireflyProxy-Upstream-Referer";
export const UPSTREAM_HEADERS_HEADER = "X-FireflyProxy-Upstream-Headers";

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_UPSTREAM_HEADER_ENVELOPE_BYTES = 8 * 1024;
const MAX_UPSTREAM_HEADER_COUNT = 100;
const MAX_UPSTREAM_HEADER_VALUE_BYTES = 4 * 1024;
const BLOCKED_UPSTREAM_HEADER_NAMES = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "set-cookie",
    "forwarded",
    "x-real-ip"
]);

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

export function isUnsupportedUpstreamHeaderName(name) {
    const original = String(name || "").trim();
    const normalized = normalizeHeaderName(original);
    return !HEADER_NAME_PATTERN.test(original)
        || BLOCKED_UPSTREAM_HEADER_NAMES.has(normalized)
        || normalized.startsWith("proxy-")
        || normalized.startsWith("sec-")
        || normalized.startsWith("access-control-")
        || normalized.startsWith("x-forwarded-")
        || normalized.startsWith("x-fireflyproxy-")
        || normalized.startsWith("x-proxyweb-");
}

function isValidUpstreamHeaderValue(name, value) {
    const text = String(value ?? "");
    if (new TextEncoder().encode(text).length > MAX_UPSTREAM_HEADER_VALUE_BYTES) return false;
    if (/[\r\n\0]/.test(text) || !/^[\t\x20-\x7e\x80-\xff]*$/.test(text)) return false;
    const normalized = normalizeHeaderName(name);
    if (normalized === "origin") {
        if (text === "null") return true;
        try {
            const origin = new URL(text);
            return ["http:", "https:"].includes(origin.protocol)
                && !origin.username
                && !origin.password
                && origin.pathname === "/"
                && !origin.search
                && !origin.hash;
        } catch {
            return false;
        }
    }
    if (normalized === "referer") {
        try {
            const referer = new URL(text);
            return ["http:", "https:"].includes(referer.protocol)
                && !referer.username
                && !referer.password
                && !referer.hash;
        } catch {
            return false;
        }
    }
    return true;
}

function encodeBase64UrlUtf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeUpstreamHeadersEnvelope(value) {
    const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/")
        .padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

export function buildProxyTransport(baseUrl, targetUrl, headers = {}, upstreamAuthorization = "") {
    const transportHeaders = {};
    let authorization = upstreamAuthorization;
    const upstreamHeaders = [];
    const ignoredHeaders = [];

    for (const [name, value] of Object.entries(headers)) {
        const normalizedName = normalizeHeaderName(name);
        if (normalizedName === "authorization") {
            authorization = value || authorization;
        } else if (isUnsupportedUpstreamHeaderName(name) || !isValidUpstreamHeaderValue(name, value)) {
            ignoredHeaders.push(name);
        } else {
            upstreamHeaders.push([String(name).trim(), String(value ?? "")]);
        }
    }
    while (
        upstreamHeaders.length > MAX_UPSTREAM_HEADER_COUNT
        || new TextEncoder().encode(JSON.stringify(upstreamHeaders)).length > MAX_UPSTREAM_HEADER_ENVELOPE_BYTES
    ) {
        const [name] = upstreamHeaders.pop();
        ignoredHeaders.push(name);
    }
    if (authorization) transportHeaders[UPSTREAM_AUTHORIZATION_HEADER] = authorization;
    if (upstreamHeaders.length) {
        transportHeaders[UPSTREAM_HEADERS_HEADER] = encodeBase64UrlUtf8(JSON.stringify(upstreamHeaders));
    }

    const proxyBaseUrl = String(baseUrl).replace(/\/+$/, "");
    return {
        url: `${proxyBaseUrl}/__proxyweb/api?url=${encodeURIComponent(String(targetUrl))}`,
        headers: transportHeaders,
        ignoredHeaders
    };
}
