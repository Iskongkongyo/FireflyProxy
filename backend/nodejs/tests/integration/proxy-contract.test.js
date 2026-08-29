const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { after, before, test } = require("node:test");
const { createUpstreamFixture, RANGE_BODY } = require("../fixtures/upstream-server");
const { startProxy } = require("../helpers/proxy-process");

let fixture;
let proxy;

function proxyUrl(target, headers = {}) {
    const query = new URLSearchParams({
        url: target,
        headers: JSON.stringify(headers)
    });
    return `${proxy.origin}/?${query}`;
}

function fixtureRedirect(location, status = 302) {
    const target = new URL(`${fixture.origin}/redirect-to`);
    target.searchParams.set("status", String(status));
    target.searchParams.set("location", location);
    return target.href;
}

before(async () => {
    fixture = await createUpstreamFixture();
    proxy = await startProxy();
});

after(async () => {
    await proxy.close();
    await fixture.close();
});

test("GET forwards target query and exposes upstream headers", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/json?hello=world`));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fixture"), "json");
    assert.deepEqual(payload, { ok: true, method: "GET", query: { hello: "world" } });
});

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`${method} streams body and custom headers`, async () => {
        const response = await fetch(proxyUrl(`${fixture.origin}/echo`, {
            "x-upstream-token": `token-${method.toLowerCase()}`
        }), {
            method,
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: `body-${method.toLowerCase()}`
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.method, method);
        assert.equal(payload.headers["x-upstream-token"], `token-${method.toLowerCase()}`);
        assert.equal(payload.body, `body-${method.toLowerCase()}`);
    });
}

test("HEAD preserves status and response headers", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/json`), { method: "HEAD" });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fixture"), "json");
    assert.equal(await response.text(), "");
});

test("upstream error status and body pass through", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/status/418`));
    const payload = await response.json();

    assert.equal(response.status, 418);
    assert.deepEqual(payload, { status: 418 });
});

test("validated redirect loop follows relative and absolute Location values", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/redirect`));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.query.via, "redirect");

    const absoluteTarget = `${fixture.origin}/json?via=absolute`;
    const absolute = await fetch(proxyUrl(fixtureRedirect(absoluteTarget)));
    assert.equal(absolute.status, 200);
    assert.equal((await absolute.json()).query.via, "absolute");
});

test("disabled redirect following returns the original 3xx response", async () => {
    const noFollowProxy = await startProxy({
        api: { followRedirects: false, maxRedirects: 5 }
    });
    try {
        const response = await fetch(
            `${noFollowProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/redirect`)}`,
            { redirect: "manual" }
        );
        assert.equal(response.status, 302);
        assert.equal(response.headers.get("location"), "/json?via=redirect");
    } finally {
        await noFollowProxy.close();
    }
});

test("redirect loops and configured redirect limits fail with a stable 508 error", async () => {
    const loopResponse = await fetch(proxyUrl(`${fixture.origin}/redirect-loop-a`));
    assert.equal(loopResponse.status, 508);
    assert.equal((await loopResponse.json()).error.code, "PROXY_REDIRECT_LIMIT");

    const limitedProxy = await startProxy({ max_redirects: 1 });
    try {
        const response = await fetch(
            `${limitedProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/redirect-chain/2`)}`
        );
        assert.equal(response.status, 508);
        assert.equal((await response.json()).error.code, "PROXY_REDIRECT_LIMIT");
    } finally {
        await limitedProxy.close();
    }
});

test("redirect status codes apply explicit method and request body rules", async () => {
    const cases = [
        { status: 301, method: "POST", expectedMethod: "GET", expectedBody: "" },
        { status: 302, method: "POST", expectedMethod: "GET", expectedBody: "" },
        { status: 303, method: "PUT", expectedMethod: "GET", expectedBody: "" },
        { status: 307, method: "POST", expectedMethod: "POST", expectedBody: "body-307" },
        { status: 308, method: "PUT", expectedMethod: "PUT", expectedBody: "body-308" }
    ];

    for (const item of cases) {
        const body = `body-${item.status}`;
        const response = await fetch(proxyUrl(fixtureRedirect("/echo", item.status)), {
            method: item.method,
            headers: { "content-type": "text/plain" },
            body
        });
        const payload = await response.json();
        assert.equal(response.status, 200, String(item.status));
        assert.equal(payload.method, item.expectedMethod, String(item.status));
        assert.equal(payload.body, item.expectedBody, String(item.status));
        if (item.expectedMethod === "GET") {
            assert.equal(payload.headers["content-type"], undefined, String(item.status));
            assert.equal(payload.headers["content-length"], undefined, String(item.status));
        }
    }

    const early = await fetch(proxyUrl(`${fixture.origin}/redirect-early`), {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "body-from-early-redirect"
    });
    const earlyPayload = await early.json();
    assert.equal(early.status, 200);
    assert.equal(earlyPayload.method, "POST");
    assert.equal(earlyPayload.body, "body-from-early-redirect");
});

test("streamed response reaches the client intact", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/stream`));

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "chunk-1|chunk-2|chunk-3");
});

test("Range request preserves 206 and Content-Range", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/range`), {
        headers: { range: "bytes=5-9" }
    });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes 5-9/${RANGE_BODY.length}`);
    assert.equal(await response.text(), RANGE_BODY.subarray(5, 10).toString("utf8"));
});

test("session target supports a later path request", async () => {
    const initial = await fetch(proxyUrl(`${fixture.origin}/json`));
    const cookie = initial.headers.get("set-cookie");
    assert.ok(cookie && cookie.includes("proxySession="));

    const response = await fetch(`${proxy.origin}/echo?session=yes`, {
        headers: { cookie: cookie.split(";", 1)[0] }
    });
    const payload = await response.json();

    assert.equal(payload.url, "/echo?session=yes");
});

test("configured proxy Basic Auth rejects missing credentials and accepts valid credentials", async () => {
    const authProxy = await startProxy({ user: "proxy-user", pwd: "proxy-password" });
    try {
        const target = `${fixture.origin}/json`;
        const unauthorized = await fetch(`${authProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(unauthorized.status, 401);

        const authorized = await fetch(`${authProxy.origin}/?url=${encodeURIComponent(target)}`, {
            headers: {
                authorization: `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`
            }
        });
        assert.equal(authorized.status, 200);
    } finally {
        await authProxy.close();
    }
});

test("CORS preflight returns configured origin and credentials policy", async () => {
    const response = await fetch(`${proxy.origin}/`, {
        method: "OPTIONS",
        headers: {
            origin: "http://frontend.test",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type,x-requested-with"
        }
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://frontend.test");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.match(response.headers.get("access-control-allow-headers"), /x-requested-with/);
    assert.match(response.headers.get("vary"), /Origin/);
});

test("credentialed CORS rejects arbitrary and malformed Origins", async () => {
    for (const origin of ["https://evil.test", "https://frontend.test/path", "not-an-origin"]) {
        const response = await fetch(`${proxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`, {
            headers: { origin }
        });
        const payload = await response.json();

        assert.equal(response.status, 403);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        assert.match(response.headers.get("vary"), /Origin/);
        assert.equal(payload.error.code, "PROXY_CORS_ORIGIN_DENIED");
    }
});

test("allowed and missing Origins receive distinct CORS responses", async () => {
    const target = `${fixture.origin}/json`;
    const allowed = await fetch(`${proxy.origin}/?url=${encodeURIComponent(target)}`, {
        headers: { origin: "http://frontend.test" }
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://frontend.test");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");

    const noOrigin = await fetch(`${proxy.origin}/?url=${encodeURIComponent(target)}`, {
        headers: { referer: "https://evil.test/page" }
    });
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
    assert.equal(noOrigin.headers.get("access-control-allow-credentials"), null);
});

test("wildcard CORS is only emitted without credentials", async () => {
    const wildcardProxy = await startProxy({
        cors: { allowedOrigins: ["*"], allowCredentials: false }
    });
    try {
        const response = await fetch(`${wildcardProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`, {
            headers: { origin: "https://anywhere.test" }
        });

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        assert.equal(response.headers.get("access-control-allow-credentials"), null);
    } finally {
        await wildcardProxy.close();
    }
});

test("CORS preflight rejects unsupported methods and malformed requested headers", async () => {
    const unsupported = await fetch(`${proxy.origin}/`, {
        method: "OPTIONS",
        headers: {
            origin: "http://frontend.test",
            "access-control-request-method": "TRACE"
        }
    });
    assert.equal(unsupported.status, 403);
    assert.equal((await unsupported.json()).error.code, "PROXY_CORS_METHOD_DENIED");

    const malformedHeaders = await fetch(`${proxy.origin}/`, {
        method: "OPTIONS",
        headers: {
            origin: "http://frontend.test",
            "access-control-request-method": "POST",
            "access-control-request-headers": "x-valid, bad header"
        }
    });
    assert.equal(malformedHeaders.status, 400);
    assert.equal((await malformedHeaders.json()).error.code, "PROXY_CORS_HEADERS_INVALID");

    const ordinaryOptions = await fetch(`${proxy.origin}/`, { method: "OPTIONS" });
    assert.equal(ordinaryOptions.status, 400);
    assert.equal(ordinaryOptions.headers.get("access-control-allow-origin"), null);
});

test("rate limiter can reject requests after the configured maximum", async () => {
    const limitedProxy = await startProxy({ limiter: { windowMs: 60000, max: 1 } });
    try {
        const target = `${fixture.origin}/json`;
        const first = await fetch(`${limitedProxy.origin}/?url=${encodeURIComponent(target)}`);
        const second = await fetch(`${limitedProxy.origin}/?url=${encodeURIComponent(target)}`);

        assert.equal(first.status, 200);
        assert.equal(second.status, 429);
        assert.equal(await second.text(), "fixture rate limit");
    } finally {
        await limitedProxy.close();
    }
});

test("default trustProxy ignores spoofed X-Forwarded-For for rate-limit identity", async () => {
    const directProxy = await startProxy({
        trustProxy: false,
        limiter: { windowMs: 60000, max: 1 }
    });
    try {
        const target = `${fixture.origin}/json`;
        const first = await fetch(`${directProxy.origin}/?url=${encodeURIComponent(target)}`, {
            headers: { "x-forwarded-for": "198.51.100.10" }
        });
        const second = await fetch(`${directProxy.origin}/?url=${encodeURIComponent(target)}`, {
            headers: { "x-forwarded-for": "198.51.100.11" }
        });

        assert.equal(first.status, 200);
        assert.equal(second.status, 429);
    } finally {
        await directProxy.close();
    }
});

test("numeric trustProxy uses the configured proxy hop count", async () => {
    const target = `${fixture.origin}/json`;
    for (const [trustProxy, expectedIp] of [[1, "203.0.113.20"], [2, "198.51.100.10"]]) {
        const trustedProxy = await startProxy({ trustProxy });
        try {
            const outputIndex = trustedProxy.getOutput().length;
            const response = await fetch(`${trustedProxy.origin}/?url=${encodeURIComponent(target)}`, {
                headers: { "x-forwarded-for": "198.51.100.10, 203.0.113.20" }
            });
            assert.equal(response.status, 200);
            await trustedProxy.waitForOutput(/Incoming request/, outputIndex);
            assert.match(trustedProxy.getOutput().slice(outputIndex), new RegExp(`"ip":"${expectedIp}"`));
        } finally {
            await trustedProxy.close();
        }
    }
});

test("authentication configuration hot reload affects later requests", async () => {
    const hotProxy = await startProxy();
    try {
        const target = `${fixture.origin}/json`;
        const beforeReload = await fetch(`${hotProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(beforeReload.status, 200);

        const outputIndex = hotProxy.getOutput().length;
        await hotProxy.updateConfig({ user: "hot-user", pwd: "hot-password" });
        await hotProxy.waitForOutput(/Configuration loaded/, outputIndex);

        const afterReload = await fetch(`${hotProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(afterReload.status, 401);
    } finally {
        await hotProxy.close();
    }
});

test("stored session targets are revalidated against hot-loaded hostname rules", async () => {
    const hotProxy = await startProxy();
    try {
        const initial = await fetch(`${hotProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`);
        assert.equal(initial.status, 200);
        const cookie = initial.headers.get("set-cookie");
        assert.ok(cookie && cookie.includes("proxySession="));

        const outputIndex = hotProxy.getOutput().length;
        await hotProxy.updateConfig({
            security: { blockedHostnames: ["fixture.test"] }
        });
        await hotProxy.waitForOutput(/Configuration loaded/, outputIndex);

        const afterReload = await fetch(`${hotProxy.origin}/echo`, {
            headers: { cookie: cookie.split(";", 1)[0] }
        });
        assert.equal(afterReload.status, 403);
        assert.equal((await afterReload.json()).error.code, "PROXY_SSRF_BLOCKED");
    } finally {
        await hotProxy.close();
    }
});

test("invalid configuration reload keeps the previous working configuration", async () => {
    const hotProxy = await startProxy();
    try {
        const outputIndex = hotProxy.getOutput().length;
        await fs.writeFile(hotProxy.configPath, "{ invalid json", "utf8");
        await hotProxy.waitForOutput(/Error loading config/, outputIndex);

        const response = await fetch(`${hotProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`);
        assert.equal(response.status, 200);
    } finally {
        await hotProxy.close();
    }
});

test("schema-invalid configuration reload is rejected atomically", async () => {
    const hotProxy = await startProxy();
    try {
        const outputIndex = hotProxy.getOutput().length;
        await hotProxy.updateConfig({ limiter: { max: 0 } });
        await hotProxy.waitForOutput(/CONFIG_SCHEMA_INVALID/, outputIndex);

        const response = await fetch(`${hotProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`);
        assert.equal(response.status, 200);
    } finally {
        await hotProxy.close();
    }
});

test("invalid targets use the stable public error envelope", async () => {
    const response = await fetch(`${proxy.origin}/?url=${encodeURIComponent("not-a-url")}`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
    assert.deepEqual(payload, {
        error: {
            code: "PROXY_INVALID_URL",
            message: "Target URL is invalid"
        }
    });
});

test("an explicitly empty target uses the same invalid URL envelope", async () => {
    const response = await fetch(`${proxy.origin}/?url=`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        error: {
            code: "PROXY_INVALID_URL",
            message: "Target URL is invalid"
        }
    });
});

test("target validation distinguishes protocols and non-public literal addresses", async () => {
    const cases = [
        ["ftp://example.test/file", "PROXY_PROTOCOL_BLOCKED"],
        ["http://localhost/", "PROXY_SSRF_BLOCKED"],
        ["http://127.1/", "PROXY_SSRF_BLOCKED"],
        ["http://[::1]/", "PROXY_SSRF_BLOCKED"],
        ["http://[::ffff:127.0.0.1]/", "PROXY_SSRF_BLOCKED"]
    ];

    for (const [target, code] of cases) {
        const response = await fetch(`${proxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error.code, code);
    }
});

test("reserved security flags cannot disable literal address validation", async () => {
    const hardenedProxy = await startProxy({
        security: {
            ssrf: false,
            allowPrivateNetworks: true,
            blockedHostnames: []
        }
    });
    try {
        const response = await fetch(`${hardenedProxy.origin}/?url=${encodeURIComponent("http://127.0.0.1/")}`);
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error.code, "PROXY_SSRF_BLOCKED");
    } finally {
        await hardenedProxy.close();
    }
});

test("URL credentials are rejected without reaching request or error logs", async () => {
    const credentialProxy = await startProxy();
    const secret = "url-password-must-not-appear";
    try {
        const outputIndex = credentialProxy.getOutput().length;
        const target = `http://user:${secret}@fixture.test/echo`;
        const response = await fetch(`${credentialProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, "PROXY_INVALID_URL");
        await credentialProxy.waitForOutput(/PROXY_INVALID_URL/, outputIndex);
        assert.doesNotMatch(credentialProxy.getOutput().slice(outputIndex), new RegExp(secret));
    } finally {
        await credentialProxy.close();
    }
});

test("configured hostname rules block exact hosts and wildcard subdomains", async () => {
    const blockedProxy = await startProxy({
        security: { blockedHostnames: ["blocked.test", "*.internal.test"] }
    });
    try {
        for (const target of ["http://blocked.test/", "https://api.internal.test/path"]) {
            const response = await fetch(`${blockedProxy.origin}/?url=${encodeURIComponent(target)}`);
            assert.equal(response.status, 403);
            assert.equal((await response.json()).error.code, "PROXY_SSRF_BLOCKED");
        }
    } finally {
        await blockedProxy.close();
    }
});

test("upstream connection failures do not expose internal network details", async () => {
    const target = "http://fixture.test:1/unavailable";
    const response = await fetch(`${proxy.origin}/?url=${encodeURIComponent(target)}`);
    const text = await response.text();

    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(text), {
        error: {
            code: "PROXY_UPSTREAM_ERROR",
            message: "Upstream request failed"
        }
    });
    assert.doesNotMatch(text, /ECONNREFUSED|127\.0\.0\.1|node_modules|app\.js/);
});

test("proxy Basic Auth credentials are removed while dedicated upstream auth is preserved", async () => {
    const authProxy = await startProxy({ user: "proxy-user", pwd: "proxy-password" });
    const proxyAuthorization = `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`;
    const upstreamAuthorization = "Bearer dedicated-upstream-token";
    try {
        const target = `${fixture.origin}/echo`;
        const response = await fetch(`${authProxy.origin}/?url=${encodeURIComponent(target)}`, {
            headers: {
                authorization: proxyAuthorization,
                "x-proxyweb-upstream-authorization": upstreamAuthorization
            }
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.headers.authorization, upstreamAuthorization);
        assert.equal(payload.headers["x-proxyweb-upstream-authorization"], undefined);
        assert.doesNotMatch(JSON.stringify(payload.headers), /proxy-password|cHJveHktdXNlcjpwcm94eS1wYXNzd29yZA==/);

        const proxyOnly = await fetch(`${authProxy.origin}/?url=${encodeURIComponent(target)}`, {
            headers: { authorization: proxyAuthorization }
        });
        const proxyOnlyPayload = await proxyOnly.json();
        assert.equal(proxyOnlyPayload.headers.authorization, undefined);
    } finally {
        await authProxy.close();
    }
});

test("legacy headers query remains compatible and advertises deprecation", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/echo`, {
        authorization: "Bearer legacy-upstream-token"
    }));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.headers.authorization, "Bearer legacy-upstream-token");
    assert.equal(response.headers.get("deprecation"), "true");
    assert.match(response.headers.get("warning"), /headers query parameter is deprecated/);
});

test("domain targets with private, mixed, empty or failed DNS results are rejected", async () => {
    const dnsProxy = await startProxy({}, {
        dnsRecords: {
            "private.test": [{ address: "10.0.0.1", family: 4 }],
            "mixed.test": [
                { address: "93.184.216.34", family: 4 },
                { address: "127.0.0.1", family: 4 }
            ],
            "empty.test": [],
            "missing.test": { error: "ENOTFOUND" }
        }
    });
    try {
        for (const hostname of ["private.test", "mixed.test"]) {
            const response = await fetch(`${dnsProxy.origin}/?url=${encodeURIComponent(`http://${hostname}/`)}`);
            assert.equal(response.status, 403);
            assert.equal((await response.json()).error.code, "PROXY_SSRF_BLOCKED");
        }
        for (const hostname of ["empty.test", "missing.test"]) {
            const response = await fetch(`${dnsProxy.origin}/?url=${encodeURIComponent(`http://${hostname}/`)}`);
            assert.equal(response.status, 502);
            assert.equal((await response.json()).error.code, "PROXY_DNS_FAILED");
        }
    } finally {
        await dnsProxy.close();
    }
});
test("every redirect target is revalidated before connecting", async () => {
    const privateTarget = `http://127.0.0.1:${new URL(fixture.origin).port}/echo`;
    const response = await fetch(proxyUrl(fixtureRedirect(privateTarget)));

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "PROXY_SSRF_BLOCKED");
});

test("cross-origin redirects remove authentication, cookies and token-like headers", async () => {
    const crossOriginProxy = await startProxy({}, {
        dnsRecords: {
            "other.test": [{ address: "93.184.216.35", family: 4 }]
        }
    });
    try {
        const fixturePort = new URL(fixture.origin).port;
        const crossOriginTarget = `http://other.test:${fixturePort}/echo`;
        const query = new URLSearchParams({
            url: fixtureRedirect(crossOriginTarget),
            headers: JSON.stringify({
                "x-api-key": "cross-origin-api-key",
                "x-upstream-token": "cross-origin-token",
                "x-safe": "keep"
            })
        });
        const response = await fetch(`${crossOriginProxy.origin}/?${query}`, {
            headers: {
                cookie: "proxy-client-cookie=secret",
                "x-proxyweb-upstream-authorization": "Bearer cross-origin-authorization"
            }
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.headers.host, `other.test:${fixturePort}`);
        assert.equal(payload.headers.authorization, undefined);
        assert.equal(payload.headers.cookie, undefined);
        assert.equal(payload.headers["x-api-key"], undefined);
        assert.equal(payload.headers["x-upstream-token"], undefined);
        assert.equal(payload.headers["x-safe"], "keep");
    } finally {
        await crossOriginProxy.close();
    }
});

test("redirect chain logs redact sensitive URL query values", async () => {
    const redirectLogProxy = await startProxy();
    const secret = "redirect-log-secret-789";
    try {
        const outputIndex = redirectLogProxy.getOutput().length;
        const location = `/json?token=${secret}`;
        const response = await fetch(
            `${redirectLogProxy.origin}/?url=${encodeURIComponent(fixtureRedirect(location))}`
        );
        assert.equal(response.status, 200);
        await redirectLogProxy.waitForOutput(/Following validated redirect/, outputIndex);

        const output = redirectLogProxy.getOutput().slice(outputIndex);
        assert.doesNotMatch(output, new RegExp(secret));
        assert.match(output, /\[REDACTED\]/);
    } finally {
        await redirectLogProxy.close();
    }
});

test("validated DNS addresses are pinned without a second system lookup", async () => {
    const pinnedProxy = await startProxy({}, {
        dnsRecords: {
            "rebind.test": [{ address: "93.184.216.34", family: 4 }]
        }
    });
    try {
        const fixturePort = new URL(fixture.origin).port;
        const target = `http://rebind.test:${fixturePort}/echo`;
        const response = await fetch(`${pinnedProxy.origin}/?url=${encodeURIComponent(target)}`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.headers.host, `rebind.test:${fixturePort}`);
    } finally {
        await pinnedProxy.close();
    }
});

test("request and error logs redact legacy and dedicated upstream credentials", async () => {
    const logProxy = await startProxy();
    const legacySecret = "legacy-log-secret-123";
    const dedicatedSecret = "dedicated-log-secret-456";
    try {
        const outputIndex = logProxy.getOutput().length;
        const legacyResponse = await fetch(`${logProxy.origin}/?${new URLSearchParams({
            url: `${fixture.origin}/echo`,
            headers: JSON.stringify({ authorization: `Bearer ${legacySecret}` })
        })}`);
        assert.equal(legacyResponse.status, 200);

        const errorResponse = await fetch(`${logProxy.origin}/?url=${encodeURIComponent("http://fixture.test:1/unavailable")}`, {
            headers: {
                "x-proxyweb-upstream-authorization": `Bearer ${dedicatedSecret}`
            }
        });
        assert.equal(errorResponse.status, 502);
        await logProxy.waitForOutput(/Request failed/, outputIndex);

        const output = logProxy.getOutput().slice(outputIndex);
        assert.doesNotMatch(output, new RegExp(`${legacySecret}|${dedicatedSecret}`));
        assert.match(output, /\[REDACTED\]/);
    } finally {
        await logProxy.close();
    }
});
