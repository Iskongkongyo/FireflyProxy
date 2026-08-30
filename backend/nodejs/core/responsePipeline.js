const { Readable } = require("node:stream");
const { promisify } = require("node:util");
const {
    brotliCompress,
    createBrotliDecompress,
    createGunzip,
    createInflate,
    deflate,
    gzip
} = require("node:zlib");
const { ERROR_CODES, ProxyError } = require("./errors");
const { getHeader, normalizeHeaderName } = require("./headers");

const gzipAsync = promisify(gzip);
const deflateAsync = promisify(deflate);
const brotliCompressAsync = promisify(brotliCompress);
const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const STREAMING_MEDIA_TYPES = new Set([
    "application/octet-stream",
    "application/pdf",
    "text/event-stream"
]);
const SUPPORTED_ENCODINGS = new Set(["identity", "gzip", "deflate", "br"]);

function cloneHeaders(headers) {
    return Object.fromEntries(Object.entries(headers || {}));
}

function deleteHeader(headers, targetName) {
    const normalizedTarget = normalizeHeaderName(targetName);
    for (const name of Object.keys(headers)) {
        if (normalizeHeaderName(name) === normalizedTarget) delete headers[name];
    }
}

function setHeader(headers, name, value) {
    deleteHeader(headers, name);
    headers[name] = value;
}

function parseContentType(value) {
    const raw = Array.isArray(value) ? value[0] : String(value || "");
    const [type = ""] = raw.split(";", 1);
    const mediaType = type.trim().toLowerCase();
    const charsetMatch = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(raw);
    return {
        raw,
        mediaType,
        charset: (charsetMatch?.[1] || charsetMatch?.[2] || "utf-8").trim().toLowerCase()
    };
}

function normalizeContentEncoding(value) {
    const encoding = Array.isArray(value) ? value.join(",") : String(value || "identity");
    return encoding.trim().toLowerCase() || "identity";
}

function hasResponseBody(method, status) {
    if (String(method || "GET").toUpperCase() === "HEAD") return false;
    return !((status >= 100 && status < 200) || [204, 205, 304].includes(status));
}

function classifyResponse({ mode, method, status, headers, config }) {
    const { mediaType, charset } = parseContentType(getHeader(headers, "content-type"));
    const contentEncoding = normalizeContentEncoding(getHeader(headers, "content-encoding"));
    const contentDisposition = String(getHeader(headers, "content-disposition") || "");
    const cacheControl = String(getHeader(headers, "cache-control") || "");

    if (!hasResponseBody(method, Number(status))) {
        return { kind: "stream", reason: "body-forbidden", mediaType, charset, contentEncoding };
    }
    if (mode !== "browser") {
        return { kind: "stream", reason: "mode-passthrough", mediaType, charset, contentEncoding };
    }
    if (
        Number(status) === 206
        || getHeader(headers, "content-range")
        || /^\s*attachment(?:;|$)/i.test(contentDisposition)
        || /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(cacheControl)
    ) {
        return { kind: "stream", reason: "http-passthrough", mediaType, charset, contentEncoding };
    }
    if (
        STREAMING_MEDIA_TYPES.has(mediaType)
        || mediaType.startsWith("video/")
        || mediaType.startsWith("audio/")
    ) {
        return { kind: "stream", reason: "streaming-media", mediaType, charset, contentEncoding };
    }
    if (HTML_MEDIA_TYPES.has(mediaType) && config.browser.rewriteHtml) {
        return { kind: "transform", reason: "html-rewrite", mediaType, charset, contentEncoding };
    }
    if (mediaType === "text/css" && config.browser.rewriteCss) {
        return { kind: "transform", reason: "css-rewrite", mediaType, charset, contentEncoding };
    }
    return { kind: "stream", reason: "content-passthrough", mediaType, charset, contentEncoding };
}

function createDecoder(encoding) {
    if (encoding === "gzip") return createGunzip();
    if (encoding === "deflate") return createInflate();
    if (encoding === "br") return createBrotliDecompress();
    return null;
}

async function encodeBody(body, encoding) {
    if (encoding === "gzip") return gzipAsync(body);
    if (encoding === "deflate") return deflateAsync(body);
    if (encoding === "br") return brotliCompressAsync(body);
    return body;
}

function rewriteContentTypeCharset(rawContentType) {
    const raw = String(rawContentType || "text/plain");
    const withoutCharset = raw
        .split(";")
        .filter((part, index) => index === 0 || !/^\s*charset\s*=/i.test(part))
        .join(";");
    return `${withoutCharset}; charset=utf-8`;
}

function rewriteLimitError(limit) {
    return new ProxyError(ERROR_CODES.REWRITE_LIMIT, "Response exceeds rewrite size limit", {
        statusCode: 413,
        details: { limit }
    });
}

async function collectLimited(stream, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limit) throw rewriteLimitError(limit);
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
}

function destroyTransformStreams(source, decoder) {
    if (decoder) {
        source.unpipe(decoder);
        if (!decoder.destroyed) decoder.destroy();
    }
    if (!source.destroyed) source.destroy();
}

async function prepareResponse(options) {
    const {
        body,
        headers,
        method,
        status,
        mode,
        config,
        targetUrl,
        transformText,
        logger,
        requestId
    } = options;
    const classification = classifyResponse({ mode, method, status, headers, config });
    const responseHeaders = cloneHeaders(headers);

    if (classification.kind !== "transform" || typeof transformText !== "function") {
        return {
            body,
            headers: responseHeaders,
            classification,
            transformed: false,
            preserveContentLength: true
        };
    }

    if (!SUPPORTED_ENCODINGS.has(classification.contentEncoding)) {
        logger?.warn("[ResponsePipeline] Unsupported content encoding; using stream passthrough", {
            requestId,
            contentEncoding: classification.contentEncoding,
            targetUrl
        });
        return {
            body,
            headers: responseHeaders,
            classification: { ...classification, kind: "stream", reason: "unsupported-encoding" },
            transformed: false,
            preserveContentLength: true
        };
    }

    let textDecoder;
    try {
        textDecoder = new TextDecoder(classification.charset);
    } catch {
        logger?.warn("[ResponsePipeline] Unsupported charset; using stream passthrough", {
            requestId,
            charset: classification.charset,
            targetUrl
        });
        return {
            body,
            headers: responseHeaders,
            classification: { ...classification, kind: "stream", reason: "unsupported-charset" },
            transformed: false,
            preserveContentLength: true
        };
    }

    const decoder = createDecoder(classification.contentEncoding);
    const decodedStream = decoder ? body.pipe(decoder) : body;
    try {
        const decodedBody = await collectLimited(decodedStream, config.security.maxRewriteBytes);
        const text = textDecoder.decode(decodedBody);
        const transformedText = await transformText({
            text,
            mediaType: classification.mediaType,
            targetUrl,
            headers: responseHeaders,
            config
        });
        if (typeof transformedText !== "string") {
            throw new TypeError("Response transformer must return a string");
        }

        const utf8Body = Buffer.from(transformedText, "utf8");
        const outputBody = await encodeBody(utf8Body, classification.contentEncoding);
        deleteHeader(responseHeaders, "content-length");
        deleteHeader(responseHeaders, "etag");
        deleteHeader(responseHeaders, "content-md5");
        if (classification.contentEncoding === "identity") {
            deleteHeader(responseHeaders, "content-encoding");
        }
        setHeader(
            responseHeaders,
            "content-type",
            rewriteContentTypeCharset(getHeader(responseHeaders, "content-type"))
        );
        logger?.info("[ResponsePipeline] Response transformed", {
            requestId,
            mediaType: classification.mediaType,
            contentEncoding: classification.contentEncoding,
            inputBytes: decodedBody.length,
            outputBytes: outputBody.length,
            targetUrl
        });
        return {
            body: Readable.from([outputBody]),
            headers: responseHeaders,
            classification,
            transformed: true,
            preserveContentLength: false
        };
    } catch (error) {
        destroyTransformStreams(body, decoder);
        if (error instanceof ProxyError) {
            logger?.warn("[ResponsePipeline] Rewrite size limit exceeded", {
                requestId,
                limit: config.security.maxRewriteBytes,
                targetUrl
            });
            throw error;
        }
        throw new ProxyError(ERROR_CODES.UPSTREAM_ERROR, "Upstream response transform failed", {
            statusCode: 502,
            cause: error
        });
    }
}

module.exports = {
    classifyResponse,
    collectLimited,
    parseContentType,
    prepareResponse,
    rewriteContentTypeCharset
};
