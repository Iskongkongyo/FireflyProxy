# proxyWeb Node.js 后端

这是当前 API 代理的 Node.js 实现，基于 Express 和 Axios。`main.js` 只负责进程启动、异常记录和优雅关闭，`app.js` 通过 `createApp()` 创建可注入配置、可显式关闭的 Express runtime。代理支持请求/响应流式转发、Session 目标地址、Basic Auth、限流、CORS、日志和部分配置热加载。

> [!WARNING]
> 当前实现适合本地开发和受信网络测试，**尚不具备安全公网开放代理所需的完整防护**。尤其是重定向逐跳校验等后续 P0 阶段仍未完成。请先阅读“当前安全限制”。

## 运行结构

```text
main.js
  └── createApp()
        ├── app.js               # Express middleware 与代理路由
        ├── config/              # 默认值、Schema、迁移和加载
        ├── core/                # DNS/Pinning、Validator、日志、Header 与统一错误
        ├── middleware/          # request ID 与请求日志
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
    "maxRedirects": 5
  }
}
```

完整模板还包含 `browser` 预留段。`security.blockedHostnames` 已用于目标主机校验；`security` 的其余字段与 `browser` 字段供后续 P0/P1 使用，当前不能用它们绕过现有安全检查或开启未实现功能。

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
| `api.followRedirects` | Boolean | 是否允许 Axios 自动跟随跳转；可热加载 |
| `api.maxRedirects` | Number | 自动跟随重定向的最大次数；可热加载 |

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

配置文件由 Chokidar 监听。只有 JSON 解析、环境变量插值、Schema 校验和限流器创建全部成功后，才会原子替换当前配置；失败时继续使用最后一份有效配置。超时、认证、CORS、hostname 规则、API Redirect 和限流可以热加载；已有 Session 目标会在下一次请求时重新校验。端口、`trustProxy` 和已经创建的 Session 中间件需要重启。

## 请求接口

### 单次目标请求

```text
ANY /?url=<percent-encoded-target>&method=<optional-method>
```

- `url` 必填，且应为完整的 `http://` 或 `https://` URL。
- 未提供 `method` 时使用客户端实际 HTTP 方法；提供时只接受 GET、POST、PUT、DELETE、PATCH、HEAD、OPTIONS。
- 非 GET/HEAD 请求体以流的方式转发。
- 自定义上游 Header 直接作为该 HTTP 请求的 Header 发送；上游 Bearer/Basic 使用 `X-ProxyWeb-Upstream-Authorization`，后端会将其转换为上游 `Authorization`，且不会把控制头本身转发出去。
- 普通 `Authorization` 专用于 proxyWeb 自身 Basic Auth，鉴权后立即从请求中删除。即使代理未启用认证，它也不会被隐式转发；需要上游认证时必须使用上述专用头。
- 旧 `headers=<percent-encoded-json>` 查询参数仍兼容，响应会携带 `Deprecation: true` 与 HTTP `Warning: 299`；新调用方不得继续生成该参数。
- 入站和兼容 Header 合并后会统一移除 hop-by-hop、`Proxy-Authorization` 及其 `Connection` 扩展字段。
- 上游状态码和大多数响应头会透传，响应体以流方式管道输出。

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
http://localhost:8082/?url=https%3A%2F%2Fexample.com%2Fapi
```

### Session 路径请求

首次带 `url` 请求会把目标写入 Session。后续不带 `url` 的路径会代理到该目标的 origin：

```text
GET /?url=https%3A%2F%2Fexample.com
GET /assets/app.css
```

第二次请求会尝试访问 `https://example.com/assets/app.css`。这只是简单路径拼接，不会重写 HTML/CSS 中的链接，也不是完整 Browser Proxy。

### 静态前端

`/web` 映射到当前目录的 `webPro/`，未命中的 `/web/*` 路径回退到 `webPro/index.html`。前端构建后需要显式把 `vue-request-app/dist/` 的内容部署到该目录。

## 当前安全限制

路线图 2.2 已完成严格 CORS 与客户端地址边界：带凭据请求必须命中显式 Origin allowlist，预检方法和请求头会校验；无 Origin 请求不会获得 CORS 响应头。`trustProxy` 默认关闭，限流使用 Express 按显式信任策略计算的 `req.ip`。如部署在 Nginx/Caddy 等反向代理后，必须按实际可信跳数或地址配置，错误配置仍会使日志与限流采用错误的客户端地址。

路线图 2.3–2.5 已完成 URL、字面 IP、DNS 结果校验与连接绑定：域名通过可注入 Resolver 执行 `lookup({ all: true, verbatim: true })`，保留全部规范化 A/AAAA；空结果、失败、超时、非法结果，以及任一非公网或混合公网/私网结果都会安全失败。每个请求创建独立 HTTP/HTTPS Agent，其 `lookup` 只能返回冻结后的验证地址集合；Axios 的环境代理发现被关闭，HTTPS 保持原 hostname、Host、SNI 和 `rejectUnauthorized: true`。平台提供远端 socket 地址时还会再次核对其是否属于验证集合。

以下仍是 [vNext 计划](../../proxyWeb%20vNext%20开发计划与技术方案.md) 中未完成的安全边界：

1. **重定向未逐跳校验。** Axios 仍会自动跟随跳转，新的 `Location` 尚未重新执行完整 URL/DNS/Pinning 校验；初始请求的 pinned Agent 不能替代 proxyWeb 自己管理的安全跳转循环。
2. **旧敏感查询仍处于兼容期。** 外部旧客户端如果继续使用 `headers` 查询参数，凭据仍可能进入其浏览器历史、剪贴板或中间访问日志；后端会脱敏自身日志并返回弃用提示，新版前端已停止生成。
3. **进程内 Session Store。** 默认 MemoryStore 不适合生产、多进程或多实例部署。

配置 `user`/`pwd` 不能消除上述问题。完成 P0 安全测试前，不建议提供公网生产部署步骤。

## 响应与兼容性

- 后端对所有响应使用 Axios `responseType: "stream"`，并关闭自动解压。
- 会移除部分 hop-by-hop 响应头以及 `content-length`，由 Node.js 重新处理传输。
- 当前会移除上游的 `X-Frame-Options` 和 `Content-Security-Policy`，这扩大了内容嵌入面；vNext 将按 API/Browser 模式分别处理。
- Range 请求头通常会随普通请求头转发，但仓库目前没有自动化测试证明所有媒体与断点续传场景均正确。
- 没有 Cookie Jar；客户端 Cookie 也被从上游请求头中删除。
- 没有 HTML/CSS 重写、WebSocket 代理或 SSE 专项测试。

## 日志与排错

日志写入当前目录：

- `run.log`：info/warn。
- `error.log`：error。
- 控制台：与文件一致的结构化文本日志。

应用不再覆写全局 `console`；`core/logger.js` 统一创建 Winston Logger。每条请求日志包含 request ID，并在写入任何 transport 前递归脱敏 Authorization、`X-ProxyWeb-Upstream-Authorization`、Cookie、Token、密码、Secret、API Key 和 `headers` 查询参数。代理认证隔离、前端凭据迁移以及真实子进程日志快照均已进入强制测试。

常见检查：

- 启动后立即提示配置缺失：确认工作目录是 `backend/nodejs/` 且存在 `main.json`。
- 限流异常频繁：确认 `limiter.windowMs` 使用毫秒，不要写成 `60` 表示一分钟。
- 修改端口或 Session 配置没有生效：这两类配置需要重启。
- 前端 `/web/` 返回错误：确认已部署 `webPro/index.html` 以及其静态资源。
- 400 `PROXY_INVALID_URL`：目标 URL 格式、编码或 credentials 非法。
- 403 `PROXY_PROTOCOL_BLOCKED`：目标不是 HTTP(S) URL。
- 403 `PROXY_SSRF_BLOCKED`：目标是 localhost、非公网字面 IP、域名的任一 DNS 结果为非公网地址，或命中 `security.blockedHostnames`。
- 502 `PROXY_DNS_FAILED`：域名解析失败、超时、返回空列表或非法地址记录。

## 开发与测试

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动后端 |
| `npm run dev` | 使用 Node.js watch mode 启动 |
| `npm test` | 运行全部测试，串行执行集成用例 |
| `npm run test:unit` | 运行本地 Fixture 单元测试 |
| `npm run test:integration` | 运行当前代理行为契约测试 |
| `npm run lint` | 检查生产入口与测试辅助脚本语法 |

测试完全使用本地动态端口，不依赖公网服务或系统 hosts。当前契约覆盖 GET/POST/PUT/PATCH/DELETE/HEAD、Body/Header、错误状态与安全错误格式、request ID、Redirect、Streaming、Range、Session、Basic Auth、CORS、限流和配置热加载。

后端当前 87 项测试通过、1 项 P0 TODO（重定向逐跳验证）、0 项失败；DNS public/private/mixed/空结果/失败/超时、多 A/AAAA、IPv4-mapped IPv6、DNS Pinning、远端地址一致性、TLS SNI/严格证书选项、自签名证书拒绝、URL/IP、CORS、代理跳数、认证隔离和凭据日志快照均已强制通过。2026-08-29 使用 npm 官方安全公告库审计生产依赖，结果为 0 个已知漏洞。
