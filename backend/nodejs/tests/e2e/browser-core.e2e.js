const assert = require("node:assert/strict");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { findBrowserExecutable } = require("../helpers/browser-executable");
const {
    DOWNLOAD_BYTES,
    FONT_BYTES,
    MEDIA_BYTES,
    PNG_BYTES,
    createBrowserE2eFixture
} = require("../fixtures/browser-e2e-site");
const { startProxy } = require("../helpers/proxy-process");

async function openPopup(context, action) {
    const popupPromise = context.waitForEvent("page");
    await action();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    return popup;
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

async function fetchBytes(page, url, headers = {}) {
    return page.evaluate(async ({ resourceUrl, requestHeaders }) => {
        const response = await fetch(resourceUrl, { headers: requestHeaders });
        return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            bytes: Array.from(new Uint8Array(await response.arrayBuffer()))
        };
    }, { resourceUrl: url, requestHeaders: headers });
}

function assertBytes(actual, expected, label) {
    assert.deepEqual(Buffer.from(actual), expected, `${label} changed while passing through Browser Mode`);
}

async function removeArtifactDirectory(directory) {
    const resolvedRoot = path.resolve(os.tmpdir());
    const resolvedTarget = path.resolve(directory);
    if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}proxyweb-p1-e2e-`)) {
        throw new Error(`Refusing to remove unexpected artifact directory: ${resolvedTarget}`);
    }
    await fsPromises.rm(resolvedTarget, { recursive: true, force: true });
}

async function run() {
    const artifactDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "proxyweb-p1-e2e-"));
    const diagnostics = [];
    let browserPath;
    let fixture;
    let proxy;
    let browser;
    let page;
    let passed = false;

    try {
        browserPath = findBrowserExecutable();
        fixture = await createBrowserE2eFixture();
        proxy = await startProxy({
            browser: {
                enabled: true,
                responseTransform: {
                    enabled: true,
                    rules: [{
                        id: "browser-core-page",
                        hosts: ["fixture.test"],
                        pathPrefix: "/site",
                        contentTypes: ["text/html"],
                        replacements: [{
                            search: "Browser Core fixture",
                            replacement: "Scoped Browser fixture",
                            mode: "once",
                            maxReplacements: 1
                        }, {
                            search: "http://legacy.invalid/escaped",
                            replacement: "/link-result",
                            mode: "once",
                            maxReplacements: 1
                        }],
                        appendHead: "<script>window.__scopedTransformLoaded = true;</script>",
                        prependBody: "<aside id=proxyweb-transform-marker>scoped</aside>"
                    }]
                }
            }
        }, {
            fixtureHosts: ["fixture.test", "cdn.test"],
            dnsRecords: {
                "cdn.test": [{ address: "93.184.216.35", family: 4 }]
            }
        });

        const launchArgs = ["--disable-background-networking", "--no-first-run"];
        if (typeof process.getuid === "function" && process.getuid() === 0) launchArgs.push("--no-sandbox");
        browser = await chromium.launch({ executablePath: browserPath, headless: true, args: launchArgs });
        const context = await browser.newContext({ acceptDownloads: true });
        page = await context.newPage();
        page.on("console", message => diagnostics.push(`console:${message.type()}: ${message.text()}`));
        page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
        page.on("requestfailed", request => diagnostics.push(
            `requestfailed: ${request.url()} (${request.failure()?.errorText || "unknown"})`
        ));

        const entryUrl = new URL("/__proxyweb/browser", proxy.origin);
        entryUrl.searchParams.set("url", `${fixture.origin}/site`);
        const navigation = await page.goto(entryUrl.href, { waitUntil: "domcontentloaded" });
        assert.equal(navigation.status(), 200);
        assert.match(page.url(), /\/__proxyweb\/browser\/[^/]+\/site$/);
        assert.equal(await page.locator("#static-page").textContent(), "Scoped Browser fixture");
        assert.equal(await page.locator("#proxyweb-transform-marker").textContent(), "scoped");
        assert.equal(await page.evaluate(() => window.__scopedTransformLoaded), true);
        assert.match(
            await page.locator("#scoped-hardcoded").getAttribute("href"),
            /^\/__proxyweb\/browser\/[^/]+\/link-result$/
        );
        await page.waitForFunction(() => window.__cdnScriptLoaded && window.__e2e?.sse?.length === 2);
        await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));

        const rewrittenAttributes = await page.locator(
            "link[href], script[src], img[src], a[href], form[action]"
        ).evaluateAll(elements => elements.map(element => ({
            tag: element.tagName,
            attribute: element.hasAttribute("href") ? "href" : element.hasAttribute("src") ? "src" : "action",
            value: element.getAttribute(element.hasAttribute("href") ? "href" : element.hasAttribute("src") ? "src" : "action")
        })));
        for (const item of rewrittenAttributes) {
            assert.match(item.value, /^\/__proxyweb\/browser\/[^/]+\//, `${item.tag}.${item.attribute} escaped Browser Mode`);
            assert.doesNotMatch(item.value, /(?:fixture|cdn)\.test/, `${item.tag}.${item.attribute} exposed an upstream host`);
        }

        const styleState = await page.locator("#static-page").evaluate(element => {
            const style = getComputedStyle(element);
            return {
                color: style.color,
                borderTopWidth: style.borderTopWidth,
                backgroundImage: style.backgroundImage,
                after: getComputedStyle(element, "::after").content
            };
        });
        assert.equal(styleState.color, "rgb(12, 34, 56)");
        assert.equal(styleState.borderTopWidth, "3px");
        assert.match(styleState.after, /theme-loaded/);
        assert.match(styleState.backgroundImage, /\/__proxyweb\/browser\/[^/]+\/assets\/background\.png/);
        assert.doesNotMatch(styleState.backgroundImage, /fixture\.test/);

        const localImageUrl = await page.locator("#local-image").getAttribute("src");
        const cdnImageUrl = await page.locator("#cdn-image").getAttribute("src");
        const documentToken = new URL(page.url()).pathname.split("/")[3];
        const localToken = new URL(localImageUrl, proxy.origin).pathname.split("/")[3];
        const cdnToken = new URL(cdnImageUrl, proxy.origin).pathname.split("/")[3];
        assert.equal(localToken, documentToken, "same-origin resource did not reuse the document origin token");
        assert.notEqual(localToken, cdnToken, "cross-origin CDN resource reused the document origin token");
        assert.match(await page.evaluate(() => window.__cdnScriptLoaded), new RegExp(`/browser/${cdnToken}/assets/app\\.js$`));

        const localImage = await fetchBytes(page, new URL(localImageUrl, proxy.origin).href);
        assert.equal(localImage.status, 200);
        assertBytes(localImage.bytes, PNG_BYTES, "PNG");
        const baseCssUrl = new URL(await page.locator("#base-css").getAttribute("href"), proxy.origin).href;
        const baseCss = await page.evaluate(async url => (await fetch(url)).text(), baseCssUrl);
        const fontUrlMatch = /url\(["']?(\/__proxyweb\/browser\/[^/]+\/assets\/site\.woff2)["']?\)/.exec(baseCss);
        assert.ok(fontUrlMatch, "font URL was not rewritten in the proxied stylesheet");
        const font = await fetchBytes(page, new URL(fontUrlMatch[1], proxy.origin).href);
        assert.equal(font.status, 200);
        assertBytes(font.bytes, FONT_BYTES, "font");

        const linkPage = await openPopup(context, () => page.locator("#navigation").click());
        assert.equal(await linkPage.locator("#link-result").textContent(), "linked");
        await linkPage.close();

        await page.evaluate(() => {
            const link = document.createElement("a");
            link.id = "runtime-root-link";
            link.href = "/link-result";
            link.target = "_blank";
            link.textContent = "runtime root link";
            document.body.append(link);

            const form = document.createElement("form");
            form.id = "runtime-root-post";
            form.action = "/form/result";
            form.method = "post";
            form.target = "_blank";
            form.innerHTML = '<input name="message" value="runtime root post"><button>submit</button>';
            document.body.append(form);
        });
        assert.equal(await page.locator("#runtime-root-link").getAttribute("href"), "/link-result");

        const recoveredLinkPage = await openPopup(context, () => page.locator("#runtime-root-link").click());
        assert.equal(await recoveredLinkPage.locator("#link-result").textContent(), "linked");
        assert.match(recoveredLinkPage.url(), /\/__proxyweb\/browser\/[^/]+\/link-result$/);
        await recoveredLinkPage.close();

        const recoveredPostPage = await openPopup(context, () => page.locator("#runtime-root-post button").click());
        assert.equal(await recoveredPostPage.locator("#form-result").getAttribute("data-method"), "POST");
        assert.equal(await recoveredPostPage.locator("#form-result").textContent(), "message=runtime+root+post");
        assert.match(recoveredPostPage.url(), /\/__proxyweb\/browser\/[^/]+\/form\/result$/);
        await recoveredPostPage.close();

        const ssrPage = await openPopup(context, () => page.locator("#ssr-link").click());
        assert.equal(await ssrPage.locator("#ssr-result").textContent(), "SSR:Browser");
        await ssrPage.close();

        const getPage = await openPopup(context, () => page.locator("#get-form button").click());
        assert.equal(await getPage.locator("#form-result").getAttribute("data-method"), "GET");
        assert.equal(await getPage.locator("#form-result").textContent(), "browser get");
        await getPage.close();

        const postPage = await openPopup(context, () => page.locator("#post-form button").click());
        assert.equal(await postPage.locator("#form-result").getAttribute("data-method"), "POST");
        assert.equal(await postPage.locator("#form-result").textContent(), "message=browser+post");
        await postPage.close();

        const loginPage = await openPopup(context, () => page.locator("#protected-link").click());
        assert.equal(await loginPage.locator("#login-page").textContent(), "login-required");
        assert.match(loginPage.url(), /\/__proxyweb\/browser\/[^/]+\/login-page$/);
        await Promise.all([
            loginPage.waitForNavigation({ waitUntil: "domcontentloaded" }),
            loginPage.locator("#login-form button").click()
        ]);
        assert.equal(await loginPage.locator("#account").textContent(), "session-active");
        assert.match(loginPage.url(), /\/__proxyweb\/browser\/[^/]+\/protected$/);
        await loginPage.reload({ waitUntil: "domcontentloaded" });
        assert.equal(await loginPage.locator("#account").textContent(), "session-active");
        await loginPage.close();

        const range = await fetchBytes(page, await page.locator("#media").getAttribute("href"), {
            Range: "bytes=2-7"
        });
        assert.equal(range.status, 206);
        assert.equal(range.headers["content-range"], `bytes 2-7/${MEDIA_BYTES.length}`);
        assert.equal(range.headers["accept-ranges"], "bytes");
        assertBytes(range.bytes, MEDIA_BYTES.subarray(2, 8), "MP4 range");

        const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.locator("#download").click()
        ]);
        assert.equal(download.suggestedFilename(), "report.txt");
        assertBytes(await streamToBuffer(await download.createReadStream()), DOWNLOAD_BYTES, "download");

        assert.deepEqual(await page.evaluate(() => window.__e2e.sse), ["first", "second"]);
        assert.notEqual(await page.evaluate(() => window.__e2e.sseError || false), true);

        process.stdout.write(`[P1 E2E] Browser: ${browser.version()} (${browserPath})\n`);
        process.stdout.write("[P1 E2E] PASS (static/SSR, HTML/CSS assets, CDN, forms, root recovery, redirect, Cookie, Range, download, SSE)\n");
        passed = true;
    } catch (error) {
        if (page && !page.isClosed()) {
            const screenshotPath = path.join(artifactDirectory, "failure.png");
            const htmlPath = path.join(artifactDirectory, "failure.html");
            await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
            await fsPromises.writeFile(htmlPath, await page.content().catch(() => ""), "utf8").catch(() => {});
        }
        const diagnosticPath = path.join(artifactDirectory, "diagnostics.log");
        const diagnosticText = [
            error.stack || error.message,
            "",
            ...diagnostics,
            "",
            proxy?.getOutput() || ""
        ].join("\n");
        await fsPromises.writeFile(diagnosticPath, diagnosticText, "utf8").catch(() => {});
        process.stderr.write(`[P1 E2E] FAIL. Diagnostics: ${artifactDirectory}\n${error.stack || error.message}\n`);
        process.exitCode = 1;
    } finally {
        await browser?.close().catch(() => {});
        await proxy?.close().catch(() => {});
        await fixture?.close().catch(() => {});
        if (passed) await removeArtifactDirectory(artifactDirectory);
    }
}

run();
