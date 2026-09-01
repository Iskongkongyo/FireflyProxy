const { ERROR_CODES, ProxyError } = require("../core/errors");

const BOOLEAN_PREFERENCE_KEYS = Object.freeze([
    "rewriteHtml",
    "rewriteCss",
    "cookieJar",
    "runtimeBridge",
    "scriptCookieBridge",
    "webSocket",
    "compatHeaders"
]);

function invalidPreference(field) {
    return new ProxyError(ERROR_CODES.BROWSER_URL_INVALID, "Browser proxy preference is invalid", {
        statusCode: 400,
        details: { reason: "invalid-browser-preference", field }
    });
}

function parseBooleanPreference(value, field) {
    if (value === undefined) return undefined;
    if (value === "true" || value === true) return true;
    if (value === "false" || value === false) return false;
    throw invalidPreference(field);
}

function parseBrowserPreferences(query = {}) {
    const preferences = {};
    for (const field of BOOLEAN_PREFERENCE_KEYS) {
        const value = parseBooleanPreference(query[field], field);
        if (value !== undefined) preferences[field] = value;
    }
    return Object.freeze(preferences);
}

function normalizeStoredPreferences(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
    const preferences = {};
    for (const field of BOOLEAN_PREFERENCE_KEYS) {
        if (typeof value[field] === "boolean") preferences[field] = value[field];
    }
    return Object.freeze(preferences);
}

function applyBrowserPreferences(config, storedPreferences) {
    const preferences = normalizeStoredPreferences(storedPreferences);
    const configuredHeaderPolicy = config.browser.headerPolicy;
    const headerPolicy = configuredHeaderPolicy === "compat" && preferences.compatHeaders !== false
        ? "compat"
        : configuredHeaderPolicy === "strict" ? "strict" : "preserve";
    const rewriteHtml = config.browser.rewriteHtml && preferences.rewriteHtml !== false;
    const runtimeBridge = config.browser.runtimeBridge
        && rewriteHtml
        && preferences.runtimeBridge !== false;
    const browser = Object.freeze({
        ...config.browser,
        rewriteHtml,
        rewriteCss: config.browser.rewriteCss && preferences.rewriteCss !== false,
        cookieJar: config.browser.cookieJar && preferences.cookieJar !== false,
        runtimeBridge,
        scriptCookieBridge: config.browser.scriptCookieBridge
            && runtimeBridge
            && preferences.scriptCookieBridge !== false,
        webSocket: config.browser.webSocket && preferences.webSocket !== false,
        headerPolicy
    });
    return Object.freeze({ ...config, browser });
}

module.exports = {
    BOOLEAN_PREFERENCE_KEYS,
    applyBrowserPreferences,
    normalizeStoredPreferences,
    parseBooleanPreference,
    parseBrowserPreferences
};
