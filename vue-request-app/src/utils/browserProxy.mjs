export const DEFAULT_BROWSER_PREFERENCES = Object.freeze({
    rewriteHtml: true,
    rewriteCss: true,
    cookieJar: true,
    compatHeaders: true
});

export function normalizeBrowserTarget(value) {
    const candidate = String(value || "").trim();
    let target;
    try {
        target = new URL(candidate);
    } catch {
        return null;
    }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
    return target.href;
}

export function buildBrowserEntryUrl(baseUrl, targetUrl, preferences = DEFAULT_BROWSER_PREFERENCES) {
    const normalizedTarget = normalizeBrowserTarget(targetUrl);
    if (!normalizedTarget) throw new TypeError('Browser target must be an HTTP(S) URL without credentials');

    const proxyBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
    const parsedBase = new URL(proxyBaseUrl);
    if (
        !['http:', 'https:'].includes(parsedBase.protocol)
        || parsedBase.username
        || parsedBase.password
        || parsedBase.search
        || parsedBase.hash
    ) {
        throw new TypeError('Browser Proxy base URL must be a credential-free HTTP(S) URL');
    }
    const entry = new URL(`${proxyBaseUrl}/__proxyweb/browser`);
    entry.searchParams.set('url', normalizedTarget);
    for (const field of Object.keys(DEFAULT_BROWSER_PREFERENCES)) {
        const value = preferences[field] ?? DEFAULT_BROWSER_PREFERENCES[field];
        entry.searchParams.set(field, String(Boolean(value)));
    }
    return entry.href;
}

export function canEmbedBrowserProxy(appOrigin, browserBaseUrl) {
    try {
        return new URL(browserBaseUrl).origin !== new URL(appOrigin).origin;
    } catch {
        return false;
    }
}
