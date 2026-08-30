import {
	normalizeEnvironment,
	normalizeFolder,
	normalizeSavedRequest
} from './workspaceModel.mjs';

export const WORKSPACE_DB_NAME = 'proxyweb-workspace';
export const WORKSPACE_DB_VERSION = 1;
export const SESSION_ENVIRONMENTS_KEY = 'proxyweb.workspace.session-environments.v1';

function requestResult(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
	});
}

function transactionDone(transaction) {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
		transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
	});
}

export function upgradeWorkspaceDatabase(database) {
	if (!database.objectStoreNames.contains('environments')) {
		database.createObjectStore('environments', { keyPath: 'id' });
	}
	if (!database.objectStoreNames.contains('folders')) {
		database.createObjectStore('folders', { keyPath: 'id' });
	}
	if (!database.objectStoreNames.contains('requests')) {
		const requests = database.createObjectStore('requests', { keyPath: 'id' });
		requests.createIndex('folderId', 'folderId', { unique: false });
	}
	if (!database.objectStoreNames.contains('meta')) {
		database.createObjectStore('meta', { keyPath: 'key' });
	}
}

export function openWorkspaceDatabase(indexedDBFactory = globalThis.indexedDB) {
	if (!indexedDBFactory?.open) return Promise.reject(new Error('当前浏览器不支持 IndexedDB。'));
	return new Promise((resolve, reject) => {
		const request = indexedDBFactory.open(WORKSPACE_DB_NAME, WORKSPACE_DB_VERSION);
		request.onupgradeneeded = () => upgradeWorkspaceDatabase(request.result);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error('无法打开工作区数据库。'));
		request.onblocked = () => reject(new Error('工作区数据库升级被其他页面阻塞，请关闭旧页面后重试。'));
	});
}

function safeSessionRead(storage) {
	try {
		const value = JSON.parse(storage?.getItem(SESSION_ENVIRONMENTS_KEY) || '[]');
		return Array.isArray(value) ? value.flatMap(entry => {
			try { return [{ ...normalizeEnvironment(entry), scope: 'session' }]; } catch { return []; }
		}) : [];
	} catch {
		return [];
	}
}

function sessionWrite(storage, environments) {
	if (!storage?.setItem) return false;
	storage.setItem(SESSION_ENVIRONMENTS_KEY, JSON.stringify(environments));
	return true;
}

export function createWorkspaceStore(options = {}) {
	let sessionStorage = options.sessionStorage;
	let indexedDBFactory = options.indexedDB;
	try {
		if (sessionStorage === undefined) sessionStorage = globalThis.sessionStorage;
	} catch {
		sessionStorage = null;
	}
	try {
		if (indexedDBFactory === undefined) indexedDBFactory = globalThis.indexedDB;
	} catch {
		indexedDBFactory = null;
	}
	let databasePromise;
	const database = () => databasePromise ||= openWorkspaceDatabase(indexedDBFactory);

	async function list(storeName, normalize) {
		const db = await database();
		const values = await requestResult(db.transaction(storeName).objectStore(storeName).getAll());
		return values.flatMap(value => {
			try { return [normalize(value)]; } catch { return []; }
		});
	}

	async function put(storeName, value) {
		const db = await database();
		const tx = db.transaction(storeName, 'readwrite');
		tx.objectStore(storeName).put(value);
		await transactionDone(tx);
		return value;
	}

	async function remove(storeName, id) {
		const db = await database();
		const tx = db.transaction(storeName, 'readwrite');
		tx.objectStore(storeName).delete(id);
		await transactionDone(tx);
	}

	return Object.freeze({
		async listEnvironments() {
			const persistent = await list('environments', normalizeEnvironment);
			const combined = new Map(persistent.map(environment => [environment.id, environment]));
			for (const environment of safeSessionRead(sessionStorage)) combined.set(environment.id, environment);
			return [...combined.values()]
				.sort((a, b) => a.name.localeCompare(b.name));
		},
		async putEnvironment(value) {
			const environment = normalizeEnvironment(value);
			const session = safeSessionRead(sessionStorage).filter(entry => entry.id !== environment.id);
			if (environment.scope === 'session') {
				if (!sessionWrite(sessionStorage, [...session, environment])) {
					throw new Error('当前浏览器不允许使用 Session Storage。');
				}
				await remove('environments', environment.id);
			} else {
				await put('environments', environment);
				sessionWrite(sessionStorage, session);
			}
			return environment;
		},
		async deleteEnvironment(id) {
			await remove('environments', id);
			sessionWrite(sessionStorage, safeSessionRead(sessionStorage).filter(entry => entry.id !== id));
		},
		listFolders: () => list('folders', normalizeFolder),
		putFolder: value => put('folders', normalizeFolder(value)),
		async deleteFolder(id) {
			const requests = await this.listRequests();
			await Promise.all(requests.filter(request => request.folderId === id)
				.map(request => this.putRequest({ ...request, folderId: null })));
			await remove('folders', id);
		},
		listRequests: () => list('requests', normalizeSavedRequest),
		putRequest: value => put('requests', normalizeSavedRequest(value)),
		deleteRequest: id => remove('requests', id),
		async getActiveEnvironmentId() {
			const db = await database();
			const value = await requestResult(db.transaction('meta').objectStore('meta').get('activeEnvironmentId'));
			return value?.value || '';
		},
		setActiveEnvironmentId(value) {
			return put('meta', { key: 'activeEnvironmentId', value: String(value || '') });
		}
	});
}

export function createMemoryWorkspaceStore() {
	const state = { environments: new Map(), folders: new Map(), requests: new Map(), active: '' };
	return Object.freeze({
		async listEnvironments() { return [...state.environments.values()]; },
		async putEnvironment(value) {
			const normalized = normalizeEnvironment(value);
			state.environments.set(normalized.id, normalized);
			return normalized;
		},
		async deleteEnvironment(id) { state.environments.delete(id); },
		async listFolders() { return [...state.folders.values()]; },
		async putFolder(value) {
			const normalized = normalizeFolder(value);
			state.folders.set(normalized.id, normalized);
			return normalized;
		},
		async deleteFolder(id) {
			state.folders.delete(id);
			for (const [key, request] of state.requests) {
				if (request.folderId === id) state.requests.set(key, normalizeSavedRequest({ ...request, folderId: null }));
			}
		},
		async listRequests() { return [...state.requests.values()]; },
		async putRequest(value) {
			const normalized = normalizeSavedRequest(value);
			state.requests.set(normalized.id, normalized);
			return normalized;
		},
		async deleteRequest(id) { state.requests.delete(id); },
		async getActiveEnvironmentId() { return state.active; },
		async setActiveEnvironmentId(value) { state.active = String(value || ''); }
	});
}
