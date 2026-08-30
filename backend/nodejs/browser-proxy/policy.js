const {
    buildUpstreamRequestHeaders,
    filterUpstreamResponseHeaders,
    getHeader,
    normalizeHeaderName,
    omitHeaders
} = require("../core/headers");
const {
    BROWSER_ROUTE_PREFIX,
    fromProxyRequest,
    toProxyUrl
} = require("../core/urlMapper");
const { rewriteCss } = require("./cssRewriter");
const { rewriteHtml } = require("./htmlRewriter");
const { getCookieHeader, storeResponseCookies } = require("./sessionStateStore");
const { createWebSocketOriginContext } = require("./webSocketUrl");
const {
    isolatedProxyOrigin,
    originIsolationConfig
} = require("../core/originIsolation");

const COMPAT_RESPONSE_HEADERS = Object.freeze([
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "cross-origin-resource-policy",
    "cross-origin-opener-policy",
    "cross-origin-embedder-policy",
    "clear-site-data"
]);

function replaceHeader(headers, name, value) {
    const normalizedName = normalizeHeaderName(name);
    for (const existingName of Object.keys(headers)) {
        if (normalizeHeaderName(existingName) === normalizedName) delete headers[existingName];
    }
    headers[normalizedName] = value;
}

function requestProxyOrigin(request) {
    const host = getHeader(request?.headers, "host");
    if (!host) return null;
    try {
        return new URL(`${request.protocol || "http"}://${host}`).origin;
    } catch {
        return null;
    }
}

function mapperOptions(config) {
    return { originIsolation: config?.browser?.originIsolation };
}

function mapBrowserReferer(value, proxyOrigin, config, originIsolationRegistry) {
    if (typeof value !== "string" || !proxyOrigin) return null;
    try {
        const referer = new URL(value);
        if (originIsolationConfig(config) && referer.pathname === "/" && !referer.search) {
            const sourceOrigin = originIsolationRegistry?.resolve(
                referer.origin,
                config.browser.originIsolation
            );
            return sourceOrigin ? `${sourceOrigin}/` : null;
        }
        if (!referer.pathname.startsWith(`${BROWSER_ROUTE_PREFIX}/`)) {
            return null;
        }
        const requestUrl = `${referer.pathname.slice(BROWSER_ROUTE_PREFIX.length)}${referer.search}`;
        const targetUrl = fromProxyRequest({ url: requestUrl });
        const canonical = new URL(toProxyUrl(targetUrl, mapperOptions(config)), proxyOrigin);
        return canonical.origin === referer.origin
            && `${canonical.pathname}${canonical.search}` === `${referer.pathname}${referer.search}`
            ? targetUrl
            : null;
    } catch {
        return null;
    }
}

function applyBrowserSourceHeaders(headers, inboundHeaders, context) {
    const proxyOrigin = requestProxyOrigin(context.request);
    const refererValue = getHeader(inboundHeaders, "referer");
    const sourceUrl = mapBrowserReferer(
        refererValue,
        proxyOrigin,
        context.config,
        context.originIsolationRegistry
    );
    let sourceProxyOrigin = null;
    try {
        sourceProxyOrigin = sourceUrl ? new URL(refererValue).origin : null;
    } catch {
        sourceProxyOrigin = null;
    }
    const inboundOrigin = getHeader(inboundHeaders, "origin");
    const registeredSourceOrigin = originIsolationConfig(context.config)
        ? context.originIsolationRegistry?.resolve(
            inboundOrigin,
            context.config.browser.originIsolation
        )
        : null;

    if (sourceUrl) replaceHeader(headers, "referer", sourceUrl);
    if (inboundOrigin === "null") {
        replaceHeader(headers, "origin", "null");
    } else if (registeredSourceOrigin) {
        replaceHeader(headers, "origin", registeredSourceOrigin);
    } else if (inboundOrigin === sourceProxyOrigin) {
        replaceHeader(headers, "origin", sourceUrl ? new URL(sourceUrl).origin : "null");
    } else if (originIsolationConfig(context.config)
        && inboundOrigin === isolatedProxyOrigin(new URL(context.targetUrl).origin, context.config.browser.originIsolation)) {
        replaceHeader(headers, "origin", new URL(context.targetUrl).origin);
    } else if (inboundOrigin === proxyOrigin && !originIsolationConfig(context.config)) {
        replaceHeader(headers, "origin", sourceUrl ? new URL(sourceUrl).origin : "null");
    }
    return headers;
}

function filterBrowserResponseHeaders(upstreamHeaders, config, context = {}) {
    let headers = filterUpstreamResponseHeaders(upstreamHeaders, {
        preserveContentLength: context.preserveContentLength
    });
    headers = omitHeaders(headers, ["set-cookie"]);
    if (config.browser.headerPolicy === "compat") {
        headers = omitHeaders(headers, COMPAT_RESPONSE_HEADERS);
    }
    if (context.redirectTargetUrl && getHeader(headers, "location")) {
        replaceHeader(headers, "location", toProxyUrl(context.redirectTargetUrl, mapperOptions(config)));
    }
    if (originIsolationConfig(config)) {
        const inboundOrigin = getHeader(context.request?.headers, "origin");
        const upstreamAllowedOrigin = getHeader(headers, "access-control-allow-origin");
        if (inboundOrigin && upstreamAllowedOrigin && upstreamAllowedOrigin !== "*") {
            const mappedSourceOrigin = context.originIsolationRegistry?.resolve(
                inboundOrigin,
                config.browser.originIsolation
            );
            if (mappedSourceOrigin && upstreamAllowedOrigin === mappedSourceOrigin) {
                replaceHeader(headers, "access-control-allow-origin", inboundOrigin);
            }
        }
    }
    return headers;
}

const browserPolicy = Object.freeze({
    mode: "browser",
    exposeCors: false,
    async buildRequestHeaders(inboundHeaders, customHeaders, config, context) {
        const headers = buildUpstreamRequestHeaders(inboundHeaders, customHeaders);
        const browserHeaders = applyBrowserSourceHeaders({
            ...omitHeaders(headers, ["accept-encoding"]),
            "accept-encoding": "identity"
        }, inboundHeaders, { ...context, config });
        if (config.browser.cookieJar && context.sessionState) {
            const cookie = await getCookieHeader(context.sessionState, context.targetUrl);
            if (cookie) replaceHeader(browserHeaders, "cookie", cookie);
        }
        return browserHeaders;
    },
    async captureResponseHeaders(upstreamHeaders, config, context) {
        if (!config.browser.cookieJar || !context.sessionState) return;
        await storeResponseCookies(
            context.sessionState,
            context.targetUrl,
            getHeader(upstreamHeaders, "set-cookie"),
            context
        );
    },
    filterResponseHeaders: filterBrowserResponseHeaders,
    transformResponseText({ text, mediaType, targetUrl, config }) {
        if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
            return rewriteHtml({
                html: text,
                documentUrl: targetUrl,
                mediaType,
                runtimeBridge: config.browser.runtimeBridge,
                webSocket: config.browser.webSocket,
                webSocketContext: config.browser.webSocket
                    ? createWebSocketOriginContext(new URL(targetUrl).origin, config.session.secret)
                    : null,
                mapperOptions: mapperOptions(config)
            });
        }
        if (mediaType === "text/css") {
            return rewriteCss({ css: text, stylesheetUrl: targetUrl, mapperOptions: mapperOptions(config) });
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
    filterResponseHeaders(upstreamHeaders, config, context = {}) {
        const headers = filterUpstreamResponseHeaders(upstreamHeaders, {
            preserveContentLength: context.preserveContentLength
        });
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
    COMPAT_RESPONSE_HEADERS,
    applyBrowserSourceHeaders,
    browserPolicy,
    filterBrowserResponseHeaders,
    legacyPolicy,
    mapBrowserReferer,
    requestProxyOrigin
};
