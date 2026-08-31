const assert = require('node:assert/strict');
const { test } = require('node:test');

async function loadShareLinks() {
    return import('../src/utils/shareLinks.mjs');
}

test('direct API links target the backend route and return GET response URLs', async () => {
    const { buildDirectApiLink } = await loadShareLinks();
    const link = buildDirectApiLink({
        apiBaseUrl: 'http://proxy.test:8082/',
        targetUrl: 'https://upstream.test/users?role=admin',
        method: 'GET',
        redirect: { followRedirects: false, maxRedirects: 2 }
    });
    const url = new URL(link);

    assert.equal(url.origin, 'http://proxy.test:8082');
    assert.equal(url.pathname, '/__proxyweb/api');
    assert.equal(url.searchParams.get('url'), 'https://upstream.test/users?role=admin');
    assert.equal(url.searchParams.get('followRedirects'), 'false');
    assert.equal(url.searchParams.get('maxRedirects'), '2');
    assert.equal(url.searchParams.has('method'), false);
});

test('direct API links reject methods that browser navigation cannot represent', async () => {
    const { buildDirectApiLink } = await loadShareLinks();
    assert.throws(() => buildDirectApiLink({
        apiBaseUrl: 'http://proxy.test:8082',
        targetUrl: 'https://upstream.test/users',
        method: 'POST'
    }), /只支持 GET/);
});

test('page links preserve editor rows while omitting sensitive headers and runtime secrets', async () => {
    const { buildRequestPageLink } = await loadShareLinks();
    const link = buildRequestPageLink({
        pageUrl: 'http://frontend.test:8080/web/?old=value#response',
        draft: {
            method: 'PATCH',
            url: '{{baseUrl}}/users',
            params: [
                { enabled: true, key: 'page', value: '1' },
                { enabled: false, key: 'debug', value: 'yes' }
            ],
            headers: [
                { enabled: true, key: 'Accept', value: 'application/json' },
                { enabled: false, key: 'X-Debug', value: 'disabled' },
                { enabled: true, key: 'Authorization', value: 'Bearer secret' }
            ],
            auth: { type: 'bearer', token: 'auth-secret' },
            body: { type: 'raw', text: 'body-secret' },
            redirect: { followRedirects: true, maxRedirects: 4 }
        }
    });
    const url = new URL(link);

    assert.equal(url.pathname, '/web/');
    assert.equal(url.hash, '');
    assert.equal(url.searchParams.get('url'), '{{baseUrl}}/users');
    assert.equal(url.searchParams.get('method'), 'PATCH');
    assert.deepEqual(JSON.parse(url.searchParams.get('params')), [
        { enabled: true, key: 'page', value: '1' },
        { enabled: false, key: 'debug', value: 'yes' }
    ]);
    assert.deepEqual(JSON.parse(url.searchParams.get('headers')), [
        { enabled: true, key: 'Accept', value: 'application/json' },
        { enabled: false, key: 'X-Debug', value: 'disabled' }
    ]);
    assert.doesNotMatch(link, /Bearer|auth-secret|body-secret|old=value/);
});
