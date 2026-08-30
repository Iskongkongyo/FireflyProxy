const assert = require("node:assert/strict");
const { test } = require("node:test");
const { apiPolicy } = require("../../api-proxy/policy");
const { browserPolicy, legacyPolicy } = require("../../browser-proxy/policy");
const { getTargetUrl } = require("../../middleware/legacyAdapter");

const upstreamHeaders = {
    "content-type": "text/html",
    "content-length": "10",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'"
};

test("API response policy preserves security headers without transport metadata", () => {
    const headers = apiPolicy.filterResponseHeaders(upstreamHeaders);
    assert.equal(headers["content-length"], undefined);
    assert.equal(headers["x-frame-options"], "DENY");
    assert.equal(headers["content-security-policy"], "default-src 'none'");
});

test("Browser and legacy response policies are independently configurable", () => {
    const compat = browserPolicy.filterResponseHeaders(upstreamHeaders, {
        browser: { headerPolicy: "compat" }
    });
    const strict = browserPolicy.filterResponseHeaders(upstreamHeaders, {
        browser: { headerPolicy: "strict" }
    });
    const legacy = legacyPolicy.filterResponseHeaders(upstreamHeaders);

    assert.equal(compat["x-frame-options"], undefined);
    assert.equal(strict["x-frame-options"], "DENY");
    assert.equal(legacy["x-frame-options"], undefined);
});

test("API and Browser modes select independent redirect behavior", () => {
    const config = {
        api: { followRedirects: false, maxRedirects: 2 },
        browser: { maxRedirects: 9 }
    };
    assert.deepEqual(apiPolicy.redirectOptions(config), { followRedirects: false, maxRedirects: 2 });
    assert.deepEqual(browserPolicy.redirectOptions(config), {
        followRedirects: false,
        validateRedirects: true,
        maxRedirects: 9
    });
});

test("Browser response policy maps only prevalidated redirect Locations", () => {
    const config = { browser: { headerPolicy: "strict" } };
    const mapped = browserPolicy.filterResponseHeaders({
        Location: "https://untrusted.test/raw"
    }, config, {
        redirectTargetUrl: "https://validated.test/login?next=1"
    });
    const untouched = browserPolicy.filterResponseHeaders({
        Location: "https://untrusted.test/raw"
    }, config);

    assert.equal(mapped.Location, undefined);
    assert.equal(mapped.location, "/__proxyweb/browser/aHR0cHM6Ly92YWxpZGF0ZWQudGVzdA/login?next=1");
    assert.equal(untouched.Location, "https://untrusted.test/raw");
});

test("Browser requests prefer identity encoding without allowing case aliases to override it", () => {
    const headers = browserPolicy.buildRequestHeaders({
        Accept: "text/html",
        "Accept-Encoding": "gzip, br"
    }, {});

    assert.equal(headers["Accept-Encoding"], undefined);
    assert.equal(headers["accept-encoding"], "identity");
    assert.equal(headers.Accept, "text/html");
});

test("legacy session paths retain origin-based URL joining", () => {
    assert.equal(
        getTargetUrl("https://example.test/base", "/echo?session=yes"),
        "https://example.test/echo?session=yes"
    );
});
