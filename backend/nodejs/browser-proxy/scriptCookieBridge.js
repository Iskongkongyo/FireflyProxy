const { encodeOrigin } = require("../core/urlMapper");

const SCRIPT_COOKIE_PREFIX = "__fireflyproxy_sc_";
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_COOKIE_HEADER_LENGTH = 65536;
const MAX_BRIDGED_COOKIES = 128;

function scriptCookiePrefix(targetUrl) {
    const origin = new URL(targetUrl).origin;
    return `${SCRIPT_COOKIE_PREFIX}${encodeOrigin(origin)}_`;
}

function encodeScriptCookieName(name) {
    const value = String(name);
    if (!value || value.length > 256 || !COOKIE_NAME_PATTERN.test(value)) return null;
    return Buffer.from(value, "utf8").toString("base64url");
}

function decodeScriptCookieName(token) {
    if (!/^[A-Za-z0-9_-]+$/.test(token || "")) return null;
    let name;
    try {
        name = Buffer.from(token, "base64url").toString("utf8");
    } catch {
        return null;
    }
    if (Buffer.from(name, "utf8").toString("base64url") !== token) return null;
    return encodeScriptCookieName(name) ? name : null;
}

function parseCookiePairs(cookieHeader) {
    if (typeof cookieHeader !== "string" || !cookieHeader || cookieHeader.length > MAX_COOKIE_HEADER_LENGTH) {
        return [];
    }
    const pairs = [];
    for (const part of cookieHeader.split(";")) {
        const candidate = part.trim();
        const separator = candidate.indexOf("=");
        if (separator <= 0) continue;
        const name = candidate.slice(0, separator).trim();
        const value = candidate.slice(separator + 1).trim();
        if (!name) continue;
        pairs.push({ name, value });
    }
    return pairs;
}

function getScriptCookieHeader(inboundCookieHeader, targetUrl) {
    const prefix = scriptCookiePrefix(targetUrl);
    const bridged = [];
    for (const pair of parseCookiePairs(inboundCookieHeader)) {
        if (!pair.name.startsWith(prefix)) continue;
        const name = decodeScriptCookieName(pair.name.slice(prefix.length));
        if (!name) continue;
        bridged.push({ name, value: pair.value });
        if (bridged.length >= MAX_BRIDGED_COOKIES) break;
    }
    return bridged.map(({ name, value }) => `${name}=${value}`).join("; ");
}

function mergeCookieHeaders(jarCookieHeader, scriptCookieHeader) {
    const jarPairs = parseCookiePairs(jarCookieHeader);
    const scriptPairs = parseCookiePairs(scriptCookieHeader);
    if (scriptPairs.length === 0) return jarPairs.map(({ name, value }) => `${name}=${value}`).join("; ");

    const scriptNames = new Set(scriptPairs.map(pair => pair.name));
    return [...jarPairs.filter(pair => !scriptNames.has(pair.name)), ...scriptPairs]
        .map(({ name, value }) => `${name}=${value}`)
        .join("; ");
}

module.exports = {
    SCRIPT_COOKIE_PREFIX,
    decodeScriptCookieName,
    encodeScriptCookieName,
    getScriptCookieHeader,
    mergeCookieHeaders,
    scriptCookiePrefix
};
