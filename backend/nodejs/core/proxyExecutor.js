const { pipeline } = require("node:stream");
const axios = require("axios");
const { markDeprecated } = require("./deprecation");
const { exposeCorsHeaders } = require("../middleware/cors");
const {
    assertRequestBodyLength,
    createConcurrencyGate,
    createLimitedRequestBody
} = require("./requestResources");
const { requestWithRedirects } = require("./safeRedirect");
const { validateTarget } = require("./targetValidator");

const VALID_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const HEADERS_QUERY_WARNING = '299 proxyWeb "headers query parameter is deprecated; send upstream Authorization with X-ProxyWeb-Upstream-Authorization"';

function validatePolicy(policy) {
    if (
        !policy
        || typeof policy.mode !== "string"
        || typeof policy.buildRequestHeaders !== "function"
        || typeof policy.filterResponseHeaders !== "function"
        || typeof policy.redirectOptions !== "function"
    ) {
        throw new TypeError("Proxy mode policy is invalid");
    }
    return policy;
}

function createProxyExecutor(options) {
    const {
        getConfig,
        dnsResolver,
        connectionFactory,
        logger,
        dispatch = request => axios(request)
    } = options;
    const concurrencyGate = createConcurrencyGate();
    const activeRequests = new Set();

    async function resolveTarget(value, requestConfig = getConfig()) {
        return validateTarget(value, {
            blockedHostnames: requestConfig.security.blockedHostnames,
            resolveHostname: hostname => dnsResolver.resolve(hostname)
        });
    }

    async function execute(req, res, options) {
        const policy = validatePolicy(options.policy);
        const requestConfig = options.requestConfig || getConfig();
        const target = options.target || await resolveTarget(options.targetValue, requestConfig);
        if (typeof options.onTargetValidated === "function") {
            options.onTargetValidated(target);
        }
        const allowQueryControls = options.allowQueryControls !== false;
        const methodParam = allowQueryControls ? String(req.query.method || "").toUpperCase() : "";
        const method = VALID_METHODS.has(methodParam) ? methodParam : req.method;
        const hasRequestBody = !["GET", "HEAD"].includes(method);
        if (hasRequestBody) assertRequestBodyLength(req.headers, requestConfig.api.maxRequestBodyBytes);

        const releaseConcurrency = concurrencyGate.acquire(requestConfig.api.maxConcurrentRequests);
        const controller = new AbortController();
        let finalized = false;
        const requestState = {
            controller,
            finalize() {
                if (finalized) return;
                finalized = true;
                activeRequests.delete(requestState);
                releaseConcurrency();
            }
        };
        activeRequests.add(requestState);
        req.once("aborted", () => controller.abort(new Error("Client request aborted")));
        res.once("close", () => {
            if (!res.writableFinished) controller.abort(new Error("Client connection closed"));
            requestState.finalize();
        });
        res.once("finish", requestState.finalize);

        try {
            logger.info("[Proxy] Dispatching request", {
                requestId: req.id,
                mode: policy.mode,
                targetUrl: target.url
            });

            let customHeaders = {};
            if (allowQueryControls && req.query.headers) {
                markDeprecated(res, HEADERS_QUERY_WARNING);
                logger.warn("[Proxy] Deprecated headers query parameter used", { requestId: req.id });
                try {
                    customHeaders = JSON.parse(req.query.headers);
                } catch {
                    logger.warn("[Proxy] Failed to parse custom headers JSON", { requestId: req.id });
                }
            }
            const headers = policy.buildRequestHeaders(req.headers, customHeaders, requestConfig);
            logger.info("[Proxy] Method selected", { requestId: req.id, mode: policy.mode, method });

            const requestBody = hasRequestBody
                ? createLimitedRequestBody(req, requestConfig.api.maxRequestBodyBytes)
                : undefined;
            const redirectOptions = policy.redirectOptions(requestConfig);
            const redirectResult = await requestWithRedirects({
                initialTarget: target,
                method,
                headers,
                body: requestBody,
                ...redirectOptions,
                maxReplayBodyBytes: requestConfig.api.maxRequestBodyBytes,
                validateTarget: redirectUrl => resolveTarget(redirectUrl, requestConfig),
                connectionFactory: hopTarget => connectionFactory(hopTarget, {
                    connectTimeoutMs: requestConfig.api.connectTimeoutMs
                }),
                dispatch: ({ target: hopTarget, method: hopMethod, headers: hopHeaders, body, connection }) => dispatch({
                    method: hopMethod,
                    url: hopTarget.url,
                    headers: hopHeaders,
                    data: body,
                    responseType: "stream",
                    decompress: false,
                    maxRedirects: 0,
                    validateStatus: null,
                    timeout: requestConfig.timeoutMs,
                    signal: controller.signal,
                    proxy: false,
                    httpAgent: connection.httpAgent,
                    httpsAgent: connection.httpsAgent
                }),
                logger,
                requestId: req.id
            });
            const { response, target: finalTarget, release: releaseConnection } = redirectResult;

            let connectionReleased = false;
            const releaseOnce = () => {
                if (connectionReleased) return;
                connectionReleased = true;
                releaseConnection();
            };
            response.data.once("end", releaseOnce);
            response.data.once("error", releaseOnce);
            res.once("close", releaseOnce);

            if (finalTarget.url !== target.url && typeof options.onRedirect === "function") {
                options.onRedirect(finalTarget, target);
            }

            const controlHeaders = new Map(
                ["deprecation", "warning", "link"]
                    .filter(name => res.hasHeader(name))
                    .map(name => [name, res.getHeader(name)])
            );
            const responseHeaders = policy.filterResponseHeaders(response.headers, requestConfig);
            for (const [key, value] of Object.entries(responseHeaders)) res.setHeader(key, value);
            for (const [key, value] of controlHeaders) res.setHeader(key, value);
            if (policy.exposeCors) {
                exposeCorsHeaders(req, res, [
                    ...new Set([
                        ...Object.keys(responseHeaders),
                        "x-request-id",
                        ...controlHeaders.keys()
                    ])
                ]);
            }

            res.status(response.status);
            pipeline(response.data, res, error => {
                releaseOnce();
                requestState.finalize();
                if (error && !controller.signal.aborted) {
                    logger.warn("[Proxy] Upstream response stream interrupted", {
                        requestId: req.id,
                        mode: policy.mode,
                        error
                    });
                }
            });
        } catch (error) {
            requestState.finalize();
            throw error;
        }
    }

    return Object.freeze({
        execute,
        resolveTarget,
        close() {
            for (const requestState of activeRequests) {
                requestState.controller.abort(new Error("Proxy runtime is shutting down"));
                requestState.finalize();
            }
        }
    });
}

module.exports = {
    HEADERS_QUERY_WARNING,
    VALID_METHODS,
    createProxyExecutor,
    validatePolicy
};
