const assert = require("node:assert/strict");
const { test } = require("node:test");

async function loadSecurityHelpers() {
    return import("../src/utils/headerSecurity.mjs");
}

test("sensitive authentication and token header names are classified case-insensitively", async () => {
    const { isSensitiveHeaderName } = await loadSecurityHelpers();

    assert.equal(isSensitiveHeaderName("Authorization"), true);
    assert.equal(isSensitiveHeaderName("X-Api-Key"), true);
    assert.equal(isSensitiveHeaderName("x-upstream-token"), true);
    assert.equal(isSensitiveHeaderName("X-Request-ID"), false);
    assert.equal(isSensitiveHeaderName("Content-Type"), false);
});

test("share sanitizers omit secrets without mutating source data", async () => {
    const { omitSensitiveHeaders, omitSensitiveHeaderRows } = await loadSecurityHelpers();
    const headers = {
        Authorization: "Bearer secret",
        "X-Api-Key": "secret-key",
        Accept: "application/json"
    };
    const rows = Object.entries(headers).map(([key, value]) => ({ key, value }));

    assert.deepEqual(omitSensitiveHeaders(headers), { Accept: "application/json" });
    assert.deepEqual(omitSensitiveHeaderRows(rows), [
        { key: "Accept", value: "application/json" }
    ]);
    assert.equal(headers.Authorization, "Bearer secret");
    assert.equal(rows.length, 3);
});

test("proxy transport keeps credentials out of the URL and ordinary Authorization", async () => {
    const { buildProxyTransport, UPSTREAM_AUTHORIZATION_HEADER } = await loadSecurityHelpers();
    const secret = "transport-secret";
    const transport = buildProxyTransport(
        "http://proxy.test",
        "https://upstream.test/private",
        { Accept: "application/json", Authorization: `Bearer ${secret}` }
    );

    assert.doesNotMatch(transport.url, new RegExp(secret));
    assert.doesNotMatch(transport.url, /headers=/);
    assert.equal(transport.headers.Authorization, undefined);
    assert.equal(transport.headers[UPSTREAM_AUTHORIZATION_HEADER], `Bearer ${secret}`);
    assert.equal(transport.headers.Accept, "application/json");
});
