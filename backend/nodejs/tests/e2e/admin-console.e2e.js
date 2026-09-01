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
        assert.equal(await page.locator("h1").textContent(), "proxyWeb 配置管理");
        assert.equal(await page.locator('[data-path="admin.pwd"]').inputValue(), "");
        assert.match(
            await page.locator('[data-path="session.secret"]').getAttribute("placeholder"),
            /已配置/
        );

        await page.locator('[data-path="timeoutMs"]').fill("45678");
        await page.locator('[data-path="admin.path"]').fill("/manage/settings");
        await page.locator("#save").click();
        await page.waitForURL(`${proxy.origin}/manage/settings`, { timeout: 10000 });
        await page.waitForSelector('[data-path="timeoutMs"]');
        assert.equal(await page.locator('[data-path="timeoutMs"]').inputValue(), "45678");

        const written = JSON.parse(await fs.readFile(proxy.configPath, "utf8"));
        assert.equal(written.timeoutMs, 45678);
        assert.equal(written.admin.path, "/manage/settings");
        assert.equal(written.admin.pwd, "admin-password");
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
