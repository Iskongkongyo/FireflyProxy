const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, test } = require("node:test");
const { toProxyUrl } = require("../../core/urlMapper");
const {
    LARGE_DOWNLOAD_BODY,
    MEDIA_BODY,
    SSE_FIRST_DELAY_MS,
    SSE_SECOND_DELAY_MS,
    createUpstreamFixture
} = require("../fixtures/upstream-server");
const { startProxy } = require("../helpers/proxy-process");

let fixture;
let proxy;

function modeUrl(mode, target) {
    return `${proxy.origin}/__proxyweb/${mode}?url=${encodeURIComponent(target)}`;
}

function browserUrl(target) {
    return new URL(toProxyUrl(target), proxy.origin).href;
}

function legacyUrl(target) {
    return `${proxy.origin}/?url=${encodeURIComponent(target)}`;
}

function timedRequest(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const request = http.get(url, { headers }, response => {
            const headersAt = Date.now();
            const chunks = [];
            response.on("data", chunk => chunks.push({ at: Date.now(), value: Buffer.from(chunk) }));
            response.once("end", () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks.map(chunk => chunk.value)),
                chunks,
                startedAt,
                headersAt,
                endedAt: Date.now()
            }));
            response.once("error", reject);
        });
        request.setTimeout(5000, () => request.destroy(new Error("timed request exceeded 5 seconds")));
        request.once("error", reject);
    });
}

function eventTime(result, text) {
    let body = "";
    for (const chunk of result.chunks) {
        body += chunk.value.toString("utf8");
        if (body.includes(text)) return chunk.at;
    }
    return null;
}

before(async () => {
    fixture = await createUpstreamFixture();
    proxy = await startProxy({
        browser: { enabled: true },
        security: { maxRewriteBytes: 32 }
    });
});

after(async () => {
    await proxy.close();
    await fixture.close();
});

test("SSE flushes headers and each event without waiting for stream completion", async () => {
    for (const url of [
        modeUrl("api", `${fixture.origin}/sse-delayed`),
        browserUrl(`${fixture.origin}/sse-delayed`)
    ]) {
        const result = await timedRequest(url);
        const firstAt = eventTime(result, "data: first\n\n");
        const secondAt = eventTime(result, "data: second\n\n");

        assert.equal(result.status, 200);
        assert.match(result.headers["content-type"], /^text\/event-stream\b/);
        assert.equal(result.headers["x-accel-buffering"], "no");
        assert.equal(result.body.toString("utf8"), "data: first\n\ndata: second\n\n");
        assert.ok(firstAt && secondAt);
        assert.ok(
            firstAt - result.headersAt >= SSE_FIRST_DELAY_MS - 100,
            `SSE headers were not flushed before the first event (${firstAt - result.headersAt}ms)`
        );
        assert.ok(
            secondAt - firstAt >= SSE_SECOND_DELAY_MS - 100,
            `SSE events were buffered together (${secondAt - firstAt}ms)`
        );
    }
});

test("API, Legacy and Browser Range responses preserve seek metadata and exact bytes", async () => {
    const start = 1_000_000;
    const end = 1_001_023;
    const target = `${fixture.origin}/media`;
    for (const [mode, url] of [
        ["api", modeUrl("api", target)],
        ["legacy", legacyUrl(target)],
        ["browser", browserUrl(target)]
    ]) {
        const response = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
        const body = Buffer.from(await response.arrayBuffer());

        assert.equal(response.status, 206, mode);
        assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${MEDIA_BODY.length}`, mode);
        assert.equal(response.headers.get("accept-ranges"), "bytes", mode);
        assert.equal(response.headers.get("content-length"), String(end - start + 1), mode);
        assert.equal(response.headers.get("content-type"), "video/mp4", mode);
        assert.equal(response.headers.get("etag"), '"fixture-media-etag"', mode);
        assert.deepEqual(body, MEDIA_BODY.subarray(start, end + 1), mode);
    }
});

test("open-ended and suffix media ranges retain correct HTTP semantics", async () => {
    const openStart = MEDIA_BODY.length - 257;
    const openEnded = await fetch(browserUrl(`${fixture.origin}/media`), {
        headers: { range: `bytes=${openStart}-` }
    });
    assert.equal(openEnded.status, 206);
    assert.equal(openEnded.headers.get("content-range"), `bytes ${openStart}-${MEDIA_BODY.length - 1}/${MEDIA_BODY.length}`);
    assert.equal(openEnded.headers.get("content-length"), "257");
    assert.deepEqual(Buffer.from(await openEnded.arrayBuffer()), MEDIA_BODY.subarray(openStart));

    const suffix = await fetch(browserUrl(`${fixture.origin}/media`), {
        headers: { range: "bytes=-128" }
    });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), `bytes ${MEDIA_BODY.length - 128}-${MEDIA_BODY.length - 1}/${MEDIA_BODY.length}`);
    assert.equal(suffix.headers.get("content-length"), "128");
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), MEDIA_BODY.subarray(-128));
});

test("large media and HTML attachments bypass the rewrite buffer and stream progressively", async () => {
    const media = await fetch(browserUrl(`${fixture.origin}/media`));
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("content-length"), String(MEDIA_BODY.length));
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), MEDIA_BODY);

    const download = await timedRequest(browserUrl(`${fixture.origin}/large-download-html`));
    assert.equal(download.status, 200);
    assert.equal(download.headers["content-disposition"], 'attachment; filename="large.html"');
    assert.equal(download.headers["content-length"], String(LARGE_DOWNLOAD_BODY.length));
    assert.equal(download.headers.etag, '"fixture-large-download-etag"');
    assert.deepEqual(download.body, LARGE_DOWNLOAD_BODY);
    assert.ok(download.chunks.length >= 2);
    assert.ok(
        download.endedAt - download.chunks[0].at >= 75,
        `large attachment was buffered before delivery (${download.endedAt - download.chunks[0].at}ms)`
    );
});
