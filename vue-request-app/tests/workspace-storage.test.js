const test = require('node:test');
const assert = require('node:assert/strict');

test('memory workspace store persists environments, folders and requests', async () => {
	const { createMemoryWorkspaceStore } = await import('../src/utils/workspaceStorage.mjs');
	const store = createMemoryWorkspaceStore();
	const environment = await store.putEnvironment({ name: 'Development', variables: [{ key: 'baseUrl', value: 'https://dev.test' }] });
	const folder = await store.putFolder({ name: 'Users' });
	const request = await store.putRequest({
		name: 'List users', folderId: folder.id, method: 'GET', url: '{{baseUrl}}/users',
		headers: [], body: { type: 'none' }, auth: { type: 'none' }
	});
	await store.setActiveEnvironmentId(environment.id);
	assert.equal((await store.listEnvironments())[0].name, 'Development');
	assert.equal((await store.listRequests())[0].folderId, folder.id);
	assert.equal(await store.getActiveEnvironmentId(), environment.id);

	await store.deleteFolder(folder.id);
	assert.equal((await store.listRequests())[0].folderId, null);
	await store.deleteRequest(request.id);
	assert.equal((await store.listRequests()).length, 0);
});

test('IndexedDB upgrade creates bounded workspace stores and request index', async () => {
	const { upgradeWorkspaceDatabase } = await import('../src/utils/workspaceStorage.mjs');
	const names = new Set();
	const indexes = [];
	const database = {
		objectStoreNames: { contains: name => names.has(name) },
		createObjectStore(name, options) {
			names.add(name);
			assert.deepEqual(options, { keyPath: name === 'meta' ? 'key' : 'id' });
			return { createIndex: (...args) => indexes.push(args) };
		}
	};
	upgradeWorkspaceDatabase(database);
	assert.deepEqual([...names], ['environments', 'folders', 'requests', 'meta']);
	assert.deepEqual(indexes, [['folderId', 'folderId', { unique: false }]]);
});
