const { normalizeHeaderName } = require("./headers");

function setHeader(headers, name, value) {
    const normalizedName = normalizeHeaderName(name);
    for (const existingName of Object.keys(headers)) {
        if (normalizeHeaderName(existingName) === normalizedName) delete headers[existingName];
    }
    headers[normalizedName] = value;
}

function isEventStream(classification) {
    return classification?.kind === "stream"
        && classification.mediaType === "text/event-stream";
}

function applyStreamingHeaders(headers, classification) {
    const result = { ...(headers || {}) };
    if (isEventStream(classification)) setHeader(result, "x-accel-buffering", "no");
    return result;
}

function flushStreamingHeaders(response, classification) {
    if (!isEventStream(classification) || typeof response?.flushHeaders !== "function") return false;
    response.flushHeaders();
    return true;
}

module.exports = {
    applyStreamingHeaders,
    flushStreamingHeaders,
    isEventStream
};
