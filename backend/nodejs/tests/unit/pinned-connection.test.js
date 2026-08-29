const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const {
    assertPinnedRemoteAddress,
    createPinnedConnection,
    createPinnedLookup,
    installConnectTimeout
} = require("../../core/pinnedConnection");

const target = Object.freeze({
    hostname: "api.example.test",
    addresses: Object.freeze([
        Object.freeze({ address: "93.184.216.34", family: 4 }),
        Object.freeze({ address: "2606:4700:4700::1111", family: 6 })
    ])
});

function resolveWithLookup(lookup, hostname, options) {
    return new Promise((resolve, reject) => {
        lookup(hostname, options, (error, address, family) => {
            if (error) return reject(error);
            return resolve(options && options.all ? address : { address, family });
        });
    });
}

test("pinned lookup returns only validated addresses without another DNS query", async () => {
    const lookup = createPinnedLookup(target);

    assert.deepEqual(await resolveWithLookup(lookup, "API.EXAMPLE.TEST.", { all: true }), [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 }
    ]);
    assert.deepEqual(await resolveWithLookup(lookup, target.hostname, { family: 4 }), {
        address: "93.184.216.34",
        family: 4
    });
    assert.deepEqual(await resolveWithLookup(lookup, target.hostname, { family: 6 }), {
        address: "2606:4700:4700::1111",
        family: 6
    });
});

test("pinned lookup rejects hostname changes and unavailable address families", async () => {
    const lookup = createPinnedLookup(target);

    await assert.rejects(
        resolveWithLookup(lookup, "rebound.example.test", { all: true }),
        error => error.code === "ENOTFOUND"
    );
    await assert.rejects(
        resolveWithLookup(createPinnedLookup({
            hostname: target.hostname,
            addresses: [{ address: "93.184.216.34", family: 4 }]
        }), target.hostname, { family: 6 }),
        error => error.code === "EAI_ADDRFAMILY"
    );
});

test("pinned agents preserve HTTPS hostname verification and strict certificates", () => {
    const connection = createPinnedConnection(target);
    try {
        assert.ok(connection.httpAgent instanceof http.Agent);
        assert.ok(connection.httpsAgent instanceof https.Agent);
        assert.equal(connection.httpAgent.options.lookup, connection.lookup);
        assert.equal(connection.httpsAgent.options.lookup, connection.lookup);
        assert.equal(connection.httpsAgent.options.servername, target.hostname);
        assert.equal(connection.httpsAgent.options.rejectUnauthorized, true);
        assert.equal(connection.assertRemoteAddress(null), "93.184.216.34");
    } finally {
        connection.destroy();
    }
});

test("remote socket address must match one of the validated addresses", () => {
    assert.equal(assertPinnedRemoteAddress(target, "::ffff:93.184.216.34"), "93.184.216.34");
    assert.equal(assertPinnedRemoteAddress(target, "2606:4700:4700::1111"), "2606:4700:4700::1111");
    assert.throws(
        () => assertPinnedRemoteAddress(target, "127.0.0.1"),
        error => error.code === "PROXY_SSRF_BLOCKED" && error.statusCode === 403
    );
});

test("pinned HTTPS connection rejects an untrusted certificate", async () => {
    const server = https.createServer({
        key: fs.readFileSync(path.join(__dirname, "..", "fixtures", "tls-key.pem")),
        cert: fs.readFileSync(path.join(__dirname, "..", "fixtures", "tls-cert.pem"))
    }, (request, response) => response.end("unexpected"));
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const connection = createPinnedConnection({
        hostname: "tls.fixture.test",
        addresses: [{ address: "127.0.0.1", family: 4 }]
    });
    try {
        await assert.rejects(new Promise((resolve, reject) => {
            const request = https.get({
                hostname: "tls.fixture.test",
                port: server.address().port,
                agent: connection.httpsAgent
            }, response => {
                response.resume();
                resolve();
            });
            request.once("error", reject);
        }), error => ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(error.code));
    } finally {
        connection.destroy();
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});

test("pinned connection rejects malformed or empty validated targets", () => {
    assert.throws(
        () => createPinnedConnection({ hostname: target.hostname, addresses: [] }),
        /at least one validated address/
    );
    assert.throws(
        () => createPinnedConnection({
            hostname: target.hostname,
            addresses: [{ address: "not-an-ip", family: 4 }]
        }),
        /invalid address record/
    );
});

test("connect timeout destroys a socket with the stable connect timeout error", async () => {
    const socket = new EventEmitter();
    let destroyedWith;
    socket.destroy = error => {
        destroyedWith = error;
        socket.emit("error", error);
    };
    const agent = {
        createConnection() { return socket; }
    };
    installConnectTimeout(agent, 10);
    agent.createConnection({}, () => {});
    await new Promise(resolve => setTimeout(resolve, 25));

    assert.equal(destroyedWith.code, "PROXY_CONNECT_TIMEOUT");
    assert.equal(destroyedWith.statusCode, 504);
});
