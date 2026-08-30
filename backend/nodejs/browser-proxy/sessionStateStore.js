const { CookieJar } = require("tough-cookie");

function createSessionStateStore(options = {}) {
    const createCookieJar = options.createCookieJar || (() => new CookieJar());
    const now = options.now || Date.now;
    const states = new Map();

    function removeExpiredStates(currentTime) {
        for (const [sessionId, state] of states) {
            if (state.expiresAt <= currentTime) states.delete(sessionId);
        }
    }

    function get(sessionId, maxAgeMs) {
        if (typeof sessionId !== "string" || !sessionId) {
            throw new TypeError("A non-empty proxyWeb session ID is required");
        }
        if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
            throw new TypeError("Session state maxAgeMs must be a positive safe integer");
        }

        const currentTime = now();
        removeExpiredStates(currentTime);
        let state = states.get(sessionId);
        if (!state) {
            state = {
                cookieJar: createCookieJar(),
                expiresAt: currentTime + maxAgeMs
            };
            states.set(sessionId, state);
        } else {
            state.expiresAt = currentTime + maxAgeMs;
        }
        return state;
    }

    return Object.freeze({
        get,
        delete(sessionId) {
            return states.delete(sessionId);
        },
        clear() {
            states.clear();
        },
        get size() {
            removeExpiredStates(now());
            return states.size;
        }
    });
}

async function getCookieHeader(sessionState, targetUrl) {
    if (!sessionState?.cookieJar) return "";
    return sessionState.cookieJar.getCookieString(targetUrl);
}

async function storeResponseCookies(sessionState, targetUrl, setCookieHeaders, options = {}) {
    if (!sessionState?.cookieJar || !setCookieHeaders) return;
    const values = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const value of values) {
        try {
            await sessionState.cookieJar.setCookie(String(value), targetUrl, { ignoreError: true });
        } catch (error) {
            options.logger?.warn("[Proxy] Rejected invalid upstream cookie", {
                requestId: options.requestId,
                targetOrigin: new URL(targetUrl).origin,
                error
            });
        }
    }
}

module.exports = {
    createSessionStateStore,
    getCookieHeader,
    storeResponseCookies
};
