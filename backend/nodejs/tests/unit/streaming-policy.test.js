const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    applyStreamingHeaders,
    flushStreamingHeaders,
    isEventStream
} = require("../../core/streamingPolicy");

const eventStream = Object.freeze({
    kind: "stream",
    mediaType: "text/event-stream"
});

test("SSE streaming policy disables reverse-proxy buffering without mutating upstream headers", () => {
    const upstream = { "content-type": "text/event-stream", "x-accel-buffering": "yes" };
    const headers = applyStreamingHeaders(upstream, eventStream);

    assert.equal(isEventStream(eventStream), true);
    assert.equal(headers["x-accel-buffering"], "no");
    assert.equal(upstream["x-accel-buffering"], "yes");
    assert.deepEqual(applyStreamingHeaders(upstream, {
        kind: "stream",
        mediaType: "video/mp4"
    }), upstream);
});

test("only SSE responses flush downstream headers before the first body chunk", () => {
    let flushes = 0;
    const response = { flushHeaders() { flushes += 1; } };

    assert.equal(flushStreamingHeaders(response, eventStream), true);
    assert.equal(flushes, 1);
    assert.equal(flushStreamingHeaders(response, { kind: "transform", mediaType: "text/html" }), false);
    assert.equal(flushStreamingHeaders({}, eventStream), false);
    assert.equal(flushes, 1);
});
