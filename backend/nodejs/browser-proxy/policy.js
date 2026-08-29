const { buildUpstreamRequestHeaders, filterUpstreamResponseHeaders } = require("../core/headers");

function filterBrowserResponseHeaders(upstreamHeaders, config) {
    const headers = filterUpstreamResponseHeaders(upstreamHeaders);
    if (config.browser.headerPolicy === "compat") {
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
    }
    return headers;
}

const browserPolicy = Object.freeze({
    mode: "browser",
    exposeCors: false,
    buildRequestHeaders(inboundHeaders, customHeaders) {
        return buildUpstreamRequestHeaders(inboundHeaders, customHeaders);
    },
    filterResponseHeaders: filterBrowserResponseHeaders,
    redirectOptions(config) {
        return {
            followRedirects: true,
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
