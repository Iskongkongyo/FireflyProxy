const dns = require("node:dns");

const originalLookup = dns.lookup.bind(dns);
const fixtureHostname = (process.env.PROXYWEB_FIXTURE_HOST || "fixture.test").toLowerCase();
const fixtureAddress = process.env.PROXYWEB_FIXTURE_ADDRESS || "127.0.0.1";

dns.lookup = function lookup(hostname, options, callback) {
    let normalizedOptions = options;
    let done = callback;

    if (typeof options === "function") {
        done = options;
        normalizedOptions = {};
    } else if (typeof options === "number") {
        normalizedOptions = { family: options };
    }

    const normalizedHostname = String(hostname).replace(/\.$/, "").toLowerCase();
    if (normalizedHostname !== fixtureHostname) {
        return originalLookup(hostname, options, callback);
    }

    const family = fixtureAddress.includes(":") ? 6 : 4;
    process.nextTick(() => {
        if (normalizedOptions && normalizedOptions.all) {
            done(null, [{ address: fixtureAddress, family }]);
        } else {
            done(null, fixtureAddress, family);
        }
    });
};
