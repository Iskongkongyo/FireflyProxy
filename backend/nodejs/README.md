# proxyWeb Node.js 后端

这是当前 API 代理的单文件 Node.js 实现，基于 Express 和 Axios。它支持请求/响应流式转发、Session 目标地址、Basic Auth、限流、CORS、日志和部分配置热加载。

> [!WARNING]
> 当前实现适合本地开发和受信网络测试，**尚不具备安全公网开放代理所需的完整防护**。尤其是 DNS SSRF、重定向校验和代理认证头隔离仍未完成。请先阅读“当前安全限制”。

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
  "timeout": 30,
  "user": "",
  "pwd": "",
  "accessOrigin": "*",
  "defaultSkip": "",
  "session": {
    "secret": "please-change-this-secret-in-production",
    "name": "proxySession",
    "resave": false,
    "saveUninitialized": false,
    "cookie": {
      "maxAge": 86400000,
      "secure": false,
      "httpOnly": true
    }
  },
  "limiter": {
    "windowMs": 60000,
    "max": 60,
    "message": "Too many requests, please try again later.",
    "statusCode": 429
  },
  "blacklist": [],
  "max_redirects": 5
}
```

| 字段 | 类型/单位 | 当前行为 |
| --- | --- | --- |
| `port` | Number | 启动时读取；修改后必须重启 |
| `timeout` | Number，秒 | 每次上游请求读取，可热加载 |
| `user` / `pwd` | String | 两者都非空时启用代理自身 Basic Auth |
| `accessOrigin` | String | CORS 来源；请求时读取 |
| `defaultSkip` | String | Session 尚无目标 URL 时的跳转地址 |
| `session.secret` | String | Session 签名密钥；中间件启动后不会热更新 |
| `session.cookie.maxAge` | Number，毫秒 | Session Cookie 生命周期；需重启生效 |
| `session.cookie.secure` | Boolean | 仅 HTTPS 场景设为 `true`；需重启生效 |
| `limiter.windowMs` | Number，毫秒 | 限流窗口；保存配置后重建限流器 |
| `limiter.max` | Number | 每个窗口允许的请求数 |
| `blacklist` | String[] | 拼接成正则表达式匹配完整目标 URL |
| `max_redirects` | Number | Axios 自动跟随重定向的最大次数 |

当前 `backend/nodejs/main.json` 中的 `cookie_max_age`、`cookie_secure`、`cookie_httponly` 不是代码读取的字段，`limiter.windowMs` 也必须使用毫秒。请迁移到上面的嵌套 `session.cookie` 格式。

配置文件由 Chokidar 监听。超时、认证、CORS、黑名单、重定向数和限流可以在后续请求中使用新值；监听端口和已经创建的 Session 中间件不能热更新。

## 请求接口

### 单次目标请求

```text
ANY /?url=<percent-encoded-target>&headers=<percent-encoded-json>&method=<optional-method>
```

- `url` 必填，且应为完整的 `http://` 或 `https://` URL。
- 未提供 `method` 时使用客户端实际 HTTP 方法；提供时只接受 GET、POST、PUT、DELETE、PATCH、HEAD、OPTIONS。
- 非 GET/HEAD 请求体以流的方式转发。
- `headers` 是兼容旧前端的 JSON 对象；解析失败时只记录警告并继续请求。
- 上游状态码和大多数响应头会透传，响应体以流方式管道输出。

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

以下都是 [vNext 计划](../../proxyWeb%20vNext%20开发计划与技术方案.md) 中的 P0 阻塞项：

1. **SSRF 校验不完整。** 代码只检查 URL 字面值中的 localhost 和 IP 地址，不解析域名后校验全部 A/AAAA 结果。指向私网的域名仍可能绕过检查。
2. **存在 DNS Rebinding/TOCTOU 风险。** 校验与 Axios 实际建立连接没有绑定到同一个已验证 IP。
3. **重定向未逐跳校验。** Axios 自动跟随跳转，新的 `Location` 目标不会再次执行 SSRF 检查。
4. **代理认证可能泄漏。** 代理自身使用标准 `Authorization: Basic ...`，转发头清理又没有移除 `authorization`，因此该凭据可能发送给上游。
5. **敏感头位于 URL。** `headers` 查询参数会进入访问日志、浏览器历史、剪贴板和分享链接；当前日志还会记录完整请求 URL。
6. **CORS 过宽。** `accessOrigin: "*"` 会反射客户端 Origin 并同时允许 Credentials，不应直接用于公网。
7. **`trust proxy` 硬编码为 1。** 部署拓扑不匹配时，客户端 IP 与限流键可能不可信。
8. **黑名单不是域名精确匹配。** 列表内容作为正则拼接，错误或过宽表达式可能误拦截，恶意表达式也可能带来性能问题。
9. **进程内 Session Store。** 默认 MemoryStore 不适合生产、多进程或多实例部署。
10. **错误响应泄露细节。** 部分 502 响应会把底层错误消息返回客户端。

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
- 控制台：彩色运行日志。

常见检查：

- 启动后立即提示配置缺失：确认工作目录是 `backend/nodejs/` 且存在 `main.json`。
- 限流异常频繁：确认 `limiter.windowMs` 使用毫秒，不要写成 `60` 表示一分钟。
- 修改端口或 Session 配置没有生效：这两类配置需要重启。
- 前端 `/web/` 返回错误：确认已部署 `webPro/index.html` 以及其静态资源。
- 403 `Invalid Target URL or Local IP`：目标是非法 URL、localhost、字面私网 IP 或命中了黑名单。

## 开发与测试

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动后端 |
| `npm run dev` | 使用 Node.js watch mode 启动 |
| `npm test` | 运行全部测试，串行执行集成用例 |
| `npm run test:unit` | 运行本地 Fixture 单元测试 |
| `npm run test:integration` | 运行当前代理行为契约测试 |
| `npm run lint` | 检查生产入口与测试辅助脚本语法 |

测试完全使用本地动态端口，不依赖公网服务或系统 hosts。当前契约覆盖 GET/POST/PUT/PATCH/DELETE/HEAD、Body/Header、错误状态、Redirect、Streaming、Range、Session、Basic Auth、CORS、限流和配置热加载。

DNS SSRF、重定向逐跳验证、代理认证头隔离、CORS 收紧和日志脱敏已登记为 P0 TODO 测试；在对应安全阶段实现前不会被误标为通过。2026-08-28 使用 npm 官方安全公告库审计生产依赖，结果为 0 个已知漏洞。
