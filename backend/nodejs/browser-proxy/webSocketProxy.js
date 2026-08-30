const { randomUUID } = require("node:crypto");
const { STATUS_CODES } = require("node:http");
const { WebSocket, WebSocketServer } = require("ws");
const { ERROR_CODES, ProxyError, errorPayload, normalizeProxyError } = require("../core/errors");
const { validateTarget } = require("../core/targetValidator");
const { authenticateProxyRequest } = require("../middleware/auth");
const { applyBrowserPreferences } = require("./preferences");
const { getCookieHeader, storeResponseCookies } = require("./sessionStateStore");
const {
    WEB_SOCKET_CONTEXT_PREFIX,
    fromWebSocketProxyRequest,
    toHttpUrl,
    verifyWebSocketOriginContext
} = require("./webSocketUrl");

const SAFE_REQUEST_HEADERS = Object.freeze([
    "accept-language",
    "cache-control",
    "pragma",
    "user-agent"
]);
const SUBPROTOCOL_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function writeUpgradeError(socket, error, extraHeaders = {}) {
    if (!socket || socket.destroyed) return;
    const normalized = normalizeProxyError(error);
    const body = Buffer.from(`${JSON.stringify(errorPayload(normalized))}\n`, "utf8");
    const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        Connection: "close",
        ...extraHeaders
    };
    const lines = [`HTTP/1.1 ${normalized.statusCode} ${STATUS_CODES[normalized.statusCode] || "Error"}`];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`);
}

function parseProtocols(value) {
    if (value === undefined) return [];
    if (typeof value !== "string") {
        throw new ProxyError(ERROR_CODES.BROWSER_URL_INVALID, "WebSocket subprotocol list is invalid", {
            statusCode: 400
        });
    }
    const protocols = value.split(",").map(item => item.trim());
    if (
        protocols.some(protocol => !SUBPROTOCOL_PATTERN.test(protocol))
        || new Set(protocols).size !== protocols.length
    ) {
        throw new ProxyError(ERROR_CODES.BROWSER_URL_INVALID, "WebSocket subprotocol list is invalid", {
            statusCode: 400
        });
    }
    return protocols;
}

function validateUpgradeHeaders(req) {
    const key = req.headers["sec-websocket-key"];
    let decodedKey;
    try {
        decodedKey = typeof key === "string" && !key.includes(",")
            ? Buffer.from(key, "base64")
            : null;
    } catch {
        decodedKey = null;
    }
    if (
        req.method !== "GET"
        || String(req.headers.upgrade || "").toLowerCase() !== "websocket"
        || !String(req.headers.connection || "").toLowerCase().split(",").map(value => value.trim()).includes("upgrade")
        || req.headers["sec-websocket-version"] !== "13"
        || !decodedKey
        || decodedKey.length !== 16
        || decodedKey.toString("base64") !== key
    ) {
        throw new ProxyError(ERROR_CODES.BROWSER_URL_INVALID, "WebSocket Upgrade headers are invalid", {
            statusCode: 400
        });
    }
}

function parseSourceOrigin(protocols, secret) {
    const markers = protocols.filter(protocol => protocol.startsWith(`${WEB_SOCKET_CONTEXT_PREFIX}.`));
    if (markers.length === 0) return { origin: "null", protocols };
    if (markers.length !== 1) {
        throw new ProxyError(ERROR_CODES.BROWSER_URL_INVALID, "WebSocket source context is invalid", {
            statusCode: 400
        });
    }
    const origin = verifyWebSocketOriginContext(markers[0], secret);
    if (!origin) {
        throw new ProxyError(ERROR_CODES.BROWSER_URL_INVALID, "WebSocket source context is invalid", {
            statusCode: 400
        });
    }
    return {
        origin,
        protocols: protocols.filter(protocol => protocol !== markers[0])
    };
}

function validateInboundOrigin(req) {
    const value = req.headers.origin;
    if (typeof value !== "string" || !value || value.includes(",")) {
        throw new ProxyError(ERROR_CODES.WEBSOCKET_ORIGIN_DENIED, "WebSocket Origin is not allowed", {
            statusCode: 403
        });
    }
    let origin;
    try {
        origin = new URL(value);
    } catch {
        throw new ProxyError(ERROR_CODES.WEBSOCKET_ORIGIN_DENIED, "WebSocket Origin is not allowed", {
            statusCode: 403
        });
    }
    const host = String(req.headers.host || "").toLowerCase();
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== value || origin.host.toLowerCase() !== host) {
        throw new ProxyError(ERROR_CODES.WEBSOCKET_ORIGIN_DENIED, "WebSocket Origin is not allowed", {
            statusCode: 403
        });
    }
    return origin.origin;
}

function parseSession(sessionMiddleware, req) {
    return new Promise((resolve, reject) => {
        const headers = new Map();
        const response = {
            getHeader: name => headers.get(String(name).toLowerCase()),
            setHeader: (name, value) => headers.set(String(name).toLowerCase(), value),
            removeHeader: name => headers.delete(String(name).toLowerCase()),
            writeHead() {},
            end() {}
        };
        sessionMiddleware(req, response, error => error ? reject(error) : resolve());
    });
}

function buildUpstreamHeaders(req, sourceOrigin, cookie) {
    const headers = { origin: sourceOrigin };
    for (const name of SAFE_REQUEST_HEADERS) {
        if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
    }
    if (cookie) headers.cookie = cookie;
    return headers;
}

function isRelayableCloseCode(code) {
    return code === 1000
        || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code))
        || (code >= 3000 && code <= 4999);
}

function relayClose(destination, code, reason) {
    if (destination.readyState !== WebSocket.OPEN && destination.readyState !== WebSocket.CONNECTING) return;
    const relayCode = isRelayableCloseCode(code) ? code : 1000;
    const relayReason = Buffer.from(reason || "").subarray(0, 123);
    try {
        destination.close(relayCode, relayReason);
    } catch {
        destination.terminate();
    }
}

function createWebSocketPair(downstream, upstream, options) {
    const { idleTimeoutMs, logger, requestId, targetOrigin, onFinalize } = options;
    let finalized = false;
    let idleTimer;
    let forceCloseTimer;

    const forceClose = () => {
        if (downstream.readyState !== WebSocket.CLOSED) downstream.terminate();
        if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
        finalize();
    };
    const scheduleForceClose = () => {
        if (forceCloseTimer) return;
        forceCloseTimer = setTimeout(forceClose, 1000);
        forceCloseTimer.unref?.();
    };

    const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            relayClose(downstream, 1001, "Idle timeout");
            relayClose(upstream, 1001, "Idle timeout");
            scheduleForceClose();
        }, idleTimeoutMs);
        idleTimer.unref?.();
    };
    const finalize = () => {
        if (finalized) return;
        finalized = true;
        clearTimeout(idleTimer);
        clearTimeout(forceCloseTimer);
        onFinalize();
    };
    const forward = (source, destination) => (data, isBinary) => {
        touch();
        if (destination.readyState !== WebSocket.OPEN) return;
        source.pause();
        destination.send(data, { binary: isBinary }, error => {
            if (error) {
                logger.warn("[WebSocket] Message forwarding failed", { requestId, targetOrigin, error });
                source.terminate();
                destination.terminate();
                finalize();
                return;
            }
            if (source.readyState === WebSocket.OPEN) source.resume();
        });
    };

    downstream.on("message", forward(downstream, upstream));
    upstream.on("message", forward(upstream, downstream));
    for (const socket of [downstream, upstream]) {
        socket.on("ping", touch);
        socket.on("pong", touch);
        socket.on("error", error => {
            logger.warn("[WebSocket] Connection error", { requestId, targetOrigin, error });
            const peer = socket === downstream ? upstream : downstream;
            const closeCode = error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ? 1009 : 1011;
            relayClose(peer, closeCode, closeCode === 1009 ? "Message too large" : "WebSocket proxy error");
        });
        socket.on("close", (code, reason) => {
            const peer = socket === downstream ? upstream : downstream;
            relayClose(peer, code, reason);
            if (peer.readyState === WebSocket.CLOSED) finalize();
            else scheduleForceClose();
        });
    }
    touch();
    return {
        terminate() {
            clearTimeout(idleTimer);
            forceClose();
        }
    };
}

function createWebSocketProxy(options) {
    const {
        getConfig,
        dnsResolver,
        connectionFactory,
        sessionMiddleware,
        sessionStateStore,
        logger
    } = options;
    const connections = new Set();
    let attachedServer = null;
    let closed = false;

    async function handleUpgrade(req, socket, head) {
        const state = {
            upstream: null,
            connection: null,
            pair: null,
            finalized: false,
            finalize() {
                if (state.finalized) return;
                state.finalized = true;
                connections.delete(state);
                state.connection?.destroy();
            },
            terminate() {
                state.pair?.terminate();
                if (state.upstream && state.upstream.readyState !== WebSocket.CLOSED) state.upstream.terminate();
                if (!socket.destroyed) socket.destroy();
                state.finalize();
            }
        };
        const requestId = randomUUID();
        req.id = requestId;

        try {
            if (closed) throw new ProxyError(ERROR_CODES.UPSTREAM_ERROR, "WebSocket proxy is shutting down", { statusCode: 503 });
            const configuredRequest = getConfig();
            if (!configuredRequest.browser.enabled || !configuredRequest.browser.webSocket) {
                throw new ProxyError(ERROR_CODES.WEBSOCKET_DISABLED, "Browser WebSocket proxy is disabled", {
                    statusCode: 404
                });
            }
            validateUpgradeHeaders(req);
            if (connections.size >= configuredRequest.browser.webSocketMaxConnections) {
                throw new ProxyError(ERROR_CODES.CONCURRENCY_LIMIT, "WebSocket connection limit reached", {
                    statusCode: 503
                });
            }
            connections.add(state);

            const authentication = authenticateProxyRequest(req, configuredRequest);
            if (!authentication.ok) {
                const error = new ProxyError(ERROR_CODES.WEBSOCKET_AUTH_REQUIRED, "WebSocket authentication is required", {
                    statusCode: 401
                });
                error.upgradeHeaders = { "WWW-Authenticate": 'Basic realm="Proxy Auth Required"' };
                throw error;
            }
            validateInboundOrigin(req);
            await parseSession(sessionMiddleware, req);
            const requestConfig = applyBrowserPreferences(
                configuredRequest,
                req.session?.proxyWebBrowserPreferences
            );
            if (!requestConfig.browser.webSocket) {
                throw new ProxyError(ERROR_CODES.WEBSOCKET_DISABLED, "Browser WebSocket proxy is disabled", {
                    statusCode: 404
                });
            }

            const requestedProtocols = parseProtocols(req.headers["sec-websocket-protocol"]);
            const source = parseSourceOrigin(requestedProtocols, requestConfig.session.secret);
            const webSocketUrl = fromWebSocketProxyRequest(req);
            const targetHttpUrl = toHttpUrl(webSocketUrl);
            const target = await validateTarget(targetHttpUrl.href, {
                blockedHostnames: requestConfig.security.blockedHostnames,
                resolveHostname: hostname => dnsResolver.resolve(hostname)
            });
            state.connection = connectionFactory(target, {
                connectTimeoutMs: requestConfig.api.connectTimeoutMs
            });
            const sessionState = requestConfig.browser.cookieJar
                ? await sessionStateStore.get(req.sessionID, requestConfig.session.maxAgeMs)
                : null;
            const cookie = sessionState
                ? await getCookieHeader(sessionState, targetHttpUrl.href)
                : "";
            const upstream = new WebSocket(webSocketUrl, source.protocols, {
                agent: target.protocol === "https:"
                    ? state.connection.httpsAgent
                    : state.connection.httpAgent,
                headers: buildUpstreamHeaders(req, source.origin, cookie),
                handshakeTimeout: requestConfig.api.connectTimeoutMs,
                maxPayload: requestConfig.browser.webSocketMaxPayloadBytes,
                perMessageDeflate: false,
                followRedirects: false
            });
            state.upstream = upstream;

            await new Promise((resolve, reject) => {
                let validated = false;
                let cookieCapture = Promise.resolve();
                upstream.once("upgrade", response => {
                    try {
                        state.connection.assertRemoteAddress(response.socket?.remoteAddress);
                        validated = true;
                        if (sessionState) {
                            cookieCapture = storeResponseCookies(
                                sessionState,
                                targetHttpUrl.href,
                                response.headers["set-cookie"],
                                { logger, requestId }
                            );
                        }
                    } catch (error) {
                        upstream.terminate();
                        reject(error);
                    }
                });
                upstream.once("open", async () => {
                    if (!validated) {
                        reject(new ProxyError(ERROR_CODES.SSRF_BLOCKED, "Upstream address was not validated", {
                            statusCode: 403
                        }));
                        return;
                    }
                    try {
                        await cookieCapture;
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
                upstream.once("error", reject);
                upstream.once("unexpected-response", (request, response) => {
                    response.resume();
                    reject(new ProxyError(ERROR_CODES.UPSTREAM_ERROR, "Upstream WebSocket handshake failed", {
                        statusCode: 502,
                        details: { upstreamStatus: response.statusCode }
                    }));
                });
                socket.once("close", () => reject(new Error("Client disconnected during WebSocket handshake")));
            });

            const downstreamServer = new WebSocketServer({
                noServer: true,
                clientTracking: false,
                maxPayload: requestConfig.browser.webSocketMaxPayloadBytes,
                perMessageDeflate: false,
                handleProtocols(protocols) {
                    return upstream.protocol && protocols.has(upstream.protocol)
                        ? upstream.protocol
                        : false;
                }
            });
            downstreamServer.handleUpgrade(req, socket, head, downstream => {
                state.pair = createWebSocketPair(downstream, upstream, {
                    idleTimeoutMs: requestConfig.browser.webSocketIdleTimeoutMs,
                    logger,
                    requestId,
                    targetOrigin: targetHttpUrl.origin,
                    onFinalize: state.finalize
                });
                logger.info("[WebSocket] Proxy connected", {
                    requestId,
                    targetOrigin: targetHttpUrl.origin,
                    protocol: upstream.protocol || null
                });
            });
        } catch (error) {
            state.upstream?.terminate();
            state.finalize();
            const normalized = normalizeProxyError(error);
            logger.error("[WebSocket] Upgrade failed", {
                requestId,
                code: normalized.code,
                error: normalized.cause || error
            });
            writeUpgradeError(socket, normalized, error?.upgradeHeaders);
        }
    }

    const upgradeListener = (req, socket, head) => {
        handleUpgrade(req, socket, head).catch(error => {
            logger.error("[WebSocket] Unhandled upgrade failure", { error });
            socket.destroy();
        });
    };

    return Object.freeze({
        attach(server) {
            if (attachedServer === server) return server;
            if (attachedServer) throw new Error("WebSocket proxy is already attached to a server");
            attachedServer = server;
            server.on("upgrade", upgradeListener);
            return server;
        },
        close() {
            closed = true;
            if (attachedServer) attachedServer.off("upgrade", upgradeListener);
            for (const connection of [...connections]) connection.terminate();
        },
        get activeConnections() {
            return connections.size;
        }
    });
}

module.exports = {
    buildUpstreamHeaders,
    createWebSocketPair,
    createWebSocketProxy,
    parseProtocols,
    parseSourceOrigin,
    validateInboundOrigin,
    validateUpgradeHeaders,
    writeUpgradeError
};
