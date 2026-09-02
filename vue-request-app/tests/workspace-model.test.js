const test = require('node:test');
const assert = require('node:assert/strict');

test('environment templates resolve recursively without executing expressions', async () => {
	const { normalizeEnvironment, resolveRequestDraft } = await import('../src/utils/workspaceModel.mjs');
	const environment = normalizeEnvironment({
		name: 'Development',
		variables: [
			{ key: 'origin', value: 'https://api.example.test' },
			{ key: 'version', value: 'v1' },
			{ key: 'baseUrl', value: '{{origin}}/{{version}}' },
			{ key: 'token', value: 'secret-token', secret: true }
		]
	});
	const resolved = resolveRequestDraft({
		method: 'POST',
		url: '{{baseUrl}}/users',
		params: [{ key: 'id', value: '{{version}}' }],
		headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
		auth: { type: 'none' },
		body: { type: 'json', text: '{"token":"{{token}}"}' }
	}, environment);
	assert.equal(resolved.url, 'https://api.example.test/v1/users');
	assert.equal(resolved.params[0].value, 'v1');
	assert.equal(resolved.headers[0].value, 'Bearer secret-token');
	assert.equal(resolved.body.text, '{"token":"secret-token"}');
});

test('unknown, duplicate, malformed and cyclic environment variables fail closed', async () => {
	const { normalizeEnvironment, resolveTemplate } = await import('../src/utils/workspaceModel.mjs');
	assert.throws(() => normalizeEnvironment({ name: 'bad', variables: [
		{ key: 'token', value: 'one' }, { key: 'token', value: 'two' }
	]}), /不能重复/);
	assert.throws(() => normalizeEnvironment({ name: 'bad', variables: [{ key: 'bad key', value: '' }] }), /变量/);
	assert.throws(() => resolveTemplate('{{missing}}', normalizeEnvironment({ name: 'empty', variables: [] })), /未找到/);
	const cyclic = normalizeEnvironment({ name: 'cycle', variables: [
		{ key: 'a', value: '{{b}}' }, { key: 'b', value: '{{a}}' }
	] });
	assert.throws(() => resolveTemplate('{{a}}', cyclic), /循环引用/);
	assert.throws(() => resolveTemplate('{{ process.exit() }}', cyclic), /无效或未闭合/);
});

test('saved requests keep request fields but strip browser file capabilities', async () => {
	const { normalizeSavedRequest } = await import('../src/utils/workspaceModel.mjs');
	const fakeFile = { name: 'secret.txt', size: 10 };
	const request = normalizeSavedRequest({
		name: 'Upload', method: 'POST', url: '{{baseUrl}}/upload',
		headers: [{ key: 'X-Test', value: 'ok' }],
		body: { type: 'multipart', rows: [
			{ key: 'file', kind: 'file', file: fakeFile, fileName: 'old.txt' }
		] },
		auth: { type: 'bearer', token: '{{token}}' }
	});
	assert.equal(request.body.rows[0].file, null);
	assert.equal(request.body.rows[0].fileName, 'secret.txt');
	assert.deepEqual(request.auth, { type: 'bearer', token: '{{token}}' });
});

test('API Key auth resolves environment variables and applies to headers or query parameters', async () => {
	const {
		applyApiKeyAuth,
		normalizeEnvironment,
		normalizeSavedRequest,
		resolveRequestDraft
	} = await import('../src/utils/workspaceModel.mjs');
	const environment = normalizeEnvironment({ name: 'API', variables: [
		{ key: 'apiKeyName', value: 'X-Subscription-Key' },
		{ key: 'apiKeyValue', value: 'secret-value', secret: true }
	] });
	const headerDraft = resolveRequestDraft({
		method: 'GET',
		url: 'https://example.test/items',
		headers: [],
		params: [],
		body: { type: 'none' },
		auth: { type: 'apiKey', key: '{{apiKeyName}}', value: '{{apiKeyValue}}', addTo: 'header' }
	}, environment);
	const headerRequest = applyApiKeyAuth(headerDraft);
	assert.deepEqual(headerRequest.headers, [
		{ enabled: true, key: 'X-Subscription-Key', value: 'secret-value' }
	]);

	const queryRequest = applyApiKeyAuth({
		...headerDraft,
		url: 'https://example.test/items?page=1',
		headers: [],
		auth: { ...headerDraft.auth, addTo: 'query' }
	});
	const queryUrl = new URL(queryRequest.url);
	assert.equal(queryUrl.searchParams.get('page'), '1');
	assert.equal(queryUrl.searchParams.get('X-Subscription-Key'), 'secret-value');
	const saved = normalizeSavedRequest({
		name: 'API Key Request',
		method: 'GET',
		url: 'https://example.test/',
		auth: { type: 'apiKey', key: '{{apiKeyName}}', value: '{{apiKeyValue}}', addTo: 'query' }
	});
	assert.deepEqual(saved.auth, {
		type: 'apiKey', key: '{{apiKeyName}}', value: '{{apiKeyValue}}', addTo: 'query'
	});
});

test('manual editor values override API Key auth and incomplete configuration fails closed', async () => {
	const { applyApiKeyAuth } = await import('../src/utils/workspaceModel.mjs');
	const manualHeader = applyApiKeyAuth({
		url: 'https://example.test/',
		headers: [{ enabled: true, key: 'x-api-key', value: 'manual' }],
		auth: { type: 'apiKey', key: 'X-API-Key', value: 'generated', addTo: 'header' }
	});
	assert.equal(manualHeader.headers.length, 1);
	assert.equal(manualHeader.headers[0].value, 'manual');

	const manualQuery = applyApiKeyAuth({
		url: 'https://example.test/?api_key=manual',
		headers: [],
		auth: { type: 'apiKey', key: 'api_key', value: 'generated', addTo: 'query' }
	});
	assert.deepEqual(new URL(manualQuery.url).searchParams.getAll('api_key'), ['manual']);
	assert.throws(() => applyApiKeyAuth({
		url: 'https://example.test/', headers: [], auth: { type: 'apiKey', key: 'X-API-Key', value: '' }
	}), /名称和值都需要填写/);
	assert.throws(() => applyApiKeyAuth({
		url: 'https://example.test/', headers: [], auth: { type: 'apiKey', key: 'Bad Header', value: 'secret' }
	}), /Header 名称/);
});

test('secret variable usage includes indirect references and stored credential fields', async () => {
	const {
		normalizeEnvironment,
		requestContainsStoredSecrets,
		requestUsesSecretVariables
	} = await import('../src/utils/workspaceModel.mjs');
	const environment = normalizeEnvironment({ name: 'dev', variables: [
		{ key: 'token', value: 'value', secret: true },
		{ key: 'auth', value: 'Bearer {{token}}' }
	] });
	assert.equal(requestUsesSecretVariables({ url: 'https://example.test', headers: [{ value: '{{auth}}' }] }, environment), true);
	assert.equal(requestContainsStoredSecrets({ auth: { type: 'bearer' }, headers: [] }), true);
	assert.equal(requestContainsStoredSecrets({ auth: { type: 'apiKey' }, headers: [] }), true);
	assert.equal(requestContainsStoredSecrets({ auth: { type: 'none' }, headers: [{ key: 'X-API-Key' }] }), true);
});
