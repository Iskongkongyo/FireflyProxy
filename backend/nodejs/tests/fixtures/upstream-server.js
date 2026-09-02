const http = require("node:http");
const { gzipSync } = require("node:zlib");

const RANGE_BODY = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz", "utf8");
const MEDIA_BODY = Buffer.allocUnsafe(2 * 1024 * 1024 + 333);
const LARGE_DOWNLOAD_BODY = Buffer.alloc(512 * 1024 + 17, "d");
const SSE_FIRST_DELAY_MS = 200;
const SSE_SECOND_DELAY_MS = 200;
const CACHE_REQUEST_COUNTS = new Map();
for (let index = 0; index < MEDIA_BODY.length; index += 1) MEDIA_BODY[index] = (index * 31) % 251;

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function sendJson(res, status, value, headers = {}) {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": body.length,
        ...headers
    });
    res.end(body);
}

function nextCacheCount(key) {
    const count = (CACHE_REQUEST_COUNTS.get(key) || 0) + 1;
    CACHE_REQUEST_COUNTS.set(key, count);
    return count;
}

function parseRange(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value || "");
    if (!match || (!match[1] && !match[2])) return null;

    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
        return { start: Math.max(size - suffixLength, 0), end: size - 1 };
    }

    const start = Number(match[1]);
    const end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
        return null;
    }

    return { start, end: Math.min(end, size - 1) };
}

async function handleRequest(req, res) {
    const url = new URL(req.url, "http://fixture.test");

    if (url.pathname === "/json") {
        return sendJson(res, 200, {
            ok: true,
            method: req.method,
            query: Object.fromEntries(url.searchParams)
        }, { "x-fixture": "json" });
    }

    if (url.pathname === "/cors-headers") {
        return sendJson(res, 200, { cors: "upstream" }, {
            "access-control-allow-origin": "*",
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "GET, POST",
            "access-control-allow-headers": "x-upstream-only",
            "access-control-expose-headers": "x-upstream-policy-only",
            "access-control-max-age": "86400",
            vary: "Accept-Encoding",
            "x-upstream-secret": "fixture"
        });
    }

    if (url.pathname === "/cache/stats") {
        return sendJson(res, 200, Object.fromEntries(CACHE_REQUEST_COUNTS));
    }

    if (url.pathname === "/cache/public.js") {
        const language = String(req.headers["accept-language"] || "none");
        const key = `public:${language}:${url.search}`;
        const count = nextCacheCount(key);
        const body = Buffer.from(`window.__publicCache = ${JSON.stringify({ language, count })};`, "utf8");
        const send = () => {
            const headers = {
                "content-type": "application/javascript; charset=utf-8",
                "content-length": body.length,
                "cache-control": "public, max-age=120",
                vary: "Accept-Language",
                "x-fixture-cache-count": String(count)
            };
            if (url.searchParams.has("age")) headers.age = url.searchParams.get("age");
            res.writeHead(200, headers);
            res.end(body);
        };
        return url.searchParams.has("delay") ? setTimeout(send, 120) : send();
    }

    if (url.pathname === "/cache/public.css") {
        const count = nextCacheCount("css");
        const body = Buffer.from(`.cached-${count}{background:url('/cache/public.png?case=css')}`, "utf8");
        res.writeHead(200, {
            "content-type": "text/css; charset=utf-8",
            "content-length": body.length,
            "cache-control": "public, max-age=120",
            "x-fixture-cache-count": String(count)
        });
        return res.end(body);
    }

    if (url.pathname === "/cache/private.js") {
        const count = nextCacheCount("private");
        const body = Buffer.from(`window.__privateCache = ${count};`, "utf8");
        res.writeHead(200, {
            "content-type": "application/javascript; charset=utf-8",
            "content-length": body.length,
            "cache-control": "public, max-age=120",
            "set-cookie": `privateSession=${count}; Path=/; HttpOnly`,
            "x-fixture-cache-count": String(count)
        });
        return res.end(body);
    }

    if (url.pathname === "/cache/no-store.js") {
        const count = nextCacheCount("no-store");
        const body = Buffer.from(`window.__noStoreCache = ${count};`, "utf8");
        res.writeHead(200, {
            "content-type": "application/javascript; charset=utf-8",
            "content-length": body.length,
            "cache-control": "public, no-store",
            "x-fixture-cache-count": String(count)
        });
        return res.end(body);
    }

    if (url.pathname === "/cache/public.html") {
        const count = nextCacheCount("html");
        const body = Buffer.from(`<!doctype html><html><body>${count}</body></html>`, "utf8");
        res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": body.length,
            "cache-control": "public, max-age=120",
            "x-fixture-cache-count": String(count)
        });
        return res.end(body);
    }

    if (url.pathname === "/cache/public.png") {
        const count = nextCacheCount(`image:${url.search}`);
        const size = Math.min(Math.max(Number(url.searchParams.get("size")) || 64, 1), 1024 * 1024);
        const body = Buffer.alloc(size, count % 251);
        const headers = {
            "content-type": "image/png",
            "cache-control": "public, max-age=120",
            "x-fixture-cache-count": String(count)
        };
        if (!url.searchParams.has("chunked")) headers["content-length"] = body.length;
        res.writeHead(200, headers);
        if (url.searchParams.has("chunked")) {
            res.write(body.subarray(0, Math.floor(body.length / 2)));
            return setTimeout(() => res.end(body.subarray(Math.floor(body.length / 2))), 20);
        }
        return res.end(body);
    }

    if (url.pathname === "/security-headers") {
        return sendJson(res, 200, { secured: true }, {
            "x-frame-options": "DENY",
            "content-security-policy": "default-src 'none'",
            "content-security-policy-report-only": "default-src 'self'",
            "cross-origin-resource-policy": "same-origin",
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-embedder-policy": "require-corp",
            "clear-site-data": "\"cache\""
        });
    }

    if (url.pathname === "/cookie/set") {
        return sendJson(res, 200, { cookiesSet: true }, {
            "set-cookie": [
                "hostOnly=alpha; Path=/; HttpOnly; SameSite=Lax",
                "scoped=inside; Path=/cookie/scoped; HttpOnly",
                "secureOnly=tls; Path=/; Secure; HttpOnly",
                "expired=gone; Path=/; Max-Age=0"
            ]
        });
    }

    if (url.pathname === "/cookie/echo" || url.pathname === "/cookie/scoped/echo") {
        return sendJson(res, 200, {
            cookie: req.headers.cookie || "",
            host: req.headers.host,
            origin: req.headers.origin || "",
            referer: req.headers.referer || ""
        });
    }

    if (url.pathname === "/html") {
        const body = Buffer.from("<!doctype html><html><body>pipeline</body></html>", "utf8");
        res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": body.length,
            etag: '"fixture-html-etag"',
            "content-md5": "fixture-html-md5",
            "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT"
        });
        return res.end(body);
    }

    if (url.pathname === "/html-relative") {
        const port = String(req.headers.host || "").split(":").pop();
        const body = Buffer.from(`<!doctype html><html><head>
            <base href="/assets/">
            <link id="stylesheet" href="site.css" rel="stylesheet">
            <meta http-equiv="refresh" content="0; url=/landing">
            <style id="inline-sheet">.banner { background-image: url('inline-banner.png'); }</style>
        </head><body>
            <a id="navigation" href="/json?via=html#result">Next</a>
            <script id="script" src="app.js"></script>
            <img id="image" src="logo.png" srcset="small.png 1x, //cdn.test:${port}/large.png 2x">
            <form id="form" action="/echo" method="post"></form>
            <iframe id="frame" src="frame.html"></iframe>
            <div id="styled" style="background-image: url('background.png')"></div>
            <a id="email" href="mailto:test@example.com">Email</a>
        </body></html>`, "utf8");
        res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": body.length,
            etag: '"fixture-html-rewrite-etag"'
        });
        return res.end(body);
    }

    if (url.pathname === "/css" || url.pathname === "/styles/components/main.css") {
        const port = String(req.headers.host || "").split(":").pop();
        const body = Buffer.from(`@import "theme/base.css" screen;
.hero { background-image: url("../../images/hero.png"); }
.icon { mask-image: url("//cdn.test:${port}/icons.svg#check"); }
@font-face { src: url('/fonts/site.woff2') format('woff2'); }
.embedded { background-image: url(data:image/png;base64,AAAA); }`, "utf8");
        res.writeHead(200, {
            "content-type": "text/css; charset=utf-8",
            "content-length": body.length,
            etag: '"fixture-css-rewrite-etag"'
        });
        return res.end(body);
    }

    if (url.pathname === "/gzip-html") {
        const body = Buffer.from("<!doctype html><html><body>compressed</body></html>", "utf8");
        const compressed = gzipSync(body);
        res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-encoding": "gzip",
            "content-length": compressed.length,
            etag: '"fixture-gzip-etag"',
            "content-md5": "fixture-gzip-md5"
        });
        return res.end(compressed);
    }

    if (url.pathname === "/large-html") {
        const size = Math.min(Math.max(Number(url.searchParams.get("size")) || 1024, 1), 1024 * 1024);
        const body = Buffer.alloc(size, "h");
        res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": body.length
        });
        return res.end(body);
    }

    if (url.pathname === "/sse") {
        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            etag: '"fixture-sse-etag"'
        });
        res.write("data: first\n\n");
        return setTimeout(() => res.end("data: second\n\n"), 10);
    }

    if (url.pathname === "/sse-delayed") {
        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache"
        });
        res.flushHeaders();
        return setTimeout(() => {
            res.write("data: first\n\n");
            setTimeout(() => res.end("data: second\n\n"), SSE_SECOND_DELAY_MS);
        }, SSE_FIRST_DELAY_MS);
    }

    if (url.pathname === "/echo") {
        const body = await readBody(req);
        return sendJson(res, 200, {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body.toString("utf8")
        });
    }

    if (url.pathname.startsWith("/status/")) {
        const status = Number(url.pathname.slice("/status/".length));
        return sendJson(res, status, { status });
    }

    if (url.pathname === "/redirect") {
        res.writeHead(302, { location: "/json?via=redirect" });
        return res.end();
    }

    if (url.pathname === "/diagnostic-spoof") {
        return sendJson(res, 200, { ok: true }, {
            "x-proxyweb-final-url": "attacker-controlled",
            "x-proxyweb-redirect-chain": "attacker-controlled"
        });
    }

    if (url.pathname === "/redirect-to") {
        await readBody(req);
        const status = Number(url.searchParams.get("status") || 302);
        const location = url.searchParams.get("location") || "/json?via=redirect-to";
        res.writeHead(status, { location });
        return res.end();
    }

    if (url.pathname === "/redirect-early") {
        res.writeHead(307, { location: "/echo" });
        return res.end();
    }

    if (url.pathname === "/redirect-loop-a") {
        res.writeHead(302, { location: "/redirect-loop-b" });
        return res.end();
    }

    if (url.pathname === "/redirect-loop-b") {
        res.writeHead(302, { location: "/redirect-loop-a" });
        return res.end();
    }

    if (url.pathname.startsWith("/redirect-chain/")) {
        const remaining = Number(url.pathname.slice("/redirect-chain/".length));
        if (Number.isInteger(remaining) && remaining > 0) {
            res.writeHead(302, { location: `/redirect-chain/${remaining - 1}` });
            return res.end();
        }
        return sendJson(res, 200, { redirected: true, remaining: 0 });
    }

    if (url.pathname === "/stream") {
        res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "transfer-encoding": "chunked"
        });
        res.write("chunk-1|");
        setTimeout(() => {
            res.write("chunk-2|");
            res.end("chunk-3");
        }, 10);
        return;
    }

    if (url.pathname === "/bytes") {
        const size = Math.min(Math.max(Number(url.searchParams.get("size")) || 1024, 1), 1024 * 1024);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(Math.min(size, 16384), "x");
        let remaining = size;
        while (remaining > 0) {
            const length = Math.min(remaining, chunk.length);
            res.write(chunk.subarray(0, length));
            remaining -= length;
        }
        return res.end();
    }

    if (url.pathname === "/abrupt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial-response");
        return setTimeout(() => res.socket.destroy(), 10);
    }

    if (url.pathname === "/malformed-length") {
        res.writeHead(200, {
            "content-type": "text/plain",
            "content-length": 128
        });
        return res.end("short");
    }

    if (url.pathname === "/range") {
        const range = parseRange(req.headers.range, RANGE_BODY.length);
        if (!range && req.headers.range) {
            res.writeHead(416, { "content-range": `bytes */${RANGE_BODY.length}` });
            return res.end();
        }

        if (range) {
            const part = RANGE_BODY.subarray(range.start, range.end + 1);
            res.writeHead(206, {
                "accept-ranges": "bytes",
                "content-range": `bytes ${range.start}-${range.end}/${RANGE_BODY.length}`,
                "content-length": part.length,
                "content-type": "application/octet-stream",
                etag: '"fixture-range-etag"'
            });
            return res.end(part);
        }

        res.writeHead(200, {
            "accept-ranges": "bytes",
            "content-length": RANGE_BODY.length,
            "content-type": "application/octet-stream",
            etag: '"fixture-range-etag"'
        });
        return res.end(RANGE_BODY);
    }

    if (url.pathname === "/media") {
        const range = parseRange(req.headers.range, MEDIA_BODY.length);
        if (!range && req.headers.range) {
            res.writeHead(416, {
                "accept-ranges": "bytes",
                "content-range": `bytes */${MEDIA_BODY.length}`
            });
            return res.end();
        }
        if (range) {
            const part = MEDIA_BODY.subarray(range.start, range.end + 1);
            res.writeHead(206, {
                "accept-ranges": "bytes",
                "content-range": `bytes ${range.start}-${range.end}/${MEDIA_BODY.length}`,
                "content-length": part.length,
                "content-type": "video/mp4",
                etag: '"fixture-media-etag"'
            });
            return res.end(part);
        }
        res.writeHead(200, {
            "accept-ranges": "bytes",
            "content-length": MEDIA_BODY.length,
            "content-type": "video/mp4",
            etag: '"fixture-media-etag"'
        });
        return res.end(MEDIA_BODY);
    }

    if (url.pathname === "/large-download-html") {
        const firstChunkSize = 16384;
        res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-disposition": 'attachment; filename="large.html"',
            "content-length": LARGE_DOWNLOAD_BODY.length,
            etag: '"fixture-large-download-etag"'
        });
        res.write(LARGE_DOWNLOAD_BODY.subarray(0, firstChunkSize));
        return setTimeout(() => res.end(LARGE_DOWNLOAD_BODY.subarray(firstChunkSize)), 150);
    }

    if (url.pathname === "/slow") {
        const delayMs = Math.min(Number(url.searchParams.get("ms")) || 50, 1000);
        return setTimeout(() => sendJson(res, 200, { delayMs }), delayMs);
    }

    return sendJson(res, 404, { error: "fixture_not_found", path: url.pathname });
}

async function createUpstreamFixture() {
    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch(error => {
            sendJson(res, 500, { error: error.message });
        });
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    return {
        server,
        port: address.port,
        origin: `http://fixture.test:${address.port}`,
        localOrigin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        })
    };
}

module.exports = {
    LARGE_DOWNLOAD_BODY,
    MEDIA_BODY,
    RANGE_BODY,
    SSE_FIRST_DELAY_MS,
    SSE_SECOND_DELAY_MS,
    createUpstreamFixture
};
