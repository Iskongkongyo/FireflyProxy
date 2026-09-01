const { timingSafeEqual } = require("node:crypto");
const basicAuth = require("basic-auth");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { ConfigLoadError } = require("../config/loader");
const { ERROR_CODES, ProxyError } = require("../core/errors");
const { requestOrigin } = require("../core/originIsolation");
const { clearProxyAuthorization } = require("../middleware/auth");
const { createAdminSnapshot } = require("./configManager");
const { createAdminPage } = require("./page");

function isAdminPath(pathname, adminPath) {
    return pathname === adminPath || pathname.startsWith(`${adminPath}/`);
}

function createAdminRouteMarker({ getConfig }) {
    return (req, res, next) => {
        const { path } = getConfig().admin;
        if (isAdminPath(req.path, path)) req.proxyWebAdminRoute = true;
        next();
    };
}

function createAdminHomeMarker({ getConfig }) {
    return (req, res, next) => {
        const config = getConfig();
        const hasTarget = Object.prototype.hasOwnProperty.call(req.query || {}, "url")
            || Boolean(req.session?.targetUrl);
        if (
            config.admin.enabled
            && !config.defaultSkip
            && ["GET", "HEAD"].includes(req.method)
            && req.path === "/"
            && !hasTarget
        ) {
            req.proxyWebAdminHome = true;
        }
        next();
    };
}

function safeCredentialEqual(actual, expected) {
    const left = Buffer.from(String(actual || ""), "utf8");
    const right = Buffer.from(String(expected || ""), "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
}

function authenticateAdmin(req, config) {
    const credentials = basicAuth(req);
    clearProxyAuthorization(req);
    return Boolean(
        credentials
        && safeCredentialEqual(credentials.name, config.admin.user)
        && safeCredentialEqual(credentials.pass, config.admin.pwd)
    );
}

function secureAdminResponse(res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
}

function sameOriginReferer(req) {
    const expectedOrigin = requestOrigin(req);
    const value = req.headers.referer;
    if (!expectedOrigin || typeof value !== "string") return null;
    try {
        const referer = new URL(value);
        return referer.origin === expectedOrigin ? referer : null;
    } catch {
        return null;
    }
}

function adminApiSourceAllowed(req, adminPath) {
    const referer = sameOriginReferer(req);
    return Boolean(referer && (referer.pathname === adminPath || referer.pathname === `${adminPath}/`));
}

function adminPageSourceAllowed(req, adminPath) {
    const referer = sameOriginReferer(req);
    if (referer) {
        if (referer.pathname === "/" || isAdminPath(referer.pathname, adminPath)) return true;
        const previous = req.session?.proxyWebAdminPreviousPath;
        if (
            previous
            && previous.expiresAt > Date.now()
            && isAdminPath(referer.pathname, previous.path)
        ) {
            return true;
        }
        return false;
    }
    const fetchSite = req.headers["sec-fetch-site"];
    return fetchSite === undefined || fetchSite === "none";
}

function adminError(code, message, statusCode, cause) {
    return new ProxyError(code, message, { statusCode, cause });
}

function createAdminRouter({ getConfig, saveConfig }) {
    const jsonParser = express.json({ limit: "256kb", strict: true, type: "application/json" });
    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        handler(req, res) {
            res.status(429).json({
                error: {
                    code: ERROR_CODES.ADMIN_RATE_LIMIT,
                    message: "Too many admin authentication attempts"
                }
            });
        }
    });

    return (req, res, next) => {
        if (!req.proxyWebAdminRoute) return next();
        const config = getConfig();
        if (!isAdminPath(req.path, config.admin.path)) return next();
        if (!config.admin.enabled) {
            return next(adminError(ERROR_CODES.ADMIN_DISABLED, "Admin console is disabled", 404));
        }

        secureAdminResponse(res);
        const basePath = config.admin.path;
        const apiPath = `${basePath}/api/config`;
        const pageRequest = req.path === basePath || req.path === `${basePath}/`;
        const apiRequest = req.path === apiPath;
        if (
            (pageRequest && !adminPageSourceAllowed(req, basePath))
            || (apiRequest && !adminApiSourceAllowed(req, basePath))
        ) {
            return next(adminError(
                ERROR_CODES.ADMIN_ORIGIN_DENIED,
                "Admin request source is not allowed",
                403
            ));
        }
        return loginLimiter(req, res, () => {
            if (!authenticateAdmin(req, config)) {
                res.setHeader("WWW-Authenticate", 'Basic realm="proxyWeb Admin", charset="UTF-8"');
                return res.status(401).json({
                    error: {
                        code: ERROR_CODES.ADMIN_AUTH_REQUIRED,
                        message: "Admin authentication is required"
                    }
                });
            }

            if (req.method === "GET" && req.path === `${basePath}/`) {
                return res.redirect(308, basePath);
            }
            if (req.method === "GET" && req.path === basePath) {
                if (req.session?.proxyWebAdminPreviousPath) {
                    delete req.session.proxyWebAdminPreviousPath;
                }
                return res.type("html").send(createAdminPage());
            }
            if (req.method === "GET" && req.path === apiPath) {
                return res.json({
                    ...createAdminSnapshot(config),
                    restartOnly: ["port", "trustProxy", "session"]
                });
            }
            if (req.method === "PUT" && req.path === apiPath) {
                const expectedOrigin = requestOrigin(req);
                if (
                    !expectedOrigin
                    || req.headers.origin !== expectedOrigin
                    || req.headers["x-proxyweb-admin"] !== "1"
                ) {
                    return next(adminError(
                        ERROR_CODES.ADMIN_ORIGIN_DENIED,
                        "Admin configuration update origin is not allowed",
                        403
                    ));
                }
                return jsonParser(req, res, async error => {
                    if (error) return next(adminError(
                        ERROR_CODES.ADMIN_CONFIG_INVALID,
                        "Admin configuration payload is invalid",
                        error.status || 400,
                        error
                    ));
                    try {
                        const result = await saveConfig(req.body?.config);
                        if (result.config.admin.path !== basePath && req.session) {
                            req.session.proxyWebAdminPreviousPath = {
                                path: basePath,
                                expiresAt: Date.now() + 60_000
                            };
                        }
                        return res.json({
                            ok: true,
                            adminEnabled: result.config.admin.enabled,
                            adminPath: result.config.admin.path,
                            adminCredentialsChanged: result.adminCredentialsChanged,
                            restartRequired: result.restartRequired,
                            warnings: result.warnings
                        });
                    } catch (saveError) {
                        const publicMessage = saveError instanceof ConfigLoadError
                            ? saveError.message
                            : "Unable to save configuration";
                        return next(adminError(
                            ERROR_CODES.ADMIN_CONFIG_INVALID,
                            publicMessage,
                            saveError instanceof ConfigLoadError ? 400 : 500,
                            saveError
                        ));
                    }
                });
            }
            return next(adminError(ERROR_CODES.ROUTE_NOT_FOUND, "Admin route was not found", 404));
        });
    };
}

module.exports = {
    authenticateAdmin,
    adminApiSourceAllowed,
    adminPageSourceAllowed,
    createAdminRouteMarker,
    createAdminHomeMarker,
    createAdminRouter,
    isAdminPath,
    safeCredentialEqual,
    secureAdminResponse
};
