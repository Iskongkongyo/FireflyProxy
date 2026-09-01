function createDefaultConfig(env = process.env) {
    return {
        port: 8082,
        trustProxy: false,
        timeoutMs: 30000,
        user: "",
        pwd: "",
        defaultSkip: "",
        admin: {
            enabled: false,
            path: "/admin",
            user: "",
            pwd: ""
        },
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
            allowedOrigins: ["http://localhost:8080"],
            allowCredentials: true
        },
        limiter: {
            enabled: false,
            windowMs: 60000,
            max: 60,
            message: "Too many requests, please try again later.",
            statusCode: 429
        },
        security: {
            ssrf: true,
            allowPrivateNetworks: false,
            blockedHostnames: [],
            maxRewriteBytes: 5242880
        },
        api: {
            followRedirects: true,
            maxRedirects: 5,
            connectTimeoutMs: 5000,
            maxRequestBodyBytes: 5242880,
            maxConcurrentRequests: 64
        },
        browser: {
            enabled: false,
            maxRedirects: 10,
            rewriteHtml: true,
            rewriteCss: true,
            cookieJar: true,
            runtimeBridge: false,
            scriptCookieBridge: false,
            webSocket: false,
            webSocketMaxPayloadBytes: 1048576,
            webSocketIdleTimeoutMs: 60000,
            webSocketMaxConnections: 64,
            originIsolation: {
                enabled: false,
                baseOrigin: "https://browse.example.com"
            },
            headerPolicy: "compat"
        }
    };
}

module.exports = {
    createDefaultConfig
};
