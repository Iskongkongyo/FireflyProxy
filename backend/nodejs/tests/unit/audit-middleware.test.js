const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const {
    createRequestAudit,
    queryTargetOrigin,
    requestMode
} = require("../../middleware/audit");

test("audit mode classification excludes management and static workspace routes", () => {
    assert.equal(requestMode({ path: "/__proxyweb/api", fireflyProxyAdminRoute: false }), "api");
    assert.equal(requestMode({ path: "/__proxyweb/browser/token/page" }), "browser");
    assert.equal(requestMode({ path: "/web/assets/app.js" }), null);
    assert.equal(requestMode({ path: "/admin", fireflyProxyAdminRoute: true }), null);
    assert.equal(requestMode({ path: "/legacy" }), "legacy");
});

test("target extraction keeps only a safe HTTP origin", () => {
    assert.equal(queryTargetOrigin({ query: { url: "https://api.example.test:8443/path?secret=1" } }), "https://api.example.test:8443");
    assert.equal(queryTargetOrigin({ query: { url: "file:///secret" } }), "");
});

test("request audit records completion metadata without a full URL", () => {
    let now = 1000;
    const records = [];
    const middleware = createRequestAudit({
        getConfig: () => ({ audit: { enabled: true, recordTargetOrigin: true } }),
        auditStore: { record: event => records.push(event) },
        now: () => now
    });
    const response = new EventEmitter();
    response.statusCode = 200;
    response.locals = {};
    const request = {
        path: "/__proxyweb/api",
        query: { url: "https://api.example.test/private?token=secret" },
        ip: "::ffff:203.0.113.7",
        method: "POST",
        id: "request-7",
        socket: {}
    };

    middleware(request, response, () => {});
    now = 1012;
    response.emit("finish");

    assert.deepEqual(records[0], {
        timestamp: 1000,
        category: "request",
        action: "request.completed",
        outcome: "success",
        ip: "203.0.113.7",
        method: "POST",
        mode: "api",
        targetOrigin: "https://api.example.test",
        status: 200,
        durationMs: 12,
        requestId: "request-7"
    });
});
