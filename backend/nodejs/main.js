const { createApp } = require("./app");

const runtime = createApp();
const config = runtime.getConfig();
const logger = runtime.logger;

const server = runtime.app.listen(config.port, () => {
    logger.info(`[Server] Reverse Proxy running on port ${config.port}`);
    logger.info("[Security] SSRF Protection: Enabled");
    logger.info("[System] Hot Reload: Enabled");
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// 保持当前异常记录行为；退出策略将在 P0-11 阶段单独收紧。
process.on("uncaughtException", err => {
    logger.error("[System] Uncaught Exception", { error: err });
});

process.on("unhandledRejection", reason => {
    logger.error("[System] Unhandled Rejection", { error: reason });
});

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[System] ${signal} received, shutting down...`);

    const forceExitTimer = setTimeout(() => {
        logger.error("[System] Graceful shutdown timed out.");
        process.exit(1);
    }, 5000);
    forceExitTimer.unref();

    try {
        await runtime.close();
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
        clearTimeout(forceExitTimer);
        process.exit(0);
    } catch (error) {
        clearTimeout(forceExitTimer);
        logger.error("[System] Graceful shutdown failed", { error });
        process.exit(1);
    }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
