const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    parseBooleanControl,
    parseMaxRedirects,
    resolveApiRedirectOptions
} = require("../../api-proxy/requestControls");

test("API redirect controls parse only canonical scalar values", () => {
    assert.equal(parseBooleanControl(undefined, "followRedirects"), undefined);
    assert.equal(parseBooleanControl("true", "followRedirects"), true);
    assert.equal(parseBooleanControl("false", "followRedirects"), false);
    assert.equal(parseMaxRedirects("0"), 0);
    assert.equal(parseMaxRedirects("20"), 20);
    for (const value of ["TRUE", "1", "", ["true"], 1]) {
        assert.throws(() => parseBooleanControl(value, "followRedirects"), error =>
            error.code === "PROXY_REQUEST_CONTROL_INVALID" && error.statusCode === 400);
    }
    for (const value of ["-1", "01", "21", "1.5", "NaN", ["2"]]) {
        assert.throws(() => parseMaxRedirects(value), error =>
            error.code === "PROXY_REQUEST_CONTROL_INVALID" && error.statusCode === 400);
    }
});

test("per-request redirect controls can only tighten global policy", () => {
    const enabled = { api: { followRedirects: true, maxRedirects: 5 } };
    assert.deepEqual(resolveApiRedirectOptions(enabled), { followRedirects: true, maxRedirects: 5 });
    assert.deepEqual(resolveApiRedirectOptions(enabled, {
        followRedirects: "false", maxRedirects: "2"
    }), { followRedirects: false, maxRedirects: 2 });

    const disabled = { api: { followRedirects: false, maxRedirects: 3 } };
    assert.deepEqual(resolveApiRedirectOptions(disabled, {
        followRedirects: "true", maxRedirects: "10"
    }), { followRedirects: false, maxRedirects: 3 });
});
