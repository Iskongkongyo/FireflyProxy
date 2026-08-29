const { domainToASCII } = require("node:url");
const ipaddr = require("ipaddr.js");
const { ERROR_CODES, ProxyError } = require("./errors");

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const INVALID_PERCENT_ENCODING = /%(?![0-9A-Fa-f]{2})/;
const RAW_WHITESPACE_OR_CONTROL = /[\u0000-\u0020\u007f]/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function createValidationError(code, message, statusCode, details) {
    return new ProxyError(code, message, { statusCode, details });
}

function invalidUrl(details) {
    return createValidationError(
        ERROR_CODES.INVALID_URL,
        "Target URL is invalid",
        400,
        details
    );
}

function stripIpv6Brackets(hostname) {
    return hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname;
}

function normalizeIpAddress(value) {
    if (!ipaddr.isValid(value)) return null;
    const address = ipaddr.process(value);
    return {
        address: address.toString(),
        family: address.kind() === "ipv4" ? 4 : 6,
        range: address.range()
    };
}

function normalizeDnsHostname(value) {
    const withoutTrailingDot = value.endsWith(".") ? value.slice(0, -1) : value;
    if (!withoutTrailingDot || withoutTrailingDot.length > 253) return null;

    const hostname = domainToASCII(withoutTrailingDot.toLowerCase());
    if (!hostname || hostname.length > 253) return null;
    const labels = hostname.split(".");
    if (labels.some(label => !DNS_LABEL.test(label))) return null;
    return hostname;
}

function normalizeHostnameRule(value) {
    if (typeof value !== "string" || !value || value !== value.trim()) return null;

    const wildcard = value.startsWith("*.");
    const candidate = wildcard ? value.slice(2) : value;
    if (!candidate || (wildcard && candidate.includes("*"))) return null;

    const unwrapped = stripIpv6Brackets(candidate.endsWith(".")
        ? candidate.slice(0, -1)
        : candidate);
    const ip = normalizeIpAddress(unwrapped);
    if (ip) return wildcard ? null : ip.address;
    if (/[\\/@?#:%*]/.test(candidate)) return null;

    const hostname = normalizeDnsHostname(candidate);
    return hostname ? `${wildcard ? "*." : ""}${hostname}` : null;
}

function isHostnameBlocked(hostname, rules = []) {
    return rules.some(value => {
        const rule = normalizeHostnameRule(value);
        if (!rule) return false;
        if (!rule.startsWith("*.")) return hostname === rule;
        const suffix = rule.slice(1);
        return hostname.endsWith(suffix) && hostname.length > suffix.length;
    });
}

function parseTargetUrl(value) {
    if (typeof value !== "string" || !value || value !== value.trim()) {
        throw invalidUrl({ reason: "missing-or-noncanonical-input" });
    }
    if (RAW_WHITESPACE_OR_CONTROL.test(value) || value.includes("\\") || INVALID_PERCENT_ENCODING.test(value)) {
        throw invalidUrl({ reason: "invalid-encoding" });
    }

    let url;
    try {
        url = new URL(value);
    } catch (error) {
        throw invalidUrl({ reason: "parse-failed", cause: error.code });
    }

    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        throw createValidationError(
            ERROR_CODES.PROTOCOL_BLOCKED,
            "Target protocol is not allowed",
            403,
            { protocol: url.protocol }
        );
    }
    if (!/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value)) {
        throw invalidUrl({ reason: "noncanonical-scheme" });
    }
    if (url.username || url.password) {
        throw invalidUrl({ reason: "credentials-forbidden" });
    }

    const authority = value.match(/^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/u)?.[1];
    if (!authority || authority.includes("%")) {
        throw invalidUrl({ reason: "encoded-or-empty-authority" });
    }
    if (!url.hostname) throw invalidUrl({ reason: "empty-hostname" });
    return url;
}

async function validateTarget(value, context = {}) {
    const url = parseTargetUrl(value);
    const rawHostname = stripIpv6Brackets(url.hostname);
    const ip = normalizeIpAddress(rawHostname);

    let hostname;
    let addresses = [];
    let selectedAddress = null;

    if (ip) {
        hostname = ip.address;
        if (ip.range !== "unicast") {
            throw createValidationError(
                ERROR_CODES.SSRF_BLOCKED,
                "Target address is not public",
                403,
                { hostname, range: ip.range }
            );
        }
        addresses = [Object.freeze({ address: hostname, family: ip.family })];
        selectedAddress = hostname;
        url.hostname = ip.family === 6 ? `[${hostname}]` : hostname;
    } else {
        hostname = normalizeDnsHostname(rawHostname);
        if (!hostname) throw invalidUrl({ reason: "invalid-hostname" });
        if (hostname === "localhost" || hostname.endsWith(".localhost")) {
            throw createValidationError(
                ERROR_CODES.SSRF_BLOCKED,
                "Target hostname is blocked",
                403,
                { hostname, reason: "localhost" }
            );
        }
        url.hostname = hostname;
    }

    if (isHostnameBlocked(hostname, context.blockedHostnames)) {
        throw createValidationError(
            ERROR_CODES.SSRF_BLOCKED,
            "Target hostname is blocked",
            403,
            { hostname, reason: "configured-rule" }
        );
    }

    return Object.freeze({
        url: url.href,
        protocol: url.protocol,
        hostname,
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
        addresses: Object.freeze(addresses),
        selectedAddress
    });
}

module.exports = {
    isHostnameBlocked,
    normalizeHostnameRule,
    normalizeIpAddress,
    parseTargetUrl,
    validateTarget
};
