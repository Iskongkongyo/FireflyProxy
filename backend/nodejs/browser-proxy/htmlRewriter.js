const cheerio = require("cheerio");
const { resolveTargetUrl, toProxyUrl } = require("../core/urlMapper");
const { rewriteCss, rewriteCssValue } = require("./cssRewriter");
const { RUNTIME_BRIDGE_PATH } = require("./runtimeBridge");

const URL_ATTRIBUTES = Object.freeze([
    ["a[href]", "href"],
    ["area[href]", "href"],
    ["link[href]", "href"],
    ["script[src]", "src"],
    ["img[src]", "src"],
    ["source[src]", "src"],
    ["iframe[src]", "src"],
    ["frame[src]", "src"],
    ["form[action]", "action"],
    ["input[src]", "src"],
    ["input[formaction]", "formaction"],
    ["button[formaction]", "formaction"],
    ["video[src]", "src"],
    ["video[poster]", "poster"],
    ["audio[src]", "src"],
    ["track[src]", "src"],
    ["object[data]", "data"],
    ["embed[src]", "src"]
]);

function rewriteUrlValue(value, baseUrl, mapperOptions) {
    const resolved = resolveTargetUrl(value, baseUrl);
    return resolved ? toProxyUrl(resolved, mapperOptions) : value;
}

function parseSrcset(value) {
    const input = String(value || "");
    const candidates = [];
    let cursor = 0;

    while (cursor < input.length) {
        while (cursor < input.length && /[\t\n\f\r ,]/.test(input[cursor])) cursor += 1;
        if (cursor >= input.length) break;

        const urlStart = cursor;
        while (cursor < input.length && !/[\t\n\f\r ]/.test(input[cursor])) cursor += 1;
        let url = input.slice(urlStart, cursor);
        let endedByComma = false;
        while (url.endsWith(",")) {
            endedByComma = true;
            url = url.slice(0, -1);
        }
        if (!url) continue;

        if (endedByComma) {
            candidates.push({ url, descriptor: "" });
            continue;
        }

        while (cursor < input.length && /[\t\n\f\r ]/.test(input[cursor])) cursor += 1;
        const descriptorStart = cursor;
        let parentheses = 0;
        let quote = "";
        while (cursor < input.length) {
            const character = input[cursor];
            if (quote) {
                if (character === "\\") cursor += 1;
                else if (character === quote) quote = "";
            } else if (character === "\"" || character === "'") {
                quote = character;
            } else if (character === "(") {
                parentheses += 1;
            } else if (character === ")" && parentheses > 0) {
                parentheses -= 1;
            } else if (character === "," && parentheses === 0) {
                break;
            }
            cursor += 1;
        }
        candidates.push({
            url,
            descriptor: input.slice(descriptorStart, cursor).trim()
        });
        if (input[cursor] === ",") cursor += 1;
    }

    return candidates;
}

function rewriteSrcset(value, baseUrl, mapperOptions) {
    const candidates = parseSrcset(value);
    if (candidates.length === 0) return value;
    return candidates
        .map(({ url, descriptor }) => {
            const rewritten = rewriteUrlValue(url, baseUrl, mapperOptions);
            return descriptor ? `${rewritten} ${descriptor}` : rewritten;
        })
        .join(", ");
}

function rewriteInlineStyle(value, baseUrl, mapperOptions) {
    return rewriteCssValue(value, baseUrl, mapperOptions);
}

function rewriteMetaRefresh(value, baseUrl, mapperOptions) {
    const match = /^(\s*(?:\d+(?:\.\d*)?|\.\d+)\s*;\s*url\s*=\s*)([\s\S]*)$/i.exec(String(value || ""));
    if (!match) return value;

    const leadingWhitespace = /^\s*/.exec(match[2])[0];
    const trailingWhitespace = /\s*$/.exec(match[2])[0];
    const candidate = match[2].slice(
        leadingWhitespace.length,
        match[2].length - trailingWhitespace.length
    );
    if (!candidate) return value;
    const startsWithQuote = ["\"", "'"].includes(candidate[0]);
    const endsWithQuote = ["\"", "'"].includes(candidate[candidate.length - 1]);
    if (startsWithQuote !== endsWithQuote || (startsWithQuote && candidate[0] !== candidate[candidate.length - 1])) {
        return value;
    }
    const quote = candidate.length >= 2
        && candidate[0] === candidate[candidate.length - 1]
        && ["\"", "'"].includes(candidate[0])
        ? candidate[0]
        : "";
    const rawUrl = quote ? candidate.slice(1, -1) : candidate;
    const rewritten = rewriteUrlValue(rawUrl, baseUrl, mapperOptions);
    if (rewritten === rawUrl) return value;

    return `${match[1]}${leadingWhitespace}${quote}${rewritten}${quote}${trailingWhitespace}`;
}

function rewriteAttributeSet($, selector, attribute, baseUrl, mapperOptions) {
    $(selector).each((index, element) => {
        const current = $(element).attr(attribute);
        if (typeof current !== "string") return;
        $(element).attr(attribute, rewriteUrlValue(current, baseUrl, mapperOptions));
    });
}

function injectRuntimeBridge($, documentUrl, baseUrl = null, options = {}) {
    if ($("script[data-fireflyproxy-runtime]").length > 0) return false;
    const script = $("<script></script>")
        .attr("src", RUNTIME_BRIDGE_PATH)
        .attr("data-fireflyproxy-runtime", documentUrl);
    if (baseUrl) script.attr("data-fireflyproxy-base-url", baseUrl);
    if (options.scriptCookieBridge) {
        script.attr("data-fireflyproxy-script-cookie-bridge", "true");
    }
    if (options.webSocket && options.webSocketContext) {
        script.attr("data-fireflyproxy-websocket", "true");
        script.attr("data-fireflyproxy-origin-context", options.webSocketContext);
    }
    if (options.originIsolation?.enabled) {
        script.attr("data-fireflyproxy-isolation-base-origin", options.originIsolation.baseOrigin);
    }
    const head = $("head").first();
    if (head.length > 0) head.prepend(script);
    else $.root().prepend(script);
    return true;
}

function rewriteHtml({
    html,
    documentUrl,
    mediaType = "text/html",
    runtimeBridge = false,
    scriptCookieBridge = false,
    webSocket = false,
    webSocketContext = null,
    mapperOptions
}) {
    const xmlMode = mediaType === "application/xhtml+xml";
    const $ = cheerio.load(String(html || ""), xmlMode ? { xml: true } : undefined);
    const firstBase = $("base[href]").first();
    const firstBaseHref = firstBase.attr("href");
    const resolvedBaseUrl = typeof firstBaseHref === "string"
        ? resolveTargetUrl(firstBaseHref, documentUrl)
        : null;
    const effectiveBaseUrl = resolvedBaseUrl || documentUrl;

    for (const [selector, attribute] of URL_ATTRIBUTES) {
        rewriteAttributeSet($, selector, attribute, effectiveBaseUrl, mapperOptions);
    }

    $("img[srcset], source[srcset]").each((index, element) => {
        const current = $(element).attr("srcset");
        if (typeof current === "string") $(element).attr("srcset", rewriteSrcset(current, effectiveBaseUrl, mapperOptions));
    });

    $("[style]").each((index, element) => {
        const current = $(element).attr("style");
        if (typeof current === "string") $(element).attr("style", rewriteInlineStyle(current, effectiveBaseUrl, mapperOptions));
    });

    $("style").each((index, element) => {
        const style = $(element);
        const type = String(style.attr("type") || "text/css").trim().toLowerCase();
        if (type !== "text/css") return;
        const current = style.html();
        if (typeof current === "string") {
            style.text(rewriteCss({ css: current, stylesheetUrl: effectiveBaseUrl, mapperOptions }));
        }
    });

    $("meta[http-equiv]").each((index, element) => {
        const meta = $(element);
        if (String(meta.attr("http-equiv") || "").trim().toLowerCase() !== "refresh") return;
        const current = meta.attr("content");
        if (typeof current === "string") meta.attr("content", rewriteMetaRefresh(current, effectiveBaseUrl, mapperOptions));
    });

    $("base[href]").each((index, element) => {
        const current = $(element).attr("href");
        if (typeof current === "string") $(element).attr("href", rewriteUrlValue(current, documentUrl, mapperOptions));
    });

    if (runtimeBridge) injectRuntimeBridge(
        $,
        documentUrl,
        resolvedBaseUrl,
        {
            scriptCookieBridge,
            webSocket,
            webSocketContext,
            originIsolation: mapperOptions?.originIsolation
        }
    );

    return xmlMode ? $.xml() : $.html();
}

module.exports = {
    injectRuntimeBridge,
    parseSrcset,
    rewriteHtml,
    rewriteInlineStyle,
    rewriteMetaRefresh,
    rewriteSrcset,
    rewriteUrlValue
};
