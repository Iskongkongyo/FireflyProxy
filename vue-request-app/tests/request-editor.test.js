const test = require('node:test');
const assert = require('node:assert/strict');

test('request editor normalizes legacy rows and keeps disabled state', async () => {
	const { normalizeEditorRows } = await import('../src/utils/requestEditor.mjs');
	assert.deepEqual(normalizeEditorRows([{ key: 'a', value: 1 }, { enabled: false, key: 'b' }]), [
		{ enabled: true, key: 'a', value: '1' },
		{ enabled: false, key: 'b', value: '' }
	]);
});

test('request editor safely recovers from malformed shared rows', async () => {
	const { parseEditorRows } = await import('../src/utils/requestEditor.mjs');
	assert.deepEqual(parseEditorRows('{not-json'), [{ enabled: true, key: '', value: '' }]);
});

test('query rows preserve existing values and duplicate order while skipping disabled rows', async () => {
	const { appendQueryRows } = await import('../src/utils/requestEditor.mjs');
	const result = new URL(appendQueryRows('https://example.test/path?x=0#fragment', [
		{ enabled: true, key: 'x', value: '1' },
		{ enabled: false, key: 'skip', value: 'secret' },
		{ enabled: true, key: 'x', value: '2' }
	]));
	assert.equal(result.hash, '');
	assert.deepEqual(result.searchParams.getAll('x'), ['0', '1', '2']);
	assert.equal(result.searchParams.has('skip'), false);
});

test('serialized editor rows exclude disabled and blank keys', async () => {
	const { serializeEditorRows } = await import('../src/utils/requestEditor.mjs');
	assert.equal(serializeEditorRows([
		{ enabled: false, key: 'off', value: '1' },
		{ enabled: true, key: '', value: '2' },
		{ enabled: true, key: 'on', value: '3' }
	]), '[{"enabled":true,"key":"on","value":"3"}]');
});
