const assert = require('node:assert/strict');
const { test } = require('node:test');

async function loadBrowserHelpers() {
    return import('../src/utils/browserProxy.mjs');
}

test('Browser target validation accepts only credential-free HTTP(S) URLs', async () => {
    const { normalizeBrowserTarget } = await loadBrowserHelpers();

    assert.equal(normalizeBrowserTarget(' https://example.test/docs '), 'https://example.test/docs');
    assert.equal(normalizeBrowserTarget('http://example.test'), 'http://example.test/');
    assert.equal(normalizeBrowserTarget('ftp://example.test/file'), null);
    assert.equal(normalizeBrowserTarget('https://user:secret@example.test/'), null);
    assert.equal(normalizeBrowserTarget('not a url'), null);
});

test('Browser entry URL keeps preferences explicit and target credentials out of controls', async () => {
    const { buildBrowserEntryUrl } = await loadBrowserHelpers();
    const result = new URL(buildBrowserEntryUrl(
        'https://browse.proxy.test/',
        'https://example.test/path?q=1#view',
        {
            rewriteHtml: false,
            rewriteCss: true,
            cookieJar: false,
            compatHeaders: true
        }
    ));

    assert.equal(result.origin, 'https://browse.proxy.test');
    assert.equal(result.pathname, '/__proxyweb/browser');
    assert.equal(result.searchParams.get('url'), 'https://example.test/path?q=1#view');
    assert.equal(result.searchParams.get('rewriteHtml'), 'false');
    assert.equal(result.searchParams.get('rewriteCss'), 'true');
    assert.equal(result.searchParams.get('cookieJar'), 'false');
    assert.equal(result.searchParams.get('compatHeaders'), 'true');
    assert.equal(result.searchParams.has('runtimeBridge'), false);
    assert.throws(
        () => buildBrowserEntryUrl('javascript:alert(1)', 'https://example.test/'),
        /base URL/
    );
});

test('embedded preview is allowed only when Browser Proxy uses a separate origin', async () => {
    const { canEmbedBrowserProxy } = await loadBrowserHelpers();

    assert.equal(canEmbedBrowserProxy('https://app.proxy.test', 'https://browse.proxy.test'), true);
    assert.equal(canEmbedBrowserProxy('https://proxy.test', 'https://proxy.test/'), false);
    assert.equal(canEmbedBrowserProxy('invalid', 'https://browse.proxy.test'), false);
});
