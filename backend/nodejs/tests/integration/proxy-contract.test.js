const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const { after, before, test } = require("node:test");
const cheerio = require("cheerio");
const { encodeScriptCookieName, scriptCookiePrefix } = require("../../browser-proxy/scriptCookieBridge");
const { toProxyUrl } = require("../../core/urlMapper");
const { createUpstreamFixture, RANGE_BODY } = require("../fixtures/upstream-server");
const { startProxy } = require("../helpers/proxy-process");

let fixture;
let proxy;

function proxyUrl(target, headers = {}) {
    const query = new URLSearchParams({
        url: target,
        headers: JSON.stringify(headers)
    });
    return `${proxy.origin}/?${query}`;
}

function modeUrl(proxyOrigin, mode, target) {
    return `${proxyOrigin}/__proxyweb/${mode}?url=${encodeURIComponent(target)}`;
}

function apiControlUrl(proxyOrigin, target, controls = {}) {
    const url = new URL(modeUrl(proxyOrigin, "api", target));
    for (const [name, value] of Object.entries(controls)) url.searchParams.set(name, String(value));
    return url.href;
}

function decodeDiagnosticHeader(response, name) {
    const value = response.headers.get(name);
    assert.ok(value, `missing ${name}`);
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function fixtureRedirect(location, status = 302) {
    const target = new URL(`${fixture.origin}/redirect-to`);
    target.searchParams.set("status", String(status));
    target.searchParams.set("location", location);
    return target.href;
}

before(async () => {
    fixture = await createUpstreamFixture();
    proxy = await startProxy();
});

after(async () => {
    await proxy.close();
    await fixture.close();
});

test("GET forwards target query and exposes upstream headers", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/json?hello=world`));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fixture"), "json");
    assert.deepEqual(payload, { ok: true, method: "GET", query: { hello: "world" } });
});

test("new API route forwards requests without creating legacy session state", async () => {
    const response = await fetch(modeUrl(proxy.origin, "api", `${fixture.origin}/echo?route=api`), {
        method: "POST",
        headers: {
            "content-type": "text/plain",
            "x-api-route": "true"
        },
        body: "api-route-body"
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("deprecation"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(payload.method, "POST");
    assert.equal(payload.headers["x-api-route"], "true");
    assert.equal(payload.body, "api-route-body");
});

test("new API route safely forwards structured browser-restricted request headers", async () => {
    const structuredHeaders = Buffer.from(JSON.stringify([
        ["Referer", "https://qifu.baidu.com/search"],
        ["Origin", "https://qifu.baidu.com"],
        ["Cookie", "upstreamSession=alpha"],
        ["User-Agent", "FireflyProxy-Integration/1.0"],
        ["X-Trace-ID", "trace-structured"],
        ["Host", "attacker.test"],
        ["X-Forwarded-For", "127.0.0.1"]
    ]), "utf8").toString("base64url");
    const response = await fetch(modeUrl(proxy.origin, "api", `${fixture.origin}/echo`), {
        headers: {
            origin: "http://frontend.test",
            cookie: "proxySession=must-not-leak",
            "x-fireflyproxy-upstream-headers": structuredHeaders
        }
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.headers.referer, "https://qifu.baidu.com/search");
    assert.equal(payload.headers.origin, "https://qifu.baidu.com");
    assert.equal(payload.headers.cookie, "upstreamSession=alpha");
    assert.equal(payload.headers["user-agent"], "FireflyProxy-Integration/1.0");
    assert.equal(payload.headers["x-trace-id"], "trace-structured");
    assert.equal(payload.headers.host, `fixture.test:${fixture.port}`);
    assert.equal(payload.headers["x-forwarded-for"], undefined);
});

test("legacy route remains compatible and advertises its successor", async () => {
    const target = `${fixture.origin}/json?route=legacy`;
    const response = await fetch(`${proxy.origin}/?url=${encodeURIComponent(target)}`, {
        headers: { origin: "http://frontend.test" }
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).query.route, "legacy");
    assert.equal(response.headers.get("deprecation"), "true");
    assert.match(response.headers.get("warning"), /legacy \/\?url route is deprecated/);
    assert.match(response.headers.get("link"), /<\/__proxyweb\/api>/);
    assert.match(response.headers.get("access-control-expose-headers"), /deprecation/i);
    assert.match(response.headers.get("access-control-expose-headers"), /warning/i);
    assert.match(response.headers.get("access-control-expose-headers"), /link/i);
});

test("Browser route is explicit, disabled by default and isolated from API CORS", async () => {
    const disabled = await fetch(modeUrl(proxy.origin, "browser", `${fixture.origin}/json`), {
        headers: { origin: "http://frontend.test" }
    });
    assert.equal(disabled.status, 404);
    assert.equal((await disabled.json()).error.code, "PROXY_BROWSER_DISABLED");
    assert.equal(disabled.headers.get("access-control-allow-origin"), null);

    const unknown = await fetch(`${proxy.origin}/__proxyweb/unknown`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "PROXY_ROUTE_NOT_FOUND");

    const reservedRoot = await fetch(`${proxy.origin}/__proxyweb`);
    assert.equal(reservedRoot.status, 404);
    assert.equal((await reservedRoot.json()).error.code, "PROXY_ROUTE_NOT_FOUND");
});

test("Browser entry creates a validated canonical URL whose query cannot become proxy controls", async () => {
    const canonicalProxy = await startProxy({ browser: { enabled: true } });
    try {
        const injectedHeaders = encodeURIComponent(JSON.stringify({ "x-injected": "unsafe" }));
        const target = `${fixture.origin}/echo?method=DELETE&headers=${injectedHeaders}&q=canonical#view`;
        const entry = await fetch(modeUrl(canonicalProxy.origin, "browser", target), {
            redirect: "manual"
        });
        const expectedLocation = toProxyUrl(target);

        assert.equal(entry.status, 302);
        assert.equal(entry.headers.get("location"), expectedLocation);
        assert.equal(entry.headers.get("set-cookie"), null);

        const response = await fetch(new URL(expectedLocation, canonicalProxy.origin), {
            headers: { "x-real-header": "preserved" }
        });
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.method, "GET");
        assert.equal(payload.headers["x-injected"], undefined);
        assert.equal(payload.headers["x-real-header"], "preserved");
        assert.equal(new URL(payload.url, fixture.origin).searchParams.get("method"), "DELETE");
        assert.equal(new URL(payload.url, fixture.origin).searchParams.get("q"), "canonical");
    } finally {
        await canonicalProxy.close();
    }
});

test("Browser safely recovers escaped root-relative GET and POST requests from a Canonical Referer", async () => {
    const recoveryProxy = await startProxy({ browser: { enabled: true } });
    try {
        const sourceUrl = `${fixture.origin}/html?source=root-recovery`;
        const canonicalReferer = `${recoveryProxy.origin}${toProxyUrl(sourceUrl)}`;
        const recovered = await fetch(`${recoveryProxy.origin}/echo?via=root`, {
            method: "POST",
            redirect: "manual",
            headers: {
                origin: recoveryProxy.origin,
                referer: canonicalReferer,
                "content-type": "text/plain"
            },
            body: "root-recovery-body"
        });

        assert.equal(recovered.status, 307);
        assert.equal(recovered.headers.get("location"), toProxyUrl(`${fixture.origin}/echo?via=root`));
        assert.equal(recovered.headers.get("cache-control"), "no-store");
        assert.match(recovered.headers.get("vary"), /Referer/i);
        assert.equal(recovered.headers.get("deprecation"), null);

        const canonicalResponse = await fetch(new URL(
            recovered.headers.get("location"),
            recoveryProxy.origin
        ), {
            method: "POST",
            headers: {
                origin: recoveryProxy.origin,
                referer: canonicalReferer,
                "content-type": "text/plain"
            },
            body: "root-recovery-body"
        });
        const payload = await canonicalResponse.json();
        assert.equal(canonicalResponse.status, 200);
        assert.equal(payload.method, "POST");
        assert.equal(payload.body, "root-recovery-body");
        assert.equal(payload.headers.referer, sourceUrl);
        assert.equal(payload.headers.origin, fixture.origin);

        const noReferer = await fetch(`${recoveryProxy.origin}/json`, { redirect: "manual" });
        assert.equal(noReferer.status, 400);
        assert.match(await noReferer.text(), /Proxy Service Ready/);
    } finally {
        await recoveryProxy.close();
    }
});

test("Browser entry preferences tighten rewrite, Cookie Jar and response header behavior per session", async () => {
    const preferenceProxy = await startProxy({ browser: { enabled: true } });
    try {
        const entryUrl = new URL(modeUrl(
            preferenceProxy.origin,
            "browser",
            `${fixture.origin}/html-relative`
        ));
        entryUrl.searchParams.set("rewriteHtml", "false");
        entryUrl.searchParams.set("rewriteCss", "false");
        entryUrl.searchParams.set("cookieJar", "false");
        entryUrl.searchParams.set("compatHeaders", "false");
        const entry = await fetch(entryUrl, { redirect: "manual" });
        const proxySessionCookie = entry.headers.get("set-cookie").split(";", 1)[0];

        assert.equal(entry.status, 302);
        const html = await fetch(new URL(entry.headers.get("location"), preferenceProxy.origin), {
            headers: { cookie: proxySessionCookie }
        });
        const htmlText = await html.text();
        assert.match(htmlText, /href="\/json\?via=html#result"/);
        assert.match(htmlText, /src="app\.js"/);
        assert.notEqual(html.headers.get("content-length"), null);

        const securityHeaders = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/security-headers`),
            preferenceProxy.origin
        ), {
            headers: { cookie: proxySessionCookie }
        });
        assert.equal(securityHeaders.headers.get("x-frame-options"), "DENY");
        assert.equal(securityHeaders.headers.get("content-security-policy"), "default-src 'none'");

        await fetch(new URL(toProxyUrl(`${fixture.origin}/cookie/set`), preferenceProxy.origin), {
            headers: { cookie: proxySessionCookie }
        });
        const cookieEcho = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cookie/echo`),
            preferenceProxy.origin
        ), {
            headers: { cookie: proxySessionCookie }
        });
        assert.equal((await cookieEcho.json()).cookie, "");
    } finally {
        await preferenceProxy.close();
    }
});

test("Browser entry rejects malformed preferences and cannot enable globally restricted behavior", async () => {
    const restrictedProxy = await startProxy({
        browser: {
            enabled: true,
            rewriteHtml: false,
            rewriteCss: false,
            cookieJar: false,
            headerPolicy: "strict"
        }
    });
    try {
        const malformedUrl = new URL(modeUrl(
            restrictedProxy.origin,
            "browser",
            `${fixture.origin}/html-relative`
        ));
        malformedUrl.searchParams.set("rewriteHtml", "sometimes");
        const malformed = await fetch(malformedUrl);
        assert.equal(malformed.status, 400);
        assert.equal((await malformed.json()).error.code, "PROXY_BROWSER_URL_INVALID");

        const attemptedEnable = new URL(modeUrl(
            restrictedProxy.origin,
            "browser",
            `${fixture.origin}/html-relative`
        ));
        attemptedEnable.searchParams.set("rewriteHtml", "true");
        attemptedEnable.searchParams.set("rewriteCss", "true");
        attemptedEnable.searchParams.set("cookieJar", "true");
        attemptedEnable.searchParams.set("compatHeaders", "true");
        const entry = await fetch(attemptedEnable, { redirect: "manual" });
        const proxySessionCookie = entry.headers.get("set-cookie").split(";", 1)[0];
        const html = await fetch(new URL(entry.headers.get("location"), restrictedProxy.origin), {
            headers: { cookie: proxySessionCookie }
        });
        assert.match(await html.text(), /src="app\.js"/);
        assert.notEqual(html.headers.get("content-length"), null);
    } finally {
        await restrictedProxy.close();
    }
});

test("canonical Browser tokens isolate origins and never bypass SSRF validation", async () => {
    const isolatedProxy = await startProxy({ browser: { enabled: true } }, {
        dnsRecords: {
            "other.test": [{ address: "93.184.216.35", family: 4 }]
        }
    });
    try {
        const port = new URL(fixture.origin).port;
        const firstPath = toProxyUrl(`${fixture.origin}/json?origin=first`);
        const secondPath = toProxyUrl(`http://other.test:${port}/json?origin=second`);
        const [first, second] = await Promise.all([
            fetch(new URL(firstPath, isolatedProxy.origin)),
            fetch(new URL(secondPath, isolatedProxy.origin))
        ]);
        assert.equal((await first.json()).query.origin, "first");
        assert.equal((await second.json()).query.origin, "second");

        const privatePath = toProxyUrl("http://127.0.0.1/private");
        const blocked = await fetch(new URL(privatePath, isolatedProxy.origin));
        assert.equal(blocked.status, 403);
        assert.equal((await blocked.json()).error.code, "PROXY_SSRF_BLOCKED");

        const invalid = await fetch(`${isolatedProxy.origin}/__proxyweb/browser/not+a-token/path`);
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).error.code, "PROXY_BROWSER_URL_INVALID");

        const token = toProxyUrl(`${fixture.origin}/`).split("/")[3];
        const malformed = await fetch(
            `${isolatedProxy.origin}/__proxyweb/browser/${token}/bad%zz`
        );
        assert.equal(malformed.status, 400);
        assert.equal((await malformed.json()).error.code, "PROXY_BROWSER_URL_INVALID");
    } finally {
        await isolatedProxy.close();
    }
});

test("API and Browser modes use independent response, CORS and redirect policies", async () => {
    const modeProxy = await startProxy({
        api: { maxRedirects: 0 },
        browser: { enabled: true, maxRedirects: 1, headerPolicy: "compat" }
    });
    try {
        const securedTarget = `${fixture.origin}/security-headers`;
        const apiResponse = await fetch(modeUrl(modeProxy.origin, "api", securedTarget), {
            headers: { origin: "http://frontend.test" }
        });
        assert.equal(apiResponse.status, 200);
        assert.equal(apiResponse.headers.get("x-frame-options"), "DENY");
        assert.equal(apiResponse.headers.get("content-security-policy"), "default-src 'none'");
        assert.equal(apiResponse.headers.get("access-control-allow-origin"), "http://frontend.test");

        const browserResponse = await fetch(modeUrl(modeProxy.origin, "browser", securedTarget), {
            headers: { origin: "http://frontend.test" }
        });
        assert.equal(browserResponse.status, 200);
        assert.equal(browserResponse.headers.get("x-frame-options"), null);
        assert.equal(browserResponse.headers.get("content-security-policy"), null);
        assert.equal(browserResponse.headers.get("content-security-policy-report-only"), null);
        assert.equal(browserResponse.headers.get("cross-origin-resource-policy"), null);
        assert.equal(browserResponse.headers.get("cross-origin-opener-policy"), null);
        assert.equal(browserResponse.headers.get("cross-origin-embedder-policy"), null);
        assert.equal(browserResponse.headers.get("clear-site-data"), null);
        assert.equal(browserResponse.headers.get("access-control-allow-origin"), null);
        assert.match(browserResponse.headers.get("set-cookie"), /^proxySession=/);

        const apiRedirect = await fetch(modeUrl(modeProxy.origin, "api", `${fixture.origin}/redirect`));
        assert.equal(apiRedirect.status, 508);
        const browserRedirect = await fetch(modeUrl(modeProxy.origin, "browser", `${fixture.origin}/redirect`));
        assert.equal(browserRedirect.status, 200);
        assert.equal((await browserRedirect.json()).query.via, "redirect");
    } finally {
        await modeProxy.close();
    }
});

test("strict Browser header policy preserves upstream embedding protections", async () => {
    const strictProxy = await startProxy({
        browser: { enabled: true, headerPolicy: "strict" }
    });
    try {
        const response = await fetch(modeUrl(
            strictProxy.origin,
            "browser",
            `${fixture.origin}/security-headers`
        ));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-frame-options"), "DENY");
        assert.equal(response.headers.get("content-security-policy"), "default-src 'none'");
        assert.equal(response.headers.get("content-security-policy-report-only"), "default-src 'self'");
        assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
        assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
        assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
        assert.equal(response.headers.get("clear-site-data"), "\"cache\"");
    } finally {
        await strictProxy.close();
    }
});

test("Browser Cookie Jar persists upstream cookies while isolating paths, hosts and sessions", async () => {
    const cookieProxy = await startProxy({ browser: { enabled: true, cookieJar: true } }, {
        dnsRecords: {
            "other.test": [{ address: "93.184.216.35", family: 4 }]
        }
    });
    try {
        const setResponse = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cookie/set`),
            cookieProxy.origin
        ));
        assert.equal(setResponse.status, 200);
        const downstreamSetCookie = setResponse.headers.get("set-cookie");
        assert.match(downstreamSetCookie, /^proxySession=/);
        assert.doesNotMatch(downstreamSetCookie, /hostOnly|scoped|secureOnly|expired/);
        const proxySessionCookie = downstreamSetCookie.split(";", 1)[0];

        const rootResponse = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cookie/echo`),
            cookieProxy.origin
        ), {
            headers: { cookie: proxySessionCookie }
        });
        const rootPayload = await rootResponse.json();
        assert.equal(rootPayload.cookie, "hostOnly=alpha");

        const scopedResponse = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cookie/scoped/echo`),
            cookieProxy.origin
        ), {
            headers: { cookie: proxySessionCookie }
        });
        const scopedPayload = await scopedResponse.json();
        assert.match(scopedPayload.cookie, /hostOnly=alpha/);
        assert.match(scopedPayload.cookie, /scoped=inside/);
        assert.doesNotMatch(scopedPayload.cookie, /secureOnly|expired/);

        const otherOrigin = `http://other.test:${fixture.port}`;
        const otherResponse = await fetch(new URL(
            toProxyUrl(`${otherOrigin}/cookie/echo`),
            cookieProxy.origin
        ), {
            headers: { cookie: proxySessionCookie }
        });
        assert.equal((await otherResponse.json()).cookie, "");

        const separateSession = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cookie/echo`),
            cookieProxy.origin
        ));
        assert.equal((await separateSession.json()).cookie, "");
    } finally {
        await cookieProxy.close();
    }
});

test("Browser Script Cookie Bridge forwards only the carrier bound to the current upstream origin", async () => {
    const cookieProxy = await startProxy({
        browser: { enabled: true, runtimeBridge: true, scriptCookieBridge: true }
    }, {
        dnsRecords: {
            "other.test": [{ address: "93.184.216.35", family: 4 }]
        }
    });
    try {
        const setResponse = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cookie/set`),
            cookieProxy.origin
        ));
        const proxySessionCookie = setResponse.headers.get("set-cookie").split(";", 1)[0];
        const target = `${fixture.origin}/cookie/echo`;
        const localCarrier = `${scriptCookiePrefix(target)}${encodeScriptCookieName("dscld")}=true`;
        const foreignTarget = `http://other.test:${fixture.port}/cookie/echo`;
        const foreignCarrier = `${scriptCookiePrefix(foreignTarget)}${encodeScriptCookieName("foreign")}=leak`;

        const response = await fetch(new URL(toProxyUrl(target), cookieProxy.origin), {
            headers: {
                cookie: `${proxySessionCookie}; ${localCarrier}; ${foreignCarrier}; unrelated=blocked`
            }
        });
        assert.equal((await response.json()).cookie, "hostOnly=alpha; dscld=true");
    } finally {
        await cookieProxy.close();
    }
});

test("Browser maps Origin and Referer from the source token across upstream origins", async () => {
    const headerProxy = await startProxy({ browser: { enabled: true } }, {
        dnsRecords: {
            "other.test": [{ address: "93.184.216.35", family: 4 }]
        }
    });
    try {
        const sourceUrl = `${fixture.origin}/page?from=browser`;
        const destinationUrl = `http://other.test:${fixture.port}/cookie/echo`;
        const response = await fetch(new URL(toProxyUrl(destinationUrl), headerProxy.origin), {
            headers: {
                origin: headerProxy.origin,
                referer: `${headerProxy.origin}${toProxyUrl(sourceUrl)}`
            }
        });
        const payload = await response.json();
        assert.equal(payload.origin, fixture.origin);
        assert.equal(payload.referer, sourceUrl);
        assert.equal(payload.host, `other.test:${fixture.port}`);
    } finally {
        await headerProxy.close();
    }
});

test("disabling Browser Cookie Jar neither stores nor exposes upstream cookies", async () => {
    const noCookieProxy = await startProxy({ browser: { enabled: true, cookieJar: false } });
    try {
        const setResponse = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cookie/set`),
            noCookieProxy.origin
        ));
        assert.equal(setResponse.headers.get("set-cookie"), null);

        const echoResponse = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cookie/echo`),
            noCookieProxy.origin
        ), {
            headers: { cookie: "hostOnly=client-injected" }
        });
        assert.equal((await echoResponse.json()).cookie, "");
        assert.equal(echoResponse.headers.get("set-cookie"), null);
    } finally {
        await noCookieProxy.close();
    }
});

test("Browser response pipeline transforms bounded text while streaming SSE and binary metadata", async () => {
    const pipelineProxy = await startProxy({ browser: { enabled: true } });
    try {
        const html = await fetch(new URL(toProxyUrl(`${fixture.origin}/html`), pipelineProxy.origin));
        assert.equal(html.status, 200);
        assert.match(await html.text(), /<body>pipeline<\/body>/);
        assert.equal(html.headers.get("content-length"), null);
        assert.equal(html.headers.get("etag"), null);
        assert.equal(html.headers.get("content-md5"), null);
        assert.equal(html.headers.get("last-modified"), null);
        assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");

        const compressed = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/gzip-html`),
            pipelineProxy.origin
        ));
        assert.equal(compressed.status, 200);
        assert.match(await compressed.text(), /<body>compressed<\/body>/);
        assert.equal(compressed.headers.get("content-encoding"), "gzip");
        assert.equal(compressed.headers.get("etag"), null);
        assert.equal(compressed.headers.get("content-md5"), null);

        const binary = await fetch(new URL(toProxyUrl(`${fixture.origin}/range`), pipelineProxy.origin));
        assert.equal(binary.status, 200);
        assert.equal((await binary.arrayBuffer()).byteLength, RANGE_BODY.length);
        assert.equal(binary.headers.get("content-length"), String(RANGE_BODY.length));
        assert.equal(binary.headers.get("etag"), '"fixture-range-etag"');

        const sse = await fetch(new URL(toProxyUrl(`${fixture.origin}/sse`), pipelineProxy.origin));
        assert.equal(await sse.text(), "data: first\n\ndata: second\n\n");
        assert.equal(sse.headers.get("etag"), '"fixture-sse-etag"');
    } finally {
        await pipelineProxy.close();
    }
});

test("Browser scoped response transform applies only to its literal host, path and MIME scope", async () => {
    const transformProxy = await startProxy({
        browser: {
            enabled: true,
            rewriteHtml: false,
            responseTransform: {
                enabled: true,
                rules: [{
                    id: "fixture-page",
                    hosts: ["fixture.test"],
                    pathPrefix: "/html",
                    contentTypes: ["text/html"],
                    replacements: [{
                        search: "pipeline",
                        replacement: "scoped-value",
                        mode: "all",
                        maxReplacements: 4
                    }],
                    appendHead: "<meta name=proxyweb-transform content=enabled>",
                    prependBody: "<div id=proxyweb-injected>injected</div>"
                }]
            }
        }
    });
    try {
        const response = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/html`),
            transformProxy.origin
        ));
        const $ = cheerio.load(await response.text());
        assert.equal($("meta[name=proxyweb-transform]").attr("content"), "enabled");
        assert.equal($("#proxyweb-injected").text(), "injected");
        assert.match($("body").text(), /scoped-value/);
        assert.equal(response.headers.get("content-length"), null);
        assert.equal(response.headers.get("etag"), null);
        assert.equal(response.headers.get("content-md5"), null);
        assert.equal(response.headers.get("last-modified"), null);

        const rewriteDisabled = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/html-relative`),
            transformProxy.origin
        ));
        const disabled$ = cheerio.load(await rewriteDisabled.text());
        assert.equal(disabled$("#navigation").attr("href"), "/json?via=html#result");
        assert.equal(disabled$("script[data-fireflyproxy-runtime]").length, 0);
        assert.equal(disabled$("meta[name=proxyweb-transform]").attr("content"), "enabled");

        const nonMatching = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/gzip-html`),
            transformProxy.origin
        ));
        assert.match(await nonMatching.text(), /compressed/);
        assert.equal(nonMatching.headers.get("etag"), '"fixture-gzip-etag"');
        assert.notEqual(nonMatching.headers.get("content-length"), null);
    } finally {
        await transformProxy.close();
    }
});

test("Browser scoped response transform hot reloads and rejects invalid replacement rules atomically", async () => {
    const hotTransformProxy = await startProxy({
        browser: {
            enabled: true,
            rewriteHtml: false,
            responseTransform: { enabled: false, rules: [] }
        }
    });
    const target = `${fixture.origin}/html`;
    const requestPage = () => fetch(new URL(toProxyUrl(target), hotTransformProxy.origin));
    try {
        assert.match(await (await requestPage()).text(), /pipeline/);

        const enabledConfig = {
            enabled: true,
            rules: [{
                id: "hot-page",
                hosts: ["fixture.test"],
                pathPrefix: "/html",
                contentTypes: ["text/html"],
                replacements: [{
                    search: "pipeline",
                    replacement: "hot-reloaded",
                    mode: "once",
                    maxReplacements: 1
                }]
            }]
        };
        let outputIndex = hotTransformProxy.getOutput().length;
        await hotTransformProxy.updateConfig({
            browser: { enabled: true, rewriteHtml: false, responseTransform: enabledConfig }
        });
        await hotTransformProxy.waitForOutput(/Configuration loaded/, outputIndex);
        assert.match(await (await requestPage()).text(), /hot-reloaded/);

        // Chokidar coalesces rapid writes on Windows. Cross that window so this
        // test observes a distinct second reload instead of a merged change.
        await new Promise(resolve => setTimeout(resolve, 150));
        outputIndex = hotTransformProxy.getOutput().length;
        await hotTransformProxy.updateConfig({
            browser: {
                enabled: true,
                rewriteHtml: false,
                responseTransform: {
                    enabled: true,
                    rules: [{
                        ...enabledConfig.rules[0],
                        replacements: [{ search: "", replacement: "invalid", mode: "once", maxReplacements: 1 }]
                    }]
                }
            }
        });
        await hotTransformProxy.waitForOutput(/CONFIG_SCHEMA_INVALID/, outputIndex);
        assert.match(await (await requestPage()).text(), /hot-reloaded/);
    } finally {
        await hotTransformProxy.close();
    }
});

test("Browser HTML Rewrite keeps resources, navigation, forms and inline CSS on canonical routes", async () => {
    const htmlProxy = await startProxy({ browser: { enabled: true } });
    try {
        const response = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/html-relative`),
            htmlProxy.origin
        ));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("etag"), null);
        const $ = cheerio.load(await response.text());

        assert.equal($("base").attr("href"), toProxyUrl(`${fixture.origin}/assets/`));
        assert.equal($("#stylesheet").attr("href"), toProxyUrl(`${fixture.origin}/assets/site.css`));
        assert.match($("#inline-sheet").html(), new RegExp(
            toProxyUrl(`${fixture.origin}/assets/inline-banner.png`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        ));
        assert.equal($("#navigation").attr("href"), toProxyUrl(`${fixture.origin}/json?via=html#result`));
        assert.equal($("#script").attr("src"), toProxyUrl(`${fixture.origin}/assets/app.js`));
        assert.equal($("#image").attr("src"), toProxyUrl(`${fixture.origin}/assets/logo.png`));
        assert.equal(
            $("#image").attr("srcset"),
            `${toProxyUrl(`${fixture.origin}/assets/small.png`)} 1x, ${toProxyUrl(`http://cdn.test:${fixture.port}/large.png`)} 2x`
        );
        assert.equal($("#form").attr("action"), toProxyUrl(`${fixture.origin}/echo`));
        assert.equal($("#frame").attr("src"), toProxyUrl(`${fixture.origin}/assets/frame.html`));
        assert.match($("#styled").attr("style"), new RegExp(
            toProxyUrl(`${fixture.origin}/assets/background.png`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        ));
        assert.equal($("meta[http-equiv=refresh]").attr("content"), `0; url=${toProxyUrl(`${fixture.origin}/landing`)}`);
        assert.equal($("#email").attr("href"), "mailto:test@example.com");

        const navigation = await fetch(new URL($("#navigation").attr("href"), htmlProxy.origin));
        assert.equal(navigation.status, 200);
        assert.equal((await navigation.json()).query.via, "html");
    } finally {
        await htmlProxy.close();
    }
});

test("Browser rewriteHtml=false preserves upstream HTML bytes and metadata", async () => {
    const passthroughProxy = await startProxy({
        browser: { enabled: true, rewriteHtml: false }
    });
    try {
        const response = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/html-relative`),
            passthroughProxy.origin
        ));
        const html = await response.text();

        assert.match(html, /href="\/json\?via=html#result"/);
        assert.match(html, /src="app\.js"/);
        assert.equal(response.headers.get("etag"), '"fixture-html-rewrite-etag"');
        assert.notEqual(response.headers.get("content-length"), null);
    } finally {
        await passthroughProxy.close();
    }
});

test("Browser CSS Rewrite maps url() and @import relative to the stylesheet URL", async () => {
    const cssProxy = await startProxy({ browser: { enabled: true } });
    try {
        const stylesheetUrl = `${fixture.origin}/styles/components/main.css`;
        const response = await fetch(new URL(toProxyUrl(stylesheetUrl), cssProxy.origin));
        const css = await response.text();

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("etag"), null);
        assert.equal(response.headers.get("content-length"), null);
        assert.match(css, new RegExp(
            toProxyUrl(`${fixture.origin}/styles/components/theme/base.css`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        ));
        assert.match(css, new RegExp(
            toProxyUrl(`${fixture.origin}/images/hero.png`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        ));
        assert.match(css, new RegExp(
            toProxyUrl(`http://cdn.test:${fixture.port}/icons.svg#check`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        ));
        assert.match(css, new RegExp(
            toProxyUrl(`${fixture.origin}/fonts/site.woff2`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        ));
        assert.match(css, /data:image\/png;base64,AAAA/);
    } finally {
        await cssProxy.close();
    }
});

test("Browser rewriteCss=false preserves upstream CSS bytes and metadata", async () => {
    const passthroughProxy = await startProxy({
        browser: { enabled: true, rewriteCss: false }
    });
    try {
        const response = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/styles/components/main.css`),
            passthroughProxy.origin
        ));
        const css = await response.text();

        assert.match(css, /url\("\.\.\/\.\.\/images\/hero\.png"\)/);
        assert.match(css, /@import "theme\/base\.css"/);
        assert.equal(response.headers.get("etag"), '"fixture-css-rewrite-etag"');
        assert.notEqual(response.headers.get("content-length"), null);
    } finally {
        await passthroughProxy.close();
    }
});

test("Browser redirects validate and rewrite Location without a server-side second hop", async () => {
    const locationProxy = await startProxy(
        { browser: { enabled: true } },
        { dnsRecords: {
            "cdn.test": [{ address: "93.184.216.35", family: 4 }]
        } }
    );
    try {
        const relative = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/redirect`),
            locationProxy.origin
        ), { redirect: "manual" });
        const expectedRelative = toProxyUrl(`${fixture.origin}/json?via=redirect`);
        assert.equal(relative.status, 302);
        assert.equal(relative.headers.get("location"), expectedRelative);

        const followed = await fetch(new URL(expectedRelative, locationProxy.origin));
        assert.equal(followed.status, 200);
        assert.equal((await followed.json()).query.via, "redirect");

        const crossOriginTarget = `http://cdn.test:${fixture.port}/login?from=redirect`;
        const crossOrigin = await fetch(new URL(
            toProxyUrl(fixtureRedirect(crossOriginTarget)),
            locationProxy.origin
        ), { redirect: "manual" });
        assert.equal(crossOrigin.status, 302);
        assert.equal(crossOrigin.headers.get("location"), toProxyUrl(crossOriginTarget));

        const privateTarget = fixtureRedirect("http://127.0.0.1/private");
        const blocked = await fetch(new URL(
            toProxyUrl(privateTarget),
            locationProxy.origin
        ), { redirect: "manual" });
        assert.equal(blocked.status, 403);
        assert.equal((await blocked.json()).error.code, "PROXY_SSRF_BLOCKED");
    } finally {
        await locationProxy.close();
    }
});

test("Browser transform limits fail before response headers with a stable error", async () => {
    const boundedPipelineProxy = await startProxy({
        browser: { enabled: true },
        security: { maxRewriteBytes: 16 }
    });
    try {
        const response = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/large-html?size=64`),
            boundedPipelineProxy.origin
        ));
        assert.equal(response.status, 413);
        assert.deepEqual(await response.json(), {
            error: {
                code: "PROXY_REWRITE_LIMIT",
                message: "Response exceeds rewrite size limit"
            }
        });
        const healthy = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/range`),
            boundedPipelineProxy.origin
        ));
        assert.equal(healthy.status, 200);
        assert.equal((await healthy.arrayBuffer()).byteLength, RANGE_BODY.length);
    } finally {
        await boundedPipelineProxy.close();
    }
});

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`${method} streams body and custom headers`, async () => {
        const response = await fetch(proxyUrl(`${fixture.origin}/echo`, {
            "x-upstream-token": `token-${method.toLowerCase()}`
        }), {
            method,
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: `body-${method.toLowerCase()}`
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.method, method);
        assert.equal(payload.headers["x-upstream-token"], `token-${method.toLowerCase()}`);
        assert.equal(payload.body, `body-${method.toLowerCase()}`);
    });
}

test("HEAD preserves status and response headers", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/json`), { method: "HEAD" });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fixture"), "json");
    assert.equal(await response.text(), "");
});

test("upstream error status and body pass through", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/status/418`));
    const payload = await response.json();

    assert.equal(response.status, 418);
    assert.deepEqual(payload, { status: 418 });
});

test("validated redirect loop follows relative and absolute Location values", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/redirect`));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.query.via, "redirect");

    const absoluteTarget = `${fixture.origin}/json?via=absolute`;
    const absolute = await fetch(proxyUrl(fixtureRedirect(absoluteTarget)));
    assert.equal(absolute.status, 200);
    assert.equal((await absolute.json()).query.via, "absolute");
});

test("API redirect controls expose trustworthy final URL and ordered chain diagnostics", async () => {
    const target = `${fixture.origin}/redirect-chain/2`;
    const response = await fetch(apiControlUrl(proxy.origin, target, {
        followRedirects: true,
        maxRedirects: 2
    }), { headers: { origin: "http://frontend.test" } });
    const chain = decodeDiagnosticHeader(response, "x-proxyweb-redirect-chain");

    assert.equal(response.status, 200);
    assert.equal(decodeDiagnosticHeader(response, "x-proxyweb-final-url"), `${fixture.origin}/redirect-chain/0`);
    assert.deepEqual(chain.map(entry => [entry.status, entry.url, entry.location, entry.followed]), [
        [302, `${fixture.origin}/redirect-chain/2`, `${fixture.origin}/redirect-chain/1`, true],
        [302, `${fixture.origin}/redirect-chain/1`, `${fixture.origin}/redirect-chain/0`, true]
    ]);
    assert.equal(response.headers.get("x-proxyweb-redirect-count"), "2");
    assert.equal(response.headers.get("x-proxyweb-follow-redirects"), "true");
    assert.equal(response.headers.get("x-proxyweb-max-redirects"), "2");
    assert.match(response.headers.get("access-control-expose-headers"), /x-proxyweb-final-url/i);
    assert.match(response.headers.get("access-control-expose-headers"), /x-proxyweb-redirect-chain/i);
});

test("API no-follow diagnostics preserve the first response without validating its target", async () => {
    const target = `${fixture.origin}/redirect`;
    const response = await fetch(apiControlUrl(proxy.origin, target, {
        followRedirects: false,
        maxRedirects: 5
    }), { redirect: "manual" });
    const chain = decodeDiagnosticHeader(response, "x-proxyweb-redirect-chain");

    assert.equal(response.status, 302);
    assert.equal(decodeDiagnosticHeader(response, "x-proxyweb-final-url"), target);
    assert.equal(response.headers.get("x-proxyweb-follow-redirects"), "false");
    assert.deepEqual(chain, [{
        status: 302,
        method: "GET",
        url: target,
        location: `${fixture.origin}/json?via=redirect`,
        followed: false,
        validated: false
    }]);
});

test("API request controls cannot loosen global redirect policy and reject malformed values", async () => {
    const limited = await fetch(apiControlUrl(proxy.origin, `${fixture.origin}/redirect-chain/2`, {
        followRedirects: true,
        maxRedirects: 1
    }));
    assert.equal(limited.status, 508);
    assert.equal((await limited.json()).error.code, "PROXY_REDIRECT_LIMIT");
    const limitedChain = decodeDiagnosticHeader(limited, "x-proxyweb-redirect-chain");
    assert.equal(limitedChain.length, 2);
    assert.deepEqual(limitedChain.map(entry => entry.followed), [true, false]);

    const invalid = await fetch(`${modeUrl(proxy.origin, "api", `${fixture.origin}/json`)}&followRedirects=true&followRedirects=false`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "PROXY_REQUEST_CONTROL_INVALID");

    const noFollowProxy = await startProxy({ api: { followRedirects: false, maxRedirects: 1 } });
    try {
        const response = await fetch(apiControlUrl(noFollowProxy.origin, `${fixture.origin}/redirect`, {
            followRedirects: true,
            maxRedirects: 20
        }), { redirect: "manual" });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get("x-proxyweb-follow-redirects"), "false");
        assert.equal(response.headers.get("x-proxyweb-max-redirects"), "1");
    } finally {
        await noFollowProxy.close();
    }
});

test("upstream cannot spoof reserved API diagnostic headers", async () => {
    const target = `${fixture.origin}/diagnostic-spoof`;
    const response = await fetch(modeUrl(proxy.origin, "api", target));
    assert.equal(response.status, 200);
    assert.equal(decodeDiagnosticHeader(response, "x-proxyweb-final-url"), target);
    assert.deepEqual(decodeDiagnosticHeader(response, "x-proxyweb-redirect-chain"), []);
});

test("disabled redirect following returns the original 3xx response", async () => {
    const noFollowProxy = await startProxy({
        api: { followRedirects: false, maxRedirects: 5 }
    });
    try {
        const response = await fetch(
            `${noFollowProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/redirect`)}`,
            { redirect: "manual" }
        );
        assert.equal(response.status, 302);
        assert.equal(response.headers.get("location"), "/json?via=redirect");
    } finally {
        await noFollowProxy.close();
    }
});

test("redirect loops and configured redirect limits fail with a stable 508 error", async () => {
    const loopResponse = await fetch(proxyUrl(`${fixture.origin}/redirect-loop-a`));
    assert.equal(loopResponse.status, 508);
    assert.equal((await loopResponse.json()).error.code, "PROXY_REDIRECT_LIMIT");

    const limitedProxy = await startProxy({ max_redirects: 1 });
    try {
        const response = await fetch(
            `${limitedProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/redirect-chain/2`)}`
        );
        assert.equal(response.status, 508);
        assert.equal((await response.json()).error.code, "PROXY_REDIRECT_LIMIT");
    } finally {
        await limitedProxy.close();
    }
});

test("redirect status codes apply explicit method and request body rules", async () => {
    const cases = [
        { status: 301, method: "POST", expectedMethod: "GET", expectedBody: "" },
        { status: 302, method: "POST", expectedMethod: "GET", expectedBody: "" },
        { status: 303, method: "PUT", expectedMethod: "GET", expectedBody: "" },
        { status: 307, method: "POST", expectedMethod: "POST", expectedBody: "body-307" },
        { status: 308, method: "PUT", expectedMethod: "PUT", expectedBody: "body-308" }
    ];

    for (const item of cases) {
        const body = `body-${item.status}`;
        const response = await fetch(proxyUrl(fixtureRedirect("/echo", item.status)), {
            method: item.method,
            headers: { "content-type": "text/plain" },
            body
        });
        const payload = await response.json();
        assert.equal(response.status, 200, String(item.status));
        assert.equal(payload.method, item.expectedMethod, String(item.status));
        assert.equal(payload.body, item.expectedBody, String(item.status));
        if (item.expectedMethod === "GET") {
            assert.equal(payload.headers["content-type"], undefined, String(item.status));
            assert.equal(payload.headers["content-length"], undefined, String(item.status));
        }
    }

    const early = await fetch(proxyUrl(`${fixture.origin}/redirect-early`), {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "body-from-early-redirect"
    });
    const earlyPayload = await early.json();
    assert.equal(early.status, 200);
    assert.equal(earlyPayload.method, "POST");
    assert.equal(earlyPayload.body, "body-from-early-redirect");
});

test("streamed response reaches the client intact", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/stream`));

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "chunk-1|chunk-2|chunk-3");
});

test("request timeout returns a stable 504 response", async () => {
    const timeoutProxy = await startProxy({ timeoutMs: 25 });
    try {
        const target = `${fixture.origin}/slow?ms=100`;
        const response = await fetch(`${timeoutProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(response.status, 504);
        assert.equal((await response.json()).error.code, "PROXY_REQUEST_TIMEOUT");
    } finally {
        await timeoutProxy.close();
    }
});

test("request body and concurrent proxy work stay within configured bounds", async () => {
    const boundedProxy = await startProxy({
        api: {
            maxRequestBodyBytes: 4,
            maxConcurrentRequests: 1
        }
    });
    try {
        const oversized = await fetch(
            `${boundedProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/echo`)}`,
            { method: "POST", body: "12345" }
        );
        assert.equal(oversized.status, 413);
        assert.equal((await oversized.json()).error.code, "PROXY_REQUEST_BODY_LIMIT");

        const slowTarget = `${fixture.origin}/slow?ms=150`;
        const first = fetch(`${boundedProxy.origin}/?url=${encodeURIComponent(slowTarget)}`);
        await new Promise(resolve => setTimeout(resolve, 30));
        const rejected = await fetch(
            `${boundedProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`
        );
        assert.equal(rejected.status, 503);
        assert.equal((await rejected.json()).error.code, "PROXY_CONCURRENCY_LIMIT");
        assert.equal((await first).status, 200);
    } finally {
        await boundedProxy.close();
    }
});

test("client disconnect cancels upstream work without destabilizing the process", async () => {
    const target = `${fixture.origin}/slow?ms=200`;
    const url = new URL(`${proxy.origin}/?url=${encodeURIComponent(target)}`);
    await new Promise(resolve => {
        const request = http.get(url);
        request.once("error", resolve);
        request.once("close", resolve);
        setTimeout(() => request.destroy(), 20);
    });

    const healthy = await fetch(proxyUrl(`${fixture.origin}/json?after=disconnect`));
    assert.equal(healthy.status, 200);
    assert.equal((await healthy.json()).query.after, "disconnect");
});

for (const path of ["/abrupt", "/malformed-length"]) {
    test(`interrupted upstream stream ${path} is contained at the route boundary`, async () => {
        await assert.rejects(async () => {
            const response = await fetch(proxyUrl(`${fixture.origin}${path}`));
            await response.arrayBuffer();
        });

        const healthy = await fetch(proxyUrl(`${fixture.origin}/json?after=stream-error`));
        assert.equal(healthy.status, 200);
    });
}

test("API streaming is not buffered by the smaller rewrite limit", async () => {
    const streamingProxy = await startProxy({ security: { maxRewriteBytes: 16 } });
    try {
        const response = await fetch(
            `${streamingProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/bytes?size=65536`)}`
        );
        assert.equal(response.status, 200);
        assert.equal((await response.arrayBuffer()).byteLength, 65536);
    } finally {
        await streamingProxy.close();
    }
});

test("session maxAge expires stored targets", async () => {
    const expiringProxy = await startProxy({ session: { maxAgeMs: 50 } });
    try {
        const initial = await fetch(
            `${expiringProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`
        );
        const cookie = initial.headers.get("set-cookie");
        assert.ok(cookie && cookie.includes("proxySession="));
        await new Promise(resolve => setTimeout(resolve, 100));

        const expired = await fetch(`${expiringProxy.origin}/echo`, {
            headers: { cookie: cookie.split(";", 1)[0] }
        });
        assert.equal(expired.status, 400);
    } finally {
        await expiringProxy.close();
    }
});

test("Range request preserves 206 and Content-Range", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/range`), {
        headers: { range: "bytes=5-9" }
    });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes 5-9/${RANGE_BODY.length}`);
    assert.equal(await response.text(), RANGE_BODY.subarray(5, 10).toString("utf8"));
});

test("session target supports a later path request", async () => {
    const initial = await fetch(proxyUrl(`${fixture.origin}/json`));
    const cookie = initial.headers.get("set-cookie");
    assert.ok(cookie && cookie.includes("proxySession="));

    const response = await fetch(`${proxy.origin}/echo?session=yes`, {
        headers: { cookie: cookie.split(";", 1)[0] }
    });
    const payload = await response.json();

    assert.equal(payload.url, "/echo?session=yes");
});

test("configured proxy Basic Auth rejects missing credentials and accepts valid credentials", async () => {
    const authProxy = await startProxy({ user: "proxy-user", pwd: "proxy-password" });
    try {
        const target = `${fixture.origin}/json`;
        const unauthorized = await fetch(`${authProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(unauthorized.status, 401);

        const authorized = await fetch(`${authProxy.origin}/?url=${encodeURIComponent(target)}`, {
            headers: {
                authorization: `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`
            }
        });
        assert.equal(authorized.status, 200);
    } finally {
        await authProxy.close();
    }
});

test("CORS preflight returns configured origin and credentials policy", async () => {
    const response = await fetch(`${proxy.origin}/`, {
        method: "OPTIONS",
        headers: {
            origin: "http://frontend.test",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type,x-requested-with,x-fireflyproxy-upstream-referer"
        }
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://frontend.test");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.match(response.headers.get("access-control-allow-headers"), /x-requested-with/);
    assert.match(response.headers.get("access-control-allow-headers"), /x-fireflyproxy-upstream-referer/);
    assert.match(response.headers.get("vary"), /Origin/);
});

test("API response CORS policy cannot be overwritten by upstream CORS headers", async () => {
    const response = await fetch(modeUrl(proxy.origin, "api", `${fixture.origin}/cors-headers`), {
        headers: { origin: "http://frontend.test" }
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://frontend.test");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.equal(response.headers.get("access-control-allow-methods"), null);
    assert.equal(response.headers.get("access-control-allow-headers"), null);
    assert.equal(response.headers.get("access-control-max-age"), null);
    assert.doesNotMatch(response.headers.get("access-control-expose-headers") || "", /x-upstream-policy-only/i);
    assert.match(response.headers.get("vary"), /Origin/i);
    assert.match(response.headers.get("vary"), /Accept-Encoding/i);
});

test("credentialed CORS rejects arbitrary and malformed Origins", async () => {
    for (const origin of ["https://evil.test", "https://frontend.test/path", "not-an-origin"]) {
        const response = await fetch(`${proxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`, {
            headers: { origin }
        });
        const payload = await response.json();

        assert.equal(response.status, 403);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        assert.match(response.headers.get("vary"), /Origin/);
        assert.equal(payload.error.code, "PROXY_CORS_ORIGIN_DENIED");
    }
});

test("allowed and missing Origins receive distinct CORS responses", async () => {
    const target = `${fixture.origin}/json`;
    const allowed = await fetch(`${proxy.origin}/?url=${encodeURIComponent(target)}`, {
        headers: { origin: "http://frontend.test" }
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://frontend.test");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");

    const noOrigin = await fetch(`${proxy.origin}/?url=${encodeURIComponent(target)}`, {
        headers: { referer: "https://evil.test/page" }
    });
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
    assert.equal(noOrigin.headers.get("access-control-allow-credentials"), null);
});

test("wildcard CORS is only emitted without credentials", async () => {
    const wildcardProxy = await startProxy({
        cors: { allowedOrigins: ["*"], allowCredentials: false }
    });
    try {
        const response = await fetch(`${wildcardProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`, {
            headers: { origin: "https://anywhere.test" }
        });

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        assert.equal(response.headers.get("access-control-allow-credentials"), null);
    } finally {
        await wildcardProxy.close();
    }
});

test("CORS preflight rejects unsupported methods and malformed requested headers", async () => {
    const unsupported = await fetch(`${proxy.origin}/`, {
        method: "OPTIONS",
        headers: {
            origin: "http://frontend.test",
            "access-control-request-method": "TRACE"
        }
    });
    assert.equal(unsupported.status, 403);
    assert.equal((await unsupported.json()).error.code, "PROXY_CORS_METHOD_DENIED");

    const malformedHeaders = await fetch(`${proxy.origin}/`, {
        method: "OPTIONS",
        headers: {
            origin: "http://frontend.test",
            "access-control-request-method": "POST",
            "access-control-request-headers": "x-valid, bad header"
        }
    });
    assert.equal(malformedHeaders.status, 400);
    assert.equal((await malformedHeaders.json()).error.code, "PROXY_CORS_HEADERS_INVALID");

    const ordinaryOptions = await fetch(`${proxy.origin}/`, { method: "OPTIONS" });
    assert.equal(ordinaryOptions.status, 400);
    assert.equal(ordinaryOptions.headers.get("access-control-allow-origin"), null);
});

test("rate limiter can reject requests after the configured maximum", async () => {
    const limitedProxy = await startProxy({ limiter: { windowMs: 60000, max: 1 } });
    try {
        const target = `${fixture.origin}/json`;
        const first = await fetch(`${limitedProxy.origin}/?url=${encodeURIComponent(target)}`);
        const second = await fetch(`${limitedProxy.origin}/?url=${encodeURIComponent(target)}`);

        assert.equal(first.status, 200);
        assert.equal(second.status, 429);
        assert.equal(await second.text(), "fixture rate limit");
    } finally {
        await limitedProxy.close();
    }
});

test("rate limiter can be disabled and re-enabled through hot configuration", async () => {
    const toggleProxy = await startProxy({ limiter: { enabled: false, windowMs: 60000, max: 1 } });
    try {
        const target = `${fixture.origin}/json`;
        const first = await fetch(`${toggleProxy.origin}/?url=${encodeURIComponent(target)}`);
        const second = await fetch(`${toggleProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);

        const outputIndex = toggleProxy.getOutput().length;
        await toggleProxy.updateConfig({ limiter: { enabled: true } });
        await toggleProxy.waitForOutput(/RateLimiter reloaded dynamically/, outputIndex);

        const limitedFirst = await fetch(`${toggleProxy.origin}/?url=${encodeURIComponent(target)}`);
        const limitedSecond = await fetch(`${toggleProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(limitedFirst.status, 200);
        assert.equal(limitedSecond.status, 429);
    } finally {
        await toggleProxy.close();
    }
});

test("default trustProxy ignores spoofed X-Forwarded-For for rate-limit identity", async () => {
    const directProxy = await startProxy({
        trustProxy: false,
        limiter: { windowMs: 60000, max: 1 }
    });
    try {
        const target = `${fixture.origin}/json`;
        const first = await fetch(`${directProxy.origin}/?url=${encodeURIComponent(target)}`, {
            headers: { "x-forwarded-for": "198.51.100.10" }
        });
        const second = await fetch(`${directProxy.origin}/?url=${encodeURIComponent(target)}`, {
            headers: { "x-forwarded-for": "198.51.100.11" }
        });

        assert.equal(first.status, 200);
        assert.equal(second.status, 429);
    } finally {
        await directProxy.close();
    }
});

test("numeric trustProxy uses the configured proxy hop count", async () => {
    const target = `${fixture.origin}/json`;
    for (const [trustProxy, expectedIp] of [[1, "203.0.113.20"], [2, "198.51.100.10"]]) {
        const trustedProxy = await startProxy({ trustProxy });
        try {
            const outputIndex = trustedProxy.getOutput().length;
            const response = await fetch(`${trustedProxy.origin}/?url=${encodeURIComponent(target)}`, {
                headers: { "x-forwarded-for": "198.51.100.10, 203.0.113.20" }
            });
            assert.equal(response.status, 200);
            await trustedProxy.waitForOutput(/Incoming request/, outputIndex);
            assert.match(trustedProxy.getOutput().slice(outputIndex), new RegExp(`"ip":"${expectedIp}"`));
        } finally {
            await trustedProxy.close();
        }
    }
});

test("authentication configuration hot reload affects later requests", async () => {
    const hotProxy = await startProxy();
    try {
        const target = `${fixture.origin}/json`;
        const beforeReload = await fetch(`${hotProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(beforeReload.status, 200);

        const outputIndex = hotProxy.getOutput().length;
        await hotProxy.updateConfig({ user: "hot-user", pwd: "hot-password" });
        await hotProxy.waitForOutput(/Configuration loaded/, outputIndex);

        const afterReload = await fetch(`${hotProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(afterReload.status, 401);
    } finally {
        await hotProxy.close();
    }
});

test("stored session targets are revalidated against hot-loaded hostname rules", async () => {
    const hotProxy = await startProxy();
    try {
        const initial = await fetch(`${hotProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`);
        assert.equal(initial.status, 200);
        const cookie = initial.headers.get("set-cookie");
        assert.ok(cookie && cookie.includes("proxySession="));

        const outputIndex = hotProxy.getOutput().length;
        await hotProxy.updateConfig({
            security: { blockedHostnames: ["fixture.test"] }
        });
        await hotProxy.waitForOutput(/Configuration loaded/, outputIndex);

        const afterReload = await fetch(`${hotProxy.origin}/echo`, {
            headers: { cookie: cookie.split(";", 1)[0] }
        });
        assert.equal(afterReload.status, 403);
        assert.equal((await afterReload.json()).error.code, "PROXY_SSRF_BLOCKED");
    } finally {
        await hotProxy.close();
    }
});

test("invalid configuration reload keeps the previous working configuration", async () => {
    const hotProxy = await startProxy();
    try {
        const outputIndex = hotProxy.getOutput().length;
        await fs.writeFile(hotProxy.configPath, "{ invalid json", "utf8");
        await hotProxy.waitForOutput(/Error loading config/, outputIndex);

        const response = await fetch(`${hotProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`);
        assert.equal(response.status, 200);
    } finally {
        await hotProxy.close();
    }
});

test("schema-invalid configuration reload is rejected atomically", async () => {
    const hotProxy = await startProxy();
    try {
        const outputIndex = hotProxy.getOutput().length;
        await hotProxy.updateConfig({ limiter: { max: 0 } });
        await hotProxy.waitForOutput(/CONFIG_SCHEMA_INVALID/, outputIndex);

        const response = await fetch(`${hotProxy.origin}/?url=${encodeURIComponent(`${fixture.origin}/json`)}`);
        assert.equal(response.status, 200);
    } finally {
        await hotProxy.close();
    }
});

test("invalid targets use the stable public error envelope", async () => {
    const response = await fetch(`${proxy.origin}/?url=${encodeURIComponent("not-a-url")}`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
    assert.deepEqual(payload, {
        error: {
            code: "PROXY_INVALID_URL",
            message: "Target URL is invalid"
        }
    });
});

test("an explicitly empty target uses the same invalid URL envelope", async () => {
    const response = await fetch(`${proxy.origin}/?url=`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        error: {
            code: "PROXY_INVALID_URL",
            message: "Target URL is invalid"
        }
    });
});

test("target validation distinguishes protocols and non-public literal addresses", async () => {
    const cases = [
        ["ftp://example.test/file", "PROXY_PROTOCOL_BLOCKED"],
        ["http://localhost/", "PROXY_SSRF_BLOCKED"],
        ["http://127.1/", "PROXY_SSRF_BLOCKED"],
        ["http://[::1]/", "PROXY_SSRF_BLOCKED"],
        ["http://[::ffff:127.0.0.1]/", "PROXY_SSRF_BLOCKED"]
    ];

    for (const [target, code] of cases) {
        const response = await fetch(`${proxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error.code, code);
    }
});

test("reserved security flags cannot disable literal address validation", async () => {
    const hardenedProxy = await startProxy({
        security: {
            ssrf: false,
            allowPrivateNetworks: true,
            blockedHostnames: []
        }
    });
    try {
        const response = await fetch(`${hardenedProxy.origin}/?url=${encodeURIComponent("http://127.0.0.1/")}`);
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error.code, "PROXY_SSRF_BLOCKED");
    } finally {
        await hardenedProxy.close();
    }
});

test("URL credentials are rejected without reaching request or error logs", async () => {
    const credentialProxy = await startProxy();
    const secret = "url-password-must-not-appear";
    try {
        const outputIndex = credentialProxy.getOutput().length;
        const target = `http://user:${secret}@fixture.test/echo`;
        const response = await fetch(`${credentialProxy.origin}/?url=${encodeURIComponent(target)}`);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, "PROXY_INVALID_URL");
        await credentialProxy.waitForOutput(/PROXY_INVALID_URL/, outputIndex);
        assert.doesNotMatch(credentialProxy.getOutput().slice(outputIndex), new RegExp(secret));
    } finally {
        await credentialProxy.close();
    }
});

test("configured hostname rules block exact hosts and wildcard subdomains", async () => {
    const blockedProxy = await startProxy({
        security: { blockedHostnames: ["blocked.test", "*.internal.test"] }
    });
    try {
        for (const target of ["http://blocked.test/", "https://api.internal.test/path"]) {
            const response = await fetch(`${blockedProxy.origin}/?url=${encodeURIComponent(target)}`);
            assert.equal(response.status, 403);
            assert.equal((await response.json()).error.code, "PROXY_SSRF_BLOCKED");
        }
    } finally {
        await blockedProxy.close();
    }
});

test("upstream connection failures do not expose internal network details", async () => {
    const target = "http://fixture.test:1/unavailable";
    const response = await fetch(`${proxy.origin}/?url=${encodeURIComponent(target)}`);
    const text = await response.text();

    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(text), {
        error: {
            code: "PROXY_UPSTREAM_ERROR",
            message: "Upstream request failed"
        }
    });
    assert.doesNotMatch(text, /ECONNREFUSED|127\.0\.0\.1|node_modules|app\.js/);
});

test("proxy Basic Auth credentials are removed while dedicated upstream auth is preserved", async () => {
    const authProxy = await startProxy({ user: "proxy-user", pwd: "proxy-password" });
    const proxyAuthorization = `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`;
    const upstreamAuthorization = "Bearer dedicated-upstream-token";
    try {
        const target = `${fixture.origin}/echo`;
        const response = await fetch(`${authProxy.origin}/?url=${encodeURIComponent(target)}`, {
            headers: {
                authorization: proxyAuthorization,
                "x-proxyweb-upstream-authorization": upstreamAuthorization
            }
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.headers.authorization, upstreamAuthorization);
        assert.equal(payload.headers["x-proxyweb-upstream-authorization"], undefined);
        assert.doesNotMatch(JSON.stringify(payload.headers), /proxy-password|cHJveHktdXNlcjpwcm94eS1wYXNzd29yZA==/);

        const proxyOnly = await fetch(`${authProxy.origin}/?url=${encodeURIComponent(target)}`, {
            headers: { authorization: proxyAuthorization }
        });
        const proxyOnlyPayload = await proxyOnly.json();
        assert.equal(proxyOnlyPayload.headers.authorization, undefined);
    } finally {
        await authProxy.close();
    }
});

test("API Referer uses a dedicated control header without trusting the browser Referer", async () => {
    const target = `${fixture.origin}/echo`;
    const response = await fetch(modeUrl(proxy.origin, "api", target), {
        headers: {
            origin: "http://frontend.test",
            referer: "http://frontend.test/editor",
            "x-fireflyproxy-upstream-referer": "https://qifu.baidu.com/"
        }
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.headers.referer, "https://qifu.baidu.com/");
    assert.equal(payload.headers["x-fireflyproxy-upstream-referer"], undefined);
});

test("legacy headers query remains compatible and advertises deprecation", async () => {
    const response = await fetch(proxyUrl(`${fixture.origin}/echo`, {
        authorization: "Bearer legacy-upstream-token"
    }));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.headers.authorization, "Bearer legacy-upstream-token");
    assert.equal(response.headers.get("deprecation"), "true");
    assert.match(response.headers.get("warning"), /headers query parameter is deprecated/);
});

test("domain targets with private, mixed, empty or failed DNS results are rejected", async () => {
    const dnsProxy = await startProxy({}, {
        dnsRecords: {
            "private.test": [{ address: "10.0.0.1", family: 4 }],
            "mixed.test": [
                { address: "93.184.216.34", family: 4 },
                { address: "127.0.0.1", family: 4 }
            ],
            "empty.test": [],
            "missing.test": { error: "ENOTFOUND" }
        }
    });
    try {
        for (const hostname of ["private.test", "mixed.test"]) {
            const response = await fetch(`${dnsProxy.origin}/?url=${encodeURIComponent(`http://${hostname}/`)}`);
            assert.equal(response.status, 403);
            assert.equal((await response.json()).error.code, "PROXY_SSRF_BLOCKED");
        }
        for (const hostname of ["empty.test", "missing.test"]) {
            const response = await fetch(`${dnsProxy.origin}/?url=${encodeURIComponent(`http://${hostname}/`)}`);
            assert.equal(response.status, 502);
            assert.equal((await response.json()).error.code, "PROXY_DNS_FAILED");
        }
    } finally {
        await dnsProxy.close();
    }
});
test("every redirect target is revalidated before connecting", async () => {
    const privateTarget = `http://127.0.0.1:${new URL(fixture.origin).port}/echo`;
    const response = await fetch(proxyUrl(fixtureRedirect(privateTarget)));

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "PROXY_SSRF_BLOCKED");
});

test("cross-origin redirects remove authentication, cookies and token-like headers", async () => {
    const crossOriginProxy = await startProxy({}, {
        dnsRecords: {
            "other.test": [{ address: "93.184.216.35", family: 4 }]
        }
    });
    try {
        const fixturePort = new URL(fixture.origin).port;
        const crossOriginTarget = `http://other.test:${fixturePort}/echo`;
        const query = new URLSearchParams({
            url: fixtureRedirect(crossOriginTarget),
            headers: JSON.stringify({
                "x-api-key": "cross-origin-api-key",
                "x-upstream-token": "cross-origin-token",
                "x-safe": "keep"
            })
        });
        const response = await fetch(`${crossOriginProxy.origin}/?${query}`, {
            headers: {
                cookie: "proxy-client-cookie=secret",
                "x-proxyweb-upstream-authorization": "Bearer cross-origin-authorization"
            }
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.headers.host, `other.test:${fixturePort}`);
        assert.equal(payload.headers.authorization, undefined);
        assert.equal(payload.headers.cookie, undefined);
        assert.equal(payload.headers["x-api-key"], undefined);
        assert.equal(payload.headers["x-upstream-token"], undefined);
        assert.equal(payload.headers["x-safe"], "keep");
    } finally {
        await crossOriginProxy.close();
    }
});

test("redirect chain logs redact sensitive URL query values", async () => {
    const redirectLogProxy = await startProxy();
    const secret = "redirect-log-secret-789";
    try {
        const outputIndex = redirectLogProxy.getOutput().length;
        const location = `/json?token=${secret}`;
        const response = await fetch(
            `${redirectLogProxy.origin}/?url=${encodeURIComponent(fixtureRedirect(location))}`
        );
        assert.equal(response.status, 200);
        await redirectLogProxy.waitForOutput(/Following validated redirect/, outputIndex);

        const output = redirectLogProxy.getOutput().slice(outputIndex);
        assert.doesNotMatch(output, new RegExp(secret));
        assert.match(output, /\[REDACTED\]/);
    } finally {
        await redirectLogProxy.close();
    }
});

test("validated DNS addresses are pinned without a second system lookup", async () => {
    const pinnedProxy = await startProxy({}, {
        dnsRecords: {
            "rebind.test": [{ address: "93.184.216.34", family: 4 }]
        }
    });
    try {
        const fixturePort = new URL(fixture.origin).port;
        const target = `http://rebind.test:${fixturePort}/echo`;
        const response = await fetch(`${pinnedProxy.origin}/?url=${encodeURIComponent(target)}`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.headers.host, `rebind.test:${fixturePort}`);
    } finally {
        await pinnedProxy.close();
    }
});

test("request and error logs redact legacy and dedicated upstream credentials", async () => {
    const logProxy = await startProxy();
    const legacySecret = "legacy-log-secret-123";
    const dedicatedSecret = "dedicated-log-secret-456";
    try {
        const outputIndex = logProxy.getOutput().length;
        const legacyResponse = await fetch(`${logProxy.origin}/?${new URLSearchParams({
            url: `${fixture.origin}/echo`,
            headers: JSON.stringify({ authorization: `Bearer ${legacySecret}` })
        })}`);
        assert.equal(legacyResponse.status, 200);

        const errorResponse = await fetch(`${logProxy.origin}/?url=${encodeURIComponent("http://fixture.test:1/unavailable")}`, {
            headers: {
                "x-proxyweb-upstream-authorization": `Bearer ${dedicatedSecret}`
            }
        });
        assert.equal(errorResponse.status, 502);
        await logProxy.waitForOutput(/Request failed/, outputIndex);

        const output = logProxy.getOutput().slice(outputIndex);
        assert.doesNotMatch(output, new RegExp(`${legacySecret}|${dedicatedSecret}`));
        assert.match(output, /\[REDACTED\]/);
    } finally {
        await logProxy.close();
    }
});
