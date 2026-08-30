import { activeEditorRows, createEditorRow, normalizeEditorRows } from './requestEditor.mjs';
import { isSensitiveHeaderName } from './headerSecurity.mjs';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HTTP_METHOD = /^[A-Z][A-Z0-9._-]*$/;
const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

function importError(message) {
	const error = new Error(message);
	error.name = 'CurlImportError';
	return error;
}

export function tokenizeCurl(input) {
	const source = String(input ?? '').trim();
	if (!source) throw importError('请输入 cURL 命令。');

	const tokens = [];
	let token = '';
	let tokenStarted = false;
	let quote = null;

	const pushToken = () => {
		if (tokenStarted) tokens.push(token);
		token = '';
		tokenStarted = false;
	};

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];

		if (quote === "'") {
			if (char === "'") quote = null;
			else token += char;
			continue;
		}

		if (quote === '"') {
			if (char === '"') {
				quote = null;
			} else if (char === '\\') {
				if (next === '\n') {
					index += 1;
				} else if (next === '\r' && source[index + 2] === '\n') {
					index += 2;
				} else if (['"', '\\', '$', '`'].includes(next)) {
					token += next;
					index += 1;
				} else {
					token += char;
				}
			} else if (char === '`' || (char === '$' && next === '(')) {
				throw importError('不支持 Shell 命令替换；请先将动态内容替换为普通文本。');
			} else {
				token += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			tokenStarted = true;
			continue;
		}

		if (char === '\\') {
			if (next === '\n') {
				index += 1;
			} else if (next === '\r' && source[index + 2] === '\n') {
				index += 2;
			} else if (next !== undefined) {
				tokenStarted = true;
				token += next;
				index += 1;
			} else {
				throw importError('cURL 命令以不完整的转义符结尾。');
			}
			continue;
		}

		if (/\s/.test(char)) {
			if (char === '\n' || char === '\r') {
				throw importError('多行 cURL 命令必须使用反斜杠续行。');
			}
			pushToken();
			continue;
		}

		if (char === '`' || (char === '$' && next === '(')) {
			throw importError('不支持 Shell 命令替换；Import 只接受静态 cURL 文本。');
		}

		if ([';', '|', '&', '>', '<'].includes(char)) {
			throw importError(`不支持 Shell 控制符 ${char}；Import 不会执行或拼接命令。`);
		}

		tokenStarted = true;
		token += char;
	}

	if (quote) throw importError('cURL 命令包含未闭合的引号。');
	pushToken();
	return tokens;
}

function optionValue(tokens, index, option, inlineValue) {
	if (inlineValue !== undefined) {
		return { value: inlineValue, nextIndex: index };
	}
	if (index + 1 >= tokens.length) throw importError(`${option} 缺少参数。`);
	return { value: tokens[index + 1], nextIndex: index + 1 };
}

function parseHeader(value) {
	const separator = value.indexOf(':');
	if (separator <= 0) throw importError(`请求头格式无效：${value}`);
	return createEditorRow({
		key: value.slice(0, separator).trim(),
		value: value.slice(separator + 1).trimStart()
	});
}

function parseBasicAuth(value) {
	const separator = value.indexOf(':');
	return {
		type: 'basic',
		username: separator < 0 ? value : value.slice(0, separator),
		password: separator < 0 ? '' : value.slice(separator + 1)
	};
}

function parseFormRow(value, warnings) {
	const separator = value.indexOf('=');
	if (separator <= 0) throw importError(`multipart 字段格式无效：${value}`);
	const key = value.slice(0, separator);
	const fieldValue = value.slice(separator + 1);

	if (fieldValue.startsWith('@') || fieldValue.startsWith('<')) {
		const filePath = fieldValue.slice(1);
		const fileName = filePath.split(/[\\/]/).pop() || filePath;
		warnings.push(`文件 ${filePath} 仅作为占位符导入，请在发送前重新选择本地文件。`);
		return {
			enabled: true,
			key,
			kind: 'file',
			value: '',
			file: null,
			fileName,
			filePath
		};
	}

	return {
		enabled: true,
		key,
		kind: 'text',
		value: fieldValue,
		file: null,
		fileName: '',
		filePath: ''
	};
}

function contentType(headers) {
	return headers.find(({ key }) => key.toLowerCase() === 'content-type')?.value.toLowerCase() || '';
}

function parseUrlencodedBody(text) {
	return Array.from(new URLSearchParams(text).entries()).map(([key, value]) => createEditorRow({ key, value }));
}

function validateImportedUrl(rawUrl) {
	if (!rawUrl) throw importError('cURL 命令中没有找到 URL。');
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw importError('cURL URL 格式无效。');
	}
	if (!SAFE_PROTOCOLS.has(parsed.protocol)) throw importError('cURL Import 仅支持 HTTP 和 HTTPS URL。');
	if (parsed.username || parsed.password) throw importError('URL 不得内嵌凭据；请使用 --user 或 Authorization 请求头。');
	return parsed.href;
}

export function parseCurl(input) {
	const tokens = tokenizeCurl(input);
	if (!tokens.length || !/^curl(?:\.exe)?$/i.test(tokens[0])) {
		throw importError('命令必须以 curl 开头。');
	}

	let method = '';
	let rawUrl = '';
	let auth = { type: 'none' };
	let forceGet = false;
	const headers = [];
	const dataParts = [];
	const formRows = [];
	const warnings = [];

	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		let option = token;
		let inlineValue;
		if (token.startsWith('--') && token.includes('=')) {
			const separator = token.indexOf('=');
			option = token.slice(0, separator);
			inlineValue = token.slice(separator + 1);
		}

		const shortOption = /^(-[XHduF])(.*)$/.exec(token);
		if (shortOption && shortOption[2]) {
			option = shortOption[1];
			inlineValue = shortOption[2];
		}

		if (['-X', '--request'].includes(option)) {
			const result = optionValue(tokens, index, option, inlineValue);
			method = result.value.toUpperCase();
			index = result.nextIndex;
			if (!HTTP_METHOD.test(method)) throw importError('HTTP Method 格式无效。');
		} else if (['-H', '--header'].includes(option)) {
			const result = optionValue(tokens, index, option, inlineValue);
			headers.push(parseHeader(result.value));
			index = result.nextIndex;
		} else if (['-d', '--data', '--data-raw', '--data-binary'].includes(option)) {
			const result = optionValue(tokens, index, option, inlineValue);
			dataParts.push(result.value);
			if (['-d', '--data', '--data-binary'].includes(option) && result.value.startsWith('@')) {
				warnings.push(`${result.value} 不会读取本地文件，已作为字面文本导入。`);
			}
			index = result.nextIndex;
		} else if (['-u', '--user'].includes(option)) {
			const result = optionValue(tokens, index, option, inlineValue);
			auth = parseBasicAuth(result.value);
			index = result.nextIndex;
		} else if (['-F', '--form'].includes(option)) {
			const result = optionValue(tokens, index, option, inlineValue);
			formRows.push(parseFormRow(result.value, warnings));
			index = result.nextIndex;
		} else if (option === '--url') {
			const result = optionValue(tokens, index, option, inlineValue);
			rawUrl = result.value;
			index = result.nextIndex;
		} else if (['-G', '--get'].includes(option)) {
			forceGet = true;
		} else if (['-L', '--location', '-s', '--silent', '--compressed', '-k', '--insecure'].includes(option)) {
			warnings.push(`已忽略 cURL 传输选项 ${option}。`);
		} else if (token.startsWith('-')) {
			throw importError(`暂不支持 cURL 选项 ${token}。`);
		} else if (!rawUrl) {
			rawUrl = token;
		} else {
			throw importError(`发现多个位置参数：${token}`);
		}
	}

	const url = validateImportedUrl(rawUrl);
	if (!method) method = forceGet ? 'GET' : (dataParts.length || formRows.length ? 'POST' : 'GET');
	if (forceGet && dataParts.length) warnings.push('--get 的 data 参数暂按请求体导入，请确认请求语义。');
	if (!BODY_METHODS.has(method) && (dataParts.length || formRows.length)) {
		warnings.push(`${method} 请求体会保留在编辑器中，但当前发送器不会发送它。`);
	}

	let body = { type: 'none' };
	if (formRows.length) {
		body = { type: 'multipart', rows: formRows };
	} else if (dataParts.length) {
		const text = dataParts.join('&');
		const type = contentType(headers);
		if (type.includes('application/json')) body = { type: 'json', text };
		else if (type.includes('application/x-www-form-urlencoded')) {
			body = { type: 'urlencoded', rows: parseUrlencodedBody(text) };
		} else body = { type: 'raw', text, contentType: type || 'text/plain;charset=utf-8' };
	}

	return {
		method,
		url,
		headers: normalizeEditorRows(headers),
		auth,
		body,
		warnings
	};
}

export function quotePosixShell(value) {
	return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function hasHeader(headers, name) {
	return headers.some(({ key }) => key.toLowerCase() === name.toLowerCase());
}

function encodedRows(rows) {
	const params = new URLSearchParams();
	activeEditorRows(rows).forEach(({ key, value }) => params.append(key, value));
	return params.toString();
}

function normalizeMultipartRows(rows) {
	return Array.isArray(rows) ? rows.filter((row) => row && row.enabled !== false && row.key) : [];
}

export function exportCurl(request) {
	const method = String(request?.method || 'GET').toUpperCase();
	if (!HTTP_METHOD.test(method)) throw new Error('HTTP Method 格式无效。');
	const url = validateImportedUrl(request?.url);
	const headers = activeEditorRows(request?.headers || []);
	const body = request?.body || { type: 'none' };
	const tokens = ['curl', '--request', method, url];

	const exportHeaders = [...headers];
	if (body.type === 'json' && !hasHeader(exportHeaders, 'content-type')) {
		exportHeaders.push(createEditorRow({ key: 'Content-Type', value: 'application/json' }));
	} else if (body.type === 'raw' && body.contentType && !hasHeader(exportHeaders, 'content-type')) {
		exportHeaders.push(createEditorRow({ key: 'Content-Type', value: body.contentType }));
	} else if (body.type === 'urlencoded' && !hasHeader(exportHeaders, 'content-type')) {
		exportHeaders.push(createEditorRow({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }));
	}

	exportHeaders.forEach(({ key, value }) => tokens.push('--header', `${key}: ${value}`));

	const auth = request?.auth || { type: 'none' };
	if (auth.type === 'basic') {
		tokens.push('--user', `${auth.username || ''}:${auth.password || ''}`);
	} else if (auth.type === 'bearer' && !hasHeader(exportHeaders, 'authorization')) {
		tokens.push('--header', `Authorization: Bearer ${auth.token || ''}`);
	}

	if (body.type === 'json' || body.type === 'raw') {
		tokens.push('--data-raw', body.text || '');
	} else if (body.type === 'urlencoded') {
		tokens.push('--data-raw', encodedRows(body.rows));
	} else if (body.type === 'multipart') {
		normalizeMultipartRows(body.rows).forEach((row) => {
			const value = row.kind === 'file'
				? `@${row.filePath || row.fileName || 'select-file-before-running'}`
				: String(row.value ?? '');
			tokens.push('--form', `${row.key}=${value}`);
		});
	}

	const rendered = tokens.map((token, index) => index === 0 ? token : quotePosixShell(token));
	return `${rendered[0]} \\\n  ${rendered.slice(1).join(' \\\n  ')}`;
}

export function requestContainsSecrets(request) {
	const auth = request?.auth || { type: 'none' };
	if (auth.type !== 'none') return true;
	return activeEditorRows(request?.headers || []).some(({ key }) => isSensitiveHeaderName(key));
}

export function supportsRequestBody(method) {
	return BODY_METHODS.has(String(method || '').toUpperCase());
}
