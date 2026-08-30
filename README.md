# proxyWeb

轻量的浏览器 API 调试界面与 Node.js HTTP 代理实验项目。当前版本可用于本地开发和受信网络中的 API 调试；vNext 计划在此基础上补齐安全边界、测试体系和 Browser Proxy 能力。

![界面预览](./vue-request-app/review.png)

> [!WARNING]
> P0 网络安全与基础架构门禁已通过，但进程内 Session Store、旧查询兼容面和后续 Browser 隔离仍有限制，**不要直接暴露为生产级开放代理**。完整问题和改造顺序见 [vNext 开发计划与技术方案](./proxyWeb%20vNext%20开发计划与技术方案.md)。

## 当前能力

| 模块 | 已实现 |
| --- | --- |
| API 请求 | GET、POST、PUT、DELETE、PATCH、HEAD；查询参数；自定义请求头 |
| 请求体 | URL 编码表单、multipart 文件、JSON、纯文本 |
| 上游认证 | Basic Auth、Bearer Token |
| 响应 | JSON/文本格式化、响应头、图片/音视频预览、文件下载 |
| 本地功能 | 响应式界面、分享链接、浏览器本地历史记录 |
| 后端 | API/Browser 分路由、Canonical URL、HTML/CSS/Location 重写、Session Cookie Jar、Header 映射、受限响应变换、流式转发、共享安全网络内核与限流 |

当前 Browser Route 已支持常见 HTML 属性、`srcset`、`<base>`、Meta Refresh、内联/独立 CSS、安全 Location、Session Cookie Jar 与 Origin/Referer 映射，但还没有完整的网页反向代理能力；WebSocket 和 SPA 动态请求兼容仍属于后续 vNext 阶段。

## 目录结构

```text
proxyWeb/
├── backend/
│   ├── main.json.example        # 后端配置模板
│   ├── echo.js                  # 独立回显服务（开发辅助）
│   └── nodejs/
│       ├── main.js              # 进程启动与关闭入口
│       ├── app.js               # Express App Factory 与模式路由装配
│       ├── api-proxy/           # API Route 与响应策略
│       ├── browser-proxy/       # Browser Route 骨架与响应策略
│       ├── config/              # 默认值、Schema 与配置加载
│       ├── core/                # 安全网络内核、UrlMapper、日志、Header 与错误模块
│       ├── middleware/          # 请求日志等 Express 中间件
│       ├── main.json            # 当前本地配置
│       └── README.md            # 后端说明
├── vue-request-app/             # Vue 3 前端
│   ├── src/
│   ├── package.json
│   └── README.md                # 前端说明
├── docs/
│   └── vnext-implementation-roadmap.md  # vNext 分阶段实施路线图
└── proxyWeb vNext 开发计划与技术方案.md
```

## 快速开始

建议使用 Node.js 22+。前后端均已提交依赖锁文件，使用 `npm ci` 可复现安装。

### 1. 启动后端

在仓库根目录执行：

```powershell
Set-Location .\backend\nodejs
npm ci
npm start
```

后端从**当前工作目录**读取 `./main.json`，因此应在 `backend/nodejs/` 内启动。若该文件不存在，可先把 `../main.json.example` 复制为 `./main.json`，并至少修改 `session.secret`。

默认监听 `http://localhost:8082`。

当前推荐的 API 入口是：

```text
ANY /__proxyweb/api?url=<percent-encoded-target>
```

旧 `/?url=...` 仅作为兼容 Adapter 保留，并返回 `Deprecation`、`Warning` 与后继路由 `Link`。`/__proxyweb/browser?url=...` 是 Browser Mode 的独立入口，默认由 `browser.enabled: false` 关闭；开启后会先校验目标，再 302 到 `/__proxyweb/browser/<originToken>/...` Canonical URL。Token 只标识 origin，每次请求仍执行完整安全校验；HTML 中可映射的静态 URL 会改写到对应 Canonical 路由。

### 2. 启动前端

另开一个终端，在仓库根目录执行：

```powershell
Set-Location .\vue-request-app
npm ci
npm run serve
```

由于前端的 `publicPath` 和路由基址都是 `/web/`，开发地址是：

```text
http://localhost:8080/web/
```

前端默认请求 `http://localhost:8082`。如需修改，在启动或构建前设置 `VUE_APP_PROXY_URL`；这是 Vue CLI 的**构建时变量**：

```powershell
$env:VUE_APP_PROXY_URL = "https://proxy.example.com"
npm run serve
```

### 3. 生产构建

```powershell
Set-Location .\vue-request-app
npm run build
```

产物位于 `vue-request-app/dist/`。后端只会从其工作目录下的 `webPro/` 提供静态文件，因此若希望由 Node.js 一并托管前端，需要把 `dist/` 的内容部署到 `backend/nodejs/webPro/`，然后访问后端的 `/web/`。

## 配置

以 [backend/main.json.example](./backend/main.json.example) 为当前配置格式参考。常用字段如下：

| 字段 | 单位/含义 | 是否可热加载 |
| --- | --- | --- |
| `port` | 监听端口 | 否，需重启 |
| `trustProxy` | Express 信任代理策略；模板默认 `false` | 否，需重启 |
| `timeoutMs` | 上游请求超时，毫秒 | 是 |
| `user` / `pwd` | 代理自身 Basic Auth；两者均非空时启用 | 是 |
| `cors.allowedOrigins` | 允许的浏览器 Origin 数组 | 是 |
| `cors.allowCredentials` | 是否允许浏览器携带凭据；为 `true` 时禁止 `*` | 是 |
| `session.secret` | Session 签名密钥 | 否，需重启 |
| `session.maxAgeMs` | Cookie 生命周期，毫秒 | 否，需重启 |
| `limiter.windowMs` | 限流窗口，毫秒 | 是 |
| `limiter.max` | 每个窗口的请求数 | 是 |
| `security.blockedHostnames` | 精确主机或 `*.example.com` 子域规则；不接受正则 | 是 |
| `security.maxRewriteBytes` | Browser HTML/CSS 解压后的最大变换字节数，超限返回 413 | 是 |
| `api.followRedirects` | 是否启用 proxyWeb 安全逐跳循环 | 是 |
| `api.maxRedirects` | 安全逐跳循环的最大次数 | 是 |
| `api.connectTimeoutMs` | 每一跳 TCP/TLS 连接超时，毫秒 | 是 |
| `api.maxRequestBodyBytes` | 非 GET/HEAD 请求体与 Redirect 重放缓存上限，字节 | 是 |
| `api.maxConcurrentRequests` | 同时执行的代理请求上限，超出返回 503 | 是 |
| `browser.enabled` | 是否开放 Browser Route 骨架；默认关闭 | 是 |
| `browser.maxRedirects` | 兼容保留；Browser 3xx 已改为验证并返回 Canonical Location，不在服务端逐跳跟随 | 是 |
| `browser.cookieJar` | 是否在服务端 Session 内维护 upstream Cookie；默认开启 | 是 |
| `browser.headerPolicy` | `compat` 移除不兼容的嵌入/跨源策略头，`preserve` 保留；`strict` 为保留策略兼容值 | 是 |
| `browser.rewriteHtml` | 是否启用 HTML 属性、`srcset`、Meta Refresh 和内联 style URL 重写 | 是 |
| `browser.rewriteCss` | 是否启用 CSS `url()` 与 `@import` AST 重写 | 是 |

旧配置仍会迁移：`timeout` 按秒转换为 `timeoutMs`，`cookie_max_age` 按秒转换为 `session.maxAgeMs`，`session.cookie.maxAge` 保持毫秒，`accessOrigin`、`blacklist` 和 `max_redirects` 分别迁移到 `cors.allowedOrigins`、`security.blockedHostnames` 与 `api.maxRedirects`。旧 `accessOrigin: "*"` 会以 `allowCredentials: false` 迁移；旧黑名单值按精确主机或前导通配子域规则校验，不再作为正则执行。迁移会记录弃用警告，建议按模板尽快更新。

## 当前安全边界

- URL Validator 已拒绝非 HTTP(S) 协议、URL credentials、非法编码、localhost，以及 loopback/private/link-local/unspecified/multicast/reserved 等字面 IPv4/IPv6。域名使用 `lookup(all: true, verbatim: true)` 校验全部 A/AAAA，任一结果非公网即整体拒绝；请求级 HTTP/HTTPS Agent 的 `lookup` 只能返回该验证集合，并保持原 hostname、Host、SNI 和严格 TLS 证书校验。
- Axios 自身固定 `maxRedirects: 0`；启用 `api.followRedirects` 时由 proxyWeb 处理 301/302/303/307/308，每一跳重新执行 URL、DNS 与 Pinning 校验。跨域跳转会删除认证、Cookie、Token、Secret 与 API Key 类 Header，循环或超限返回 508。
- 代理请求同时受 `timeoutMs`、`api.connectTimeoutMs`、`api.maxRequestBodyBytes` 与 `api.maxConcurrentRequests` 约束；客户端断开会取消上游，异常响应流由管道边界回收。API 响应仍保持流式转发，不受 Rewrite 缓冲上限影响。
- Browser Mode 只有 HTML/CSS 进入 `maxRewriteBytes` 限制的解压、Charset 解码、UTF-8 输出与重新压缩流程；gzip/deflate/br 均按解压后大小计数。HTML 使用 Parser 重写 allowlist 属性、`srcset`、`<base>`、Meta Refresh 与内联 CSS，独立 CSS 使用 AST 重写 `url()`/`@import`；相对 CSS URL 基于样式表自身地址。Browser 301/302/303/307/308 会先验证 Location，再返回 Canonical Location 交由浏览器处理，不在服务端吞掉跳转。实际子请求与跳转目标仍执行完整 SSRF/DNS/Pinning 校验。SSE、206、附件、`no-transform`、音视频、PDF 和二进制保持流式。
- Browser Cookie Jar 仅由服务端按 proxyWeb Session 保存，并按 upstream Domain、Path、Secure 与 Expiry 匹配；入站 proxyWeb Cookie 不会直接转发，上游 `Set-Cookie` 也不会设置到 proxyWeb 域名。Canonical Referer 会映射回完整 upstream URL，Origin 只取已验证的来源页面 origin；来源未知时使用 `null`，不会把跨站请求伪装成与目标同源。
- 未捕获异常和未处理 Promise rejection 不再作为可继续运行的恢复机制，而会停止接收连接、关闭 runtime，并在超时后强制退出。
- 代理自身 Basic Auth 已与上游认证隔离：普通 `Authorization` 只用于代理鉴权，上游认证使用 `X-ProxyWeb-Upstream-Authorization`。
- 旧 `headers` 查询参数仍为兼容而接受，并会返回弃用提示；新版前端不再用它发送 Header，也不会把敏感 Header 写入分享/API 链接或历史。目标 URL 自身若包含 Token 仍可能进入浏览器历史和剪贴板。
- CORS 使用显式 Origin allowlist；非法或未授权 Origin 会被拒绝，无 Origin 请求不会获得 CORS 响应头。`allowCredentials: true` 与 `allowedOrigins: ["*"]` 的组合会在配置加载时被拒绝。
- `trustProxy` 的模板、内置默认值和旧配置补全值均为 `false`，限流默认以直连地址识别客户端并忽略伪造的 `X-Forwarded-For`。只有位于可信反向代理后方时，才应按实际代理跳数或地址显式启用。
- Express Session 与 Browser SessionStateStore 当前都使用进程内存，不适合多实例或长期生产运行；服务端 Jar 也无法让目标脚本通过 `document.cookie` 读取 upstream Cookie。

P0 的逐项证据见 [自动化验收矩阵](./docs/p0-verification-matrix.md)。更详细的运行方式与剩余限制见 [后端文档](./backend/nodejs/README.md)，前端数据与构建说明见 [前端文档](./vue-request-app/README.md)。

## P0 自动化门禁

从仓库根目录执行完整的锁文件安装与验收：

```powershell
node scripts/p0-gate.js --install
```

已完成依赖安装时可省略 `--install`。当前门禁会执行后端 161 项测试与语法检查、前端 4 项回归测试、lint 和生产构建；任一步骤失败都会非零退出。只有最终输出 `P0 gate PASS` 才表示验收通过。

## 文档索引

- [前端 README](./vue-request-app/README.md)
- [Node.js 后端 README](./backend/nodejs/README.md)
- [vNext 开发计划与技术方案](./proxyWeb%20vNext%20开发计划与技术方案.md)
- [vNext 分阶段实施路线图](./docs/vnext-implementation-roadmap.md)
- [P0 自动化验收矩阵](./docs/p0-verification-matrix.md)

## 许可证状态

仓库当前没有 `LICENSE` 文件，因此暂不声明具体开源许可证。发布或接受外部贡献前，建议补充正式许可证文件，并再恢复许可证徽章与声明。
