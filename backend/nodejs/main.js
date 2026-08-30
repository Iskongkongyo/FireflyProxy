const http = require("node:http");
const { createApp } = require("./app");
const { createProcessLifecycle } = require("./core/processLifecycle");

const runtime = createApp();
const config = runtime.getConfig();
const logger = runtime.logger;

const server = http.createServer(runtime.app);
runtime.attachServer(server);
server.listen(config.port, () => {
    logger.info(`[Server] Reverse Proxy running on port ${config.port}`);
    logger.info("[Security] SSRF Protection: Enabled");
    logger.info("[System] Hot Reload: Enabled");
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

createProcessLifecycle({ server, runtime, logger }).register();
