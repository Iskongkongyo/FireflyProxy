const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    normalizeRequestOrigin,
    parseRequestedHeaders,
    resolveCorsOrigin
} = require("../../middleware/cors");

test("request Origin normalization only accepts canonical HTTP origins", () => {
    assert.equal(normalizeRequestOrigin("https://app.example.com"), "https://app.example.com");
    assert.equal(normalizeRequestOrigin("http://localhost:8080"), "http://localhost:8080");
    assert.equal(normalizeRequestOrigin("https://app.example.com/"), null);
    assert.equal(normalizeRequestOrigin("https://app.example.com/path"), null);
    assert.equal(normalizeRequestOrigin("null"), null);
    assert.equal(normalizeRequestOrigin("not-an-origin"), null);
});

test("requested CORS headers are normalized, deduplicated and syntax checked", () => {
    assert.deepEqual(
        parseRequestedHeaders("Content-Type, X-Request-ID, content-type"),
        ["content-type", "x-request-id"]
    );
    assert.deepEqual(parseRequestedHeaders(undefined), []);
    assert.equal(parseRequestedHeaders("x-valid, bad header"), null);
    assert.equal(parseRequestedHeaders("x-valid,"), null);
});

test("CORS policy returns literal wildcard only for wildcard configuration", () => {
    assert.equal(resolveCorsOrigin("https://app.example.com", {
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: true
    }), "https://app.example.com");
    assert.equal(resolveCorsOrigin("https://evil.example.com", {
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: true
    }), null);
    assert.equal(resolveCorsOrigin("https://any.example.com", {
        allowedOrigins: ["*"],
        allowCredentials: false
    }), "*");
});
