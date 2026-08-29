const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    ERROR_CODES,
    ProxyError,
    createErrorMiddleware,
    errorPayload,
    normalizeProxyError
} = require("../../core/errors");

test("known proxy errors use the stable public error envelope", () => {
    const error = new ProxyError(ERROR_CODES.SSRF_BLOCKED, "Target is blocked", {
        statusCode: 403,
        details: { address: "127.0.0.1" }
    });

    assert.deepEqual(errorPayload(error), {
        error: { code: "PROXY_SSRF_BLOCKED", message: "Target is blocked" }
    });
});

test("unknown internal failures are converted without exposing their message", () => {
    const internal = new Error("connect ECONNREFUSED C:\\private\\service.js:42");
    const normalized = normalizeProxyError(internal);
    const payload = errorPayload(internal);

    assert.equal(normalized.code, ERROR_CODES.UPSTREAM_ERROR);
    assert.equal(normalized.cause, internal);
    assert.deepEqual(payload, {
        error: { code: "PROXY_UPSTREAM_ERROR", message: "Upstream request failed" }
    });
    assert.doesNotMatch(JSON.stringify(payload), /ECONNREFUSED|private|service\.js/);
});

test("timeout failures receive a stable timeout code", () => {
    const internal = Object.assign(new Error("socket details"), { code: "ETIMEDOUT" });
    const normalized = normalizeProxyError(internal);

    assert.equal(normalized.code, ERROR_CODES.REQUEST_TIMEOUT);
    assert.equal(normalized.statusCode, 504);
});

test("wrapped resource errors preserve their public code", () => {
    const resourceError = new ProxyError(ERROR_CODES.CONNECT_TIMEOUT, "Upstream connection timed out", {
        statusCode: 504
    });
    const wrapped = new Error("transport failed", { cause: resourceError });

    assert.equal(normalizeProxyError(wrapped), resourceError);
});

test("error middleware logs internal context but only sends the public envelope", () => {
    const entries = [];
    const logger = { error: (message, metadata) => entries.push({ message, metadata }) };
    const middleware = createErrorMiddleware({ logger });
    const response = {
        headersSent: false,
        statusCode: null,
        body: null,
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; }
    };
    const internal = new Error("DNS lookup exposed 10.0.0.1");

    middleware(internal, { id: "request-123" }, response, () => assert.fail("next should not be called"));

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, {
        error: { code: "PROXY_UPSTREAM_ERROR", message: "Upstream request failed" }
    });
    assert.equal(entries[0].metadata.requestId, "request-123");
    assert.equal(entries[0].metadata.error, internal);
});
