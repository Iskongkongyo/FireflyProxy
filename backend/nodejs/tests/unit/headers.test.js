const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    buildUpstreamRequestHeaders,
    filterUpstreamResponseHeaders,
    isHopByHopHeader,
    isProxyAuthenticationHeader,
    UPSTREAM_AUTHORIZATION_HEADER
} = require("../../core/headers");

test("header classifications keep Cookie separate from hop-by-hop fields", () => {
    assert.equal(isHopByHopHeader("Connection"), true);
    assert.equal(isHopByHopHeader("Transfer-Encoding"), true);
    assert.equal(isHopByHopHeader("Cookie"), false);
    assert.equal(isProxyAuthenticationHeader("Proxy-Authorization"), true);
    assert.equal(isProxyAuthenticationHeader("Authorization"), false);
});

test("request header builder removes transport fields after merging custom headers", () => {
    const headers = buildUpstreamRequestHeaders({
        Host: "proxy.test",
        Connection: "x-connection-secret",
        "X-Connection-Secret": "remove-me",
        Cookie: "legacy=session",
        Authorization: "Basic proxy-credentials",
        [UPSTREAM_AUTHORIZATION_HEADER]: "Bearer upstream-token",
        "X-Keep": "inbound"
    }, {
        Connection: "keep-alive",
        "Proxy-Authorization": "Basic remove-me",
        "X-Keep": "custom"
    });

    assert.equal(headers.Host, undefined);
    assert.equal(headers.Connection, undefined);
    assert.equal(headers["X-Connection-Secret"], undefined);
    assert.equal(headers.Cookie, undefined);
    assert.equal(headers["Proxy-Authorization"], undefined);
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers[UPSTREAM_AUTHORIZATION_HEADER], undefined);
    assert.equal(headers.authorization, "Bearer upstream-token");
    assert.equal(headers["X-Keep"], "custom");
});

test("legacy query Authorization remains available when the safe header is absent", () => {
    const headers = buildUpstreamRequestHeaders(
        { authorization: "Basic proxy-credentials" },
        { Authorization: "Bearer legacy-upstream-token" }
    );

    assert.deepEqual(headers, { authorization: "Bearer legacy-upstream-token" });
});

test("response header filter removes transport metadata and preserves end-to-end headers", () => {
    const headers = filterUpstreamResponseHeaders({
        connection: "x-remove",
        "x-remove": "transport-only",
        "content-length": "42",
        "set-cookie": ["upstream=value"],
        "x-fixture": "keep"
    });

    assert.equal(headers.connection, undefined);
    assert.equal(headers["x-remove"], undefined);
    assert.equal(headers["content-length"], undefined);
    assert.deepEqual(headers["set-cookie"], ["upstream=value"]);
    assert.equal(headers["x-fixture"], "keep");
});
