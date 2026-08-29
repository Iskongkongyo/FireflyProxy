const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const {
    createReplayableBody,
    redirectHeaders,
    redirectMethod,
    requestWithRedirects
} = require("../../core/safeRedirect");

test("redirect methods follow 301/302/303/307/308 body semantics", () => {
    assert.equal(redirectMethod(301, "POST"), "GET");
    assert.equal(redirectMethod(302, "POST"), "GET");
    assert.equal(redirectMethod(302, "PUT"), "PUT");
    assert.equal(redirectMethod(303, "PATCH"), "GET");
    assert.equal(redirectMethod(303, "HEAD"), "HEAD");
    assert.equal(redirectMethod(307, "POST"), "POST");
    assert.equal(redirectMethod(308, "PUT"), "PUT");
});

test("cross-origin redirects remove secrets and body-changing redirects remove entity headers", () => {
    const headers = redirectHeaders({
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-api-key": "key-secret",
        "x-upstream-token": "token-secret",
        "content-type": "application/json",
        "content-length": "2",
        "x-safe": "keep"
    }, "https://one.test/start", "https://two.test/next", "POST", "GET");

    assert.deepEqual(headers, { "x-safe": "keep" });
    assert.deepEqual(redirectHeaders({ authorization: "Bearer same", "x-safe": "keep" },
        "https://one.test/start", "https://one.test/next", "GET", "GET"), {
        authorization: "Bearer same",
        "x-safe": "keep"
    });
});

test("replayable body streams the first hop and only fails when oversized content is replayed", async () => {
    const replayable = createReplayableBody(Readable.from(["hello", "-world"]), 32);
    const firstHop = [];
    for await (const chunk of replayable.initial) firstHop.push(chunk);
    assert.equal(Buffer.concat(firstHop).toString(), "hello-world");
    assert.equal((await replayable.replay()).toString(), "hello-world");

    const oversized = createReplayableBody(Readable.from(["too-large"]), 4);
    for await (const chunk of oversized.initial) void chunk;
    await assert.rejects(
        oversized.replay(),
        error => error.code === "PROXY_REQUEST_BODY_LIMIT" && error.statusCode === 413
    );
});

test("redirect loop validates a relative target and creates a new connection for every hop", async () => {
    const initialTarget = { url: "http://one.test/start" };
    const nextTarget = { url: "http://one.test/next" };
    const validated = [];
    const dispatched = [];
    let destroyed = 0;

    const result = await requestWithRedirects({
        initialTarget,
        method: "GET",
        headers: {},
        followRedirects: true,
        maxRedirects: 2,
        validateTarget: async url => {
            validated.push(url);
            return nextTarget;
        },
        connectionFactory: target => ({
            httpAgent: {},
            httpsAgent: {},
            assertRemoteAddress() {},
            destroy() { destroyed += 1; },
            target
        }),
        dispatch: async ({ target }) => {
            dispatched.push(target.url);
            if (target === initialTarget) {
                return {
                    status: 302,
                    headers: { location: "/next" },
                    data: Readable.from([])
                };
            }
            return { status: 200, headers: {}, data: Readable.from(["ok"]) };
        }
    });

    assert.deepEqual(validated, ["http://one.test/next"]);
    assert.deepEqual(dispatched, ["http://one.test/start", "http://one.test/next"]);
    assert.equal(result.target, nextTarget);
    assert.equal(result.redirectCount, 1);
    assert.equal(destroyed, 1);
    result.release();
    assert.equal(destroyed, 2);
});
