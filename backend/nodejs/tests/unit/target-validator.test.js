const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    isHostnameBlocked,
    normalizeHostnameRule,
    validateTarget
} = require("../../core/targetValidator");

async function expectTargetError(target, code, statusCode) {
    await assert.rejects(
        validateTarget(target),
        error => {
            assert.equal(error.code, code);
            assert.equal(error.statusCode, statusCode);
            return true;
        }
    );
}

test("target validator accepts canonical HTTP(S) domains and public literals", async () => {
    const domain = await validateTarget("https://Example.COM.:443/path?ok=yes");
    assert.deepEqual(domain, {
        url: "https://example.com/path?ok=yes",
        protocol: "https:",
        hostname: "example.com",
        port: 443,
        addresses: [],
        selectedAddress: null
    });

    const ipv4 = await validateTarget("http://8.8.8.8:8080/");
    assert.equal(ipv4.hostname, "8.8.8.8");
    assert.equal(ipv4.port, 8080);
    assert.deepEqual(ipv4.addresses, [{ address: "8.8.8.8", family: 4 }]);

    const ipv6 = await validateTarget("https://[2001:4860:4860::8888]/");
    assert.equal(ipv6.hostname, "2001:4860:4860::8888");
    assert.deepEqual(ipv6.addresses, [{ address: "2001:4860:4860::8888", family: 6 }]);

    const mapped = await validateTarget("http://[::ffff:8.8.8.8]/");
    assert.equal(mapped.url, "http://8.8.8.8/");
    assert.deepEqual(mapped.addresses, [{ address: "8.8.8.8", family: 4 }]);
});

test("target validator rejects malformed URLs, credentials and unsupported protocols", async () => {
    for (const target of [
        "",
        "not-a-url",
        "http:///",
        "http:example.com",
        "http://user:password@example.com/",
        "http://%65xample.com/",
        "http://exa%2fmple.com/",
        "http://example.com/%zz",
        "http://example.com/a b",
        "http:\\example.com"
    ]) {
        await expectTargetError(target, "PROXY_INVALID_URL", 400);
    }

    for (const target of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)"]) {
        await expectTargetError(target, "PROXY_PROTOCOL_BLOCKED", 403);
    }
});

test("target validator rejects every non-public IPv4 range and legacy notation", async () => {
    for (const target of [
        "http://0.0.0.0/",
        "http://10.0.0.1/",
        "http://100.64.0.1/",
        "http://127.0.0.1/",
        "http://127.1/",
        "http://0177.0.0.1/",
        "http://0x7f000001/",
        "http://2130706433/",
        "http://169.254.1.1/",
        "http://172.16.0.1/",
        "http://192.168.0.1/",
        "http://192.0.2.1/",
        "http://198.18.0.1/",
        "http://224.0.0.1/",
        "http://240.0.0.1/",
        "http://255.255.255.255/"
    ]) {
        await expectTargetError(target, "PROXY_SSRF_BLOCKED", 403);
    }
});

test("target validator rejects local, mapped, reserved and multicast IPv6", async () => {
    for (const target of [
        "http://[::]/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[fc00::1]/",
        "http://[fe80::1]/",
        "http://[ff00::1]/",
        "http://[2001:db8::1]/"
    ]) {
        await expectTargetError(target, "PROXY_SSRF_BLOCKED", 403);
    }
});

test("hostname rules use exact or leading-wildcard matching without regex", async () => {
    assert.equal(normalizeHostnameRule("Example.COM."), "example.com");
    assert.equal(normalizeHostnameRule("*.Example.COM"), "*.example.com");
    assert.equal(normalizeHostnameRule("internal\\.example"), null);
    assert.equal(normalizeHostnameRule("*example.com"), null);
    assert.equal(isHostnameBlocked("example.com", ["example.com"]), true);
    assert.equal(isHostnameBlocked("api.example.com", ["example.com"]), false);
    assert.equal(isHostnameBlocked("api.example.com", ["*.example.com"]), true);
    assert.equal(isHostnameBlocked("example.com", ["*.example.com"]), false);

    await assert.rejects(
        validateTarget("https://API.Example.com/path", {
            blockedHostnames: ["*.example.com"]
        }),
        error => error.code === "PROXY_SSRF_BLOCKED" && error.statusCode === 403
    );
});

test("localhost and its reserved subdomains are always blocked", async () => {
    for (const target of ["http://localhost/", "http://LOCALHOST./", "http://api.localhost/"]) {
        await expectTargetError(target, "PROXY_SSRF_BLOCKED", 403);
    }
});
