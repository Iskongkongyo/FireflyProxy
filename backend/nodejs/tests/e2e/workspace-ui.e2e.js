const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { findBrowserExecutable } = require("../helpers/browser-executable");

const frontendDist = path.resolve(__dirname, "../../../../vue-request-app/dist");
const contentTypes = Object.freeze({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
});

function startStaticServer() {
    if (!fs.existsSync(path.join(frontendDist, "index.html"))) {
        throw new Error("Frontend dist is missing. Run npm run build in vue-request-app first.");
    }
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, "http://127.0.0.1").pathname;
        const relative = pathname.startsWith("/web/") ? pathname.slice(5) : "";
        const candidate = path.resolve(frontendDist, relative || "index.html");
        const insideDist = candidate === frontendDist || candidate.startsWith(`${frontendDist}${path.sep}`);
        const filePath = insideDist && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
            ? candidate
            : path.join(frontendDist, "index.html");
        response.setHeader("content-type", contentTypes[path.extname(filePath)] || "application/octet-stream");
        fs.createReadStream(filePath).pipe(response);
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve({
            origin: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise(done => server.close(done))
        }));
    });
}

async function run() {
    let staticServer;
    let browser;
    try {
        const browserPath = findBrowserExecutable();
        staticServer = await startStaticServer();
        const args = ["--disable-background-networking", "--no-first-run"];
        if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
        browser = await chromium.launch({ executablePath: browserPath, headless: true, args });
        const page = await browser.newPage();
        await page.addInitScript(() => {
            window.__proxywebCopiedText = "";
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                    writeText: async value => { window.__proxywebCopiedText = String(value); }
                }
            });
        });
        const navigation = await page.goto(`${staticServer.origin}/web/`, { waitUntil: "networkidle" });
        assert.equal(navigation.status(), 200);

        await page.getByRole("button", { name: /^工作区/ }).click();
        await page.getByRole("button", { name: "新建环境" }).click();
        await page.getByPlaceholder("例如 Development").fill("Development");
        let variableRows = page.locator(".el-drawer .el-table__body-wrapper .el-table__row");
        await variableRows.nth(0).getByPlaceholder("baseUrl").fill("baseUrl");
        await variableRows.nth(0).getByPlaceholder("变量值或 {{other}}").fill("https://api.example.test");
        await page.getByRole("button", { name: "新增变量" }).click();
        variableRows = page.locator(".el-drawer .el-table__body-wrapper .el-table__row");
        await variableRows.nth(1).getByPlaceholder("baseUrl").fill("token");
        await variableRows.nth(1).getByPlaceholder("变量值或 {{other}}").fill("local-secret");
        await variableRows.nth(1).locator(".el-switch").nth(1).click();
        await page.getByRole("button", { name: "保存并启用" }).click();
        await page.getByText("环境已保存并启用。").waitFor();
        await page.locator(".el-drawer__close-btn").click();
        await page.reload({ waitUntil: "networkidle" });
        await page.getByRole("button", { name: "工作区 · Development" }).waitFor();

        await page.getByLabel("API 请求地址").fill("{{baseUrl}}/users");
        await page.getByRole("button", { name: /^工作区/ }).click();
        await page.getByRole("tab", { name: "请求集合" }).click();
        await page.getByPlaceholder("新文件夹名称").fill("Users");
        await page.getByRole("button", { name: "新增文件夹" }).click();
        await page.getByPlaceholder("请求名称").fill("List users");
        await page.locator(".save-grid .el-select").click();
        await page.locator(".el-select-dropdown__item").filter({ hasText: /^Users$/ }).click();
        await page.locator(".save-grid").getByRole("button", { name: "保存" }).click();
        await page.getByText("当前请求已保存。").waitFor();
        await page.locator(".el-drawer__close-btn").click();

        await page.getByLabel("API 请求地址").fill("https://changed.example.test/");
        await page.getByRole("button", { name: /^工作区/ }).click();
        const savedRow = page.locator(".el-drawer .el-table__row").filter({ hasText: "List users" });
        await savedRow.getByRole("button", { name: "加载" }).click();
        assert.equal(await page.getByLabel("API 请求地址").inputValue(), "{{baseUrl}}/users");

        await page.getByRole("button", { name: "导入与导出" }).click();
        await page.getByRole("menuitem", { name: "复制直达 API 链接" }).click();
        const directApiLink = new URL(await page.evaluate(() => window.__proxywebCopiedText));
        assert.equal(directApiLink.origin, "http://localhost:8082");
        assert.equal(directApiLink.pathname, "/__proxyweb/api");
        assert.equal(directApiLink.searchParams.get("url"), "https://api.example.test/users");

        await page.getByRole("button", { name: "导入与导出" }).click();
        await page.getByRole("menuitem", { name: "复制请求页面链接" }).click();
        const requestPageLink = new URL(await page.evaluate(() => window.__proxywebCopiedText));
        assert.equal(requestPageLink.origin, staticServer.origin);
        assert.equal(requestPageLink.pathname, "/web/");
        assert.equal(requestPageLink.searchParams.get("url"), "{{baseUrl}}/users");

        const stored = await page.evaluate(async () => {
            const session = JSON.parse(sessionStorage.getItem("fireflyproxy.workspace.session-environments.v1") || "[]");
            const database = await new Promise((resolve, reject) => {
                const request = indexedDB.open("fireflyproxy-workspace", 1);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            const readAll = store => new Promise((resolve, reject) => {
                const request = database.transaction(store).objectStore(store).getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            return { session, folders: await readAll("folders"), requests: await readAll("requests") };
        });
        assert.equal(stored.session[0].variables.find(variable => variable.key === "token").value, "local-secret");
        assert.equal(stored.session[0].variables.find(variable => variable.key === "token").secret, true);
        assert.equal(stored.folders[0].name, "Users");
        assert.equal(stored.requests[0].name, "List users");
        assert.equal(stored.requests[0].url, "{{baseUrl}}/users");

        process.stdout.write(`[P3 Workspace E2E] Browser: ${browser.version()} (${browserPath})\n`);
        process.stdout.write("[P3 Workspace E2E] PASS (Environment/Secret, Collections, direct API/page share links)\n");
    } catch (error) {
        process.stderr.write(`[P3 Workspace E2E] FAIL\n${error.stack || error.message}\n`);
        process.exitCode = 1;
    } finally {
        await browser?.close().catch(() => {});
        await staticServer?.close().catch(() => {});
    }
}

run();
