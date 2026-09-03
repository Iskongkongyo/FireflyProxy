const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    assertClientRuleCanBeBlocked,
    clientRuleMatches,
    createClientBlockMiddleware,
    normalizeClientIp,
    normalizeClientRule,
    rulesOverlap
} = require("../../core/clientAccess");
const { ERROR_CODES } = require("../../core/errors");

test("client address helpers normalize IPs and match exact or CIDR rules", () => {
    assert.equal(normalizeClientIp("::ffff:203.0.113.8"), "203.0.113.8");
    assert.equal(normalizeClientIp("[2001:db8::1]"), "2001:db8::1");
    assert.equal(normalizeClientRule("203.0.113.0/24"), "203.0.113.0/24");
    assert.equal(normalizeClientRule("203.0.113.99/24"), "203.0.113.0/24");
    assert.equal(normalizeClientRule("example.com"), null);
    assert.equal(clientRuleMatches("203.0.113.0/24", "203.0.113.55"), true);
    assert.equal(clientRuleMatches("203.0.113.4", "203.0.113.5"), false);
    assert.equal(rulesOverlap("203.0.113.0/24", "203.0.113.9"), true);
    assert.equal(rulesOverlap("203.0.113.0/24", "198.51.100.0/24"), false);
});

test("client bans cannot overlap loopback, server, protected or current admin addresses", () => {
    for (const [rule, options] of [
        ["127.0.0.1", {}],
        ["127.0.0.0/8", {}],
        ["203.0.113.0/24", { currentAdminIp: "203.0.113.8" }],
        ["198.51.100.0/24", { localAddress: "198.51.100.1" }],
        ["192.0.2.8", { neverBlock: ["192.0.2.0/24"] }]
    ]) {
        assert.throws(
            () => assertClientRuleCanBeBlocked(rule, options),
            error => error.code === ERROR_CODES.ADMIN_CONFIG_INVALID
        );
    }
    assert.equal(assertClientRuleCanBeBlocked("203.0.113.8"), "203.0.113.8");
});

test("client block middleware rejects active bans before business logic", () => {
    const records = [];
    const hits = [];
    const middleware = createClientBlockMiddleware({
        getConfig: () => ({ clientAccessControl: { enabled: true, neverBlock: [] } }),
        auditStore: {
            findActiveBan: ip => ip === "203.0.113.9" ? { id: "ban-1", rule: "203.0.113.0/24" } : null,
            recordBanHit: id => hits.push(id),
            record: event => records.push(event)
        },
        logger: { warn() {} }
    });
    let error;
    middleware({
        ip: "203.0.113.9",
        method: "GET",
        id: "request-1",
        socket: { localAddress: "192.0.2.1" }
    }, {}, value => { error = value; });

    assert.equal(error.code, ERROR_CODES.CLIENT_BLOCKED);
    assert.deepEqual(hits, ["ban-1"]);
    assert.equal(records[0].category, "security");
    assert.equal(records[0].detail, "rule=203.0.113.0/24");
});

test("client block middleware always lets loopback reach recovery controls", () => {
    const middleware = createClientBlockMiddleware({
        getConfig: () => ({ clientAccessControl: { enabled: true, neverBlock: [] } }),
        auditStore: {
            findActiveBan: () => ({ id: "bad", rule: "127.0.0.0/8" }),
            recordBanHit() { throw new Error("must not hit"); },
            record() { throw new Error("must not record"); }
        },
        logger: { warn() {} }
    });
    let nextCalled = false;
    middleware({ ip: "127.0.0.1", socket: { localAddress: "127.0.0.1" } }, {}, error => {
        assert.equal(error, undefined);
        nextCalled = true;
    });
    assert.equal(nextCalled, true);
});

test("client access fails closed when the active ban store is unavailable", () => {
    const middleware = createClientBlockMiddleware({
        getConfig: () => ({ clientAccessControl: { enabled: true, neverBlock: [] } }),
        auditStore: { findActiveBan() { throw new Error("database offline"); } },
        logger: { error() {}, warn() {} }
    });
    let error;
    middleware({
        ip: "203.0.113.10",
        id: "request-2",
        socket: { localAddress: "192.0.2.1" }
    }, {}, value => { error = value; });
    assert.equal(error.code, ERROR_CODES.AUDIT_UNAVAILABLE);
    assert.equal(error.statusCode, 503);
});
