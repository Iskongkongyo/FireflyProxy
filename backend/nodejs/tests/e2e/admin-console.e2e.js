const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { chromium } = require("playwright-core");
const { findBrowserExecutable } = require("../helpers/browser-executable");
const { startProxy } = require("../helpers/proxy-process");

async function run() {
    let proxy;
    let browser;
    try {
        proxy = await startProxy({
            admin: {
                enabled: true,
                path: "/control",
                user: "admin-user",
                pwd: "admin-password"
            }
        });
        const browserPath = findBrowserExecutable();
        browser = await chromium.launch({
            executablePath: browserPath,
            headless: true,
            args: ["--disable-background-networking", "--no-first-run"]
        });
        const context = await browser.newContext({
            httpCredentials: { username: "admin-user", password: "admin-password" }
        });
        const page = await context.newPage();
        page.on("console", message => {
            if (message.type() === "error") {
                process.stderr.write(`[Admin E2E console:error] ${message.text()}\n`);
            }
        });
        page.on("pageerror", error => process.stderr.write(`[Admin E2E pageerror] ${error.message}\n`));
        await page.goto(`${proxy.origin}/`, { waitUntil: "domcontentloaded" });

        assert.equal(new URL(page.url()).pathname, "/control");
        assert.equal(await page.locator("h1").textContent(), "系统配置");
        assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
        await page.locator("#theme").click();
        assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
        await page.reload({ waitUntil: "domcontentloaded" });
        assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
        await page.locator("#theme").click();

        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.locator("#mobile-menu").isVisible(), true);
        assert.equal(await page.evaluate(() => (
            document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )), true);
        await page.locator("#mobile-menu").click();
        assert.match(await page.locator("body").getAttribute("class"), /nav-open/);
        await page.locator('[data-nav="section-admin"]').click();
        assert.doesNotMatch(await page.locator("body").getAttribute("class") || "", /nav-open/);
        await page.setViewportSize({ width: 1440, height: 1000 });
        assert.equal(await page.locator('[data-path="admin.pwd"]').inputValue(), "");
        assert.match(
            await page.locator('[data-path="session.secret"]').getAttribute("placeholder"),
            /已配置/
        );
        assert.equal(await page.locator('[data-path="browser.responseTransform.enabled"]').inputValue(), "false");
        assert.equal(await page.locator('[data-path="browser.publicCache.enabled"]').inputValue(), "false");
        assert.equal(await page.locator('[data-path="runtimeState.backend"]').inputValue(), "memory");
        assert.equal(await page.locator('[data-path="browser.publicCache.maxBytes"]').inputValue(), "256");
        assert.equal(
            await page.locator('[data-unit-for="browser.publicCache.maxBytes"]').inputValue(),
            "1048576"
        );
        await page.waitForFunction(() => document.querySelector("#audit-summary")?.textContent.includes("审计当前关闭"));
        await page.locator('[data-record-tab="bans"]').click();
        await page.waitForFunction(() => document.querySelector("#protected-list")?.textContent.includes("127.0.0.1"));
        await page.locator("#ban-rule").fill("203.0.113.9");
        await page.locator("#ban-reason").fill("管理页面端到端测试");
        await page.locator("#ban-add").click();
        await page.waitForSelector('[data-unban]');
        assert.match(await page.locator("#ban-body").textContent(), /203\.0\.113\.9/);

        await page.locator('[data-template="html"]').click();
        const templateRules = JSON.parse(
            await page.locator('[data-path="browser.responseTransform.rules"]').inputValue()
        );
        assert.equal(templateRules[0].id, "html-text-example");

        await page.locator("#search").fill("缓存总容量");
        assert.equal(await page.locator("#section-cache").isVisible(), true);
        assert.equal(await page.locator("#section-admin").isVisible(), false);
        await page.locator("#search").fill("");

        await page.locator('[data-path="timeoutMs"]').fill("45678");
        await page.locator('[data-path="admin.path"]').fill("/manage/settings");
        await page.locator('[data-path="browser.responseTransform.enabled"]').selectOption("true");
        await page.locator('[data-path="browser.publicCache.enabled"]').selectOption("true");
        await page.locator('[data-path="browser.publicCache.ttlMs"]').fill("90000");
        await page.locator('[data-path="browser.publicCache.maxBytes"]').fill("512");
        await page.locator('[data-unit-for="browser.publicCache.maxBytes"]').selectOption("1048576");
        await page.locator('[data-path="browser.publicCache.maxObjectBytes"]').fill("6");
        await page.locator('[data-unit-for="browser.publicCache.maxObjectBytes"]').selectOption("1048576");
        await page.locator('[data-path="runtimeState.busyTimeoutMs"]').fill("6000");
        await page.locator('[data-path="browser.responseTransform.rules"]').fill(JSON.stringify([{
            id: "admin-saved-rule",
            hosts: ["example.test"],
            pathPrefix: "/app/",
            contentTypes: ["text/html"],
            replacements: [{ search: "before", replacement: "after", mode: "once", maxReplacements: 1 }]
        }]));
        await page.locator("#save").click();
        await page.waitForURL(`${proxy.origin}/manage/settings`, { timeout: 10000 });
        await page.waitForSelector('[data-path="timeoutMs"]');
        assert.equal(await page.locator('[data-path="timeoutMs"]').inputValue(), "45678");

        const written = JSON.parse(await fs.readFile(proxy.configPath, "utf8"));
        assert.equal(written.timeoutMs, 45678);
        assert.equal(written.admin.path, "/manage/settings");
        assert.equal(written.admin.pwd, "admin-password");
        assert.equal(written.browser.responseTransform.enabled, true);
        assert.equal(written.browser.responseTransform.rules[0].id, "admin-saved-rule");
        assert.equal(written.browser.publicCache.enabled, true);
        assert.equal(written.browser.publicCache.ttlMs, 90000);
        assert.equal(written.browser.publicCache.maxBytes, 512 * 1024 * 1024);
        assert.equal(written.browser.publicCache.maxObjectBytes, 6 * 1024 * 1024);
        assert.equal(written.runtimeState.busyTimeoutMs, 6000);
        process.stdout.write(`[Admin E2E] PASS (${browser.version()})\n`);
    } catch (error) {
        process.stderr.write(`[Admin E2E] FAIL\n${error.stack || error.message}\n`);
        process.exitCode = 1;
    } finally {
        await browser?.close().catch(() => {});
        await proxy?.close().catch(() => {});
    }
}

run();
