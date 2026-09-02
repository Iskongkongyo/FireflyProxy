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

test('URL query parameters populate editor rows with duplicate order intact', async () => {
	const { queryRowsFromUrl } = await import('../src/utils/requestEditor.mjs');
	assert.deepEqual(queryRowsFromUrl('https://example.test/search?q=firefly&q=proxy&empty=#result'), [
		{ enabled: true, key: 'q', value: 'firefly' },
		{ enabled: true, key: 'q', value: 'proxy' },
		{ enabled: true, key: 'empty', value: '' }
	]);
	assert.equal(queryRowsFromUrl('not-a-complete-url'), null);
});

test('editor query rows replace URL parameters without duplication and preserve the editor fragment', async () => {
	const { replaceQueryRows } = await import('../src/utils/requestEditor.mjs');
	const result = new URL(replaceQueryRows('https://example.test/path?old=1#fragment', [
		{ enabled: true, key: 'q', value: 'one' },
		{ enabled: false, key: 'skip', value: 'secret' },
		{ enabled: true, key: 'q', value: 'two' }
	]));

	assert.equal(result.hash, '#fragment');
	assert.equal(result.searchParams.has('old'), false);
	assert.deepEqual(result.searchParams.getAll('q'), ['one', 'two']);
	assert.equal(result.searchParams.has('skip'), false);
});

test('request URL can preserve resolved template parameters when the editor has no rows', async () => {
	const { replaceQueryRows } = await import('../src/utils/requestEditor.mjs');
	assert.equal(
		replaceQueryRows('https://example.test/path?token=resolved#fragment', [], {
			stripHash: true,
			preserveExistingWhenEmpty: true
		}),
		'https://example.test/path?token=resolved'
	);
});

test('serialized editor rows exclude disabled and blank keys', async () => {
	const { serializeEditorRows } = await import('../src/utils/requestEditor.mjs');
	assert.equal(serializeEditorRows([
		{ enabled: false, key: 'off', value: '1' },
		{ enabled: true, key: '', value: '2' },
		{ enabled: true, key: 'on', value: '3' }
	]), '[{"enabled":true,"key":"on","value":"3"}]');
});
