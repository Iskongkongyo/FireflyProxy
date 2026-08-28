# proxyWeb 前端

基于 Vue 3、Element Plus 和 Vue CLI 5 的浏览器 API 请求界面。它负责组装请求、展示响应和保存本地历史；跨域请求由 [Node.js 后端](../backend/nodejs/README.md) 转发。

![界面预览](./review.png)

## 已实现功能

- GET、POST、PUT、DELETE、PATCH、HEAD 请求。
- 查询参数和自定义请求头。
- Basic Auth、Bearer Token 上游认证。
- URL 编码表单、multipart 文件、JSON 和纯文本请求体。
- JSON/文本、响应头、图片、音视频和下载响应展示。
- 复制页面配置链接、复制代理 API 链接。
- 使用 `localStorage` 保存请求历史。
- PC 与移动端布局。

## 本地开发

建议使用 Node.js 22+。

```powershell
Set-Location .\vue-request-app
npm ci
npm run serve
```

开发地址为 `http://localhost:8080/web/`，不是站点根路径。`vue.config.js` 的 `publicPath` 与 Vue Router 的 history base 均为 `/web/`。

可用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run serve` | 启动开发服务器 |
| `npm run build` | 构建到 `dist/` |
| `npm run lint` | 运行 ESLint |

### 已验证状态

2026-08-28 使用 Node.js 22.19.0 / npm 11.6.2 验证：`npm ci`、`npm run lint` 和 `npm run build` 均成功。当前构建仍会报告以下非阻塞警告：

- `caniuse-lite` / Browserslist 数据约 19 个月未更新。
- 生产入口约 1.62 MiB，vendor JS 约 1.26 MiB，超过 Webpack 的性能建议阈值。
- 安装过程会提示 ESLint 7、Glob 7、Rimraf 3 等间接依赖已弃用；后续应评估 Vue CLI 5 工具链升级。

## 后端地址配置

`src/config.js` 使用：

```js
BASE_URL: process.env.VUE_APP_PROXY_URL || 'http://localhost:8082'
```

`VUE_APP_PROXY_URL` 是 Vue CLI 构建时变量，修改后需要重新启动开发服务器或重新构建：

```powershell
$env:VUE_APP_PROXY_URL = "https://proxy.example.com"
npm run build
```

不要在变量值末尾添加 `/`，当前代码会自行拼接 `/?url=...`。

## 使用说明

1. 输入包含 `http://` 或 `https://` 的完整目标 URL。
2. 选择 HTTP 方法。
3. 在“请求参数”“请求头”“请求验证”中补充配置；非 GET/HEAD 请求可在“请求体”中选择发送格式。
4. 点击“发送请求”，在下方查看内容、响应头、耗时和大小。

手工填写的 `Authorization` 请求头优先于“请求验证”面板生成的值。媒体 URL 仅按扩展名识别；播放能力取决于浏览器原生编解码、目标服务的 Range 行为和响应类型。项目没有集成 HLS 播放器，因此 `.m3u8` 并非在所有浏览器中都可直接播放。

## 分享与本地数据安全

> [!CAUTION]
> 当前实现会把请求头写进 URL 查询参数；页面分享链接、复制的 API 链接和历史记录都可能包含 `Authorization` 等秘密。

- “复制页面链接”会把方法、参数和请求头编码进页面 URL。
- “复制 API 接口”会把自定义请求头编码进代理 URL 的 `headers` 参数。
- 历史记录保存在当前站点的 `localStorage.history` 中，其中保存的是上述页面链接。
- 浏览器历史、剪贴板、代理访问日志和任何收到分享链接的人都可能看到其中的 Token。

因此，当前版本只应使用临时或低权限凭据。清理时可在“历史”页面点击“清空所有”，也可清除该站点的浏览器存储。vNext 计划改为通过实际请求头传递上游认证，并弃用敏感的 `headers` 查询参数。

Cookie 输入目前尝试写入 proxyWeb 当前域名的 `document.cookie`，并不等价于独立的上游 Cookie Jar；复杂登录站点不能依赖该功能。

## 构建与部署

```powershell
npm run build
```

构建产物在 `dist/`。两种部署方式：

- 独立静态站点：Web Server 必须把 `/web/*` 的 history fallback 指向 `/web/index.html`。
- 随 Node.js 后端部署：把 `dist/` 内容复制到 `backend/nodejs/webPro/`，通过 `https://your-host/web/` 访问。

若前后端不同源，后端 `accessOrigin` 需要与前端来源匹配。当前 CORS 实现仍有安全待办，公开部署前请阅读 [后端安全限制](../backend/nodejs/README.md#当前安全限制)。

## 项目结构

```text
vue-request-app/
├── public/                  # 静态资源
├── src/
│   ├── components/
│   │   ├── Index.vue        # 请求编排
│   │   ├── ActionButtons.vue
│   │   ├── RequestBody.vue
│   │   ├── ResponseViewer.vue
│   │   ├── UserAuth.vue
│   │   └── History.vue
│   ├── plugins/             # Element Plus 图标
│   ├── router/              # /web/ 路由配置
│   ├── utils/               # 请求与错误处理工具
│   ├── config.js
│   ├── App.vue
│   └── main.js
├── package.json
├── package-lock.json
└── vue.config.js
```

## 当前限制

- 没有自动化前端测试。
- 普通 GET 响应会先完整读取为 Blob；除按扩展名识别的媒体外，不属于真正的浏览器端流式展示。
- HTML 响应只作为文本或新页面内容处理，不会重写其中的相对 URL、CSS、脚本或表单。
- 分享链接解析缺少面向恶意/损坏 JSON 参数的错误隔离。
- 项目只包含 Node.js 后端，没有 Python 后端。

完整改造范围见 [vNext 开发计划](../proxyWeb%20vNext%20开发计划与技术方案.md)。
