function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close(error => {
            if (!error || error.code === "ERR_SERVER_NOT_RUNNING") return resolve();
            reject(error);
        });
    });
}

function createProcessLifecycle(options) {
    const {
        server,
        runtime,
        logger,
        processRef = process,
        forceExitMs = 5000,
        exit = code => processRef.exit(code)
    } = options;
    let shutdownPromise = null;

    async function performShutdown(reason, exitCode) {
        logger.info(`[System] ${reason} received, shutting down...`);
        const forceExitTimer = setTimeout(() => {
            logger.error("[System] Graceful shutdown timed out.");
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
            exit(1);
        }, forceExitMs);
        forceExitTimer.unref?.();

        try {
            const serverClosed = closeServer(server);
            await runtime.close();
            await serverClosed;
            clearTimeout(forceExitTimer);
            exit(exitCode);
        } catch (error) {
            clearTimeout(forceExitTimer);
            logger.error("[System] Graceful shutdown failed", { error });
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
            exit(1);
        }
    }

    function shutdown(reason, exitCode = 0) {
        if (!shutdownPromise) shutdownPromise = performShutdown(reason, exitCode);
        return shutdownPromise;
    }

    function register() {
        processRef.once("SIGINT", () => void shutdown("SIGINT", 0));
        processRef.once("SIGTERM", () => void shutdown("SIGTERM", 0));
        processRef.once("uncaughtException", error => {
            logger.error("[System] Uncaught Exception", { error });
            void shutdown("uncaughtException", 1);
        });
        processRef.once("unhandledRejection", reason => {
            logger.error("[System] Unhandled Rejection", { error: reason });
            void shutdown("unhandledRejection", 1);
        });
    }

    return Object.freeze({ register, shutdown });
}

module.exports = {
    closeServer,
    createProcessLifecycle
};
