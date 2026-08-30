const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    createSessionStateStore,
    getCookieHeader,
    storeResponseCookies
} = require("../../browser-proxy/sessionStateStore");

test("SessionStateStore isolates jars and applies upstream cookie attributes", async () => {
    const store = createSessionStateStore();
    const first = store.get("session-a", 60000);
    const second = store.get("session-b", 60000);

    await storeResponseCookies(first, "https://www.example.test/account/login", [
        "hostOnly=alpha; Path=/; HttpOnly",
        "scoped=inside; Path=/account; HttpOnly",
        "domainWide=shared; Domain=example.test; Path=/; Secure",
        "expired=gone; Path=/; Max-Age=0"
    ]);

    const accountCookies = await getCookieHeader(first, "https://www.example.test/account/profile");
    assert.match(accountCookies, /hostOnly=alpha/);
    assert.match(accountCookies, /scoped=inside/);
    assert.match(accountCookies, /domainWide=shared/);
    assert.doesNotMatch(accountCookies, /expired=/);

    const rootCookies = await getCookieHeader(first, "https://www.example.test/");
    assert.match(rootCookies, /hostOnly=alpha/);
    assert.doesNotMatch(rootCookies, /scoped=/);

    const subdomainCookies = await getCookieHeader(first, "https://cdn.example.test/asset");
    assert.equal(subdomainCookies, "domainWide=shared");
    assert.equal(await getCookieHeader(first, "http://cdn.example.test/asset"), "");
    assert.equal(await getCookieHeader(second, "https://www.example.test/account/profile"), "");
});

test("SessionStateStore expires, deletes and clears in-memory state", () => {
    let time = 1000;
    const store = createSessionStateStore({ now: () => time });
    const initial = store.get("session-a", 100);
    assert.equal(store.size, 1);
    assert.equal(store.get("session-a", 100), initial);

    time = 1201;
    assert.equal(store.size, 0);
    assert.notEqual(store.get("session-a", 100), initial);
    assert.equal(store.delete("session-a"), true);
    store.get("session-b", 100);
    store.clear();
    assert.equal(store.size, 0);
});

test("invalid upstream cookies are ignored without exposing values", async () => {
    const store = createSessionStateStore();
    const state = store.get("session-a", 60000);
    await storeResponseCookies(state, "https://example.test/", [
        "not a valid cookie",
        "public=bad; Domain=com; Path=/"
    ]);
    assert.equal(await getCookieHeader(state, "https://example.test/"), "");
});
