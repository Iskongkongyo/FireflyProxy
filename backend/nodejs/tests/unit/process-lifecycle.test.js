const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createProcessLifecycle } = require("../../core/processLifecycle");

function createHarness() {
    const events = new EventEmitter();
    const calls = [];
    const logger = {
        info(message) { calls.push(["info", message]); },
        error(message) { calls.push(["error", message]); }
    };
    const server = {
        close(callback) { calls.push(["server.close"]); setImmediate(callback); },
        closeAllConnections() { calls.push(["server.closeAllConnections"]); }
    };
    const runtime = {
        async close() { calls.push(["runtime.close"]); }
    };
    const exits = [];
    const lifecycle = createProcessLifecycle({
        server,
        runtime,
        logger,
        processRef: events,
        exit: code => exits.push(code),
        forceExitMs: 100
    });
    return { calls, events, exits, lifecycle };
}

test("SIGTERM stops accepting connections, closes runtime resources and exits zero", async () => {
    const harness = createHarness();
    harness.lifecycle.register();
    harness.events.emit("SIGTERM");
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(harness.exits, [0]);
    assert.ok(harness.calls.some(([name]) => name === "server.close"));
    assert.ok(harness.calls.some(([name]) => name === "runtime.close"));
});

test("uncaught exceptions enter the same controlled shutdown and exit non-zero", async () => {
    const harness = createHarness();
    harness.lifecycle.register();
    harness.events.emit("uncaughtException", new Error("fatal"));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(harness.exits, [1]);
    assert.ok(harness.calls.some(([name, message]) => name === "error" && /Uncaught/.test(message)));
});
