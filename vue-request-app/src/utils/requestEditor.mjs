export function createEditorRow(overrides = {}) {
	return {
		enabled: overrides.enabled !== false,
		key: String(overrides.key ?? ''),
		value: String(overrides.value ?? '')
	};
}

export function normalizeEditorRows(rows, { ensureEmptyRow = true } = {}) {
	const normalized = Array.isArray(rows)
		? rows
			.filter((row) => row && typeof row === 'object')
			.map((row) => createEditorRow(row))
		: [];

	return normalized.length || !ensureEmptyRow ? normalized : [createEditorRow()];
}

export function parseEditorRows(value) {
	if (!value) return [createEditorRow()];

	try {
		return normalizeEditorRows(JSON.parse(value));
	} catch {
		return [createEditorRow()];
	}
}

export function activeEditorRows(rows) {
	return normalizeEditorRows(rows, { ensureEmptyRow: false })
		.filter((row) => row.enabled && row.key);
}

export function appendQueryRows(rawUrl, rows) {
	const target = new URL(rawUrl);
	target.hash = '';
	activeEditorRows(rows).forEach(({ key, value }) => {
		target.searchParams.append(key, value);
	});
	return target.href;
}

export function serializeEditorRows(rows) {
	const activeRows = activeEditorRows(rows);
	return activeRows.length ? JSON.stringify(activeRows) : '';
}

export function editorRowsToHeaders(rows) {
	return activeEditorRows(rows).reduce((headers, { key, value }) => {
		headers[key] = value;
		return headers;
	}, {});
}
