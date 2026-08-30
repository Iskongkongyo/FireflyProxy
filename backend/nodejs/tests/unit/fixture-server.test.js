const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { RANGE_BODY, createUpstreamFixture } = require("../fixtures/upstream-server");

let fixture;

before(async () => {
    fixture = await createUpstreamFixture();
});

after(async () => {
    await fixture.close();
});

test("fixture echoes methods, headers and bodies", async () => {
    const response = await fetch(`${fixture.localOrigin}/echo?case=unit`, {
        method: "POST",
        headers: { "content-type": "text/plain", "x-test-header": "fixture" },
        body: "hello fixture"
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.method, "POST");
    assert.equal(payload.url, "/echo?case=unit");
    assert.equal(payload.headers["x-test-header"], "fixture");
    assert.equal(payload.body, "hello fixture");
});

test("fixture implements deterministic Range responses", async () => {
    const response = await fetch(`${fixture.localOrigin}/range`, {
        headers: { range: "bytes=5-9" }
    });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes 5-9/${RANGE_BODY.length}`);
    assert.equal(await response.text(), RANGE_BODY.subarray(5, 10).toString("utf8"));

    const suffix = await fetch(`${fixture.localOrigin}/range`, {
        headers: { range: "bytes=-5" }
    });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), `bytes ${RANGE_BODY.length - 5}-${RANGE_BODY.length - 1}/${RANGE_BODY.length}`);
    assert.equal(await suffix.text(), RANGE_BODY.subarray(-5).toString("utf8"));
});
