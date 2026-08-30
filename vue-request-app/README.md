# proxyWeb 前端

基于 Vue 3、Element Plus 和 Vue CLI 5 的浏览器 API 请求界面。它负责组装请求、展示响应和保存本地历史；跨域请求由 [Node.js 后端](../backend/nodejs/README.md) 转发。

![界面预览](./review.png)

## 已实现功能

- GET、POST、PUT、DELETE、PATCH、HEAD 请求。
- 可逐行启停的查询参数和自定义请求头。
- Basic Auth、Bearer Token 上游认证。
- URL 编码表单、multipart 文件、JSON 和纯文本请求体。
- JSON/文本、响应头、图片、音视频和下载响应展示。
- 复制页面配置链接、复制代理 API 链接。
- 安全 Import cURL 与 POSIX Shell 格式的 Copy as cURL。
- 使用 `localStorage` 保存请求历史。
- PC 与移动端布局。
- “API 请求 / 网页代理”模式切换和独立 `/web/browser` 启动页。
- Browser Proxy 默认新标签页打开，提供跨 Origin sandbox iframe 预览和可折叠兼容设置。

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
| `npm test` | 运行零依赖安全与 Browser URL 工具测试 |

### 已验证状态

2026-08-29 使用 Node.js 22.19.0 / npm 11.6.2 验证：`npm test`、`npm run lint` 和 `npm run build` 均成功。生产依赖已更新到兼容版本，`npm audit --omit=dev` 为 0 个已知漏洞。当前构建仍有以下状态需要跟踪：

- 生产入口约 1.74 MiB，vendor JS 约 1.33 MiB，超过 Webpack 的性能建议阈值。
- 不带 `--omit=dev` 的完整审计仍报告 Vue CLI 5/Webpack 开发工具链中的 17 个间接公告（11 moderate、6 high）；npm 的 `--force` 建议会破坏性降级到 Vue CLI 3，因此未采用。后续应迁移到仍受维护的构建工具链，而不是强制改锁文件。

## 后端地址配置

`src/config.js` 分别支持：

```js
API_BASE_URL: process.env.VUE_APP_PROXY_API_URL || process.env.VUE_APP_PROXY_URL
BROWSER_BASE_URL: process.env.VUE_APP_PROXY_BROWSE_URL || process.env.VUE_APP_PROXY_URL
```

三个字段都是 Vue CLI 构建时变量，修改后需要重新启动开发服务器或重新构建。推荐将 Browser Proxy 放在与管理 UI 不同的 Origin：

```powershell
$env:VUE_APP_PROXY_API_URL = "https://api.proxy.example.com"
$env:VUE_APP_PROXY_BROWSE_URL = "https://browse.proxy.example.net"
npm run build
```

未配置新字段时会回退到 `VUE_APP_PROXY_URL`，全部未配置时回退到 `http://localhost:8082`，因此旧部署保持兼容。末尾 `/` 会被安全规范化。

## 使用说明

1. 输入包含 `http://` 或 `https://` 的完整目标 URL。
2. 选择 HTTP 方法。
3. 在“请求参数”“请求头”“请求验证”中补充配置；每行可独立启停。非 GET/HEAD 请求可在“请求体”中选择 none、Raw、JSON、URL 编码或 multipart，并为 multipart 文件字段逐项选择本地文件。
4. 点击“发送请求”，在下方查看内容、响应头、耗时和大小。

“Import cURL”只解析静态 HTTP(S) cURL 文本，不运行 Shell、读取路径或发起请求；导入的 `@file` 必须在文件选择器中重新授权。“Copy as cURL”输出 POSIX Shell 单引号转义格式，若包含 Auth 或敏感 Header 会先二次确认。PowerShell/`cmd.exe` 不能保证直接复用该格式，完整契约见 [请求编辑器与 cURL 契约](../docs/request-editor-curl-contract.md)。

网页代理页位于 `/web/browser`：输入完整 HTTP(S) URL 后默认在无 opener 的新标签页打开。高级设置可以为当前 Browser Session 关闭 HTML/CSS Rewrite、Runtime Bridge、WebSocket Proxy、Cookie Jar 或 Compatibility Headers，但不能打开后端全局禁用的能力。Runtime Bridge 映射 Request/fetch、XHR、EventSource、WebSocket、window.open 与 History 动态 URL；Runtime 与 WebSocket 后端能力均默认关闭，需分别显式启用。嵌入预览只有在 Browser Proxy 与管理 UI 不同 Origin 时可选，并可能受第三方 Cookie、目标站 CSP/防嵌入策略和浏览器隐私设置影响。

手工填写的 `Authorization` 请求头优先于“请求验证”面板生成的值。发送时该值会放入 `X-ProxyWeb-Upstream-Authorization`，不会进入代理 URL；其他自定义 Header 直接作为到 proxyWeb 的 HTTP Header 发送。带自定义 Header 或上游认证的媒体请求会回退到 Axios Blob，只有无额外 Header 时才使用原生媒体 URL 流式加载。项目没有集成 HLS 播放器，因此 `.m3u8` 并非在所有浏览器中都可直接播放。

## 分享与本地数据安全

> [!CAUTION]
> 新版前端不会把敏感请求头写入页面分享链接、复制的 API 链接或历史记录，但目标 URL 自身的查询参数仍可能包含 Token。分享前仍需检查目标 URL。

- “复制页面链接”只保留方法、参数和非敏感请求头；Authorization、Cookie、Token、Secret、Password 和 API Key 类 Header 会被过滤。
- “复制 API 接口”不再包含任何请求头，调用者需要通过实际 HTTP Header 单独设置。
- 历史记录保存在当前站点的 `localStorage.history` 中，其中使用同一套敏感 Header 过滤规则。
- 页面分享与历史不会保存 Body/Auth；Copy as cURL 是显式的完整请求导出，确认后可能包含凭据，应按密码处理。
- 旧页面链接中的 `headers` 字段仍可被读取以便迁移；重新发送时会自动走安全 Header 通道，但不应再次分享旧链接。

后端仍兼容旧代理 URL 的 `headers` 查询参数，但会返回弃用提示；新版前端不再生成它。清理旧数据时可在“历史”页面点击“清空所有”，也可清除该站点的浏览器存储。

API 请求页的手工 Cookie 输入仍属于旧兼容行为，不等价于 Browser Cookie Jar。网页代理页使用后端按 Session 隔离的 upstream Cookie Jar，但服务端 Jar 无法让目标脚本通过 `document.cookie` 读取 upstream Cookie。

## 构建与部署

```powershell
npm run build
```

构建产物在 `dist/`。两种部署方式：

- 独立静态站点：Web Server 必须把 `/web/*` 的 history fallback 指向 `/web/index.html`。
- 随 Node.js 后端部署：把 `dist/` 内容复制到 `backend/nodejs/webPro/`，通过 `https://your-host/web/` 访问。

若前后端不同源，请把前端的规范 Origin（例如 `https://app.example.com`）加入后端 `cors.allowedOrigins`。需要 Cookie/HTTP 认证时再启用 `cors.allowCredentials`；该选项不能与 `*` 同时使用。公开部署前仍须阅读 [后端安全限制](../backend/nodejs/README.md#当前安全限制)。

## 项目结构

```text
vue-request-app/
├── public/                  # 静态资源
├── src/
│   ├── components/
│   │   ├── Index.vue        # 请求编排
│   │   ├── BrowserProxy.vue # 网页代理启动与兼容设置
│   │   ├── ModeSwitcher.vue # API/网页代理模式切换
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
├── tests/                   # Header 与 Browser URL 零依赖测试
├── package.json
├── package-lock.json
└── vue.config.js
```

## 当前限制

- 已有 23 项零依赖 Node Test 覆盖敏感 Header、分享过滤、安全 API 传输、请求行/Body/cURL 契约、Browser URL/偏好构造和 iframe Origin 边界；仓库级 P1/P2 门禁已通过真实 Chromium 覆盖 Browser Core、Runtime/WebSocket 与 Origin Isolation 页面链路。Vue 组件挂载级测试仍未单独引入。
- Vue CLI 5 开发工具链仍有上述仅开发依赖审计项；生产依赖审计已清零。
- 普通 GET 响应会先完整读取为 Blob；除按扩展名识别的媒体外，不属于真正的浏览器端流式展示。
- API 请求页仍把 HTML 响应作为文本或 Blob 处理；只有独立网页代理页会进入后端 HTML/CSS/Location Rewrite。
- API 请求页手工 Cookie 仍是旧兼容行为，不能完整复现 cURL Cookie 语义；网页代理 Cookie 请使用后端 Session Jar。
- 项目只包含 Node.js 后端，没有 Python 后端。

完整改造范围见 [vNext 开发计划](../proxyWeb%20vNext%20开发计划与技术方案.md)。
