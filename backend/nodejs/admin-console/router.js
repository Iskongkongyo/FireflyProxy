const { timingSafeEqual } = require("node:crypto");
const basicAuth = require("basic-auth");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { ConfigLoadError } = require("../config/loader");
const {
    assertClientRuleCanBeBlocked,
    localInterfaceAddresses,
    normalizeClientIp
} = require("../core/clientAccess");
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
        if (isAdminPath(req.path, path)) req.fireflyProxyAdminRoute = true;
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
            req.fireflyProxyAdminHome = true;
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
        "default-src 'none'; connect-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
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
        const previous = req.session?.fireflyProxyAdminPreviousPath;
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

function auditUnavailable(error) {
    return adminError(
        ERROR_CODES.AUDIT_UNAVAILABLE,
        "Audit storage is unavailable",
        503,
        error
    );
}

function recordAdminEvent(auditStore, req, input) {
    try {
        return auditStore.record({
            category: "admin",
            ip: normalizeClientIp(req.ip || req.socket?.remoteAddress) || "",
            method: req.method,
            mode: "admin",
            requestId: req.id,
            ...input
        });
    } catch {
        return null;
    }
}

function changedConfigPaths(previous, next, prefix = "", output = []) {
    if (output.length >= 100) return output;
    const left = previous && typeof previous === "object" ? previous : {};
    const right = next && typeof next === "object" ? next : {};
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        const path = prefix ? `${prefix}.${key}` : key;
        const leftValue = left[key];
        const rightValue = right[key];
        if (
            leftValue && rightValue
            && typeof leftValue === "object" && typeof rightValue === "object"
            && !Array.isArray(leftValue) && !Array.isArray(rightValue)
        ) {
            changedConfigPaths(leftValue, rightValue, path, output);
        } else if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
            output.push(path);
        }
        if (output.length >= 100) break;
    }
    return output;
}

function mutationSourceAllowed(req) {
    const expectedOrigin = requestOrigin(req);
    return Boolean(
        expectedOrigin
        && req.headers.origin === expectedOrigin
        && req.headers["x-fireflyproxy-admin"] === "1"
    );
}

function createAdminRouter({ getConfig, saveConfig, publicStaticCache, auditStore, logger }) {
    const jsonParser = express.json({ limit: "256kb", strict: true, type: "application/json" });
    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        handler(req, res) {
            recordAdminEvent(auditStore, req, {
                action: "admin.authentication",
                outcome: "rate-limited",
                status: 429
            });
            res.status(429).json({
                error: {
                    code: ERROR_CODES.ADMIN_RATE_LIMIT,
                    message: "Too many admin authentication attempts"
                }
            });
        }
    });

    return (req, res, next) => {
        if (!req.fireflyProxyAdminRoute) return next();
        const config = getConfig();
        if (!isAdminPath(req.path, config.admin.path)) return next();
        if (!config.admin.enabled) {
            return next(adminError(ERROR_CODES.ADMIN_DISABLED, "Admin console is disabled", 404));
        }

        secureAdminResponse(res);
        const basePath = config.admin.path;
        const apiPath = `${basePath}/api/config`;
        const cacheApiPath = `${basePath}/api/cache`;
        const auditApiPath = `${basePath}/api/audit`;
        const bansApiPath = `${basePath}/api/bans`;
        const pageRequest = req.path === basePath || req.path === `${basePath}/`;
        const adminApiRequest = req.path.startsWith(`${basePath}/api/`);
        if (
            (pageRequest && !adminPageSourceAllowed(req, basePath))
            || (adminApiRequest && !adminApiSourceAllowed(req, basePath))
        ) {
            recordAdminEvent(auditStore, req, {
                action: "admin.source-check",
                outcome: "failed",
                status: 403
            });
            return next(adminError(
                ERROR_CODES.ADMIN_ORIGIN_DENIED,
                "Admin request source is not allowed",
                403
            ));
        }
        return loginLimiter(req, res, () => {
            if (!authenticateAdmin(req, config)) {
                recordAdminEvent(auditStore, req, {
                    action: "admin.authentication",
                    outcome: "failed",
                    status: 401
                });
                res.setHeader("WWW-Authenticate", 'Basic realm="FireflyProxy Admin", charset="UTF-8"');
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
                if (req.session?.fireflyProxyAdminPreviousPath) {
                    delete req.session.fireflyProxyAdminPreviousPath;
                }
                recordAdminEvent(auditStore, req, {
                    action: "admin.authentication",
                    outcome: "success",
                    status: 200
                });
                return res.type("html").send(createAdminPage());
            }
            if (req.method === "GET" && req.path === apiPath) {
                return res.json({
                    ...createAdminSnapshot(config),
                    restartOnly: ["port", "trustProxy", "session", "runtimeState", "audit.backend/sqlitePath"]
                });
            }
            if (req.method === "GET" && req.path === auditApiPath) {
                try {
                    return res.json({
                        ...auditStore.query(req.query || {}),
                        enabled: config.audit.enabled,
                        backend: auditStore.backend
                    });
                } catch (error) {
                    return next(auditUnavailable(error));
                }
            }
            if (req.method === "DELETE" && req.path === auditApiPath) {
                if (!mutationSourceAllowed(req)) {
                    recordAdminEvent(auditStore, req, {
                        action: "admin.source-check",
                        outcome: "failed",
                        status: 403,
                        detail: "operation=audit.clear"
                    });
                    return next(adminError(
                        ERROR_CODES.ADMIN_ORIGIN_DENIED,
                        "Admin audit clearing origin is not allowed",
                        403
                    ));
                }
                let removed;
                try {
                    removed = auditStore.clearEvents();
                } catch (error) {
                    return next(auditUnavailable(error));
                }
                recordAdminEvent(auditStore, req, {
                    action: "audit.clear",
                    outcome: "success",
                    status: 200,
                    detail: `removed=${removed}`
                });
                return res.json({ ok: true, removed });
            }
            if (req.method === "GET" && req.path === bansApiPath) {
                try {
                    return res.json({
                        enabled: config.clientAccessControl.enabled,
                        backend: auditStore.backend,
                        items: auditStore.listBans(),
                        protectedAddresses: localInterfaceAddresses(),
                        neverBlock: config.clientAccessControl.neverBlock
                    });
                } catch (error) {
                    return next(auditUnavailable(error));
                }
            }
            if (req.method === "POST" && req.path === bansApiPath) {
                if (!mutationSourceAllowed(req)) {
                    recordAdminEvent(auditStore, req, {
                        action: "admin.source-check",
                        outcome: "failed",
                        status: 403,
                        detail: "operation=client-ban.create"
                    });
                    return next(adminError(
                        ERROR_CODES.ADMIN_ORIGIN_DENIED,
                        "Admin client ban origin is not allowed",
                        403
                    ));
                }
                return jsonParser(req, res, error => {
                    if (error) return next(adminError(
                        ERROR_CODES.ADMIN_CONFIG_INVALID,
                        "Admin client ban payload is invalid",
                        error.status || 400,
                        error
                    ));
                    try {
                        const durationMs = req.body?.durationMs;
                        if (
                            durationMs !== null && durationMs !== undefined
                            && (!Number.isSafeInteger(durationMs) || durationMs < 60000 || durationMs > 31536000000)
                        ) {
                            throw adminError(
                                ERROR_CODES.ADMIN_CONFIG_INVALID,
                                "Ban duration must be null or between one minute and 365 days",
                                400
                            );
                        }
                        const rule = assertClientRuleCanBeBlocked(req.body?.rule, {
                            currentAdminIp: req.ip || req.socket?.remoteAddress,
                            localAddress: req.socket?.localAddress,
                            neverBlock: config.clientAccessControl.neverBlock
                        });
                        const existingBans = auditStore.listBans();
                        if (existingBans.length >= 1000 && !existingBans.some(item => item.rule === rule)) {
                            throw adminError(
                                ERROR_CODES.ADMIN_CONFIG_INVALID,
                                "At most 1000 active client bans are allowed",
                                400
                            );
                        }
                        const createdAt = Date.now();
                        const ban = auditStore.addBan({
                            rule,
                            reason: req.body?.reason,
                            createdAt,
                            expiresAt: durationMs == null ? null : createdAt + durationMs
                        });
                        recordAdminEvent(auditStore, req, {
                            action: "client-ban.create",
                            outcome: "success",
                            status: 200,
                            detail: `rule=${ban.rule}`
                        });
                        logger.info("[ClientAccess] Ban created", { requestId: req.id, rule: ban.rule });
                        return res.json({ ok: true, item: ban });
                    } catch (banError) {
                        recordAdminEvent(auditStore, req, {
                            action: "client-ban.create",
                            outcome: "failed",
                            status: banError.statusCode || 400
                        });
                        return next(banError instanceof ProxyError ? banError : auditUnavailable(banError));
                    }
                });
            }
            if (req.method === "DELETE" && req.path === bansApiPath) {
                if (!mutationSourceAllowed(req)) {
                    recordAdminEvent(auditStore, req, {
                        action: "admin.source-check",
                        outcome: "failed",
                        status: 403,
                        detail: "operation=client-ban.remove"
                    });
                    return next(adminError(
                        ERROR_CODES.ADMIN_ORIGIN_DENIED,
                        "Admin client unban origin is not allowed",
                        403
                    ));
                }
                const id = typeof req.query?.id === "string" ? req.query.id : "";
                let removed = false;
                try {
                    removed = id ? auditStore.removeBan(id) : false;
                } catch (error) {
                    return next(auditUnavailable(error));
                }
                if (!removed) {
                    return next(adminError(
                        ERROR_CODES.ADMIN_CONFIG_INVALID,
                        "Client ban was not found",
                        404
                    ));
                }
                recordAdminEvent(auditStore, req, {
                    action: "client-ban.remove",
                    outcome: "success",
                    status: 200,
                    detail: `id=${id}`
                });
                logger.info("[ClientAccess] Ban removed", { requestId: req.id, banId: id });
                return res.json({ ok: true });
            }
            if (req.method === "GET" && req.path === cacheApiPath) {
                return publicStaticCache.stats(config)
                    .then(stats => res.json({
                        ...stats,
                        enabled: config.browser.publicCache.enabled
                    }))
                    .catch(next);
            }
            if (req.method === "DELETE" && req.path === cacheApiPath) {
                if (!mutationSourceAllowed(req)) {
                    recordAdminEvent(auditStore, req, {
                        action: "admin.source-check",
                        outcome: "failed",
                        status: 403,
                        detail: "operation=cache.invalidate"
                    });
                    return next(adminError(
                        ERROR_CODES.ADMIN_ORIGIN_DENIED,
                        "Admin cache invalidation origin is not allowed",
                        403
                    ));
                }
                return jsonParser(req, res, async error => {
                    if (error) return next(adminError(
                        ERROR_CODES.ADMIN_CONFIG_INVALID,
                        "Admin cache invalidation payload is invalid",
                        error.status || 400,
                        error
                    ));
                    try {
                        const result = await publicStaticCache.invalidate(req.body || {});
                        recordAdminEvent(auditStore, req, {
                            action: "cache.invalidate",
                            outcome: "success",
                            status: 200,
                            detail: `removed=${result.removed || 0}`
                        });
                        return res.json({ ok: true, ...result });
                    } catch (cacheError) {
                        recordAdminEvent(auditStore, req, {
                            action: "cache.invalidate",
                            outcome: "failed",
                            status: cacheError instanceof TypeError ? 400 : 500
                        });
                        return next(adminError(
                            ERROR_CODES.ADMIN_CONFIG_INVALID,
                            cacheError instanceof TypeError
                                ? cacheError.message
                                : "Unable to invalidate public cache",
                            cacheError instanceof TypeError ? 400 : 500,
                            cacheError
                        ));
                    }
                });
            }
            if (req.method === "PUT" && req.path === apiPath) {
                if (!mutationSourceAllowed(req)) {
                    recordAdminEvent(auditStore, req, {
                        action: "admin.source-check",
                        outcome: "failed",
                        status: 403,
                        detail: "operation=config.update"
                    });
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
                        const previousConfig = config;
                        const result = await saveConfig(req.body?.config);
                        if (result.config.admin.path !== basePath && req.session) {
                            req.session.fireflyProxyAdminPreviousPath = {
                                path: basePath,
                                expiresAt: Date.now() + 60_000
                            };
                        }
                        recordAdminEvent(auditStore, req, {
                            action: "config.update",
                            outcome: "success",
                            status: 200,
                            detail: `fields=${changedConfigPaths(previousConfig, result.config).join(",")}`
                        });
                        return res.json({
                            ok: true,
                            adminEnabled: result.config.admin.enabled,
                            adminPath: result.config.admin.path,
                            adminCredentialsChanged: result.adminCredentialsChanged,
                            restartRequired: result.restartRequired,
                            warnings: result.warnings
                        });
                    } catch (saveError) {
                        recordAdminEvent(auditStore, req, {
                            action: "config.update",
                            outcome: "failed",
                            status: saveError instanceof ConfigLoadError ? 400 : 500
                        });
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
