const assert = require("node:assert/strict");
const { test } = require("node:test");
const { toProxyUrl } = require("../../core/urlMapper");
const {
    createWebSocketOriginContext,
    fromWebSocketProxyRequest,
    toHttpUrl,
    toWebSocketUrl,
    verifyWebSocketOriginContext
} = require("../../browser-proxy/webSocketUrl");

test("WebSocket URLs share the canonical HTTP origin token without weakening protocol checks", () => {
    const canonicalPath = toProxyUrl("https://Example.test:443/socket?q=1");
    assert.equal(
        fromWebSocketProxyRequest({ url: canonicalPath }),
        "wss://example.test/socket?q=1"
    );
    assert.equal(toHttpUrl("ws://example.test/chat").href, "http://example.test/chat");
    assert.equal(toWebSocketUrl("https://example.test/chat").href, "wss://example.test/chat");
    assert.throws(() => toHttpUrl("ftp://example.test/chat"), /WebSocket URL/);
    assert.throws(() => toWebSocketUrl("https://user:secret@example.test/chat"), /WebSocket URL/);
});

test("WebSocket source origin context is signed and fails closed after tampering", () => {
    const context = createWebSocketOriginContext("https://source.example", "test-secret");
    assert.match(context, /^fireflyproxy-origin\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(
        verifyWebSocketOriginContext(context, "test-secret"),
        "https://source.example"
    );
    assert.equal(verifyWebSocketOriginContext(`${context}x`, "test-secret"), null);
    assert.equal(verifyWebSocketOriginContext(context, "other-secret"), null);
});
