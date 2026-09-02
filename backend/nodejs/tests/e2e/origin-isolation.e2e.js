const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");
const { toProxyUrl } = require("../../core/urlMapper");
const { createBrowserE2eFixture } = require("../fixtures/browser-e2e-site");
const { findBrowserExecutable } = require("../helpers/browser-executable");
const { startProxy } = require("../helpers/proxy-process");

async function run() {
    let fixture;
    let proxy;
    let browser;
    try {
        const browserPath = findBrowserExecutable();
        fixture = await createBrowserE2eFixture();
        proxy = await startProxy(port => ({
            browser: {
                enabled: true,
                runtimeBridge: true,
                webSocket: true,
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
        const isolation = {
            enabled: true,
            baseOrigin: `http://browse.proxy.test:${proxy.port}`
        };

        const args = [
            "--disable-background-networking",
            "--no-first-run",
            "--host-resolver-rules=MAP *.proxy.test 127.0.0.1"
        ];
        if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
        browser = await chromium.launch({ executablePath: browserPath, headless: true, args });
        const context = await browser.newContext();
        const sourcePage = await context.newPage();

        const entry = new URL("/__proxyweb/browser", isolation.baseOrigin);
        entry.searchParams.set("url", `${fixture.origin}/runtime`);
        entry.searchParams.set("runtimeBridge", "true");
        entry.searchParams.set("webSocket", "true");
        const navigation = await sourcePage.goto(entry.href, { waitUntil: "domcontentloaded" });
        assert.equal(navigation.status(), 200);
        await sourcePage.waitForFunction(() => window.__runtimeDone !== undefined);
        assert.equal(await sourcePage.evaluate(() => window.__runtimeDone), true, await sourcePage.evaluate(() => window.__runtimeError));

        const sourceOrigin = new URL(sourcePage.url()).origin;
        const cdnCanonical = toProxyUrl(`http://cdn.test:${fixture.port}/runtime/popup`, {
            originIsolation: isolation
        });
        const cdnOrigin = new URL(cdnCanonical).origin;
        assert.notEqual(sourceOrigin, cdnOrigin);
        assert.equal((await sourcePage.evaluate(() => window.__runtimeResults.cdn)).host, `cdn.test:${fixture.port}`);

        await sourcePage.evaluate(() => localStorage.setItem("fireflyproxy-origin-probe", "source-value"));
        const cdnPage = await context.newPage();
        const cdnNavigation = await cdnPage.goto(cdnCanonical, { waitUntil: "domcontentloaded" });
        assert.equal(cdnNavigation.status(), 200);
        assert.equal(await cdnPage.evaluate(() => localStorage.getItem("fireflyproxy-origin-probe")), null);
        await cdnPage.evaluate(() => localStorage.setItem("fireflyproxy-origin-probe", "cdn-value"));
        assert.equal(await sourcePage.evaluate(() => localStorage.getItem("fireflyproxy-origin-probe")), "source-value");

        const popupPromise = context.waitForEvent("page");
        await sourcePage.evaluate(url => { window.__isolationPopup = window.open(url, "_blank"); }, cdnCanonical);
        const popup = await popupPromise;
        await popup.waitForLoadState("domcontentloaded");
        assert.equal(await sourcePage.evaluate(() => {
            try {
                void window.__isolationPopup.document.body;
                return "readable";
            } catch (error) {
                return error.name;
            }
        }), "SecurityError");

        process.stdout.write(`[P2 Origin Isolation E2E] Browser: ${browser.version()} (${browserPath})\n`);
        process.stdout.write("[P2 Origin Isolation E2E] PASS (distinct origins/storage, SOP boundary, Runtime cross-origin CORS)\n");
    } catch (error) {
        process.stderr.write(`[P2 Origin Isolation E2E] FAIL\n${error.stack || error.message}\n`);
        process.stderr.write(proxy?.getOutput() || "");
        process.exitCode = 1;
    } finally {
        await browser?.close().catch(() => {});
        await proxy?.close().catch(() => {});
        await fixture?.close().catch(() => {});
    }
}

run();
