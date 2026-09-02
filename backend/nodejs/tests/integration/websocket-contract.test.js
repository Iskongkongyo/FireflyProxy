const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { after, before, test } = require("node:test");
const { WebSocket, WebSocketServer } = require("ws");
const { createWebSocketOriginContext } = require("../../browser-proxy/webSocketUrl");
const { toProxyUrl } = require("../../core/urlMapper");
const { createUpstreamFixture } = require("../fixtures/upstream-server");
const { startProxy } = require("../helpers/proxy-process");

const SESSION_SECRET = "proxyweb-websocket-contract-secret";
let fixture;
let upstreamServer;
let upstreamWss;
let upstreamPort;

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
}

function closeServer(server) {
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function fireflyProxyWebSocketUrl(proxyOrigin, target) {
    const url = new URL(toProxyUrl(target), proxyOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
}

async function rejectedUpgradeStatus(url, options = {}) {
    return new Promise((resolve, reject) => {
        const client = new WebSocket(url, options);
        client.once("unexpected-response", (request, response) => {
            const status = response.statusCode;
            response.resume();
            resolve(status);
        });
        client.once("open", () => {
            client.terminate();
            reject(new Error("Expected the WebSocket upgrade to be rejected"));
        });
        client.once("error", () => {});
    });
}

before(async () => {
    fixture = await createUpstreamFixture();
    upstreamServer = http.createServer((request, response) => {
        response.writeHead(426, { connection: "close" });
        response.end();
    });
    upstreamWss = new WebSocketServer({
        server: upstreamServer,
        perMessageDeflate: false,
        handleProtocols: protocols => protocols.has("chat") ? "chat" : false
    });
    upstreamWss.on("connection", (socket, request) => {
        if (request.url.startsWith("/socket")) {
        socket.send(JSON.stringify({
            authorization: request.headers.authorization || "",
            cookie: request.headers.cookie || "",
                origin: request.headers.origin || "",
                protocolHeader: request.headers["sec-websocket-protocol"] || "",
                url: request.url
            }));
            socket.ping("proxyweb-ping");
        }
        let messages = 0;
        socket.on("message", (data, isBinary) => {
            messages += 1;
            socket.send(data, { binary: isBinary });
            if (messages === 2) setTimeout(() => socket.close(4001, "fixture-done"), 10);
        });
    });
    await listen(upstreamServer);
    upstreamPort = upstreamServer.address().port;
});

after(async () => {
    for (const client of upstreamWss.clients) client.terminate();
    await closeServer(upstreamServer);
    await fixture.close();
});

test("WebSocket proxy preserves text, binary, subprotocol, close code, Cookie Jar and source Origin", async () => {
    const proxy = await startProxy({
        session: { secret: SESSION_SECRET },
        browser: {
            enabled: true,
            runtimeBridge: true,
            webSocket: true,
            webSocketIdleTimeoutMs: 2000
        }
    });
    try {
        const entry = new URL("/__proxyweb/browser", proxy.origin);
        entry.searchParams.set("url", `${fixture.origin}/cookie/set`);
        entry.searchParams.set("webSocket", "true");
        const entryResponse = await fetch(entry, { redirect: "manual" });
        const sessionCookie = entryResponse.headers.get("set-cookie").split(";", 1)[0];
        await fetch(new URL(entryResponse.headers.get("location"), proxy.origin), {
            headers: { cookie: sessionCookie }
        });

        const sourceOrigin = fixture.origin;
        const marker = createWebSocketOriginContext(sourceOrigin, SESSION_SECRET);
        const client = new WebSocket(
            fireflyProxyWebSocketUrl(proxy.origin, `http://fixture.test:${upstreamPort}/socket?q=1`),
            ["chat", marker],
            {
                origin: proxy.origin,
                headers: { cookie: sessionCookie },
                perMessageDeflate: false
            }
        );
        const messages = [];
        client.on("message", (data, isBinary) => messages.push({ data: Buffer.from(data), isBinary }));
        await once(client, "open");
        assert.equal(client.protocol, "chat");
        client.send("hello");
        client.send(Buffer.from([0, 1, 2, 255]));
        const [code, reason] = await once(client, "close");

        assert.equal(code, 4001);
        assert.equal(reason.toString(), "fixture-done");
        assert.equal(messages.length, 3);
        const metadata = JSON.parse(messages[0].data.toString("utf8"));
        assert.equal(metadata.origin, sourceOrigin);
        assert.equal(metadata.authorization, "");
        assert.equal(metadata.cookie, "hostOnly=alpha");
        assert.equal(metadata.protocolHeader, "chat");
        assert.equal(metadata.url, "/socket?q=1");
        assert.equal(messages[1].isBinary, false);
        assert.equal(messages[1].data.toString(), "hello");
        assert.equal(messages[2].isBinary, true);
        assert.deepEqual([...messages[2].data], [0, 1, 2, 255]);
    } finally {
        await proxy.close();
    }
});

test("WebSocket Upgrade enforces proxy Basic Auth without forwarding credentials", async () => {
    const proxy = await startProxy({
        user: "proxy-user",
        pwd: "proxy-pass",
        browser: { enabled: true, webSocket: true }
    });
    const url = fireflyProxyWebSocketUrl(proxy.origin, `http://fixture.test:${upstreamPort}/socket?auth=1`);
    try {
        assert.equal(await rejectedUpgradeStatus(url, { origin: proxy.origin }), 401);

        const client = new WebSocket(url, {
            origin: proxy.origin,
            headers: {
                authorization: `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`
            }
        });
        const message = once(client, "message");
        await once(client, "open");
        const [data] = await message;
        assert.equal(JSON.parse(data.toString()).authorization, "");
        client.terminate();
    } finally {
        await proxy.close();
    }
});

test("WebSocket connection limit includes established and pending Upgrade work", async () => {
    const proxy = await startProxy({
        browser: {
            enabled: true,
            webSocket: true,
            webSocketIdleTimeoutMs: 2000,
            webSocketMaxConnections: 1
        }
    });
    const url = fireflyProxyWebSocketUrl(proxy.origin, `http://fixture.test:${upstreamPort}/hold`);
    try {
        const first = new WebSocket(url, { origin: proxy.origin });
        await once(first, "open");
        assert.equal(await rejectedUpgradeStatus(url, { origin: proxy.origin }), 503);
        first.terminate();
    } finally {
        await proxy.close();
    }
});

test("WebSocket Upgrade fails closed for disabled capability, foreign Origin and SSRF targets", async () => {
    const disabled = await startProxy({ browser: { enabled: true, webSocket: false } });
    try {
        assert.equal(await rejectedUpgradeStatus(
            fireflyProxyWebSocketUrl(disabled.origin, `http://fixture.test:${upstreamPort}/socket`),
            { origin: disabled.origin }
        ), 404);
    } finally {
        await disabled.close();
    }

    const enabled = await startProxy({
        session: { secret: SESSION_SECRET },
        browser: { enabled: true, webSocket: true }
    });
    try {
        const entry = new URL("/__proxyweb/browser", enabled.origin);
        entry.searchParams.set("url", fixture.origin);
        entry.searchParams.set("webSocket", "false");
        const entryResponse = await fetch(entry, { redirect: "manual" });
        const tightenedSession = entryResponse.headers.get("set-cookie").split(";", 1)[0];
        assert.equal(await rejectedUpgradeStatus(
            fireflyProxyWebSocketUrl(enabled.origin, `http://fixture.test:${upstreamPort}/socket`),
            { origin: enabled.origin, headers: { cookie: tightenedSession } }
        ), 404);
        assert.equal(await rejectedUpgradeStatus(
            fireflyProxyWebSocketUrl(enabled.origin, `http://fixture.test:${upstreamPort}/socket`),
            { origin: "https://attacker.test" }
        ), 403);
        assert.equal(await rejectedUpgradeStatus(
            fireflyProxyWebSocketUrl(enabled.origin, "http://127.0.0.1:65530/socket"),
            { origin: enabled.origin }
        ), 403);
    } finally {
        await enabled.close();
    }
});

test("WebSocket payload and idle limits close established connections", async () => {
    const payloadProxy = await startProxy({
        browser: {
            enabled: true,
            webSocket: true,
            webSocketMaxPayloadBytes: 8,
            webSocketIdleTimeoutMs: 2000
        }
    });
    try {
        const client = new WebSocket(
            fireflyProxyWebSocketUrl(payloadProxy.origin, `http://fixture.test:${upstreamPort}/limit`),
            { origin: payloadProxy.origin }
        );
        client.on("error", () => {});
        await once(client, "open");
        client.send("payload-too-large");
        const [code] = await once(client, "close");
        assert.equal(code, 1009);
    } finally {
        await payloadProxy.close();
    }

    const idleProxy = await startProxy({
        browser: {
            enabled: true,
            webSocket: true,
            webSocketMaxPayloadBytes: 1024,
            webSocketIdleTimeoutMs: 50
        }
    });
    try {
        const client = new WebSocket(
            fireflyProxyWebSocketUrl(idleProxy.origin, `http://fixture.test:${upstreamPort}/idle`),
            { origin: idleProxy.origin }
        );
        client.on("error", () => {});
        await once(client, "open");
        const [code] = await once(client, "close");
        assert.equal(code, 1001);
    } finally {
        await idleProxy.close();
    }
});
