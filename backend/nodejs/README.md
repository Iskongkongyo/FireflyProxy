# FireflyProxy Node.js 后端

这是当前 API 代理的 Node.js 实现，基于 Express 和 Axios。`main.js` 只负责进程启动、异常记录和优雅关闭，`app.js` 通过 `createApp()` 创建可注入配置、可显式关闭的 Express runtime。API、Browser 与 Legacy Adapter 已分路由，并复用同一套 URL/DNS/Pinning/Redirect 安全执行器；各模式拥有独立 Header、响应与 CORS 策略。

> [!WARNING]
> P0 网络安全门禁与 P1 Browser Core E2E 门禁已通过，但当前实现仍以本地开发和受信网络测试为定位，**尚不适合作为生产级开放代理**。请先阅读“当前安全限制”；P0/P1 验收细节记录在本地开发文档中。

## 运行结构

```text
main.js
  └── createApp()
        ├── app.js               # Express middleware 与代理路由
        ├── config/              # 默认值、Schema、迁移和加载
        ├── api-proxy/           # API Router 与忠实响应策略
        ├── browser-proxy/       # Browser Router、Rewrite、Cookie 与兼容策略
        ├── core/                # 共享执行器、UrlMapper、DNS/Pinning、Validator、日志与错误
        ├── middleware/          # request ID、请求日志与 Legacy Adapter
        ├── config watcher       # 可由 runtime.close() 关闭
        └── runtime.getConfig()  # 启动端口及当前配置
```

测试可通过 `createApp({ configPath, watchConfig: false })` 注入隔离配置而不自动监听端口。生产入口仍使用 `npm start`，现有 HTTP 接口和默认启动行为不变。

## 环境与安装

后端要求 Node.js 22.16.0+；SQLite Runtime State 使用该版本提供的 `node:sqlite` timeout 能力。依赖清单和锁文件已经提交，可复现安装：

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
  "admin": {
    "enabled": false,
    "path": "/admin",
    "user": "",
    "pwd": ""
  },
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
  "runtimeState": {
    "backend": "memory",
    "sqlitePath": "./.fireflyproxy-state/runtime.sqlite",
    "busyTimeoutMs": 5000
  },
  "cors": {
    "allowedOrigins": ["http://localhost:8080"],
    "allowCredentials": true
  },
  "limiter": {
    "enabled": true,
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

完整模板还包含 `browser` 段。`browser.enabled`、`browser.headerPolicy`、`browser.cookieJar`、`rewriteHtml`、`rewriteCss`、`responseTransform`、`publicCache`、`runtimeBridge`、WebSocket 与 `originIsolation` 字段已用于 Browser Route；Scoped Response Transform、Public Static Cache、Runtime Bridge、WebSocket 和 Origin Isolation 默认关闭。`browser.maxRedirects` 为旧 Browser 服务端跟随行为兼容保留；当前 Browser 3xx 只验证并改写 Location，由客户端逐跳处理。`security.blockedHostnames` 已用于目标主机校验；任何模式和动态请求都不能绕过现有安全检查。

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
| `runtimeState.backend` | `memory` / `sqlite` | 默认内存；`sqlite` 可供同机多个进程共享状态；需重启 |
| `runtimeState.sqlitePath` | String | SQLite 文件；相对配置文件目录解析；需重启 |
| `runtimeState.busyTimeoutMs` | Number，毫秒 | SQLite 写锁等待上限，范围 100–60000；需重启 |
| `limiter.enabled` | Boolean | 是否启用按客户端 IP 的窗口限流；保存配置后热加载，默认 `true` |
| `limiter.windowMs` | Number，毫秒 | 限流窗口；保存配置后重建限流器 |
| `limiter.max` | Number | 每个窗口允许的请求数 |
| `security.blockedHostnames` | String[] | 精确 hostname 或 `*.example.com` 子域规则；不接受正则，可热加载 |
| `security.maxRewriteBytes` | Number，字节 | Browser 文本变换解压后输入及 UTF-8 输出的共同上限；超限返回 413；可热加载 |
| `api.followRedirects` | Boolean | 是否启用 FireflyProxy 安全逐跳循环；Axios 自身始终禁止自动跳转；可热加载 |
| `api.maxRedirects` | Number | 安全逐跳循环的最大次数；可热加载 |
| `api.connectTimeoutMs` | Number，毫秒 | 每一跳 TCP/TLS 连接阶段的上限；可热加载 |
| `api.maxRequestBodyBytes` | Number，字节 | 非 GET/HEAD Body 与 Redirect 重放缓存上限；可热加载 |
| `api.maxConcurrentRequests` | Number | 同时执行的代理请求上限；超出返回 503；可热加载 |
| `browser.enabled` | Boolean | 是否开放 Browser Route；默认 `false`；可热加载 |
| `browser.maxRedirects` | Number | 兼容保留；Browser 当前不在单个服务端请求内跟随 3xx |
| `browser.cookieJar` | Boolean | 是否启用按 FireflyProxy Session 隔离的 upstream Cookie Jar；可热加载 |
| `browser.headerPolicy` | `compat` / `preserve` / `strict` | `compat` 移除不兼容的安全策略头；`preserve` 保留；`strict` 是保留策略兼容值；可热加载 |
| `browser.rewriteHtml` | Boolean | 是否启用 HTML/XHTML URL 重写；关闭时不执行 URL Rewrite，但显式命中的 Scoped Transform 仍可变换；可热加载 |
| `browser.rewriteCss` | Boolean | 是否启用 CSS `url()` 与 `@import` AST 重写；关闭时不执行 URL Rewrite，但显式命中的 Scoped Transform 仍可变换；可热加载 |
| `browser.responseTransform.enabled` | Boolean | 是否启用限定内容替换；默认 `false`；可热加载 |
| `browser.responseTransform.rules` | Object[] | 按 Host、路径前缀和 MIME 匹配的有序字面量替换/HTML 注入规则；可热加载 |
| `browser.publicCache.enabled` | Boolean | 是否缓存显式公开的匿名静态资源；默认 `false`；可热加载 |
| `browser.publicCache.directory` | String | 磁盘缓存目录；相对路径以配置文件目录为基准；修改后需重启 |
| `browser.publicCache.ttlMs` | Number，毫秒 | 缓存 TTL 上限；默认 300000，Schema 最大 30 天；可热加载 |
| `browser.publicCache.maxBytes` | Number，字节 | 磁盘容量上限与 LRU 淘汰目标；默认 256 MiB，Schema 最大 10 GiB；可热加载 |
| `browser.publicCache.maxObjectBytes` | Number，字节 | 单个对象捕获上限；默认 5 MiB，不能超过 `maxBytes`；可热加载 |
| `browser.runtimeBridge` | Boolean | 是否注入动态 URL Bridge；默认 `false`，仅在有效 HTML Rewrite 下生效；可热加载 |
| `browser.webSocket` | Boolean | 是否开放 Canonical ws/wss Upgrade 并让 Runtime Bridge 包装 WebSocket；默认 `false`；可热加载，新连接读取新值 |
| `browser.webSocketMaxPayloadBytes` | Number，字节 | 单条上行或下行 WebSocket 消息上限；默认 1 MiB，Schema 最大 16 MiB；新连接读取新值 |
| `browser.webSocketIdleTimeoutMs` | Number，毫秒 | 无 message/ping/pong 活动后的关闭时间；默认 60 秒；新连接读取新值 |
| `browser.webSocketMaxConnections` | Number | 进行中握手与已建立 WebSocket 总上限；默认 64；可热加载 |
| `browser.originIsolation.enabled` | Boolean | 启用每 upstream 独立子域；默认 `false`；部署级开关，修改后需重启 |
| `browser.originIsolation.baseOrigin` | HTTP(S) Origin | 专用 Browser DNS namespace，例如 `https://browse.example.com`；需匹配 DNS/TLS/Session 部署并重启 |

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

字符串支持 `${FIREFLYPROXY_SESSION_SECRET}` 形式的环境变量插值；旧的 `${PROXYWEB_SESSION_SECRET}` 仍可在迁移期使用。缺少被引用的变量会拒绝配置。Schema 会拒绝未知字段、错误类型、非法端口、非正数时间、越界 Redirect 数，以及包含正则语法或非前导通配符的 hostname 规则。

配置文件由 Chokidar 监听。只有 JSON 解析、环境变量插值、Schema 校验和限流器创建全部成功后，才会原子替换当前配置；失败时继续使用最后一份有效配置。请求/连接超时、请求体/并发上限、认证、CORS、hostname 规则、API/Browser 模式策略和限流可以热加载；已有 Legacy Session 目标会在下一次请求时重新校验。端口、`trustProxy` 和已经创建的 Session 中间件需要重启。

## 请求接口

### API Route（推荐）

```text
ANY /__proxyweb/api?url=<percent-encoded-target>&method=<optional-method>&followRedirects=<true|false>&maxRedirects=<0..20>
```

- `url` 必填，且应为完整的 `http://` 或 `https://` URL。
- 未提供 `method` 时使用客户端实际 HTTP 方法；提供时只接受 GET、POST、PUT、DELETE、PATCH、HEAD、OPTIONS。
- `followRedirects` 只接受精确的 `true`/`false`，`maxRedirects` 只接受 0–20 整数；重复或非法值返回 400 `PROXY_REQUEST_CONTROL_INVALID`。两者只能关闭或收紧全局 `api` 策略。
- 非 GET/HEAD 请求体以流的方式转发。
- 自定义上游 Header 直接作为该 HTTP 请求的 Header 发送；上游 Bearer/Basic 使用 `X-FireflyProxy-Upstream-Authorization`，后端会将其转换为上游 `Authorization`，且不会把控制头本身转发出去。
- 普通 `Authorization` 专用于 FireflyProxy 自身 Basic Auth，鉴权后立即从请求中删除。即使代理未启用认证，它也不会被隐式转发；需要上游认证时必须使用上述专用头。
- 旧 `headers=<percent-encoded-json>` 查询参数仍兼容，响应会携带 `Deprecation: true` 与 HTTP `Warning: 299`；新调用方不得继续生成该参数。
- 入站和兼容 Header 合并后会统一移除 hop-by-hop、`Proxy-Authorization` 及其 `Connection` 扩展字段。
- 上游状态码和大多数响应头会透传，响应体以流方式管道输出；API 响应另带有界 Final URL、Redirect Chain 与有效控制值诊断头。
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

### Browser Route

```text
ANY /__proxyweb/browser?url=<percent-encoded-target>
```

该入口默认关闭，访问时返回 404 `PROXY_BROWSER_DISABLED`。开启 `browser.enabled` 后，入口会先执行 URL、SSRF 与 DNS 校验，再返回 302 Canonical URL：

```text
/__proxyweb/browser/<base64url-origin>/<upstream-path>?<upstream-query>
```

Canonical 子路径可逆映射到唯一 upstream origin；不同 origin 的资源使用不同 Token，不依赖或修改 Legacy Session。Token 只是路由标识，不是凭据，也不是 SSRF allowlist：每次 Canonical 请求仍会重新执行 URL、DNS Pinning、资源限制和 Redirect 安全内核。畸形、非规范或非 HTTP(S) Token 返回 400 `PROXY_BROWSER_URL_INVALID`，Canonical 路径会规范化 dot segment，并保持 percent-encoded path、查询参数和客户端 Fragment 映射。

Browser Canonical 查询字符串全部属于上游，即使字段名为 `method` 或 `headers` 也不会触发 API/Legacy 查询控制功能。Browser Mode 不套用 API 的全局 CORS；`browser.headerPolicy: "compat"` 会移除 CSP/CSP-Report-Only、X-Frame-Options、CORP/COOP/COEP 与 Clear-Site-Data，`preserve` 会保留，`strict` 保持原有的保留语义。开启 `rewriteHtml` 时，Cheerio 会解析 HTML/XHTML，并把 allowlist 属性、`srcset`、第一个 `<base>` 的有效 HTTP(S) 地址、Meta Refresh、style 属性和 `<style>` CSS 映射到 Canonical Browser URL。开启 `rewriteCss` 时，PostCSS AST 会重写样式表声明中的 `url()` 与 `@import`，相对地址基于 CSS 文件自身 URL。开启 `runtimeBridge` 时，HTML `<head>` 最前方注入 `/__proxyweb/runtime.js`，映射 Request/fetch、XHR、EventSource、WebSocket、window.open 和 History 动态 URL；WebSocket 还必须开启独立的 `browser.webSocket`。Browser 301/302/303/307/308 不在服务端继续请求：目标先经过 URL/SSRF/DNS 校验，再把 Location 映射成 Canonical URL 交由浏览器处理。开启 Cookie Jar 时，上游 Cookie 按 FireflyProxy Session 与 upstream Domain/Path/Secure/Expiry 隔离；上游 `Set-Cookie` 不会泄露到 FireflyProxy 域。Canonical Origin/Referer 会映射回来源 upstream，跨 CDN 请求仍保留页面源站语义。

Browser UI 可在入口请求中发送 `rewriteHtml`、`rewriteCss`、`runtimeBridge`、`webSocket`、`cookieJar` 与 `compatHeaders` 布尔偏好。偏好保存在签名后的当前 Browser Session 中，最近一次入口启动对该 Session 的后续 Canonical/跨 origin 子请求及 Upgrade 生效。所有偏好都只能收紧全局配置：无法启用服务器关闭的 Rewrite/Runtime Bridge/WebSocket/Cookie Jar，也无法把全局 `preserve`/`strict` 降级成 `compat`；重复值或非 `true`/`false` 参数返回 400 `PROXY_BROWSER_URL_INVALID`。不带偏好的入口会清除旧偏好并恢复服务器配置。

### Public Static Cache

`browser.publicCache.enabled` 默认是 `false`。启用后，代理只把满足全部条件的 Browser GET 响应写入磁盘：请求不含上游 `Authorization`、Cookie、Range、条件请求或强制刷新指令；响应为 200 的 JS、CSS、图片、字体、Web Manifest 或 WASM；并显式包含 `Cache-Control: public`，同时不含 `Set-Cookie`、`private`、`no-store`、`no-cache`、`Vary: *`、Content-Range 或附件下载语义。上游 `Age` 会缩短剩余新鲜期并在 HIT 时继续累加。HEAD 可以复用已有 GET 对象，但不会单独填充缓存。HTML、API/Legacy、SSE、WebSocket、音视频、PDF、下载和无法确定安全性的响应始终旁路。

Cache Key 使用完整 upstream URL 的 SHA-256、GET 表示语义、HTML/CSS Rewrite 与 Scoped Transform 配置版本，再按 Content-Encoding 和安全的 `Vary` 请求 Header 区分变体。磁盘元数据只保留 hostname 和 pathname，不写入目标查询字符串；日志只记录 request ID 与命中/旁路原因。缓存命中仍发生在 Canonical URL、DNS 和 SSRF 校验之后；Pinning 只适用于实际创建的上游 socket。响应使用 `X-FireflyProxy-Cache: HIT|MISS|BYPASS`，命中时更新 `Age`。超过单对象上限的流仍逐字节透传，只是不存储。

缓存文件经同目录临时文件原子重命名发布，启动时会忽略并清理崩溃残留；正文校验和、TTL、总容量、单对象上限及 LRU 淘汰共同限制读取与占用。同 Key 并发 miss 只允许一个 leader 请求上游，其余请求等待后复用结果。配置中的 directory 变更需要重启，其他 public cache 字段可热加载；Rewrite/Transform 配置变化会自然产生新 Key。缓存目录包含公开响应正文与 Header，仍须由部署者限制文件权限。完整安全模型记录在本地 Public Static Cache 开发文档中。

### Origin Isolation

默认 path 模式会让多个 upstream 共用一个 FireflyProxy origin。需要浏览器级 DOM、Storage、Worker scope 与权限隔离时，可配置：

```json
{
  "session": { "secure": true },
  "browser": {
    "originIsolation": {
      "enabled": true,
      "baseOrigin": "https://browse.example.com"
    }
  }
}
```

启用后入口仍为精确的 `https://browse.example.com/__proxyweb/browser?url=...`，Canonical URL 变为 `https://o-<sha256>.browse.example.com/__proxyweb/browser/<origin-token>/...`。host label 与可逆 path token 每次双重校验；错误 Host、错误 label、隔离 host 上的 API/UI 路径均返回 421 `PROXY_ORIGIN_ISOLATION_DENIED`。通配 DNS/TLS 只负责把规范子域送到应用，不构成 Host 信任或 SSRF allowlist。

生产必须提供专用的至少三级 DNS namespace、`*.browse.example.com` DNS 与 TLS 证书、HTTPS 和 `session.secure: true`。FireflyProxy 的 HttpOnly 控制 Session 会绑定精确 base hostname 的 Domain，以在隔离子域间共享启动偏好和服务端 Cookie Jar；页面 DOM/Storage 仍按子域隔离，但这不等于每 upstream 独立 FireflyProxy 登录会话。详细边界、反向代理要求和多实例限制记录在本地 Origin Isolation 威胁模型中。

### WebSocket Upgrade

开启 `browser.enabled` 与 `browser.webSocket` 后，HTTP Server 会接管 `/__proxyweb/browser/<origin-token>/...` 的 ws/wss Upgrade。Runtime Bridge 把 upstream WebSocket URL 映射到 path 模式的当前 proxy Host，或 Origin Isolation 模式下的目标派生 Host，并附加 HMAC 签名的来源 Origin 上下文；代理验证并移除该保留子协议后，只把应用声明的子协议发给上游。没有有效来源上下文时，上游 Origin 安全降级为 `null`，不会伪装成目标同源。

Upgrade 会在返回下游 101 前完成 Basic Auth、Session 偏好、Canonical URL、DNS SSRF、请求级 Pinning、TLS 和远端地址校验。上游仅收到 allowlist Header、映射后的 Origin 和 Cookie Jar 中匹配目标 URL 的 Cookie；FireflyProxy Session Cookie、普通 Authorization 与签名来源标记不会泄露。文本、二进制、应用子协议和合法关闭码双向透传；ping/pong 在两条连接上分别应答。转发通过暂停来源读取直至目标 `send` 完成施加 backpressure，并同时受 payload、idle 和总连接数限制。ws/wss Redirect 不跟随，配置关闭和进程 shutdown 会终止相关握手及连接。

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

### 配置管理页面

`admin.enabled` 默认关闭。首次需要在 `main.json` 配置独立的 `admin.path`、`admin.user` 和 `admin.pwd`；启用后管理页面由后端直接提供，不依赖 `webPro`。当 `defaultSkip` 为空时，访问 `/` 会重定向到管理路径。

中文页面以侧栏分类、概览卡片和可搜索设置表单覆盖完整配置 Schema，并提供明亮/黑暗主题、布尔下拉选择、B/KiB/MiB/GiB 换算、内容替换规则模板、未保存提醒和响应式移动布局。每个参数都会说明用途、安全边界、单位、配置路径与是否需要重启。保存时先验证、再同目录原子替换 `main.json` 并调用热加载。`port`、`trustProxy`、`session`、`runtimeState` 与 `browser.publicCache.directory` 会提示重启。读取 API 只返回 Secret 是否存在，不返回代理密码、Session Secret 或管理密码；空密码输入保持原文件值及 `${ENV}` 占位符。

管理 API 要求独立 Basic Auth、当前管理页 Referer、精确同源 Origin 和 `X-FireflyProxy-Admin: 1`，并有独立认证尝试限流。Canonical Browser 页面 Referer、派生 Origin Isolation host、iframe 和外部 Origin 均被拒绝。详细契约与验收命令记录在本地 Admin Console 开发文档中。

启用管理台后，`GET <admin.path>/api/cache` 返回当前缓存的 `entries`、`totalBytes`、`maxBytes` 与 `enabled`。`DELETE <admin.path>/api/cache` 接受 JSON `{ "all": true }` 清空全部，或 `{ "hostname": "static.example.com", "pathPrefix": "/assets/" }` 按精确主机和字面路径前缀失效；删除接口还必须携带当前管理页 Referer、精确 Origin、`Content-Type: application/json` 与 `X-FireflyProxy-Admin: 1`。失效代次会阻止清理前已经在途的响应重新填充被清理范围。

## 当前安全限制

路线图 2.2 已完成严格 CORS 与客户端地址边界：带凭据请求必须命中显式 Origin allowlist，预检方法和请求头会校验；无 Origin 请求不会获得 CORS 响应头。`trustProxy` 默认关闭，限流使用 Express 按显式信任策略计算的 `req.ip`。如部署在 Nginx/Caddy 等反向代理后，必须按实际可信跳数或地址配置，错误配置仍会使日志与限流采用错误的客户端地址。

路线图 2.3–2.6 已完成 URL、字面 IP、DNS 结果校验、连接绑定与安全 Redirect Loop：域名通过可注入 Resolver 执行 `lookup({ all: true, verbatim: true })`，保留全部规范化 A/AAAA；空结果、失败、超时、非法结果，以及任一非公网或混合公网/私网结果都会安全失败。每个请求创建独立 HTTP/HTTPS Agent，其 `lookup` 只能返回冻结后的验证地址集合；Axios 的环境代理发现被关闭，HTTPS 保持原 hostname、Host、SNI 和 `rejectUnauthorized: true`。平台提供远端 socket 地址时还会再次核对其是否属于验证集合。

Axios 自身始终使用 `maxRedirects: 0`。当 `api.followRedirects` 开启时，FireflyProxy 处理 301/302/303/307/308：每一跳解析相对或绝对 `Location`、重新执行 URL/DNS/Pinning、创建新的请求级 Agent，并按 `api.maxRedirects` 检测循环和超限。API Route 的 `followRedirects`/`maxRedirects` 查询控制只能关闭或收紧该全局策略。跨 Origin 会删除认证、Cookie、Token、Password、Secret 与 API Key 类 Header；301/302 的 POST 和 303 按规则转换为 GET，307/308 保留方法与 Body。请求体始终以流式 Transform 按 `api.maxRequestBodyBytes` 计数；需要重放 307/308 时使用同一上限进行有限捕获，超限返回 413 `PROXY_REQUEST_BODY_LIMIT`。

路线图 2.7 已完成进程策略与资源限制：连接阶段使用请求级 Agent 定时器，请求阶段使用 `timeoutMs`；并发槽超限 fail-fast，客户端断开与 runtime shutdown 会 Abort 上游；上游半截响应和畸形 Content-Length 由 `pipeline` 在路由边界回收。未捕获异常与未处理 rejection 统一进入受控 shutdown，先停止接收连接并关闭 runtime，5 秒仍未完成才强制退出。API 响应继续流式传输，`security.maxRewriteBytes` 不会导致 API 大响应整体缓冲。

路线图 3.3 已建立 Browser Response Transform Pipeline：HTML/XHTML/CSS 以及显式命中 Scoped Response Transform 的文本在 gzip、deflate、br 或 identity 解码后按 `security.maxRewriteBytes` 约束输入和最终 UTF-8 输出，再使用原 Content-Encoding 重新压缩。超过上限会在发送上游响应头前返回 413 `PROXY_REWRITE_LIMIT`；畸形压缩流返回受控 502。SSE、206/Content-Range、附件、`Cache-Control: no-transform`、音视频、PDF、二进制、未知 Encoding/Charset，以及未命中任何 Rewrite/Transform 的文本保持原始流式透传。

Scoped Response Transform 规则必须具有唯一 `id`，并同时命中 `hosts`、`pathPrefix` 与 `contentTypes`。Host 只接受精确值或 `*.example.com` 前导通配子域；路径是字面前缀；MIME 接受精确值或 `text/*` 形式的类型通配。`replacements` 只执行字面量替换，支持 `once`/`all` 和每项 `maxReplacements`；`appendHead`、`prependBody` 只对 HTML/XHTML 生效，只有注入而没有替换的规则不会缓冲其他文本类型。规则按数组顺序先完成全部替换，再按相同顺序注入片段；不开放正则。HTML/CSS URL Rewrite 仍分别服从自己的开关。变换后移除失效的 Content-Length、ETag、Content-MD5 与 Last-Modified。详细配置例：

```json
{
  "browser": {
    "responseTransform": {
      "enabled": true,
      "rules": [{
        "id": "example-page-fix",
        "enabled": true,
        "hosts": ["example.com", "*.static.example.com"],
        "pathPrefix": "/app/",
        "contentTypes": ["text/html"],
        "replacements": [{
          "search": "https://old.example.com/",
          "replacement": "/",
          "mode": "all",
          "maxReplacements": 100
        }],
        "appendHead": "<script src=\"/compat.js\"></script>",
        "prependBody": ""
      }]
    }
  }
}
```

P4.2 Public Static Cache 在上述 Browser 表示生成完成后捕获最终响应字节，因此命中的对象与当前 Rewrite/Transform 配置版本一致。它要求显式 `Cache-Control: public` 并对认证、Cookie、Set-Cookie、Range、HTML、SSE、附件与不安全 Vary fail closed；只缓存完整成功流。磁盘文件采用 SHA-256 标识、正文校验和及原子发布，过期或损坏项不会返回；容量收缩会按最近访问时间淘汰。清理操作先递增失效代次，使清理前已经在途的旧响应也不能回填。

路线图 3.4 已完成 HTML Rewrite：解析器先以文档 URL 解析第一个 `<base href>`；它是有效 HTTP(S) 目标时形成 effective base，否则回退文档 URL，其余相对 URL 使用该基准。跨 origin/CDN 会生成各自的 origin Token。`srcset` 只替换候选 URL 并保留 descriptor，Meta Refresh 只替换 URL 段，内联 style 使用 CSS value parser 处理 `url()`。`javascript:`、`data:`、`blob:`、`mailto:`、`tel:`、纯 Fragment、畸形 URL 和带 credentials 的目标保持原值，Canonical 子请求仍须通过 SSRF/DNS/Pinning 安全校验。关闭 `rewriteHtml` 时不会执行 HTML URL Rewrite；仅在 Scoped Transform 也未命中时保持原始流式响应。

路线图 3.5 已完成 CSS 与 Location Rewrite：PostCSS 只遍历声明值和 `@import` AST，value parser 只修改可安全解析的 HTTP(S) URL token，保留 media/layer 条件、data URL、Fragment 与复杂转义；HTML `<style>` 复用同一管线，非 `text/css` 预处理器块保持原样。Browser Redirect 使用 Redirect 内核的 validation-only 模式，解析相对/绝对 Location 并执行 URL、SSRF 与全部 DNS 结果校验；成功后返回独立 origin Token 的 Canonical Location，拒绝目标时回收上游流并在发送 3xx 前返回安全错误。API/Legacy 的服务端 follow、循环/次数限制与方法/Body 规则保持不变。

路线图 3.6 已完成 Cookie Jar 与 Header Policy：`SessionStateStore` 为每个 FireflyProxy Session 维护独立 tough-cookie Jar，并按 upstream 属性匹配，过期 Session 状态会回收。Browser 请求先移除客户端 FireflyProxy Cookie，再仅注入目标 URL 可见的 upstream Cookie；响应 `Set-Cookie` 在发送下游前写入 Jar 并剥离。Origin/Referer 只接受当前 proxy origin 下可严格反解的 Canonical Referer，跨 origin 资源的 Origin 使用来源页面 origin；来源无法验证时使用 `null`，绝不猜测为目标 origin。`compat` 只在 Browser Mode 删除明确列出的安全策略头，API 和 `preserve`/`strict` 保持上游语义。

路线图 3.7 已完成 Browser UI 与受限启动偏好：前端 `/web/browser` 默认用 `noopener,noreferrer` 新标签页打开目标，提供独立模式切换、URL 校验、可折叠兼容设置以及安全/兼容限制提示。只有 Browser Proxy 与管理 UI 不同 Origin 时才允许 sandbox iframe 预览；即使跨 Origin，iframe 仍可能受第三方 Cookie 和目标站防嵌入策略影响。`VUE_APP_PROXY_API_URL` 与 `VUE_APP_PROXY_BROWSE_URL` 可分别部署，缺省时保持旧 `VUE_APP_PROXY_URL` 回退行为。

路线图 3.8 已完成 P1 Browser Core E2E：`playwright-core` 驱动本机 Edge/Chrome/Chromium，访问两个本地虚拟 upstream origin，强制验证静态/SSR 页面、多 CSS/图片、跨 CDN 图片与脚本、GET/POST 表单、302 登录、Cookie Session、字体、MP4 Range、下载和 SSE。HTML/CSS/Location 不逃回 upstream、跨 origin Token 隔离和二进制逐字节直通也属于门禁条件；失败会保留截图、HTML、浏览器错误、失败请求与代理日志。

Browser 根路径恢复 Adapter 处理页面运行时插入、直接赋值或第三方脚本生成的 `/path` 导航。它只接受能按当前 proxy Origin 严格反解的 Canonical Referer，将单斜杠路径绑定到该 Referer 的 upstream origin，重新执行 URL、SSRF 与 DNS 校验后返回不缓存的 307 Canonical 跳转，从而保留 POST Method 与 Body。该 Adapter 不接管 `/__proxyweb/*`、`/web/*`、显式 Legacy `?url=`、双斜杠或缺少可信 Referer 的请求；`noreferrer`/`no-referrer` 页面不会使用 Session 或 Origin 猜测目标。

路线图 4.1 已完成 SSE 与 Range/Media 专项可靠性：SSE 在首个事件前显式 flush 下游响应头并设置 `X-Accel-Buffering: no`；API/Legacy/Browser 的未变换响应均保留合法 Content-Length。开放/后缀 Range、2 MiB 媒体、512 KiB HTML 附件和分块时序已在仅 32 字节 Rewrite 上限下验证，证明 206、媒体与附件不会进入文本 Buffer。

路线图 4.2 已完成最小 Runtime Bridge：脚本端点受既有认证、限流、全局配置与 Session 偏好约束，使用 `no-store` 和 `nosniff`；注入带 `data-fireflyproxy-runtime` 标记并避免重复。Bridge 保留原函数 `this`、prototype/static、Promise 和错误行为，按 upstream 文档 URL 及有效 `<base>` 解析动态 HTTP(S) URL。`Request` 在构造时只替换 URL，不读取或重建 Body；所有映射请求仍通过 Canonical Route 的 URL/DNS/Pinning 与资源限制。配置关闭、Session 关闭或 HTML Rewrite 关闭时脚本端点稳定返回 404；已经加载 Bridge 的旧页面需刷新后才会解除 patch。

### 反向代理与 SSE

FireflyProxy 会为 SSE 响应发送 `X-Accel-Buffering: no`，但生产链路中的外层代理仍必须允许流式响应。Nginx 可对承载 FireflyProxy 的 location 显式配置：

```nginx
location /__proxyweb/ {
    proxy_pass http://127.0.0.1:8082;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

若网关会忽略或删除 `X-Accel-Buffering`，必须在该网关配置中关闭响应缓冲。不要通过 CDN 缓存 SSE；超时值应按业务心跳周期设置，而不是无限放大所有普通请求的超时。

以下仍是本地 vNext 开发计划中未完成的安全边界：

1. **旧敏感查询仍处于兼容期。** 外部旧客户端如果继续使用 `headers` 查询参数，凭据仍可能进入其浏览器历史、剪贴板或中间访问日志；后端会脱敏自身日志并返回弃用提示，新版前端已停止生成。
2. **共享状态的部署范围。** 默认 Express Session 与 Browser SessionStateStore 仍使用进程内存；可选 SQLite adapter 会在同机多进程间共享 Express Session、Browser 偏好、upstream Cookie Jar 与 Origin label，并支持进程重启连续性。它不支持跨主机或网络文件系统；集群限流和 WebSocket 配额也仍按进程计算。跨机器部署在远程 Store 完成前只能用 sticky routing 过渡；细节记录在本地 Shared Runtime State 开发文档中。
3. **脚本 Cookie 可见性。** 服务端 Cookie Jar 可以维持 HTTP 会话，但不会让目标脚本读取 upstream HttpOnly Cookie。可显式开启 `browser.scriptCookieBridge` 映射脚本可见 Cookie；它默认关闭、依赖 Runtime Bridge，且共享 proxy Origin 不等价于完整浏览器 Origin Isolation；细节记录在本地 Script Cookie Bridge 开发文档中。

配置 `user`/`pwd` 不能消除上述问题。P0 门禁通过不等于已解决多实例 Session、完整 Browser 隔离或生产运维要求，因此仍不提供开放代理式公网生产部署步骤。

## 响应与兼容性

- 后端对所有上游响应使用 Axios `responseType: "stream"`，并关闭 Axios 自动解压；只有选中的 Browser HTML/CSS 或显式命中限定内容规则的文本由受限 Pipeline 解压。
- API Mode 写入 `X-FireflyProxy-Final-URL`、`X-FireflyProxy-Redirect-Chain`、`X-FireflyProxy-Redirect-Count`、`X-FireflyProxy-Follow-Redirects` 与 `X-FireflyProxy-Max-Redirects`。URL 与链为 Base64URL JSON；达到 4096 字符安全上限时按完整条目截断并增加 `X-FireflyProxy-Diagnostics-Truncated: true`。上游同名 Header 会先删除，允许的 CORS 响应会显式暴露可信诊断头。
- API/Legacy/Browser 都继续移除 hop-by-hop Header；Response Pipeline 明确认定未变换时保留合法 `content-length`、ETag、Content-MD5 与 Last-Modified，Transform 后移除这些已失效元数据，并把 Charset 规范为 UTF-8。
- API Mode 保留上游安全响应头；Browser `preserve`/`strict` 保留，只有显式 `compat` 会移除列出的 CSP、嵌入和跨源策略头；Legacy Adapter 为保持旧行为仍移除 X-Frame-Options/CSP。
- Range 请求头随普通请求头转发；自动化契约覆盖 API/Legacy/Browser 的 206、`Content-Range`、`Accept-Ranges`、正确 `Content-Length`、开放/后缀范围和响应片段。
- Browser Cookie Jar 已实现：客户端 FireflyProxy Cookie 会先删除，只按目标 URL 注入 Session Jar 中的 upstream Cookie；上游 `Set-Cookie` 不向下游透传。API/Legacy 行为不变。
- Public Static Cache 开启时，Browser 响应附带防上游伪造的 `X-FireflyProxy-Cache: HIT|MISS|BYPASS`；HIT 重新应用当前 Browser Header Policy，并重算 `Content-Length` 与 `Age`。关闭时不增加该诊断头。
- HTML/CSS 静态 URL、Browser Location、Cookie、来源 Header、脚本动态请求、WebSocket 与可选多 upstream Origin Isolation 已实现；SSE 已有直通集成测试。高级 Worker/Service Worker 兼容尚未实现。

## 日志与排错

日志写入当前目录：

- `run.log`：info/warn。
- `error.log`：error。
- 控制台：与文件一致的结构化文本日志。

应用不再覆写全局 `console`；`core/logger.js` 统一创建 Winston Logger。每条请求日志包含 request ID，并在写入任何 transport 前递归脱敏 Authorization、`X-FireflyProxy-Upstream-Authorization`、Cookie、Token、密码、Secret、API Key、`headers` 查询参数及多层编码目标 URL 中的敏感查询值。代理认证隔离、前端凭据迁移、Redirect Chain 以及真实子进程日志快照均已进入强制测试。

常见检查：

- 启动后立即提示配置缺失：确认工作目录是 `backend/nodejs/` 且存在 `main.json`。
- 网页资源频繁返回 429：先确认 `limiter.windowMs` 使用毫秒，不要写成 `60` 表示一分钟；本地或受信环境可设 `limiter.enabled: false`，公网环境应优先调高 `max` 并保留限流。
- 修改端口或 Session 配置没有生效：这两类配置需要重启。
- 503 `PROXY_RUNTIME_STATE_UNAVAILABLE`：共享 SQLite 被锁超时、损坏或不可访问；检查文件/目录权限、磁盘和同机写锁，不要把它改为网络共享盘，也不要删除数据库来掩盖 Schema 问题。
- 前端 `/web/` 返回错误：确认已部署 `webPro/index.html` 以及其静态资源。
- 400 `PROXY_INVALID_URL`：目标 URL 格式、编码或 credentials 非法。
- 400 `PROXY_REQUEST_CONTROL_INVALID`：API Redirect 控制重复、类型错误或超出规定范围。
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
| `npm run test:e2e` | 使用本机 Chromium 浏览器运行 P1 Browser Core E2E |
| `npm run test:streaming` | 运行 SSE、Range/Media、附件与 Response Pipeline 专项门禁 |
| `npm run test:diagnostics` | 运行 API Redirect 控制、逐跳链和响应诊断专项测试 |
| `npm run test:runtime` | 运行 Runtime Bridge 注入、配置和端点契约专项测试 |
| `npm run test:websocket` | 运行 WebSocket URL、安全握手、双向消息及资源上限专项测试 |
| `npm run test:runtime:e2e` | 使用本机 Chromium 验证动态 Request/fetch、XHR、EventSource、WebSocket、window.open 与 History |
| `npm run test:isolation:e2e` | 使用本机 Chromium 验证多 upstream Origin、Storage、SOP 与跨源 Runtime CORS |
| `npm run test:workspace:e2e` | 重新构建前端并验证 Environment、Session Secret、Folder、IndexedDB Saved Request 与 API/页面链接分流 |
| `npm run lint` | 检查生产入口与测试辅助脚本语法 |
| `npm run verify:p0` | 运行前后端完整 P0 门禁（复用已安装依赖） |
| `npm run verify:p0:ci` | 先执行两端 `npm ci`，再运行完整 P0 门禁 |
| `npm run verify:p1` | 运行 P0 回归与 Browser Core E2E |
| `npm run verify:p1:ci` | 从两端 `npm ci` 开始运行完整 P1 门禁 |
| `npm run verify:p2` | 运行 P1 回归与 Runtime Bridge E2E |
| `npm run verify:p2:ci` | 从两端 `npm ci` 开始运行当前完整 P2 门禁 |
| `npm run verify:p3` | 运行完整 P2 回归与 Environment/Collections Edge E2E |
| `npm run verify:p3:ci` | 从两端 `npm ci` 开始运行完整 P3 门禁 |

测试完全使用本地动态端口，不依赖公网服务或系统 hosts。当前契约覆盖 GET/POST/PUT/PATCH/DELETE/HEAD、Body/Header、错误状态与安全错误格式、request ID、Redirect、Streaming、Range、Session、Basic Auth、CORS、限流、配置热加载、HTML 属性/base/srcset/Meta Refresh、内联/独立 CSS、Location、Cookie Jar 隔离、Origin/Referer 映射、Runtime Bridge、WebSocket Upgrade、Origin Isolation Host 双绑定与 SQLite Shared Runtime State，以及超时、超限、并发、客户端断开、上游断流、畸形流和受控 shutdown。P1/P2 E2E 额外通过真实 Chromium 验证页面级资源、导航、表单、登录会话、媒体片段、下载、SSE、脚本动态 URL、WebSocket、独立 Origin/Storage 与 SOP 边界。

后端当前 255 项测试通过、0 项 TODO、0 项失败；除 URL/DNS/Pinning/Redirect/CORS/认证与日志边界外，可热加载限流开关、请求级 Redirect 收紧控制、有序诊断链、保留 Header 防伪与有界编码、请求/连接超时、Body/并发上限、客户端断开、上游中断、畸形流、Session 过期、模式路由隔离、Canonical 映射、HTML/CSS/Location Rewrite、Scoped Response Transform、Public Static Cache、Cookie 属性/隔离、Header 映射、Browser Session 偏好上限、Runtime Bridge、WebSocket、Origin Isolation、SQLite 多进程状态共享、SSE 时序、Range/Media 元数据、附件渐进传输、受限 Transform/Streaming 分界和 graceful/fatal shutdown 均已强制通过。2026-08-30 使用 npm 官方安全公告库审计生产依赖，结果为 0 个已知漏洞。

路线图 2.8 的干净安装 P0 门禁已于 2026-08-29 通过 7/7；路线图 3.8 的 P1 门禁和 4.2–4.4 的 P2 门禁均于 2026-08-30 在完整前序回归后通过真实浏览器 E2E；路线图 5.3 的 P3 门禁继续复用 P2，并追加本地工作区 IndexedDB E2E。逐项证据记录在本地的 P0/P1/P2 自动化验收矩阵、工作区契约与 Origin Isolation 威胁模型中。前端构建仍有已记录的 bundle 体积 warning，不影响本次正确性门禁，后续应随构建工具链升级处理。
