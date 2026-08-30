const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createDefaultConfig } = require("../../config/defaults");
const {
    applyBrowserPreferences,
    normalizeStoredPreferences,
    parseBrowserPreferences
} = require("../../browser-proxy/preferences");

test("Browser preferences parse only explicit boolean query values", () => {
    assert.deepEqual(parseBrowserPreferences({
        rewriteHtml: "false",
        rewriteCss: "true",
        cookieJar: false,
        runtimeBridge: "false",
        webSocket: "false",
        compatHeaders: true,
        url: "https://example.test/"
    }), {
        rewriteHtml: false,
        rewriteCss: true,
        cookieJar: false,
        runtimeBridge: false,
        webSocket: false,
        compatHeaders: true
    });
    assert.throws(
        () => parseBrowserPreferences({ rewriteHtml: ["true", "false"] }),
        error => error.code === "PROXY_BROWSER_URL_INVALID"
            && error.details.field === "rewriteHtml"
    );
});

test("Browser preferences can only tighten configured capabilities", () => {
    const defaults = createDefaultConfig({ PROXYWEB_SESSION_SECRET: "test-secret" });
    const tightened = applyBrowserPreferences(defaults, {
        rewriteHtml: false,
        rewriteCss: false,
        cookieJar: false,
        runtimeBridge: false,
        webSocket: false,
        compatHeaders: false
    });
    assert.equal(tightened.browser.rewriteHtml, false);
    assert.equal(tightened.browser.rewriteCss, false);
    assert.equal(tightened.browser.cookieJar, false);
    assert.equal(tightened.browser.runtimeBridge, false);
    assert.equal(tightened.browser.webSocket, false);
    assert.equal(tightened.browser.headerPolicy, "preserve");

    const globallyRestricted = {
        ...defaults,
        browser: {
            ...defaults.browser,
            rewriteHtml: false,
            rewriteCss: false,
            cookieJar: false,
            runtimeBridge: false,
            webSocket: false,
            headerPolicy: "strict"
        }
    };
    const attemptedEnable = applyBrowserPreferences(globallyRestricted, {
        rewriteHtml: true,
        rewriteCss: true,
        cookieJar: true,
        runtimeBridge: true,
        webSocket: true,
        compatHeaders: true
    });
    assert.equal(attemptedEnable.browser.rewriteHtml, false);
    assert.equal(attemptedEnable.browser.rewriteCss, false);
    assert.equal(attemptedEnable.browser.cookieJar, false);
    assert.equal(attemptedEnable.browser.runtimeBridge, false);
    assert.equal(attemptedEnable.browser.webSocket, false);
    assert.equal(attemptedEnable.browser.headerPolicy, "strict");
});

test("stored Browser preferences ignore malformed or unknown fields", () => {
    assert.deepEqual(normalizeStoredPreferences({
        rewriteHtml: false,
        rewriteCss: "false",
        cookieJar: true,
        runtimeBridge: true,
        webSocket: true,
        __proto__: { polluted: true }
    }), {
        rewriteHtml: false,
        cookieJar: true,
        runtimeBridge: true,
        webSocket: true
    });
});
