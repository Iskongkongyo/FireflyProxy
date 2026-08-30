const {
    buildUpstreamRequestHeaders,
    filterUpstreamResponseHeaders,
    getHeader,
    normalizeHeaderName,
    omitHeaders
} = require("../core/headers");
const { rewriteCss } = require("./cssRewriter");
const { rewriteHtml } = require("./htmlRewriter");
const { toProxyUrl } = require("../core/urlMapper");

function replaceHeader(headers, name, value) {
    const normalizedName = normalizeHeaderName(name);
    for (const existingName of Object.keys(headers)) {
        if (normalizeHeaderName(existingName) === normalizedName) delete headers[existingName];
    }
    headers[normalizedName] = value;
}

function filterBrowserResponseHeaders(upstreamHeaders, config, context = {}) {
    const headers = filterUpstreamResponseHeaders(upstreamHeaders, {
        preserveContentLength: context.preserveContentLength
    });
    if (config.browser.headerPolicy === "compat") {
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
    }
    if (context.redirectTargetUrl && getHeader(headers, "location")) {
        replaceHeader(headers, "location", toProxyUrl(context.redirectTargetUrl));
    }
    return headers;
}

const browserPolicy = Object.freeze({
    mode: "browser",
    exposeCors: false,
    buildRequestHeaders(inboundHeaders, customHeaders) {
        const headers = buildUpstreamRequestHeaders(inboundHeaders, customHeaders);
        return {
            ...omitHeaders(headers, ["accept-encoding"]),
            "accept-encoding": "identity"
        };
    },
    filterResponseHeaders: filterBrowserResponseHeaders,
    transformResponseText({ text, mediaType, targetUrl }) {
        if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
            return rewriteHtml({ html: text, documentUrl: targetUrl, mediaType });
        }
        if (mediaType === "text/css") {
            return rewriteCss({ css: text, stylesheetUrl: targetUrl });
        }
        return text;
    },
    redirectOptions(config) {
        return {
            followRedirects: false,
            validateRedirects: true,
            maxRedirects: config.browser.maxRedirects
        };
    }
});

const legacyPolicy = Object.freeze({
    ...browserPolicy,
    mode: "legacy",
    exposeCors: true,
    filterResponseHeaders(upstreamHeaders) {
        const headers = filterUpstreamResponseHeaders(upstreamHeaders);
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        return headers;
    },
    redirectOptions(config) {
        return {
            followRedirects: config.api.followRedirects,
            maxRedirects: config.api.maxRedirects
        };
    }
});

module.exports = {
    browserPolicy,
    filterBrowserResponseHeaders,
    legacyPolicy
};
