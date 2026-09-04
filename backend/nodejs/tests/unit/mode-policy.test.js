const assert = require("node:assert/strict");
const { test } = require("node:test");
const { apiPolicy, DEFAULT_USER_AGENT } = require("../../api-proxy/policy");
const {
    COMPAT_RESPONSE_HEADERS,
    browserPolicy,
    legacyPolicy
} = require("../../browser-proxy/policy");
const { createSessionStateStore, storeResponseCookies } = require("../../browser-proxy/sessionStateStore");
const { encodeScriptCookieName, scriptCookiePrefix } = require("../../browser-proxy/scriptCookieBridge");
const { toProxyUrl } = require("../../core/urlMapper");
const { getTargetUrl } = require("../../middleware/legacyAdapter");

const upstreamHeaders = {
    "content-type": "text/html",
    "content-length": "10",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'"
};

test("API response policy preserves security headers without transport metadata", () => {
    const headers = apiPolicy.filterResponseHeaders(upstreamHeaders);
    const passthrough = apiPolicy.filterResponseHeaders(upstreamHeaders, {}, {
        preserveContentLength: true
    });
    assert.equal(headers["content-length"], undefined);
    assert.equal(passthrough["content-length"], "10");
    assert.equal(headers["x-frame-options"], "DENY");
    assert.equal(headers["content-security-policy"], "default-src 'none'");
});

test("API requests replace ambient browser identity with a coherent server client profile", () => {
    const headers = apiPolicy.buildRequestHeaders({
        accept: "application/json, text/plain, */*",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json",
        dnt: "1",
        priority: "u=1, i",
        "upgrade-insecure-requests": "1",
        "user-agent": "Mozilla/5.0 Chrome/140.0.0.0"
    });

    assert.equal(headers["user-agent"], DEFAULT_USER_AGENT);
    assert.equal(headers.accept, undefined);
    assert.equal(headers["accept-encoding"], undefined);
    assert.equal(headers["accept-language"], undefined);
    assert.equal(headers.dnt, undefined);
    assert.equal(headers.priority, undefined);
    assert.equal(headers["upgrade-insecure-requests"], undefined);
    assert.equal(headers["content-type"], "application/json");
});

test("Browser and legacy response policies are independently configurable", () => {
    const extendedHeaders = {
        ...upstreamHeaders,
        "set-cookie": ["upstream=secret"],
        "content-security-policy-report-only": "default-src 'self'",
        "cross-origin-resource-policy": "same-origin",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "clear-site-data": "\"cache\""
    };
    const compat = browserPolicy.filterResponseHeaders(extendedHeaders, {
        browser: { headerPolicy: "compat" }
    });
    const strict = browserPolicy.filterResponseHeaders(extendedHeaders, {
        browser: { headerPolicy: "strict" }
    });
    const preserve = browserPolicy.filterResponseHeaders(extendedHeaders, {
        browser: { headerPolicy: "preserve" }
    });
    const legacy = legacyPolicy.filterResponseHeaders(upstreamHeaders, {}, {
        preserveContentLength: true
    });

    for (const name of COMPAT_RESPONSE_HEADERS) assert.equal(compat[name], undefined);
    assert.equal(strict["x-frame-options"], "DENY");
    assert.equal(preserve["cross-origin-resource-policy"], "same-origin");
    assert.equal(strict["set-cookie"], undefined);
    assert.equal(preserve["set-cookie"], undefined);
    assert.equal(legacy["x-frame-options"], undefined);
    assert.equal(legacy["content-length"], "10");
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

test("Browser requests map source headers, inject jar cookies and force identity encoding", async () => {
    const state = createSessionStateStore().get("session-a", 60000);
    await storeResponseCookies(state, "https://cdn.test/", "upstream=jar; Path=/; HttpOnly");
    const sourceUrl = "https://source.test/page?q=1";
    const targetUrl = "https://cdn.test/asset.css";
    const bridgeCookie = `${scriptCookiePrefix(targetUrl)}${encodeScriptCookieName("dscld")}=true`;
    const headers = await browserPolicy.buildRequestHeaders({
        Accept: "text/html",
        "Accept-Encoding": "gzip, br",
        Cookie: `proxySession=do-not-forward; ${bridgeCookie}`,
        Host: "proxy.test",
        Origin: "https://proxy.test",
        Referer: `https://proxy.test${toProxyUrl(sourceUrl)}`
    }, {}, {
        browser: { cookieJar: true, scriptCookieBridge: true }
    }, {
        request: { protocol: "https", headers: { host: "proxy.test" } },
        sessionState: state,
        targetUrl
    });

    assert.equal(headers["Accept-Encoding"], undefined);
    assert.equal(headers["accept-encoding"], "identity");
    assert.equal(headers.Accept, "text/html");
    assert.equal(headers.cookie, "upstream=jar; dscld=true");
    assert.equal(headers.origin, "https://source.test");
    assert.equal(headers.referer, sourceUrl);
    assert.equal(headers.Host, undefined);
});

test("Browser source header mapping rejects external Referer and preserves opaque Origin", async () => {
    const headers = await browserPolicy.buildRequestHeaders({
        Host: "proxy.test",
        Origin: "null",
        Referer: `https://attacker.test${toProxyUrl("https://source.test/page")}`
    }, {}, {
        browser: { cookieJar: false }
    }, {
        request: { protocol: "https", headers: { host: "proxy.test" } },
        targetUrl: "https://destination.test/path"
    });

    assert.equal(headers.origin, "null");
    assert.equal(headers.referer, undefined);
});

test("Browser source header mapping never guesses the destination as the source Origin", async () => {
    const headers = await browserPolicy.buildRequestHeaders({
        Host: "proxy.test",
        Origin: "https://proxy.test"
    }, {}, {
        browser: { cookieJar: false }
    }, {
        request: { protocol: "https", headers: { host: "proxy.test" } },
        targetUrl: "https://destination.test/sensitive-action"
    });

    assert.equal(headers.origin, "null");
});

test("legacy session paths retain origin-based URL joining", () => {
    assert.equal(
        getTargetUrl("https://example.test/base", "/echo?session=yes"),
        "https://example.test/echo?session=yes"
    );
});
