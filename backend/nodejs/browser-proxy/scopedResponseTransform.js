const { createHash } = require("node:crypto");
const cheerio = require("cheerio");
const { ERROR_CODES, ProxyError } = require("../core/errors");
const { normalizeHostnameRule } = require("../core/targetValidator");

const EXPLICIT_TEXT_MEDIA_TYPES = new Set([
    "application/ecmascript",
    "application/javascript",
    "application/json",
    "application/manifest+json",
    "application/rss+xml",
    "application/xhtml+xml",
    "application/xml",
    "application/x-javascript",
    "application/atom+xml",
    "image/svg+xml"
]);

function isTransformableTextMediaType(mediaType) {
    const normalized = String(mediaType || "").trim().toLowerCase();
    if (!normalized || normalized === "text/event-stream") return false;
    return normalized.startsWith("text/")
        || EXPLICIT_TEXT_MEDIA_TYPES.has(normalized)
        || normalized.endsWith("+json")
        || normalized.endsWith("+xml");
}

function hostnameMatches(hostname, pattern) {
    const normalized = normalizeHostnameRule(pattern);
    const normalizedHostname = normalizeHostnameRule(hostname);
    if (!normalized || !normalizedHostname || normalizedHostname.startsWith("*.")) return false;
    if (!normalized.startsWith("*.")) return normalizedHostname === normalized;
    const suffix = normalized.slice(1);
    return normalizedHostname.endsWith(suffix) && normalizedHostname.length > suffix.length;
}

function contentTypeMatches(mediaType, pattern) {
    const normalized = String(pattern || "").toLowerCase();
    if (normalized.endsWith("/*")) {
        return mediaType.startsWith(normalized.slice(0, -1));
    }
    return mediaType === normalized;
}

function ruleHasApplicableOperation(rule, mediaType) {
    if (rule.replacements.length > 0) return true;
    return ["text/html", "application/xhtml+xml"].includes(mediaType)
        && Boolean(rule.appendHead || rule.prependBody);
}

function ruleMatches(rule, targetUrl, mediaType) {
    if (
        !rule?.enabled
        || !isTransformableTextMediaType(mediaType)
        || !ruleHasApplicableOperation(rule, mediaType)
    ) return false;
    let target;
    try {
        target = new URL(targetUrl);
    } catch {
        return false;
    }
    return rule.hosts.some(pattern => hostnameMatches(target.hostname, pattern))
        && target.pathname.startsWith(rule.pathPrefix)
        && rule.contentTypes.some(pattern => contentTypeMatches(mediaType, pattern));
}

function matchingRules(config, targetUrl, mediaType) {
    const responseTransform = config?.browser?.responseTransform;
    if (!responseTransform?.enabled || !Array.isArray(responseTransform.rules)) return [];
    return responseTransform.rules.filter(rule => ruleMatches(rule, targetUrl, mediaType));
}

function hasMatchingResponseTransform(config, targetUrl, mediaType) {
    return matchingRules(config, targetUrl, mediaType).length > 0;
}

function transformLimitError(limit) {
    return new ProxyError(ERROR_CODES.REWRITE_LIMIT, "Response exceeds rewrite size limit", {
        statusCode: 413,
        details: { limit }
    });
}

function assertOutputBound(text, limit) {
    if (Number.isFinite(limit) && Buffer.byteLength(text, "utf8") > limit) {
        throw transformLimitError(limit);
    }
}

function replaceLiteral(input, search, replacement, limit, maxOutputBytes = Infinity) {
    const maxReplacements = Math.max(0, Number(limit) || 0);
    if (!search || maxReplacements === 0) return { text: input, replacements: 0 };

    const chunks = [];
    let cursor = 0;
    let count = 0;
    let projectedBytes = Buffer.byteLength(input, "utf8");
    const byteDelta = Buffer.byteLength(replacement, "utf8") - Buffer.byteLength(search, "utf8");
    while (count < maxReplacements) {
        const index = input.indexOf(search, cursor);
        if (index < 0) break;
        projectedBytes += byteDelta;
        if (projectedBytes > maxOutputBytes) throw transformLimitError(maxOutputBytes);
        chunks.push(input.slice(cursor, index), replacement);
        cursor = index + search.length;
        count += 1;
    }
    if (count === 0) return { text: input, replacements: 0 };
    chunks.push(input.slice(cursor));
    return { text: chunks.join(""), replacements: count };
}

function injectHtml(text, mediaType, rules) {
    const appendHead = rules.map(rule => rule.appendHead).filter(Boolean);
    const prependBody = rules.map(rule => rule.prependBody).filter(Boolean);
    if (appendHead.length === 0 && prependBody.length === 0) {
        return { text, injections: 0 };
    }

    const xmlMode = mediaType === "application/xhtml+xml";
    const $ = cheerio.load(String(text), xmlMode ? { xml: true } : undefined);
    if (appendHead.length > 0) {
        const head = $("head").first();
        if (head.length > 0) head.append(appendHead.join(""));
        else $.root().prepend(appendHead.join(""));
    }
    if (prependBody.length > 0) {
        const body = $("body").first();
        if (body.length > 0) body.prepend(prependBody.join(""));
        else $.root().append(prependBody.join(""));
    }
    return {
        text: xmlMode ? $.xml() : $.html(),
        injections: appendHead.length + prependBody.length
    };
}

function responseTransformVersion(config) {
    const responseTransform = config?.browser?.responseTransform || { enabled: false, rules: [] };
    return createHash("sha256")
        .update(JSON.stringify(responseTransform))
        .digest("hex")
        .slice(0, 16);
}

function applyScopedResponseTransform({ text, mediaType, targetUrl, config }) {
    const rules = matchingRules(config, targetUrl, mediaType);
    let output = String(text);
    let replacements = 0;
    const maxOutputBytes = config?.security?.maxRewriteBytes ?? Infinity;

    for (const rule of rules) {
        for (const replacement of rule.replacements) {
            const limit = replacement.mode === "once" ? 1 : replacement.maxReplacements;
            const result = replaceLiteral(
                output,
                replacement.search,
                replacement.replacement,
                limit,
                maxOutputBytes
            );
            output = result.text;
            replacements += result.replacements;
        }
    }

    let injections = 0;
    if (["text/html", "application/xhtml+xml"].includes(mediaType)) {
        const fragmentBytes = rules.reduce((total, rule) => (
            total + Buffer.byteLength(rule.appendHead, "utf8") + Buffer.byteLength(rule.prependBody, "utf8")
        ), 0);
        if (Number.isFinite(maxOutputBytes)
            && Buffer.byteLength(output, "utf8") + fragmentBytes > maxOutputBytes) {
            throw transformLimitError(maxOutputBytes);
        }
        const result = injectHtml(output, mediaType, rules);
        output = result.text;
        injections = result.injections;
    }
    assertOutputBound(output, maxOutputBytes);

    return {
        text: output,
        matchedRuleIds: rules.map(rule => rule.id),
        replacements,
        injections,
        version: responseTransformVersion(config)
    };
}

module.exports = {
    applyScopedResponseTransform,
    contentTypeMatches,
    hasMatchingResponseTransform,
    hostnameMatches,
    isTransformableTextMediaType,
    matchingRules,
    replaceLiteral,
    responseTransformVersion,
    ruleHasApplicableOperation,
    ruleMatches,
    transformLimitError
};
