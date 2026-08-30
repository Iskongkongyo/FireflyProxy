const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    API_DIAGNOSTIC_HEADERS,
    MAX_DIAGNOSTIC_HEADER_CHARS,
    buildApiResponseDiagnosticHeaders
} = require("../../api-proxy/responseDiagnostics");

function decode(value) {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

test("API diagnostics encode final URL, redirect chain and effective controls", () => {
    const chain = [{
        status: 302, method: "GET", url: "https://one.test/start",
        location: "https://two.test/final", followed: true, validated: true
    }];
    const headers = buildApiResponseDiagnosticHeaders({
        finalUrl: "https://two.test/final", redirectChain: chain,
        followRedirects: true, maxRedirects: 3
    });

    assert.equal(decode(headers[API_DIAGNOSTIC_HEADERS.finalUrl]), "https://two.test/final");
    assert.deepEqual(decode(headers[API_DIAGNOSTIC_HEADERS.redirectChain]), chain);
    assert.equal(headers[API_DIAGNOSTIC_HEADERS.redirectCount], "1");
    assert.equal(headers[API_DIAGNOSTIC_HEADERS.followRedirects], "true");
    assert.equal(headers[API_DIAGNOSTIC_HEADERS.maxRedirects], "3");
    assert.equal(headers[API_DIAGNOSTIC_HEADERS.truncated], undefined);
});

test("API diagnostics remain bounded and explicitly mark truncation", () => {
    const longUrl = `https://example.test/${"a".repeat(5000)}`;
    const headers = buildApiResponseDiagnosticHeaders({
        finalUrl: longUrl,
        redirectChain: Array.from({ length: 20 }, (_, index) => ({
            status: 302, method: "GET", url: `${longUrl}/${index}`,
            location: `${longUrl}/${index + 1}`, followed: true, validated: true
        })),
        followRedirects: true, maxRedirects: 20
    });

    assert.ok(headers[API_DIAGNOSTIC_HEADERS.finalUrl].length <= MAX_DIAGNOSTIC_HEADER_CHARS);
    assert.ok(headers[API_DIAGNOSTIC_HEADERS.redirectChain].length <= MAX_DIAGNOSTIC_HEADER_CHARS);
    assert.equal(headers[API_DIAGNOSTIC_HEADERS.truncated], "true");
});
