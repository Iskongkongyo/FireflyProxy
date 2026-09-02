const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWebSocketOriginContext } = require("../../browser-proxy/webSocketUrl");
const {
    buildUpstreamHeaders,
    parseProtocols,
    parseSourceOrigin,
    validateInboundOrigin,
    validateUpgradeHeaders
} = require("../../browser-proxy/webSocketProxy");

test("WebSocket protocol parsing removes only a verified FireflyProxy source marker", () => {
    const marker = createWebSocketOriginContext("https://source.test", "secret");
    const parsed = parseSourceOrigin(parseProtocols(`chat, ${marker}`), "secret");
    assert.equal(parsed.origin, "https://source.test");
    assert.deepEqual(parsed.protocols, ["chat"]);
    assert.throws(() => parseProtocols("chat, chat"), /subprotocol/);
    assert.throws(() => parseProtocols("chat protocol"), /subprotocol/);
    assert.throws(() => parseSourceOrigin([`${marker}x`], "secret"), /source context/);
    assert.deepEqual(parseSourceOrigin(["chat"], "secret"), {
        origin: "null",
        protocols: ["chat"]
    });
});

test("WebSocket Upgrade headers are validated before upstream work", () => {
    const request = {
        method: "GET",
        headers: {
            connection: "keep-alive, Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
            "sec-websocket-version": "13"
        }
    };
    assert.doesNotThrow(() => validateUpgradeHeaders(request));
    assert.throws(
        () => validateUpgradeHeaders({ ...request, headers: { ...request.headers, "sec-websocket-version": "12" } }),
        /Upgrade headers/
    );
    assert.throws(
        () => validateUpgradeHeaders({ ...request, headers: { ...request.headers, "sec-websocket-key": "short" } }),
        /Upgrade headers/
    );
});

test("WebSocket Origin must name the current proxy host", () => {
    const request = { headers: { host: "proxy.test:8443", origin: "https://proxy.test:8443" } };
    assert.equal(validateInboundOrigin(request), "https://proxy.test:8443");
    assert.throws(
        () => validateInboundOrigin({ headers: { host: "proxy.test", origin: "https://attacker.test" } }),
        error => error.code === "PROXY_WEBSOCKET_ORIGIN_DENIED"
    );
    assert.throws(
        () => validateInboundOrigin({ headers: { host: "proxy.test" } }),
        error => error.statusCode === 403
    );
});

test("WebSocket upstream headers are allowlisted and source-controlled", () => {
    assert.deepEqual(buildUpstreamHeaders({ headers: {
        "user-agent": "fixture",
        authorization: "secret",
        cookie: "proxySession=secret",
        origin: "https://proxy.test"
    } }, "https://source.test", "upstream=jar"), {
        origin: "https://source.test",
        "user-agent": "fixture",
        cookie: "upstream=jar"
    });
});
