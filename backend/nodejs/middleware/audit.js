const { normalizeClientIp } = require("../core/clientAccess");

function requestMode(req) {
    if (req.fireflyProxyAdminRoute || req.fireflyProxyAdminHome) return null;
    if (req.path === "/__proxyweb/api" || req.path.startsWith("/__proxyweb/api/")) return "api";
    if (req.path === "/__proxyweb/browser" || req.path.startsWith("/__proxyweb/browser/")) return "browser";
    if (req.path === "/__proxyweb/runtime.js") return "browser-runtime";
    if (req.path === "/web" || req.path.startsWith("/web/")) return null;
    return "legacy";
}

function queryTargetOrigin(req) {
    const value = req.query?.url;
    if (typeof value !== "string") return "";
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
    } catch {
        return "";
    }
}

function createRequestAudit({ getConfig, auditStore, logger, now = Date.now }) {
    return (req, res, next) => {
        const mode = requestMode(req);
        if (!mode || !getConfig().audit.enabled) return next();
        const startedAt = now();
        res.once("finish", () => {
            const config = getConfig().audit;
            try {
                auditStore.record({
                    timestamp: startedAt,
                    category: "request",
                    action: "request.completed",
                    outcome: res.statusCode >= 400 ? "failed" : "success",
                    ip: normalizeClientIp(req.ip || req.socket?.remoteAddress) || "",
                    method: req.method,
                    mode,
                    targetOrigin: config.recordTargetOrigin
                        ? (res.locals.fireflyProxyTargetOrigin || queryTargetOrigin(req))
                        : "",
                    status: res.statusCode,
                    durationMs: now() - startedAt,
                    requestId: req.id
                });
            } catch (error) {
                logger?.error("[Audit] Unable to record completed request", {
                    requestId: req.id,
                    error
                });
            }
        });
        next();
    };
}

module.exports = {
    createRequestAudit,
    queryTargetOrigin,
    requestMode
};
