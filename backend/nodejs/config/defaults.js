function createDefaultConfig(env = process.env) {
    return {
        port: 8082,
        // Preserve the baseline until the dedicated trust-proxy security stage.
        trustProxy: 1,
        timeoutMs: 30000,
        user: "",
        pwd: "",
        defaultSkip: "",
        session: {
            secret: env.PROXYWEB_SESSION_SECRET || `change-this-secret-in-prod-${Date.now()}`,
            name: "proxySession",
            resave: false,
            saveUninitialized: false,
            maxAgeMs: 86400000,
            secure: false,
            httpOnly: true,
            sameSite: "lax"
        },
        cors: {
            // Preserve the current wildcard behavior until P0 CORS hardening.
            allowedOrigins: ["*"],
            allowCredentials: true
        },
        limiter: {
            windowMs: 60000,
            max: 60,
            message: "Too many requests, please try again later.",
            statusCode: 429
        },
        blacklist: [],
        security: {
            ssrf: true,
            allowPrivateNetworks: false,
            maxRewriteBytes: 5242880
        },
        api: {
            followRedirects: true,
            maxRedirects: 5
        },
        browser: {
            enabled: false,
            maxRedirects: 10,
            rewriteHtml: true,
            rewriteCss: true,
            cookieJar: true,
            runtimeBridge: false,
            headerPolicy: "compat"
        }
    };
}

module.exports = {
    createDefaultConfig
};
