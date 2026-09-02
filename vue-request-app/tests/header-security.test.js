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

test("proxy transport keeps credentials separate and carries upstream headers in one envelope", async () => {
	const {
		buildProxyTransport,
		decodeUpstreamHeadersEnvelope,
		UPSTREAM_AUTHORIZATION_HEADER,
		UPSTREAM_HEADERS_HEADER,
		UPSTREAM_REFERER_HEADER
	} = await loadSecurityHelpers();
	const secret = "transport-secret";
	const transport = buildProxyTransport(
		"http://proxy.test",
		"https://upstream.test/private",
		{
			Accept: "application/json",
			Authorization: `Bearer ${secret}`,
			Referer: "https://upstream.test/source",
			Origin: "https://client.example",
			Cookie: "session=upstream",
			"User-Agent": "FireflyProxy-Test/1.0",
			Host: "attacker.test"
		}
	);

    assert.doesNotMatch(transport.url, new RegExp(secret));
    assert.doesNotMatch(transport.url, /headers=/);
    assert.equal(
        transport.url,
        "http://proxy.test/__proxyweb/api?url=https%3A%2F%2Fupstream.test%2Fprivate"
    );
	assert.equal(transport.headers.Authorization, undefined);
	assert.equal(transport.headers.Referer, undefined);
	assert.equal(transport.headers[UPSTREAM_AUTHORIZATION_HEADER], `Bearer ${secret}`);
	assert.equal(transport.headers[UPSTREAM_REFERER_HEADER], undefined);
	assert.deepEqual(decodeUpstreamHeadersEnvelope(transport.headers[UPSTREAM_HEADERS_HEADER]), [
		["Accept", "application/json"],
		["Referer", "https://upstream.test/source"],
		["Origin", "https://client.example"],
		["Cookie", "session=upstream"],
		["User-Agent", "FireflyProxy-Test/1.0"]
	]);
	assert.deepEqual(transport.ignoredHeaders, ["Host"]);
});

test("proxy transport rejects malformed names, invalid Origin and header injection", async () => {
	const { buildProxyTransport, decodeUpstreamHeadersEnvelope, UPSTREAM_HEADERS_HEADER } = await loadSecurityHelpers();
	const transport = buildProxyTransport("http://proxy.test", "https://upstream.test", {
		"Bad Header": "value",
		Origin: "https://example.test/path",
		"X-Injection": "safe\r\nInjected: yes",
		"X-Trace": "kept"
	});

	assert.deepEqual(transport.ignoredHeaders, ["Bad Header", "Origin", "X-Injection"]);
	assert.deepEqual(decodeUpstreamHeadersEnvelope(transport.headers[UPSTREAM_HEADERS_HEADER]), [
		["X-Trace", "kept"]
	]);
});

test("proxy transport marks API Key headers as sensitive redirect metadata", async () => {
	const { buildProxyTransport, decodeUpstreamHeadersEnvelope, UPSTREAM_HEADERS_HEADER } = await loadSecurityHelpers();
	const transport = buildProxyTransport(
		"http://proxy.test",
		"https://upstream.test",
		{ "X-Custom-Credential": "secret", Accept: "application/json" },
		"",
		{ sensitiveHeaderNames: ["x-custom-credential"] }
	);

	assert.deepEqual(decodeUpstreamHeadersEnvelope(transport.headers[UPSTREAM_HEADERS_HEADER]), [
		["X-Custom-Credential", "secret", true],
		["Accept", "application/json"]
	]);
});

test("proxy transport normalizes a trailing slash before the API route", async () => {
    const { buildProxyTransport } = await loadSecurityHelpers();
    const transport = buildProxyTransport(
        "http://proxy.test/",
        "https://upstream.test/resource"
    );

    assert.match(transport.url, /^http:\/\/proxy\.test\/__proxyweb\/api\?/);
    assert.doesNotMatch(transport.url, /proxy\.test\/\/__proxyweb/);
});
