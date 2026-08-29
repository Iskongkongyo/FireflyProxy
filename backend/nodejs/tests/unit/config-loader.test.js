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
    const config = createDefaultConfig({ PROXYWEB_SESSION_SECRET: "default-test-secret" });

    assert.equal(config.timeoutMs, 30000);
    assert.equal(config.session.maxAgeMs, 86400000);
    assert.equal(config.limiter.windowMs, 60000);
    assert.equal(config.session.secret, "default-test-secret");
    assert.equal(config.api.maxRedirects, 5);
    assert.equal(config.trustProxy, false);
    assert.deepEqual(config.cors, {
        allowedOrigins: ["http://localhost:8080"],
        allowCredentials: true
    });
    assert.deepEqual(config.security.blockedHostnames, []);
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
    assert.deepEqual(result.config.security.blockedHostnames, ["legacy.example", "*.blocked.example"]);
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

test("hostname block rules reject legacy regular expressions", () => {
    assert.throws(
        () => parseConfigObject({
            security: { blockedHostnames: ["internal\\.example"] }
        }, { env: {} }),
        error => {
            assert.ok(error instanceof ConfigLoadError);
            assert.equal(error.code, "CONFIG_SCHEMA_INVALID");
            assert.match(error.message, /security\.blockedHostnames\.0/);
            assert.match(error.message, /exact hostname or a leading wildcard/);
            return true;
        }
    );
});

test("legacy migration emits structured deprecation records", () => {
    const result = migrateLegacyConfig({ timeout: 10, max_redirects: 2 });

    assert.equal(result.config.timeoutMs, 10000);
    assert.equal(result.config.api.maxRedirects, 2);
    assert.deepEqual(result.warnings.map(item => item.field), ["timeout", "max_redirects"]);
});

test("committed example configuration matches the current schema", () => {
    const configPath = path.resolve(__dirname, "..", "..", "..", "main.json.example");
    const result = loadConfigFile({ configPath, env: {} });

    assert.equal(result.config.timeoutMs, 30000);
    assert.equal(result.config.trustProxy, false);
    assert.deepEqual(result.config.cors.allowedOrigins, ["http://localhost:8080"]);
    assert.deepEqual(result.warnings, []);
});
