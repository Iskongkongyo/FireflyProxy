const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const {
    browserRepresentationVersion,
    createPublicStaticCache,
    evaluateCacheRequest,
    evaluateCacheResponse,
    isPublicStaticMediaType,
    parseVary
} = require("../../browser-proxy/publicStaticCache");

function cacheConfig(overrides = {}) {
    return {
        browser: {
            rewriteHtml: true,
            rewriteCss: true,
            responseTransform: { enabled: false, rules: [] },
            originIsolation: { enabled: false, baseOrigin: "https://browse.example.com" },
            publicCache: {
                enabled: true,
                directory: "./cache",
                ttlMs: 60_000,
                maxBytes: 1024 * 1024,
                maxObjectBytes: 64 * 1024,
                ...overrides
            }
        }
    };
}

function requestInput(config, overrides = {}) {
    return {
        mode: "browser",
        method: "GET",
        targetUrl: "https://static.example.test/assets/app.js?v=1",
        headers: { accept: "*/*", "accept-language": "zh-CN" },
        config,
        ...overrides
    };
}

function responseInput(config, request, overrides = {}) {
    return {
        request,
        status: 200,
        headers: {
            "content-type": "application/javascript",
            "cache-control": "public, max-age=120",
            vary: "accept-language"
        },
        classification: {
            kind: "stream",
            reason: "content-passthrough",
            mediaType: "application/javascript",
            charset: "utf-8",
            contentEncoding: "identity"
        },
        config,
        ...overrides
    };
}

async function consume(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

async function storeBody(cache, request, response, config, body) {
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });
    const streamed = await consume(cache.capture({
        body: Readable.from([body]),
        request,
        response: {
            ...response,
            headers: response.headers,
            classification: response.classification
        },
        config,
        onComplete: complete
    }));
    const result = await completed;
    assert.deepEqual(streamed, body);
    return result;
}

async function removeCacheDirectory(directory) {
    const resolvedRoot = path.resolve(os.tmpdir());
    const resolvedTarget = path.resolve(directory);
    assert.ok(resolvedTarget.startsWith(`${resolvedRoot}${path.sep}proxyweb-cache-unit-`));
    await fs.rm(resolvedTarget, { recursive: true, force: true });
}

test("public cache request and response eligibility fails closed", () => {
    const config = cacheConfig();
    const valid = evaluateCacheRequest(requestInput(config));
    assert.equal(valid.eligible, true);
    for (const [reason, overrides] of [
        ["mode", { mode: "api" }],
        ["method", { method: "POST" }],
        ["authorization", { headers: { authorization: "Bearer secret" } }],
        ["cookie", { headers: { cookie: "sid=private" } }],
        ["range", { headers: { range: "bytes=0-10" } }],
        ["conditional", { headers: { "if-none-match": "fixture-etag" } }],
        ["request-cache-control", { headers: { "cache-control": "no-cache" } }],
        ["request-cache-control", { headers: { pragma: "no-cache" } }]
    ]) {
        assert.equal(evaluateCacheRequest(requestInput(config, overrides)).reason, reason);
    }

    for (const mediaType of ["text/css", "application/javascript", "image/png", "font/woff2", "application/wasm"]) {
        assert.equal(isPublicStaticMediaType(mediaType), true, mediaType);
    }
    for (const mediaType of ["text/html", "text/event-stream", "video/mp4", "application/pdf"]) {
        assert.equal(isPublicStaticMediaType(mediaType), false, mediaType);
    }

    const responseCases = [
        ["status", { status: 404 }],
        ["media-type", { classification: { mediaType: "text/html", contentEncoding: "identity" } }],
        ["set-cookie", { headers: { "content-type": "image/png", "cache-control": "public", "set-cookie": "sid=1" } }],
        ["private", { headers: { "content-type": "image/png", "cache-control": "private" } }],
        ["no-store", { headers: { "content-type": "image/png", "cache-control": "public, no-store" } }],
        ["no-cache", { headers: { "content-type": "image/png", "cache-control": "public, no-cache" } }],
        ["not-explicitly-public", { headers: { "content-type": "image/png", "cache-control": "max-age=60" } }],
        ["age-invalid", { headers: { "content-type": "image/png", "cache-control": "public", age: "invalid" } }],
        ["zero-ttl", { headers: { "content-type": "image/png", "cache-control": "public, max-age=1.5" } }],
        ["vary-star", { headers: { "content-type": "image/png", "cache-control": "public", vary: "*" } }],
        ["vary-unsafe", { headers: { "content-type": "image/png", "cache-control": "public", vary: "Cookie" } }],
        ["attachment", { headers: { "content-type": "image/png", "cache-control": "public", "content-disposition": "attachment; filename=x.png" } }]
    ];
    for (const [reason, overrides] of responseCases) {
        assert.equal(evaluateCacheResponse(responseInput(config, valid, overrides)).reason, reason);
    }
    const agedConfig = cacheConfig({ ttlMs: 120_000 });
    const aged = evaluateCacheResponse(responseInput(agedConfig, valid, {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=120", age: "30" }
    }));
    assert.equal(aged.initialAgeSeconds, 30);
    assert.equal(aged.ttlMs, 90_000);
    assert.deepEqual(parseVary("Accept-Language, Accept-Encoding").names, ["accept-language", "accept-encoding"]);
});

test("public cache persists atomic entries and varies without storing target query data", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxyweb-cache-unit-"));
    const config = cacheConfig();
    const body = Buffer.from("console.log('cached');", "utf8");
    let cache = createPublicStaticCache({ directory });
    try {
        let request = cache.prepareRequest(requestInput(config));
        const responseSource = responseInput(config, request);
        const response = {
            ...cache.evaluateResponse(responseSource),
            headers: responseSource.headers,
            classification: responseSource.classification
        };
        assert.deepEqual(await storeBody(cache, request, response, config, body), {
            stored: true,
            reason: "stored"
        });
        assert.deepEqual((await cache.lookup(request, config)).body, body);
        assert.equal(await cache.lookup({ ...request, headers: { "accept-language": "en-US" } }, config), null);

        const files = await fs.readdir(directory);
        assert.equal(files.filter(name => name.endsWith(".pwc")).length, 1);
        const raw = await fs.readFile(path.join(directory, files.find(name => name.endsWith(".pwc"))));
        assert.equal(raw.includes(Buffer.from("v=1")), false);

        await cache.close();
        await fs.writeFile(path.join(directory, ".pwc-crash.tmp"), "partial", "utf8");
        cache = createPublicStaticCache({ directory });
        assert.deepEqual((await cache.lookup(request, config)).body, body);
        assert.equal((await fs.readdir(directory)).includes(".pwc-crash.tmp"), false);
    } finally {
        await cache.close();
        await removeCacheDirectory(directory);
    }
});

test("public cache expires, invalidates exact scopes and collapses concurrent leaders", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxyweb-cache-unit-"));
    let clock = 10_000;
    const config = cacheConfig({ ttlMs: 100 });
    const cache = createPublicStaticCache({ directory, now: () => clock });
    try {
        let request = cache.prepareRequest(requestInput(config));
        const responseSource = responseInput(config, request, {
            headers: { "content-type": "image/png", "cache-control": "public" },
            classification: { mediaType: "image/png", contentEncoding: "identity" }
        });
        const response = {
            ...cache.evaluateResponse(responseSource),
            headers: responseSource.headers,
            classification: responseSource.classification
        };
        await storeBody(cache, request, response, config, Buffer.from([1, 2, 3]));
        assert.ok(await cache.lookup(request, config));
        clock += 101;
        assert.equal(await cache.lookup(request, config), null);

        clock += 1;
        await storeBody(cache, request, response, config, Buffer.from([4, 5, 6]));
        assert.deepEqual(await cache.invalidate({
            hostname: "static.example.test",
            pathPrefix: "/assets/"
        }), { removed: 1 });
        assert.equal(await cache.lookup(request, config), null);

        assert.deepEqual(
            await storeBody(cache, request, response, config, Buffer.from([7, 8, 9])),
            { stored: false, reason: "invalidated" }
        );
        assert.equal(await cache.lookup(request, config), null);

        request = cache.prepareRequest(requestInput(config));
        await storeBody(cache, request, response, config, Buffer.from([7, 8, 9]));
        const firstSize = (await cache.stats(config)).totalBytes;
        config.browser.publicCache.maxBytes = firstSize + 64;
        clock += 1;
        const secondRequest = cache.prepareRequest(requestInput(config, {
            targetUrl: "https://static.example.test/assets/second.png"
        }));
        const secondSource = responseInput(config, secondRequest, {
            headers: { "content-type": "image/png", "cache-control": "public" },
            classification: { mediaType: "image/png", contentEncoding: "identity" }
        });
        const secondResponse = {
            ...cache.evaluateResponse(secondSource),
            headers: secondSource.headers,
            classification: secondSource.classification
        };
        await storeBody(cache, secondRequest, secondResponse, config, Buffer.from([10, 11, 12]));
        assert.equal(await cache.lookup(request, config), null);
        assert.ok(await cache.lookup(secondRequest, config));
        assert.equal((await cache.stats(config)).entries, 1);

        const leader = cache.acquire(request.baseHash);
        const follower = cache.acquire(request.baseHash);
        assert.equal(leader.leader, true);
        assert.equal(follower.leader, false);
        leader.complete({ stored: false, reason: "test" });
        assert.deepEqual(await follower.promise, { stored: false, reason: "test" });
    } finally {
        await cache.close();
        await removeCacheDirectory(directory);
    }
});

test("public cache representation version changes with rewrite and transform configuration", () => {
    const base = cacheConfig();
    const same = structuredClone(base);
    const rewriteChanged = cacheConfig();
    rewriteChanged.browser.rewriteCss = false;
    const transformChanged = cacheConfig();
    transformChanged.browser.responseTransform = {
        enabled: true,
        rules: [{ id: "v2", enabled: true }]
    };

    assert.equal(browserRepresentationVersion(base), browserRepresentationVersion(same));
    assert.notEqual(browserRepresentationVersion(base), browserRepresentationVersion(rewriteChanged));
    assert.notEqual(browserRepresentationVersion(base), browserRepresentationVersion(transformChanged));
});
