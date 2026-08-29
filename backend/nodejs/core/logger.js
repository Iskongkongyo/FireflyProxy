const path = require("node:path");
const winston = require("winston");
const { redact } = require("./redact");

function redactFormat() {
    return winston.format(info => {
        for (const key of Object.keys(info)) {
            info[key] = redact(info[key]);
        }
        return info;
    })();
}

function printLog({ timestamp, level, message, ...metadata }) {
    const visibleMetadata = Object.fromEntries(
        Object.entries(metadata).filter(([key, value]) => (
            typeof key === "string" && value !== undefined
        ))
    );
    const suffix = Object.keys(visibleMetadata).length > 0
        ? ` ${JSON.stringify(visibleMetadata)}`
        : "";
    return `[${timestamp}] [${String(level).toUpperCase()}] ${message}${suffix}`;
}

function createLogger(options = {}) {
    const logDir = options.logDir || path.resolve(__dirname, "..");
    const transports = options.transports || [];

    if (!options.transports && options.files !== false) {
        transports.push(
            new winston.transports.File({
                filename: path.join(logDir, "run.log"),
                level: "info",
                format: winston.format(info => info.level === "error" ? false : info)()
            }),
            new winston.transports.File({
                filename: path.join(logDir, "error.log"),
                level: "error"
            })
        );
    }

    if (!options.transports && options.console !== false) {
        transports.push(new winston.transports.Console());
    }

    return winston.createLogger({
        level: options.level || "info",
        format: winston.format.combine(
            redactFormat(),
            winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
            winston.format.printf(printLog)
        ),
        transports
    });
}

module.exports = {
    createLogger
};
