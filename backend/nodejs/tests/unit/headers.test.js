const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    buildUpstreamRequestHeaders,
    filterUpstreamResponseHeaders,
    isHopByHopHeader,
    isProxyAuthenticationHeader,
    SENSITIVE_UPSTREAM_HEADERS,
    UPSTREAM_AUTHORIZATION_HEADER,
    UPSTREAM_HEADERS_HEADER,
    UPSTREAM_REFERER_HEADER
} = require("../../core/headers");

function encodeUpstreamHeaders(entries) {
    return Buffer.from(JSON.stringify(entries), "utf8").toString("base64url");
}

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

test("API Referer control forwards only a validated absolute HTTP(S) value", () => {
    const controlled = buildUpstreamRequestHeaders({
        referer: "http://frontend.test/editor",
        [UPSTREAM_REFERER_HEADER]: "https://upstream.test/source?from=api"
    }, {}, { allowUpstreamReferer: true });

    assert.equal(controlled.referer, "https://upstream.test/source?from=api");
    assert.equal(controlled[UPSTREAM_REFERER_HEADER], undefined);

    const ordinary = buildUpstreamRequestHeaders({
        referer: "https://attacker.test/spoof",
        [UPSTREAM_REFERER_HEADER]: "https://upstream.test/source"
    });
    assert.equal(ordinary.referer, undefined);

    for (const value of ["not-a-url", "file:///private", "https://user:secret@upstream.test/"]) {
        const invalid = buildUpstreamRequestHeaders({
            [UPSTREAM_REFERER_HEADER]: value
        }, {}, { allowUpstreamReferer: true });
        assert.equal(invalid.referer, undefined);
    }
});

test("structured API headers forward browser-restricted fields and reject transport identity fields", () => {
    const envelope = encodeUpstreamHeaders([
        ["Referer", "https://upstream.test/source?q=1"],
        ["Origin", "https://client.example:443"],
        ["Cookie", "session=upstream"],
        ["User-Agent", "FireflyProxy-Test/1.0"],
        ["X-Trace-ID", "trace-1"],
        ["Host", "attacker.test"],
        ["Content-Length", "999"],
        ["Forwarded", "for=attacker"],
        ["X-Forwarded-For", "127.0.0.1"],
        ["Sec-Fetch-Site", "none"]
    ]);
    const headers = buildUpstreamRequestHeaders({
        origin: "http://frontend.test",
        cookie: "proxySession=private",
        "sec-fetch-mode": "cors",
        [UPSTREAM_HEADERS_HEADER]: envelope
    }, {}, { allowUpstreamHeaders: true });

    assert.equal(headers.referer, "https://upstream.test/source?q=1");
    assert.equal(headers.origin, "https://client.example");
    assert.equal(headers.cookie, "session=upstream");
    assert.equal(headers["user-agent"], "FireflyProxy-Test/1.0");
    assert.equal(headers["x-trace-id"], "trace-1");
    assert.equal(headers.host, undefined);
    assert.equal(headers["content-length"], undefined);
    assert.equal(headers.forwarded, undefined);
    assert.equal(headers["x-forwarded-for"], undefined);
    assert.equal(headers["sec-fetch-site"], undefined);
    assert.equal(headers[UPSTREAM_HEADERS_HEADER], undefined);
});

test("malformed or unsafe structured API header values are ignored", () => {
    for (const envelope of [
        "not+base64url",
        encodeUpstreamHeaders({ Referer: "https://upstream.test" }),
        encodeUpstreamHeaders([["Origin", "https://example.test/path"]]),
        encodeUpstreamHeaders([["X-Test", "line-one\r\nInjected: yes"]]),
        encodeUpstreamHeaders([["X-Test", "中文不能直接放入 HTTP/1 请求头"]])
    ]) {
        const headers = buildUpstreamRequestHeaders({
            [UPSTREAM_HEADERS_HEADER]: envelope
        }, {}, { allowUpstreamHeaders: true });
        assert.deepEqual(headers, {});
    }
});

test("structured API headers retain explicit sensitive names for redirect policy", () => {
    const headers = buildUpstreamRequestHeaders({
        [UPSTREAM_HEADERS_HEADER]: encodeUpstreamHeaders([
            ["X-Custom-Credential", "secret", true],
            ["X-Safe", "keep"]
        ])
    }, {}, { allowUpstreamHeaders: true });

    assert.deepEqual(headers[SENSITIVE_UPSTREAM_HEADERS], new Set(["x-custom-credential"]));
    assert.equal(headers["x-custom-credential"], "secret");
    assert.equal(headers["x-safe"], "keep");
});

test("response header filter removes transport metadata and preserves end-to-end headers", () => {
    const headers = filterUpstreamResponseHeaders({
        connection: "x-remove",
        "x-remove": "transport-only",
        "content-length": "42",
        "set-cookie": ["upstream=value"],
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET",
        "x-fixture": "keep"
    }, { stripCors: true });

    assert.equal(headers.connection, undefined);
    assert.equal(headers["x-remove"], undefined);
    assert.equal(headers["content-length"], undefined);
    assert.equal(headers["access-control-allow-origin"], undefined);
    assert.equal(headers["access-control-allow-credentials"], undefined);
    assert.equal(headers["access-control-allow-methods"], undefined);
    assert.deepEqual(headers["set-cookie"], ["upstream=value"]);
    assert.equal(headers["x-fixture"], "keep");
});
