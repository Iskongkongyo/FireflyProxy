const MAX_DIAGNOSTIC_HEADER_CHARS = 4096;

const API_DIAGNOSTIC_HEADERS = Object.freeze({
    finalUrl: "x-proxyweb-final-url",
    redirectChain: "x-proxyweb-redirect-chain",
    redirectCount: "x-proxyweb-redirect-count",
    followRedirects: "x-proxyweb-follow-redirects",
    maxRedirects: "x-proxyweb-max-redirects",
    truncated: "x-proxyweb-diagnostics-truncated"
});

function encodeJson(value) {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function truncateText(value, maxLength = 2048) {
    const text = String(value || "");
    return text.length <= maxLength ? { value: text, truncated: false } : {
        value: `${text.slice(0, maxLength)}…`,
        truncated: true
    };
}

function encodeRedirectChain(chain) {
    const included = [];
    let truncated = false;
    for (const entry of Array.isArray(chain) ? chain : []) {
        const candidate = [...included, entry];
        if (encodeJson(candidate).length > MAX_DIAGNOSTIC_HEADER_CHARS) {
            truncated = true;
            break;
        }
        included.push(entry);
    }
    return { value: encodeJson(included), truncated };
}

function buildApiResponseDiagnosticHeaders(context = {}) {
    const finalUrl = truncateText(context.finalUrl);
    const chain = encodeRedirectChain(context.redirectChain);
    const headers = {
        [API_DIAGNOSTIC_HEADERS.finalUrl]: encodeJson(finalUrl.value),
        [API_DIAGNOSTIC_HEADERS.redirectChain]: chain.value,
        [API_DIAGNOSTIC_HEADERS.redirectCount]: String(context.redirectChain?.length || 0),
        [API_DIAGNOSTIC_HEADERS.followRedirects]: String(context.followRedirects === true),
        [API_DIAGNOSTIC_HEADERS.maxRedirects]: String(context.maxRedirects ?? 0)
    };
    if (finalUrl.truncated || chain.truncated) {
        headers[API_DIAGNOSTIC_HEADERS.truncated] = "true";
    }
    return headers;
}

module.exports = {
    API_DIAGNOSTIC_HEADERS,
    MAX_DIAGNOSTIC_HEADER_CHARS,
    buildApiResponseDiagnosticHeaders,
    encodeJson
};
