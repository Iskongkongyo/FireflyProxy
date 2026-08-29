const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
    "authorization",
    "proxyauthorization",
    "xproxywebupstreamauthorization",
    "cookie",
    "setcookie",
    "token",
    "accesstoken",
    "refreshtoken",
    "password",
    "passwd",
    "pwd",
    "secret",
    "key",
    "apikey",
    "xapikey",
    "headers"
]);

function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key) {
    return SENSITIVE_KEYS.has(normalizeKey(key));
}

function redactString(value) {
    return String(value)
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
        .replace(
            /((?:x[-_]?proxyweb[-_]?upstream[-_]?authorization|proxy[-_]?authorization|authorization|set[-_]?cookie|cookie|access[-_]?token|refresh[-_]?token|token|password|passwd|pwd|secret|x[-_]?api[-_]?key|api[-_]?key|apikey|key|headers)(?:%22|["']?)\s*(?:%3A|%3D|[:=])\s*)(?:%22[^&\s]*|"[^"]*"|'[^']*'|[^&\s,}]+)/gi,
            `$1${REDACTED}`
        );
}

function redact(value, seen = new WeakSet()) {
    if (typeof value === "string") return redactString(value);
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;

    if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
    if (value instanceof Date) return value.toISOString();
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (value instanceof Error) {
        return {
            name: value.name,
            message: redactString(value.message),
            stack: value.stack ? redactString(value.stack) : undefined,
            code: value.code
        };
    }

    if (Array.isArray(value)) {
        return value.map(item => redact(item, seen));
    }

    const result = {};
    for (const [key, item] of Object.entries(value)) {
        result[key] = isSensitiveKey(key) ? REDACTED : redact(item, seen);
    }
    return result;
}

module.exports = {
    REDACTED,
    isSensitiveKey,
    redact,
    redactString
};
