const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const {
    assertRequestBodyLength,
    createConcurrencyGate,
    createLimitedRequestBody
} = require("../../core/requestResources");

test("content-length requests fail before dispatch when the body is too large", () => {
    assert.throws(
        () => assertRequestBodyLength({ "content-length": "11" }, 10),
        error => error.code === "PROXY_REQUEST_BODY_LIMIT" && error.statusCode === 413
    );
});

test("chunked request bodies are counted while remaining streaming", async () => {
    const body = createLimitedRequestBody(Readable.from(["123", "456"]), 5);
    await assert.rejects(
        async () => {
            for await (const chunk of body) void chunk;
        },
        error => error.code === "PROXY_REQUEST_BODY_LIMIT"
    );
});

test("concurrency slots fail fast and release exactly once", () => {
    const gate = createConcurrencyGate();
    const release = gate.acquire(1);

    assert.equal(gate.active, 1);
    assert.throws(
        () => gate.acquire(1),
        error => error.code === "PROXY_CONCURRENCY_LIMIT" && error.statusCode === 503
    );
    release();
    release();
    assert.equal(gate.active, 0);
});
