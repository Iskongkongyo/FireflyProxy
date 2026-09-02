const { ERROR_CODES, ProxyError } = require("../core/errors");
const { applyBrowserPreferences } = require("./preferences");

const RUNTIME_BRIDGE_PATH = "/__proxyweb/runtime.js";

function runtimeBridgeBootstrap() {
    "use strict";

    const runtimeScript = document.currentScript;
    const initialDocumentUrl = runtimeScript?.getAttribute("data-fireflyproxy-runtime");
    const initialBaseUrl = runtimeScript?.getAttribute("data-fireflyproxy-base-url");
    const scriptCookieBridgeEnabled = runtimeScript?.getAttribute("data-fireflyproxy-script-cookie-bridge") === "true";
    const webSocketEnabled = runtimeScript?.getAttribute("data-fireflyproxy-websocket") === "true";
    const webSocketOriginContext = runtimeScript?.getAttribute("data-fireflyproxy-origin-context");
    const isolationBaseOriginValue = runtimeScript?.getAttribute("data-fireflyproxy-isolation-base-origin");
    if (!runtimeScript || !initialDocumentUrl || runtimeScript.dataset.fireflyproxyRuntimeActive === "true") return;

    const ROUTE_PREFIX = "/__proxyweb/browser";
    const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
    const WEB_SOCKET_PROTOCOLS = new Set(["ws:", "wss:"]);
    const proxyOrigin = window.location.origin;
    const isolationBaseOrigin = parseHttpUrl(isolationBaseOriginValue)?.origin || null;
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

    function encodeCookieName(name) {
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name || "")) return null;
        const bytes = new TextEncoder().encode(name);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    function decodeCookieName(token) {
        if (!/^[A-Za-z0-9_-]+$/.test(token || "")) return null;
        try {
            const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
            const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
            const binary = atob(padded);
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
            const name = new TextDecoder().decode(bytes);
            return encodeCookieName(name) === token ? name : null;
        } catch {
            return null;
        }
    }

    function sha256Hex(value) {
        const constants = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];
        const bytes = new TextEncoder().encode(value);
        const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
        const data = new Uint8Array(paddedLength);
        data.set(bytes);
        data[bytes.length] = 0x80;
        const view = new DataView(data.buffer);
        const bitLength = bytes.length * 8;
        view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
        view.setUint32(paddedLength - 4, bitLength >>> 0);
        const hash = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        ];
        const words = new Uint32Array(64);
        const rotate = (word, count) => (word >>> count) | (word << (32 - count));
        for (let offset = 0; offset < data.length; offset += 64) {
            for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
            for (let index = 16; index < 64; index += 1) {
                const left = words[index - 15];
                const right = words[index - 2];
                const sigma0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3);
                const sigma1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10);
                words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
            }
            let [a, b, c, d, e, f, g, h] = hash;
            for (let index = 0; index < 64; index += 1) {
                const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
                const choice = (e & f) ^ (~e & g);
                const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
                const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
                const majority = (a & b) ^ (a & c) ^ (b & c);
                const temp2 = (sum0 + majority) >>> 0;
                h = g; g = f; f = e; e = (d + temp1) >>> 0;
                d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
            }
            hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
            hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
            hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
            hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
        }
        return hash.map(word => word.toString(16).padStart(8, "0")).join("");
    }

    function proxyOriginFor(upstreamOrigin) {
        if (!isolationBaseOrigin) return proxyOrigin;
        const base = new URL(isolationBaseOrigin);
        base.hostname = `o-${sha256Hex(upstreamOrigin).slice(0, 32)}.${base.hostname}`;
        return base.origin;
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
        if (!proxyUrl.pathname.startsWith(`${ROUTE_PREFIX}/`)) return null;
        const remainder = proxyUrl.pathname.slice(ROUTE_PREFIX.length + 1);
        const separator = remainder.indexOf("/");
        if (separator <= 0) return null;
        const origin = decodeOrigin(remainder.slice(0, separator));
        if (!origin) return null;
        if (proxyUrl.origin !== proxyOriginFor(origin)) return null;
        return parseHttpUrl(`${origin}${remainder.slice(separator)}${proxyUrl.search}${proxyUrl.hash}`)?.href || null;
    }

    function toProxyUrl(target) {
        return `${proxyOriginFor(target.origin)}${ROUTE_PREFIX}/${encodeOrigin(target.origin)}${target.pathname}${target.search}${target.hash}`;
    }

    function resolveRuntimeUrl(value) {
        if (value === undefined || value === null || value === "") return null;
        const raw = value instanceof URL ? value.href : String(value);
        if (!raw || raw.trim() !== raw || raw.startsWith("#")) return null;

        let resolved = parseHttpUrl(raw, fixedBaseUrl || currentUpstreamUrl);
        if (!resolved) return null;
        const canonicalTarget = upstreamFromProxyUrl(resolved.href);
        if (canonicalTarget) {
            return { upstreamUrl: canonicalTarget, proxyUrl: resolved.href, canonical: true };
        }
        if (resolved.origin === proxyOrigin) {
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
    runtimeScript.dataset.fireflyproxyRuntimeActive = "true";

    function installScriptCookieBridge() {
        if (!scriptCookieBridgeEnabled || typeof Document !== "function") return;
        const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
        if (!descriptor?.configurable || typeof descriptor.get !== "function" || typeof descriptor.set !== "function") {
            return;
        }

        const prefix = `__fireflyproxy_sc_${encodeOrigin(new URL(currentUpstreamUrl).origin)}_`;
        const nativeGetter = descriptor.get;
        const nativeSetter = descriptor.set;
        Object.defineProperty(Document.prototype, "cookie", {
            configurable: true,
            enumerable: descriptor.enumerable,
            get() {
                const visible = [];
                const nativeValue = Reflect.apply(nativeGetter, this, []);
                for (const part of String(nativeValue || "").split(";")) {
                    const candidate = part.trim();
                    const separator = candidate.indexOf("=");
                    if (separator <= 0) continue;
                    const carrierName = candidate.slice(0, separator).trim();
                    if (!carrierName.startsWith(prefix)) continue;
                    const name = decodeCookieName(carrierName.slice(prefix.length));
                    if (name) visible.push(`${name}=${candidate.slice(separator + 1).trim()}`);
                }
                return visible.join("; ");
            },
            set(value) {
                const parts = String(value).split(";");
                const pair = parts.shift()?.trim() || "";
                const separator = pair.indexOf("=");
                if (separator <= 0) return undefined;
                const name = pair.slice(0, separator).trim();
                const encodedName = encodeCookieName(name);
                if (!encodedName) return undefined;

                const attributes = [];
                for (const rawAttribute of parts) {
                    const attribute = rawAttribute.trim();
                    const key = attribute.split("=", 1)[0].trim().toLowerCase();
                    if (key === "expires" || key === "max-age") attributes.push(attribute);
                }
                const serialized = `${prefix}${encodedName}=${pair.slice(separator + 1).trim()}; Path=/`
                    + (attributes.length ? `; ${attributes.join("; ")}` : "");
                return Reflect.apply(nativeSetter, this, [serialized]);
            }
        });
    }

    installScriptCookieBridge();

    const NativeRequest = window.Request;
    if (typeof NativeRequest === "function") {
        function FireflyProxyRequest(input, init) {
            const mappedInput = input instanceof NativeRequest ? input : mapRuntimeUrl(input);
            const args = arguments.length > 1 ? [mappedInput, init] : [mappedInput];
            if (!new.target) return Reflect.apply(NativeRequest, this, args);
            const constructorTarget = new.target === FireflyProxyRequest ? NativeRequest : new.target;
            return Reflect.construct(NativeRequest, args, constructorTarget);
        }
        preserveCallable(FireflyProxyRequest, NativeRequest);
        FireflyProxyRequest.prototype = NativeRequest.prototype;
        window.Request = FireflyProxyRequest;
    }

    const nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
        function fireflyProxyFetch(input, init) {
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
        preserveCallable(fireflyProxyFetch, nativeFetch);
        window.fetch = fireflyProxyFetch;
    }

    const nativeXhrOpen = window.XMLHttpRequest?.prototype?.open;
    if (typeof nativeXhrOpen === "function") {
        function fireflyProxyXhrOpen(method, url) {
            const args = Array.from(arguments);
            args[1] = mapRuntimeUrl(url);
            return Reflect.apply(nativeXhrOpen, this, args);
        }
        preserveCallable(fireflyProxyXhrOpen, nativeXhrOpen);
        window.XMLHttpRequest.prototype.open = fireflyProxyXhrOpen;
    }

    const NativeEventSource = window.EventSource;
    if (typeof NativeEventSource === "function") {
        function FireflyProxyEventSource(url, options) {
            const args = arguments.length > 1 ? [mapRuntimeUrl(url), options] : [mapRuntimeUrl(url)];
            if (!new.target) return Reflect.apply(NativeEventSource, this, args);
            const constructorTarget = new.target === FireflyProxyEventSource ? NativeEventSource : new.target;
            return Reflect.construct(NativeEventSource, args, constructorTarget);
        }
        preserveCallable(FireflyProxyEventSource, NativeEventSource);
        FireflyProxyEventSource.prototype = NativeEventSource.prototype;
        window.EventSource = FireflyProxyEventSource;
    }

    const NativeWebSocket = window.WebSocket;
    if (
        webSocketEnabled
        && typeof NativeWebSocket === "function"
        && /^fireflyproxy-origin\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(webSocketOriginContext || "")
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
            const targetProxyOrigin = new URL(proxyOriginFor(httpOrigin.origin));
            return `${proxyProtocol}//${targetProxyOrigin.host}${ROUTE_PREFIX}/${encodeOrigin(httpOrigin.origin)}`
                + `${target.pathname}${target.search}${target.hash}`;
        }

        function appendOriginContext(protocols) {
            if (protocols === undefined) return [webSocketOriginContext];
            if (typeof protocols === "string") return [protocols, webSocketOriginContext];
            return [...protocols, webSocketOriginContext];
        }

        function FireflyProxyWebSocket(url, protocols) {
            const args = arguments.length > 1
                ? [mapWebSocketUrl(url), appendOriginContext(protocols)]
                : [mapWebSocketUrl(url), appendOriginContext(undefined)];
            if (!new.target) return Reflect.apply(NativeWebSocket, this, args);
            const constructorTarget = new.target === FireflyProxyWebSocket ? NativeWebSocket : new.target;
            return Reflect.construct(NativeWebSocket, args, constructorTarget);
        }
        preserveCallable(FireflyProxyWebSocket, NativeWebSocket);
        FireflyProxyWebSocket.prototype = NativeWebSocket.prototype;
        window.WebSocket = FireflyProxyWebSocket;
    }

    const nativeWindowOpen = window.open;
    if (typeof nativeWindowOpen === "function") {
        function fireflyProxyWindowOpen(url) {
            const args = Array.from(arguments);
            if (args.length > 0 && url !== "") args[0] = mapRuntimeUrl(url);
            return Reflect.apply(nativeWindowOpen, this, args);
        }
        preserveCallable(fireflyProxyWindowOpen, nativeWindowOpen);
        window.open = fireflyProxyWindowOpen;
    }

    function patchHistoryMethod(name) {
        const nativeMethod = window.history?.[name];
        if (typeof nativeMethod !== "function") return;
        function fireflyProxyHistoryMethod(state, title, url) {
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
        preserveCallable(fireflyProxyHistoryMethod, nativeMethod);
        window.history[name] = fireflyProxyHistoryMethod;
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
            req.session?.fireflyProxyBrowserPreferences
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
