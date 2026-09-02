const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { toProxyUrl } = require("../../core/urlMapper");
const { createUpstreamFixture } = require("../fixtures/upstream-server");
const { startProxy } = require("../helpers/proxy-process");

let fixture;

before(async () => {
    fixture = await createUpstreamFixture();
});

after(async () => {
    await fixture.close();
});

function cacheSettings(overrides = {}) {
    return {
        enabled: true,
        directory: "./public-cache",
        ttlMs: 60000,
        maxBytes: 1024 * 1024,
        maxObjectBytes: 512,
        ...overrides
    };
}

function browserUrl(proxy, target) {
    return new URL(toProxyUrl(target), proxy.origin);
}

async function cacheFetch(proxy, path, options = {}) {
    return fetch(browserUrl(proxy, `${fixture.origin}${path}`), options);
}

test("Browser public cache hits explicit public static variants and serves HEAD from GET", async () => {
    const proxy = await startProxy({
        browser: { enabled: true, publicCache: cacheSettings() }
    });
    try {
        const headers = { "accept-language": "zh-CN" };
        const first = await cacheFetch(proxy, "/cache/public.js?case=hit", { headers });
        const firstBody = await first.text();
        assert.equal(first.headers.get("x-proxyweb-cache"), "MISS");
        assert.equal(first.headers.get("x-fixture-cache-count"), "1");

        const second = await cacheFetch(proxy, "/cache/public.js?case=hit", { headers });
        assert.equal(second.headers.get("x-proxyweb-cache"), "HIT");
        assert.equal(second.headers.get("x-fixture-cache-count"), "1");
        assert.equal(await second.text(), firstBody);

        const variant = await cacheFetch(proxy, "/cache/public.js?case=hit", {
            headers: { "accept-language": "en-US" }
        });
        assert.equal(variant.headers.get("x-proxyweb-cache"), "MISS");
        assert.equal(variant.headers.get("x-fixture-cache-count"), "1");
        assert.notEqual(await variant.text(), firstBody);

        const head = await cacheFetch(proxy, "/cache/public.js?case=hit", {
            method: "HEAD",
            headers
        });
        assert.equal(head.headers.get("x-proxyweb-cache"), "HIT");
        assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(firstBody));
        assert.equal(await head.text(), "");

        const cssFirst = await cacheFetch(proxy, "/cache/public.css");
        const cssBody = await cssFirst.text();
        assert.equal(cssFirst.headers.get("x-proxyweb-cache"), "MISS");
        assert.match(cssBody, /\/__proxyweb\/browser\/[^/]+\/cache\/public\.png\?case=css/);
        const cssSecond = await cacheFetch(proxy, "/cache/public.css");
        assert.equal(cssSecond.headers.get("x-proxyweb-cache"), "HIT");
        assert.equal(await cssSecond.text(), cssBody);

        const agedFirst = await cacheFetch(proxy, "/cache/public.js?case=age&age=30");
        assert.equal(agedFirst.headers.get("x-proxyweb-cache"), "MISS");
        assert.equal(agedFirst.headers.get("age"), "30");
        await agedFirst.arrayBuffer();
        const agedHit = await cacheFetch(proxy, "/cache/public.js?case=age&age=30");
        assert.equal(agedHit.headers.get("x-proxyweb-cache"), "HIT");
        assert.ok(Number(agedHit.headers.get("age")) >= 30);
        await agedHit.arrayBuffer();
    } finally {
        await proxy.close();
    }
});

test("Browser public cache collapses concurrent misses and versions rewritten output", async () => {
    const proxy = await startProxy({
        browser: { enabled: true, rewriteCss: true, publicCache: cacheSettings() }
    });
    try {
        const target = "/cache/public.js?case=collapse&delay=1";
        const responses = await Promise.all(Array.from({ length: 5 }, () => (
            cacheFetch(proxy, target, { headers: { "accept-language": "collapse" } })
        )));
        await Promise.all(responses.map(response => response.arrayBuffer()));
        assert.equal(responses.filter(response => response.headers.get("x-proxyweb-cache") === "MISS").length, 1);
        assert.equal(responses.filter(response => response.headers.get("x-proxyweb-cache") === "HIT").length, 4);
        assert.deepEqual(
            [...new Set(responses.map(response => response.headers.get("x-fixture-cache-count")))],
            ["1"]
        );

        const outputIndex = proxy.getOutput().length;
        await proxy.updateConfig({
            browser: { enabled: true, rewriteCss: false, publicCache: cacheSettings() }
        });
        await proxy.waitForOutput(/Configuration loaded/, outputIndex);
        const versionMiss = await cacheFetch(proxy, target, {
            headers: { "accept-language": "collapse" }
        });
        assert.equal(versionMiss.headers.get("x-proxyweb-cache"), "MISS");
        assert.equal(versionMiss.headers.get("x-fixture-cache-count"), "2");
        await versionMiss.arrayBuffer();
    } finally {
        await proxy.close();
    }
});

test("Browser public cache fails closed for credentials, cookies, response policy and non-static bodies", async () => {
    const proxy = await startProxy({
        browser: { enabled: true, publicCache: cacheSettings() }
    });
    try {
        const apiTarget = `${fixture.origin}/cache/public.js?case=api-mode`;
        const apiResponse = await fetch(
            `${proxy.origin}/__proxyweb/api?url=${encodeURIComponent(apiTarget)}`,
            { headers: { "accept-language": "api-mode" } }
        );
        assert.equal(apiResponse.headers.get("x-proxyweb-cache"), null);
        assert.equal(apiResponse.headers.get("x-fixture-cache-count"), "1");
        await apiResponse.arrayBuffer();
        const browserAfterApi = await cacheFetch(proxy, "/cache/public.js?case=api-mode", {
            headers: { "accept-language": "api-mode" }
        });
        assert.equal(browserAfterApi.headers.get("x-proxyweb-cache"), "MISS");
        assert.equal(browserAfterApi.headers.get("x-fixture-cache-count"), "2");
        await browserAfterApi.arrayBuffer();

        const authTarget = "/cache/public.js?case=auth";
        for (let count = 1; count <= 2; count += 1) {
            const response = await cacheFetch(proxy, authTarget, {
                headers: {
                    "accept-language": "auth",
                    "x-proxyweb-upstream-authorization": "Bearer private-token"
                }
            });
            assert.equal(response.headers.get("x-proxyweb-cache"), "BYPASS");
            assert.equal(response.headers.get("x-fixture-cache-count"), String(count));
            await response.arrayBuffer();
        }

        let sessionCookie = "";
        for (let count = 1; count <= 2; count += 1) {
            const response = await cacheFetch(proxy, "/cache/private.js", {
                headers: sessionCookie ? { cookie: sessionCookie } : undefined
            });
            sessionCookie ||= response.headers.get("set-cookie")?.split(";", 1)[0] || "";
            assert.equal(response.headers.get("x-proxyweb-cache"), "BYPASS");
            assert.equal(response.headers.get("x-fixture-cache-count"), String(count));
            await response.arrayBuffer();
        }
        const otherSession = await cacheFetch(proxy, "/cache/private.js");
        assert.equal(otherSession.headers.get("x-proxyweb-cache"), "BYPASS");
        assert.equal(otherSession.headers.get("x-fixture-cache-count"), "3");
        await otherSession.arrayBuffer();

        for (const [path, firstCount, secondCount] of [
            ["/cache/no-store.js", "1", "2"],
            ["/cache/public.html", "1", "2"],
            ["/cache/public.png?size=1024&case=large", "1", "2"]
        ]) {
            const first = await cacheFetch(proxy, path);
            const firstHeader = first.headers.get("x-fixture-cache-count");
            await first.arrayBuffer();
            const second = await cacheFetch(proxy, path);
            const secondHeader = second.headers.get("x-fixture-cache-count");
            await second.arrayBuffer();
            assert.equal(first.headers.get("x-proxyweb-cache"), "BYPASS");
            assert.equal(second.headers.get("x-proxyweb-cache"), "BYPASS");
            assert.equal(firstHeader, firstCount);
            assert.equal(secondHeader, secondCount);
        }

        for (let count = 1; count <= 2; count += 1) {
            const ranged = await cacheFetch(proxy, "/cache/public.png?case=range", {
                headers: { range: "bytes=0-10" }
            });
            assert.equal(ranged.headers.get("x-proxyweb-cache"), "BYPASS");
            assert.equal(ranged.headers.get("x-fixture-cache-count"), String(count));
            await ranged.arrayBuffer();
        }

        for (const [cacheCase, headers] of [
            ["request-no-cache", { "cache-control": "no-cache" }],
            ["conditional", { "if-none-match": "fixture-etag" }]
        ]) {
            for (let count = 1; count <= 2; count += 1) {
                const bypassed = await cacheFetch(proxy, `/cache/public.js?case=${cacheCase}`, { headers });
                assert.equal(bypassed.headers.get("x-proxyweb-cache"), "BYPASS");
                assert.equal(bypassed.headers.get("x-fixture-cache-count"), String(count));
                await bypassed.arrayBuffer();
            }
        }

        for (let count = 1; count <= 2; count += 1) {
            const oversized = await cacheFetch(
                proxy,
                "/cache/public.png?size=1024&chunked=1&case=stream-limit"
            );
            const bytes = Buffer.from(await oversized.arrayBuffer());
            assert.equal(oversized.headers.get("x-proxyweb-cache"), "MISS");
            assert.equal(oversized.headers.get("x-fixture-cache-count"), String(count));
            assert.equal(bytes.length, 1024);
            assert.ok(bytes.every(value => value === count));
        }
    } finally {
        await proxy.close();
    }
});

test("Admin cache API reports capacity and invalidates an exact upstream range", async () => {
    const proxy = await startProxy({
        admin: { enabled: true, path: "/control", user: "admin-user", pwd: "admin-password" },
        browser: { enabled: true, publicCache: cacheSettings() }
    });
    const auth = `Basic ${Buffer.from("admin-user:admin-password").toString("base64")}`;
    const adminHeaders = {
        authorization: auth,
        referer: `${proxy.origin}/control`
    };
    try {
        const cached = await cacheFetch(proxy, "/cache/public.js?case=admin", {
            headers: { "accept-language": "admin" }
        });
        await cached.arrayBuffer();
        const hit = await cacheFetch(proxy, "/cache/public.js?case=admin", {
            headers: { "accept-language": "admin" }
        });
        assert.equal(hit.headers.get("x-proxyweb-cache"), "HIT");
        await hit.arrayBuffer();

        const stats = await fetch(`${proxy.origin}/control/api/cache`, { headers: adminHeaders });
        assert.equal(stats.status, 200);
        assert.equal((await stats.json()).entries, 1);

        const invalidated = await fetch(`${proxy.origin}/control/api/cache`, {
            method: "DELETE",
            headers: {
                ...adminHeaders,
                origin: proxy.origin,
                "content-type": "application/json",
                "x-fireflyproxy-admin": "1"
            },
            body: JSON.stringify({ hostname: "fixture.test", pathPrefix: "/cache/" })
        });
        assert.equal(invalidated.status, 200);
        assert.deepEqual(await invalidated.json(), { ok: true, removed: 1 });

        const after = await cacheFetch(proxy, "/cache/public.js?case=admin", {
            headers: { "accept-language": "admin" }
        });
        assert.equal(after.headers.get("x-proxyweb-cache"), "MISS");
        assert.equal(after.headers.get("x-fixture-cache-count"), "2");
        await after.arrayBuffer();
    } finally {
        await proxy.close();
    }
});
