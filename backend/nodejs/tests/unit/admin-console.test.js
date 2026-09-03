const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { createDefaultConfig } = require("../../config/defaults");
const {
    changedRestartFields,
    createAdminSnapshot,
    restoreSecretValues
} = require("../../admin-console/configManager");
const {
    adminApiSourceAllowed,
    adminPageSourceAllowed,
    authenticateAdmin,
    createAdminHomeMarker,
    isAdminPath,
    safeCredentialEqual
} = require("../../admin-console/router");
const { createAdminPage } = require("../../admin-console/page");

function sourceRequest(path, referer, fetchSite) {
    return {
        protocol: "https",
        headers: {
            host: "proxy.test",
            ...(referer ? { referer } : {}),
            ...(fetchSite ? { "sec-fetch-site": fetchSite } : {})
        },
        session: {},
        path
    };
}

function authorization(user, password) {
    return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

test("admin route matching is exact to the configured path namespace", () => {
    assert.equal(isAdminPath("/control", "/control"), true);
    assert.equal(isAdminPath("/control/api/config", "/control"), true);
    assert.equal(isAdminPath("/controller", "/control"), false);
});

test("admin home marker applies only to an unclaimed GET homepage", () => {
    const middleware = createAdminHomeMarker({
        getConfig: () => ({
            admin: { enabled: true },
            defaultSkip: ""
        })
    });
    const homepage = { method: "GET", path: "/", query: {}, session: {} };
    middleware(homepage, {}, () => {});
    assert.equal(homepage.fireflyProxyAdminHome, true);

    for (const request of [
        { method: "POST", path: "/", query: {}, session: {} },
        { method: "GET", path: "/", query: { url: "https://example.test" }, session: {} },
        { method: "GET", path: "/", query: {}, session: { targetUrl: "https://example.test" } }
    ]) {
        middleware(request, {}, () => {});
        assert.equal(request.fireflyProxyAdminHome, undefined);
    }
});

test("admin page ships a standalone syntactically valid management client", () => {
    const html = createAdminPage();
    const start = html.indexOf("<script>") + "<script>".length;
    const end = html.lastIndexOf("</script>");
    assert.ok(start > 0 && end > start);
    assert.doesNotThrow(() => new vm.Script(html.slice(start, end), {
        filename: "fireflyproxy-admin-inline.js"
    }));
    assert.doesNotMatch(html, /admin-password|session-secret/);
    assert.match(html, /browser\.responseTransform\.enabled/);
    assert.match(html, /browser\.responseTransform\.rules/);
    assert.match(html, /browser\.publicCache\.enabled/);
    assert.match(html, /browser\.publicCache\.maxObjectBytes/);
    assert.match(html, /runtimeState\.backend/);
    assert.match(html, /runtimeState\.sqlitePath/);
    assert.match(html, /audit\.enabled/);
    assert.match(html, /clientAccessControl\.neverBlock/);
    assert.match(html, /请求与操作记录/);
    assert.match(html, /data-record-tab="bans"/);
    assert.match(html, /FireflyProxy 管理面板/);
    assert.match(html, /开启（true）/);
    assert.match(html, /data-unit-for/);
    assert.match(html, /HTML 文字替换/);
    assert.match(html, /HTML 注入/);
    assert.match(html, /深色模式/);
    assert.match(html, /搜索参数、说明或路径/);
});

test("admin source checks reject Browser Canonical pages even on the same proxy origin", () => {
    assert.equal(adminApiSourceAllowed(
        sourceRequest("/control/api/config", "https://proxy.test/control"),
        "/control"
    ), true);
    assert.equal(adminApiSourceAllowed(
        sourceRequest(
            "/control/api/config",
            "https://proxy.test/__proxyweb/browser/token/page"
        ),
        "/control"
    ), false);
    assert.equal(adminPageSourceAllowed(
        sourceRequest("/control", null, "same-origin"),
        "/control"
    ), false);
    assert.equal(adminPageSourceAllowed(
        sourceRequest("/control", null, "none"),
        "/control"
    ), true);
});

test("admin authentication consumes credentials and uses an independent identity", () => {
    const config = createDefaultConfig({ PROXYWEB_SESSION_SECRET: "unit-secret" });
    config.admin = { enabled: true, path: "/control", user: "admin-user", pwd: "admin-password" };
    const request = {
        headers: { authorization: authorization("admin-user", "admin-password") }
    };

    assert.equal(authenticateAdmin(request, config), true);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(safeCredentialEqual("same", "same"), true);
    assert.equal(safeCredentialEqual("same", "different"), false);
});

test("admin snapshots redact every secret and null keeps raw placeholders on save", () => {
    const config = createDefaultConfig({ PROXYWEB_SESSION_SECRET: "resolved-session-secret" });
    config.pwd = "proxy-secret";
    config.admin = { enabled: true, path: "/admin", user: "admin", pwd: "admin-secret" };
    const snapshot = createAdminSnapshot(config);

    assert.equal(snapshot.config.pwd, null);
    assert.equal(snapshot.config.session.secret, null);
    assert.equal(snapshot.config.admin.pwd, null);
    assert.deepEqual(snapshot.secrets, {
        pwd: true,
        "session.secret": true,
        "admin.pwd": true
    });

    const restored = restoreSecretValues(snapshot.config, {
        session: { secret: "${PROXYWEB_SESSION_SECRET}" },
        admin: { pwd: "raw-admin-secret" }
    }, config);
    assert.equal(restored.pwd, "proxy-secret");
    assert.equal(restored.session.secret, "${PROXYWEB_SESSION_SECRET}");
    assert.equal(restored.admin.pwd, "raw-admin-secret");
});

test("restart detection includes startup-bound state settings and the cache directory", () => {
    const current = createDefaultConfig({ PROXYWEB_SESSION_SECRET: "restart-secret" });
    const hot = structuredClone(current);
    hot.timeoutMs += 1;
    hot.admin.path = "/settings";
    assert.deepEqual(changedRestartFields(current, hot), []);

    const restart = structuredClone(current);
    restart.port += 1;
    restart.session.maxAgeMs += 1;
    restart.runtimeState.backend = "sqlite";
    restart.audit.backend = "sqlite";
    restart.browser.publicCache.directory = "./another-cache";
    assert.deepEqual(changedRestartFields(current, restart), [
        "port",
        "session",
        "runtimeState",
        "audit.backend/sqlitePath",
        "browser.publicCache.directory"
    ]);
});
