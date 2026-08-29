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

test("current redirect behavior follows relative Location", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/redirect`));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.query.via, "redirect");
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

test.todo("proxy Basic Auth credentials are removed before forwarding upstream");
test.todo("domain targets resolving to private addresses are rejected");
test.todo("every redirect target is revalidated before connecting");
test.todo("credentialed CORS never reflects an arbitrary Origin");
test.todo("request logs redact headers query values and Authorization");
