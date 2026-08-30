const assert = require("node:assert/strict");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { createBrowserE2eFixture } = require("../fixtures/browser-e2e-site");
const { findBrowserExecutable } = require("../helpers/browser-executable");
const { startProxy } = require("../helpers/proxy-process");

async function removeArtifactDirectory(directory) {
    const resolvedRoot = path.resolve(os.tmpdir());
    const resolvedTarget = path.resolve(directory);
    if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}proxyweb-runtime-e2e-`)) {
        throw new Error(`Refusing to remove unexpected artifact directory: ${resolvedTarget}`);
    }
    await fsPromises.rm(resolvedTarget, { recursive: true, force: true });
}

async function openPopup(context, action) {
    const popupPromise = context.waitForEvent("page");
    await action();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    return popup;
}

async function run() {
    const artifactDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "proxyweb-runtime-e2e-"));
    const diagnostics = [];
    let fixture;
    let proxy;
    let browser;
    let page;
    let passed = false;

    try {
        const browserPath = findBrowserExecutable();
        fixture = await createBrowserE2eFixture();
        proxy = await startProxy({
            browser: { enabled: true, runtimeBridge: true, webSocket: true }
        }, {
            fixtureHosts: ["fixture.test", "cdn.test"],
            dnsRecords: {
                "cdn.test": [{ address: "93.184.216.35", family: 4 }]
            }
        });

        const launchArgs = ["--disable-background-networking", "--no-first-run"];
        if (typeof process.getuid === "function" && process.getuid() === 0) launchArgs.push("--no-sandbox");
        browser = await chromium.launch({ executablePath: browserPath, headless: true, args: launchArgs });
        const context = await browser.newContext();
        page = await context.newPage();
        page.on("console", message => diagnostics.push(`console:${message.type()}: ${message.text()}`));
        page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
        page.on("requestfailed", request => diagnostics.push(
            `requestfailed: ${request.url()} (${request.failure()?.errorText || "unknown"})`
        ));

        const entryUrl = new URL("/__proxyweb/browser", proxy.origin);
        entryUrl.searchParams.set("url", `${fixture.origin}/runtime`);
        entryUrl.searchParams.set("runtimeBridge", "true");
        const navigation = await page.goto(entryUrl.href, { waitUntil: "domcontentloaded" });
        assert.equal(navigation.status(), 200);
        assert.equal(await page.evaluate(() => window.__runtimeDone), true, await page.evaluate(() => window.__runtimeError));

        const results = await page.evaluate(() => window.__runtimeResults);
        assert.equal(results.markerCount, 1);
        assert.equal(results.fetchReturnsPromise, true);
        assert.equal(results.fetchPrototypeName, "fetch");
        assert.equal(results.fetchName, "fetch");
        assert.equal(results.fetchLength, 1);
        assert.equal(results.requestName, "Request");
        assert.equal(results.eventSourcePrototypeName, "EventSource");
        assert.equal(results.eventSourceName, "EventSource");
        assert.equal(results.webSocketPrototypeName, "WebSocket");
        assert.equal(results.webSocketName, "WebSocket");
        assert.equal(results.xhrOpenName, "open");
        assert.equal(results.historyPushStateName, "pushState");
        assert.equal(results.fetch.method, "GET");
        assert.equal(results.fetch.pathname, "/runtime/api");
        assert.equal(results.fetch.query.via, "fetch");
        assert.equal(results.fetch.host, `fixture.test:${fixture.port}`);
        assert.equal(results.request.method, "POST");
        assert.equal(results.request.body, "runtime-request-body");
        assert.equal(results.request.origin, fixture.origin);
        assert.equal(results.request.referer, `${fixture.origin}/runtime`);
        assert.equal(results.xhr.pathname, "/runtime/api");
        assert.equal(results.xhr.query.via, "xhr");
        assert.equal(results.cdn.host, `cdn.test:${fixture.port}`);
        assert.equal(results.cdn.query.via, "cdn");
        assert.equal(results.data, "runtime-data");
        assert.deepEqual(results.events, ["runtime-first", "runtime-second"]);
        assert.equal(results.webSocket.code, 4002);
        assert.equal(results.webSocket.protocol, "runtime-chat");
        assert.equal(results.webSocket.reason, "runtime-done");
        assert.deepEqual(JSON.parse(results.webSocket.values[0]), {
            origin: fixture.origin,
            protocolHeader: "runtime-chat",
            url: "/runtime/socket?via=bridge"
        });
        assert.equal(results.webSocket.values[1], "runtime-text");
        assert.deepEqual(results.webSocket.values[2], [4, 2, 1]);
        assert.equal(results.relative.pathname, "/runtime/base/relative.json");
        assert.equal(results.relative.query.via, "history");
        assert.equal(results.relative.referer, `${fixture.origin}/runtime/virtual?step=1`);
        assert.equal(results.historySecurity, "SecurityError");
        assert.match(results.historyUrl, /\/__proxyweb\/browser\/[^/]+\/runtime\/virtual\?step=1#view$/);
        assert.equal(page.url(), results.historyUrl);

        const popup = await openPopup(context, () => page.locator("#runtime-popup").click());
        assert.equal(await popup.locator("#runtime-popup-result").textContent(), "runtime-popup-ok");
        assert.match(popup.url(), /\/__proxyweb\/browser\/[^/]+\/runtime\/popup$/);
        await popup.close();

        assert.doesNotMatch(proxy.getOutput(), /runtime-request-body/);
        process.stdout.write(`[P2 Runtime E2E] Browser: ${browser.version()} (${browserPath})\n`);
        process.stdout.write("[P2 Runtime E2E] PASS (fetch/Request, XHR, EventSource, WebSocket, window.open, History, cross-origin token)\n");
        passed = true;
    } catch (error) {
        if (page && !page.isClosed()) {
            await page.screenshot({ path: path.join(artifactDirectory, "failure.png"), fullPage: true }).catch(() => {});
            await fsPromises.writeFile(
                path.join(artifactDirectory, "failure.html"),
                await page.content().catch(() => ""),
                "utf8"
            ).catch(() => {});
        }
        await fsPromises.writeFile(path.join(artifactDirectory, "diagnostics.log"), [
            error.stack || error.message,
            "",
            ...diagnostics,
            "",
            proxy?.getOutput() || ""
        ].join("\n"), "utf8").catch(() => {});
        process.stderr.write(`[P2 Runtime E2E] FAIL. Diagnostics: ${artifactDirectory}\n${error.stack || error.message}\n`);
        process.exitCode = 1;
    } finally {
        await browser?.close().catch(() => {});
        await proxy?.close().catch(() => {});
        await fixture?.close().catch(() => {});
        if (passed) await removeArtifactDirectory(artifactDirectory);
    }
}

run();
