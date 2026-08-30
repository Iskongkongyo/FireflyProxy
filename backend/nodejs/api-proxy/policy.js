const { buildUpstreamRequestHeaders, filterUpstreamResponseHeaders } = require("../core/headers");

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
    redirectOptions(config) {
        return {
            followRedirects: config.api.followRedirects,
            maxRedirects: config.api.maxRedirects
        };
    }
});

module.exports = {
    apiPolicy
};
