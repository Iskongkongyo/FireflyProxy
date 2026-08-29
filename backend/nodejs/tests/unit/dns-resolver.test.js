const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    DnsResolutionError,
    createDnsResolver
} = require("../../core/dnsResolver");

test("DNS resolver requests every address in resolver order", async () => {
    const calls = [];
    const records = [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 }
    ];
    const resolver = createDnsResolver({
        lookup: async (hostname, options) => {
            calls.push({ hostname, options });
            return records;
        }
    });

    assert.strictEqual(await resolver.resolve("example.test"), records);
    assert.deepEqual(calls, [{
        hostname: "example.test",
        options: { all: true, verbatim: true }
    }]);
});

test("DNS resolver fails closed for empty and failed lookups", async () => {
    const empty = createDnsResolver({ lookup: async () => [] });
    await assert.rejects(
        empty.resolve("empty.test"),
        error => error instanceof DnsResolutionError && error.code === "DNS_EMPTY_RESULT"
    );

    const cause = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    const failed = createDnsResolver({ lookup: async () => { throw cause; } });
    await assert.rejects(
        failed.resolve("missing.test"),
        error => (
            error instanceof DnsResolutionError
            && error.code === "DNS_LOOKUP_FAILED"
            && error.cause === cause
        )
    );
});

test("DNS resolver applies a bounded lookup timeout", async () => {
    const resolver = createDnsResolver({
        lookup: () => new Promise(() => {}),
        timeoutMs: 10
    });

    await assert.rejects(
        resolver.resolve("slow.test"),
        error => error instanceof DnsResolutionError && error.code === "DNS_LOOKUP_TIMEOUT"
    );

    assert.throws(
        () => createDnsResolver({ lookup: async () => [], timeoutMs: 0 }),
        /positive integer/
    );
});
