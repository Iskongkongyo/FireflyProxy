const dns = require("node:dns");

const DEFAULT_DNS_TIMEOUT_MS = 5000;

class DnsResolutionError extends Error {
    constructor(code, message, options = {}) {
        super(message, { cause: options.cause });
        this.name = "DnsResolutionError";
        this.code = code;
    }
}

function withTimeout(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            reject(new DnsResolutionError("DNS_LOOKUP_TIMEOUT", "DNS lookup timed out"));
        }, timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createDnsResolver(options = {}) {
    const lookup = options.lookup || dns.promises.lookup.bind(dns.promises);
    const timeoutMs = options.timeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;

    if (typeof lookup !== "function") throw new TypeError("DNS lookup must be a function");
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError("DNS timeout must be a positive integer");
    }

    return Object.freeze({
        async resolve(hostname) {
            let results;
            try {
                results = await withTimeout(
                    Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })),
                    timeoutMs
                );
            } catch (error) {
                if (error instanceof DnsResolutionError) throw error;
                throw new DnsResolutionError("DNS_LOOKUP_FAILED", "DNS lookup failed", { cause: error });
            }

            if (!Array.isArray(results) || results.length === 0) {
                throw new DnsResolutionError("DNS_EMPTY_RESULT", "DNS lookup returned no addresses");
            }
            return results;
        }
    });
}

module.exports = {
    DEFAULT_DNS_TIMEOUT_MS,
    DnsResolutionError,
    createDnsResolver
};
