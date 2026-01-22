# 🌐 PostmanWeb

<div align="center">

![Preview](./vue-request-app/review.png)

**一个无需安装的在线 API 调试工具，支持自建代理服务器，轻松调试任意 API。**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)[![Vue](https://img.shields.io/badge/Vue-3.x-brightgreen.svg)](https://vuejs.org/)[![Node.js](https://img.shields.io/badge/Node.js-16+-green.svg)](https://nodejs.org/)[![Python](https://img.shields.io/badge/Python-3.8+-blue.svg)](https://python.org/)

[在线演示](#-在线演示) • [功能特性](#-功能特性) • [快速开始](#-快速开始) • [文档](#-详细文档)

---

## 📖 项目介绍

**PostmanWeb** 是一个类似 Postman 的 Web 版 API 调试工具，但无需安装任何客户端。它由两部分组成：

1. **前端界面** - 基于 Vue 3 + Element Plus 构建的现代化 Web 应用
2. **后端代理** - 支持 Node.js 和 Python 两种实现，解决浏览器跨域限制

### 为什么需要后端代理？

由于浏览器的同源策略 (CORS) 限制，前端无法直接请求第三方 API。后端代理服务作为中转，帮你绕过这个限制。

---

## ✨ 功能特性

| 特性 | 说明 |
|------|------|
| 🚀 **零安装** | 浏览器直接访问，随用随走 |
| 📱 **响应式设计** | 完美适配 PC 和移动端 |
| 🔐 **多种认证** | 支持 Basic Auth、Bearer Token 等 |
| 📦 **全方法支持** | GET、POST、PUT、DELETE、PATCH、HEAD |
| 🎬 **流媒体播放** | 智能识别音视频，边加载边播放 |
| 📋 **一键分享** | 复制页面链接或 API 接口 |
| 📜 **历史记录** | 自动保存，支持快速回溯 |
| ☁️ **Cloudflare 绕过** | Python 版支持穿透 5 秒盾 |
| 🔥 **配置热重载** | 修改配置无需重启服务 |
| 🛡️ **SSRF 防护** | 内置安全防护，拒绝内网渗透 |

---

## 🏗️ 项目架构

```
PostmanWeb/
├── vue-request-app/     # 🖥️ 前端项目 (Vue 3 + Element Plus)
│   ├── src/
│   │   ├── components/  # Vue 组件
│   │   ├── config.js    # 代理服务器配置
│   │   └── ...
│   └── README.md        # 前端文档
│
└── backend/             # 🔧 后端项目 (二选一)
    ├── main.js          # Node.js 版 (Express + Axios)
    ├── main.py          # Python 版 (Flask + Cloudscraper)
    ├── main.json        # 配置文件 (热更新)
    ├── README(nodejs).md  # Node.js 文档
    └── README(python).md  # Python 文档
```

---

## 🚀 快速开始

### 第一步：启动后端代理

根据你的技术栈选择一个后端：

<details>
<summary><b>🟢 Node.js 版（推荐通用场景）</b></summary>

```bash
cd backend

# 安装依赖
npm install express axios express-rate-limit chokidar express-session basic-auth ipaddr.js winston

# 启动服务
node main.js
```

<details>
<summary><b>🐍 Python 版（需要绕过 Cloudflare 人机验证时可用）</b></summary>
```bash
cd backend

# 安装依赖
pip install flask flask-session flask-limiter watchdog cloudscraper requests

# 启动服务
python main.py
```

启动成功后，代理服务运行在 `http://localhost:8082`

### 第二步：启动前端

```bash
cd vue-request-app

# 安装依赖
npm install

# 启动开发服务器
npm run serve
```

访问 `http://localhost:8080` 即可使用！

---

## 📚 详细文档

| 模块 | 文档链接 | 说明 |
|------|----------|------|
| 🖥️ 前端 | [vue-request-app/README.md](./vue-request-app/README.md) | 技术栈、使用指南、项目结构 |
| 🟢 Node.js 后端 | [backend/README(nodejs).md](./backend/README(nodejs).md) | 配置详解、安全机制、生产部署 |
| 🐍 Python 后端 | [backend/README(python).md](./backend/README(python).md) | Cloudflare 绕过、Gunicorn 部署 |

---

## 🆚 后端版本对比

| 特性 | Node.js 版 | Python 版 |
|------|------------|-----------|
| Cloudflare 5秒盾绕过 | ❌ | ✅ |
| 并发性能 | ⚡ 高 | 🐢 适中 |
| 依赖管理 | npm | pip |
| 生产部署 | PM2 | Gunicorn |
| 适用场景 | 通用 API 代理 | 需绕过 Cloudflare |

**选择建议：**
- 如果只是普通 API 调试 → 选 **Node.js 版**
- 如果目标网站有 Cloudflare 保护 → 选 **Python 版**

---

## ⚙️ 配置说明

后端配置文件 `backend/main.json`：

```json
{
  "port": 8082,
  "timeout": 30,
  "user": "admin",
  "pwd": "password",
  "accessOrigin": "*",
  "limiter": {
    "windowMs": 60000,
    "max": 60
  },
  "blacklist": []
}
```

前端配置文件 `vue-request-app/src/config.js`：

```javascript
export const PROXY_CONFIG = {
    BASE_URL: 'http://localhost:8082',  // 后端地址
    TIMEOUT: 60000,
};
```

---

## 🔒 安全提示

1. **生产环境务必配置认证** - 设置 `user` 和 `pwd`
2. **修改 Session 密钥** - 替换 `session.secret` 为强密码
3. **启用 HTTPS** - 在 Nginx 层配置 SSL 证书

---

## 🤝 贡献

欢迎提交 Issue 或 Pull Request！

---

## 📜 许可证

[MIT License](LICENSE)

---

<div align="center">

**Made with ❤️ by [Iskongkongyo](https://github.com/Iskongkongyo)**

⭐ 如果这个项目对你有帮助，请给个 Star！
