const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { clientRuleMatches, normalizeClientRule } = require("./clientAccess");

const AUDIT_SCHEMA_VERSION = 1;
const MAX_PAGE_SIZE = 200;

function boundedText(value, maxLength = 512) {
    return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, maxLength);
}

function safeTargetOrigin(value) {
    if (!value) return "";
    try {
        const url = new URL(String(value));
        return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
    } catch {
        return "";
    }
}

function normalizeEvent(input, now = Date.now) {
    return Object.freeze({
        id: boundedText(input.id || randomUUID(), 64),
        timestamp: Number.isSafeInteger(input.timestamp) ? input.timestamp : now(),
        category: boundedText(input.category || "request", 32),
        action: boundedText(input.action || "request.completed", 80),
        outcome: boundedText(input.outcome || "success", 32),
        ip: boundedText(input.ip, 64),
        method: boundedText(input.method, 16),
        mode: boundedText(input.mode, 32),
        targetOrigin: safeTargetOrigin(input.targetOrigin),
        status: Number.isInteger(input.status) ? input.status : null,
        durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : null,
        requestId: boundedText(input.requestId, 64),
        detail: boundedText(input.detail, 512)
    });
}

function normalizeQuery(options = {}) {
    const parsedLimit = Number(options.limit);
    const parsedOffset = Number(options.offset);
    return {
        category: boundedText(options.category, 32),
        outcome: boundedText(options.outcome, 32),
        ip: boundedText(options.ip, 64),
        query: boundedText(options.query, 128).toLowerCase(),
        limit: Number.isFinite(parsedLimit)
            ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(parsedLimit)))
            : 50,
        offset: Number.isFinite(parsedOffset) ? Math.max(0, Math.trunc(parsedOffset)) : 0
    };
}

function eventMatches(event, filters) {
    if (filters.category && event.category !== filters.category) return false;
    if (filters.outcome && event.outcome !== filters.outcome) return false;
    if (filters.ip && !event.ip.includes(filters.ip)) return false;
    if (filters.query) {
        const haystack = [event.action, event.ip, event.method, event.mode, event.targetOrigin, event.requestId, event.detail]
            .join(" ").toLowerCase();
        if (!haystack.includes(filters.query)) return false;
    }
    return true;
}

function normalizeBan(input, now = Date.now) {
    const rule = normalizeClientRule(input.rule);
    if (!rule) throw new TypeError("Client ban rule must be an IP address or CIDR");
    const createdAt = Number.isSafeInteger(input.createdAt) ? input.createdAt : now();
    const expiresAt = input.expiresAt === null || input.expiresAt === undefined
        ? null
        : Number(input.expiresAt);
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt)) {
        throw new TypeError("Client ban expiry must be later than its creation time");
    }
    return Object.freeze({
        id: boundedText(input.id || randomUUID(), 64),
        rule,
        reason: boundedText(input.reason || "管理员手动封禁", 256),
        createdAt,
        expiresAt,
        hitCount: Math.max(0, Number(input.hitCount) || 0),
        lastHitAt: Number.isSafeInteger(input.lastHitAt) ? input.lastHitAt : null
    });
}

function createMemoryAuditStore({ getConfig, now }) {
    let events = [];
    const bans = new Map();

    function prune() {
        const config = getConfig().audit;
        const cutoff = now() - config.retentionDays * 86400000;
        events = events.filter(event => event.timestamp >= cutoff).slice(-config.maxRecords);
        for (const [id, ban] of bans) {
            if (ban.expiresAt !== null && ban.expiresAt <= now()) bans.delete(id);
        }
    }

    return Object.freeze({
        backend: "memory",
        record(input) {
            if (!getConfig().audit.enabled) return null;
            const event = normalizeEvent(input, now);
            events.push(event);
            prune();
            return event;
        },
        query(options) {
            prune();
            const filters = normalizeQuery(options);
            const matches = events.filter(event => eventMatches(event, filters)).reverse();
            return { total: matches.length, items: matches.slice(filters.offset, filters.offset + filters.limit) };
        },
        clearEvents() {
            const removed = events.length;
            events = [];
            return removed;
        },
        addBan(input) {
            const previous = [...bans.values()].find(item => item.rule === normalizeClientRule(input.rule));
            const ban = normalizeBan({ ...input, id: previous?.id }, now);
            bans.set(ban.id, ban);
            prune();
            return ban;
        },
        removeBan(id) {
            return bans.delete(String(id));
        },
        listBans() {
            prune();
            return [...bans.values()].sort((a, b) => b.createdAt - a.createdAt);
        },
        findActiveBan(address) {
            return this.listBans().find(ban => clientRuleMatches(ban.rule, address)) || null;
        },
        recordBanHit(id) {
            const ban = bans.get(String(id));
            if (!ban) return;
            bans.set(ban.id, normalizeBan({
                ...ban,
                hitCount: ban.hitCount + 1,
                lastHitAt: now()
            }, now));
        },
        close() {}
    });
}

function initializeAuditDatabase(database) {
    const schemaVersion = Number(database.prepare("PRAGMA user_version").get().user_version || 0);
    if (schemaVersion > AUDIT_SCHEMA_VERSION) {
        throw new Error(`Audit database schema ${schemaVersion} is newer than supported version ${AUDIT_SCHEMA_VERSION}`);
    }
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(`
        CREATE TABLE IF NOT EXISTS audit_events(
            event_id TEXT PRIMARY KEY,
            occurred_at INTEGER NOT NULL,
            category TEXT NOT NULL,
            action TEXT NOT NULL,
            outcome TEXT NOT NULL,
            ip TEXT NOT NULL,
            method TEXT NOT NULL,
            mode TEXT NOT NULL,
            target_origin TEXT NOT NULL,
            status INTEGER,
            duration_ms INTEGER,
            request_id TEXT NOT NULL,
            detail TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events(occurred_at DESC);
        CREATE INDEX IF NOT EXISTS audit_events_ip ON audit_events(ip, occurred_at DESC);
        CREATE TABLE IF NOT EXISTS client_bans(
            ban_id TEXT PRIMARY KEY,
            rule TEXT NOT NULL UNIQUE,
            reason TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            hit_count INTEGER NOT NULL,
            last_hit_at INTEGER
        ) STRICT;
    `);
    if (schemaVersion < AUDIT_SCHEMA_VERSION) {
        database.exec(`PRAGMA user_version = ${AUDIT_SCHEMA_VERSION}`);
    }
}

function rowToEvent(row) {
    return {
        id: row.event_id,
        timestamp: row.occurred_at,
        category: row.category,
        action: row.action,
        outcome: row.outcome,
        ip: row.ip,
        method: row.method,
        mode: row.mode,
        targetOrigin: row.target_origin,
        status: row.status,
        durationMs: row.duration_ms,
        requestId: row.request_id,
        detail: row.detail
    };
}

function rowToBan(row) {
    return {
        id: row.ban_id,
        rule: row.rule,
        reason: row.reason,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        hitCount: row.hit_count,
        lastHitAt: row.last_hit_at
    };
}

function createSqliteAuditStore({ configPath, getConfig, now }) {
    let DatabaseSync;
    try {
        ({ DatabaseSync } = require("node:sqlite"));
    } catch (error) {
        throw new Error("SQLite audit storage requires a Node.js build with node:sqlite", { cause: error });
    }
    const sqlitePath = path.resolve(path.dirname(path.resolve(configPath)), getConfig().audit.sqlitePath);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const database = new DatabaseSync(sqlitePath, { timeout: 5000 });
    try {
        initializeAuditDatabase(database);
    } catch (error) {
        database.close();
        throw error;
    }
    try { fs.chmodSync(sqlitePath, 0o600); } catch {}

    const insertEvent = database.prepare(`
        INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteExpiredEvents = database.prepare("DELETE FROM audit_events WHERE occurred_at < ?");
    const trimEvents = database.prepare(`
        DELETE FROM audit_events WHERE event_id IN (
            SELECT event_id FROM audit_events ORDER BY occurred_at DESC LIMIT -1 OFFSET ?
        )
    `);
    const clearEventsStatement = database.prepare("DELETE FROM audit_events");
    const deleteExpiredBans = database.prepare("DELETE FROM client_bans WHERE expires_at IS NOT NULL AND expires_at <= ?");
    const upsertBan = database.prepare(`
        INSERT INTO client_bans(ban_id, rule, reason, created_at, expires_at, hit_count, last_hit_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rule) DO UPDATE SET
            reason = excluded.reason,
            created_at = excluded.created_at,
            expires_at = excluded.expires_at,
            hit_count = 0,
            last_hit_at = NULL
    `);
    const removeBanStatement = database.prepare("DELETE FROM client_bans WHERE ban_id = ?");
    const listBansStatement = database.prepare("SELECT * FROM client_bans ORDER BY created_at DESC");
    const updateBanHit = database.prepare(`
        UPDATE client_bans SET hit_count = hit_count + 1, last_hit_at = ? WHERE ban_id = ?
    `);
    let banCache = { expires: 0, items: [] };

    function pruneEvents() {
        const config = getConfig().audit;
        deleteExpiredEvents.run(now() - config.retentionDays * 86400000);
        trimEvents.run(config.maxRecords);
    }

    function listBans() {
        if (banCache.expires > now()) {
            return banCache.items.filter(ban => ban.expiresAt === null || ban.expiresAt > now());
        }
        deleteExpiredBans.run(now());
        banCache = {
            expires: now() + 1000,
            items: listBansStatement.all().map(rowToBan)
        };
        return banCache.items;
    }

    return Object.freeze({
        backend: "sqlite",
        sqlitePath,
        record(input) {
            if (!getConfig().audit.enabled) return null;
            const event = normalizeEvent(input, now);
            insertEvent.run(
                event.id, event.timestamp, event.category, event.action, event.outcome,
                event.ip, event.method, event.mode, event.targetOrigin, event.status,
                event.durationMs, event.requestId, event.detail
            );
            pruneEvents();
            return event;
        },
        query(options) {
            pruneEvents();
            const filters = normalizeQuery(options);
            const clauses = [];
            const parameters = [];
            if (filters.category) { clauses.push("category = ?"); parameters.push(filters.category); }
            if (filters.outcome) { clauses.push("outcome = ?"); parameters.push(filters.outcome); }
            if (filters.ip) { clauses.push("ip LIKE ?"); parameters.push(`%${filters.ip}%`); }
            if (filters.query) {
                clauses.push("lower(action || ' ' || ip || ' ' || method || ' ' || mode || ' ' || target_origin || ' ' || request_id || ' ' || detail) LIKE ?");
                parameters.push(`%${filters.query}%`);
            }
            const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
            const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM audit_events ${where}`).get(...parameters).count);
            const rows = database.prepare(`
                SELECT * FROM audit_events ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?
            `).all(...parameters, filters.limit, filters.offset);
            return { total, items: rows.map(rowToEvent) };
        },
        clearEvents() {
            return Number(clearEventsStatement.run().changes);
        },
        addBan(input) {
            const ban = normalizeBan(input, now);
            upsertBan.run(
                ban.id, ban.rule, ban.reason, ban.createdAt, ban.expiresAt,
                ban.hitCount, ban.lastHitAt
            );
            banCache.expires = 0;
            return listBans().find(item => item.rule === ban.rule);
        },
        removeBan(id) {
            const removed = Number(removeBanStatement.run(String(id)).changes) > 0;
            banCache.expires = 0;
            return removed;
        },
        listBans,
        findActiveBan(address) {
            return listBans().find(ban => clientRuleMatches(ban.rule, address)) || null;
        },
        recordBanHit(id) {
            updateBanHit.run(now(), String(id));
            banCache.expires = 0;
        },
        close() {
            database.close();
        }
    });
}

function createAuditStore(options) {
    const now = options.now || Date.now;
    const config = options.getConfig();
    return config.audit.backend === "sqlite"
        ? createSqliteAuditStore({ ...options, now })
        : createMemoryAuditStore({ ...options, now });
}

module.exports = {
    AUDIT_SCHEMA_VERSION,
    MAX_PAGE_SIZE,
    createAuditStore,
    createMemoryAuditStore,
    createSqliteAuditStore,
    normalizeBan,
    normalizeEvent,
    normalizeQuery,
    safeTargetOrigin
};
