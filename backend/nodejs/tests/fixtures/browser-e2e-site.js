const http = require("node:http");

const PNG_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
);
const FONT_BYTES = Buffer.from("d09GMgABAAAAAAAsAAoAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64");
const MEDIA_BYTES = Buffer.from("proxyweb-e2e-media-range-payload", "utf8");
const DOWNLOAD_BYTES = Buffer.from("proxyWeb browser download fixture\n", "utf8");

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", chunk => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks)));
        request.on("error", reject);
    });
}

function send(response, status, body, headers = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    response.writeHead(status, {
        "content-length": payload.length,
        ...headers
    });
    response.end(payload);
}

function sendHtml(response, html, status = 200, headers = {}) {
    send(response, status, html, {
        "content-type": "text/html; charset=utf-8",
        ...headers
    });
}

function parseRange(value, size) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(value || "");
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
        return null;
    }
    return { start, end: Math.min(end, size - 1) };
}

function pageHtml(port) {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>proxyWeb P1 fixture</title>
    <link id="base-css" rel="stylesheet" href="/assets/base.css">
    <link id="theme-css" rel="stylesheet" href="/assets/theme.css">
</head>
<body>
    <main id="static-page" class="hero">Browser Core fixture</main>
    <img id="local-image" src="/assets/local.png" alt="local">
    <img id="second-image" src="/assets/second.png" alt="second">
    <img id="cdn-image" src="http://cdn.test:${port}/assets/cdn.png" alt="cdn">
    <script id="cdn-script" src="http://cdn.test:${port}/assets/app.js"></script>

    <a id="navigation" target="_blank" href="/link-result">link</a>
    <a id="ssr-link" target="_blank" href="/ssr?name=Browser">ssr</a>
    <a id="protected-link" target="_blank" href="/protected">protected</a>
    <a id="download" href="/download/report.txt" download>download</a>
    <a id="media" href="/media/sample.mp4">media</a>
    <a id="sse" href="/events">events</a>

    <form id="get-form" target="_blank" method="get" action="/form/result">
        <input name="term" value="browser get">
        <button type="submit">GET</button>
    </form>
    <form id="post-form" target="_blank" method="post" action="/form/result">
        <input name="message" value="browser post">
        <button type="submit">POST</button>
    </form>

    <script>
        window.__e2e = { sse: [] };
        const events = new EventSource(document.querySelector("#sse").href);
        events.onmessage = event => {
            window.__e2e.sse.push(event.data);
            if (window.__e2e.sse.length === 2) events.close();
        };
        events.onerror = () => { window.__e2e.sseError = true; };
    </script>
</body>
</html>`;
}

async function handleRequest(request, response, port) {
    const url = new URL(request.url, `http://${request.headers.host || "fixture.test"}`);

    if (url.pathname === "/site") return sendHtml(response, pageHtml(port));
    if (url.pathname === "/ssr") {
        return sendHtml(response, `<!doctype html><html><body><output id="ssr-result">SSR:${url.searchParams.get("name") || "guest"}</output></body></html>`);
    }
    if (url.pathname === "/link-result") {
        return sendHtml(response, "<!doctype html><html><body><output id=\"link-result\">linked</output></body></html>");
    }
    if (url.pathname === "/assets/base.css") {
        return send(response, 200, `@font-face { font-family: ProxyFixture; src: url("/assets/site.woff2") format("woff2"); }
body { font-family: ProxyFixture, sans-serif; }
.hero { color: rgb(12, 34, 56); background-image: url("/assets/background.png"); }`, {
            "content-type": "text/css; charset=utf-8"
        });
    }
    if (url.pathname === "/assets/theme.css") {
        return send(response, 200, `.hero { border-top: 3px solid rgb(7, 8, 9); }
.hero::after { content: "theme-loaded"; }`, {
            "content-type": "text/css; charset=utf-8"
        });
    }
    if (["/assets/local.png", "/assets/second.png", "/assets/cdn.png", "/assets/background.png"].includes(url.pathname)) {
        return send(response, 200, PNG_BYTES, { "content-type": "image/png", "cache-control": "no-store" });
    }
    if (url.pathname === "/assets/site.woff2") {
        return send(response, 200, FONT_BYTES, { "content-type": "font/woff2", "cache-control": "no-store" });
    }
    if (url.pathname === "/assets/app.js") {
        return send(response, 200, "window.__cdnScriptLoaded = document.currentScript.src;", {
            "content-type": "application/javascript; charset=utf-8"
        });
    }
    if (url.pathname === "/form/result") {
        const body = await readBody(request);
        const value = request.method === "GET" ? url.searchParams.get("term") : body.toString("utf8");
        return sendHtml(response, `<!doctype html><html><body><output id="form-result" data-method="${request.method}">${value}</output></body></html>`);
    }
    if (url.pathname === "/protected") {
        if ((request.headers.cookie || "").includes("browserAuth=granted")) {
            return sendHtml(response, "<!doctype html><html><body><output id=\"account\">session-active</output></body></html>");
        }
        response.writeHead(302, { location: "/login-page" });
        return response.end();
    }
    if (url.pathname === "/login-page") {
        return sendHtml(response, `<!doctype html><html><body>
            <output id="login-page">login-required</output>
            <form id="login-form" method="post" action="/login">
                <input name="username" value="fixture-user">
                <button type="submit">Login</button>
            </form>
        </body></html>`);
    }
    if (url.pathname === "/login" && request.method === "POST") {
        await readBody(request);
        response.writeHead(302, {
            location: "/protected",
            "set-cookie": "browserAuth=granted; Path=/; HttpOnly; SameSite=Lax"
        });
        return response.end();
    }
    if (url.pathname === "/events") {
        response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive"
        });
        response.write("data: first\n\n");
        return setTimeout(() => response.end("data: second\n\n"), 30);
    }
    if (url.pathname === "/media/sample.mp4") {
        const range = parseRange(request.headers.range, MEDIA_BYTES.length);
        if (request.headers.range && !range) {
            response.writeHead(416, { "content-range": `bytes */${MEDIA_BYTES.length}` });
            return response.end();
        }
        if (range) {
            const part = MEDIA_BYTES.subarray(range.start, range.end + 1);
            return send(response, 206, part, {
                "content-type": "video/mp4",
                "accept-ranges": "bytes",
                "content-range": `bytes ${range.start}-${range.end}/${MEDIA_BYTES.length}`
            });
        }
        return send(response, 200, MEDIA_BYTES, {
            "content-type": "video/mp4",
            "accept-ranges": "bytes"
        });
    }
    if (url.pathname === "/download/report.txt") {
        return send(response, 200, DOWNLOAD_BYTES, {
            "content-type": "application/octet-stream",
            "content-disposition": "attachment; filename=report.txt"
        });
    }
    return sendHtml(response, "<!doctype html><html><body>not found</body></html>", 404);
}

async function createBrowserE2eFixture() {
    const server = http.createServer((request, response) => {
        const address = server.address();
        handleRequest(request, response, address.port).catch(error => {
            if (!response.headersSent) sendHtml(response, error.message, 500);
            else response.destroy(error);
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    return {
        server,
        port,
        origin: `http://fixture.test:${port}`,
        cdnOrigin: `http://cdn.test:${port}`,
        close: () => new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        })
    };
}

module.exports = {
    DOWNLOAD_BYTES,
    FONT_BYTES,
    MEDIA_BYTES,
    PNG_BYTES,
    createBrowserE2eFixture
};
