const test = require('node:test');
const assert = require('node:assert/strict');

function encode(value) {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('redirect settings normalize and append only API control parameters', async () => {
	const { applyRedirectSettings, normalizeRedirectSettings } = await import('../src/utils/responseDiagnostics.mjs');
	assert.deepEqual(normalizeRedirectSettings({ followRedirects: 'false', maxRedirects: '2' }), {
		followRedirects: false, maxRedirects: 2
	});
	assert.deepEqual(normalizeRedirectSettings({ followRedirects: 'yes', maxRedirects: '99' }), {
		followRedirects: true, maxRedirects: 5
	});
	const url = new URL(applyRedirectSettings('https://proxy.test/__proxyweb/api?url=target', {
		followRedirects: false, maxRedirects: 0
	}));
	assert.equal(url.searchParams.get('url'), 'target');
	assert.equal(url.searchParams.get('followRedirects'), 'false');
	assert.equal(url.searchParams.get('maxRedirects'), '0');
});

test('response diagnostics decode bounded trustworthy metadata and reject malformed values', async () => {
	const { parseResponseDiagnostics } = await import('../src/utils/responseDiagnostics.mjs');
	const chain = [{
		status: 302, method: 'get', url: 'https://one.test/', location: 'https://two.test/',
		followed: true, validated: true
	}];
	const parsed = parseResponseDiagnostics({
		'x-proxyweb-final-url': encode('https://two.test/'),
		'x-proxyweb-redirect-chain': encode(chain),
		'x-proxyweb-follow-redirects': 'true',
		'x-proxyweb-max-redirects': '3'
	}, 'https://fallback.test/');
	assert.equal(parsed.finalUrl, 'https://two.test/');
	assert.equal(parsed.redirectChain[0].method, 'GET');
	assert.equal(parsed.followRedirects, true);
	assert.equal(parsed.maxRedirects, 3);

	const malformed = parseResponseDiagnostics({
		'x-proxyweb-final-url': 'not+base64',
		'x-proxyweb-redirect-chain': encode([{ status: '302', url: 1 }])
	}, 'https://fallback.test/');
	assert.equal(malformed.finalUrl, 'https://fallback.test/');
	assert.deepEqual(malformed.redirectChain, []);
});

test('response byte size uses UTF-8 bytes and total timing is monotonic', async () => {
	const { elapsedMilliseconds, responseByteLength } = await import('../src/utils/responseDiagnostics.mjs');
	assert.equal(responseByteLength('猫'), 3);
	assert.equal(responseByteLength({ value: '猫' }), Buffer.byteLength(JSON.stringify({ value: '猫' })));
	assert.equal(responseByteLength(new Uint8Array([1, 2, 3])), 3);
	assert.equal(elapsedMilliseconds(10.01, 22.26), 12.3);
	assert.equal(elapsedMilliseconds(20, 10), 0);
});
