const { ERROR_CODES, ProxyError } = require("../core/errors");
const { applyBrowserPreferences } = require("./preferences");

const RUNTIME_BRIDGE_PATH = "/__proxyweb/runtime.js";

function runtimeBridgeBootstrap() {
    "use strict";

    const runtimeScript = document.currentScript;
    const initialDocumentUrl = runtimeScript?.getAttribute("data-proxyweb-runtime");
    const initialBaseUrl = runtimeScript?.getAttribute("data-proxyweb-base-url");
    const webSocketEnabled = runtimeScript?.getAttribute("data-proxyweb-websocket") === "true";
    const webSocketOriginContext = runtimeScript?.getAttribute("data-proxyweb-origin-context");
    if (!runtimeScript || !initialDocumentUrl || runtimeScript.dataset.proxywebRuntimeActive === "true") return;

    const ROUTE_PREFIX = "/__proxyweb/browser";
    const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
    const WEB_SOCKET_PROTOCOLS = new Set(["ws:", "wss:"]);
    const proxyOrigin = window.location.origin;
    let currentUpstreamUrl;
    let fixedBaseUrl;

    function preserveCallable(wrapper, nativeFunction) {
        Object.setPrototypeOf(wrapper, nativeFunction);
        for (const property of ["name", "length"]) {
            try {
                Object.defineProperty(wrapper, property, {
                    configurable: true,
                    value: nativeFunction[property]
                });
            } catch {
                // Older engines may expose non-configurable function metadata.
            }
        }
        return wrapper;
    }

    function parseHttpUrl(value, base) {
        let url;
        try {
            url = new URL(value, base);
        } catch {
            return null;
        }
        if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
        return url;
    }

    function encodeOrigin(origin) {
        const bytes = new TextEncoder().encode(origin);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    function decodeOrigin(token) {
        if (!/^[A-Za-z0-9_-]+$/.test(token || "")) return null;
        try {
            const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
            const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
            const binary = atob(padded);
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
            const origin = new TextDecoder().decode(bytes);
            const parsed = parseHttpUrl(origin);
            return parsed?.origin === origin && parsed.href === `${origin}/` ? origin : null;
        } catch {
            return null;
        }
    }

    function upstreamFromProxyUrl(value) {
        let proxyUrl;
        try {
            proxyUrl = new URL(value, proxyOrigin);
        } catch {
            return null;
        }
        if (proxyUrl.origin !== proxyOrigin || !proxyUrl.pathname.startsWith(`${ROUTE_PREFIX}/`)) return null;
        const remainder = proxyUrl.pathname.slice(ROUTE_PREFIX.length + 1);
        const separator = remainder.indexOf("/");
        if (separator <= 0) return null;
        const origin = decodeOrigin(remainder.slice(0, separator));
        if (!origin) return null;
        return parseHttpUrl(`${origin}${remainder.slice(separator)}${proxyUrl.search}${proxyUrl.hash}`)?.href || null;
    }

    function toProxyUrl(target) {
        return `${proxyOrigin}${ROUTE_PREFIX}/${encodeOrigin(target.origin)}${target.pathname}${target.search}${target.hash}`;
    }

    function resolveRuntimeUrl(value) {
        if (value === undefined || value === null || value === "") return null;
        const raw = value instanceof URL ? value.href : String(value);
        if (!raw || raw.trim() !== raw || raw.startsWith("#")) return null;

        let resolved = parseHttpUrl(raw, fixedBaseUrl || currentUpstreamUrl);
        if (!resolved) return null;
        if (resolved.origin === proxyOrigin) {
            const canonicalTarget = upstreamFromProxyUrl(resolved.href);
            if (canonicalTarget) {
                return { upstreamUrl: canonicalTarget, proxyUrl: resolved.href, canonical: true };
            }
            resolved = parseHttpUrl(`${resolved.pathname}${resolved.search}${resolved.hash}`, new URL(currentUpstreamUrl).origin);
            if (!resolved) return null;
        }
        return { upstreamUrl: resolved.href, proxyUrl: toProxyUrl(resolved), canonical: false };
    }

    function mapRuntimeUrl(value) {
        return resolveRuntimeUrl(value)?.proxyUrl || value;
    }

    currentUpstreamUrl = parseHttpUrl(initialDocumentUrl)?.href;
    if (!currentUpstreamUrl) return;
    fixedBaseUrl = parseHttpUrl(initialBaseUrl)?.href || null;
    runtimeScript.dataset.proxywebRuntimeActive = "true";

    const NativeRequest = window.Request;
    if (typeof NativeRequest === "function") {
        function ProxyWebRequest(input, init) {
            const mappedInput = input instanceof NativeRequest ? input : mapRuntimeUrl(input);
            const args = arguments.length > 1 ? [mappedInput, init] : [mappedInput];
            if (!new.target) return Reflect.apply(NativeRequest, this, args);
            const constructorTarget = new.target === ProxyWebRequest ? NativeRequest : new.target;
            return Reflect.construct(NativeRequest, args, constructorTarget);
        }
        preserveCallable(ProxyWebRequest, NativeRequest);
        ProxyWebRequest.prototype = NativeRequest.prototype;
        window.Request = ProxyWebRequest;
    }

    const nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
        function proxyWebFetch(input, init) {
            try {
                let mappedInput = input;
                if (typeof NativeRequest === "function" && input instanceof NativeRequest) {
                    const mappedUrl = mapRuntimeUrl(input.url);
                    if (mappedUrl !== input.url) mappedInput = new Request(mappedUrl, input);
                } else {
                    mappedInput = mapRuntimeUrl(input);
                }
                const args = arguments.length > 1 ? [mappedInput, init] : [mappedInput];
                return Reflect.apply(nativeFetch, this, args);
            } catch (error) {
                return Promise.reject(error);
            }
        }
        preserveCallable(proxyWebFetch, nativeFetch);
        window.fetch = proxyWebFetch;
    }

    const nativeXhrOpen = window.XMLHttpRequest?.prototype?.open;
    if (typeof nativeXhrOpen === "function") {
        function proxyWebXhrOpen(method, url) {
            const args = Array.from(arguments);
            args[1] = mapRuntimeUrl(url);
            return Reflect.apply(nativeXhrOpen, this, args);
        }
        preserveCallable(proxyWebXhrOpen, nativeXhrOpen);
        window.XMLHttpRequest.prototype.open = proxyWebXhrOpen;
    }

    const NativeEventSource = window.EventSource;
    if (typeof NativeEventSource === "function") {
        function ProxyWebEventSource(url, options) {
            const args = arguments.length > 1 ? [mapRuntimeUrl(url), options] : [mapRuntimeUrl(url)];
            if (!new.target) return Reflect.apply(NativeEventSource, this, args);
            const constructorTarget = new.target === ProxyWebEventSource ? NativeEventSource : new.target;
            return Reflect.construct(NativeEventSource, args, constructorTarget);
        }
        preserveCallable(ProxyWebEventSource, NativeEventSource);
        ProxyWebEventSource.prototype = NativeEventSource.prototype;
        window.EventSource = ProxyWebEventSource;
    }

    const NativeWebSocket = window.WebSocket;
    if (
        webSocketEnabled
        && typeof NativeWebSocket === "function"
        && /^proxyweb-origin\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(webSocketOriginContext || "")
    ) {
        function mapWebSocketUrl(value) {
            const raw = value instanceof URL ? value.href : String(value);
            let target;
            try {
                target = new URL(raw, fixedBaseUrl || currentUpstreamUrl);
            } catch {
                return value;
            }
            if (HTTP_PROTOCOLS.has(target.protocol)) {
                target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
            }
            if (!WEB_SOCKET_PROTOCOLS.has(target.protocol) || target.username || target.password) return value;

            const httpOrigin = new URL(target.origin);
            httpOrigin.protocol = target.protocol === "wss:" ? "https:" : "http:";
            const proxyProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            return `${proxyProtocol}//${window.location.host}${ROUTE_PREFIX}/${encodeOrigin(httpOrigin.origin)}`
                + `${target.pathname}${target.search}${target.hash}`;
        }

        function appendOriginContext(protocols) {
            if (protocols === undefined) return [webSocketOriginContext];
            if (typeof protocols === "string") return [protocols, webSocketOriginContext];
            return [...protocols, webSocketOriginContext];
        }

        function ProxyWebWebSocket(url, protocols) {
            const args = arguments.length > 1
                ? [mapWebSocketUrl(url), appendOriginContext(protocols)]
                : [mapWebSocketUrl(url), appendOriginContext(undefined)];
            if (!new.target) return Reflect.apply(NativeWebSocket, this, args);
            const constructorTarget = new.target === ProxyWebWebSocket ? NativeWebSocket : new.target;
            return Reflect.construct(NativeWebSocket, args, constructorTarget);
        }
        preserveCallable(ProxyWebWebSocket, NativeWebSocket);
        ProxyWebWebSocket.prototype = NativeWebSocket.prototype;
        window.WebSocket = ProxyWebWebSocket;
    }

    const nativeWindowOpen = window.open;
    if (typeof nativeWindowOpen === "function") {
        function proxyWebWindowOpen(url) {
            const args = Array.from(arguments);
            if (args.length > 0 && url !== "") args[0] = mapRuntimeUrl(url);
            return Reflect.apply(nativeWindowOpen, this, args);
        }
        preserveCallable(proxyWebWindowOpen, nativeWindowOpen);
        window.open = proxyWebWindowOpen;
    }

    function patchHistoryMethod(name) {
        const nativeMethod = window.history?.[name];
        if (typeof nativeMethod !== "function") return;
        function proxyWebHistoryMethod(state, title, url) {
            if (arguments.length < 3 || url === undefined || url === null) {
                return Reflect.apply(nativeMethod, this, arguments);
            }
            const raw = url instanceof URL ? url.href : String(url);
            const current = new URL(currentUpstreamUrl);
            const canonicalTarget = upstreamFromProxyUrl(raw);
            const resolved = parseHttpUrl(canonicalTarget || raw, current.href);
            if (!resolved) return Reflect.apply(nativeMethod, this, arguments);
            if (resolved.origin !== current.origin) {
                throw new DOMException("History URL must use the current upstream origin", "SecurityError");
            }
            const result = Reflect.apply(nativeMethod, this, [state, title, toProxyUrl(resolved)]);
            currentUpstreamUrl = resolved.href;
            return result;
        }
        preserveCallable(proxyWebHistoryMethod, nativeMethod);
        window.history[name] = proxyWebHistoryMethod;
    }

    patchHistoryMethod("pushState");
    patchHistoryMethod("replaceState");
    const syncHistoryUrl = () => {
        const target = upstreamFromProxyUrl(window.location.href);
        if (target) currentUpstreamUrl = target;
    };
    window.addEventListener("popstate", syncHistoryUrl);
    window.addEventListener("hashchange", syncHistoryUrl);
}

const RUNTIME_BRIDGE_SOURCE = `;(${runtimeBridgeBootstrap.toString()})();\n`;

function createRuntimeBridgeHandler({ getConfig }) {
    if (typeof getConfig !== "function") throw new TypeError("getConfig must be a function");
    return (req, res, next) => {
        const configuredRequest = getConfig();
        const requestConfig = applyBrowserPreferences(
            configuredRequest,
            req.session?.proxyWebBrowserPreferences
        );
        if (!requestConfig.browser.enabled || !requestConfig.browser.runtimeBridge) {
            return next(new ProxyError(ERROR_CODES.ROUTE_NOT_FOUND, "Runtime Bridge is not available", {
                statusCode: 404
            }));
        }
        res.set({
            "cache-control": "no-store",
            "content-type": "application/javascript; charset=utf-8",
            "x-content-type-options": "nosniff"
        });
        return res.send(RUNTIME_BRIDGE_SOURCE);
    };
}

module.exports = {
    RUNTIME_BRIDGE_PATH,
    RUNTIME_BRIDGE_SOURCE,
    createRuntimeBridgeHandler
};
