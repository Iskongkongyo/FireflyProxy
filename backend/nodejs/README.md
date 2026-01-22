# 🚀 Smart Dynamic Reverse Proxy - Node.js 版

> **拒绝重启，拒绝内网渗透！** 这是一个基于 Node.js Express 构建的、高度可配置的动态反向代理服务。它专为安全性和灵活性设计，支持配置热重载、严格的 SSRF 防御以及智能的请求头处理。

## ✨ 核心亮点 (Key Features)

| 特性 | 说明 |
|------|------|
| 🔥 **配置热重载** | 修改 `main.json` 配置文件后，限流、超时策略即刻生效，**无需重启服务** |
| 🛡️ **SSRF 防御** | 内置 `ipaddr.js` 深度检测，自动阻断内网私有 IP 访问，防止代理被恶意利用 |
| ⚡ **动态代理** | 只需 `/?url=https://target.com`，即可开启会话级代理 |
| 🔒 **安全加固** | 集成 Basic Auth、Rate Limit 速率限制及自动化 CORS 处理 |
| 📝 **日志分离** | 基于 Winston，运行日志与错误日志分离，便于排查问题 |
| 🧠 **重定向同步** | 自动跟踪重定向链，同步更新 Session 中的目标 URL |

------

## 🛠️ 快速开始 (Quick Start)

### 1. 环境准备

确保你的服务器已安装 **Node.js 16.x** 或更高版本。

### 2. 安装依赖

```bash
npm install express axios express-rate-limit chokidar express-session basic-auth ipaddr.js winston
```

### 3. 创建配置文件

在 `backend/` 目录下创建 `main.json` 文件（若不创建，系统将使用默认安全配置）：

```json
{
  "port": 8082,
  "timeout": 30,
  "user": "admin",
  "pwd": "your_secure_password",
  "accessOrigin": "*",
  "defaultSkip": "",
  "session": {
    "secret": "my-super-secret-key-change-in-prod",
    "name": "proxySession",
    "resave": false,
    "saveUninitialized": false,
    "cookie": { "maxAge": 86400000, "secure": false, "httpOnly": true }
  },
  "limiter": {
    "windowMs": 60000,
    "max": 60,
    "message": "Too many requests, slow down!",
    "statusCode": 429
  },
  "blacklist": ["malicious-site.org"]
}
```

### 4. 启动服务

```bash
node main.js
```

看到以下输出即表示启动成功：

```
🚀 [Server] Reverse Proxy running on port 8082
🛡️ [Security] SSRF Protection: Enabled
🔥 [System] Hot Reload: Enabled
```

------

## ⚙️ 配置项详解 (Configuration)

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `port` | Number | `8082` | 服务监听端口 |
| `timeout` | Number | `30` | 请求超时时间（秒） |
| `user` | String | `""` | Basic Auth 用户名（留空则不启用认证） |
| `pwd` | String | `""` | Basic Auth 密码 |
| `accessOrigin` | String | `"*"` | CORS 允许的来源（`*` 表示允许所有） |
| `defaultSkip` | String | `""` | 未设置目标时跳转的默认 URL |
| `session.secret` | String | 随机生成 | Session 加密密钥（生产环境请务必修改） |
| `session.cookie.maxAge` | Number | `86400000` | Session 过期时间（毫秒，默认 24 小时） |
| `limiter.windowMs` | Number | `60000` | 限流时间窗口（毫秒） |
| `limiter.max` | Number | `60` | 时间窗口内最大请求数 |
| `blacklist` | Array | `[]` | 黑名单域名列表，支持正则表达式 |

------

## 🎮 使用指南 (Usage)

### 1. 开启代理会话

访问代理服务器并带上目标 URL：

```
http://your-server-ip:8082/?url=https://www.google.com
```

- **成功:** 服务器会建立 Session，后续请求将自动代理到目标地址
- **失败:** 如果目标是内网 IP 或黑名单域名，将返回 `403 Forbidden`

### 2. 持续访问

Session 建立后，直接访问代理服务器的路径：

```
http://your-server-ip:8082/search?q=hello
```

会自动转发到 `https://www.google.com/search?q=hello`

### 3. 注入自定义请求头

通过 `headers` 参数注入自定义请求头：

```
http://your-server-ip:8082/?url=https://api.example.com&headers={"Authorization":"Bearer xxx"}
```

### 4. 动态修改配置

直接修改 `main.json`，保存后控制台会提示：

```
[Config] 📝 File changed, reloading...
[System] 🔄 RateLimiter reloaded dynamically.
```

**无需重启**，新策略立即生效！

------

## 📂 项目结构 (Structure)

```
backend/
├── main.js           # 🧠 核心入口文件 (Express + Axios)
├── main.json         # ⚙️ 配置文件 (支持热更新)
├── run.log           # 📘 运行日志 (Info/Warn)
├── error.log         # 📕 错误日志 (Error only)
└── webPro/           # 📂 静态资源目录 (通过 /web 访问)
```

------

## 🛡️ 安全机制 (Security)

### SSRF 防护

| 防护层 | 说明 |
|--------|------|
| 协议校验 | 只允许 `http://` 和 `https://` 协议 |
| IP 检测 | 拒绝 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.1` 等内网/本地 IP |
| 域名黑名单 | 支持正则匹配的域名黑名单 |
| Header 净化 | 移除 `x-forwarded-for`, `cf-connecting-ip` 等可能泄露信息的请求头 |

### 认证与限流

- **Basic Auth:** 配置 `user` 和 `pwd` 后生效，未授权访问返回 401
- **Rate Limit:** 基于 IP 的请求限流，超限返回 429

------

## 🔧 生产环境部署 (Production)

### 使用 PM2 部署

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start main.js --name "reverse-proxy"

# 设置开机自启
pm2 startup
pm2 save
```

### Nginx 反向代理配置

```nginx
server {
    listen 80;
    server_name proxy.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 注意事项

- 生产环境请修改 `session.secret` 为强密码
- 建议配置 `user` 和 `pwd` 启用 Basic Auth
- 考虑使用 Redis 存储 Session（代码中有注释示例）

------

## 📝 常见问题 (FAQ)

**Q: 为什么日志里有 \"Blocked Private/Local IP\"?**

A: 这是 SSRF 防御在工作。有人试图通过你的代理访问内网服务（如 `localhost:3306`），已被成功拦截。

**Q: 请求超时怎么办?**

A: 修改 `main.json` 中的 `timeout` 值（单位为秒），保存后自动生效。

------

## 📜 许可证 (License)

MIT License. Feel free to use and modify!

------

**Made with ❤️ by [Iskongkongyo](https://github.com/Iskongkongyo)**