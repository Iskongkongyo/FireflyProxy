const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    RUNTIME_BRIDGE_PATH,
    RUNTIME_BRIDGE_SOURCE,
    createRuntimeBridgeHandler
} = require("../../browser-proxy/runtimeBridge");
const { createDefaultConfig } = require("../../config/defaults");

function responseRecorder() {
    const headers = {};
    return {
        headers,
        body: null,
        set(values) {
            Object.assign(headers, values);
            return this;
        },
        send(value) {
            this.body = value;
            return this;
        }
    };
}

test("Runtime Bridge source is standalone JavaScript without diagnostic or storage side effects", () => {
    assert.equal(RUNTIME_BRIDGE_PATH, "/__proxyweb/runtime.js");
    assert.doesNotThrow(() => new Function(RUNTIME_BRIDGE_SOURCE));
    assert.doesNotMatch(RUNTIME_BRIDGE_SOURCE, /console\.|localStorage|sessionStorage/);
    assert.match(RUNTIME_BRIDGE_SOURCE, /ProxyWebRequest/);
    assert.match(RUNTIME_BRIDGE_SOURCE, /XMLHttpRequest/);
    assert.match(RUNTIME_BRIDGE_SOURCE, /EventSource/);
    assert.match(RUNTIME_BRIDGE_SOURCE, /ProxyWebWebSocket/);
    assert.match(RUNTIME_BRIDGE_SOURCE, /pushState/);
});

test("Runtime Bridge handler fails closed and serves a no-store nosniff script only when effective", () => {
    const defaults = createDefaultConfig({ PROXYWEB_SESSION_SECRET: "test-secret" });
    let config = {
        ...defaults,
        browser: { ...defaults.browser, enabled: true, runtimeBridge: true }
    };
    const handler = createRuntimeBridgeHandler({ getConfig: () => config });
    const enabledResponse = responseRecorder();
    handler({ session: {} }, enabledResponse, error => { throw error; });

    assert.equal(enabledResponse.headers["cache-control"], "no-store");
    assert.equal(enabledResponse.headers["x-content-type-options"], "nosniff");
    assert.equal(enabledResponse.body, RUNTIME_BRIDGE_SOURCE);

    let failure;
    handler({ session: { proxyWebBrowserPreferences: { runtimeBridge: false } } }, responseRecorder(), error => {
        failure = error;
    });
    assert.equal(failure.code, "PROXY_ROUTE_NOT_FOUND");
    assert.equal(failure.statusCode, 404);

    config = { ...config, browser: { ...config.browser, runtimeBridge: false } };
    failure = null;
    handler({ session: { proxyWebBrowserPreferences: { runtimeBridge: true } } }, responseRecorder(), error => {
        failure = error;
    });
    assert.equal(failure.code, "PROXY_ROUTE_NOT_FOUND");
});
