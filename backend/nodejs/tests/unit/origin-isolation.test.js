const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    classifyProxyOrigin,
    createOriginIsolationRegistry,
    isolatedProxyOrigin,
    isolationLabel,
    validateTargetProxyOrigin
} = require("../../core/originIsolation");
const { toProxyUrl } = require("../../core/urlMapper");

const isolation = {
    enabled: true,
    baseOrigin: "https://browse.proxy.test"
};

test("Origin isolation labels are deterministic SHA-256 DNS labels", () => {
    assert.equal(isolationLabel("https://example.com"), "o-100680ad546ce6a577f42f52df33b4cf");
    assert.equal(
        isolatedProxyOrigin("https://example.com", isolation),
        "https://o-100680ad546ce6a577f42f52df33b4cf.browse.proxy.test"
    );
});

test("bounded source registry resolves only labels registered from canonical targets", () => {
    const registry = createOriginIsolationRegistry({ maxEntries: 1 });
    const first = "https://first.example";
    const second = "https://second.example";
    registry.register(first);
    assert.equal(registry.resolve(isolatedProxyOrigin(first, isolation), isolation), first);
    registry.register(second);
    assert.equal(registry.resolve(isolatedProxyOrigin(first, isolation), isolation), null);
    assert.equal(registry.resolve(isolatedProxyOrigin(second, isolation), isolation), second);
    assert.equal(registry.resolve("https://o-ffffffffffffffffffffffffffffffff.browse.proxy.test", isolation), null);
});

test("isolated URL mapping keeps the reversible path token as a second binding", () => {
    const mapped = toProxyUrl("https://example.com/docs?q=1#part", { originIsolation: isolation });
    assert.equal(
        mapped,
        "https://o-100680ad546ce6a577f42f52df33b4cf.browse.proxy.test"
            + "/__proxyweb/browser/aHR0cHM6Ly9leGFtcGxlLmNvbQ/docs?q=1#part"
    );
});

test("origin classification trusts only the exact base or a canonical derived-label shape", () => {
    assert.deepEqual(classifyProxyOrigin("https://browse.proxy.test", isolation), {
        scope: "base",
        origin: "https://browse.proxy.test"
    });
    assert.equal(classifyProxyOrigin("https://attacker.browse.proxy.test", isolation), null);
    assert.equal(classifyProxyOrigin("http://o-100680ad546ce6a577f42f52df33b4cf.browse.proxy.test", isolation), null);
});

test("target host validation redirects only the base host and rejects mismatched isolated hosts", () => {
    const baseRequest = { protocol: "https", headers: { host: "browse.proxy.test" } };
    assert.equal(validateTargetProxyOrigin(baseRequest, "https://example.com", isolation).redirect, true);

    const correctRequest = {
        protocol: "https",
        headers: { host: "o-100680ad546ce6a577f42f52df33b4cf.browse.proxy.test" }
    };
    assert.equal(validateTargetProxyOrigin(correctRequest, "https://example.com", isolation).redirect, false);

    assert.throws(
        () => validateTargetProxyOrigin({
            protocol: "https",
            headers: { host: "o-ffffffffffffffffffffffffffffffff.browse.proxy.test" }
        }, "https://example.com", isolation),
        error => error.code === "PROXY_ORIGIN_ISOLATION_DENIED" && error.statusCode === 421
    );
});
