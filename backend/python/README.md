# 🐍 Smart Dynamic Reverse Proxy - Python 版

> **Python 党的反代利器！** 这是一个基于 Flask 构建的现代化反向代理服务。它不仅继承了动态配置和安全防御的优良传统，更集成了 `Cloudscraper`，赋予了它**穿透 Cloudflare 5秒盾**的超能力。

## ✨ 核心亮点 (Key Features)

| 特性 | 说明 |
|------|------|
| ☁️ **Cloudflare 穿透** | 内置 `cloudscraper` 引擎，自动处理 JS 挑战，轻松代理被 Cloudflare 保护的网站 |
| 🔥 **配置热重载** | 基于 `watchdog` 监听文件变动，修改 `main.json` 无需重启 |
| 🛡️ **SSRF 防御** | 智能识别并拒绝内网私有 IP，防止代理成为内网渗透的跳板 |
| 🚦 **智能限流** | 集成 `Flask-Limiter`，精准控制访问频率 |
| 🔄 **重定向同步** | 自动跟踪重定向链，同步更新 Session 中的目标 URL |
| 🐍 **稳定可靠** | 全局异常捕获机制，单个请求崩溃不会影响整个进程 |

------

## 🆚 Node.js 版 vs Python 版

| 特性 | Node.js 版 | Python 版 |
|------|------------|-----------|
| Cloudflare 绕过 | ❌ 不支持 | ✅ 内置 cloudscraper |
| 性能 | ⚡ 更高并发 | 🐢 适中 |
| 依赖管理 | npm | pip |
| 适用场景 | 通用代理 | 需要绕过 Cloudflare 的场景 |

------

## 🛠️ 快速开始 (Quick Start)

### 1. 环境准备

确保你的服务器已安装 **Python 3.8+**。

### 2. 安装依赖

```bash
pip install flask flask-session flask-limiter watchdog cloudscraper requests
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
    "secret": "super-secret-key-change-me",
    "name": "proxySession",
    "cookie_max_age": 86400,
    "cookie_httponly": true
  },
  "limiter": {
    "windowMs": 60,
    "max": 60,
    "message": "Too fast! Take a breath.",
    "statusCode": 429
  },
  "blacklist": ["bad-site.com", "malware.org"]
}
```

### 4. 启动服务

**开发/测试模式:**

```bash
python main.py
```

看到以下输出即表示启动成功：

```
🚀 [Server] Reverse Proxy running on port 8082
🛡️ [Security] SSRF Protection: Enabled
☁️ [Cloudflare] Bypass with cloudscraper: Enabled
🔥 [System] Hot Reload: Enabled
```

**生产环境模式 (推荐使用 Gunicorn):**

```bash
pip install gunicorn
gunicorn -w 4 -b 0.0.0.0:8082 main:app
```

------

## ⚙️ 配置项详解 (Configuration)

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `port` | Integer | `8082` | 服务监听端口 |
| `timeout` | Integer | `30` | 请求超时时间（秒） |
| `user` | String | `""` | Basic Auth 用户名（留空则不启用认证） |
| `pwd` | String | `""` | Basic Auth 密码 |
| `accessOrigin` | String | `"*"` | CORS 允许的来源 |
| `defaultSkip` | String | `""` | 未设置目标时跳转的默认 URL |
| `session.secret` | String | 随机生成 | Session 加密密钥 |
| `session.cookie_max_age` | Integer | `86400` | Session 过期时间（秒） |
| `limiter.windowMs` | Integer | `60` | 限流时间窗口（秒） |
| `limiter.max` | Integer | `60` | 时间窗口内最大请求数 |
| `blacklist` | Array | `[]` | 黑名单域名列表 |

------

## 🎮 使用指南 (Usage)

### 1. 开启代理会话

访问代理服务器并带上目标 URL：

```
http://your-server-ip:8082/?url=https://www.cloudflare-protected-site.com
```

**工作流程:**
1. 验证 URL 安全性 (SSRF 防护)
2. 建立 Session
3. 自动绕过 Cloudflare 验证 (如有)
4. 返回目标网页

### 2. 持续访问

Session 建立后，直接访问代理服务器的路径：

```
http://your-server-ip:8082/api/data
```

会自动转发到目标站点的 `/api/data`

### 3. 注入自定义请求头

```
http://your-server-ip:8082/?url=https://api.example.com&headers={"Authorization":"Bearer xxx"}
```

### 4. 动态调整策略

服务运行中发现需要调整限流？

1. 打开 `main.json`
2. 修改 `"max": 10` (每分钟 10 次)
3. 保存文件
4. **无需重启**，控制台提示 `[Config] 📝 File changed, reloading...`

------

## 📂 项目结构 (Structure)

```
backend/
├── main.py           # 🧠 核心逻辑 (Flask + Cloudscraper)
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
| IP 检测 | 使用 Python `ipaddress` 库检测私有、环回、链路本地、保留地址 |
| 域名黑名单 | 支持正则匹配的域名黑名单 |
| Header 净化 | 自动剔除 Hop-by-Hop headers 和 Cloudflare 相关头部 |

### 认证与限流

- **Basic Auth:** 配置 `user` 和 `pwd` 后生效
- **Flask-Limiter:** 基于 IP 的请求限流，存储于内存

------

## ☁️ Cloudflare 绕过原理 (How it works)

本项目使用 [cloudscraper](https://github.com/VeNoMouS/cloudscraper) 库绕过 Cloudflare 的 JavaScript 挑战：

1. **模拟浏览器环境:** 设置真实的 User-Agent 和浏览器指纹
2. **自动处理 JS 挑战:** 解析并执行 Cloudflare 的 JavaScript 验证代码
3. **Cookie 持久化:** 保存验证通过后的 Cookie，避免重复验证

**支持的 Cloudflare 保护类型:**
- ✅ JavaScript Challenge (5秒盾)
- ✅ Browser Integrity Check
- ⚠️ CAPTCHA (需要额外配置)

------

## 🔧 生产环境部署 (Production)

### 使用 Supervisor 部署

```ini
[program:reverse-proxy]
command=/usr/local/bin/gunicorn -w 4 -b 0.0.0.0:8082 main:app
directory=/path/to/backend
user=www-data
autostart=true
autorestart=true
stderr_logfile=/var/log/reverse-proxy.err.log
stdout_logfile=/var/log/reverse-proxy.out.log
```

### 使用 systemd 部署

```ini
[Unit]
Description=Reverse Proxy Service
After=network.target

[Service]
User=www-data
WorkingDirectory=/path/to/backend
ExecStart=/usr/local/bin/gunicorn -w 4 -b 0.0.0.0:8082 main:app
Restart=always

[Install]
WantedBy=multi-user.target
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
        
        # 对于大文件/流媒体，增加超时
        proxy_read_timeout 300;
        proxy_send_timeout 300;
    }
}
```

------

## 📝 常见问题 (FAQ)

**Q: 为什么日志里有 \"Blocked Private/Local IP\"?**

A: 这是 SSRF 防御在工作。有人试图通过你的代理访问你服务器的内网服务（如本地数据库），已被成功拦截。

**Q: Cloudflare 绕过失败怎么办?**

A: 可能的原因：
1. Cloudflare 更新了验证逻辑 → 尝试更新 cloudscraper: `pip install -U cloudscraper`
2. 目标站点启用了 reCAPTCHA → 需要配置验证码解决服务
3. IP 被 Cloudflare 封禁 → 更换 IP 或使用代理

**Q: 支持 HTTPS 吗?**

A: 本程序作为反代客户端支持访问 HTTPS 目标。如果你希望本服务本身通过 HTTPS 访问，建议在前方再挂一个 Nginx 处理 SSL 证书。

------

## 📦 依赖列表 (Requirements)

```
flask>=2.0.0
flask-session>=0.5.0
flask-limiter>=3.0.0
watchdog>=3.0.0
cloudscraper>=1.2.71
requests>=2.28.0
```

保存为 `requirements.txt` 后可使用 `pip install -r requirements.txt` 安装。

------

## 📜 许可证 (License)

MIT License.

------

**Made with ❤️ by [Iskongkongyo](https://github.com/Iskongkongyo)**