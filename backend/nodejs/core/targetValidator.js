const { domainToASCII } = require("node:url");
const ipaddr = require("ipaddr.js");
const { ERROR_CODES, ProxyError } = require("./errors");

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const INVALID_PERCENT_ENCODING = /%(?![0-9A-Fa-f]{2})/;
const RAW_WHITESPACE_OR_CONTROL = /[\u0000-\u0020\u007f]/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const NON_PUBLIC_CIDRS = Object.freeze([
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.31.196.0/24",
    "192.52.193.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "192.175.48.0/24",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "::/96",
    "::1/128",
    "64:ff9b::/96",
    "64:ff9b:1::/48",
    "100::/64",
    "2001::/23",
    "2001:db8::/32",
    "2002::/16",
    "2620:4f:8000::/48",
    "3fff::/20",
    "5f00::/16",
    "fc00::/7",
    "fe80::/10",
    "fec0::/10",
    "ff00::/8"
].map(value => Object.freeze(ipaddr.parseCIDR(value))));

function createValidationError(code, message, statusCode, details, cause) {
    return new ProxyError(code, message, { statusCode, details, cause });
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

function isPublicAddress(value) {
    const normalized = normalizeIpAddress(value);
    if (!normalized) return false;
    const address = ipaddr.parse(normalized.address);
    return !NON_PUBLIC_CIDRS.some(([network, prefix]) => (
        network.kind() === address.kind() && address.match(network, prefix)
    ));
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
        if (!isPublicAddress(hostname)) {
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

    if (!ip) {
        if (typeof context.resolveHostname !== "function") {
            throw createValidationError(
                ERROR_CODES.DNS_FAILED,
                "Unable to resolve target hostname",
                502,
                { hostname, reason: "resolver-unavailable" }
            );
        }

        let resolved;
        try {
            resolved = await context.resolveHostname(hostname);
        } catch (error) {
            throw createValidationError(
                ERROR_CODES.DNS_FAILED,
                "Unable to resolve target hostname",
                502,
                { hostname, reason: error.code || "lookup-failed" },
                error
            );
        }

        if (!Array.isArray(resolved) || resolved.length === 0) {
            throw createValidationError(
                ERROR_CODES.DNS_FAILED,
                "Unable to resolve target hostname",
                502,
                { hostname, reason: "empty-result" }
            );
        }

        const unique = new Map();
        for (const result of resolved) {
            const sourceAddress = result && typeof result.address === "string"
                ? stripIpv6Brackets(result.address)
                : null;
            const source = sourceAddress && ipaddr.isValid(sourceAddress)
                ? ipaddr.parse(sourceAddress)
                : null;
            const normalized = result && normalizeIpAddress(result.address);
            const sourceFamily = source && source.kind() === "ipv4" ? 4 : 6;
            if (!source || !normalized || ![4, 6].includes(result.family) || result.family !== sourceFamily) {
                throw createValidationError(
                    ERROR_CODES.DNS_FAILED,
                    "Unable to resolve target hostname",
                    502,
                    { hostname, reason: "invalid-result" }
                );
            }
            if (!isPublicAddress(normalized.address)) {
                throw createValidationError(
                    ERROR_CODES.SSRF_BLOCKED,
                    "Target resolves to a non-public address",
                    403,
                    { hostname, address: normalized.address, range: normalized.range }
                );
            }
            unique.set(`${normalized.family}:${normalized.address}`, Object.freeze({
                address: normalized.address,
                family: normalized.family
            }));
        }

        addresses = [...unique.values()];
        if (addresses.length === 0) {
            throw createValidationError(
                ERROR_CODES.DNS_FAILED,
                "Unable to resolve target hostname",
                502,
                { hostname, reason: "empty-normalized-result" }
            );
        }
        selectedAddress = addresses[0].address;
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
    isPublicAddress,
    isHostnameBlocked,
    normalizeHostnameRule,
    normalizeIpAddress,
    parseTargetUrl,
    validateTarget
};
