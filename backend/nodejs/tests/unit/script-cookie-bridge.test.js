const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    encodeScriptCookieName,
    getScriptCookieHeader,
    mergeCookieHeaders,
    scriptCookiePrefix
} = require("../../browser-proxy/scriptCookieBridge");

test("Script Cookie Bridge selects only carriers bound to the current upstream origin", () => {
    const target = "https://www.example.test/watch/1";
    const otherTarget = "https://other.test/watch/1";
    const disclaimer = `${scriptCookiePrefix(target)}${encodeScriptCookieName("dscld")}`;
    const preference = `${scriptCookiePrefix(target)}${encodeScriptCookieName("display_mode")}`;
    const foreign = `${scriptCookiePrefix(otherTarget)}${encodeScriptCookieName("foreign")}`;
    const inbound = [
        "proxySession=control-secret",
        `${disclaimer}=true`,
        `${preference}=compact%3D1`,
        `${foreign}=must-not-leak`,
        `${scriptCookiePrefix(target)}not*=invalid`
    ].join("; ");

    assert.equal(
        getScriptCookieHeader(inbound, target),
        "dscld=true; display_mode=compact%3D1"
    );
    assert.equal(getScriptCookieHeader(inbound, otherTarget), "foreign=must-not-leak");
});

test("Script Cookie Bridge merges client script state without forwarding proxy cookies", () => {
    assert.equal(
        mergeCookieHeaders(
            "session_token=server-token; dscld=old; scoped=server",
            "dscld=true; client_only=yes"
        ),
        "session_token=server-token; scoped=server; dscld=true; client_only=yes"
    );
    assert.equal(mergeCookieHeaders("session_token=server-token", ""), "session_token=server-token");
});
