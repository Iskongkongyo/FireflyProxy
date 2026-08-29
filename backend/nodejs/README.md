# proxyWeb Node.js 后端

这是当前 API 代理的 Node.js 实现，基于 Express 和 Axios。`main.js` 只负责进程启动、异常记录和优雅关闭，`app.js` 通过 `createApp()` 创建可注入配置、可显式关闭的 Express runtime。API、Browser 与 Legacy Adapter 已分路由，并复用同一套 URL/DNS/Pinning/Redirect 安全执行器；各模式拥有独立 Header、响应与 CORS 策略。

> [!WARNING]
> P0 网络安全与基础架构门禁已通过，但当前实现仍以本地开发和受信网络测试为定位，**尚不适合作为生产级开放代理**。请先阅读“当前安全限制”和 [P0 验收矩阵](../../docs/p0-verification-matrix.md)。

## 运行结构

```text
main.js
  └── createApp()
        ├── app.js               # Express middleware 与代理路由
        ├── config/              # 默认值、Schema、迁移和加载
        ├── api-proxy/           # API Router 与忠实响应策略
        ├── browser-proxy/       # Browser Router 骨架与兼容策略
        ├── core/                # 共享执行器、UrlMapper、DNS/Pinning、Validator、日志与错误
        ├── middleware/          # request ID、请求日志与 Legacy Adapter
        ├── config watcher       # 可由 runtime.close() 关闭
        └── runtime.getConfig()  # 启动端口及当前配置
```

测试可通过 `createApp({ configPath, watchConfig: false })` 注入隔离配置而不自动监听端口。生产入口仍使用 `npm start`，现有 HTTP 接口和默认启动行为不变。

## 环境与安装

建议使用 Node.js 22+。依赖清单和锁文件已经提交，可复现安装：

```powershell
Set-Location .\backend\nodejs
npm ci
```

代码从进程的当前工作目录读取 `./main.json`，静态目录也按当前工作目录解析为 `./webPro`，所以请始终在 `backend/nodejs/` 中启动：

```powershell
npm start
```

若 `main.json` 不存在，把 `../main.json.example` 复制到此目录并修改。缺少配置文件时服务会使用内置默认值，但默认 Session secret 每次启动都会变化，且代理不会启用认证，不适合实际部署。

## 配置格式

[../main.json.example](../main.json.example) 是当前推荐模板：

```json
{
  "port": 8082,
  "trustProxy": false,
  "timeoutMs": 30000,
  "user": "",
  "pwd": "",
  "defaultSkip": "",
  "session": {
    "secret": "please-change-this-secret-in-production",
    "name": "proxySession",
    "resave": false,
    "saveUninitialized": false,
    "maxAgeMs": 86400000,
    "secure": false,
    "httpOnly": true,
    "sameSite": "lax"
  },
  "cors": {
    "allowedOrigins": ["http://localhost:8080"],
    "allowCredentials": true
  },
  "limiter": {
    "windowMs": 60000,
    "max": 60,
    "message": "Too many requests, please try again later.",
    "statusCode": 429
  },
  "security": {
    "ssrf": true,
    "allowPrivateNetworks": false,
    "blockedHostnames": [],
    "maxRewriteBytes": 5242880
  },
  "api": {
    "followRedirects": true,
    "maxRedirects": 5,
    "connectTimeoutMs": 5000,
    "maxRequestBodyBytes": 5242880,
    "maxConcurrentRequests": 64
  }
}
```

完整模板还包含 `browser` 段。`browser.enabled`、`browser.maxRedirects`、`browser.headerPolicy`、`rewriteHtml` 与 `rewriteCss` 已用于 Browser Route 和 Transform Pipeline；这两个 Rewrite 开关目前只控制文本是否进入受限变换流程，具体 HTML/CSS URL 改写仍从后续阶段实现。Cookie Jar 和 Runtime Bridge 字段仍是预留，不能据此认为对应功能已经实现。`security.blockedHostnames` 已用于目标主机校验；任何模式都不能绕过现有安全检查。

| 字段 | 类型/单位 | 当前行为 |
| --- | --- | --- |
| `port` | Number | 启动时读取；修改后必须重启 |
| `trustProxy` | Boolean/Number/String/String[] | 启动时应用到 Express；修改后必须重启 |
| `timeoutMs` | Number，毫秒 | 每次上游请求读取，可热加载 |
| `user` / `pwd` | String | 两者都非空时启用代理自身 Basic Auth |
| `cors.allowedOrigins` | String[] | 允许的规范 HTTP(S) Origin 或 `*`；非法/未授权 Origin 返回 403 |
| `cors.allowCredentials` | Boolean | 是否发送 Credentials CORS 响应头；为 `true` 时 Schema 禁止 `*` |
| `defaultSkip` | String | Session 尚无目标 URL 时的跳转地址 |
| `session.secret` | String | Session 签名密钥；中间件启动后不会热更新 |
| `session.maxAgeMs` | Number，毫秒 | Session Cookie 生命周期；需重启生效 |
| `session.secure` | Boolean | 仅 HTTPS 场景设为 `true`；需重启生效 |
| `session.httpOnly` / `sameSite` | Boolean/String | Session Cookie 属性；需重启生效 |
| `limiter.windowMs` | Number，毫秒 | 限流窗口；保存配置后重建限流器 |
| `limiter.max` | Number | 每个窗口允许的请求数 |
| `security.blockedHostnames` | String[] | 精确 hostname 或 `*.example.com` 子域规则；不接受正则，可热加载 |
| `security.maxRewriteBytes` | Number，字节 | Browser HTML/CSS 解压后的变换上限；超限返回 413；可热加载 |
| `api.followRedirects` | Boolean | 是否启用 proxyWeb 安全逐跳循环；Axios 自身始终禁止自动跳转；可热加载 |
| `api.maxRedirects` | Number | 安全逐跳循环的最大次数；可热加载 |
| `api.connectTimeoutMs` | Number，毫秒 | 每一跳 TCP/TLS 连接阶段的上限；可热加载 |
| `api.maxRequestBodyBytes` | Number，字节 | 非 GET/HEAD Body 与 Redirect 重放缓存上限；可热加载 |
| `api.maxConcurrentRequests` | Number | 同时执行的代理请求上限；超出返回 503；可热加载 |
| `browser.enabled` | Boolean | 是否开放 Browser Route 骨架；默认 `false`；可热加载 |
| `browser.maxRedirects` | Number | Browser Mode 独立安全逐跳上限；可热加载 |
| `browser.headerPolicy` | `compat` / `strict` | `compat` 移除 X-Frame-Options/CSP，`strict` 保留；可热加载 |
| `browser.rewriteHtml` / `rewriteCss` | Boolean | 是否让对应 Content-Type 进入 Transform Pipeline；可热加载 |

### 旧配置迁移

| 旧字段 | 新字段 | 迁移单位 |
| --- | --- | --- |
| `timeout` | `timeoutMs` | 秒乘以 1000 |
| `accessOrigin` | `cors.allowedOrigins` | 字符串转为单元素数组；`*` 同时迁移为 `allowCredentials: false` |
| `session.cookie.maxAge` | `session.maxAgeMs` | 保持毫秒 |
| `session.cookie_max_age` | `session.maxAgeMs` | 秒乘以 1000 |
| `session.cookie_secure` | `session.secure` | 不变 |
| `session.cookie_httponly` | `session.httpOnly` | 不变 |
| `max_redirects` | `api.maxRedirects` | 不变 |
| `blacklist` | `security.blockedHostnames` | 按精确 hostname / 前导通配子域规则重新校验，不再执行正则 |

若配置包含旧字段且 `limiter.windowMs <= 1000`，迁移器会把它视为旧版秒值并乘以 1000。每次加载旧字段都会输出弃用警告，但现有服务不会因此中断。

字符串支持 `${PROXYWEB_SESSION_SECRET}` 形式的环境变量插值；缺少被引用的变量会拒绝配置。Schema 会拒绝未知字段、错误类型、非法端口、非正数时间、越界 Redirect 数，以及包含正则语法或非前导通配符的 hostname 规则。

配置文件由 Chokidar 监听。只有 JSON 解析、环境变量插值、Schema 校验和限流器创建全部成功后，才会原子替换当前配置；失败时继续使用最后一份有效配置。请求/连接超时、请求体/并发上限、认证、CORS、hostname 规则、API/Browser 模式策略和限流可以热加载；已有 Legacy Session 目标会在下一次请求时重新校验。端口、`trustProxy` 和已经创建的 Session 中间件需要重启。

## 请求接口

### API Route（推荐）

```text
ANY /__proxyweb/api?url=<percent-encoded-target>&method=<optional-method>
```

- `url` 必填，且应为完整的 `http://` 或 `https://` URL。
- 未提供 `method` 时使用客户端实际 HTTP 方法；提供时只接受 GET、POST、PUT、DELETE、PATCH、HEAD、OPTIONS。
- 非 GET/HEAD 请求体以流的方式转发。
- 自定义上游 Header 直接作为该 HTTP 请求的 Header 发送；上游 Bearer/Basic 使用 `X-ProxyWeb-Upstream-Authorization`，后端会将其转换为上游 `Authorization`，且不会把控制头本身转发出去。
- 普通 `Authorization` 专用于 proxyWeb 自身 Basic Auth，鉴权后立即从请求中删除。即使代理未启用认证，它也不会被隐式转发；需要上游认证时必须使用上述专用头。
- 旧 `headers=<percent-encoded-json>` 查询参数仍兼容，响应会携带 `Deprecation: true` 与 HTTP `Warning: 299`；新调用方不得继续生成该参数。
- 入站和兼容 Header 合并后会统一移除 hop-by-hop、`Proxy-Authorization` 及其 `Connection` 扩展字段。
- 上游状态码和大多数响应头会透传，响应体以流方式管道输出。
- API Route 不写入 Legacy Session，保留上游的 `X-Frame-Options` 与 `Content-Security-Policy`，并使用显式 API CORS 策略。

每个请求都会获得服务端生成的 request ID，并通过 `X-Request-ID` 响应头返回。代理自身产生的 JSON 错误使用稳定格式：

```json
{
  "error": {
    "code": "PROXY_UPSTREAM_ERROR",
    "message": "Upstream request failed"
  }
}
```

底层异常、Stack、内部文件路径和网络地址只进入脱敏后的服务端错误日志，不放入该响应。

示例中的查询值必须进行 URL 编码：

```text
http://localhost:8082/__proxyweb/api?url=https%3A%2F%2Fexample.com%2Fapi
```

### Browser Route 骨架

```text
ANY /__proxyweb/browser?url=<percent-encoded-target>
```

该入口默认关闭，访问时返回 404 `PROXY_BROWSER_DISABLED`。开启 `browser.enabled` 后，入口会先执行 URL、SSRF 与 DNS 校验，再返回 302 Canonical URL：

```text
/__proxyweb/browser/<base64url-origin>/<upstream-path>?<upstream-query>
```

Canonical 子路径可逆映射到唯一 upstream origin；不同 origin 的资源使用不同 Token，不依赖或修改 Legacy Session。Token 只是路由标识，不是凭据，也不是 SSRF allowlist：每次 Canonical 请求仍会重新执行 URL、DNS Pinning、资源限制和 Redirect 安全内核。畸形、非规范或非 HTTP(S) Token 返回 400 `PROXY_BROWSER_URL_INVALID`，Canonical 路径会规范化 dot segment，并保持 percent-encoded path、查询参数和客户端 Fragment 映射。

Browser Canonical 查询字符串全部属于上游，即使字段名为 `method` 或 `headers` 也不会触发 API/Legacy 查询控制功能。Browser Mode 不套用 API 的全局 CORS；`browser.headerPolicy: "compat"` 会移除上游 `X-Frame-Options` 与 `Content-Security-Policy`，`strict` 则保留。HTML/CSS 已进入受限 Transform Pipeline，但当前转换器仍是无 URL 改写的恒等实现；Cookie Jar、WebSocket 和具体内容 Rewrite 尚未实现，因此仍不能作为完整网页代理使用。

### Legacy Adapter（已弃用）

旧入口仍兼容：首次带 `url` 请求会把目标写入 Session，后续不带 `url` 的路径会代理到该目标的 origin：

```text
GET /?url=https%3A%2F%2Fexample.com
GET /assets/app.css
```

第二次请求会尝试访问 `https://example.com/assets/app.css`。这只是简单路径拼接，不会重写 HTML/CSS 中的链接，也不是完整 Browser Proxy。

Legacy 响应会携带 `Deprecation: true`、HTTP `Warning: 299` 和指向 `/__proxyweb/api` 的 `Link: rel="successor-version"`。新调用方必须使用 API Route；所有未定义的 `/__proxyweb/*` 保留路径会返回 404 `PROXY_ROUTE_NOT_FOUND`，不会误落入 Legacy Session。

### 静态前端

`/web` 映射到当前目录的 `webPro/`，未命中的 `/web/*` 路径回退到 `webPro/index.html`。前端构建后需要显式把 `vue-request-app/dist/` 的内容部署到该目录。

## 当前安全限制

路线图 2.2 已完成严格 CORS 与客户端地址边界：带凭据请求必须命中显式 Origin allowlist，预检方法和请求头会校验；无 Origin 请求不会获得 CORS 响应头。`trustProxy` 默认关闭，限流使用 Express 按显式信任策略计算的 `req.ip`。如部署在 Nginx/Caddy 等反向代理后，必须按实际可信跳数或地址配置，错误配置仍会使日志与限流采用错误的客户端地址。

路线图 2.3–2.6 已完成 URL、字面 IP、DNS 结果校验、连接绑定与安全 Redirect Loop：域名通过可注入 Resolver 执行 `lookup({ all: true, verbatim: true })`，保留全部规范化 A/AAAA；空结果、失败、超时、非法结果，以及任一非公网或混合公网/私网结果都会安全失败。每个请求创建独立 HTTP/HTTPS Agent，其 `lookup` 只能返回冻结后的验证地址集合；Axios 的环境代理发现被关闭，HTTPS 保持原 hostname、Host、SNI 和 `rejectUnauthorized: true`。平台提供远端 socket 地址时还会再次核对其是否属于验证集合。

Axios 自身始终使用 `maxRedirects: 0`。当 `api.followRedirects` 开启时，proxyWeb 处理 301/302/303/307/308：每一跳解析相对或绝对 `Location`、重新执行 URL/DNS/Pinning、创建新的请求级 Agent，并按 `api.maxRedirects` 检测循环和超限。跨 Origin 会删除认证、Cookie、Token、Password、Secret 与 API Key 类 Header；301/302 的 POST 和 303 按规则转换为 GET，307/308 保留方法与 Body。请求体始终以流式 Transform 按 `api.maxRequestBodyBytes` 计数；需要重放 307/308 时使用同一上限进行有限捕获，超限返回 413 `PROXY_REQUEST_BODY_LIMIT`。

路线图 2.7 已完成进程策略与资源限制：连接阶段使用请求级 Agent 定时器，请求阶段使用 `timeoutMs`；并发槽超限 fail-fast，客户端断开与 runtime shutdown 会 Abort 上游；上游半截响应和畸形 Content-Length 由 `pipeline` 在路由边界回收。未捕获异常与未处理 rejection 统一进入受控 shutdown，先停止接收连接并关闭 runtime，5 秒仍未完成才强制退出。API 响应继续流式传输，`security.maxRewriteBytes` 不会导致 API 大响应整体缓冲。

路线图 3.3 已建立 Browser Response Transform Pipeline：HTML/XHTML/CSS 在 gzip、deflate、br 或 identity 解码后按 `security.maxRewriteBytes` 计算上限，再按声明 Charset 解码为文本、输出 UTF-8 并使用原 Content-Encoding 重新压缩。超过上限会在发送上游响应头前返回 413 `PROXY_REWRITE_LIMIT`；畸形压缩流返回受控 502。SSE、206/Content-Range、附件、`Cache-Control: no-transform`、音视频、PDF、二进制、未知 Encoding/Charset，以及关闭对应 Rewrite 开关的文本保持原始流式透传。

以下仍是 [vNext 计划](../../proxyWeb%20vNext%20开发计划与技术方案.md) 中未完成的安全边界：

1. **旧敏感查询仍处于兼容期。** 外部旧客户端如果继续使用 `headers` 查询参数，凭据仍可能进入其浏览器历史、剪贴板或中间访问日志；后端会脱敏自身日志并返回弃用提示，新版前端已停止生成。
2. **进程内 Session Store。** 默认 MemoryStore 不适合生产、多进程或多实例部署。

配置 `user`/`pwd` 不能消除上述问题。P0 门禁通过不等于已解决多实例 Session、完整 Browser 隔离或生产运维要求，因此仍不提供开放代理式公网生产部署步骤。

## 响应与兼容性

- 后端对所有上游响应使用 Axios `responseType: "stream"`，并关闭 Axios 自动解压；只有选中的 Browser HTML/CSS 由受限 Pipeline 解压。
- API/Legacy 继续移除 hop-by-hop 与 `content-length`。Browser passthrough 保留合法 `content-length`、ETag 与 Content-MD5；Transform 后移除这些已失效元数据，并把 Charset 规范为 UTF-8。
- API Mode 保留上游 `X-Frame-Options` 和 `Content-Security-Policy`；Browser Mode 只在显式 `compat` 策略下移除，Legacy Adapter 为保持旧行为也会移除。
- Range 请求头随普通请求头转发；自动化契约覆盖了 206、`Content-Range` 与响应片段。
- 没有 Cookie Jar；客户端 Cookie 也被从上游请求头中删除。
- HTML/CSS URL 内容改写与 WebSocket 尚未实现；SSE 已有直通集成测试。

## 日志与排错

日志写入当前目录：

- `run.log`：info/warn。
- `error.log`：error。
- 控制台：与文件一致的结构化文本日志。

应用不再覆写全局 `console`；`core/logger.js` 统一创建 Winston Logger。每条请求日志包含 request ID，并在写入任何 transport 前递归脱敏 Authorization、`X-ProxyWeb-Upstream-Authorization`、Cookie、Token、密码、Secret、API Key、`headers` 查询参数及多层编码目标 URL 中的敏感查询值。代理认证隔离、前端凭据迁移、Redirect Chain 以及真实子进程日志快照均已进入强制测试。

常见检查：

- 启动后立即提示配置缺失：确认工作目录是 `backend/nodejs/` 且存在 `main.json`。
- 限流异常频繁：确认 `limiter.windowMs` 使用毫秒，不要写成 `60` 表示一分钟。
- 修改端口或 Session 配置没有生效：这两类配置需要重启。
- 前端 `/web/` 返回错误：确认已部署 `webPro/index.html` 以及其静态资源。
- 400 `PROXY_INVALID_URL`：目标 URL 格式、编码或 credentials 非法。
- 403 `PROXY_PROTOCOL_BLOCKED`：目标不是 HTTP(S) URL。
- 403 `PROXY_SSRF_BLOCKED`：目标是 localhost、非公网字面 IP、域名的任一 DNS 结果为非公网地址，或命中 `security.blockedHostnames`。
- 502 `PROXY_DNS_FAILED`：域名解析失败、超时、返回空列表或非法地址记录。
- 502 `PROXY_REDIRECT_BLOCKED`：上游返回无法解析的 Redirect `Location`。
- 504 `PROXY_CONNECT_TIMEOUT` / `PROXY_REQUEST_TIMEOUT`：连接阶段或上游请求超过配置上限。
- 503 `PROXY_CONCURRENCY_LIMIT`：正在执行的代理请求达到 `api.maxConcurrentRequests`。
- 508 `PROXY_REDIRECT_LIMIT`：Redirect 超出配置上限或形成循环。
- 413 `PROXY_REQUEST_BODY_LIMIT`：请求体或 Redirect 重放内容超过 `api.maxRequestBodyBytes`。
- 413 `PROXY_REWRITE_LIMIT`：Browser HTML/CSS 解压后超过 `security.maxRewriteBytes`。
- 404 `PROXY_BROWSER_DISABLED`：Browser Route 尚未在配置中开启。
- 400 `PROXY_BROWSER_URL_INVALID`：Canonical Token、路径或映射目标不合法或不规范。
- 404 `PROXY_ROUTE_NOT_FOUND`：请求命中了未定义的 `/__proxyweb/*` 保留路径。

## 开发与测试

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动后端 |
| `npm run dev` | 使用 Node.js watch mode 启动 |
| `npm test` | 运行全部测试，串行执行集成用例 |
| `npm run test:unit` | 运行本地 Fixture 单元测试 |
| `npm run test:integration` | 运行当前代理行为契约测试 |
| `npm run lint` | 检查生产入口与测试辅助脚本语法 |
| `npm run verify:p0` | 运行前后端完整 P0 门禁（复用已安装依赖） |
| `npm run verify:p0:ci` | 先执行两端 `npm ci`，再运行完整 P0 门禁 |

测试完全使用本地动态端口，不依赖公网服务或系统 hosts。当前契约覆盖 GET/POST/PUT/PATCH/DELETE/HEAD、Body/Header、错误状态与安全错误格式、request ID、Redirect、Streaming、Range、Session、Basic Auth、CORS、限流、配置热加载，以及超时、超限、并发、客户端断开、上游断流、畸形流和受控 shutdown。

后端当前 137 项测试通过、0 项 TODO、0 项失败；除 URL/DNS/Pinning/Redirect/CORS/认证与日志边界外，请求/连接超时、Body/并发上限、客户端断开、上游中断、畸形流、Session 过期、模式路由隔离、Canonical 映射、受限 Transform/Streaming 分界和 graceful/fatal shutdown 均已强制通过。2026-08-29 使用 npm 官方安全公告库审计生产依赖，结果为 0 个已知漏洞。

路线图 2.8 的干净安装门禁已于 2026-08-29 通过 7/7：前后端 `npm ci`、后端测试与语法检查、前端测试、lint 和生产构建全部成功。逐项 DoD 与测试位置见 [P0 自动化验收矩阵](../../docs/p0-verification-matrix.md)。前端构建仍有已记录的 bundle 体积 warning，不影响本次正确性门禁，后续应随构建工具链升级处理。
