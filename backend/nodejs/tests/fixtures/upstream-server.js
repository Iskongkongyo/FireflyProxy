const http = require("node:http");

const RANGE_BODY = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz", "utf8");

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

function parseRange(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value || "");
    if (!match) return null;

    const start = match[1] === "" ? 0 : Number(match[1]);
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

    if (url.pathname === "/security-headers") {
        return sendJson(res, 200, { secured: true }, {
            "x-frame-options": "DENY",
            "content-security-policy": "default-src 'none'"
        });
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
                "content-type": "application/octet-stream"
            });
            return res.end(part);
        }

        res.writeHead(200, {
            "accept-ranges": "bytes",
            "content-length": RANGE_BODY.length,
            "content-type": "application/octet-stream"
        });
        return res.end(RANGE_BODY);
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
    RANGE_BODY,
    createUpstreamFixture
};
