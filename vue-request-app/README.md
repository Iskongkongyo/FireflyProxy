# 🌐 PostmanWeb - 在线代理网站

> **随时随地，无需安装！** 这是一个基于 Vue 3 + Element Plus 构建的现代化 Web API 调试工具。功能参考 Postman，却无需任何安装，打开浏览器即可使用。

![Preview](./review.png)

## ✨ 核心亮点 (Key Features)

- **🚀 零安装体验:** 无需下载客户端，浏览器直接访问，随用随走。
- **📱 响应式设计:** 完美适配 PC 和移动端，手机上也能调试 API。
- **🎨 Element Plus UI:** 基于 Vue 3 生态，现代化的 UI 设计，操作流畅。
- **🔐 多种认证方式:** 支持 Basic Auth、Bearer Token 等多种认证模式。
- **📦 全方法支持:** 支持 GET、POST、PUT、DELETE、PATCH、HEAD 等所有 HTTP 方法。
- **🎬 流媒体播放:** 智能识别音视频链接，支持边加载边播放的流媒体模式。
- **📋 一键复制分享:** 快速复制当前配置的页面链接或 API 接口，方便分享与协作。
- **📜 历史记录:** 自动保存请求历史，支持快速回溯和重放。

------

## 🛠️ 技术栈 (Tech Stack)

| 类别     | 技术                           |
| -------- | ------------------------------ |
| 框架     | Vue 3                          |
| UI 组件  | Element Plus                   |
| 路由     | Vue Router 4                   |
| HTTP 客户端 | Axios                      |
| 代码高亮 | Highlight.js                   |
| 构建工具 | Vue CLI 5                      |

------

## 🚀 快速开始 (Quick Start)

### 1. 环境准备

确保你的开发环境已安装 Node.js (建议 16.x 或更高版本)。

### 2. 安装依赖

```bash
npm install
```

### 3. 配置代理服务器

编辑 `src/config.js` 文件，设置后端代理服务器地址：

```javascript
export const PROXY_CONFIG = {
    // 代理服务器地址 - 开发环境使用 localhost，生产环境改为实际部署地址
    BASE_URL: process.env.VUE_APP_PROXY_URL || 'http://localhost:8082',

    // 请求超时时间 (毫秒)
    TIMEOUT: 60000,
};
```

### 4. 启动开发服务器

```bash
npm run serve
```

访问 `http://localhost:8080` 即可使用。

### 5. 生产环境构建

```bash
npm run build
```

构建产物将输出到 `dist/` 目录。

------

## 📂 项目结构 (Project Structure)

```
vue-request-app/
├── public/              # 静态资源目录
├── src/
│   ├── assets/          # 图片、字体等资源
│   ├── components/      # Vue 组件
│   │   ├── Index.vue        # 🏠 主页面 - 请求构建与发送
│   │   ├── ActionButtons.vue # 🎛️ 操作按钮组件
│   │   ├── RequestBody.vue   # 📝 请求体编辑器
│   │   ├── ResponseViewer.vue# 📺 响应内容展示器
│   │   ├── UserAuth.vue      # 🔐 用户认证组件
│   │   └── History.vue       # 📜 历史记录页面
│   ├── plugins/         # 插件配置 (Element Plus)
│   ├── router/          # 路由配置
│   ├── utils/           # 工具函数
│   ├── config.js        # ⚙️ 应用配置文件
│   ├── App.vue          # 根组件
│   └── main.js          # 入口文件
├── package.json         # 项目依赖
└── vue.config.js        # Vue CLI 配置
```

------

## 🎮 使用指南 (Usage Guide)

### 1. 发送 GET 请求

1. 在 URL 输入框中输入目标地址，如 `https://api.github.com/users/octocat`
2. 选择请求方法为 `GET`
3. 点击「发送请求」按钮
4. 在下方查看 JSON 格式化后的响应结果

### 2. 发送带认证的请求

1. 点击「验证类型」选项卡
2. 选择认证方式（如 Bearer Token）
3. 输入你的 Token
4. 切换回参数或请求头页签，发送请求

### 3. 发送 POST 请求

1. 选择请求方法为 `POST`
2. 点击「请求体」选项卡
3. 选择 Content-Type（如 `application/json`）
4. 输入请求体内容
5. 发送请求

### 4. 流媒体播放

对于视频/音频链接（.mp4, .mp3, .m3u8 等），系统会自动启用流媒体模式：
- 无需等待完整下载，边加载边播放
- 支持视频进度条拖拽

### 5. 分享配置

- **复制页面链接:** 复制当前配置，分享给他人可直接打开相同配置的页面
- **复制 API 链接:** 生成可直接调用的代理 API 地址

------

## ⚙️ 环境变量 (Environment Variables)

可通过 `.env` 文件或环境变量配置：

| 变量名               | 说明                | 默认值                    |
| -------------------- | ------------------- | ------------------------- |
| `VUE_APP_PROXY_URL`  | 后端代理服务器地址  | `http://localhost:8082`   |

------

## 🔗 配合后端使用

本前端需要配合后端代理服务使用。项目提供两种后端实现：

| 后端     | 特点                                           | 文档                          |
| -------- | ---------------------------------------------- | ----------------------------- |
| Node.js  | 基于 Express，配置热更新，适合通用场景         | `../backend/README(nodejs).md` |
| Python   | 基于 Flask，内置 Cloudflare 绕过，适合特殊场景 | `../backend/README(python).md` |

------

## 🤝 贡献 (Contributing)

欢迎提交 Issue 或 Pull Request！

1. Fork 本仓库
2. 创建你的功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开一个 Pull Request

## 📜 许可证 (License)

MIT License - 随便用！

------

*Made with ❤️ by [Iskongkongyo](https://github.com/Iskongkongyo)*
