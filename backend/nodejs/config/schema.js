const { z } = require("zod");
const { getPublicSuffix } = require("tough-cookie");
const { normalizeClientRule } = require("../core/clientAccess");
const { normalizeAccessRule, normalizeHostnameRule } = require("../core/targetValidator");

const originSchema = z.string().refine(value => {
    if (value === "*") return true;
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && url.origin === value;
    } catch {
        return false;
    }
}, "Expected '*' or an HTTP(S) origin without a path");

const trustProxySchema = z.union([
    z.boolean(),
    z.number().int().nonnegative(),
    z.string().min(1),
    z.array(z.string().min(1))
]);

const adminPathSchema = z.string().max(128).refine(value => (
    /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value)
    && value !== "/web"
    && !value.startsWith("/web/")
    && value !== "/__proxyweb"
    && !value.startsWith("/__proxyweb/")
), "Expected an absolute non-reserved path such as /admin or /control/settings");

const adminSchema = z.object({
    enabled: z.boolean(),
    path: adminPathSchema,
    user: z.string().max(256).refine(
        value => !/[\u0000-\u001f\u007f:]/.test(value),
        "Admin username cannot contain control characters or ':'"
    ),
    pwd: z.string().max(1024).refine(
        value => !/[\u0000-\u001f\u007f]/.test(value),
        "Admin password cannot contain control characters"
    )
}).strict();

const sessionSchema = z.object({
    secret: z.string().min(1),
    name: z.string().min(1),
    resave: z.boolean(),
    saveUninitialized: z.boolean(),
    maxAgeMs: z.number().int().positive(),
    secure: z.boolean(),
    httpOnly: z.boolean(),
    sameSite: z.union([z.boolean(), z.enum(["lax", "strict", "none"])])
}).strict();

const corsSchema = z.object({
    allowedOrigins: z.array(originSchema).min(1),
    allowCredentials: z.boolean()
}).strict().superRefine((value, context) => {
    if (value.allowCredentials && value.allowedOrigins.includes("*")) {
        context.addIssue({
            code: "custom",
            path: ["allowedOrigins"],
            message: "Wildcard origin is forbidden when allowCredentials is true"
        });
    }
});

const limiterSchema = z.object({
    enabled: z.boolean(),
    windowMs: z.number().int().positive(),
    max: z.number().int().positive(),
    message: z.string(),
    statusCode: z.number().int().min(400).max(599)
}).strict();

const boundedPathSchema = z.string().min(1).max(1024).refine(
    value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
    "Expected a non-empty path without control characters"
);

const auditSchema = z.object({
    enabled: z.boolean(),
    backend: z.enum(["memory", "sqlite"]),
    sqlitePath: boundedPathSchema,
    retentionDays: z.number().int().min(1).max(365),
    maxRecords: z.number().int().min(100).max(1000000),
    recordTargetOrigin: z.boolean()
}).strict();

const clientRuleSchema = z.string().refine(
    value => normalizeClientRule(value) !== null,
    "Expected an IPv4/IPv6 address or CIDR"
);

const clientAccessControlSchema = z.object({
    enabled: z.boolean(),
    neverBlock: z.array(clientRuleSchema).max(1000)
}).strict();

const accessRuleSchema = z.string().refine(
    value => normalizeAccessRule(value) !== null,
    "Expected a hostname, wildcard hostname, IP or CIDR with an optional port"
);

const securitySchema = z.object({
    ssrf: z.boolean(),
    allowPrivateNetworks: z.boolean(),
    accessControl: z.object({
        enabled: z.boolean(),
        allowed: z.array(accessRuleSchema).max(1000),
        blocked: z.array(accessRuleSchema).max(1000)
    }).strict(),
    maxRewriteBytes: z.number().int().positive()
}).strict();

const apiSchema = z.object({
    followRedirects: z.boolean(),
    maxRedirects: z.number().int().nonnegative().max(20),
    connectTimeoutMs: z.number().int().positive(),
    maxRequestBodyBytes: z.number().int().positive(),
    maxConcurrentRequests: z.number().int().positive().max(10000)
}).strict();

const transformHostnameSchema = z.string().refine(
    value => normalizeHostnameRule(value) !== null,
    "Expected an exact hostname or a leading wildcard such as *.example.com"
);

const transformContentTypeSchema = z.string().max(128).refine(value => (
    value === value.trim()
    && value === value.toLowerCase()
    && /^(?:[a-z0-9!#$&^_.+-]+)\/(?:[a-z0-9!#$&^_.+-]+|\*)$/.test(value)
), "Expected a lowercase media type such as text/html or text/*");

const literalReplacementSchema = z.object({
    search: z.string().min(1).max(16384),
    replacement: z.string().max(65536),
    mode: z.enum(["once", "all"]).default("all"),
    maxReplacements: z.number().int().min(1).max(10000).default(1000)
}).strict();

const responseTransformRuleSchema = z.object({
    id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    enabled: z.boolean().default(true),
    hosts: z.array(transformHostnameSchema).min(1).max(32),
    pathPrefix: z.string().min(1).max(2048).refine(value => (
        value.startsWith("/") && !/[\u0000-\u001f\u007f?#]/.test(value)
    ), "Expected an absolute URL path prefix without query or fragment"),
    contentTypes: z.array(transformContentTypeSchema).min(1).max(32),
    replacements: z.array(literalReplacementSchema).max(64).default([]),
    appendHead: z.string().max(262144).default(""),
    prependBody: z.string().max(262144).default("")
}).strict().superRefine((value, context) => {
    if (value.replacements.length === 0 && !value.appendHead && !value.prependBody) {
        context.addIssue({
            code: "custom",
            path: ["replacements"],
            message: "A response transform rule requires a replacement or HTML injection"
        });
    }
});

const responseTransformSchema = z.object({
    enabled: z.boolean(),
    rules: z.array(responseTransformRuleSchema).max(64)
}).strict().superRefine((value, context) => {
    const seen = new Set();
    for (const [index, rule] of value.rules.entries()) {
        if (seen.has(rule.id)) {
            context.addIssue({
                code: "custom",
                path: ["rules", index, "id"],
                message: "Response transform rule IDs must be unique"
            });
        }
        seen.add(rule.id);
    }
});

const publicCacheSchema = z.object({
    enabled: z.boolean(),
    directory: z.string().min(1).max(1024).refine(
        value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
        "Expected a non-empty cache directory without control characters"
    ),
    ttlMs: z.number().int().positive().max(2592000000),
    maxBytes: z.number().int().positive().max(10737418240),
    maxObjectBytes: z.number().int().positive().max(104857600)
}).strict().superRefine((value, context) => {
    if (value.maxObjectBytes > value.maxBytes) {
        context.addIssue({
            code: "custom",
            path: ["maxObjectBytes"],
            message: "Public cache object limit cannot exceed total cache capacity"
        });
    }
});

const runtimeStateSchema = z.object({
    backend: z.enum(["memory", "sqlite"]),
    sqlitePath: z.string().min(1).max(1024).refine(
        value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
        "Expected a non-empty SQLite path without control characters"
    ),
    busyTimeoutMs: z.number().int().min(100).max(60000)
}).strict();

const browserSchema = z.object({
    enabled: z.boolean(),
    maxRedirects: z.number().int().nonnegative().max(20),
    rewriteHtml: z.boolean(),
    rewriteCss: z.boolean(),
    cookieJar: z.boolean(),
    runtimeBridge: z.boolean(),
    scriptCookieBridge: z.boolean(),
    webSocket: z.boolean(),
    webSocketMaxPayloadBytes: z.number().int().positive().max(16777216),
    webSocketIdleTimeoutMs: z.number().int().positive().max(3600000),
    webSocketMaxConnections: z.number().int().positive().max(10000),
    responseTransform: responseTransformSchema,
    publicCache: publicCacheSchema,
    originIsolation: z.object({
        enabled: z.boolean(),
        baseOrigin: originSchema.refine(value => value !== "*", "Expected an exact HTTP(S) origin")
    }).strict(),
    headerPolicy: z.enum(["strict", "preserve", "compat"])
}).strict();

const configSchema = z.object({
    port: z.number().int().min(1).max(65535),
    trustProxy: trustProxySchema,
    timeoutMs: z.number().int().positive(),
    user: z.string(),
    pwd: z.string(),
    defaultSkip: z.string(),
    admin: adminSchema,
    session: sessionSchema,
    runtimeState: runtimeStateSchema,
    cors: corsSchema,
    limiter: limiterSchema,
    audit: auditSchema,
    clientAccessControl: clientAccessControlSchema,
    security: securitySchema,
    api: apiSchema,
    browser: browserSchema
}).strict().superRefine((value, context) => {
    if (value.admin.enabled && (!value.admin.user || !value.admin.pwd)) {
        context.addIssue({
            code: "custom",
            path: ["admin"],
            message: "Enabled admin console requires a non-empty admin user and password"
        });
    }
    if (value.browser.scriptCookieBridge && (!value.browser.runtimeBridge || !value.browser.rewriteHtml)) {
        context.addIssue({
            code: "custom",
            path: ["browser", "scriptCookieBridge"],
            message: "Script Cookie Bridge requires browser.runtimeBridge and browser.rewriteHtml"
        });
    }
    if (!value.browser.originIsolation.enabled) return;
    const base = new URL(value.browser.originIsolation.baseOrigin);
    const labels = base.hostname.split(".");
    let registrableDomain = null;
    try {
        registrableDomain = getPublicSuffix(base.hostname, { allowSpecialUseDomain: true });
    } catch {
        registrableDomain = null;
    }
    if (
        labels.length < 3
        || base.hostname === registrableDomain
        || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    ) {
        context.addIssue({
            code: "custom",
            path: ["browser", "originIsolation", "baseOrigin"],
            message: "Origin isolation requires a dedicated DNS namespace with at least three hostname labels"
        });
    }
    if (base.protocol === "http:" && !base.hostname.endsWith(".test")) {
        context.addIssue({
            code: "custom",
            path: ["browser", "originIsolation", "baseOrigin"],
            message: "Origin isolation requires HTTPS outside reserved .test environments"
        });
    }
    if (base.protocol === "https:" && !value.session.secure) {
        context.addIssue({
            code: "custom",
            path: ["session", "secure"],
            message: "HTTPS origin isolation requires a Secure session cookie"
        });
    }
    if (!value.session.httpOnly) {
        context.addIssue({
            code: "custom",
            path: ["session", "httpOnly"],
            message: "Origin isolation requires an HttpOnly control session cookie"
        });
    }
});

function formatConfigIssues(error) {
    return error.issues.map(issue => {
        const path = issue.path.length ? issue.path.join(".") : "config";
        return `${path}: ${issue.message}`;
    }).join("; ");
}

module.exports = {
    configSchema,
    formatConfigIssues
};
