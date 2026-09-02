const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    isPublicAddress,
    isHostnameBlocked,
    normalizeAccessRule,
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
    const domain = await validateTarget("https://Example.COM.:443/path?ok=yes", {
        resolveHostname: async hostname => {
            assert.equal(hostname, "example.com");
            return [
                { address: "93.184.216.34", family: 4 },
                { address: "2606:4700:4700::1111", family: 6 }
            ];
        }
    });
    assert.deepEqual(domain, {
        url: "https://example.com/path?ok=yes",
        protocol: "https:",
        hostname: "example.com",
        port: 443,
        addresses: [
            { address: "93.184.216.34", family: 4 },
            { address: "2606:4700:4700::1111", family: 6 }
        ],
        selectedAddress: "93.184.216.34"
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

test("public address policy explicitly rejects special-purpose ranges", () => {
    assert.equal(isPublicAddress("93.184.216.34"), true);
    assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
    for (const address of [
        "0.0.0.0",
        "100.100.100.200",
        "169.254.169.254",
        "192.0.0.9",
        "198.51.100.1",
        "::1",
        "64:ff9b::1",
        "100::1",
        "2001:db8::1",
        "fc00::1",
        "fe80::1"
    ]) {
        assert.equal(isPublicAddress(address), false, address);
    }
});

test("DNS validation preserves all public A/AAAA results and normalizes mapped IPv6", async () => {
    const target = await validateTarget("https://multi.example/", {
        resolveHostname: async () => [
            { address: "93.184.216.34", family: 4 },
            { address: "2606:4700:4700::1111", family: 6 },
            { address: "93.184.216.34", family: 4 },
            { address: "::ffff:8.8.8.8", family: 6 }
        ]
    });

    assert.deepEqual(target.addresses, [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "8.8.8.8", family: 4 }
    ]);
    assert.equal(target.selectedAddress, "93.184.216.34");
});

test("DNS validation rejects private-only and mixed public/private results", async () => {
    for (const records of [
        [{ address: "10.0.0.1", family: 4 }],
        [
            { address: "93.184.216.34", family: 4 },
            { address: "127.0.0.1", family: 4 }
        ],
        [{ address: "::ffff:127.0.0.1", family: 6 }]
    ]) {
        await assert.rejects(
            validateTarget("https://blocked.example/", {
                resolveHostname: async () => records
            }),
            error => error.code === "PROXY_SSRF_BLOCKED" && error.statusCode === 403
        );
    }
});

test("DNS validation fails closed for unavailable, empty and malformed resolvers", async () => {
    const cases = [
        {},
        { resolveHostname: async () => [] },
        { resolveHostname: async () => [{ address: "not-an-ip", family: 4 }] },
        { resolveHostname: async () => [{ address: "8.8.8.8", family: 6 }] },
        { resolveHostname: async () => { throw Object.assign(new Error("missing"), { code: "ENOTFOUND" }); } }
    ];

    for (const context of cases) {
        await assert.rejects(
            validateTarget("https://missing.example/", context),
            error => error.code === "PROXY_DNS_FAILED" && error.statusCode === 502
        );
    }
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

test("network access rules normalize domains, IPs, CIDRs and optional ports", () => {
    assert.equal(normalizeAccessRule("Example.COM.:443"), "example.com:443");
    assert.equal(normalizeAccessRule("*.Example.COM"), "*.example.com");
    assert.equal(normalizeAccessRule("8.8.8.8:53"), "8.8.8.8:53");
    assert.equal(normalizeAccessRule("8.8.8.0/24"), "8.8.8.0/24");
    assert.equal(
        normalizeAccessRule("[2001:4860:4860::8888]:443"),
        "[2001:4860:4860::8888]:443"
    );
    assert.equal(
        normalizeAccessRule("[2606:4700:4700::/48]:8443"),
        "[2606:4700:4700::/48]:8443"
    );
    for (const invalid of ["", "http://example.com", "*example.com", "example.com:0", "8.8.8.0/99"]) {
        assert.equal(normalizeAccessRule(invalid), null, invalid);
    }
});

test("network access blacklist wins and supports host, resolved IP and port matching", async () => {
    const resolveHostname = async () => [{ address: "93.184.216.34", family: 4 }];
    const enabled = (allowed, blocked) => ({ enabled: true, allowed, blocked });

    await assert.rejects(
        validateTarget("https://api.example.com/", {
            resolveHostname,
            accessControl: enabled(["*.example.com"], ["api.example.com"])
        }),
        error => error.code === "PROXY_SSRF_BLOCKED" && error.details.reason === "access-control-blocked"
    );
    await assert.rejects(
        validateTarget("https://safe.example.com/", {
            resolveHostname,
            accessControl: enabled([], ["93.184.216.0/24"])
        }),
        error => error.code === "PROXY_SSRF_BLOCKED" && error.details.reason === "access-control-blocked"
    );
    await validateTarget("https://api.example.com:8443/", {
        resolveHostname,
        accessControl: enabled([], ["api.example.com:443"])
    });
});

test("non-empty allowlist defaults to deny and requires a host match or all resolved IPs", async () => {
    const enabled = allowed => ({ enabled: true, allowed, blocked: [] });
    const mixedResolver = async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "8.8.8.8", family: 4 }
    ];

    await validateTarget("https://api.example.com/", {
        resolveHostname: mixedResolver,
        accessControl: enabled(["*.example.com:443"])
    });
    await assert.rejects(
        validateTarget("https://api.example.com:8443/", {
            resolveHostname: mixedResolver,
            accessControl: enabled(["*.example.com:443"])
        }),
        error => error.code === "PROXY_SSRF_BLOCKED" && error.details.reason === "access-control-not-allowed"
    );
    await assert.rejects(
        validateTarget("https://other.test/", {
            resolveHostname: mixedResolver,
            accessControl: enabled(["93.184.216.0/24"])
        }),
        error => error.code === "PROXY_SSRF_BLOCKED" && error.details.reason === "access-control-not-allowed"
    );
    await validateTarget("https://other.test/", {
        resolveHostname: async () => [
            { address: "93.184.216.34", family: 4 },
            { address: "93.184.216.35", family: 4 }
        ],
        accessControl: enabled(["93.184.216.0/24"])
    });
});

test("localhost and its reserved subdomains are always blocked", async () => {
    for (const target of ["http://localhost/", "http://LOCALHOST./", "http://api.localhost/"]) {
        await expectTargetError(target, "PROXY_SSRF_BLOCKED", 403);
    }
});
