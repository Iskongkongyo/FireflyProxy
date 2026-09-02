const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { getCookieHeader, storeResponseCookies } = require("../../browser-proxy/sessionStateStore");
const { isolatedProxyOrigin } = require("../../core/originIsolation");
const { RUNTIME_STATE_SCHEMA_VERSION, createRuntimeState } = require("../../core/runtimeState");

function runtimeConfig(sqlitePath) {
    return {
        session: { maxAgeMs: 60_000 },
        runtimeState: { backend: "sqlite", sqlitePath, busyTimeoutMs: 1000 }
    };
}

function expressSet(store, sessionId, value) {
    return new Promise((resolve, reject) => store.set(sessionId, value, error => (
        error ? reject(error) : resolve()
    )));
}

function expressGet(store, sessionId) {
    return new Promise((resolve, reject) => store.get(sessionId, (error, value) => (
        error ? reject(error) : resolve(value)
    )));
}

function expressDestroy(store, sessionId) {
    return new Promise((resolve, reject) => store.destroy(sessionId, error => (
        error ? reject(error) : resolve()
    )));
}

async function removeRuntimeDirectory(directory) {
    const root = path.resolve(os.tmpdir());
    const target = path.resolve(directory);
    assert.ok(target.startsWith(`${root}${path.sep}proxyweb-runtime-state-unit-`));
    await fs.rm(target, { recursive: true, force: true });
}

test("SQLite runtime state shares Express sessions, Cookie Jars and origin labels", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxyweb-runtime-state-unit-"));
    const sqlitePath = path.join(directory, "runtime.sqlite");
    let clock = 10_000;
    const first = createRuntimeState({
        config: runtimeConfig(sqlitePath),
        configPath: path.join(directory, "first.json"),
        now: () => clock
    });
    const second = createRuntimeState({
        config: runtimeConfig(sqlitePath),
        configPath: path.join(directory, "second.json"),
        now: () => clock
    });
    try {
        await expressSet(first.expressSessionStore, "shared-session", {
            cookie: { originalMaxAge: 60_000 },
            fireflyProxyBrowserPreferences: { rewriteCss: false }
        });
        assert.deepEqual(
            (await expressGet(second.expressSessionStore, "shared-session")).fireflyProxyBrowserPreferences,
            { rewriteCss: false }
        );

        const firstHandle = await first.sessionStateStore.get("shared-session", 60_000);
        await storeResponseCookies(firstHandle, "https://fixture.test/cookie/set", [
            "alpha=1; Path=/; HttpOnly"
        ]);
        const secondHandle = await second.sessionStateStore.get("shared-session", 60_000);
        assert.match(await getCookieHeader(secondHandle, "https://fixture.test/cookie/echo"), /alpha=1/);

        const concurrentFirst = await first.sessionStateStore.get("shared-session", 60_000);
        const concurrentSecond = await second.sessionStateStore.get("shared-session", 60_000);
        await storeResponseCookies(concurrentFirst, "https://fixture.test/", ["beta=2; Path=/"]);
        await storeResponseCookies(concurrentSecond, "https://fixture.test/", ["gamma=3; Path=/"]);
        const merged = await getCookieHeader(
            await first.sessionStateStore.get("shared-session", 60_000),
            "https://fixture.test/"
        );
        assert.match(merged, /alpha=1/);
        assert.match(merged, /beta=2/);
        assert.match(merged, /gamma=3/);

        await expressSet(first.expressSessionStore, "deleted-session", {
            cookie: { originalMaxAge: 60_000 }
        });
        await first.sessionStateStore.get("deleted-session", 60_000);
        assert.equal(first.sessionStateStore.size, 2);
        await expressDestroy(second.expressSessionStore, "deleted-session");
        assert.equal(first.sessionStateStore.size, 1);

        const isolation = {
            enabled: true,
            baseOrigin: "https://browse.example.test"
        };
        first.originIsolationRegistry.register("https://fixture.test");
        assert.equal(
            second.originIsolationRegistry.resolve(
                isolatedProxyOrigin("https://fixture.test", isolation),
                isolation
            ),
            "https://fixture.test"
        );

        const { DatabaseSync } = require("node:sqlite");
        const locker = new DatabaseSync(sqlitePath);
        locker.exec("BEGIN IMMEDIATE");
        try {
            await assert.rejects(
                expressSet(second.expressSessionStore, "blocked-session", {
                    cookie: { originalMaxAge: 60_000 }
                }),
                error => error.code === "PROXY_RUNTIME_STATE_UNAVAILABLE" && error.statusCode === 503
            );
            await assert.rejects(
                second.sessionStateStore.get("blocked-session", 60_000),
                error => error.code === "PROXY_RUNTIME_STATE_UNAVAILABLE" && error.statusCode === 503
            );
        } finally {
            locker.exec("ROLLBACK");
            locker.close();
        }

        clock += 60_001;
        assert.equal(await expressGet(second.expressSessionStore, "shared-session"), null);
        assert.equal(second.sessionStateStore.size, 0);
        assert.equal(
            second.originIsolationRegistry.resolve(
                isolatedProxyOrigin("https://fixture.test", isolation),
                isolation
            ),
            null
        );
    } finally {
        await first.close();
        await second.close();
        await removeRuntimeDirectory(directory);
    }
});

test("SQLite runtime state persists across instance shutdown without clearing shared rows", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxyweb-runtime-state-unit-"));
    const sqlitePath = path.join(directory, "runtime.sqlite");
    const config = runtimeConfig(sqlitePath);
    let first;
    let reopened;
    try {
        first = createRuntimeState({ config, configPath: path.join(directory, "main.json") });
        await expressSet(first.expressSessionStore, "durable-session", {
            cookie: { originalMaxAge: 60_000 },
            value: "persisted"
        });
        await first.close();
        first = null;

        reopened = createRuntimeState({ config, configPath: path.join(directory, "main.json") });
        assert.equal((await expressGet(reopened.expressSessionStore, "durable-session")).value, "persisted");
        assert.equal(RUNTIME_STATE_SCHEMA_VERSION, 1);
    } finally {
        await first?.close();
        await reopened?.close();
        await removeRuntimeDirectory(directory);
    }
});

test("SQLite runtime state refuses a schema newer than this binary supports", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxyweb-runtime-state-unit-"));
    const sqlitePath = path.join(directory, "runtime.sqlite");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(sqlitePath);
    database.exec(`PRAGMA user_version = ${RUNTIME_STATE_SCHEMA_VERSION + 1}`);
    database.close();

    try {
        assert.throws(
            () => createRuntimeState({
                config: runtimeConfig(sqlitePath),
                configPath: path.join(directory, "main.json")
            }),
            new RegExp(`schema ${RUNTIME_STATE_SCHEMA_VERSION + 1} is newer`)
        );
    } finally {
        await removeRuntimeDirectory(directory);
    }
});
