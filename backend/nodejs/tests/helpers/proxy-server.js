const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { createApp } = require("../../app");
const { createProcessLifecycle } = require("../../core/processLifecycle");
const { createPinnedConnection } = require("../../core/pinnedConnection");
const { normalizeIpAddress } = require("../../core/targetValidator");

const fixtureAddress = process.env.PROXYWEB_FIXTURE_ADDRESS || "127.0.0.1";
const fixtureFamily = net.isIP(fixtureAddress);

function createFixtureConnection(target) {
    const pinned = createPinnedConnection(target);
    const lookup = (hostname, options, callback) => {
        let lookupOptions = options;
        let done = callback;
        if (typeof options === "function") {
            done = options;
            lookupOptions = {};
        }

        pinned.lookup(hostname, lookupOptions, error => {
            if (error) return done(error);
            const mapped = { address: fixtureAddress, family: fixtureFamily };
            if (lookupOptions && lookupOptions.all) return done(null, [mapped]);
            return done(null, mapped.address, mapped.family);
        });
    };

    const httpAgent = new http.Agent({ keepAlive: false, lookup });
    const httpsAgent = new https.Agent({
        keepAlive: false,
        lookup,
        rejectUnauthorized: true,
        servername: target.hostname
    });
    pinned.destroy();

    return {
        httpAgent,
        httpsAgent,
        assertRemoteAddress(remoteAddress) {
            if (!remoteAddress) return fixtureAddress;
            const normalized = normalizeIpAddress(remoteAddress);
            if (!normalized || normalized.address !== fixtureAddress || normalized.family !== fixtureFamily) {
                throw new Error(`Fixture connection reached an unexpected address: ${remoteAddress || "missing"}`);
            }
            return normalized.address;
        },
        destroy() {
            httpAgent.destroy();
            httpsAgent.destroy();
        }
    };
}

const runtime = createApp({ connectionFactory: createFixtureConnection });
const config = runtime.getConfig();
const server = http.createServer(runtime.app);
runtime.attachServer(server);
server.listen(config.port, () => {
    runtime.logger.info(`[Server] Contract proxy running on port ${config.port}`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

createProcessLifecycle({ server, runtime, logger: runtime.logger }).register();
