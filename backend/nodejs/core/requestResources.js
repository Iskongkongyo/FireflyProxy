const { Transform } = require("node:stream");
const { ERROR_CODES, ProxyError } = require("./errors");

function requestBodyLimitError(maxBytes) {
    return new ProxyError(ERROR_CODES.REQUEST_BODY_LIMIT, "Request body exceeds the configured limit", {
        statusCode: 413,
        details: { maxBytes }
    });
}

function assertRequestBodyLength(headers, maxBytes) {
    const value = headers && headers["content-length"];
    if (value === undefined) return;

    const length = Number(value);
    if (Number.isFinite(length) && length > maxBytes) {
        throw requestBodyLimitError(maxBytes);
    }
}

function createLimitedRequestBody(source, maxBytes) {
    if (!source || typeof source.pipe !== "function") {
        throw new TypeError("Request body source must be a readable stream");
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
        throw new TypeError("Request body limit must be a positive integer");
    }

    let size = 0;
    const limiter = new Transform({
        transform(chunk, encoding, callback) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            size += buffer.length;
            if (size > maxBytes) return callback(requestBodyLimitError(maxBytes));
            callback(null, chunk);
        }
    });

    source.once("error", error => limiter.destroy(error));
    source.pipe(limiter);
    return limiter;
}

function createConcurrencyGate() {
    let active = 0;

    return Object.freeze({
        acquire(maxConcurrentRequests) {
            if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests <= 0) {
                throw new TypeError("Concurrent request limit must be a positive integer");
            }
            if (active >= maxConcurrentRequests) {
                throw new ProxyError(
                    ERROR_CODES.CONCURRENCY_LIMIT,
                    "Proxy concurrency limit reached",
                    { statusCode: 503, details: { maxConcurrentRequests } }
                );
            }

            active += 1;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                active -= 1;
            };
        },
        get active() {
            return active;
        }
    });
}

module.exports = {
    assertRequestBodyLength,
    createConcurrencyGate,
    createLimitedRequestBody,
    requestBodyLimitError
};
