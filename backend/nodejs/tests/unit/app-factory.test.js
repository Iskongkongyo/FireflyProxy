const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createApp } = require("../../app");

function testConfig(port) {
    return {
        port,
        timeout: 3,
        user: "",
        pwd: "",
        accessOrigin: "http://factory.test",
        defaultSkip: "",
        session: {
            secret: `factory-test-secret-${port}`,
            name: "proxySession",
            resave: false,
            saveUninitialized: false,
            cookie: { maxAge: 60000, secure: false, httpOnly: true }
        },
        limiter: {
            windowMs: 60000,
            max: 100,
            message: "factory rate limit",
            statusCode: 429
        },
        blacklist: [],
        max_redirects: 5
    };
}

async function createConfigFile(port) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxyweb-app-factory-"));
    const configPath = path.join(tempDir, "main.json");
    await fs.writeFile(configPath, `${JSON.stringify(testConfig(port), null, 2)}\n`, "utf8");
    return { tempDir, configPath };
}

async function removeConfigDirectory(tempDir) {
    const tempRoot = path.resolve(os.tmpdir());
    const target = path.resolve(tempDir);
    if (!target.startsWith(`${tempRoot}${path.sep}proxyweb-app-factory-`)) {
        throw new Error(`Refusing to remove unexpected test directory: ${target}`);
    }
    await fs.rm(target, { recursive: true, force: true });
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

test("createApp loads an injected config without opening a port", async () => {
    const { tempDir, configPath } = await createConfigFile(19001);
    const runtime = createApp({ configPath, watchConfig: false });

    try {
        assert.equal(runtime.getConfig().port, 19001);
        assert.deepEqual(runtime.getConfig().cors.allowedOrigins, ["http://factory.test"]);
        assert.equal(runtime.getConfig().timeoutMs, 3000);
        assert.equal(typeof runtime.app.listen, "function");

        const server = runtime.app.listen(0, "127.0.0.1");
        await new Promise((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        try {
            const address = server.address();
            const response = await fetch(`http://127.0.0.1:${address.port}/`, {
                method: "OPTIONS",
                headers: { origin: "http://factory.test" }
            });
            assert.equal(response.status, 204);
        } finally {
            await closeServer(server);
        }
    } finally {
        await runtime.close();
        await removeConfigDirectory(tempDir);
    }
});

test("createApp keeps configuration state isolated between runtimes", async () => {
    const firstFile = await createConfigFile(19011);
    const secondFile = await createConfigFile(19012);
    const first = createApp({ configPath: firstFile.configPath, watchConfig: false });
    const second = createApp({ configPath: secondFile.configPath, watchConfig: false });

    try {
        assert.equal(first.getConfig().port, 19011);
        assert.equal(second.getConfig().port, 19012);
        assert.notStrictEqual(first.app, second.app);
    } finally {
        await first.close();
        await second.close();
        await removeConfigDirectory(firstFile.tempDir);
        await removeConfigDirectory(secondFile.tempDir);
    }
});
