const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    BROWSER_ROUTE_PREFIX,
    decodeOrigin,
    encodeOrigin,
    fromProxyRequest,
    resolveTargetUrl,
    toProxyUrl
} = require("../../core/urlMapper");

test("origin tokens are canonical, URL-safe and exactly reversible", () => {
    const token = encodeOrigin("https://Example.COM:443");

    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(decodeOrigin(token), "https://example.com");
    assert.equal(token, Buffer.from("https://example.com").toString("base64url"));
});

test("invalid, aliased and non-origin tokens fail with a stable public code", () => {
    const invalidTokens = [
        "",
        "not+padded=",
        Buffer.from("javascript:alert(1)").toString("base64url"),
        Buffer.from("https://example.com/path").toString("base64url"),
        Buffer.from("https://EXAMPLE.com").toString("base64url")
    ];

    for (const token of invalidTokens) {
        assert.throws(
            () => decodeOrigin(token),
            error => error.code === "PROXY_BROWSER_URL_INVALID" && error.statusCode === 400
        );
    }
});

test("proxy URLs preserve encoded paths, query and client-side fragments", () => {
    const target = "https://example.com/a%2Fb/file?q=hello%20world#section-2";
    const proxyUrl = toProxyUrl(target);
    const token = encodeOrigin("https://example.com");

    assert.equal(
        proxyUrl,
        `${BROWSER_ROUTE_PREFIX}/${token}/a%2Fb/file?q=hello%20world#section-2`
    );
    assert.equal(
        fromProxyRequest({ url: `/${token}/a%2Fb/file?q=hello%20world` }),
        "https://example.com/a%2Fb/file?q=hello%20world"
    );
});

test("request mapping normalizes dot segments without allowing a path to replace the token origin", () => {
    const token = encodeOrigin("https://example.com");

    assert.equal(
        fromProxyRequest({ url: `/${token}/docs/../asset.js?v=1` }),
        "https://example.com/asset.js?v=1"
    );
    assert.equal(
        fromProxyRequest({ url: `/${token}//attacker.test/asset.js` }),
        "https://example.com//attacker.test/asset.js"
    );
});

test("relative targets resolve against the effective document URL and ignored schemes stay unmapped", () => {
    const documentUrl = "https://example.com/docs/page/index.html";

    assert.equal(
        resolveTargetUrl("../images/logo.png?size=2#preview", documentUrl),
        "https://example.com/docs/images/logo.png?size=2#preview"
    );
    for (const value of [
        "#section",
        "javascript:alert(1)",
        "data:text/plain,hi",
        "blob:https://example.com/id",
        "mailto:a@example.com",
        "tel:123"
    ]) {
        assert.equal(resolveTargetUrl(value, documentUrl), null, value);
    }
});

test("malformed canonical request targets are rejected before target validation", () => {
    const token = encodeOrigin("https://example.com");
    for (const url of [`/${token}`, `/${token}/bad%zz`, `/${token}/bad\\path`, "/invalid!/path"]) {
        assert.throws(
            () => fromProxyRequest({ url }),
            error => error.code === "PROXY_BROWSER_URL_INVALID"
        );
    }
});
