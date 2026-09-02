const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Transform } = require("node:stream");
const { getHeader, normalizeHeaderName } = require("../core/headers");
const { normalizeHostnameRule } = require("../core/targetValidator");
const { responseTransformVersion } = require("./scopedResponseTransform");

const CACHE_MAGIC = Buffer.from("PWC1", "ascii");
const CACHE_HEADER_BYTES = 8;
const CACHE_FORMAT_VERSION = 1;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_VARY_HEADERS = 16;
const MAX_VARY_VALUE_BYTES = 4096;
const CACHE_FILE_PATTERN = /^([a-f0-9]{64})\.pwc$/;
const SENSITIVE_VARY_HEADER = /^(?:authorization|cookie2?|origin|referer|proxy-authorization|x-(?:fireflyproxy|proxyweb)-upstream-authorization|.*(?:token|password|passwd|secret|api[-_]?key).*)$/i;
const STATIC_APPLICATION_MEDIA_TYPES = new Set([
    "application/ecmascript",
    "application/javascript",
    "application/manifest+json",
    "application/wasm",
    "application/x-font-ttf",
    "application/x-javascript",
    "application/vnd.ms-fontobject"
]);

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function isPublicStaticMediaType(mediaType) {
    const normalized = String(mediaType || "").trim().toLowerCase();
    return normalized === "text/css"
        || normalized === "text/javascript"
        || normalized.startsWith("image/")
        || normalized.startsWith("font/")
        || STATIC_APPLICATION_MEDIA_TYPES.has(normalized);
}

function browserRepresentationVersion(config) {
    const browser = config?.browser || {};
    return sha256(JSON.stringify({
        rewriteHtml: Boolean(browser.rewriteHtml),
        rewriteCss: Boolean(browser.rewriteCss),
        responseTransform: responseTransformVersion(config),
        originIsolation: browser.originIsolation || null
    })).slice(0, 16);
}

function parseCacheControl(value) {
    const directives = new Map();
    const raw = Array.isArray(value) ? value.join(",") : String(value || "");
    for (const token of raw.split(",")) {
        const [rawName, ...rawValue] = token.trim().split("=");
        const name = rawName.toLowerCase();
        if (!name || directives.has(name)) continue;
        directives.set(name, rawValue.join("=").replace(/^"|"$/g, ""));
    }
    return directives;
}

function parseVary(value) {
    const raw = Array.isArray(value) ? value.join(",") : String(value || "");
    if (!raw.trim()) return { ok: true, names: [] };
    const names = [...new Set(raw.split(",").map(normalizeHeaderName).filter(Boolean))];
    if (
        names.includes("*")
        || names.length > MAX_VARY_HEADERS
        || names.some(name => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))
        || names.some(name => SENSITIVE_VARY_HEADER.test(name))
    ) {
        return { ok: false, names: [], reason: names.includes("*") ? "vary-star" : "vary-unsafe" };
    }
    return { ok: true, names };
}

function varyValues(names, headers) {
    const values = {};
    let totalBytes = 0;
    for (const name of names) {
        const raw = getHeader(headers, name);
        const value = Array.isArray(raw) ? raw.join(",") : String(raw || "");
        const bytes = Buffer.byteLength(value, "utf8");
        if (bytes > MAX_VARY_VALUE_BYTES || totalBytes + bytes > MAX_VARY_VALUE_BYTES * 2) {
            return null;
        }
        totalBytes += bytes;
        values[name] = value;
    }
    return values;
}

function evaluateCacheRequest({ mode, method, targetUrl, headers, config }) {
    const cacheConfig = config?.browser?.publicCache;
    if (!cacheConfig?.enabled) return { eligible: false, reason: "disabled" };
    if (mode !== "browser") return { eligible: false, reason: "mode" };
    const normalizedMethod = String(method || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(normalizedMethod)) return { eligible: false, reason: "method" };
    if (getHeader(headers, "authorization")) return { eligible: false, reason: "authorization" };
    if (getHeader(headers, "cookie")) return { eligible: false, reason: "cookie" };
    if (getHeader(headers, "range")) return { eligible: false, reason: "range" };
    for (const name of ["if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "if-range"]) {
        if (getHeader(headers, name)) return { eligible: false, reason: "conditional" };
    }
    const requestDirectives = parseCacheControl(getHeader(headers, "cache-control"));
    if (
        requestDirectives.has("no-cache")
        || requestDirectives.has("no-store")
        || requestDirectives.get("max-age") === "0"
    ) {
        return { eligible: false, reason: "request-cache-control" };
    }
    if (/(?:^|,)\s*no-cache\s*(?:,|$)/i.test(String(getHeader(headers, "pragma") || ""))) {
        return { eligible: false, reason: "request-cache-control" };
    }

    let target;
    try {
        target = new URL(targetUrl);
    } catch {
        return { eligible: false, reason: "target" };
    }
    const representationVersion = browserRepresentationVersion(config);
    const baseHash = sha256(JSON.stringify([target.href, "GET", representationVersion]));
    return {
        eligible: true,
        reason: "candidate",
        baseHash,
        method: normalizedMethod,
        representationVersion,
        targetHostname: target.hostname,
        targetPathname: target.pathname
    };
}

function cacheTtl(cacheControl, configuredTtlMs, initialAgeSeconds) {
    const initialAgeMs = initialAgeSeconds * 1000;
    for (const name of ["s-maxage", "max-age"]) {
        if (!cacheControl.has(name)) continue;
        const raw = cacheControl.get(name);
        if (!/^\d+$/.test(raw)) return 0;
        const seconds = Number(raw);
        if (!Number.isSafeInteger(seconds)) return 0;
        return Math.max(0, Math.min(configuredTtlMs, seconds * 1000 - initialAgeMs));
    }
    return configuredTtlMs;
}

function evaluateCacheResponse({ request, status, headers, classification, config }) {
    if (!request?.eligible) return { eligible: false, reason: request?.reason || "request" };
    if (request.method !== "GET") return { eligible: false, reason: "head-miss" };
    if (Number(status) !== 200) return { eligible: false, reason: "status" };
    if (!isPublicStaticMediaType(classification?.mediaType)) {
        return { eligible: false, reason: "media-type" };
    }
    if (classification?.mediaType === "text/event-stream") {
        return { eligible: false, reason: "sse" };
    }
    if (getHeader(headers, "set-cookie") !== undefined) {
        return { eligible: false, reason: "set-cookie" };
    }
    if (getHeader(headers, "content-range") || Number(status) === 206) {
        return { eligible: false, reason: "range" };
    }
    const disposition = String(getHeader(headers, "content-disposition") || "");
    if (/^\s*attachment(?:;|$)/i.test(disposition)) {
        return { eligible: false, reason: "attachment" };
    }

    const directives = parseCacheControl(getHeader(headers, "cache-control"));
    if (directives.has("private")) return { eligible: false, reason: "private" };
    if (directives.has("no-store")) return { eligible: false, reason: "no-store" };
    if (directives.has("no-cache")) return { eligible: false, reason: "no-cache" };
    if (!directives.has("public")) return { eligible: false, reason: "not-explicitly-public" };
    const rawAge = getHeader(headers, "age");
    const encodedAge = rawAge === undefined ? "0" : String(rawAge);
    if (!/^\d+$/.test(encodedAge)) return { eligible: false, reason: "age-invalid" };
    const initialAgeSeconds = Number(encodedAge);
    if (!Number.isSafeInteger(initialAgeSeconds)) return { eligible: false, reason: "age-invalid" };
    const ttlMs = cacheTtl(directives, config.browser.publicCache.ttlMs, initialAgeSeconds);
    if (ttlMs <= 0) return { eligible: false, reason: "zero-ttl" };

    const vary = parseVary(getHeader(headers, "vary"));
    if (!vary.ok) return { eligible: false, reason: vary.reason };
    const values = varyValues(vary.names, request.headers);
    if (!values) return { eligible: false, reason: "vary-too-large" };
    const contentLength = Number(getHeader(headers, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > config.browser.publicCache.maxObjectBytes) {
        return { eligible: false, reason: "object-too-large" };
    }
    return {
        eligible: true,
        reason: "store",
        ttlMs,
        initialAgeSeconds,
        vary: values,
        contentEncoding: String(classification?.contentEncoding || "identity")
    };
}

function cloneCacheHeaders(headers) {
    const result = {};
    for (const [name, value] of Object.entries(headers || {})) {
        const normalized = normalizeHeaderName(name);
        if (normalized === "set-cookie" || normalized === "x-proxyweb-cache") continue;
        if (typeof value === "string" || typeof value === "number" || Array.isArray(value)) {
            result[normalized] = value;
        }
    }
    return result;
}

function sameVary(left, right) {
    const leftNames = Object.keys(left || {}).sort();
    const rightNames = Object.keys(right || {}).sort();
    return leftNames.length === rightNames.length
        && leftNames.every((name, index) => name === rightNames[index] && left[name] === right[name]);
}

function entryMatchesRequest(entry, requestHeaders) {
    const current = varyValues(Object.keys(entry.vary || {}), requestHeaders);
    return current !== null && sameVary(entry.vary, current);
}

function validEntryMetadata(metadata, id, fileBytes) {
    return metadata
        && metadata.format === CACHE_FORMAT_VERSION
        && metadata.id === id
        && /^[a-f0-9]{64}$/.test(metadata.baseHash || "")
        && Number.isInteger(metadata.bodyBytes)
        && metadata.bodyBytes >= 0
        && Number.isFinite(metadata.expiresAt)
        && Number.isFinite(metadata.createdAt)
        && metadata.bodyHash?.match(/^[a-f0-9]{64}$/)
        && fileBytes === CACHE_HEADER_BYTES + metadata.metadataBytes + metadata.bodyBytes;
}

async function readCacheFile(filePath, id, includeBody = false) {
    const handle = await fs.open(filePath, "r");
    try {
        const stat = await handle.stat();
        const prefix = Buffer.alloc(CACHE_HEADER_BYTES);
        const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
        if (prefixRead.bytesRead !== prefix.length || !prefix.subarray(0, 4).equals(CACHE_MAGIC)) {
            throw new Error("Invalid cache file header");
        }
        const metadataBytes = prefix.readUInt32BE(4);
        if (metadataBytes <= 0 || metadataBytes > MAX_METADATA_BYTES) {
            throw new Error("Invalid cache metadata length");
        }
        const encodedMetadata = Buffer.alloc(metadataBytes);
        const metadataRead = await handle.read(encodedMetadata, 0, metadataBytes, CACHE_HEADER_BYTES);
        if (metadataRead.bytesRead !== metadataBytes) throw new Error("Incomplete cache metadata");
        const metadata = JSON.parse(encodedMetadata.toString("utf8"));
        metadata.metadataBytes = metadataBytes;
        if (!validEntryMetadata(metadata, id, stat.size)) throw new Error("Invalid cache metadata");
        if (!includeBody) return { metadata, fileBytes: stat.size };
        const body = Buffer.alloc(metadata.bodyBytes);
        const bodyRead = await handle.read(body, 0, body.length, CACHE_HEADER_BYTES + metadataBytes);
        if (bodyRead.bytesRead !== body.length || sha256(body) !== metadata.bodyHash) {
            throw new Error("Invalid cache body");
        }
        return { metadata, body, fileBytes: stat.size };
    } finally {
        await handle.close();
    }
}

function createPublicStaticCache(options = {}) {
    const directory = path.resolve(options.directory || ".fireflyproxy-cache");
    const logger = options.logger;
    const now = options.now || Date.now;
    const entries = new Map();
    const byBaseHash = new Map();
    const inFlight = new Map();
    const pendingWrites = new Set();
    let totalBytes = 0;
    let initPromise;
    let closed = false;
    let invalidationEpoch = 0;

    function entryPath(id) {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError("Invalid cache entry ID");
        return path.join(directory, `${id}.pwc`);
    }

    function addIndex(metadata, fileBytes) {
        entries.set(metadata.id, { ...metadata, fileBytes });
        if (!byBaseHash.has(metadata.baseHash)) byBaseHash.set(metadata.baseHash, new Set());
        byBaseHash.get(metadata.baseHash).add(metadata.id);
        totalBytes += fileBytes;
    }

    function removeIndex(id) {
        const entry = entries.get(id);
        if (!entry) return null;
        entries.delete(id);
        totalBytes -= entry.fileBytes;
        const group = byBaseHash.get(entry.baseHash);
        group?.delete(id);
        if (group?.size === 0) byBaseHash.delete(entry.baseHash);
        return entry;
    }

    async function removeEntry(id) {
        const entry = removeIndex(id);
        if (!entry) return false;
        await fs.rm(entryPath(id), { force: true }).catch(() => {});
        return true;
    }

    async function initialize() {
        if (initPromise) return initPromise;
        initPromise = (async () => {
            await fs.mkdir(directory, { recursive: true });
            const files = await fs.readdir(directory, { withFileTypes: true });
            for (const file of files) {
                if (!file.isFile()) continue;
                const match = CACHE_FILE_PATTERN.exec(file.name);
                if (!match) {
                    if (/^\.pwc-.*\.tmp$/.test(file.name)) {
                        await fs.rm(path.join(directory, file.name), { force: true }).catch(() => {});
                    }
                    continue;
                }
                try {
                    const loaded = await readCacheFile(path.join(directory, file.name), match[1]);
                    addIndex(loaded.metadata, loaded.fileBytes);
                } catch {
                    await fs.rm(path.join(directory, file.name), { force: true }).catch(() => {});
                }
            }
        })();
        return initPromise;
    }

    async function prune(config) {
        await initialize();
        const current = now();
        for (const entry of [...entries.values()]) {
            if (entry.expiresAt <= current) await removeEntry(entry.id);
        }
        const maxBytes = config.browser.publicCache.maxBytes;
        if (totalBytes <= maxBytes) return;
        const oldest = [...entries.values()].sort((left, right) => (
            (left.accessedAt || left.createdAt) - (right.accessedAt || right.createdAt)
        ));
        for (const entry of oldest) {
            if (totalBytes <= maxBytes) break;
            await removeEntry(entry.id);
        }
    }

    async function lookup(request, config) {
        if (!request?.eligible || closed) return null;
        await prune(config);
        const candidates = [...(byBaseHash.get(request.baseHash) || [])]
            .map(id => entries.get(id))
            .filter(Boolean)
            .filter(entry => entry.expiresAt > now() && entryMatchesRequest(entry, request.headers))
            .sort((left, right) => (right.createdAt - left.createdAt));
        for (const entry of candidates) {
            try {
                const loaded = await readCacheFile(entryPath(entry.id), entry.id, true);
                entry.accessedAt = now();
                return { metadata: entry, body: loaded.body };
            } catch {
                await removeEntry(entry.id);
            }
        }
        return null;
    }

    async function store({ request, response, body, config }) {
        if (closed || !response?.eligible) return { stored: false, reason: "closed" };
        if (request.cacheEpoch !== invalidationEpoch) return { stored: false, reason: "invalidated" };
        if (!Buffer.isBuffer(body)) throw new TypeError("Cache body must be a Buffer");
        if (body.length > config.browser.publicCache.maxObjectBytes) {
            return { stored: false, reason: "object-too-large" };
        }
        await initialize();
        const createdAt = now();
        const bodyHash = sha256(body);
        const id = sha256(JSON.stringify([
            request.baseHash,
            response.vary,
            response.contentEncoding,
            bodyHash,
            createdAt,
            randomBytes(8).toString("hex")
        ]));
        const metadata = {
            format: CACHE_FORMAT_VERSION,
            id,
            baseHash: request.baseHash,
            representationVersion: request.representationVersion,
            targetHostname: request.targetHostname,
            targetPathname: request.targetPathname,
            status: 200,
            headers: cloneCacheHeaders(response.headers),
            classification: response.classification,
            vary: response.vary,
            contentEncoding: response.contentEncoding,
            createdAt,
            accessedAt: createdAt,
            expiresAt: createdAt + response.ttlMs,
            initialAgeSeconds: response.initialAgeSeconds,
            bodyBytes: body.length,
            bodyHash
        };
        let encodedMetadata = Buffer.from(JSON.stringify(metadata), "utf8");
        if (encodedMetadata.length > MAX_METADATA_BYTES) {
            return { stored: false, reason: "metadata-too-large" };
        }
        const prefix = Buffer.alloc(CACHE_HEADER_BYTES);
        CACHE_MAGIC.copy(prefix);
        prefix.writeUInt32BE(encodedMetadata.length, 4);
        const file = Buffer.concat([prefix, encodedMetadata, body]);
        if (file.length > config.browser.publicCache.maxBytes) {
            return { stored: false, reason: "object-too-large" };
        }
        const temporary = path.join(
            directory,
            `.pwc-${process.pid}-${randomBytes(8).toString("hex")}.tmp`
        );
        try {
            await fs.writeFile(temporary, file, { flag: "wx", mode: 0o600 });
            if (request.cacheEpoch !== invalidationEpoch) {
                await fs.rm(temporary, { force: true });
                return { stored: false, reason: "invalidated" };
            }
            await fs.rename(temporary, entryPath(id));
            if (request.cacheEpoch !== invalidationEpoch) {
                await fs.rm(entryPath(id), { force: true });
                return { stored: false, reason: "invalidated" };
            }
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => {});
            throw error;
        }
        metadata.metadataBytes = encodedMetadata.length;
        addIndex(metadata, file.length);
        const duplicates = [...(byBaseHash.get(request.baseHash) || [])]
            .map(entryId => entries.get(entryId))
            .filter(entry => entry && entry.id !== id)
            .filter(entry => entry.contentEncoding === response.contentEncoding && sameVary(entry.vary, response.vary));
        for (const duplicate of duplicates) await removeEntry(duplicate.id);
        await prune(config);
        return { stored: entries.has(id), reason: entries.has(id) ? "stored" : "evicted" };
    }

    function acquire(baseHash) {
        const existing = inFlight.get(baseHash);
        if (existing) return { leader: false, promise: existing.promise };
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const flight = { promise, resolve };
        inFlight.set(baseHash, flight);
        let completed = false;
        return {
            leader: true,
            promise,
            complete(result) {
                if (completed) return;
                completed = true;
                if (inFlight.get(baseHash) === flight) inFlight.delete(baseHash);
                resolve(result);
            }
        };
    }

    function capture({ body, request, response, config, onComplete }) {
        let chunks = [];
        let size = 0;
        let done = false;
        let ended = false;
        const finish = result => {
            if (done) return;
            done = true;
            onComplete?.(result);
        };
        const captureStream = new Transform({
            transform(chunk, encoding, callback) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
                if (!done) {
                    if (size + buffer.length <= config.browser.publicCache.maxObjectBytes) {
                        chunks.push(Buffer.from(buffer));
                        size += buffer.length;
                    } else {
                        chunks = [];
                        size = 0;
                        finish({ stored: false, reason: "object-too-large" });
                    }
                }
                callback(null, chunk);
            },
            flush(callback) {
                ended = true;
                if (!done) {
                    const captured = Buffer.concat(chunks, size);
                    const pending = store({ request, response, body: captured, config })
                        .then(finish)
                        .catch(error => {
                            logger?.warn("[PublicCache] Unable to store cache entry", { error });
                            finish({ stored: false, reason: "write-failed" });
                        })
                        .finally(() => pendingWrites.delete(pending));
                    pendingWrites.add(pending);
                }
                callback();
            },
            destroy(error, callback) {
                if (!ended) finish({ stored: false, reason: error ? "stream-error" : "stream-incomplete" });
                callback(error);
            }
        });
        body.once("error", error => captureStream.destroy(error));
        body.pipe(captureStream);
        return captureStream;
    }

    async function invalidate(scope = {}) {
        invalidationEpoch += 1;
        await initialize();
        if (!scope.all && !scope.hostname) {
            throw new TypeError("Cache invalidation requires all=true or an exact hostname");
        }
        const hostname = scope.hostname ? normalizeHostnameRule(scope.hostname) : null;
        if (scope.hostname && (!hostname || hostname.startsWith("*."))) {
            throw new TypeError("Cache invalidation hostname must be exact");
        }
        const pathPrefix = scope.pathPrefix || "/";
        if (!pathPrefix.startsWith("/") || /[?#\u0000-\u001f\u007f]/.test(pathPrefix)) {
            throw new TypeError("Cache invalidation pathPrefix must be an absolute path prefix");
        }
        let removed = 0;
        for (const entry of [...entries.values()]) {
            if (
                scope.all
                || (entry.targetHostname === hostname && entry.targetPathname.startsWith(pathPrefix))
            ) {
                if (await removeEntry(entry.id)) removed += 1;
            }
        }
        return { removed };
    }

    async function stats(config) {
        await prune(config);
        return { entries: entries.size, totalBytes, maxBytes: config.browser.publicCache.maxBytes };
    }

    return Object.freeze({
        directory,
        prepareRequest(input) {
            const result = evaluateCacheRequest(input);
            return result.eligible
                ? { ...result, headers: input.headers, cacheEpoch: invalidationEpoch }
                : result;
        },
        evaluateResponse: evaluateCacheResponse,
        lookup,
        acquire,
        capture,
        invalidate,
        stats,
        async close() {
            closed = true;
            for (const flight of inFlight.values()) flight.resolve({ stored: false, reason: "closed" });
            inFlight.clear();
            await Promise.allSettled([...pendingWrites]);
        }
    });
}

module.exports = {
    CACHE_FORMAT_VERSION,
    browserRepresentationVersion,
    createPublicStaticCache,
    evaluateCacheRequest,
    evaluateCacheResponse,
    isPublicStaticMediaType,
    parseCacheControl,
    parseVary,
    varyValues
};
