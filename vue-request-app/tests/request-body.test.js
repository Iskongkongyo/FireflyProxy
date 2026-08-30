const test = require('node:test');
const assert = require('node:assert/strict');

test('builds none, raw, and validated JSON body contracts', async () => {
	const { buildRequestBody } = await import('../src/utils/requestBody.mjs');
	assert.deepEqual(buildRequestBody({ type: 'none' }), { body: null, contentType: '', mode: 'none' });
	assert.deepEqual(buildRequestBody({ type: 'raw', text: 'hello', contentType: ' text/plain ' }), {
		body: 'hello', contentType: 'text/plain', mode: 'raw'
	});
	assert.equal(buildRequestBody({ type: 'json', text: '{"ok":true}' }).contentType, 'application/json;charset=utf-8');
	assert.throws(() => buildRequestBody({ type: 'json', text: '{bad' }), /JSON 语法/);
});

test('urlencoded body preserves duplicate order and skips disabled fields', async () => {
	const { buildRequestBody } = await import('../src/utils/requestBody.mjs');
	const payload = buildRequestBody({
		type: 'urlencoded',
		rows: [
			{ enabled: true, key: 'tag', value: 'one' },
			{ enabled: false, key: 'secret', value: 'hidden' },
			{ enabled: true, key: 'tag', value: 'two words' }
		]
	});
	assert.equal(payload.body.toString(), 'tag=one&tag=two+words');
	assert.match(payload.contentType, /x-www-form-urlencoded/);
});

test('multipart body includes text and selected files but never imports paths', async () => {
	const { buildRequestBody } = await import('../src/utils/requestBody.mjs');
	const file = new Blob(['cat'], { type: 'text/plain' });
	Object.defineProperty(file, 'name', { value: 'cat.txt' });
	const payload = buildRequestBody({
		type: 'multipart',
		rows: [
			{ enabled: true, key: 'caption', kind: 'text', value: 'hello' },
			{ enabled: true, key: 'upload', kind: 'file', file, fileName: 'ignored.txt' }
		]
	});
	assert.equal(payload.contentType, '');
	assert.equal(payload.body.get('caption'), 'hello');
	assert.equal(payload.body.get('upload').name, 'cat.txt');
	assert.throws(() => buildRequestBody({
		type: 'multipart', rows: [{ enabled: true, key: 'upload', kind: 'file', filePath: '/secret.txt' }]
	}), /重新选择本地文件/);
});
