import { activeEditorRows } from './requestEditor.mjs';

const BODY_TYPES = new Set(['none', 'raw', 'json', 'urlencoded', 'multipart']);

export function buildRequestBody(draft = {}) {
	const type = BODY_TYPES.has(draft.type) ? draft.type : 'none';
	if (type === 'none') return { body: null, contentType: '', mode: type };
	if (type === 'raw') {
		return {
			body: String(draft.text ?? ''),
			contentType: String(draft.contentType || '').trim(),
			mode: type
		};
	}
	if (type === 'json') {
		const body = String(draft.text ?? '');
		try {
			JSON.parse(body);
		} catch {
			throw new Error('请先修正 JSON 语法。');
		}
		return { body, contentType: 'application/json;charset=utf-8', mode: type };
	}
	if (type === 'urlencoded') {
		const body = new URLSearchParams();
		activeEditorRows(draft.rows).forEach(({ key, value }) => body.append(key, value));
		return { body, contentType: 'application/x-www-form-urlencoded;charset=utf-8', mode: type };
	}

	const body = new FormData();
	const rows = Array.isArray(draft.rows) ? draft.rows : [];
	rows.filter((row) => row && row.enabled !== false && row.key).forEach((row) => {
		if (row.kind === 'file') {
			if (!row.file) throw new Error(`请为字段 ${row.key} 重新选择本地文件。`);
			body.append(String(row.key), row.file, row.file.name || row.fileName || 'upload');
		} else {
			body.append(String(row.key), String(row.value ?? ''));
		}
	});
	return { body, contentType: '', mode: type };
}
