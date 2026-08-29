const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRequestLogger } = require("../../middleware/requestLogger");

test("request logger assigns an ID and redacts the logged URL", () => {
    const secret = "query-secret-789";
    const urlCredential = "url-credential-987";
    const entries = [];
    const headers = {};
    const middleware = createRequestLogger({
        logger: { info: (message, metadata) => entries.push({ message, metadata }) },
        requestIdFactory: () => "fixed-request-id"
    });
    const request = {
        method: "GET",
        url: `/?url=${encodeURIComponent(`https://user:${urlCredential}@example.test/`)}&headers=${encodeURIComponent(JSON.stringify({ Authorization: `Bearer ${secret}` }))}`,
        originalUrl: `/?url=${encodeURIComponent(`https://user:${urlCredential}@example.test/`)}&headers=${encodeURIComponent(JSON.stringify({ Authorization: `Bearer ${secret}` }))}`,
        ip: "127.0.0.1"
    };
    const response = { setHeader: (name, value) => { headers[name] = value; } };
    let nextCalled = false;

    middleware(request, response, () => { nextCalled = true; });

    assert.equal(request.id, "fixed-request-id");
    assert.equal(headers["X-Request-ID"], "fixed-request-id");
    assert.equal(nextCalled, true);
    assert.equal(entries.length, 1);
    assert.doesNotMatch(entries[0].metadata.path, new RegExp(secret));
    assert.doesNotMatch(entries[0].metadata.path, new RegExp(urlCredential));
    assert.match(entries[0].metadata.path, /\[REDACTED\]/);
});
