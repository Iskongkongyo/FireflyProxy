import { buildProxyTransport, isSensitiveHeaderName } from './headerSecurity.mjs';
import { normalizeEditorRows } from './requestEditor.mjs';
import { applyRedirectSettings, normalizeRedirectSettings } from './responseDiagnostics.mjs';

function serializeShareRows(rows, { omitSensitive = false } = {}) {
	const normalized = normalizeEditorRows(rows, { ensureEmptyRow: false })
		.filter(row => row.key || row.value)
		.filter(row => !omitSensitive || !isSensitiveHeaderName(row.key));
	return normalized.length ? JSON.stringify(normalized) : '';
}

export function buildDirectApiLink({ apiBaseUrl, targetUrl, method = 'GET', redirect }) {
	if (String(method).toUpperCase() !== 'GET') {
		throw new Error('可直接访问的 API 链接只支持 GET；其他 Method 请使用 Copy as cURL。');
	}
	const transport = buildProxyTransport(apiBaseUrl, targetUrl);
	return applyRedirectSettings(transport.url, redirect);
}

export function buildRequestPageLink({ pageUrl, draft }) {
	const url = new URL(pageUrl);
	url.hash = '';
	url.search = '';
	const redirect = normalizeRedirectSettings(draft.redirect);
	url.searchParams.set('url', String(draft.url || ''));
	url.searchParams.set('method', String(draft.method || 'GET').toUpperCase());
	url.searchParams.set('params', serializeShareRows(draft.params));
	url.searchParams.set('headers', serializeShareRows(draft.headers, { omitSensitive: true }));
	url.searchParams.set('followRedirects', String(redirect.followRedirects));
	url.searchParams.set('maxRedirects', String(redirect.maxRedirects));
	url.searchParams.set('display', '0');
	return url.href;
}
