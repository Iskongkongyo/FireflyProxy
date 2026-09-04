const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { test } = require("node:test");
const { startProxy } = require("../helpers/proxy-process");

function authorization(user, password) {
    return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

test("admin console protects, redacts, validates and hot-moves its configuration route", async () => {
    const proxy = await startProxy({
        user: "proxy-user",
        pwd: "proxy-password",
        admin: {
            enabled: true,
            path: "/control",
            user: "admin-user",
            pwd: "admin-password"
        }
    });
    const originalAuth = authorization("admin-user", "admin-password");
    try {
        const home = await fetch(`${proxy.origin}/`, { redirect: "manual" });
        assert.equal(home.status, 302);
        assert.equal(home.headers.get("location"), "/control");

        const unauthorized = await fetch(`${proxy.origin}/control`);
        assert.equal(unauthorized.status, 401);
        assert.match(unauthorized.headers.get("www-authenticate"), /FireflyProxy Admin/);

        const page = await fetch(`${proxy.origin}/control`, {
            headers: { authorization: originalAuth }
        });
        assert.equal(page.status, 200);
        assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
        assert.match(page.headers.get("content-security-policy"), /img-src data:/);
        const pageHtml = await page.text();
        assert.match(pageHtml, /FireflyProxy 管理面板/);
        assert.match(pageHtml, /<link rel="icon" type="image\/jpeg" href="data:image\/jpeg;base64,/);
        assert.match(pageHtml, /<img class="brand-mark" src="data:image\/jpeg;base64,/);
        assert.match(pageHtml, /系统配置/);
        assert.match(pageHtml, /白名单与黑名单/);
        assert.match(pageHtml, /请求与操作记录/);
        assert.match(pageHtml, /security\.accessControl\.allowed/);

        const snapshotResponse = await fetch(`${proxy.origin}/control/api/config`, {
            headers: {
                authorization: originalAuth,
                referer: `${proxy.origin}/control`
            }
        });
        const snapshot = await snapshotResponse.json();
        assert.equal(snapshotResponse.status, 200);
        assert.equal(snapshot.config.pwd, null);
        assert.equal(snapshot.config.session.secret, null);
        assert.equal(snapshot.config.admin.pwd, null);
        assert.equal(snapshot.secrets["session.secret"], true);

        const browserSource = await fetch(`${proxy.origin}/control/api/config`, {
            headers: {
                authorization: originalAuth,
                referer: `${proxy.origin}/__proxyweb/browser/token/page`
            }
        });
        assert.equal(browserSource.status, 403);
        assert.equal((await browserSource.json()).error.code, "PROXY_ADMIN_ORIGIN_DENIED");

        const rejected = await fetch(`${proxy.origin}/control/api/config`, {
            method: "PUT",
            headers: {
                authorization: originalAuth,
                origin: "http://attacker.test",
                referer: `${proxy.origin}/control`,
                "content-type": "application/json",
                "x-fireflyproxy-admin": "1"
            },
            body: JSON.stringify({ config: snapshot.config })
        });
        assert.equal(rejected.status, 403);
        assert.equal((await rejected.json()).error.code, "PROXY_ADMIN_ORIGIN_DENIED");

        const fileBeforeInvalidSave = await fs.readFile(proxy.configPath, "utf8");
        const invalidConfig = structuredClone(snapshot.config);
        invalidConfig.port = 70000;
        const invalidSave = await fetch(`${proxy.origin}/control/api/config`, {
            method: "PUT",
            headers: {
                authorization: originalAuth,
                origin: proxy.origin,
                referer: `${proxy.origin}/control`,
                "content-type": "application/json",
                "x-fireflyproxy-admin": "1"
            },
            body: JSON.stringify({ config: invalidConfig })
        });
        assert.equal(invalidSave.status, 400);
        assert.equal((await invalidSave.json()).error.code, "PROXY_ADMIN_CONFIG_INVALID");
        assert.equal(await fs.readFile(proxy.configPath, "utf8"), fileBeforeInvalidSave);

        snapshot.config.timeoutMs = 43210;
        snapshot.config.admin.path = "/settings/secure";
        snapshot.config.admin.pwd = "new-admin-password";
        const saved = await fetch(`${proxy.origin}/control/api/config`, {
            method: "PUT",
            headers: {
                authorization: originalAuth,
                origin: proxy.origin,
                referer: `${proxy.origin}/control`,
                "content-type": "application/json",
                "x-fireflyproxy-admin": "1"
            },
            body: JSON.stringify({ config: snapshot.config })
        });
        const result = await saved.json();
        assert.equal(saved.status, 200);
        assert.equal(result.ok, true);
        assert.equal(result.adminPath, "/settings/secure");
        assert.equal(result.adminCredentialsChanged, true);
        assert.deepEqual(result.restartRequired, []);

        const oldCredentials = await fetch(`${proxy.origin}/settings/secure/api/config`, {
            headers: {
                authorization: originalAuth,
                referer: `${proxy.origin}/settings/secure`
            }
        });
        assert.equal(oldCredentials.status, 401);
        const moved = await fetch(`${proxy.origin}/settings/secure/api/config`, {
            headers: {
                authorization: authorization("admin-user", "new-admin-password"),
                referer: `${proxy.origin}/settings/secure`
            }
        });
        assert.equal(moved.status, 200);
        assert.equal((await moved.json()).config.timeoutMs, 43210);

        const written = JSON.parse(await fs.readFile(proxy.configPath, "utf8"));
        assert.equal(written.session.secret, "proxyweb-contract-test-secret");
        assert.equal(written.admin.pwd, "new-admin-password");
        assert.equal(written.timeoutMs, 43210);
    } finally {
        await proxy.close();
    }
});
