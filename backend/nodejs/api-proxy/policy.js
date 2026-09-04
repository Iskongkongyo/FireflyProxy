const { buildUpstreamRequestHeaders, filterUpstreamResponseHeaders } = require("../core/headers");
const { resolveApiRedirectOptions } = require("./requestControls");
const { buildApiResponseDiagnosticHeaders } = require("./responseDiagnostics");
const { version } = require("../package.json");

// Browser-added client context does not describe the server-side connection to
// the upstream. Forwarding only part of it creates a contradictory fingerprint
// (for example, a Chrome User-Agent over a Node.js TLS connection).
const AMBIENT_BROWSER_HEADERS = Object.freeze([
    "accept",
    "accept-encoding",
    "accept-language",
    "dnt",
    "priority",
    "upgrade-insecure-requests",
    "user-agent"
]);
const DEFAULT_USER_AGENT = `FireflyProxy/${version}`;

const apiPolicy = Object.freeze({
    mode: "api",
    exposeCors: true,
    buildRequestHeaders(inboundHeaders, customHeaders) {
        return buildUpstreamRequestHeaders(inboundHeaders, customHeaders, {
            allowUpstreamReferer: true,
            allowUpstreamHeaders: true,
            omitInboundHeaders: AMBIENT_BROWSER_HEADERS,
            defaultUserAgent: DEFAULT_USER_AGENT
        });
    },
    filterResponseHeaders(upstreamHeaders, config, context = {}) {
        return filterUpstreamResponseHeaders(upstreamHeaders, {
            preserveContentLength: context.preserveContentLength,
            stripCors: true
        });
    },
    redirectOptions(config, context = {}) {
        return resolveApiRedirectOptions(config, context.request?.query);
    },
    responseDiagnostics(context) {
        return buildApiResponseDiagnosticHeaders(context);
    }
});

module.exports = {
    AMBIENT_BROWSER_HEADERS,
    DEFAULT_USER_AGENT,
    apiPolicy
};
