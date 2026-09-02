const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
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

async function removeSharedDirectory(directory) {
    const root = path.resolve(os.tmpdir());
    const target = path.resolve(directory);
    assert.ok(target.startsWith(`${root}${path.sep}proxyweb-shared-runtime-`));
    await fs.rm(target, { recursive: true, force: true });
}

function sessionCookie(response) {
    return response.headers.get("set-cookie")?.split(";", 1)[0] || "";
}

test("two backend processes continue one Browser session through SQLite runtime state", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxyweb-shared-runtime-"));
    const sqlitePath = path.join(directory, "runtime.sqlite");
    const overrides = {
        runtimeState: { backend: "sqlite", sqlitePath, busyTimeoutMs: 5000 },
        browser: { enabled: true, rewriteCss: true, cookieJar: true }
    };
    const first = await startProxy(overrides);
    const second = await startProxy(overrides);
    try {
        const entry = new URL("/__proxyweb/browser", first.origin);
        entry.searchParams.set("url", `${fixture.origin}/cookie/set`);
        entry.searchParams.set("rewriteCss", "false");
        const entryResponse = await fetch(entry, { redirect: "manual" });
        assert.equal(entryResponse.status, 302);
        const cookie = sessionCookie(entryResponse);
        assert.match(cookie, /^proxySession=/);

        const setCookie = await fetch(new URL(entryResponse.headers.get("location"), first.origin), {
            headers: { cookie }
        });
        assert.equal(setCookie.status, 200);
        await setCookie.arrayBuffer();

        const echo = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cookie/echo`),
            second.origin
        ), { headers: { cookie } });
        assert.equal(echo.status, 200);
        const echoed = await echo.json();
        assert.match(echoed.cookie, /hostOnly=alpha/);

        const css = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cache/public.css`),
            second.origin
        ), { headers: { cookie } });
        assert.equal(css.status, 200);
        const cssBody = await css.text();
        assert.match(cssBody, /url\('\/cache\/public\.png\?case=css'\)/);
        assert.doesNotMatch(cssBody, /__proxyweb\/browser/);

        await first.close();
        const afterShutdown = await fetch(new URL(
            toProxyUrl(`${fixture.origin}/cookie/echo`),
            second.origin
        ), { headers: { cookie } });
        assert.match((await afterShutdown.json()).cookie, /hostOnly=alpha/);
    } finally {
        await first.close();
        await second.close();
        await removeSharedDirectory(directory);
    }
});
