const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const {
    brotliCompressSync,
    brotliDecompressSync,
    deflateSync,
    gunzipSync,
    gzipSync,
    inflateSync
} = require("node:zlib");
const {
    classifyResponse,
    parseContentType,
    prepareResponse
} = require("../../core/responsePipeline");

const config = {
    security: { maxRewriteBytes: 1024 },
    browser: { rewriteHtml: true, rewriteCss: true }
};
const logger = { info() {}, warn() {} };

async function readAll(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

test("content type parsing and response classification separate transform from streaming media", () => {
    assert.deepEqual(parseContentType("Text/HTML; profile=test; charset=GBK"), {
        raw: "Text/HTML; profile=test; charset=GBK",
        mediaType: "text/html",
        charset: "gbk"
    });
    assert.equal(classifyResponse({
        mode: "browser",
        method: "GET",
        status: 200,
        headers: { "content-type": "text/html" },
        config
    }).kind, "transform");
    for (const mediaType of ["text/event-stream", "video/mp4", "audio/mpeg", "application/pdf", "application/octet-stream"]) {
        assert.equal(classifyResponse({
            mode: "browser",
            method: "GET",
            status: 200,
            headers: { "content-type": mediaType },
            config
        }).kind, "stream", mediaType);
    }
    for (const headers of [
        { "content-type": "text/html", "content-range": "bytes 0-9/20" },
        { "content-type": "text/html", "content-disposition": "attachment; filename=page.html" },
        { "content-type": "text/html", "cache-control": "public, no-transform" }
    ]) {
        assert.equal(classifyResponse({
            mode: "browser",
            method: "GET",
            status: headers["content-range"] ? 206 : 200,
            headers,
            config
        }).kind, "stream");
    }
    assert.equal(classifyResponse({
        mode: "browser",
        method: "GET",
        status: 200,
        headers: { "content-type": "text/html" },
        config: { ...config, browser: { ...config.browser, rewriteHtml: false } }
    }).kind, "stream");
});

test("identity HTML is decoded as declared charset, transformed and emitted as UTF-8", async () => {
    const source = Readable.from([Buffer.from([0x63, 0x61, 0x66, 0xe9])]);
    const prepared = await prepareResponse({
        body: source,
        headers: {
            "content-type": "text/html; charset=windows-1252",
            "content-length": "4",
            etag: '"old"',
            "content-md5": "old-md5"
        },
        method: "GET",
        status: 200,
        mode: "browser",
        config,
        targetUrl: "https://example.test/",
        transformText: ({ text }) => `${text}!`,
        logger
    });

    assert.equal((await readAll(prepared.body)).toString("utf8"), "café!");
    assert.equal(prepared.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(prepared.headers["content-length"], undefined);
    assert.equal(prepared.headers.etag, undefined);
    assert.equal(prepared.headers["content-md5"], undefined);
    assert.equal(prepared.transformed, true);
});

test("gzip, deflate and br HTML are decompressed, bounded and recompressed", async () => {
    const encodings = [
        ["gzip", gzipSync, gunzipSync],
        ["deflate", deflateSync, inflateSync],
        ["br", brotliCompressSync, brotliDecompressSync]
    ];
    for (const [encoding, compress, decompress] of encodings) {
        const source = Readable.from([compress(Buffer.from("<p>before</p>"))]);
        const prepared = await prepareResponse({
            body: source,
            headers: {
                "content-type": "text/html; charset=utf-8",
                "content-encoding": encoding,
                "content-length": "32",
                etag: '"compressed"'
            },
            method: "GET",
            status: 200,
            mode: "browser",
            config,
            targetUrl: "https://example.test/",
            transformText: ({ text }) => text.replace("before", "after"),
            logger
        });
        const output = await readAll(prepared.body);

        assert.equal(decompress(output).toString("utf8"), "<p>after</p>", encoding);
        assert.equal(prepared.headers["content-encoding"], encoding);
        assert.equal(prepared.headers["content-length"], undefined);
        assert.equal(prepared.headers.etag, undefined);
    }
});

test("rewrite limits apply to decoded bytes and return a stable 413 error", async () => {
    const compressed = gzipSync(Buffer.alloc(2048, "x"));
    await assert.rejects(
        prepareResponse({
            body: Readable.from([compressed]),
            headers: { "content-type": "text/css", "content-encoding": "gzip" },
            method: "GET",
            status: 200,
            mode: "browser",
            config,
            targetUrl: "https://example.test/large.css",
            transformText: ({ text }) => text,
            logger
        }),
        error => error.code === "PROXY_REWRITE_LIMIT" && error.statusCode === 413
    );
});

test("binary and unsupported encodings remain byte-identical passthrough streams", async () => {
    for (const [contentType, contentEncoding] of [
        ["application/octet-stream", undefined],
        ["text/html", "zstd"],
        ["text/html; charset=unsupported-charset", undefined]
    ]) {
        const body = Buffer.from("raw-passthrough");
        const prepared = await prepareResponse({
            body: Readable.from([body]),
            headers: {
                "content-type": contentType,
                ...(contentEncoding ? { "content-encoding": contentEncoding } : {}),
                "content-length": String(body.length),
                etag: '"keep"'
            },
            method: "GET",
            status: 200,
            mode: "browser",
            config,
            targetUrl: "https://example.test/resource",
            transformText: ({ text }) => `${text}!`,
            logger
        });

        assert.deepEqual(await readAll(prepared.body), body);
        assert.equal(prepared.headers["content-length"], String(body.length));
        assert.equal(prepared.headers.etag, '"keep"');
        assert.equal(prepared.transformed, false);
        assert.equal(prepared.preserveContentLength, true);
    }
});

test("malformed supported compression fails closed before response headers", async () => {
    await assert.rejects(
        prepareResponse({
            body: Readable.from([Buffer.from("not-gzip")]),
            headers: { "content-type": "text/html", "content-encoding": "gzip" },
            method: "GET",
            status: 200,
            mode: "browser",
            config,
            targetUrl: "https://example.test/broken",
            transformText: ({ text }) => text,
            logger
        }),
        error => error.code === "PROXY_UPSTREAM_ERROR" && error.statusCode === 502
    );
});
