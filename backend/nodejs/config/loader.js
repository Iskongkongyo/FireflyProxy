const fs = require("node:fs");
const { createDefaultConfig } = require("./defaults");
const { configSchema, formatConfigIssues } = require("./schema");

class ConfigLoadError extends Error {
    constructor(code, message, cause) {
        super(message, { cause });
        this.name = "ConfigLoadError";
        this.code = code;
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
    if (!isPlainObject(base) || !isPlainObject(override)) return override;

    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
        result[key] = isPlainObject(value) && isPlainObject(base[key])
            ? deepMerge(base[key], value)
            : value;
    }
    return result;
}

function legacySecondsToMs(value) {
    return typeof value === "number" ? value * 1000 : value;
}

function migrateLegacyConfig(input) {
    const raw = structuredClone(input);
    const warnings = [];
    const warn = (field, replacement, note = "") => {
        warnings.push({
            field,
            replacement,
            message: `${field} is deprecated; use ${replacement}.${note ? ` ${note}` : ""}`
        });
    };

    const legacyMarkers = ["timeout", "accessOrigin", "max_redirects", "blacklist"]
        .some(field => Object.prototype.hasOwnProperty.call(raw, field))
        || Boolean(raw.session && (
            raw.session.cookie
            || Object.prototype.hasOwnProperty.call(raw.session, "cookie_max_age")
            || Object.prototype.hasOwnProperty.call(raw.session, "cookie_secure")
            || Object.prototype.hasOwnProperty.call(raw.session, "cookie_httponly")
        ));

    if (raw.timeoutMs === undefined && raw.timeout !== undefined) {
        raw.timeoutMs = legacySecondsToMs(raw.timeout);
        warn("timeout", "timeoutMs", "The legacy value is interpreted as seconds.");
    }
    delete raw.timeout;

    if (raw.cors === undefined && raw.accessOrigin !== undefined) {
        const legacyWildcard = raw.accessOrigin === "*";
        raw.cors = {
            allowedOrigins: [raw.accessOrigin],
            allowCredentials: !legacyWildcard
        };
        warn(
            "accessOrigin",
            "cors.allowedOrigins",
            legacyWildcard ? "Wildcard origins are migrated with credentials disabled." : ""
        );
    }
    delete raw.accessOrigin;

    if (raw.api === undefined && raw.max_redirects !== undefined) {
        raw.api = {
            maxRedirects: raw.max_redirects,
            followRedirects: true
        };
        warn("max_redirects", "api.maxRedirects");
    }
    delete raw.max_redirects;

    if (raw.blacklist !== undefined) {
        if (raw.security === undefined) raw.security = {};
        if (isPlainObject(raw.security) && raw.security.blockedHostnames === undefined) {
            raw.security = {
                ...raw.security,
                blockedHostnames: raw.blacklist
            };
        }
        warn(
            "blacklist",
            "security.blockedHostnames",
            "Rules now match exact hostnames or leading wildcard subdomains; regular expressions are not supported."
        );
    }
    delete raw.blacklist;

    if (raw.session) {
        const session = { ...raw.session };
        if (session.maxAgeMs === undefined && session.cookie && session.cookie.maxAge !== undefined) {
            session.maxAgeMs = session.cookie.maxAge;
            warn("session.cookie.maxAge", "session.maxAgeMs");
        } else if (session.maxAgeMs === undefined && session.cookie_max_age !== undefined) {
            session.maxAgeMs = legacySecondsToMs(session.cookie_max_age);
            warn("session.cookie_max_age", "session.maxAgeMs", "The legacy value is interpreted as seconds.");
        }

        if (session.secure === undefined && session.cookie && session.cookie.secure !== undefined) {
            session.secure = session.cookie.secure;
            warn("session.cookie.secure", "session.secure");
        } else if (session.secure === undefined && session.cookie_secure !== undefined) {
            session.secure = session.cookie_secure;
            warn("session.cookie_secure", "session.secure");
        }

        if (session.httpOnly === undefined && session.cookie && session.cookie.httpOnly !== undefined) {
            session.httpOnly = session.cookie.httpOnly;
            warn("session.cookie.httpOnly", "session.httpOnly");
        } else if (session.httpOnly === undefined && session.cookie_httponly !== undefined) {
            session.httpOnly = session.cookie_httponly;
            warn("session.cookie_httponly", "session.httpOnly");
        }

        if (session.sameSite === undefined && session.cookie && session.cookie.sameSite !== undefined) {
            session.sameSite = session.cookie.sameSite;
            warn("session.cookie.sameSite", "session.sameSite");
        }

        delete session.cookie;
        delete session.cookie_max_age;
        delete session.cookie_secure;
        delete session.cookie_httponly;
        raw.session = session;
    }

    if (legacyMarkers && raw.limiter && typeof raw.limiter.windowMs === "number"
        && raw.limiter.windowMs > 0 && raw.limiter.windowMs <= 1000) {
        raw.limiter = {
            ...raw.limiter,
            windowMs: raw.limiter.windowMs * 1000
        };
        warn("limiter.windowMs", "limiter.windowMs", "A legacy value <= 1000 is interpreted as seconds.");
    }

    return { config: raw, warnings };
}

function interpolateEnvironment(value, env) {
    if (Array.isArray(value)) return value.map(item => interpolateEnvironment(item, env));
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            interpolateEnvironment(item, env)
        ]));
    }
    if (typeof value !== "string") return value;

    return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (match, name) => {
        if (!Object.prototype.hasOwnProperty.call(env, name)) {
            throw new ConfigLoadError("CONFIG_ENV_MISSING", `Environment variable ${name} is required by the configuration.`);
        }
        return env[name];
    });
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
    return value;
}

function parseConfigObject(raw, options = {}) {
    const env = options.env || process.env;
    const defaults = options.defaults || createDefaultConfig(env);
    const { config: migrated, warnings } = migrateLegacyConfig(raw);

    let interpolated;
    try {
        interpolated = interpolateEnvironment(migrated, env);
    } catch (error) {
        if (error instanceof ConfigLoadError) throw error;
        throw new ConfigLoadError("CONFIG_ENV_INVALID", error.message, error);
    }

    const result = configSchema.safeParse(deepMerge(defaults, interpolated));
    if (!result.success) {
        throw new ConfigLoadError("CONFIG_SCHEMA_INVALID", formatConfigIssues(result.error), result.error);
    }

    return {
        config: deepFreeze(result.data),
        warnings
    };
}

function loadConfigFile(options = {}) {
    const configPath = options.configPath || "./main.json";
    const env = options.env || process.env;
    const defaults = options.defaults || createDefaultConfig(env);

    if (!fs.existsSync(configPath)) {
        return {
            config: deepFreeze(configSchema.parse(defaults)),
            warnings: [],
            source: "defaults"
        };
    }

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
        throw new ConfigLoadError("CONFIG_JSON_INVALID", `Unable to parse ${configPath}: ${error.message}`, error);
    }

    const parsed = parseConfigObject(raw, { defaults, env });
    return {
        ...parsed,
        source: configPath
    };
}

module.exports = {
    ConfigLoadError,
    deepMerge,
    interpolateEnvironment,
    loadConfigFile,
    migrateLegacyConfig,
    parseConfigObject
};
