const assert = require('node:assert/strict');
const test = require('node:test');

test('header suggestions list common fields on focus and filter names case-insensitively', async () => {
	const { filterHeaderSuggestions } = await import('../src/utils/headerCatalog.mjs');
	const all = filterHeaderSuggestions('');
	assert.ok(all.length >= 20);
	assert.ok(all.some(item => item.value === 'Origin'));
	assert.ok(all.some(item => item.value === 'Cookie'));
	assert.deepEqual(filterHeaderSuggestions('referer').map(item => item.value), ['Referer']);
	assert.deepEqual(filterHeaderSuggestions('API 密钥').map(item => item.value), ['X-Api-Key']);
});
