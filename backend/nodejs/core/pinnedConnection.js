const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { domainToASCII } = require("node:url");
const { ERROR_CODES, ProxyError } = require("./errors");
const { normalizeIpAddress } = require("./targetValidator");

function normalizeLookupHostname(value) {
    const hostname = String(value || "").replace(/\.$/, "").toLowerCase();
    return net.isIP(hostname) ? hostname : domainToASCII(hostname).toLowerCase();
}

function createLookupError(code, hostname) {
    const error = new Error(`Pinned DNS lookup rejected ${hostname}`);
    error.code = code;
    error.hostname = hostname;
    return error;
}

function normalizeLookupOptions(options) {
    if (typeof options === "number") return { family: options, all: false };
    return {
        family: options && Number(options.family) || 0,
        all: Boolean(options && options.all)
    };
}

function validatePinnedTarget(target) {
    if (!target || typeof target.hostname !== "string" || !Array.isArray(target.addresses)) {
        throw new TypeError("Pinned connection requires a validated target");
    }

    const hostname = normalizeLookupHostname(target.hostname);
    const addresses = target.addresses.map(record => {
        const normalized = record && normalizeIpAddress(record.address);
        if (!normalized || normalized.family !== record.family) {
            throw new TypeError("Pinned connection received an invalid address record");
        }
        return Object.freeze({ address: normalized.address, family: normalized.family });
    });

    if (!hostname || addresses.length === 0) {
        throw new TypeError("Pinned connection requires at least one validated address");
    }

    return { hostname, addresses: Object.freeze(addresses) };
}

function createPinnedLookup(target) {
    const pinned = validatePinnedTarget(target);

    return function lookup(hostname, options, callback) {
        let lookupOptions = options;
        let done = callback;
        if (typeof options === "function") {
            done = options;
            lookupOptions = {};
        }
        if (typeof done !== "function") throw new TypeError("DNS lookup callback is required");

        const requestedHostname = normalizeLookupHostname(hostname);
        if (requestedHostname !== pinned.hostname) {
            return process.nextTick(done, createLookupError("ENOTFOUND", requestedHostname));
        }

        const normalizedOptions = normalizeLookupOptions(lookupOptions);
        const matches = normalizedOptions.family
            ? pinned.addresses.filter(record => record.family === normalizedOptions.family)
            : pinned.addresses;
        if (matches.length === 0) {
            return process.nextTick(done, createLookupError("EAI_ADDRFAMILY", requestedHostname));
        }

        if (normalizedOptions.all) {
            return process.nextTick(done, null, matches.map(record => ({ ...record })));
        }
        return process.nextTick(done, null, matches[0].address, matches[0].family);
    };
}

function assertPinnedRemoteAddress(target, remoteAddress) {
    const pinned = validatePinnedTarget(target);
    const normalized = normalizeIpAddress(remoteAddress);
    const allowed = new Set(pinned.addresses.map(record => `${record.family}:${record.address}`));
    if (!normalized || !allowed.has(`${normalized.family}:${normalized.address}`)) {
        throw new ProxyError(ERROR_CODES.SSRF_BLOCKED, "Upstream connection address was not validated", {
            statusCode: 403,
            details: {
                hostname: pinned.hostname,
                remoteAddress: normalized ? normalized.address : null,
                reason: "pinned-address-mismatch"
            }
        });
    }
    return normalized.address;
}

function installConnectTimeout(agent, connectTimeoutMs) {
    if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
        throw new TypeError("Connect timeout must be a positive integer");
    }

    const createConnection = agent.createConnection.bind(agent);
    agent.createConnection = (options, callback) => {
        let timer;
        const clearTimer = () => {
            if (!timer) return;
            clearTimeout(timer);
            timer = null;
        };
        const socket = createConnection(options, (...args) => {
            clearTimer();
            if (callback) callback(...args);
        });
        timer = setTimeout(() => {
            socket.destroy(new ProxyError(ERROR_CODES.CONNECT_TIMEOUT, "Upstream connection timed out", {
                statusCode: 504,
                details: { connectTimeoutMs }
            }));
        }, connectTimeoutMs);
        timer.unref?.();
        socket.once("error", clearTimer);
        socket.once("close", clearTimer);
        return socket;
    };
    return agent;
}

function createPinnedConnection(target, options = {}) {
    const pinned = validatePinnedTarget(target);
    const lookup = createPinnedLookup(target);
    const connectTimeoutMs = options.connectTimeoutMs || 5000;
    const httpAgent = installConnectTimeout(new http.Agent({ keepAlive: false, lookup }), connectTimeoutMs);
    const httpsOptions = {
        keepAlive: false,
        lookup,
        rejectUnauthorized: true
    };
    if (!net.isIP(pinned.hostname)) httpsOptions.servername = pinned.hostname;
    const httpsAgent = installConnectTimeout(new https.Agent(httpsOptions), connectTimeoutMs);

    return Object.freeze({
        lookup,
        httpAgent,
        httpsAgent,
        assertRemoteAddress(remoteAddress) {
            if (remoteAddress) return assertPinnedRemoteAddress(target, remoteAddress);
            // Some platforms do not expose remoteAddress on an active client socket.
            // The request-specific Agent still cannot resolve outside this frozen set.
            return pinned.addresses[0].address;
        },
        destroy() {
            httpAgent.destroy();
            httpsAgent.destroy();
        }
    });
}

module.exports = {
    assertPinnedRemoteAddress,
    createPinnedConnection,
    createPinnedLookup,
    installConnectTimeout,
    normalizeLookupHostname
};
