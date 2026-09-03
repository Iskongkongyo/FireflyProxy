const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createDefaultConfig } = require("../../config/defaults");
const {
    ConfigLoadError,
    loadConfigFile,
    migrateLegacyConfig,
    parseConfigObject
} = require("../../config/loader");

test("default configuration uses explicit millisecond fields", () => {
    const config = createDefaultConfig({ FIREFLYPROXY_SESSION_SECRET: "default-test-secret" });

    assert.equal(config.timeoutMs, 30000);
    assert.equal(config.session.maxAgeMs, 86400000);
    assert.equal(config.limiter.enabled, false);
    assert.equal(config.limiter.windowMs, 60000);
    assert.equal(config.session.secret, "default-test-secret");
    assert.equal(config.api.maxRedirects, 5);
    assert.equal(config.api.connectTimeoutMs, 5000);
    assert.equal(config.api.maxRequestBodyBytes, 5242880);
    assert.equal(config.api.maxConcurrentRequests, 64);
    assert.deepEqual(config.admin, {
        enabled: false,
        path: "/admin",
        user: "",
        pwd: ""
    });
    assert.deepEqual(config.runtimeState, {
        backend: "memory",
        sqlitePath: "./.fireflyproxy-state/runtime.sqlite",
        busyTimeoutMs: 5000
    });
    assert.deepEqual(config.audit, {
        enabled: false,
        backend: "memory",
        sqlitePath: "./.fireflyproxy-audit/audit.sqlite",
        retentionDays: 7,
        maxRecords: 20000,
        recordTargetOrigin: true
    });
    assert.deepEqual(config.clientAccessControl, {
        enabled: false,
        neverBlock: []
    });
    assert.equal(config.browser.webSocket, false);
    assert.equal(config.browser.scriptCookieBridge, false);
    assert.equal(config.browser.webSocketMaxPayloadBytes, 1048576);
    assert.equal(config.browser.webSocketIdleTimeoutMs, 60000);
    assert.equal(config.browser.webSocketMaxConnections, 64);
    assert.deepEqual(config.browser.responseTransform, {
        enabled: false,
        rules: []
    });
    assert.deepEqual(config.browser.publicCache, {
        enabled: false,
        directory: "./.fireflyproxy-cache/public",
        ttlMs: 300000,
        maxBytes: 268435456,
        maxObjectBytes: 5242880
    });
    assert.deepEqual(config.browser.originIsolation, {
        enabled: false,
        baseOrigin: "https://browse.example.com"
    });
    assert.equal(config.trustProxy, false);
    assert.deepEqual(config.cors, {
        allowedOrigins: ["http://localhost:8080"],
        allowCredentials: true
    });
    assert.deepEqual(config.security.accessControl, {
        enabled: false,
        allowed: [],
        blocked: []
    });
});

test("legacy flat and snake_case fields migrate without mutating input", () => {
    const legacy = {
        port: 9090,
        timeout: 12,
        accessOrigin: "http://legacy.test",
        max_redirects: 3,
        session: {
            secret: "legacy-session-secret",
            name: "legacySession",
            cookie_max_age: 3600,
            cookie_secure: true,
            cookie_httponly: false
        },
        limiter: {
            windowMs: 60,
            max: 5,
            message: "legacy limit",
            statusCode: 429
        },
        blacklist: ["legacy.example", "*.blocked.example"]
    };
    const snapshot = structuredClone(legacy);
    const result = parseConfigObject(legacy, { env: {} });

    assert.deepEqual(legacy, snapshot);
    assert.equal(result.config.timeoutMs, 12000);
    assert.equal(result.config.session.maxAgeMs, 3600000);
    assert.equal(result.config.session.secure, true);
    assert.equal(result.config.session.httpOnly, false);
    assert.equal(result.config.limiter.windowMs, 60000);
    assert.deepEqual(result.config.cors.allowedOrigins, ["http://legacy.test"]);
    assert.deepEqual(result.config.security.accessControl, {
        enabled: true,
        allowed: [],
        blocked: ["legacy.example", "*.blocked.example"]
    });
    assert.equal(result.config.api.maxRedirects, 3);
    assert.ok(result.warnings.length >= 7);
});

test("legacy nested cookie maxAge keeps its documented millisecond unit", () => {
    const result = parseConfigObject({
        timeout: 30,
        accessOrigin: "*",
        session: {
            secret: "nested-cookie-secret",
            cookie: { maxAge: 123456, secure: false, httpOnly: true }
        }
    }, { env: {} });

    assert.equal(result.config.session.maxAgeMs, 123456);
    assert.equal(result.config.cors.allowCredentials, false);
});

test("new configuration interpolates environment variables and is deeply frozen", () => {
    const result = parseConfigObject({
        timeoutMs: 4500,
        trustProxy: false,
        session: {
            secret: "${PROXYWEB_SESSION_SECRET}",
            maxAgeMs: 120000
        },
        cors: {
            allowedOrigins: ["http://localhost:8080"],
            allowCredentials: true
        },
        api: {
            followRedirects: false,
            maxRedirects: 0
        }
    }, {
        env: { PROXYWEB_SESSION_SECRET: "environment-secret" }
    });

    assert.equal(result.config.session.secret, "environment-secret");
    assert.equal(result.config.timeoutMs, 4500);
    assert.equal(result.config.api.followRedirects, false);
    assert.equal(result.config.api.connectTimeoutMs, 5000);
    assert.ok(Object.isFrozen(result.config));
    assert.ok(Object.isFrozen(result.config.session));
    assert.ok(Object.isFrozen(result.config.cors.allowedOrigins));
    assert.deepEqual(result.warnings, []);
});

test("missing interpolated environment variable fails closed", () => {
    assert.throws(
        () => parseConfigObject({ session: { secret: "${MISSING_SECRET}" } }, { env: {} }),
        error => error instanceof ConfigLoadError && error.code === "CONFIG_ENV_MISSING"
    );
});

test("invalid values and unknown keys return actionable schema errors", () => {
    assert.throws(
        () => parseConfigObject({ port: 70000, unexpected: true }, { env: {} }),
        error => {
            assert.ok(error instanceof ConfigLoadError);
            assert.equal(error.code, "CONFIG_SCHEMA_INVALID");
            assert.match(error.message, /port/);
            assert.match(error.message, /Unrecognized key/);
            return true;
        }
    );
});

test("credentialed wildcard CORS configuration fails closed", () => {
    assert.throws(
        () => parseConfigObject({
            cors: { allowedOrigins: ["*"], allowCredentials: true }
        }, { env: {} }),
        error => {
            assert.ok(error instanceof ConfigLoadError);
            assert.equal(error.code, "CONFIG_SCHEMA_INVALID");
            assert.match(error.message, /cors\.allowedOrigins/);
            assert.match(error.message, /Wildcard origin is forbidden/);
            return true;
        }
    );
});

test("admin console requires credentials and a non-reserved absolute path when enabled", () => {
    assert.throws(
        () => parseConfigObject({ admin: { enabled: true, path: "/admin", user: "", pwd: "" } }),
        error => error instanceof ConfigLoadError && /admin/.test(error.message)
    );
    for (const adminPath of ["/", "/web", "/web/admin", "/__proxyweb/admin", "relative", "/bad.path"]) {
        assert.throws(
            () => parseConfigObject({ admin: {
                enabled: true,
                path: adminPath,
                user: "admin",
                pwd: "password"
            } }),
            error => error instanceof ConfigLoadError && /admin\.path/.test(error.message)
        );
    }
});

test("network access rules reject regular expressions and malformed ports", () => {
    assert.throws(
        () => parseConfigObject({
            security: { blockedHostnames: ["internal\\.example"] }
        }, { env: {} }),
        error => {
            assert.ok(error instanceof ConfigLoadError);
            assert.equal(error.code, "CONFIG_SCHEMA_INVALID");
            assert.match(error.message, /security\.accessControl\.blocked\.0/);
            assert.match(error.message, /hostname, wildcard hostname, IP or CIDR/);
            return true;
        }
    );
    assert.throws(
        () => parseConfigObject({
            security: {
                accessControl: {
                    enabled: true,
                    allowed: ["example.com:70000"],
                    blocked: []
                }
            }
        }, { env: {} }),
        error => error instanceof ConfigLoadError && /security\.accessControl\.allowed\.0/.test(error.message)
    );
});

test("network access policy accepts host, wildcard, IP, CIDR and port rules", () => {
    const accessControl = parseConfigObject({
        security: {
            accessControl: {
                enabled: true,
                allowed: [
                    "api.example.com",
                    "*.trusted.example.com:443",
                    "8.8.8.8:53",
                    "8.8.8.0/24",
                    "[2001:4860:4860::8888]:443",
                    "[2606:4700:4700::/48]:8443"
                ],
                blocked: ["blocked.example.com"]
            }
        }
    }, { env: {} }).config.security.accessControl;

    assert.equal(accessControl.enabled, true);
    assert.equal(accessControl.allowed.length, 6);
    assert.deepEqual(accessControl.blocked, ["blocked.example.com"]);
});

test("legacy migration emits structured deprecation records", () => {
    const result = migrateLegacyConfig({ timeout: 10, max_redirects: 2 });

    assert.equal(result.config.timeoutMs, 10000);
    assert.equal(result.config.api.maxRedirects, 2);
    assert.deepEqual(result.warnings.map(item => item.field), ["timeout", "max_redirects"]);
});

test("audit and client access controls validate bounded privacy settings", () => {
    const config = parseConfigObject({
        audit: {
            enabled: true,
            backend: "sqlite",
            sqlitePath: "./audit/events.sqlite",
            retentionDays: 30,
            maxRecords: 50000,
            recordTargetOrigin: false
        },
        clientAccessControl: {
            enabled: true,
            neverBlock: ["203.0.113.9", "2001:db8::/48"]
        }
    }).config;
    assert.equal(config.audit.backend, "sqlite");
    assert.deepEqual(config.clientAccessControl.neverBlock, ["203.0.113.9", "2001:db8::/48"]);

    for (const value of [
        { audit: { retentionDays: 0 } },
        { audit: { maxRecords: 99 } },
        { clientAccessControl: { neverBlock: ["example.com"] } }
    ]) {
        assert.throws(
            () => parseConfigObject(value),
            error => error instanceof ConfigLoadError
        );
    }
});

test("committed example configuration matches the current schema", () => {
    const configPath = path.resolve(__dirname, "..", "..", "..", "main.json.example");
    const result = loadConfigFile({ configPath, env: {} });

    assert.equal(result.config.timeoutMs, 30000);
    assert.equal(result.config.limiter.enabled, true);
    assert.equal(result.config.api.maxRequestBodyBytes, 5242880);
    assert.equal(result.config.trustProxy, false);
    assert.deepEqual(result.config.cors.allowedOrigins, ["http://localhost:8080"]);
    assert.deepEqual(result.warnings, []);
});

test("Browser header policy accepts preserve while retaining strict compatibility", () => {
    assert.equal(parseConfigObject({
        browser: { headerPolicy: "preserve" }
    }).config.browser.headerPolicy, "preserve");
    assert.equal(parseConfigObject({
        browser: { headerPolicy: "strict" }
    }).config.browser.headerPolicy, "strict");
});

test("WebSocket resource settings are bounded by the configuration schema", () => {
    assert.throws(
        () => parseConfigObject({
            browser: { webSocketMaxPayloadBytes: 16777217 }
        }),
        error => error instanceof ConfigLoadError
            && /browser\.webSocketMaxPayloadBytes/.test(error.message)
    );
    assert.throws(
        () => parseConfigObject({
            browser: { webSocketIdleTimeoutMs: 3600001 }
        }),
        error => error instanceof ConfigLoadError
            && /browser\.webSocketIdleTimeoutMs/.test(error.message)
    );
});

test("Script Cookie Bridge requires HTML Rewrite and Runtime Bridge", () => {
    for (const browser of [
        { scriptCookieBridge: true, runtimeBridge: false },
        { scriptCookieBridge: true, runtimeBridge: true, rewriteHtml: false }
    ]) {
        assert.throws(
            () => parseConfigObject({ browser }),
            error => error instanceof ConfigLoadError && /browser\.scriptCookieBridge/.test(error.message)
        );
    }
    assert.equal(parseConfigObject({ browser: {
        scriptCookieBridge: true,
        runtimeBridge: true,
        rewriteHtml: true
    } }).config.browser.scriptCookieBridge, true);
});

test("Scoped response transform validates bounded literal rules and unique IDs", () => {
    const valid = parseConfigObject({
        browser: {
            responseTransform: {
                enabled: true,
                rules: [{
                    id: "example-html",
                    hosts: ["example.com", "*.static.example.com"],
                    pathPrefix: "/app/",
                    contentTypes: ["text/html"],
                    replacements: [{ search: "before", replacement: "after" }]
                }]
            }
        }
    }).config.browser.responseTransform;
    assert.equal(valid.rules[0].enabled, true);
    assert.equal(valid.rules[0].replacements[0].mode, "all");
    assert.equal(valid.rules[0].replacements[0].maxReplacements, 1000);

    for (const rules of [
        [{
            id: "empty",
            hosts: ["example.com"],
            pathPrefix: "/",
            contentTypes: ["text/html"]
        }],
        [{
            id: "bad-host",
            hosts: ["*"],
            pathPrefix: "/",
            contentTypes: ["text/html"],
            replacements: [{ search: "a", replacement: "b" }]
        }],
        [{
            id: "bad-path",
            hosts: ["example.com"],
            pathPrefix: "relative",
            contentTypes: ["text/html"],
            replacements: [{ search: "a", replacement: "b" }]
        }],
        ...[["duplicate", "duplicate"]].map(ids => ids.map(id => ({
            id,
            hosts: ["example.com"],
            pathPrefix: "/",
            contentTypes: ["text/html"],
            replacements: [{ search: "a", replacement: "b" }]
        })))
    ]) {
        assert.throws(
            () => parseConfigObject({ browser: { responseTransform: { enabled: true, rules } } }),
            error => error instanceof ConfigLoadError && /responseTransform/.test(error.message)
        );
    }
});

test("Public static cache defaults closed and enforces bounded disk capacity", () => {
    const valid = parseConfigObject({
        browser: {
            publicCache: {
                enabled: true,
                directory: "./cache/public",
                ttlMs: 60000,
                maxBytes: 1048576,
                maxObjectBytes: 65536
            }
        }
    }).config.browser.publicCache;
    assert.equal(valid.enabled, true);
    assert.equal(valid.maxObjectBytes, 65536);

    for (const publicCache of [
        { enabled: true, directory: "", ttlMs: 1, maxBytes: 1024, maxObjectBytes: 1 },
        { enabled: true, directory: "./cache", ttlMs: 0, maxBytes: 1024, maxObjectBytes: 1 },
        { enabled: true, directory: "./cache", ttlMs: 1, maxBytes: 1024, maxObjectBytes: 2048 }
    ]) {
        assert.throws(
            () => parseConfigObject({ browser: { publicCache } }),
            error => error instanceof ConfigLoadError && /publicCache/.test(error.message)
        );
    }
});

test("Runtime state accepts memory or bounded SQLite startup configuration", () => {
    assert.equal(parseConfigObject({
        runtimeState: {
            backend: "sqlite",
            sqlitePath: "./state/runtime.sqlite",
            busyTimeoutMs: 1000
        }
    }).config.runtimeState.backend, "sqlite");

    for (const runtimeState of [
        { backend: "redis", sqlitePath: "./state.sqlite", busyTimeoutMs: 1000 },
        { backend: "sqlite", sqlitePath: "", busyTimeoutMs: 1000 },
        { backend: "sqlite", sqlitePath: "./state.sqlite", busyTimeoutMs: 99 },
        { backend: "sqlite", sqlitePath: "./state.sqlite", busyTimeoutMs: 60001 }
    ]) {
        assert.throws(
            () => parseConfigObject({ runtimeState }),
            error => error instanceof ConfigLoadError && /runtimeState/.test(error.message)
        );
    }
});

test("Origin isolation requires an owned HTTPS namespace and Secure control session", () => {
    const enabled = parseConfigObject({
        session: { secure: true },
        browser: {
            originIsolation: { enabled: true, baseOrigin: "https://browse.proxy.test" }
        }
    });
    assert.equal(enabled.config.browser.originIsolation.enabled, true);

    for (const browser of [
        { originIsolation: { enabled: true, baseOrigin: "https://example.com" } },
        { originIsolation: { enabled: true, baseOrigin: "https://example.co.uk" } },
        { originIsolation: { enabled: true, baseOrigin: "http://browse.example.com" } }
    ]) {
        assert.throws(
            () => parseConfigObject({ browser }),
            error => error instanceof ConfigLoadError && /originIsolation\.baseOrigin/.test(error.message)
        );
    }
    assert.throws(
        () => parseConfigObject({
            browser: {
                originIsolation: { enabled: true, baseOrigin: "https://browse.proxy.test" }
            }
        }),
        error => error instanceof ConfigLoadError && /session\.secure/.test(error.message)
    );
    assert.throws(
        () => parseConfigObject({
            session: { secure: true, httpOnly: false },
            browser: {
                originIsolation: { enabled: true, baseOrigin: "https://browse.proxy.test" }
            }
        }),
        error => error instanceof ConfigLoadError && /session\.httpOnly/.test(error.message)
    );
});
