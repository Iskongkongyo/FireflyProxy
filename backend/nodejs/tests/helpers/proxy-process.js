const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BACKEND_DIR = path.resolve(__dirname, "..", "..");
const TEST_SERVER_PATH = path.join(__dirname, "proxy-server.js");
const DNS_PRELOAD_PATH = path.join(__dirname, "fixture-dns-preload.js");

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function defaultConfig(port) {
    return {
        port,
        timeout: 2,
        user: "",
        pwd: "",
        accessOrigin: "http://frontend.test",
        defaultSkip: "",
        session: {
            secret: "proxyweb-contract-test-secret",
            name: "proxySession",
            resave: false,
            saveUninitialized: false,
            cookie: {
                maxAge: 60000,
                secure: false,
                httpOnly: true
            }
        },
        limiter: {
            windowMs: 60000,
            max: 1000,
            message: "fixture rate limit",
            statusCode: 429
        },
        blacklist: [],
        max_redirects: 5
    };
}

function requestStatus(port) {
    return new Promise(resolve => {
        const request = http.get({ hostname: "127.0.0.1", port, path: "/" }, response => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
        });
        request.once("error", () => resolve(null));
        request.setTimeout(250, () => {
            request.destroy();
            resolve(null);
        });
    });
}

async function waitUntilReady(child, port, getOutput) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Proxy exited before becoming ready.\n${getOutput()}`);
        }
        const status = await requestStatus(port);
        if (status !== null) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for proxy on port ${port}.\n${getOutput()}`);
}

async function stopChild(child) {
    if (child.exitCode !== null) return;

    child.kill("SIGTERM");
    const exited = new Promise(resolve => child.once("exit", resolve));
    const timeout = new Promise(resolve => setTimeout(resolve, 2000, "timeout"));
    if (await Promise.race([exited, timeout]) === "timeout") {
        child.kill("SIGKILL");
        await exited;
        throw new Error("Proxy did not exit within the graceful shutdown timeout.");
    }
}

async function removeTestDirectory(tempDir) {
    const resolvedTempRoot = path.resolve(os.tmpdir());
    const resolvedTarget = path.resolve(tempDir);
    const expectedPrefix = `${resolvedTempRoot}${path.sep}proxyweb-contract-`;
    if (!resolvedTarget.startsWith(expectedPrefix)) {
        throw new Error(`Refusing to remove unexpected test directory: ${resolvedTarget}`);
    }
    await fs.rm(resolvedTarget, { recursive: true, force: true });
}

async function startProxy(overrides = {}, options = {}) {
    const port = overrides.port || await getFreePort();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxyweb-contract-"));
    const configPath = path.join(tempDir, "main.json");
    const config = {
        ...defaultConfig(port),
        ...overrides,
        session: {
            ...defaultConfig(port).session,
            ...(overrides.session || {})
        },
        limiter: {
            ...defaultConfig(port).limiter,
            ...(overrides.limiter || {})
        }
    };
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let output = "";
    const child = spawn(process.execPath, ["--require", DNS_PRELOAD_PATH, TEST_SERVER_PATH], {
        cwd: tempDir,
        env: {
            ...process.env,
            PROXYWEB_FIXTURE_HOST: "fixture.test",
            PROXYWEB_FIXTURE_ADDRESS: "127.0.0.1",
            PROXYWEB_FIXTURE_VALIDATION_ADDRESS: "93.184.216.34",
            PROXYWEB_VALIDATION_DNS_RECORDS: JSON.stringify(options.dnsRecords || {})
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });

    await waitUntilReady(child, port, () => output);

    return {
        child,
        port,
        origin: `http://127.0.0.1:${port}`,
        configPath,
        getOutput: () => output,
        async updateConfig(patch) {
            const nextSession = patch.session ? { ...config.session, ...patch.session } : config.session;
            const nextLimiter = patch.limiter ? { ...config.limiter, ...patch.limiter } : config.limiter;
            Object.assign(config, patch);
            config.session = nextSession;
            config.limiter = nextLimiter;
            await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        },
        async waitForOutput(pattern, startIndex = 0) {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                if (pattern.test(output.slice(startIndex))) return;
                if (child.exitCode !== null) throw new Error(`Proxy exited.\n${output}`);
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new Error(`Output did not match ${pattern}.\n${output}`);
        },
        async close() {
            await stopChild(child);
            await removeTestDirectory(tempDir);
        }
    };
}

module.exports = {
    startProxy
};
