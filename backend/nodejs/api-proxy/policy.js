const { buildUpstreamRequestHeaders, filterUpstreamResponseHeaders } = require("../core/headers");
const { resolveApiRedirectOptions } = require("./requestControls");
const { buildApiResponseDiagnosticHeaders } = require("./responseDiagnostics");

const apiPolicy = Object.freeze({
    mode: "api",
    exposeCors: true,
    buildRequestHeaders(inboundHeaders, customHeaders) {
        return buildUpstreamRequestHeaders(inboundHeaders, customHeaders);
    },
    filterResponseHeaders(upstreamHeaders, config, context = {}) {
        return filterUpstreamResponseHeaders(upstreamHeaders, {
            preserveContentLength: context.preserveContentLength
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
    apiPolicy
};
