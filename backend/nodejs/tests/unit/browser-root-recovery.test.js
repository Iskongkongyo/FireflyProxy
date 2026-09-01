const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createDefaultConfig } = require("../../config/defaults");
const { toProxyUrl } = require("../../core/urlMapper");
const {
    isReservedProxyPath,
    resolveBrowserRootRecovery
} = require("../../browser-proxy/rootRecovery");

function request(path, referer) {
    return {
        protocol: "https",
        originalUrl: path,
        url: path,
        query: Object.fromEntries(new URL(path, "https://proxy.test").searchParams),
        headers: {
            host: "proxy.test",
            ...(referer ? { referer } : {})
        }
    };
}

function browserConfig() {
    const defaults = createDefaultConfig({});
    return {
        ...defaults,
        browser: { ...defaults.browser, enabled: true }
    };
}

test("Browser root recovery resolves a single-slash path from a strict Canonical Referer", () => {
    const sourceUrl = "https://upstream.test/docs/page?step=1";
    const referer = `https://proxy.test${toProxyUrl(sourceUrl)}`;
    const recovery = resolveBrowserRootRecovery(
        request("/account/save?mode=compact", referer),
        browserConfig()
    );

    assert.deepEqual(recovery, {
        sourceUrl,
        targetUrl: "https://upstream.test/account/save?mode=compact"
    });
});

test("Browser root recovery fails closed without a matching Canonical Referer", () => {
    const config = browserConfig();
    assert.equal(resolveBrowserRootRecovery(request("/account/save"), config), null);
    assert.equal(resolveBrowserRootRecovery(
        request("/account/save", "https://attacker.test/__proxyweb/browser/token/page"),
        config
    ), null);
    assert.equal(resolveBrowserRootRecovery(
        request("//attacker.test/path", `https://proxy.test${toProxyUrl("https://upstream.test/page")}`),
        config
    ), null);
});

test("Browser root recovery never captures explicit proxy or frontend routes", () => {
    const config = browserConfig();
    const referer = `https://proxy.test${toProxyUrl("https://upstream.test/page")}`;

    assert.equal(resolveBrowserRootRecovery(request("/?url=https%3A%2F%2Fexample.test", referer), config), null);
    assert.equal(resolveBrowserRootRecovery(request("/__proxyweb/api?url=x", referer), config), null);
    assert.equal(resolveBrowserRootRecovery(request("/web/", referer), config), null);
    assert.equal(isReservedProxyPath("/webhook"), false);
});
