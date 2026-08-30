const { z } = require("zod");
const { normalizeHostnameRule } = require("../core/targetValidator");

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
    windowMs: z.number().int().positive(),
    max: z.number().int().positive(),
    message: z.string(),
    statusCode: z.number().int().min(400).max(599)
}).strict();

const securitySchema = z.object({
    ssrf: z.boolean(),
    allowPrivateNetworks: z.boolean(),
    blockedHostnames: z.array(z.string().refine(
        value => normalizeHostnameRule(value) !== null,
        "Expected an exact hostname or a leading wildcard such as *.example.com"
    )),
    maxRewriteBytes: z.number().int().positive()
}).strict();

const apiSchema = z.object({
    followRedirects: z.boolean(),
    maxRedirects: z.number().int().nonnegative().max(20),
    connectTimeoutMs: z.number().int().positive(),
    maxRequestBodyBytes: z.number().int().positive(),
    maxConcurrentRequests: z.number().int().positive().max(10000)
}).strict();

const browserSchema = z.object({
    enabled: z.boolean(),
    maxRedirects: z.number().int().nonnegative().max(20),
    rewriteHtml: z.boolean(),
    rewriteCss: z.boolean(),
    cookieJar: z.boolean(),
    runtimeBridge: z.boolean(),
    headerPolicy: z.enum(["strict", "preserve", "compat"])
}).strict();

const configSchema = z.object({
    port: z.number().int().min(1).max(65535),
    trustProxy: trustProxySchema,
    timeoutMs: z.number().int().positive(),
    user: z.string(),
    pwd: z.string(),
    defaultSkip: z.string(),
    session: sessionSchema,
    cors: corsSchema,
    limiter: limiterSchema,
    security: securitySchema,
    api: apiSchema,
    browser: browserSchema
}).strict();

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
