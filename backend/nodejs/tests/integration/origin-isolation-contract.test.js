const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, test } = require("node:test");
const cheerio = require("cheerio");
const { isolatedProxyOrigin } = require("../../core/originIsolation");
const { toProxyUrl } = require("../../core/urlMapper");
const { createUpstreamFixture } = require("../fixtures/upstream-server");
const { startProxy } = require("../helpers/proxy-process");

let fixture;
let proxy;
let isolation;

function transportUrl(canonicalUrl) {
    const url = new URL(canonicalUrl);
    return `${proxy.origin}${url.pathname}${url.search}`;
}

function hostHeader(origin) {
    return new URL(origin).host;
}

function requestProxy(path, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: "127.0.0.1",
            port: proxy.port,
            path,
            headers
        }, response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => resolve({
                status: response.statusCode,
                headers: response.headers,
                text: Buffer.concat(chunks).toString("utf8"),
                json() { return JSON.parse(this.text); }
            }));
        });
        request.on("error", reject);
        request.end();
    });
}

before(async () => {
    fixture = await createUpstreamFixture();
    proxy = await startProxy(port => ({
        browser: {
            enabled: true,
            runtimeBridge: true,
            originIsolation: {
                enabled: true,
                baseOrigin: `http://browse.proxy.test:${port}`
            }
        }
    }), {
        fixtureHosts: ["fixture.test", "cdn.test"],
        dnsRecords: {
            "cdn.test": [{ address: "93.184.216.35", family: 4 }]
        }
    });
    isolation = proxy
        ? { enabled: true, baseOrigin: `http://browse.proxy.test:${proxy.port}` }
        : null;
});

after(async () => {
    await proxy.close();
    await fixture.close();
});

test("base entry redirects to the derived origin and shares only the HttpOnly control session", async () => {
    const entry = new URL("/__proxyweb/browser", proxy.origin);
    entry.searchParams.set("url", `${fixture.origin}/json?entry=isolated`);
    entry.searchParams.set("runtimeBridge", "true");
    const response = await requestProxy(`${entry.pathname}${entry.search}`, {
        host: hostHeader(isolation.baseOrigin)
    });
    const expected = toProxyUrl(`${fixture.origin}/json?entry=isolated`, { originIsolation: isolation });

    assert.equal(response.status, 302);
    assert.equal(response.headers.location, expected);
    assert.match(String(response.headers["set-cookie"] || ""), /Domain=browse\.proxy\.test/i);
    assert.match(String(response.headers["set-cookie"] || ""), /HttpOnly/i);
});

test("canonical child host succeeds while a mismatched label and non-browser route fail closed", async () => {
    const target = `${fixture.origin}/json?child=valid`;
    const canonical = toProxyUrl(target, { originIsolation: isolation });
    const validUrl = new URL(transportUrl(canonical));
    const valid = await requestProxy(`${validUrl.pathname}${validUrl.search}`, {
        host: hostHeader(new URL(canonical).origin)
    });
    assert.equal(valid.status, 200);
    assert.equal(valid.json().query.child, "valid");

    const mismatched = await requestProxy(`${validUrl.pathname}${validUrl.search}`, {
        host: `o-${"f".repeat(32)}.browse.proxy.test:${proxy.port}`
    });
    assert.equal(mismatched.status, 421);
    assert.equal(mismatched.json().error.code, "PROXY_ORIGIN_ISOLATION_DENIED");

    const isolatedOrigin = isolatedProxyOrigin(new URL(target).origin, isolation);
    const api = await requestProxy(`/__proxyweb/api?url=${encodeURIComponent(target)}`, {
        host: hostHeader(isolatedOrigin)
    });
    assert.equal(api.status, 421);
});

test("cross-upstream source headers are restored only from a matching isolated Referer", async () => {
    const sourceUrl = `${fixture.origin}/page`;
    const destinationUrl = `http://cdn.test:${fixture.port}/echo`;
    const sourceProxyUrl = toProxyUrl(sourceUrl, { originIsolation: isolation });
    const destinationProxyUrl = toProxyUrl(destinationUrl, { originIsolation: isolation });
    const destinationTransport = new URL(transportUrl(destinationProxyUrl));
    const response = await requestProxy(`${destinationTransport.pathname}${destinationTransport.search}`, {
        host: hostHeader(new URL(destinationProxyUrl).origin),
        origin: new URL(sourceProxyUrl).origin,
        referer: sourceProxyUrl
    });
    const payload = response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.headers.origin, new URL(sourceUrl).origin);
    assert.equal(payload.headers.referer, sourceUrl);
});

test("escaped root-relative navigation is recovered only on its matching isolated origin", async () => {
    const sourceUrl = `${fixture.origin}/page`;
    const sourceProxyUrl = toProxyUrl(sourceUrl, { originIsolation: isolation });
    const recoveredTarget = `${fixture.origin}/json?root=isolated`;
    const response = await requestProxy("/json?root=isolated", {
        host: hostHeader(new URL(sourceProxyUrl).origin),
        origin: new URL(sourceProxyUrl).origin,
        referer: sourceProxyUrl
    });

    assert.equal(response.status, 307);
    assert.equal(response.headers.location, toProxyUrl(recoveredTarget, { originIsolation: isolation }));
    assert.equal(response.headers["cache-control"], "no-store");

    const untrusted = await requestProxy("/json?root=denied", {
        host: hostHeader(new URL(sourceProxyUrl).origin),
        referer: "http://attacker.test/page"
    });
    assert.equal(untrusted.status, 421);
    assert.equal(untrusted.json().error.code, "PROXY_ORIGIN_ISOLATION_DENIED");
});

test("HTML rewrite emits absolute isolated origins and configures the Runtime mapper", async () => {
    const target = `${fixture.origin}/html-relative`;
    const canonical = toProxyUrl(target, { originIsolation: isolation });
    const transport = new URL(transportUrl(canonical));
    const response = await requestProxy(`${transport.pathname}${transport.search}`, {
        host: hostHeader(new URL(canonical).origin)
    });
    const $ = cheerio.load(response.text);

    assert.equal(response.status, 200);
    assert.equal(
        $("#image").attr("src"),
        toProxyUrl(`${fixture.origin}/assets/logo.png`, { originIsolation: isolation })
    );
    assert.match(
        $("#image").attr("srcset"),
        new RegExp(isolatedProxyOrigin(`http://cdn.test:${fixture.port}`, isolation).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    assert.equal(
        $("script[data-proxyweb-runtime]").attr("data-proxyweb-isolation-base-origin"),
        isolation.baseOrigin
    );
});
