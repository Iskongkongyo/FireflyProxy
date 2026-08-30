const { ERROR_CODES, ProxyError } = require("../core/errors");

const MAX_REDIRECTS_LIMIT = 20;

function invalidControl(name) {
    return new ProxyError(
        ERROR_CODES.REQUEST_CONTROL_INVALID,
        "API request control is invalid",
        { statusCode: 400, details: { name } }
    );
}

function singleQueryValue(value, name) {
    if (value === undefined) return undefined;
    if (Array.isArray(value) || typeof value !== "string") throw invalidControl(name);
    return value;
}

function parseBooleanControl(value, name) {
    const normalized = singleQueryValue(value, name);
    if (normalized === undefined) return undefined;
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw invalidControl(name);
}

function parseMaxRedirects(value) {
    const normalized = singleQueryValue(value, "maxRedirects");
    if (normalized === undefined) return undefined;
    if (!/^(?:0|[1-9]\d?)$/.test(normalized)) throw invalidControl("maxRedirects");
    const parsed = Number(normalized);
    if (parsed > MAX_REDIRECTS_LIMIT) throw invalidControl("maxRedirects");
    return parsed;
}

function resolveApiRedirectOptions(config, query = {}) {
    const requestedFollow = parseBooleanControl(query.followRedirects, "followRedirects");
    const requestedMax = parseMaxRedirects(query.maxRedirects);
    const configuredFollow = config.api.followRedirects;
    const configuredMax = config.api.maxRedirects;

    return Object.freeze({
        followRedirects: configuredFollow && requestedFollow !== false,
        maxRedirects: Math.min(configuredMax, requestedMax ?? configuredMax)
    });
}

module.exports = {
    MAX_REDIRECTS_LIMIT,
    parseBooleanControl,
    parseMaxRedirects,
    resolveApiRedirectOptions
};
