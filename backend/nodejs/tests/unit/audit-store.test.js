const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
    createMemoryAuditStore,
    createSqliteAuditStore,
    normalizeEvent,
    normalizeQuery,
    safeTargetOrigin
} = require("../../core/auditStore");

function testConfig(overrides = {}) {
    return {
        audit: {
            enabled: true,
            retentionDays: 7,
            maxRecords: 2,
            ...overrides
        }
    };
}

test("audit events retain bounded metadata and reduce targets to origins", () => {
    const event = normalizeEvent({
        targetOrigin: "https://user:secret@example.test:8443/private?q=token#fragment",
        detail: `safe\u0000${"x".repeat(600)}`,
        method: "GET\r\nInjected"
    }, () => 123);

    assert.equal(event.timestamp, 123);
    assert.equal(event.targetOrigin, "https://example.test:8443");
    assert.equal(event.method, "GET  Injected");
    assert.equal(event.detail.length, 512);
    assert.equal(safeTargetOrigin("file:///secret"), "");
    assert.deepEqual(
        { limit: normalizeQuery({ limit: "1.9", offset: "Infinity" }).limit, offset: normalizeQuery({ limit: "1.9", offset: "Infinity" }).offset },
        { limit: 1, offset: 0 }
    );
});

test("memory audit store bounds, filters, clears and expires records", () => {
    let now = 1_700_000_000_000;
    const config = testConfig();
    const store = createMemoryAuditStore({ getConfig: () => config, now: () => now });

    store.record({ action: "first", category: "request", ip: "203.0.113.1" });
    now += 1;
    store.record({ action: "second", category: "admin", ip: "203.0.113.2" });
    now += 1;
    store.record({ action: "third", category: "request", ip: "203.0.113.3" });

    assert.deepEqual(store.query({}).items.map(item => item.action), ["third", "second"]);
    assert.equal(store.query({ category: "request", query: "203.0.113.3" }).total, 1);
    assert.equal(store.clearEvents(), 2);
    assert.equal(store.query({}).total, 0);

    config.audit.enabled = false;
    assert.equal(store.record({ action: "disabled" }), null);
});

test("memory audit store manages normalized temporary bans and hit counts", () => {
    let now = 1_700_000_000_000;
    const config = testConfig();
    const store = createMemoryAuditStore({ getConfig: () => config, now: () => now });
    const ban = store.addBan({
        rule: "203.0.113.0/24",
        reason: "abuse",
        createdAt: now,
        expiresAt: now + 60_000
    });

    assert.equal(store.findActiveBan("203.0.113.42").id, ban.id);
    store.recordBanHit(ban.id);
    assert.equal(store.listBans()[0].hitCount, 1);
    assert.equal(store.listBans()[0].lastHitAt, now);

    now += 60_000;
    assert.equal(store.findActiveBan("203.0.113.42"), null);
    assert.equal(store.listBans().length, 0);
});

test("SQLite audit store persists bounded events and bans", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fireflyproxy-audit-test-"));
    const config = testConfig({
        backend: "sqlite",
        sqlitePath: "./audit.sqlite",
        maxRecords: 2
    });
    const options = {
        configPath: path.join(directory, "main.json"),
        getConfig: () => config,
        now: () => 1_700_000_000_000
    };
    let store;
    try {
        store = createSqliteAuditStore(options);
        store.record({ action: "one", timestamp: 1_699_999_999_998 });
        store.record({ action: "two", timestamp: 1_699_999_999_999 });
        store.record({ action: "three", timestamp: 1_700_000_000_000 });
        const ban = store.addBan({ rule: "203.0.113.4", createdAt: 1_700_000_000_000, expiresAt: null });
        store.close();
        store = createSqliteAuditStore(options);

        assert.deepEqual(store.query({}).items.map(item => item.action), ["three", "two"]);
        assert.equal(store.findActiveBan("203.0.113.4").id, ban.id);
    } finally {
        store?.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
