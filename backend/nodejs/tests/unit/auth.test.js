const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createProxyAuth } = require("../../middleware/auth");

function authorization(user, password) {
    return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function createResponse() {
    return {
        headers: {},
        statusCode: null,
        body: null,
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        status(value) { this.statusCode = value; return this; },
        send(value) { this.body = value; return this; }
    };
}

function silentLogger() {
    return { warn() {} };
}

test("valid proxy credentials are consumed and replaced by non-secret auth context", () => {
    const middleware = createProxyAuth({
        getConfig: () => ({ user: "proxy-user", pwd: "proxy-password" }),
        logger: silentLogger()
    });
    const request = {
        id: "request-1",
        headers: { authorization: authorization("proxy-user", "proxy-password") }
    };
    let nextCalled = false;

    middleware(request, createResponse(), () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(request.headers.authorization, undefined);
    assert.deepEqual(request.proxyAuth, { user: "proxy-user" });
    assert.equal(Object.isFrozen(request.proxyAuth), true);
});

test("invalid proxy credentials are removed before returning 401", () => {
    const middleware = createProxyAuth({
        getConfig: () => ({ user: "proxy-user", pwd: "proxy-password" }),
        logger: silentLogger()
    });
    const request = {
        headers: { Authorization: authorization("proxy-user", "wrong-password") }
    };
    const response = createResponse();

    middleware(request, response, () => assert.fail("next should not be called"));

    assert.equal(request.headers.Authorization, undefined);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body, "Unauthorized");
    assert.match(response.headers["www-authenticate"], /Basic/);
});

test("open mode still consumes ordinary Authorization instead of forwarding it", () => {
    const middleware = createProxyAuth({
        getConfig: () => ({ user: "", pwd: "" }),
        logger: silentLogger()
    });
    const request = {
        headers: { authorization: "Bearer must-not-be-upstream" }
    };
    let nextCalled = false;

    middleware(request, createResponse(), () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(request.headers.authorization, undefined);
});
