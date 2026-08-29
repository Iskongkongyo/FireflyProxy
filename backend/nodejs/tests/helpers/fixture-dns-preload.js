const dns = require("node:dns");

const originalLookup = dns.lookup.bind(dns);
const dnsPromises = dns.promises;
const originalPromisesLookup = dnsPromises.lookup.bind(dnsPromises);
const fixtureHostname = (process.env.PROXYWEB_FIXTURE_HOST || "fixture.test").toLowerCase();
const fixtureAddress = process.env.PROXYWEB_FIXTURE_ADDRESS || "127.0.0.1";
const fixtureValidationAddress = process.env.PROXYWEB_FIXTURE_VALIDATION_ADDRESS || "93.184.216.34";

let validationRecords = {};
try {
    validationRecords = JSON.parse(process.env.PROXYWEB_VALIDATION_DNS_RECORDS || "{}");
} catch {
    validationRecords = {};
}

function normalizeHostname(hostname) {
    return String(hostname).replace(/\.$/, "").toLowerCase();
}

dns.lookup = function lookup(hostname, options, callback) {
    let normalizedOptions = options;
    let done = callback;

    if (typeof options === "function") {
        done = options;
        normalizedOptions = {};
    } else if (typeof options === "number") {
        normalizedOptions = { family: options };
    }

    const normalizedHostname = normalizeHostname(hostname);
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

dnsPromises.lookup = async function lookup(hostname, options) {
    const normalizedHostname = normalizeHostname(hostname);
    const configured = validationRecords[normalizedHostname];

    if (configured && configured.error) {
        const error = new Error("fixture DNS lookup failed");
        error.code = configured.error;
        throw error;
    }
    if (Array.isArray(configured)) return configured;
    if (normalizedHostname === fixtureHostname) {
        return [{
            address: fixtureValidationAddress,
            family: fixtureValidationAddress.includes(":") ? 6 : 4
        }];
    }
    return originalPromisesLookup(hostname, options);
};
