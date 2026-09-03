const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

process.chdir(__dirname);

const configPath = path.join(__dirname, "main.json");
const examplePath = path.join(__dirname, "main.json.example");

if (!fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(examplePath, "utf8"));
    config.session.secret = randomBytes(32).toString("hex");
    const localOrigins = [
        `http://localhost:${config.port}`,
        `http://127.0.0.1:${config.port}`
    ];
    config.cors.allowedOrigins = [...new Set([
        ...localOrigins,
        ...(config.cors.allowedOrigins || [])
    ])];

    try {
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600
        });
        console.log(`[Setup] 已创建 ${configPath}`);
        console.log("[Setup] 公网部署前请配置代理/管理认证、HTTPS、CORS 与安全策略。");
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
    }
}

require("./main");
