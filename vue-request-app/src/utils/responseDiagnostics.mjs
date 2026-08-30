export const DIAGNOSTIC_HEADERS = Object.freeze({
	finalUrl: 'x-proxyweb-final-url',
	redirectChain: 'x-proxyweb-redirect-chain',
	followRedirects: 'x-proxyweb-follow-redirects',
	maxRedirects: 'x-proxyweb-max-redirects',
	truncated: 'x-proxyweb-diagnostics-truncated'
});

const MAX_REDIRECTS = 20;
const MAX_ENCODED_HEADER_LENGTH = 8192;

export function normalizeRedirectSettings(value = {}, fallback = { followRedirects: true, maxRedirects: 5 }) {
	const followRedirects = typeof value.followRedirects === 'boolean'
		? value.followRedirects
		: String(value.followRedirects) === 'true'
			? true
			: String(value.followRedirects) === 'false'
				? false
				: fallback.followRedirects;
	const parsedMax = typeof value.maxRedirects === 'number'
		? value.maxRedirects
		: /^\d+$/.test(String(value.maxRedirects ?? '')) ? Number(value.maxRedirects) : NaN;
	return {
		followRedirects,
		maxRedirects: Number.isInteger(parsedMax) && parsedMax >= 0 && parsedMax <= MAX_REDIRECTS
			? parsedMax
			: fallback.maxRedirects
	};
}

export function applyRedirectSettings(rawUrl, settings) {
	const url = new URL(rawUrl);
	const normalized = normalizeRedirectSettings(settings);
	url.searchParams.set('followRedirects', String(normalized.followRedirects));
	url.searchParams.set('maxRedirects', String(normalized.maxRedirects));
	return url.href;
}

function getHeader(headers, name) {
	if (headers && typeof headers.get === 'function') return headers.get(name);
	const match = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
	return match?.[1];
}

export function decodeDiagnosticJson(value) {
	if (typeof value !== 'string' || !value || value.length > MAX_ENCODED_HEADER_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
		return undefined;
	}
	try {
		const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
}

function normalizeChain(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, MAX_REDIRECTS).flatMap((entry) => {
		if (!entry || !Number.isInteger(entry.status) || typeof entry.url !== 'string' || typeof entry.location !== 'string') {
			return [];
		}
		return [{
			status: entry.status,
			method: String(entry.method || 'GET').toUpperCase(),
			url: entry.url,
			location: entry.location,
			followed: entry.followed === true,
			validated: entry.validated === true
		}];
	});
}

export function parseResponseDiagnostics(headers, fallbackUrl = '') {
	const finalUrl = decodeDiagnosticJson(getHeader(headers, DIAGNOSTIC_HEADERS.finalUrl));
	const redirectChain = normalizeChain(decodeDiagnosticJson(getHeader(headers, DIAGNOSTIC_HEADERS.redirectChain)));
	const maxRedirects = Number(getHeader(headers, DIAGNOSTIC_HEADERS.maxRedirects));
	return {
		finalUrl: typeof finalUrl === 'string' ? finalUrl : fallbackUrl,
		redirectChain,
		followRedirects: getHeader(headers, DIAGNOSTIC_HEADERS.followRedirects) === 'true',
		maxRedirects: Number.isInteger(maxRedirects) && maxRedirects >= 0 ? maxRedirects : null,
		truncated: getHeader(headers, DIAGNOSTIC_HEADERS.truncated) === 'true'
	};
}

export function responseByteLength(value) {
	if (value == null) return 0;
	if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (ArrayBuffer.isView(value)) return value.byteLength;
	try {
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		return new TextEncoder().encode(text).byteLength;
	} catch {
		return 0;
	}
}

export function elapsedMilliseconds(start, end) {
	const duration = Number(end) - Number(start);
	return Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 10) / 10 : 0;
}
