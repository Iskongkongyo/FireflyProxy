const { pipeline, Readable } = require("node:stream");
const axios = require("axios");
const { markDeprecated } = require("./deprecation");
const { exposeCorsHeaders } = require("../middleware/cors");
const { prepareResponse } = require("./responsePipeline");
const { applyStreamingHeaders, flushStreamingHeaders } = require("./streamingPolicy");
const {
    assertRequestBodyLength,
    createConcurrencyGate,
    createLimitedRequestBody
} = require("./requestResources");
const { requestWithRedirects } = require("./safeRedirect");
const { validateTarget } = require("./targetValidator");

const VALID_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const HEADERS_QUERY_WARNING = '299 FireflyProxy "headers query parameter is deprecated; send upstream Authorization with X-FireflyProxy-Upstream-Authorization"';

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
        publicStaticCache,
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
        let effectiveRedirectOptions;
        let cacheFlight;

        const completeCacheFlight = result => {
            cacheFlight?.complete(result);
            cacheFlight = null;
        };

        const logCache = (event, reason) => {
            logger.info(`[PublicCache] ${event}`, {
                requestId: req.id,
                reason
            });
        };

        const sendCachedResponse = (cached, cacheRequest) => {
            const prepared = {
                headers: cached.metadata.headers,
                classification: cached.metadata.classification,
                transformed: false,
                preserveContentLength: true
            };
            const responseHeaders = applyStreamingHeaders(policy.filterResponseHeaders(
                prepared.headers,
                requestConfig,
                {
                    ...prepared,
                    request: req,
                    originIsolationRegistry: options.originIsolationRegistry,
                    status: cached.metadata.status,
                    targetUrl: target.url
                }
            ), prepared.classification);
            responseHeaders["content-length"] = String(cached.body.length);
            responseHeaders.age = String(
                Math.max(0, cached.metadata.initialAgeSeconds || 0)
                + Math.max(0, Math.floor((Date.now() - cached.metadata.createdAt) / 1000))
            );
            responseHeaders["x-proxyweb-cache"] = "HIT";
            for (const [key, value] of Object.entries(responseHeaders)) res.setHeader(key, value);
            res.status(cached.metadata.status);
            flushStreamingHeaders(res, prepared.classification);
            logCache("Hit", "fresh");
            if (cacheRequest.method === "HEAD") {
                res.end();
                return;
            }
            pipeline(Readable.from([cached.body]), res, error => {
                requestState.finalize();
                if (error && !controller.signal.aborted) {
                    logger.warn("[PublicCache] Cached response stream interrupted", {
                        requestId: req.id,
                        error
                    });
                }
            });
        };

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
            const policyContext = {
                request: req,
                originIsolationRegistry: options.originIsolationRegistry,
                sessionState: options.sessionState,
                targetUrl: target.url
            };
            const headers = await policy.buildRequestHeaders(
                req.headers,
                customHeaders,
                requestConfig,
                policyContext
            );
            logger.info("[Proxy] Method selected", { requestId: req.id, mode: policy.mode, method });

            const cacheRequest = publicStaticCache?.prepareRequest({
                mode: policy.mode,
                method,
                targetUrl: target.url,
                headers,
                config: requestConfig
            });
            if (requestConfig.browser?.publicCache?.enabled && cacheRequest?.eligible) {
                while (true) {
                    const cached = await publicStaticCache.lookup(cacheRequest, requestConfig);
                    if (cached) {
                        sendCachedResponse(cached, cacheRequest);
                        return;
                    }
                    const acquired = publicStaticCache.acquire(cacheRequest.baseHash);
                    if (acquired.leader) {
                        cacheFlight = acquired;
                        break;
                    }
                    logCache("Wait", "request-collapse");
                    await acquired.promise;
                }
            } else if (requestConfig.browser?.publicCache?.enabled && policy.mode === "browser") {
                logCache("Bypass", cacheRequest?.reason || "unavailable");
            }

            const requestBody = hasRequestBody
                ? createLimitedRequestBody(req, requestConfig.api.maxRequestBodyBytes)
                : undefined;
            const redirectOptions = policy.redirectOptions(requestConfig, policyContext);
            effectiveRedirectOptions = redirectOptions;
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
            const {
                response,
                target: finalTarget,
                redirectTarget,
                redirectChain,
                release: releaseConnection
            } = redirectResult;

            let connectionReleased = false;
            const releaseOnce = () => {
                if (connectionReleased) return;
                connectionReleased = true;
                releaseConnection();
            };
            response.data.once("end", releaseOnce);
            response.data.once("error", releaseOnce);
            res.once("close", releaseOnce);

            if (typeof policy.captureResponseHeaders === "function") {
                try {
                    await policy.captureResponseHeaders(response.headers, requestConfig, {
                        ...policyContext,
                        logger,
                        requestId: req.id,
                        targetUrl: finalTarget.url
                    });
                } catch (error) {
                    response.data.destroy();
                    releaseOnce();
                    throw error;
                }
            }

            if (finalTarget.url !== target.url && typeof options.onRedirect === "function") {
                options.onRedirect(finalTarget, target);
            }

            let preparedResponse = await prepareResponse({
                body: response.data,
                headers: response.headers,
                method,
                status: response.status,
                mode: policy.mode,
                config: requestConfig,
                targetUrl: finalTarget.url,
                transformText: policy.transformResponseText,
                shouldTransformText: policy.shouldTransformResponseText,
                logger,
                requestId: req.id
            });
            const cacheResponse = publicStaticCache?.evaluateResponse({
                request: cacheRequest,
                status: response.status,
                headers: preparedResponse.headers,
                classification: preparedResponse.classification,
                config: requestConfig
            });
            if (cacheFlight && cacheResponse?.eligible) {
                preparedResponse = {
                    ...preparedResponse,
                    body: publicStaticCache.capture({
                        body: preparedResponse.body,
                        request: cacheRequest,
                        response: {
                            ...cacheResponse,
                            headers: preparedResponse.headers,
                            classification: preparedResponse.classification
                        },
                        config: requestConfig,
                        onComplete(result) {
                            logCache(result.stored ? "Store" : "Bypass", result.reason);
                            completeCacheFlight(result);
                        }
                    })
                };
            } else if (cacheFlight) {
                logCache("Bypass", cacheResponse?.reason || "response");
                completeCacheFlight(cacheResponse);
            }
            const controlHeaders = new Map(
                ["deprecation", "warning", "link"]
                    .filter(name => res.hasHeader(name))
                    .map(name => [name, res.getHeader(name)])
            );
            const responseHeaders = applyStreamingHeaders(policy.filterResponseHeaders(
                preparedResponse.headers,
                requestConfig,
                {
                    ...preparedResponse,
                    request: req,
                    originIsolationRegistry: options.originIsolationRegistry,
                    status: response.status,
                    targetUrl: finalTarget.url,
                    redirectTargetUrl: redirectTarget?.url
                }
            ), preparedResponse.classification);
            if (typeof policy.responseDiagnostics === "function") {
                Object.assign(responseHeaders, policy.responseDiagnostics({
                    finalUrl: finalTarget.url,
                    redirectChain,
                    ...redirectOptions
                }));
            }
            for (const [key, value] of Object.entries(responseHeaders)) res.setHeader(key, value);
            if (requestConfig.browser?.publicCache?.enabled && policy.mode === "browser") {
                res.setHeader("x-proxyweb-cache", cacheResponse?.eligible ? "MISS" : "BYPASS");
            }
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
            flushStreamingHeaders(res, preparedResponse.classification);
            pipeline(preparedResponse.body, res, error => {
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
            completeCacheFlight({ stored: false, reason: "request-error" });
            if (
                typeof policy.responseDiagnostics === "function"
                && error.redirectDiagnostics
                && !res.headersSent
            ) {
                const diagnosticHeaders = policy.responseDiagnostics({
                    ...error.redirectDiagnostics,
                    ...(effectiveRedirectOptions || policy.redirectOptions(requestConfig, {
                        request: req
                    }))
                });
                for (const [name, value] of Object.entries(diagnosticHeaders)) res.setHeader(name, value);
                if (policy.exposeCors) {
                    exposeCorsHeaders(req, res, [...Object.keys(diagnosticHeaders), "x-request-id"]);
                }
            }
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
