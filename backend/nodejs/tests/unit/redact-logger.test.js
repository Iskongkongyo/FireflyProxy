const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const { test } = require("node:test");
const winston = require("winston");
const { createLogger } = require("../../core/logger");
const { REDACTED, isSensitiveKey, redact } = require("../../core/redact");

test("redact removes secrets from nested objects, URLs and errors without mutating input", () => {
    const secret = "sensitive-value-123";
    const input = {
        authorization: `Bearer ${secret}`,
        nested: { api_key: secret },
        targetUrl: `https://example.test/?headers=${encodeURIComponent(JSON.stringify({ Authorization: `Bearer ${secret}` }))}&safe=yes`,
        error: new Error(`request failed password=${secret}`)
    };

    const result = redact(input);
    const serialized = JSON.stringify(result);

    assert.equal(result.authorization, REDACTED);
    assert.equal(result.nested.api_key, REDACTED);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(result.targetUrl, /headers=%5BREDACTED%5D|headers=\[REDACTED\]/);
    assert.equal(input.nested.api_key, secret);
    assert.equal(isSensitiveKey("Proxy-Authorization"), true);
    assert.equal(isSensitiveKey("X-ProxyWeb-Upstream-Authorization"), true);
    assert.equal(isSensitiveKey("x-request-id"), false);
});

test("logger applies redaction before writing to a transport", async () => {
    const secret = "logger-secret-456";
    let output = "";
    let resolveWrite;
    const written = new Promise(resolve => { resolveWrite = resolve; });
    const stream = new Writable({
        write(chunk, encoding, callback) {
            output += chunk.toString();
            callback();
            resolveWrite();
        }
    });
    const logger = createLogger({
        transports: [new winston.transports.Stream({ stream })]
    });

    logger.info("Proxy request", {
        targetUrl: `https://example.test/?token=${secret}`,
        headers: { authorization: `Bearer ${secret}` }
    });
    await written;
    logger.close();

    assert.doesNotMatch(output, new RegExp(secret));
    assert.match(output, /\[REDACTED\]/);
});
