const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const cheerio = require("cheerio");
const { RUNTIME_BRIDGE_SOURCE } = require("../../browser-proxy/runtimeBridge");
const { toProxyUrl } = require("../../core/urlMapper");
const { createUpstreamFixture } = require("../fixtures/upstream-server");
const { startProxy } = require("../helpers/proxy-process");

let fixture;

before(async () => {
    fixture = await createUpstreamFixture();
});

after(async () => {
    await fixture.close();
});

function browserEntry(proxy, target, runtimeBridge) {
    const entry = new URL("/__proxyweb/browser", proxy.origin);
    entry.searchParams.set("url", target);
    if (runtimeBridge !== undefined) entry.searchParams.set("runtimeBridge", String(runtimeBridge));
    return entry;
}

test("enabled Runtime Bridge injects before upstream scripts and is served with defensive headers", async () => {
    const proxy = await startProxy({ browser: { enabled: true, runtimeBridge: true } });
    try {
        const response = await fetch(new URL(toProxyUrl(`${fixture.origin}/html-relative`), proxy.origin));
        const $ = cheerio.load(await response.text());
        const scripts = $("head script");

        assert.equal(scripts.first().attr("src"), "/__proxyweb/runtime.js");
        assert.equal(scripts.first().attr("data-proxyweb-runtime"), `${fixture.origin}/html-relative`);
        assert.equal($("script[data-proxyweb-runtime]").length, 1);

        const runtime = await fetch(new URL("/__proxyweb/runtime.js", proxy.origin));
        assert.equal(runtime.status, 200);
        assert.equal(runtime.headers.get("content-type"), "application/javascript; charset=utf-8");
        assert.equal(runtime.headers.get("cache-control"), "no-store");
        assert.equal(runtime.headers.get("x-content-type-options"), "nosniff");
        assert.equal(await runtime.text(), RUNTIME_BRIDGE_SOURCE);
    } finally {
        await proxy.close();
    }
});

test("Runtime Bridge preference can disable injection and script delivery but cannot enable a global restriction", async () => {
    for (const globalRuntimeBridge of [true, false]) {
        const proxy = await startProxy({
            browser: { enabled: true, runtimeBridge: globalRuntimeBridge }
        });
        try {
            const requestedPreference = globalRuntimeBridge ? false : true;
            const entry = await fetch(
                browserEntry(proxy, `${fixture.origin}/html-relative`, requestedPreference),
                { redirect: "manual" }
            );
            const cookie = entry.headers.get("set-cookie").split(";", 1)[0];
            const page = await fetch(new URL(entry.headers.get("location"), proxy.origin), {
                headers: { cookie }
            });
            const $ = cheerio.load(await page.text());
            assert.equal($("script[data-proxyweb-runtime]").length, 0);

            const runtime = await fetch(new URL("/__proxyweb/runtime.js", proxy.origin), {
                headers: { cookie }
            });
            assert.equal(runtime.status, 404);
            assert.equal((await runtime.json()).error.code, "PROXY_ROUTE_NOT_FOUND");
        } finally {
            await proxy.close();
        }
    }
});

test("disabling HTML Rewrite also disables the effective Runtime Bridge", async () => {
    const proxy = await startProxy({
        browser: { enabled: true, rewriteHtml: false, runtimeBridge: true }
    });
    try {
        const page = await fetch(new URL(toProxyUrl(`${fixture.origin}/html-relative`), proxy.origin));
        assert.doesNotMatch(await page.text(), /data-proxyweb-runtime/);
        const runtime = await fetch(new URL("/__proxyweb/runtime.js", proxy.origin));
        assert.equal(runtime.status, 404);
    } finally {
        await proxy.close();
    }
});
