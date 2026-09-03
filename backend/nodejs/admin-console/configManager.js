const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { ConfigLoadError, parseConfigObject } = require("../config/loader");

const SECRET_PATHS = Object.freeze([
    Object.freeze(["pwd"]),
    Object.freeze(["session", "secret"]),
    Object.freeze(["admin", "pwd"])
]);

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(object, segments) {
    let current = object;
    for (const segment of segments) {
        if (!isPlainObject(current) && typeof current !== "string") return undefined;
        current = current?.[segment];
    }
    return current;
}

function setPath(object, segments, value) {
    let current = object;
    for (const segment of segments.slice(0, -1)) {
        if (!isPlainObject(current[segment])) current[segment] = {};
        current = current[segment];
    }
    current[segments.at(-1)] = value;
}

async function readRawConfig(configPath) {
    try {
        const text = await fs.readFile(configPath, "utf8");
        const value = JSON.parse(text);
        if (!isPlainObject(value)) throw new TypeError("Configuration root must be an object");
        return value;
    } catch (error) {
        if (error?.code === "ENOENT") return {};
        if (error instanceof SyntaxError || error instanceof TypeError) {
            throw new ConfigLoadError("CONFIG_JSON_INVALID", `Unable to parse ${configPath}: ${error.message}`, error);
        }
        throw error;
    }
}

function createAdminSnapshot(config) {
    const snapshot = structuredClone(config);
    const secrets = {};
    for (const segments of SECRET_PATHS) {
        const key = segments.join(".");
        secrets[key] = Boolean(getPath(config, segments));
        setPath(snapshot, segments, null);
    }
    return { config: snapshot, secrets };
}

function restoreSecretValues(candidate, rawConfig, currentConfig) {
    for (const segments of SECRET_PATHS) {
        const submitted = getPath(candidate, segments);
        if (submitted !== null && submitted !== undefined) continue;
        const rawValue = getPath(rawConfig, segments);
        setPath(candidate, segments, rawValue !== undefined
            ? rawValue
            : getPath(currentConfig, segments));
    }
    return candidate;
}

function changedRestartFields(previous, next) {
    const fields = [];
    for (const field of ["port", "trustProxy", "session", "runtimeState"]) {
        if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) fields.push(field);
    }
    if (
        previous.audit.backend !== next.audit.backend
        || previous.audit.sqlitePath !== next.audit.sqlitePath
    ) fields.push("audit.backend/sqlitePath");
    if (previous.browser.publicCache.directory !== next.browser.publicCache.directory) {
        fields.push("browser.publicCache.directory");
    }
    return fields;
}

async function writeAtomic(configPath, text) {
    const resolved = path.resolve(configPath);
    const temporary = `${resolved}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    try {
        await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.rename(temporary, resolved);
    } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

async function saveAdminConfig({
    configPath,
    submittedConfig,
    currentConfig,
    defaults,
    env,
    reloadConfig
}) {
    if (!isPlainObject(submittedConfig)) {
        throw new ConfigLoadError("CONFIG_SCHEMA_INVALID", "Configuration payload must be an object");
    }
    const rawConfig = await readRawConfig(configPath);
    const candidate = restoreSecretValues(structuredClone(submittedConfig), rawConfig, currentConfig);
    const parsed = parseConfigObject(candidate, { defaults, env });
    const restartRequired = changedRestartFields(currentConfig, parsed.config);
    const adminCredentialsChanged = currentConfig.admin.user !== parsed.config.admin.user
        || currentConfig.admin.pwd !== parsed.config.admin.pwd;
    await writeAtomic(configPath, `${JSON.stringify(candidate, null, 2)}\n`);
    const reload = reloadConfig();
    if (!reload.ok) throw reload.error;
    return {
        config: reload.config,
        warnings: parsed.warnings,
        restartRequired,
        adminCredentialsChanged
    };
}

module.exports = {
    SECRET_PATHS,
    changedRestartFields,
    createAdminSnapshot,
    readRawConfig,
    restoreSecretValues,
    saveAdminConfig,
    writeAtomic
};
