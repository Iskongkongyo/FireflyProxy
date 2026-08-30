const { Transform } = require("node:stream");
const { ERROR_CODES, ProxyError } = require("./errors");

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REPLAY_BODY_BYTES = 5 * 1024 * 1024;
const NO_BODY_METHODS = new Set(["GET", "HEAD"]);
const ENTITY_HEADERS = new Set([
    "content-encoding",
    "content-language",
    "content-length",
    "content-location",
    "content-md5",
    "content-type",
    "digest",
    "transfer-encoding"
]);
const SENSITIVE_REDIRECT_HEADER = /^(?:authorization|cookie2?|proxy-authorization|x-proxyweb-upstream-authorization|.*(?:token|password|passwd|secret|api[-_]?key).*)$/i;

function redirectMethod(status, method) {
    const normalized = String(method || "GET").toUpperCase();
    if (status === 303 && normalized !== "HEAD") return "GET";
    if ([301, 302].includes(status) && normalized === "POST") return "GET";
    return normalized;
}

function redirectHeaders(headers, fromUrl, toUrl, fromMethod, toMethod) {
    const crossOrigin = new URL(fromUrl).origin !== new URL(toUrl).origin;
    const dropsBody = !NO_BODY_METHODS.has(String(fromMethod).toUpperCase())
        && NO_BODY_METHODS.has(String(toMethod).toUpperCase());
    const result = {};

    for (const [name, value] of Object.entries(headers || {})) {
        const normalizedName = name.toLowerCase();
        if (crossOrigin && SENSITIVE_REDIRECT_HEADER.test(normalizedName)) continue;
        if (dropsBody && ENTITY_HEADERS.has(normalizedName)) continue;
        result[name] = value;
    }
    return result;
}

function redirectError(code, message, statusCode, details, cause) {
    return new ProxyError(code, message, { statusCode, details, cause });
}

function attachRedirectDiagnostics(error, finalUrl, redirectChain) {
    Object.defineProperty(error, "redirectDiagnostics", {
        value: Object.freeze({
            finalUrl,
            redirectChain: Object.freeze([...redirectChain])
        }),
        enumerable: false
    });
    return error;
}

function createReplayableBody(source, maxBytes = DEFAULT_MAX_REPLAY_BODY_BYTES) {
    if (!source || typeof source.pipe !== "function") {
        throw new TypeError("Replayable body source must be a readable stream");
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
        throw new TypeError("Replay body limit must be a positive integer");
    }

    let chunks = [];
    let size = 0;
    let exceeded = false;
    let streamError = null;
    let ready = false;
    let markReady;
    const readyPromise = new Promise(resolve => { markReady = resolve; });
    const finish = () => {
        if (ready) return;
        ready = true;
        markReady();
    };

    const capture = new Transform({
        transform(chunk, encoding, callback) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            if (!exceeded) {
                if (size + buffer.length <= maxBytes) {
                    chunks.push(Buffer.from(buffer));
                    size += buffer.length;
                } else {
                    exceeded = true;
                    chunks = [];
                    size = 0;
                }
            }
            callback(null, chunk);
        },
        flush(callback) {
            finish();
            callback();
        },
        destroy(error, callback) {
            if (error) streamError = error;
            finish();
            callback(error);
        }
    });
    source.once("error", error => capture.destroy(error));
    source.pipe(capture);

    return Object.freeze({
        initial: capture,
        async replay() {
            // If the upstream replied before consuming the full request, keep
            // draining the inbound stream so the bounded replay cache can finish.
            capture.resume();
            await readyPromise;
            if (streamError) throw streamError;
            if (exceeded) {
                throw redirectError(
                    ERROR_CODES.REQUEST_BODY_LIMIT,
                    "Request body is too large to replay across redirects",
                    413,
                    { maxBytes }
                );
            }
            return Buffer.concat(chunks, size);
        }
    });
}

function getResponseRemoteAddress(response) {
    return response?.data?.socket?.remoteAddress
        || response?.request?.socket?.remoteAddress
        || response?.request?._currentRequest?.socket?.remoteAddress
        || response?.request?.res?.socket?.remoteAddress
        || null;
}

function isRedirectResponse(response) {
    return REDIRECT_STATUSES.has(response?.status) && typeof response?.headers?.location === "string";
}

function disposeHop(response, connection) {
    if (response?.data && typeof response.data.destroy === "function") response.data.destroy();
    connection.destroy();
}

function validateConnection(connection) {
    if (
        !connection
        || !connection.httpAgent
        || !connection.httpsAgent
        || typeof connection.assertRemoteAddress !== "function"
        || typeof connection.destroy !== "function"
    ) {
        throw new TypeError("connectionFactory returned an invalid pinned connection");
    }
    return connection;
}

async function requestWithRedirects(options) {
    const {
        initialTarget,
        method,
        headers,
        body,
        followRedirects,
        validateRedirects = false,
        maxRedirects,
        validateTarget,
        connectionFactory,
        dispatch,
        logger,
        requestId,
        maxReplayBodyBytes = DEFAULT_MAX_REPLAY_BODY_BYTES
    } = options;

    if (!initialTarget || typeof initialTarget.url !== "string") {
        throw new TypeError("initialTarget must be validated");
    }
    if (typeof validateTarget !== "function" || typeof connectionFactory !== "function" || typeof dispatch !== "function") {
        throw new TypeError("Redirect client dependencies must be functions");
    }
    if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
        throw new TypeError("maxRedirects must be a non-negative integer");
    }

    let currentTarget = initialTarget;
    let currentMethod = String(method || "GET").toUpperCase();
    let currentHeaders = { ...(headers || {}) };
    const replayableBody = followRedirects && body && !NO_BODY_METHODS.has(currentMethod)
        ? createReplayableBody(body, maxReplayBodyBytes)
        : null;
    let currentBody = replayableBody ? replayableBody.initial : body;
    let redirectCount = 0;
    const redirectChain = [];
    const visited = new Set([currentTarget.url]);

    while (true) {
        const connection = validateConnection(connectionFactory(currentTarget));
        let response;
        try {
            response = await dispatch({
                target: currentTarget,
                method: currentMethod,
                headers: currentHeaders,
                body: NO_BODY_METHODS.has(currentMethod) ? undefined : currentBody,
                connection
            });
            connection.assertRemoteAddress(getResponseRemoteAddress(response));
        } catch (error) {
            connection.destroy();
            throw error;
        }

        if (!isRedirectResponse(response)) {
            return Object.freeze({
                response,
                target: currentTarget,
                redirectCount,
                redirectChain: Object.freeze([...redirectChain]),
                release: () => connection.destroy()
            });
        }

        if (!followRedirects && !validateRedirects) {
            let location = response.headers.location;
            try {
                location = new URL(location, currentTarget.url).href;
            } catch {
                // No-follow mode preserves invalid upstream Location as response data.
            }
            redirectChain.push(Object.freeze({
                status: response.status,
                method: currentMethod,
                url: currentTarget.url,
                location,
                followed: false,
                validated: false
            }));
            return Object.freeze({
                response,
                target: currentTarget,
                redirectCount,
                redirectChain: Object.freeze([...redirectChain]),
                release: () => connection.destroy()
            });
        }

        if (followRedirects && redirectCount >= maxRedirects) {
            const stoppedChain = [...redirectChain, Object.freeze({
                status: response.status,
                method: currentMethod,
                url: currentTarget.url,
                location: response.headers.location,
                followed: false,
                validated: false
            })];
            disposeHop(response, connection);
            throw attachRedirectDiagnostics(redirectError(
                ERROR_CODES.REDIRECT_LIMIT,
                "Upstream redirect limit exceeded",
                508,
                { maxRedirects }
            ), currentTarget.url, stoppedChain);
        }

        let redirectUrl;
        try {
            redirectUrl = new URL(response.headers.location, currentTarget.url).href;
        } catch (error) {
            disposeHop(response, connection);
            throw redirectError(
                ERROR_CODES.REDIRECT_BLOCKED,
                "Upstream redirect target is invalid",
                502,
                { reason: "invalid-location" },
                error
            );
        }

        let nextTarget;
        try {
            nextTarget = await validateTarget(redirectUrl);
        } catch (error) {
            disposeHop(response, connection);
            throw error;
        }

        if (!followRedirects) {
            redirectChain.push(Object.freeze({
                status: response.status,
                method: currentMethod,
                url: currentTarget.url,
                location: nextTarget.url,
                followed: false,
                validated: true
            }));
            logger?.info("[Proxy] Browser redirect target validated", {
                requestId,
                statusCode: response.status,
                fromUrl: currentTarget.url,
                targetUrl: nextTarget.url
            });
            return Object.freeze({
                response,
                target: currentTarget,
                redirectTarget: nextTarget,
                redirectCount,
                redirectChain: Object.freeze([...redirectChain]),
                release: () => connection.destroy()
            });
        }

        const nextMethod = redirectMethod(response.status, currentMethod);
        let nextHeaders;
        let nextBody;
        try {
            if (visited.has(nextTarget.url)) {
                throw attachRedirectDiagnostics(redirectError(
                    ERROR_CODES.REDIRECT_LIMIT,
                    "Upstream redirect loop detected",
                    508,
                    { redirectCount: redirectCount + 1 }
                ), currentTarget.url, [...redirectChain, Object.freeze({
                    status: response.status,
                    method: currentMethod,
                    url: currentTarget.url,
                    location: nextTarget.url,
                    followed: false,
                    validated: true
                })]);
            }
            nextHeaders = redirectHeaders(
                currentHeaders,
                currentTarget.url,
                nextTarget.url,
                currentMethod,
                nextMethod
            );
            if (!NO_BODY_METHODS.has(nextMethod) && replayableBody) {
                nextBody = await replayableBody.replay();
            }
        } catch (error) {
            disposeHop(response, connection);
            throw error;
        }
        disposeHop(response, connection);

        redirectChain.push(Object.freeze({
            status: response.status,
            method: currentMethod,
            url: currentTarget.url,
            location: nextTarget.url,
            followed: true,
            validated: true
        }));
        redirectCount += 1;
        if (logger) {
            logger.info("[Proxy] Following validated redirect", {
                requestId,
                statusCode: response.status,
                redirectCount,
                fromUrl: currentTarget.url,
                targetUrl: nextTarget.url
            });
        }

        visited.add(nextTarget.url);
        currentTarget = nextTarget;
        currentMethod = nextMethod;
        currentHeaders = nextHeaders;
        currentBody = nextBody;
    }
}

module.exports = {
    DEFAULT_MAX_REPLAY_BODY_BYTES,
    REDIRECT_STATUSES,
    createReplayableBody,
    redirectHeaders,
    redirectMethod,
    requestWithRedirects
};
