import { isSensitiveHeaderName } from './headerSecurity.mjs';
import { normalizeEditorRows } from './requestEditor.mjs';
import { normalizeRedirectSettings } from './responseDiagnostics.mjs';

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const BODY_TYPES = new Set(['none', 'raw', 'json', 'urlencoded', 'multipart']);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const TEMPLATE_TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
const MAX_NAME_LENGTH = 80;
const MAX_URL_LENGTH = 8192;
const MAX_VALUE_LENGTH = 16384;
const MAX_BODY_LENGTH = 1024 * 1024;
const MAX_VARIABLES = 100;
const MAX_ROWS = 500;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export class WorkspaceValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'WorkspaceValidationError';
	}
}

function requiredText(value, label, maxLength = MAX_NAME_LENGTH) {
	const text = String(value ?? '').trim();
	if (!text) throw new WorkspaceValidationError(`${label}不能为空。`);
	if (text.length > maxLength) throw new WorkspaceValidationError(`${label}不能超过 ${maxLength} 个字符。`);
	return text;
}

function boundedText(value, label, maxLength = MAX_VALUE_LENGTH) {
	const text = String(value ?? '');
	if (text.length > maxLength) throw new WorkspaceValidationError(`${label}不能超过 ${maxLength} 个字符。`);
	return text;
}

export function createWorkspaceId(prefix = 'item') {
	const random = globalThis.crypto?.randomUUID?.()
		|| `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return `${prefix}-${random}`;
}

export function createVariable(overrides = {}) {
	return {
		id: String(overrides.id || createWorkspaceId('var')),
		key: String(overrides.key ?? ''),
		value: String(overrides.value ?? ''),
		enabled: overrides.enabled !== false,
		secret: overrides.secret === true
	};
}

export function normalizeEnvironment(value = {}) {
	const variables = (Array.isArray(value.variables) ? value.variables : [])
		.filter(entry => entry && (
			String(entry.key ?? '').trim()
			|| String(entry.value ?? '')
			|| entry.secret === true
		));
	if (variables.length > MAX_VARIABLES) {
		throw new WorkspaceValidationError(`单个环境最多包含 ${MAX_VARIABLES} 个变量。`);
	}
	const normalizedVariables = variables.map((entry, index) => {
		const variable = createVariable(entry);
		variable.key = requiredText(variable.key, `第 ${index + 1} 个变量名`, 64);
		if (!VARIABLE_NAME.test(variable.key)) {
			throw new WorkspaceValidationError(`变量 ${variable.key} 只能使用字母、数字、_、.、-，且不能以数字开头。`);
		}
		variable.value = boundedText(variable.value, `变量 ${variable.key} 的值`);
		return variable;
	});
	const activeKeys = normalizedVariables.filter(entry => entry.enabled).map(entry => entry.key);
	if (new Set(activeKeys).size !== activeKeys.length) {
		throw new WorkspaceValidationError('启用的环境变量名不能重复。');
	}
	const now = Date.now();
	return {
		id: String(value.id || createWorkspaceId('env')),
		name: requiredText(value.name, '环境名称'),
		scope: value.scope === 'session' ? 'session' : 'persistent',
		variables: normalizedVariables,
		createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now,
		updatedAt: now
	};
}

export function normalizeFolder(value = {}) {
	const now = Date.now();
	return {
		id: String(value.id || createWorkspaceId('folder')),
		name: requiredText(value.name, 'Folder 名称'),
		createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now,
		updatedAt: now
	};
}

function normalizeRows(rows, label, limit = MAX_ROWS) {
	if (Array.isArray(rows) && rows.length > limit) {
		throw new WorkspaceValidationError(`${label}最多包含 ${limit} 行。`);
	}
	return normalizeEditorRows(rows, { ensureEmptyRow: false }).map((row, index) => ({
		enabled: row.enabled,
		key: boundedText(row.key, `${label}第 ${index + 1} 行 Key`, 256),
		value: boundedText(row.value, `${label}第 ${index + 1} 行 Value`)
	}));
}

export function normalizeRequestBody(body = {}) {
	const type = BODY_TYPES.has(body.type) ? body.type : 'none';
	if (type === 'raw') return {
		type,
		text: boundedText(body.text, 'Raw Body', MAX_BODY_LENGTH),
		contentType: boundedText(body.contentType || 'text/plain;charset=utf-8', 'Content-Type', 256)
	};
	if (type === 'json') return { type, text: boundedText(body.text, 'JSON Body', MAX_BODY_LENGTH) };
	if (type === 'urlencoded') return { type, rows: normalizeRows(body.rows, 'URL 编码 Body') };
	if (type === 'multipart') {
		if (Array.isArray(body.rows) && body.rows.length > MAX_ROWS) {
			throw new WorkspaceValidationError(`multipart Body 最多包含 ${MAX_ROWS} 行。`);
		}
		return {
			type,
			rows: (Array.isArray(body.rows) ? body.rows : []).map((row, index) => ({
				enabled: row?.enabled !== false,
				key: boundedText(row?.key, `multipart 第 ${index + 1} 行 Key`, 256),
				kind: row?.kind === 'file' ? 'file' : 'text',
				value: row?.kind === 'file' ? '' : boundedText(row?.value, `multipart 第 ${index + 1} 行 Value`),
				file: null,
				fileName: row?.kind === 'file' ? boundedText(row?.file?.name || row?.fileName, '文件名', 512) : '',
				filePath: ''
			}))
		};
	}
	return { type: 'none' };
}

function normalizeAuth(auth = {}) {
	if (auth.type === 'basic') return {
		type: 'basic',
		username: boundedText(auth.username, 'Basic Auth Username'),
		password: boundedText(auth.password, 'Basic Auth Password')
	};
	if (auth.type === 'bearer') return {
		type: 'bearer',
		token: boundedText(auth.token, 'Bearer Token')
	};
	if (auth.type === 'apiKey') return {
		type: 'apiKey',
		key: boundedText(auth.key, 'API Key 名称', 256),
		value: boundedText(auth.value, 'API Key 值'),
		addTo: auth.addTo === 'query' ? 'query' : 'header'
	};
	return { type: 'none' };
}

export function normalizeSavedRequest(value = {}) {
	const method = String(value.method || 'GET').toUpperCase();
	if (!METHODS.has(method)) throw new WorkspaceValidationError('Saved Request 的 HTTP Method 不受支持。');
	const now = Date.now();
	return {
		id: String(value.id || createWorkspaceId('request')),
		folderId: value.folderId ? String(value.folderId) : null,
		name: requiredText(value.name, 'Saved Request 名称'),
		method,
		url: boundedText(value.url, '请求 URL', MAX_URL_LENGTH),
		params: normalizeRows(value.params, 'Params'),
		headers: normalizeRows(value.headers, 'Headers', 100),
		body: normalizeRequestBody(value.body),
		auth: normalizeAuth(value.auth),
		redirect: normalizeRedirectSettings(value.redirect),
		createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now,
		updatedAt: now
	};
}

function environmentRows(environment) {
	return normalizeEnvironment(environment).variables.filter(entry => entry.enabled);
}

function createResolver(environment) {
	const rows = environment ? environmentRows(environment) : [];
	const byKey = new Map(rows.map(row => [row.key, row]));
	const cache = new Map();

	function resolveVariable(key, stack = []) {
		if (cache.has(key)) return cache.get(key);
		const row = byKey.get(key);
		if (!row) throw new WorkspaceValidationError(`未找到已启用的环境变量：${key}`);
		if (stack.includes(key)) {
			throw new WorkspaceValidationError(`环境变量存在循环引用：${[...stack, key].join(' → ')}`);
		}
		const resolved = resolveString(row.value, [...stack, key]);
		cache.set(key, resolved);
		return resolved;
	}

	function resolveString(value, stack = []) {
		const source = String(value ?? '');
		const output = source.replace(TEMPLATE_TOKEN, (_match, key) => resolveVariable(key, stack));
		if (output.includes('{{') || output.includes('}}')) {
			throw new WorkspaceValidationError('模板包含无效或未闭合的环境变量。');
		}
		return output;
	}

	return { byKey, resolveString };
}

export function resolveTemplate(value, environment) {
	return createResolver(environment).resolveString(value);
}

function resolveRows(rows, resolver) {
	return normalizeEditorRows(rows, { ensureEmptyRow: false }).map(row => ({
		...row,
		key: resolver.resolveString(row.key),
		value: resolver.resolveString(row.value)
	}));
}

export function resolveRequestDraft(draft = {}, environment = null) {
	const resolver = createResolver(environment);
	const body = normalizeRequestBody(draft.body);
	if (body.type === 'raw' || body.type === 'json') body.text = resolver.resolveString(body.text);
	if (body.type === 'raw') body.contentType = resolver.resolveString(body.contentType);
	if (body.type === 'urlencoded') body.rows = resolveRows(body.rows, resolver);
	if (body.type === 'multipart') {
		body.rows = body.rows.map((row, index) => ({
			...row,
			key: resolver.resolveString(row.key),
			value: row.kind === 'text' ? resolver.resolveString(row.value) : '',
			file: draft.body?.rows?.[index]?.file || null
		}));
	}
	const auth = normalizeAuth(draft.auth);
	if (auth.type === 'basic') {
		auth.username = resolver.resolveString(auth.username);
		auth.password = resolver.resolveString(auth.password);
	} else if (auth.type === 'bearer') {
		auth.token = resolver.resolveString(auth.token);
	} else if (auth.type === 'apiKey') {
		auth.key = resolver.resolveString(auth.key);
		auth.value = resolver.resolveString(auth.value);
	}
	return {
		method: String(draft.method || 'GET').toUpperCase(),
		url: resolver.resolveString(draft.url),
		params: resolveRows(draft.params, resolver),
		headers: resolveRows(draft.headers, resolver),
		body,
		auth,
		redirect: normalizeRedirectSettings(draft.redirect)
	};
}

export function applyApiKeyAuth(draft = {}) {
	const auth = normalizeAuth(draft.auth);
	const headers = normalizeEditorRows(draft.headers, { ensureEmptyRow: false });
	const output = { ...draft, headers, auth };
	if (auth.type !== 'apiKey') return output;

	const key = auth.key.trim();
	if (!key && !auth.value) return output;
	if (!key || !auth.value) {
		throw new WorkspaceValidationError('API Key 的名称和值都需要填写。');
	}

	if (auth.addTo === 'query') {
		let target;
		try {
			target = new URL(draft.url);
		} catch {
			throw new WorkspaceValidationError('添加 API Key 查询参数前，请先填写有效的 HTTP(S) URL。');
		}
		if (!['http:', 'https:'].includes(target.protocol)) {
			throw new WorkspaceValidationError('API Key 查询参数只能添加到 HTTP(S) URL。');
		}
		if (!target.searchParams.has(key)) target.searchParams.append(key, auth.value);
		return { ...output, url: target.href };
	}

	if (!HEADER_NAME_PATTERN.test(key)) {
		throw new WorkspaceValidationError('API Key 请求头名称不是有效的 HTTP Header 名称。');
	}
	const hasManualHeader = headers.some(row =>
		row.enabled !== false && row.key.trim().toLowerCase() === key.toLowerCase());
	if (!hasManualHeader) headers.push({ enabled: true, key, value: auth.value });
	return output;
}

export function buildAuthorizationHeader(auth = {}) {
	if (auth.type === 'bearer' && auth.token) return `Bearer ${auth.token}`;
	if (auth.type !== 'basic' || (!auth.username && !auth.password)) return '';
	const bytes = new TextEncoder().encode(`${auth.username || ''}:${auth.password || ''}`);
	let binary = '';
	bytes.forEach(byte => { binary += String.fromCharCode(byte); });
	return `Basic ${btoa(binary)}`;
}

function allStrings(value, output = []) {
	if (typeof value === 'string') output.push(value);
	else if (Array.isArray(value)) value.forEach(entry => allStrings(entry, output));
	else if (value && typeof value === 'object') {
		for (const [key, entry] of Object.entries(value)) {
			if (key !== 'file') allStrings(entry, output);
		}
	}
	return output;
}

export function requestUsesSecretVariables(draft, environment) {
	if (!environment) return false;
	const rows = environmentRows(environment);
	const byKey = new Map(rows.map(row => [row.key, row]));
	const secretMemo = new Map();
	function reachesSecret(key, stack = []) {
		if (secretMemo.has(key)) return secretMemo.get(key);
		const row = byKey.get(key);
		if (!row || stack.includes(key)) return false;
		const nested = [...row.value.matchAll(TEMPLATE_TOKEN)].map(match => match[1]);
		const result = row.secret || nested.some(name => reachesSecret(name, [...stack, key]));
		secretMemo.set(key, result);
		return result;
	}
	return allStrings(draft).some(text =>
		[...text.matchAll(TEMPLATE_TOKEN)].some(match => reachesSecret(match[1])));
}

export function requestContainsStoredSecrets(request) {
	if (request?.auth?.type && request.auth.type !== 'none') return true;
	return (request?.headers || []).some(row => row?.enabled !== false && isSensitiveHeaderName(row?.key));
}
