const assert = require("node:assert/strict");
const { test } = require("node:test");
const { WebSocket } = require("ws");
const { startProxy } = require("../helpers/proxy-process");

function authorization(user, password) {
    return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function webSocketStatus(url, headers) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        socket.once("open", () => {
            socket.terminate();
            reject(new Error("WebSocket unexpectedly opened"));
        });
        socket.once("unexpected-response", (request, response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
        });
        socket.once("error", error => {
            if (!/Unexpected server response/u.test(error.message)) reject(error);
        });
    });
}

test("admin audit APIs record authentication and safely manage client bans", async () => {
    const proxy = await startProxy({
        trustProxy: 1,
        audit: {
            enabled: true,
            backend: "memory",
            retentionDays: 7,
            maxRecords: 1000,
            recordTargetOrigin: true
        },
        clientAccessControl: { enabled: true, neverBlock: [] },
        admin: {
            enabled: true,
            path: "/control",
            user: "admin-user",
            pwd: "admin-password"
        }
    });
    const auth = authorization("admin-user", "admin-password");
    const readHeaders = { authorization: auth, referer: `${proxy.origin}/control` };
    const mutationHeaders = {
        ...readHeaders,
        origin: proxy.origin,
        "content-type": "application/json",
        "x-fireflyproxy-admin": "1"
    };

    try {
        const failedAuth = await fetch(`${proxy.origin}/control`, {
            headers: { authorization: authorization("admin-user", "wrong") }
        });
        assert.equal(failedAuth.status, 401);

        const ownAddressBan = await fetch(`${proxy.origin}/control/api/bans`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ rule: "127.0.0.1", durationMs: 600000 })
        });
        assert.equal(ownAddressBan.status, 400);

        const createdResponse = await fetch(`${proxy.origin}/control/api/bans`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({
                rule: "203.0.113.9",
                reason: "contract test",
                durationMs: 600000
            })
        });
        const created = await createdResponse.json();
        assert.equal(createdResponse.status, 200);
        assert.equal(created.item.rule, "203.0.113.9");

        const blocked = await fetch(`${proxy.origin}/__proxyweb/api?url=https://example.test`, {
            headers: { "x-forwarded-for": "203.0.113.9" }
        });
        assert.equal(blocked.status, 403);
        assert.equal((await blocked.json()).error.code, "PROXY_CLIENT_BLOCKED");
        assert.equal(await webSocketStatus(
            proxy.origin.replace(/^http/u, "ws") + "/__proxyweb/browser/not-a-token",
            { "x-forwarded-for": "203.0.113.9" }
        ), 403);

        const bansResponse = await fetch(`${proxy.origin}/control/api/bans`, { headers: readHeaders });
        const bans = await bansResponse.json();
        assert.equal(bansResponse.status, 200);
        assert.equal(bans.items[0].hitCount, 2);
        assert.ok(bans.protectedAddresses.includes("127.0.0.1"));

        const securityResponse = await fetch(`${proxy.origin}/control/api/audit?category=security`, {
            headers: readHeaders
        });
        const security = await securityResponse.json();
        assert.equal(securityResponse.status, 200);
        assert.equal(security.enabled, true);
        assert.equal(security.items[0].action, "client.blocked");
        assert.equal(security.items[0].ip, "203.0.113.9");

        const adminResponse = await fetch(`${proxy.origin}/control/api/audit?category=admin`, {
            headers: readHeaders
        });
        const adminEvents = await adminResponse.json();
        assert.ok(adminEvents.items.some(item => (
            item.action === "admin.authentication" && item.outcome === "failed"
        )));
        assert.ok(adminEvents.items.some(item => item.action === "client-ban.create"));

        const removed = await fetch(
            `${proxy.origin}/control/api/bans?id=${encodeURIComponent(created.item.id)}`,
            { method: "DELETE", headers: mutationHeaders }
        );
        assert.equal(removed.status, 200);
        assert.equal((await removed.json()).ok, true);
    } finally {
        await proxy.close();
    }
});
