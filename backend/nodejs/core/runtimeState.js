const fs = require("node:fs");
const path = require("node:path");
const session = require("express-session");
const { CookieJar } = require("tough-cookie");
const { createSessionStateStore } = require("../browser-proxy/sessionStateStore");
const { ERROR_CODES, ProxyError } = require("./errors");
const {
    createOriginIsolationRegistry,
    isolatedProxyOrigin,
    isolationLabel,
    classifyProxyOrigin
} = require("./originIsolation");

const RUNTIME_STATE_SCHEMA_VERSION = 1;
const MAX_SESSION_JSON_BYTES = 1024 * 1024;
const MAX_COOKIE_JAR_JSON_BYTES = 4 * 1024 * 1024;

function runtimeStateUnavailable(error) {
    if (error instanceof ProxyError) return error;
    return new ProxyError(
        ERROR_CODES.RUNTIME_STATE_UNAVAILABLE,
        "Shared runtime state is temporarily unavailable",
        { statusCode: 503, cause: error }
    );
}

function sessionExpiry(value, fallbackMaxAgeMs, now = Date.now()) {
    const expires = value?.cookie?.expires;
    if (expires) {
        const timestamp = new Date(expires).getTime();
        if (Number.isFinite(timestamp)) return timestamp;
    }
    const originalMaxAge = Number(value?.cookie?.originalMaxAge);
    return now + (
        Number.isSafeInteger(originalMaxAge) && originalMaxAge > 0
            ? originalMaxAge
            : fallbackMaxAgeMs
    );
}

function encodeBoundedJson(value, maxBytes, label) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
        throw new RangeError(`${label} exceeds its serialized size limit`);
    }
    return encoded;
}

function transaction(database, operation) {
    database.exec("BEGIN IMMEDIATE");
    try {
        const result = operation();
        database.exec("COMMIT");
        return result;
    } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
    }
}

class SqliteExpressSessionStore extends session.Store {
    constructor({ database, maxAgeMs, now = Date.now }) {
        super();
        this.database = database;
        this.maxAgeMs = maxAgeMs;
        this.now = now;
        this.select = database.prepare(
            "SELECT payload, expires_at FROM express_sessions WHERE session_id = ?"
        );
        this.upsert = database.prepare(`
            INSERT INTO express_sessions(session_id, payload, expires_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                payload = excluded.payload,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at
        `);
        this.remove = database.prepare("DELETE FROM express_sessions WHERE session_id = ?");
        this.removeBrowser = database.prepare("DELETE FROM browser_sessions WHERE session_id = ?");
        this.removeExpired = database.prepare("DELETE FROM express_sessions WHERE expires_at <= ?");
        this.removeAll = database.prepare("DELETE FROM express_sessions");
        this.removeAllBrowser = database.prepare("DELETE FROM browser_sessions");
        this.count = database.prepare("SELECT COUNT(*) AS count FROM express_sessions WHERE expires_at > ?");
    }

    get(sessionId, callback) {
        try {
            const current = this.now();
            const row = this.select.get(sessionId);
            if (!row || row.expires_at <= current) {
                if (row) transaction(this.database, () => {
                    this.remove.run(sessionId);
                    this.removeBrowser.run(sessionId);
                });
                return callback(null, null);
            }
            return callback(null, JSON.parse(row.payload));
        } catch (error) {
            return callback(runtimeStateUnavailable(error));
        }
    }

    set(sessionId, value, callback = () => {}) {
        try {
            const current = this.now();
            const payload = encodeBoundedJson(value, MAX_SESSION_JSON_BYTES, "Express session");
            this.upsert.run(sessionId, payload, sessionExpiry(value, this.maxAgeMs, current), current);
            callback(null);
        } catch (error) {
            callback(runtimeStateUnavailable(error));
        }
    }

    touch(sessionId, value, callback = () => {}) {
        this.set(sessionId, value, callback);
    }

    destroy(sessionId, callback = () => {}) {
        try {
            transaction(this.database, () => {
                this.remove.run(sessionId);
                this.removeBrowser.run(sessionId);
            });
            callback(null);
        } catch (error) {
            callback(runtimeStateUnavailable(error));
        }
    }

    clear(callback = () => {}) {
        try {
            transaction(this.database, () => {
                this.removeAll.run();
                this.removeAllBrowser.run();
            });
            callback(null);
        } catch (error) {
            callback(runtimeStateUnavailable(error));
        }
    }

    length(callback) {
        try {
            const current = this.now();
            this.removeExpired.run(current);
            callback(null, Number(this.count.get(current).count));
        } catch (error) {
            callback(error);
        }
    }
}

function createSqliteBrowserSessionStore({ database, now = Date.now }) {
    const select = database.prepare(
        "SELECT jar_json, expires_at FROM browser_sessions WHERE session_id = ?"
    );
    const upsert = database.prepare(`
        INSERT INTO browser_sessions(session_id, jar_json, expires_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            jar_json = excluded.jar_json,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
    `);
    const touch = database.prepare(
        "UPDATE browser_sessions SET expires_at = ?, updated_at = ? WHERE session_id = ?"
    );
    const remove = database.prepare("DELETE FROM browser_sessions WHERE session_id = ?");
    const removeExpired = database.prepare("DELETE FROM browser_sessions WHERE expires_at <= ?");
    const removeAll = database.prepare("DELETE FROM browser_sessions");
    const count = database.prepare("SELECT COUNT(*) AS count FROM browser_sessions WHERE expires_at > ?");

    function emptyJarJson() {
        return encodeBoundedJson(new CookieJar().serializeSync(), MAX_COOKIE_JAR_JSON_BYTES, "Cookie Jar");
    }

    function loadJar(sessionId, current) {
        const row = select.get(sessionId);
        if (!row || row.expires_at <= current) return new CookieJar();
        return CookieJar.deserializeSync(JSON.parse(row.jar_json));
    }

    function validateSession(sessionId, maxAgeMs) {
        if (typeof sessionId !== "string" || !sessionId) {
            throw new TypeError("A non-empty FireflyProxy session ID is required");
        }
        if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
            throw new TypeError("Session state maxAgeMs must be a positive safe integer");
        }
    }

    async function get(sessionId, maxAgeMs) {
        try {
            validateSession(sessionId, maxAgeMs);
            const current = now();
            transaction(database, () => {
                removeExpired.run(current);
                const row = select.get(sessionId);
                if (row) touch.run(current + maxAgeMs, current, sessionId);
                else upsert.run(sessionId, emptyJarJson(), current + maxAgeMs, current);
            });
            return Object.freeze({
                async getCookieString(targetUrl) {
                    try {
                        return loadJar(sessionId, now()).getCookieStringSync(targetUrl);
                    } catch (error) {
                        throw runtimeStateUnavailable(error);
                    }
                },
                async storeResponseCookies(targetUrl, values, options = {}) {
                    try {
                        transaction(database, () => {
                            const writeTime = now();
                            const jar = loadJar(sessionId, writeTime);
                            for (const value of values) {
                                try {
                                    jar.setCookieSync(String(value), targetUrl, { ignoreError: true });
                                } catch (error) {
                                    options.logger?.warn("[Proxy] Rejected invalid upstream cookie", {
                                        requestId: options.requestId,
                                        targetOrigin: new URL(targetUrl).origin,
                                        error
                                    });
                                }
                            }
                            const jarJson = encodeBoundedJson(
                                jar.serializeSync(),
                                MAX_COOKIE_JAR_JSON_BYTES,
                                "Cookie Jar"
                            );
                            upsert.run(sessionId, jarJson, writeTime + maxAgeMs, writeTime);
                        });
                    } catch (error) {
                        throw runtimeStateUnavailable(error);
                    }
                }
            });
        } catch (error) {
            throw runtimeStateUnavailable(error);
        }
    }

    return Object.freeze({
        get,
        async delete(sessionId) {
            try {
                return Number(remove.run(sessionId).changes) > 0;
            } catch (error) {
                throw runtimeStateUnavailable(error);
            }
        },
        async clear() {
            try {
                removeAll.run();
            } catch (error) {
                throw runtimeStateUnavailable(error);
            }
        },
        get size() {
            try {
                const current = now();
                removeExpired.run(current);
                return Number(count.get(current).count);
            } catch (error) {
                throw runtimeStateUnavailable(error);
            }
        }
    });
}

function createSqliteOriginRegistry({ database, maxEntries = 4096, ttlMs, now = Date.now }) {
    const upsert = database.prepare(`
        INSERT INTO origin_labels(label, upstream_origin, expires_at, accessed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(label) DO UPDATE SET
            upstream_origin = excluded.upstream_origin,
            expires_at = excluded.expires_at,
            accessed_at = excluded.accessed_at
    `);
    const select = database.prepare(
        "SELECT upstream_origin, expires_at FROM origin_labels WHERE label = ?"
    );
    const touch = database.prepare(
        "UPDATE origin_labels SET expires_at = ?, accessed_at = ? WHERE label = ?"
    );
    const remove = database.prepare("DELETE FROM origin_labels WHERE label = ?");
    const removeExpired = database.prepare("DELETE FROM origin_labels WHERE expires_at <= ?");
    const trim = database.prepare(`
        DELETE FROM origin_labels WHERE label IN (
            SELECT label FROM origin_labels ORDER BY accessed_at ASC
            LIMIT MAX(0, (SELECT COUNT(*) FROM origin_labels) - ?)
        )
    `);
    const removeAll = database.prepare("DELETE FROM origin_labels");
    return Object.freeze({
        register(upstreamOrigin) {
            try {
                const label = isolationLabel(upstreamOrigin);
                const current = now();
                transaction(database, () => {
                    removeExpired.run(current);
                    upsert.run(label, upstreamOrigin, current + ttlMs, current);
                    trim.run(maxEntries);
                });
                return label;
            } catch (error) {
                throw runtimeStateUnavailable(error);
            }
        },
        resolve(proxyOrigin, isolation) {
            try {
                const classified = classifyProxyOrigin(proxyOrigin, isolation);
                if (classified?.scope !== "isolated") return null;
                const current = now();
                const row = select.get(classified.label);
                if (!row || row.expires_at <= current) {
                    if (row) remove.run(classified.label);
                    return null;
                }
                if (isolatedProxyOrigin(row.upstream_origin, isolation) !== proxyOrigin) return null;
                touch.run(current + ttlMs, current, classified.label);
                return row.upstream_origin;
            } catch (error) {
                throw runtimeStateUnavailable(error);
            }
        },
        clear() {
            try {
                removeAll.run();
            } catch (error) {
                throw runtimeStateUnavailable(error);
            }
        }
    });
}

function initializeDatabase(database) {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA foreign_keys = ON");
    const version = Number(database.prepare("PRAGMA user_version").get().user_version);
    if (version > RUNTIME_STATE_SCHEMA_VERSION) {
        throw new Error(`Runtime state schema ${version} is newer than supported version ${RUNTIME_STATE_SCHEMA_VERSION}`);
    }
    if (version === 0) {
        transaction(database, () => {
            // Another process may have completed the migration while this process
            // waited for the write lock. Re-read the version under that lock.
            const lockedVersion = Number(database.prepare("PRAGMA user_version").get().user_version);
            if (lockedVersion > RUNTIME_STATE_SCHEMA_VERSION) {
                throw new Error(
                    `Runtime state schema ${lockedVersion} is newer than supported version ${RUNTIME_STATE_SCHEMA_VERSION}`
                );
            }
            if (lockedVersion !== 0) return;
            database.exec(`
                CREATE TABLE express_sessions(
                    session_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                ) STRICT;
                CREATE INDEX express_sessions_expiry ON express_sessions(expires_at);
                CREATE TABLE browser_sessions(
                    session_id TEXT PRIMARY KEY,
                    jar_json TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                ) STRICT;
                CREATE INDEX browser_sessions_expiry ON browser_sessions(expires_at);
                CREATE TABLE origin_labels(
                    label TEXT PRIMARY KEY,
                    upstream_origin TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    accessed_at INTEGER NOT NULL
                ) STRICT;
                CREATE INDEX origin_labels_expiry ON origin_labels(expires_at);
                PRAGMA user_version = 1;
            `);
        });
    }
}

function createRuntimeState(options) {
    const { config, configPath = "./main.json", now = Date.now } = options;
    if (config.runtimeState.backend === "memory") {
        const sessionStateStore = options.sessionStateStore || createSessionStateStore({ now });
        const originIsolationRegistry = options.originIsolationRegistry || createOriginIsolationRegistry({
            ttlMs: config.session.maxAgeMs,
            now
        });
        return Object.freeze({
            backend: "memory",
            expressSessionStore: options.expressSessionStore,
            sessionStateStore,
            originIsolationRegistry,
            async close() {
                await sessionStateStore.clear?.();
                originIsolationRegistry.clear?.();
            }
        });
    }

    const sqlitePath = path.resolve(
        path.dirname(path.resolve(configPath)),
        config.runtimeState.sqlitePath
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    let DatabaseSync;
    try {
        ({ DatabaseSync } = require("node:sqlite"));
    } catch (error) {
        throw new Error("SQLite runtime state requires a Node.js build with node:sqlite", { cause: error });
    }
    const database = new DatabaseSync(sqlitePath, { timeout: config.runtimeState.busyTimeoutMs });
    try {
        initializeDatabase(database);
        try { fs.chmodSync(sqlitePath, 0o600); } catch {}
    } catch (error) {
        database.close();
        throw error;
    }
    return Object.freeze({
        backend: "sqlite",
        sqlitePath,
        expressSessionStore: new SqliteExpressSessionStore({
            database,
            maxAgeMs: config.session.maxAgeMs,
            now
        }),
        sessionStateStore: createSqliteBrowserSessionStore({ database, now }),
        originIsolationRegistry: createSqliteOriginRegistry({
            database,
            ttlMs: config.session.maxAgeMs,
            now
        }),
        async close() {
            database.close();
        }
    });
}

module.exports = {
    RUNTIME_STATE_SCHEMA_VERSION,
    SqliteExpressSessionStore,
    createRuntimeState,
    createSqliteBrowserSessionStore,
    createSqliteOriginRegistry,
    encodeBoundedJson,
    sessionExpiry,
    transaction,
    runtimeStateUnavailable
};
