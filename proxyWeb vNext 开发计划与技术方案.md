# proxyWeb vNext 开发计划与技术方案

> 项目：`Iskongkongyo/proxyWeb`  
> 目标定位：**Postman Lite + 通用 Web Reverse Proxy**  
> 本文用途：直接交给 Codex 作为后续开发任务书与验收规格。
> 基线复核：2026-08-28

> [!IMPORTANT]
> 本文是 **vNext 目标规格与任务清单**，不是当前版本的功能说明。带有“状态：✅”的 P0/P1 条目、路线图 2.8、3.8 与 P2 路线图 4.1–4.2 已通过自动化验收；P2 其余阶段、P3 与未标记完成的 Milestone 条目仍应视为待实现。当前可运行方式、配置字段和已知风险以根目录 `README.md` 及模块 README 为准。

> 可执行的小阶段、依赖关系和逐阶段完成条件见 [`docs/vnext-implementation-roadmap.md`](./docs/vnext-implementation-roadmap.md)。

---

# 0. Codex 执行说明

请直接基于当前仓库进行开发，不要重写整个项目，不要破坏现有可用功能。

总体执行原则：

1. **Node.js 后端作为 vNext 主实现。**
2. 现有 `/?url=...` 使用方式必须尽量保持兼容。
3. 优先安全性与架构拆分，其次才增加网页兼容功能。
4. 不继续向现有 `backend/nodejs/main.js` 大量堆逻辑，应拆分模块。
5. 每完成一个阶段都必须保证项目可以启动和运行。
6. 新功能必须有测试，不接受仅通过手工访问验证。
7. 不实现针对 CAPTCHA、WAF、Cloudflare Challenge、DRM 等系统的绕过功能。
8. 不允许通过关闭 SSRF 防护来换取网页兼容性。
9. 如果某项兼容功能会明显削弱安全性，应做成显式配置项，而不是默认行为。

---

# 1. 产品目标

proxyWeb 最终提供两个相对独立但共享底层网络模块的工作模式：

```text
                       proxyWeb
                          │
              ┌───────────┴───────────┐
              │                       │
          API Mode               Browser Mode
       Postman Lite             Web Reverse Proxy
              │                       │
              └───────────┬───────────┘
                          │
                    Proxy Core
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
      SSRF             Redirect          Streaming
      DNS              Headers           Cookie
      TLS              Logging           Security
```

## 1.1 API Mode

目标：

- 快速发送 HTTP 请求；
- 解决浏览器 CORS；
- 支持 GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS；
- 支持自定义 Header；
- 支持 Basic / Bearer 等上游认证；
- 支持 JSON、Raw、Form、Multipart；
- 支持大文件和流式请求；
- 支持音视频、Range、SSE；
- 支持请求历史；
- 后续支持 cURL Import / Export。

API Mode 不应该自动执行网页内容修改。

---

## 1.2 Browser Mode

目标：

用户输入：

```text
https://example.com
```

proxyWeb 应尽可能允许用户通过 proxyWeb 浏览：

```text
HTML
CSS
图片
字体
脚本
表单
下载
音视频
SSE
WebSocket
Cookie Session
跨域静态资源
普通 SPA
```

Browser Mode 可以进行：

- URL Rewrite；
- Header Rewrite；
- Location Rewrite；
- Cookie Jar；
- Origin / Referer 映射；
- HTML / CSS Rewrite；
- WebSocket URL 映射；
- 浏览器兼容运行时注入。

但项目不承诺：

- 任意网站 100% 可代理；
- OAuth/OIDC 一定工作；
- CAPTCHA/WAF 一定工作；
- DRM 视频工作；
- 浏览器指纹检测可绕过；
- Service Worker 强绑定站点可正常工作。

---

# 2. 当前代码基线

基线制定时 Node 实现主要位于 `main.js`；1.1 完成后已拆分为：

```text
backend/nodejs/main.js
backend/nodejs/app.js
```

其中 `main.js` 负责进程生命周期，`app.js` 导出可注入配置、可关闭的 `createApp()` runtime；配置、日志/Header、DNS/Validator、Pinning 与安全 Redirect 已拆为独立模块。

当前已经具备：

- Express Server；
- Axios HTTP Proxy；
- responseType=stream；
- 请求体流式转发；
- Session targetUrl；
- Basic Auth；
- CORS；
- Rate Limit；
- 配置热加载；
- Winston 日志；
- URL/IP、DNS SSRF 与请求级 Pinning；
- proxyWeb 安全逐跳 Redirect Loop；
- Response Header 转发；
- CSP/X-Frame-Options 删除。

基线复核时还确认了以下工程状态：

- 基线制定时后端尚无 npm 工程和测试；0.1–0.3 已补充 `package.json`、锁文件、标准脚本、本地 Fixture 与现有行为契约测试；
- 后端配置路径是相对当前工作目录的 `./main.json`，必须从 `backend/nodejs/` 启动；
- `backend/main.json.example` 是当前字段格式参考，但现有 `backend/nodejs/main.json` 仍混用了旧 Session 字段与毫秒/秒单位；
- 前端开发与部署基址为 `/web/`；构建产物默认在 `vue-request-app/dist/`，不会自动进入后端 `webPro/`；
- 仓库当前没有 Python 后端，也没有 `LICENSE` 文件；
- P0 已于 2026-08-29 达到 Definition of Done；P1 已于 2026-08-30 完成路线图 3.1–3.8，并通过本地 Playwright Browser Core E2E；P2 路线图 4.1–4.2 已完成 SSE/Range/Media 与最小 Runtime Bridge，并通过独立 Edge E2E。WebSocket、高级 Worker/SPA 兼容和 Origin Isolation 尚未完成。

当前前端主要结构：

```text
vue-request-app/src/components/

ActionButtons.vue
History.vue
Index.vue
RequestBody.vue
ResponseViewer.vue
UserAuth.vue
```

前端继续使用 Vue 3 + Element Plus 即可，不需要本轮迁移框架。

---

# 3. 当前必须优先解决的问题

以下定义为 **P0 Blocking Issues**。

在 Browser Mode 大规模开发前必须解决。

---

# 4. P0 — 网络安全与基础架构重构

## P0-1. 拆分 `main.js`

> 状态：✅ 已于 2026-08-29 完成路线图 1.1–1.3 与 2.7。`main.js` 只保留启动和生命周期注册，Express runtime、配置、网络安全内核、Header、日志、错误和中间件均已拆分并可注入测试；目标目录中的 Browser/WebSocket 模块仍按 P1/P2 阶段创建。

目标目录：

```text
backend/nodejs/
├── main.js
├── app.js
├── config/
│   ├── defaults.js
│   ├── loader.js
│   └── schema.js
├── core/
│   ├── networkClient.js
│   ├── targetValidator.js
│   ├── dnsResolver.js
│   ├── redirect.js
│   ├── headers.js
│   ├── urlMapper.js
│   └── errors.js
├── middleware/
│   ├── auth.js
│   ├── cors.js
│   ├── rateLimit.js
│   └── requestLogger.js
├── api-proxy/
│   ├── router.js
│   └── proxy.js
├── browser-proxy/
│   ├── router.js
│   ├── proxy.js
│   ├── cookieJar.js
│   ├── htmlRewriter.js
│   ├── cssRewriter.js
│   ├── responseHeaders.js
│   └── runtimeBridge.js
├── websocket/
│   └── proxy.js
└── tests/
```

`main.js` 最终只负责：

```text
加载配置
创建 app
创建 HTTP Server
绑定 WebSocket upgrade
监听端口
全局进程异常处理
```

不要继续在 `main.js` 中实现 HTML Rewrite 等业务逻辑。

---

# 5. P0-2. 重做 SSRF Validator

> 状态：✅ 路线图 2.3–2.5 已于 2026-08-29 完成 Validator 与连接绑定。`validateTarget()` 已覆盖 URL credentials、编码变体、IPv4/IPv6/IPv4-mapped IPv6、非公网范围、hostname 规则与全部 DNS A/AAAA 结果，并返回请求级 `addresses`/`selectedAddress`；请求级 pinned Agent 已消费该上下文。

当前同步布尔函数：

```js
isSafeTarget(url)
```

改为：

```js
await validateTarget(url, context)
```

返回结构：

```js
{
  url,
  protocol,
  hostname,
  port,
  addresses,
  selectedAddress
}
```

---

## 5.1 URL 基础检查

只允许：

```text
http:
https:
```

Browser WebSocket 后续额外允许：

```text
ws:
wss:
```

默认拒绝：

```text
file:
ftp:
gopher:
data:
javascript:
blob:
```

同时处理：

- 空 hostname；
- 非法 URL；
- IPv6；
- IPv4-mapped IPv6；
- localhost；
- URL 中的 username/password；
- 奇怪的编码 hostname。

URL 中携带账号密码时不要写入日志。

---

# 6. P0-3. DNS SSRF 防护

> 状态：✅ 已于 2026-08-29 完成路线图 2.4–2.5。可注入 Resolver 使用 `lookup(all: true, verbatim: true)` 并设置超时上界；public/private/mixed/空结果/失败/超时、多 A/AAAA、family 不一致与 IPv4-mapped IPv6 均已进入强制测试，验证地址随后由请求级 pinned Agent 绑定到实际连接。

必须使用：

```js
dns.promises.lookup(hostname, {
    all: true,
    verbatim: true
})
```

对域名解析得到的 **全部 IP 地址**进行安全检查。

如果某个 hostname 同时返回：

```text
93.x.x.x
127.0.0.1
```

应整体拒绝，而不是选择公网 IP 后继续。

至少拒绝：

```text
loopback
private
link-local
multicast
unspecified
unique-local IPv6
reserved
carrier-grade NAT
metadata ranges
```

尤其测试：

```text
127.0.0.1
0.0.0.0
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.0.0/16
169.254.169.254
::1
fc00::/7
fe80::/10
```

不要仅通过：

```js
range === "unicast"
```

判断公网 IP。

建立独立函数：

```js
isPublicAddress(ip)
```

并编写完整单元测试。

---

# 7. P0-4. 防止 DNS Rebinding / TOCTOU

> 状态：✅ 已于 2026-08-29 完成路线图 2.5。HTTP/HTTPS 使用请求级 Agent，其 lookup 只返回 Validator 冻结的地址集合，并拒绝 hostname 变化；Axios 关闭环境代理发现。HTTPS 保持原 Host/SNI 与严格证书验证，平台可提供远端 socket 地址时再执行一次地址集合核对；Rebinding、family、地址不一致与自签名证书拒绝均有强制测试。

不能：

```text
先 DNS 校验 example.com
↓
Axios 再自行 DNS
↓
连接另一个 IP
```

必须尽量确保：

> 实际建立 TCP 连接的 IP 与安全检查后的 IP 一致。

实现自定义：

```text
http.Agent
https.Agent
```

或等价网络连接层。

其 `lookup` 应返回已经验证的 IP。

HTTPS 必须仍然：

```text
Host: example.com
SNI: example.com
```

不能因为连接 IP 而失去 TLS hostname 校验。

---

# 8. P0-5. 禁止 Axios 不受控制地自动 Redirect

> 状态：✅ 已于 2026-08-29 完成路线图 2.6。Axios 每一跳固定 `maxRedirects: 0`；proxyWeb 对 301/302/303/307/308 逐跳重新执行 URL、DNS 与 Pinning，限制循环/次数并清理跨 Origin 敏感 Header。方法/Body 语义、公网跳私网、相对/绝对 Location 与多层编码日志脱敏均有强制测试。

Browser Mode：

```js
maxRedirects: 0
```

API Mode 如果开启 Follow Redirect，也必须由 proxyWeb 自己实现 redirect loop。

每一次：

```text
301
302
303
307
308
```

都必须：

```text
解析 Location
↓
new URL(location, currentUrl)
↓
重新 validateTarget()
↓
重新 DNS 检查
↓
重新建立经过验证的连接
```

绝不能只验证第一个 URL。

Redirect 最大次数：

```text
API Mode 默认 5
Browser Mode 默认 10
```

超出返回明确错误：

```text
508 / ProxyRedirectLimitError
```

---

# 9. P0-6. 修复 Proxy Basic Auth 泄露风险

> 状态：✅ 已于 2026-08-29 完成路线图 2.1。代理认证头在鉴权后立即删除，上游认证改用专用控制头；Fixture 强制验证代理密码不可达 upstream。

Proxy 自己的认证与 Upstream Authorization 必须彻底区分。

不要出现：

```text
Authorization: Basic <proxyWeb账号密码>
```

被转发给目标网站。

规则：

```text
如果 Basic Auth 用于保护 proxyWeb：
    验证完成后必须删除该 Authorization
```

API 用户要发送：

```text
Authorization: Bearer xxx
```

应由 API 请求配置明确传给 upstream。

长期建议：

```text
proxyWeb 自身认证
        ↓
Session Cookie

upstream Authentication
        ↓
Authorization
```

不要让二者共用同一个 Authorization Header。

---

# 10. P0-7. 修复 CORS 策略

> 状态：✅ 已于 2026-08-29 完成路线图 2.2。严格 Origin allowlist、凭据与通配互斥、标准预检处理和 CORS 响应头最小暴露均已进入强制测试；无 Origin 请求不会依据 Referer 生成 CORS 响应。

当前 `"*"` 配置不要再自动等价于：

```text
反射任意 Origin
+
Allow-Credentials: true
```

推荐配置：

```json
{
  "cors": {
    "allowedOrigins": [
      "http://localhost:8080",
      "https://app.example.com"
    ],
    "allowCredentials": true
  }
}
```

规则：

```text
Credentials=true
→ 必须匹配明确 Origin Allowlist

Credentials=false
→ 才允许 *
```

API Mode 使用 CORS。

Browser Mode 原则上不需要全局宽松 CORS。

不要让 Browser Mode 与 API Mode 共用同一个宽松 CORS middleware。

---

# 11. P0-8. trust proxy 改成配置项

> 状态：✅ 已于 2026-08-29 完成路线图 2.2。内置与模板默认值均为 `false`；限流使用 Express 按显式信任策略计算的客户端地址，并已覆盖伪造 `X-Forwarded-For` 与多层代理跳数测试。

不要硬编码：

```js
app.set("trust proxy", 1)
```

增加：

```json
{
  "trustProxy": false
}
```

生产环境部署在 Nginx/Caddy 后方时才配置：

```json
{
  "trustProxy": 1
}
```

否则 IP 限流和日志可能受到伪造 Forwarded Header 影响。

---

# 12. P0-9. 日志脱敏

> 状态：✅ 已于 2026-08-29 完成路线图 2.1。Logger/redact、request ID、代理认证隔离、前端凭据迁移和真实进程日志快照均已进入强制测试；旧 `headers` query 仅保留带弃用提示的兼容读取。

目前 URL / query 中可能出现：

```text
headers={"Authorization":"Bearer xxx"}
token=xxx
key=xxx
password=xxx
```

必须增加：

```text
core/redact.js
```

至少脱敏：

```text
authorization
proxy-authorization
cookie
set-cookie
token
access_token
refresh_token
password
passwd
pwd
secret
api_key
apikey
headers query parameter
```

日志中：

```text
Bearer abcdef...
```

只能显示类似：

```text
Bearer [REDACTED]
```

不要打印 Request Body。

---

# 13. P0-10. 配置系统统一

> 状态：✅ 已于 2026-08-29 完成路线图 1.2 与 2.3–2.7，并于 2026-08-30 在 3.1–3.6 激活 Browser Rewrite、Cookie Jar 与 Header Policy 字段；`runtimeBridge` 字段已在 4.2 接入实际注入和 Session 收紧逻辑。Zod Schema、毫秒字段、旧配置迁移、环境变量插值和原子热加载回滚均已实现。

增加配置 Schema 校验。

推荐：

```text
zod
```

解决当前秒/毫秒混用问题。

统一：

```text
timeoutMs
windowMs
maxAgeMs
```

不要使用：

```text
timeout=30
windowMs=60
cookie_max_age=86400
```

这种单位不一致设计。

推荐新配置：

```json
{
  "port": 8082,

  "trustProxy": false,

  "timeoutMs": 30000,

  "session": {
    "secret": "${PROXYWEB_SESSION_SECRET}",
    "name": "proxySession",
    "maxAgeMs": 86400000,
    "secure": false,
    "httpOnly": true,
    "sameSite": "lax"
  },

  "cors": {
    "allowedOrigins": [
      "http://localhost:8080"
    ],
    "allowCredentials": true
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
  },

  "browser": {
    "enabled": true,
    "maxRedirects": 10,
    "rewriteHtml": true,
    "rewriteCss": true,
    "cookieJar": true,
    "runtimeBridge": true,
    "headerPolicy": "compat"
  },

  "limiter": {
    "windowMs": 60000,
    "max": 60
  }
}
```

必须继续读取旧配置并做 migration。

不要一次性破坏旧 `main.json`。

---

# 14. P0-11. 修复进程异常策略

> 状态：✅ 已于 2026-08-29 完成路线图 2.7。SIGINT/SIGTERM、未捕获异常与未处理 rejection 统一进入受控 shutdown；服务先停止接收连接并关闭 runtime，fatal error 以非零状态退出，超时后强制关闭连接。

不要在：

```js
uncaughtException
```

以后继续长期运行。

正确策略：

```text
记录错误
flush logger
process.exit(1)
```

生产环境交给：

```text
PM2
systemd
Docker
```

重新启动。

---

# 15. P0 Definition of Done

> 状态：✅ 已于 2026-08-29 通过路线图 2.8。`scripts/p0-gate.js --install` 从两端锁文件安装开始执行 7 步门禁，后端 111 项与前端 3 项测试、后端语法检查、前端 lint/build 全部通过；逐项证据见 [`docs/p0-verification-matrix.md`](./docs/p0-verification-matrix.md)。

P0 完成标准：

- 域名解析到 private IP 时阻止；
- Redirect 到 private IP 时阻止；
- DNS Rebinding 连接层得到控制；
- Proxy Basic Auth 不会发送给 upstream；
- 日志不会泄露 Token；
- CORS 不再随意反射带凭证 Origin；
- 原 `/?url=https://example.com` 基本兼容；
- GET/POST/PUT/PATCH/DELETE/HEAD 正常；
- stream request 正常；
- stream response 正常；
- Range 请求正常；
- 有自动化测试。

---

# 16. P1 — Browser Mode 核心

P0 完成后开始 Browser Mode。

不要继续使用：

```text
Session 中只有一个 current target origin
```

作为唯一 URL 映射机制。

因为网页会并发请求：

```text
example.com
cdn.example.com
api.example.com
fonts.example.net
```

需要每个请求自己携带 upstream origin 信息。

---

# 17. Browser Canonical URL 设计

> 状态：✅ 已于 2026-08-30 完成路线图 3.2。Browser 入口会在目标校验后 302 到 Canonical URL；Token 只标识 origin，每个 Canonical 请求仍重新执行 SSRF、DNS 与 Pinning。

新增内部保留路径：

```text
/__proxyweb/
```

Browser Mode：

```text
/__proxyweb/browser/
```

用户进入：

```text
GET /__proxyweb/browser?url=https://example.com/docs/index.html
```

服务器：

```text
validateTarget
↓
生成 canonical proxy URL
↓
302
```

例如：

```text
/__proxyweb/browser/<originToken>/docs/index.html
```

其中：

```text
originToken = base64url("https://example.com")
```

token 不作为安全凭据，只作为 URL 映射。

---

# 18. UrlMapper

> 状态：✅ 已于 2026-08-30 完成路线图 3.2。已实现严格可逆 Token、相对 URL 解析、path/query/Fragment 映射、路径规范化、origin 隔离和稳定错误契约；3.3 已建立受限文本转换接口，具体 HTML/CSS URL Rewrite 从 3.4–3.5 继续实现。

建立：

```text
core/urlMapper.js
```

至少提供：

```js
encodeOrigin(origin)

decodeOrigin(token)

toProxyUrl(targetUrl)

fromProxyRequest(req)

resolveTargetUrl(value, documentUrl)
```

示例：

```text
https://example.com/a/b.png
```

转换：

```text
/__proxyweb/browser/<exampleToken>/a/b.png
```

跨域：

```text
https://cdn.example.net/app.js
```

转换：

```text
/__proxyweb/browser/<cdnToken>/app.js
```

这样并发跨域资源不会互相修改 Session target。

---

# 19. P1-1. HTML Rewrite

> 状态：✅ 已于 2026-08-30 完成路线图 3.4。当前使用 Cheerio 解析 HTML/XHTML，覆盖列出的 URL 属性、`srcset`、`<base>`、Meta Refresh 和内联 style `url()`；映射复用 Canonical UrlMapper，实际子请求仍经过完整安全校验。

推荐使用：

```text
cheerio
```

或可靠 HTML Parser。

禁止使用一个巨大正则表达式处理完整 HTML。

至少 Rewrite：

```text
a[href]
link[href]
script[src]
img[src]
img[srcset]
source[src]
source[srcset]
iframe[src]
frame[src]
form[action]
input[src]
button[formaction]
video[src]
video[poster]
audio[src]
track[src]
object[data]
embed[src]
meta refresh
base[href]
```

转换规则：

```js
new URL(attributeValue, currentDocumentUrl)
```

然后：

```js
urlMapper.toProxyUrl()
```

忽略：

```text
javascript:
data:
blob:
mailto:
tel:
#
```

---

# 20. HTML `<base>` 支持

解析 HTML 时先确定：

```html
<base href="...">
```

形成：

```text
effectiveBaseUrl
```

所有 relative URL 应相对：

```text
effectiveBaseUrl
```

解析，而不是简单相对当前 URL。

随后把 `<base href>` 自身也转换成 proxy URL。

---

# 21. srcset Rewrite

不能：

```text
简单 replace("http")
```

需要正确解析：

```text
image1.jpg 1x,
image2.jpg 2x
```

仅修改 URL 部分，保留 descriptor。

---

# 22. Meta Refresh

处理：

```html
<meta
  http-equiv="refresh"
  content="0; url=https://example.com/login"
>
```

其中 URL 应转换成 proxy URL。

---

# 23. P1-2. CSS Rewrite

> 状态：✅ 已于 2026-08-30 完成路线图 3.5。当前使用 PostCSS AST 与 CSS value parser 重写独立样式表、HTML `<style>` 和 style 属性中的 `url()`/`@import`；相对 URL 以 CSS 文件 URL 或文档 effective base 为准，非 HTTP(S) 与复杂转义保守直通。

处理：

```css
url(...)
@import
```

包括：

```css
background: url("../image.png")
src: url("/fonts/font.woff2")
@import "theme.css"
```

相对 URL 基于：

```text
CSS 文件自身 upstream URL
```

而不是 HTML URL。

推荐使用 CSS Parser，不要使用全文件正则。

---

# 24. Response Transform Pipeline

> 状态：✅ 已于 2026-08-30 完成路线图 3.3–3.5，并在 4.1 补齐专项时序与元数据门禁。当前按模式与 HTTP 语义区分 transform/stream，HTML/XHTML 与 CSS 均已接入 Parser Rewrite；SSE 提前 flush，Range、附件、no-transform、媒体和二进制保持直通且未变换时保留合法长度。

建立统一：

```text
responsePipeline
```

流程：

```text
Upstream Response
       │
       ├── HTML
       │     ↓
       │ HTML Rewrite
       │
       ├── CSS
       │     ↓
       │ CSS Rewrite
       │
       ├── text/event-stream
       │     ↓
       │ direct stream
       │
       └── binary / media
             ↓
          direct stream
```

---

# 25. Rewrite Size Limit

禁止无限 buffer HTML。

配置：

```json
{
  "security": {
    "maxRewriteBytes": 5242880
  }
}
```

例如：

```text
5 MB
```

超过限制：

```text
终止 Transform
返回 413 PROXY_REWRITE_LIMIT
记录 warning
```

实现选择在响应头发出前明确失败，而不是在解压流已被消费后冒险拼接原始压缩数据。不能因为几十 MB HTML/CSS 或压缩炸弹导致 Node 内存爆炸。

---

# 26. Content-Encoding

> 状态：✅ 已于 2026-08-30 完成路线图 3.3。Browser 请求优先 identity；上游仍返回 gzip、deflate 或 br 时执行受限解压、UTF-8 文本处理并按原编码重新压缩，Transform 后清理失效元数据。

Browser Mode 第一版为了 Rewrite 简单可靠，可以：

```text
请求可改写文本时优先 Accept-Encoding: identity
```

或实现：

```text
gzip
br
deflate
```

解压 → 修改 → 输出。

任何发生 body 修改的 Response：

必须删除或重新计算：

```text
Content-Length
Content-Encoding
ETag
Content-MD5
```

Binary passthrough 不要无意义删除 Content-Length。

---

# 27. P1-3. Location Rewrite

> 状态：✅ 已于 2026-08-30 完成路线图 3.5。Browser 3xx 使用 validation-only Redirect 模式：相对/绝对 Location 先执行 URL/SSRF/DNS 校验，再返回 Canonical Location 交给浏览器；API/Legacy 的安全服务端 follow 行为不变。

Browser Mode 不自动在服务端吞掉 302。

例如 upstream：

```http
HTTP/1.1 302 Found
Location: https://accounts.example.com/login
```

proxyWeb：

```text
validate redirect target
↓
rewrite Location
```

返回：

```http
Location:
/__proxyweb/browser/<accountsToken>/login
```

让浏览器自己处理 301/302/303/307/308。

这样：

```text
navigation
POST redirect
history
cookie
```

语义更接近真实浏览器。

---

# 28. P1-4. Cookie Jar

> 状态：✅ 已于 2026-08-30 完成路线图 3.6。当前以 `tough-cookie` 和可替换的进程内 `SessionStateStore` 为每个 proxyWeb Session 维护独立 Jar；请求按 upstream URL 注入 Cookie，响应 `Set-Cookie` 写入 Jar 后从下游剥离。

增加依赖：

```text
tough-cookie
```

每个 proxyWeb Session 有独立：

```text
CookieJar
```

请求前：

```js
jar.getCookieString(targetUrl)
```

发送：

```http
Cookie: ...
```

响应后解析：

```http
Set-Cookie
```

调用：

```js
jar.setCookie(...)
```

Cookie Jar 必须按照 upstream：

```text
Domain
Path
Secure
Expires
HttpOnly
```

而不是 proxyWeb 域名管理。

---

# 29. Cookie 隔离

> 状态：✅ 已于 2026-08-30 完成路线图 3.6。Session ID 与 upstream Domain/Path/Secure/Expiry 双重隔离均有强制单元与真实路由测试；关闭 `browser.cookieJar` 时不创建、吸收或发送 Jar 状态。

必须：

```text
Session A CookieJar
≠
Session B CookieJar
```

同时 CookieJar 内：

```text
example.com
≠
github.com
```

不得把一个目标网站 Cookie 发给另一个目标。

第一版可以：

```text
Memory
```

但必须抽象：

```text
SessionStateStore
```

方便未来实现：

```text
Redis
```

---

# 30. Cookie 限制说明

> 状态：✅ 已作为 3.6 的显式兼容边界记录。服务端 Jar 维持 HTTP 会话，但不会把 upstream Cookie 设置到 proxyWeb 主域，因此依赖 `document.cookie` 读取目标 Cookie 的页面仍可能不兼容。

Server-side CookieJar 无法完美模拟：

```js
document.cookie
```

因此 Browser Mode 第一版对部分严重依赖 JavaScript 读取 Cookie 的站点可能不兼容。

不要为了这一点把所有目标 Cookie 原样设置到 proxyWeb 主域名。

这是安全边界问题。

后续可通过 Origin Isolation 方案增强。

---

# 31. P1-5. Header Rewrite

> 状态：✅ 已于 2026-08-30 完成路线图 3.6。共享 Header 内核继续负责 hop-by-hop、连接扩展字段和代理认证隔离；Browser Policy 在其上独立完成 Cookie、Origin/Referer 与响应安全 Header 映射，API/Legacy 行为保持隔离。

建立：

```text
core/headers.js
```

分别：

```js
buildApiRequestHeaders()

buildBrowserRequestHeaders()

buildBrowserResponseHeaders()
```

---

# 32. Hop-by-hop Headers

HTTP 模式删除：

```text
Connection
Keep-Alive
Proxy-Authenticate
Proxy-Authorization
TE
Trailer
Transfer-Encoding
Upgrade
```

注意：

```text
Cookie
```

不是 hop-by-hop header。

不能继续把 Cookie 和 Connection 当作同一类处理。

---

# 33. Browser Origin / Referer Rewrite

> 状态：✅ 已于 2026-08-30 完成路线图 3.6。只接受当前 proxy origin 下可严格反解的 Canonical Referer；跨 origin/CDN 时 Origin 使用来源页面 upstream origin，来源未知时降级为 `null`，绝不猜测为目标资源 origin。

浏览器可能发送：

```http
Origin: https://browse.proxy.example
Referer: https://browse.proxy.example/__proxyweb/...
```

upstream 需要看到对应原站信息。

例如：

```text
proxy URL
/__proxyweb/browser/<token>/page
```

映射回：

```text
https://example.com/page
```

然后 upstream：

```http
Referer: https://example.com/page
Origin: https://example.com
```

跨域请求时 Origin 应尽量根据代理 Referer/source target 判断，而不是永远设置成 destination origin。

---

# 34. Response Security Header Policy

> 状态：✅ 已于 2026-08-30 完成路线图 3.6。`preserve` 与兼容值 `strict` 保留 upstream 安全 Header；`compat` 仅在 Browser Mode 删除明确列出的 CSP、嵌入、跨源隔离与 Clear-Site-Data Header，API Mode 继续保留真实响应语义。

不要在公共中间件中无条件：

```js
removeHeader("content-security-policy")
removeHeader("x-frame-options")
```

Browser Mode 提供：

```json
{
  "browser": {
    "headerPolicy": "compat"
  }
}
```

支持：

```text
preserve
compat
```

`preserve`：

尽量保留 upstream 安全 Header。

`compat`：

允许根据需要处理：

```text
Content-Security-Policy
Content-Security-Policy-Report-Only
X-Frame-Options
Cross-Origin-Resource-Policy
Cross-Origin-Opener-Policy
Cross-Origin-Embedder-Policy
Clear-Site-Data
```

但只影响 Browser Mode。

API Mode 应尽量展示真实 upstream Headers。

---

# 35. UI 与 Browser Proxy 安全隔离

> 状态：✅ 已于 2026-08-30 完成路线图 3.7 的前端配置边界。`VUE_APP_PROXY_API_URL` 与 `VUE_APP_PROXY_BROWSE_URL` 可独立部署，缺省时兼容回退旧 `VUE_APP_PROXY_URL`；Browser UI 同源时禁用 iframe，并始终建议将不可信目标代码与管理 UI 分离 Origin。

推荐生产部署：

```text
app.example.com
    ↓
Postman Lite UI

browse.example.net
    ↓
Browser Proxy
```

不要把不可信第三方 JavaScript 与管理 UI 长期部署到完全相同 Origin。

前端增加：

```text
VUE_APP_PROXY_API_URL
VUE_APP_PROXY_BROWSE_URL
```

如果未配置：

```text
fallback 到原 BASE_URL
```

保证旧部署仍能工作。

---

# 36. P1-6. API Mode 与 Browser Mode 分路由

> 状态：✅ 已于 2026-08-30 完成路线图 3.1–3.8。当前已提供独立 API Route、默认关闭的 Browser Route、Canonical URL、HTML/CSS/Location Rewrite、Session Cookie Jar、Origin/Referer 与安全 Header Policy、受限 Response Transform Pipeline、独立 Browser UI，以及带标准弃用响应头的 Legacy Adapter；上述边界已进入 P1 Playwright E2E 门禁。

推荐：

```text
/__proxyweb/api
/__proxyweb/browser
```

Legacy：

```text
/?url=...
```

作为兼容 Adapter。

不要让新的 Browser 功能全部塞进 legacy route。

---

# 37. P1 Definition of Done

> 状态：✅ 已于 2026-08-30 通过路线图 3.8。`scripts/p1-gate.js --install` 先执行完整 P0 回归，再以 Playwright Core 驱动本机 Chromium 验证以下页面/资源场景与核心不变量；逐项证据见 [`docs/p1-verification-matrix.md`](./docs/p1-verification-matrix.md)。

必须通过：

```text
普通静态网页
SSR 页面
多 CSS
多图片
跨 CDN 图片
跨 CDN JS
表单 GET
表单 POST
302 Login Page
Cookie Session
图片
字体
MP4 Range
文件下载
SSE
```

至少满足：

```text
HTML 内资源不直接逃回原站
CSS url() 正常
Location 不逃回原站
跨域资源拥有独立 token
Cookie Session 可以持续
二进制内容不被修改
```

---

# 38. P2 — SPA 与实时网页增强

P1 稳定以后实现。

---

# 39. P2-1. Runtime Bridge

> 状态：✅ 已于 2026-08-30 完成路线图 4.2。HTML `<head>` 最前方注入唯一 `data-proxyweb-runtime` 脚本，映射 Request/fetch、XHR、EventSource、window.open 与 History；相对 URL 同时遵循 upstream 文档地址和有效 `<base>`。全局、Session 或 HTML Rewrite 任一关闭都会禁止注入和脚本交付。WebSocket 构造器必须等待 4.3 的安全 Upgrade 代理，未在本阶段提前 patch。

静态 Rewrite 无法解决 JavaScript：

```js
fetch("/api")
new WebSocket("/socket")
new EventSource("/events")
xhr.open("GET", "/api")
```

因此 Browser HTML 中可以注入：

```html
<script src="/__proxyweb/runtime.js"></script>
```

runtimeBridge 保存：

```text
current upstream origin
current proxy token
```

包装：

```text
window.fetch
XMLHttpRequest.prototype.open
WebSocket
EventSource
window.open
```

把目标 URL 转换为 proxy URL。

不要修改第三方 JavaScript 源码。

---

# 40. Runtime Bridge 设计原则

> 状态：✅ `runtimeBridge.js` 使用 Reflect 调用/构造并继承原生函数对象，真实 Edge 已验证 Promise、prototype/static、POST Request Body、错误与 History 同源行为。Bridge 不读取、持久化或记录 Body/Token，所有映射请求仍进入 Canonical URL、DNS SSRF 与 Pinning 内核；配置关闭后，已经加载的页面需刷新才能解除现有 patch。

原函数必须保留：

```text
this
prototype
static property
Promise behavior
error behavior
```

所有 patch 应可以：

```text
browser.runtimeBridge=false
```

关闭。

在 HTML 中加入：

```text
data-proxyweb-runtime
```

避免重复注入。

---

# 41. P2-2. WebSocket Proxy

增加：

```text
ws
```

HTTP Server：

```js
server.on("upgrade", ...)
```

Browser runtime：

```text
wss://example.com/chat
```

映射：

```text
wss://browse.proxy.com/__proxyweb/browser/<token>/chat
```

Server：

```text
解析 token
↓
validateTarget(wss target)
↓
DNS SSRF validation
↓
建立 upstream WebSocket
↓
双向 message pipe
```

支持：

```text
text
binary
ping/pong
close
subprotocol
CookieJar
Origin rewrite
```

必须设置：

```text
maxPayload
idle timeout
```

防止内存滥用。

---

# 42. P2-3. SSE

> 状态：✅ 已于 2026-08-30 完成路线图 4.1。`core/streamingPolicy.js` 对 SSE 显式提前发送响应头并覆盖 `X-Accel-Buffering: no`；延迟 Fixture 同时验证 API 与 Browser 的两条事件在各自时点到达，而非结束时合并。Nginx 部署要求已写入后端 README。

SSE：

```text
Content-Type: text/event-stream
```

必须：

```text
直接 stream
禁止 buffer
禁止 HTML Rewrite
```

如果使用 Nginx 部署，文档增加：

```nginx
proxy_buffering off;
```

相关说明。

---

# 43. P2-4. Range / Media

> 状态：✅ 已于 2026-08-30 完成路线图 4.1。API、Legacy 与 Browser 的未变换响应会保留 Content-Length；2 MiB 媒体覆盖固定、开放与 suffix Range，强制断言 206、Content-Range、Accept-Ranges、Content-Length、Content-Type、ETag 和字节片段。大媒体与 HTML 附件在极小 Rewrite 上限下仍渐进传输。

测试：

```http
Range: bytes=1000000-
```

upstream：

```http
206 Partial Content
Content-Range: ...
Accept-Ranges: bytes
```

proxyWeb 必须保留：

```text
206
Content-Range
Accept-Ranges
Content-Length（未变换时）
Content-Type
```

不能因为统一删除 Content-Length 而降低媒体拖动兼容性。

---

# 44. P2-5. Origin Isolation Future Mode

后续增加可选高级部署：

```text
*.browse.example.com
```

每个 upstream origin 使用不同 proxy subdomain：

```text
example-com-token.browse.example.com
cdn-token.browse.example.com
```

优点：

```text
root-relative URL 更自然
浏览器 Same-Origin 模型更接近原站
Cookie 更容易隔离
不同目标站 JS 不共享 Origin
```

此模式依赖：

```text
Wildcard DNS
Wildcard TLS Certificate
```

因此不作为初版强制条件。

实现时 URL Mapper 应提前抽象，以便以后从：

```text
path token
```

迁移到：

```text
host token
```

而不用重写 HTML Rewriter。

---

# 45. P3 — Postman Lite 功能增强

Browser Mode 稳定以后增强 API 工作台。

优先级顺序：

## 第一组

实现：

```text
Query Params 表格
Headers 表格
Raw Body
JSON Body
x-www-form-urlencoded
multipart/form-data
```

---

## 第二组

实现：

```text
Import cURL
Copy as cURL
```

至少解析：

```text
-X
-H
--header
-d
--data
--data-raw
--data-binary
-u
--user
```

Export cURL 必须正确 shell escape。

---

## 第三组

Redirect 控制：

```text
Follow Redirects
Max Redirects
```

Response 面板显示：

```text
Status
Final URL
Redirect Chain
Duration
Response Size
Content-Type
```

---

# 46. API Route 改进

新增：

```text
ANY /__proxyweb/api?url=<target>
```

行为：

```text
HTTP Method = browser request method
HTTP Body = browser request body
Upstream Headers = API UI 配置的 headers
```

逐渐弃用：

```text
?method=
?headers={"Authorization":...}
```

尤其不要再把 Authorization 放在 URL query 中。

旧格式继续兼容至少一个主要版本。

---

# 47. API 请求性能信息

新增 Server Timing：

```text
dns
connect
tls
ttfb
total
```

如果实现复杂，可以第一版只记录：

```text
total
```

前端显示：

```text
200 OK · 842 ms · 12.4 KB
```

---

# 48. Environment Variables

后续支持：

```text
{{baseUrl}}
{{token}}
{{userId}}
```

环境结构：

```json
{
  "name": "Development",
  "variables": {
    "baseUrl": "https://dev.example.com",
    "token": "..."
  }
}
```

Token 默认只存 Local Storage 时需要给出明确提示。

后续可以考虑 Session Storage。

---

# 49. Collections

暂不复刻 Postman 全部 Collection 功能。

最低实现：

```text
Folder
Saved Request
Name
Method
URL
Headers
Body
Auth
```

优先使用 IndexedDB。

无需本轮实现账号同步。

---

# 50. 前端 UI 改造

> 状态：✅ 已于 2026-08-30 完成路线图 3.7。顶部模式切换保留现有 API Request 页面，并新增 `/web/browser` 与 `BrowserProxy.vue`；默认使用无 opener 新标签页，跨 Origin 时提供 sandbox iframe 可选预览，同源时因安全边界禁用嵌入。

主界面顶部增加：

```text
[ API 请求 ] [ 网页代理 ]
```

API Request 使用现有页面。

Browser Proxy 新建：

```text
BrowserProxy.vue
```

基本 UI：

```text
┌────────────────────────────────────┐
│ https://example.com        [打开]  │
├────────────────────────────────────┤
│ [新标签页] [嵌入预览] [兼容设置]   │
└────────────────────────────────────┘
```

默认建议：

```text
新标签页打开
```

嵌入 iframe 作为可选功能。

---

# 51. Browser Compatibility UI

> 状态：✅ 已于 2026-08-30 完成路线图 3.7，并在 4.2 激活 Runtime Bridge 开关。HTML/CSS Rewrite、Runtime Bridge、Cookie Jar 与 Compatibility Headers 位于高级折叠面板；参数绑定 Browser Session 且只能收紧服务器全局配置，不能启用后端全局关闭的能力。

允许设置：

```text
HTML Rewrite            ON
CSS Rewrite             ON
Runtime Bridge          ON
Cookie Jar              ON
Compatibility Headers   ON
```

普通用户默认无需调整。

高级选项放到折叠面板。

---

# 52. 测试体系

必须创建：

```text
backend/nodejs/tests/
```

建议拆：

```text
unit/
integration/
fixtures/
```

---

# 53. Security Unit Tests

至少：

```text
http://127.0.0.1
http://localhost
http://10.0.0.1
http://192.168.1.1
http://169.254.169.254
http://[::1]
```

全部 Block。

Mock DNS：

```text
evil.test → 127.0.0.1
```

Block。

Mock DNS：

```text
mixed.test →
  93.184.216.34
  127.0.0.1
```

Block。

Redirect：

```text
public.test
↓
302
↓
127.0.0.1
```

Block。

---

# 54. Auth Tests

必须测试：

```text
Proxy Basic Auth
```

不会出现在 fixture upstream 收到的：

```text
Authorization
```

中。

同时：

```text
Upstream Bearer Auth
```

仍然正常。

---

# 55. Rewrite Fixtures

创建本地 fixture upstream：

```text
/html
/html-relative
/html-absolute
/html-base
/css
/form
/redirect
/redirect-chain
/cookie/set
/cookie/get
/sse
/range
/download
/large-html
```

HTML fixture 同时包含：

```text
relative URL
absolute URL
root-relative URL
srcset
form
iframe
CSS
CDN resource
```

---

# 56. Browser E2E

P2 建议增加：

```text
Playwright
```

至少验证：

```text
打开 Browser Proxy
↓
HTML 页面加载
↓
图片加载
↓
CSS 加载
↓
点击链接
↓
表单提交
↓
fetch()
↓
Cookie Session
↓
WebSocket
```

不要依赖 Google/GitHub 等真实公网网站作为 CI 测试。

所有自动测试使用本地 fixtures。

---

# 57. 兼容性测试矩阵

开发完成后手工测试类型：

| 类型 | 目标 |
|---|---|
| Static HTML | 必须优秀 |
| SSR Website | 必须优秀 |
| REST API | 必须优秀 |
| JSON API | 必须优秀 |
| Media / Range | 必须优秀 |
| Download | 必须优秀 |
| CSS / Font | 必须优秀 |
| SSE | 必须优秀 |
| Cookie Login | 尽量支持 |
| SPA | 较好支持 |
| WebSocket App | 较好支持 |
| OAuth | Best Effort |
| WAF/CAPTCHA | 不保证 |
| DRM | 不支持 |

---

# 58. 性能限制

必须加入：

```text
request timeout
connect timeout
max redirect
rewrite size
WebSocket maxPayload
rate limit
session lifetime
```

可选：

```text
max response size
```

但媒体/下载模式不应该因为较低的 API JSON 限制而被误伤。

因此：

```text
rewrite buffer limit
≠
stream response limit
```

---

# 59. Streaming 原则

> 状态：✅ 路线图 3.3 建立 transform/stream 分类，4.1 进一步用真实延迟与大 Body Fixture 验证 SSE、video、206 和 attachment 不进入 Rewrite Buffer。Rewrite Buffer 上限与流式响应大小保持独立。

以下内容永远优先 Streaming：

```text
video/*
audio/*
application/octet-stream
application/pdf
text/event-stream
大文件下载
```

不要 Buffer 整个 Response。

只有需要 Rewrite 的：

```text
text/html
text/css
```

进入 buffer/transform 流程。

---

# 60. Cache 处理

Body 发生 Rewrite 后至少删除：

```text
ETag
Content-MD5
Content-Length
```

否则 upstream ETag 对 proxy 修改后的 body 已无意义。

Passthrough Response 保留缓存 Header。

---

# 61. Error API

> 状态：✅ 基础模块及路线图 2.3–2.7 已于 2026-08-29 完成。当前代理自身错误使用稳定 JSON envelope，并覆盖 URL、DNS、SSRF、Redirect、连接/请求超时、请求体与并发上限等错误代码；未捕获异常进入受控 shutdown。

统一错误格式。

API Mode：

```json
{
  "error": {
    "code": "PROXY_SSRF_BLOCKED",
    "message": "Target resolves to a non-public address"
  }
}
```

错误代码建议：

```text
PROXY_INVALID_URL
PROXY_PROTOCOL_BLOCKED
PROXY_SSRF_BLOCKED
PROXY_DNS_FAILED
PROXY_CONNECT_TIMEOUT
PROXY_REQUEST_TIMEOUT
PROXY_REQUEST_BODY_LIMIT
PROXY_CONCURRENCY_LIMIT
PROXY_REDIRECT_BLOCKED
PROXY_REDIRECT_LIMIT
PROXY_UPSTREAM_ERROR
PROXY_REWRITE_LIMIT
```

Browser Mode 可以返回简单 HTML 错误页，但同样显示错误 code。

---

# 62. 安全错误信息

客户端不要看到：

```text
完整 Node stack
内部文件路径
Session Secret
内部 DNS 细节
```

详细信息写入 Server Log。

客户端返回简化错误。

---

# 63. README 更新

完成 P0/P1 后重写项目定位：

推荐：

> proxyWeb is a lightweight browser-based API debugging and HTTP reverse-proxy toolkit. It combines a Postman-like API client with an experimental browser proxy capable of rewriting and proxying common HTTP/HTTPS websites.

中文版：

> proxyWeb 是一个轻量的浏览器 API 调试与 Web 反向代理工具，提供类似 Postman 的 API 请求能力，并支持对常见 HTTP/HTTPS 网站进行代理访问和 URL 重写。

不要宣传：

```text
100% 代理所有网站
突破任意网站限制
绕过所有 Cloudflare
```

---

# 64. 文档状态与同步规则

文档按以下职责维护：

```text
README.md
  当前项目状态、快速开始、最高优先级安全警告

vue-request-app/README.md
  当前前端功能、构建部署、本地数据与凭据风险

backend/nodejs/README.md
  当前后端接口、配置、运行方式与安全限制

本文
  vNext 目标架构、里程碑与验收规格
```

每完成一个 Milestone，必须同时：

1. 更新本文对应条目的状态与验收结果；
2. 只把测试已经证明可用的能力写入当前 README；
3. 删除已经修复的 README 风险警告，或改为准确的剩余限制；
4. 保证命令、目录、端口、配置字段和单位与仓库实际文件一致；
5. 不以规划文本代替用户文档，不以代码注释代替部署和安全说明。

---

# 65. 推荐依赖

Node 后端新增依赖尽量控制在：

```text
tough-cookie
cheerio
ws
zod
```

CSS Rewrite 如果确实需要：

```text
postcss
```

不要引入大型浏览器自动化框架作为运行时依赖。

Playwright 只能作为 devDependency / E2E Test。

---

# 66. Node 版本

vNext 建议明确提升运行环境要求：

```text
Node.js 22+
```

不要为了兼容过旧 Node.js 而增加大量兼容代码。

如果暂时不准备 Breaking Change，可先保证当前代码运行，再在 README 中标记：

```text
Node 22+ recommended
```

---

# 67. 推荐开发顺序

严格按照以下顺序。

## Milestone 0 — Baseline

完成：

```text
建立测试
确认现有 API 功能
记录兼容行为
```

不要立即加 Browser 功能。

---

## Milestone 1 — Refactor

完成：

```text
main.js 模块化
Config Schema
Logger
Header Utils
统一 Error
```

要求：

```text
行为基本不变
```

---

## Milestone 2 — Security

完成：

```text
DNS SSRF
DNS Pinning
Redirect Validator
Auth Header Isolation
CORS
trustProxy
Log Redaction
```

此 Milestone 是发布阻塞项。

---

## Milestone 3 — Browser Core

> 状态：✅ 已于 2026-08-30 完成路线图 3.1–3.8，并通过 P1 Browser Core 自动化验收矩阵。Runtime Bridge 已在后续 4.2 单独验收；此 P1 状态仍不包含 WebSocket、高级 Worker/SPA 或多 upstream Origin Isolation。

完成：

```text
UrlMapper
Canonical Browser Route
HTML Rewrite
CSS Rewrite
Location Rewrite
CookieJar
Header Rewrite
```

达到：

```text
普通网站可用
```

---

## Milestone 4 — Browser Advanced

> 状态：🟨 路线图 4.1 的 SSE/Range/Media 与 4.2 的最小 Runtime Bridge 已完成；WebSocket、高级 SPA Compatibility 和 Origin Isolation 仍待后续阶段。

完成：

```text
Runtime Bridge
WebSocket
SSE Tests
Range Tests
SPA Compatibility
```

---

## Milestone 5 — Postman Lite

完成：

```text
Params
Body Types
cURL Import
cURL Export
Redirect UI
Timing
Collections
Environment
```

---

# 68. Codex 每阶段输出要求

完成一个 Milestone 后，应：

1. 列出修改文件；
2. 说明架构变化；
3. 说明兼容性影响；
4. 运行测试；
5. 修复失败测试；
6. 更新 README；
7. 不留下显然未使用的旧代码；
8. 不留下无说明的 TODO；
9. 不通过关闭安全检查让测试通过。

---

# 69. 旧 API 兼容要求

当前：

```text
/?url=https://example.com
```

保留。

当前：

```text
?method=
```

保留 Legacy Adapter。

当前：

```text
?headers={}
```

保留兼容，但标记 deprecated。

新 UI 不再主动使用：

```text
headers query parameter
```

因为 URL：

```text
容易进入日志
浏览器历史
分享链接
代理日志
```

导致 Token 泄漏。

---

# 70. 不允许的实现捷径

Codex 不应：

```text
关闭 SSRF
默认 allowPrivateNetworks=true
用 regex 重写所有 HTML
用 regex 重写完整 JavaScript
删除全部 Cookie
删除全部安全 Header
自动信任所有 Origin
自动信任所有 X-Forwarded-For
Follow Redirect 后不重新检查目标
为了网页兼容关闭 TLS 校验
设置 rejectUnauthorized=false
记录完整 Authorization
把所有网页 Response buffer 到内存
```

TLS 必须：

```text
rejectUnauthorized=true
```

除非未来单独提供明确标记的开发模式。

---

# 71. Browser Proxy 兼容目标

项目不是浏览器。

目标是：

```text
标准 HTTP Web 网站
+
普通 SPA
+
常见实时网页
```

预计兼容优先级：

```text
Static Website        ★★★★★
SSR Website           ★★★★★
REST API              ★★★★★
Media                 ★★★★★
Download              ★★★★★
Cookie Website        ★★★★
SPA                    ★★★★
SSE                    ★★★★
WebSocket              ★★★★
OAuth                  ★★
Complex WAF            ★
DRM                    ☆
```

---

# 72. 最终项目结构建议

```text
proxyWeb/
│
├── backend/
│   │
│   ├── nodejs/
│   │   ├── main.js
│   │   ├── app.js
│   │   │
│   │   ├── config/
│   │   ├── core/
│   │   ├── middleware/
│   │   ├── api-proxy/
│   │   ├── browser-proxy/
│   │   ├── websocket/
│   │   └── tests/
│   │
│   └── python/
│
├── vue-request-app/
│   └── src/
│       ├── components/
│       │   ├── api/
│       │   └── browser/
│       ├── services/
│       ├── stores/
│       ├── utils/
│       └── config.js
│
├── docs/
│   ├── architecture.md
│   ├── security.md
│   ├── browser-proxy.md
│   └── deployment.md
│
└── README.md
```

---

# 73. 最终验收场景

Codex 在宣布 vNext 第一阶段完成前，需要确保以下场景可运行。

### API

```text
GET JSON
POST JSON
PUT
PATCH
DELETE
HEAD
Bearer Auth
Custom Headers
Raw Body
Large Response
Download
Range
SSE
```

### Browser

```text
HTML
Relative Image
Absolute Image
CSS
CSS url()
Font
External JS
Form GET
Form POST
Redirect
Cross-origin CDN
Cookie Session
Media
Download
```

### Security

```text
localhost blocked
RFC1918 blocked
IPv6 local blocked
DNS → private blocked
Redirect → private blocked
Proxy password not leaked
Token not logged
Invalid Origin rejected
TLS validation enabled
```

---

# 74. 第一轮实际开发范围

为了避免 Codex 一次修改过大，本轮实际要求优先完成：

```text
P0 全部
+
P1 Browser Core
```

也就是：

```text
模块化
SSRF DNS
DNS Pinning
Redirect 安全
Auth 隔离
CORS 修复
日志脱敏
Config Schema
UrlMapper
Browser Route
HTML Rewrite
CSS Rewrite
Location Rewrite
CookieJar
Streaming Pipeline
Range 保持
测试
README
```

P2：

```text
Runtime Bridge
WebSocket
高级 SPA
Wildcard Origin Isolation
```

可以在 P0/P1 完成后继续。

P3 Postman 功能增强最后进行。

---

# 75. 最终 Definition of Done

第一阶段只有在以下条件全部满足后才算完成：

```text
npm install
npm start
```

能够启动。

现有 API 功能没有重大回归。

```text
npm test
```

全部通过。

安全测试全部通过。

普通 HTML 网站通过 Browser Route 可以：

```text
加载页面
加载图片
加载 CSS
点击链接
处理 Redirect
维持 Cookie
```

跨域 CDN Resource 不直接逃离 proxyWeb。

SSRF 无法通过：

```text
DNS
Redirect
IPv6
直接 IP
```

简单绕过。

Proxy 自身凭证不会发送给 upstream。

敏感 Header 不会进入普通日志。

Binary、Media、SSE 不会被错误 HTML Rewrite。

README 已准确说明：

```text
功能
部署
安全限制
Browser Mode 限制
```

完成这些后，再进入：

```text
P2 Runtime Bridge + WebSocket
```

开发。

---

# 76. Codex 开始任务

首先执行：

```text
1. 阅读当前整个仓库；
2. 运行现有项目；
3. 建立回归测试；
4. 将 main.js 模块化；
5. 完成全部 P0；
6. 确保旧功能测试通过；
7. 开始 P1 Browser Core；
8. 完成 Browser Fixtures；
9. 运行全部测试；
10. 更新 README 和架构文档。
```

不要优先调整 UI 美术。

当前最重要的顺序是：

```text
Security
   ↓
Architecture
   ↓
Browser Compatibility
   ↓
Postman UX
```

项目最终定位保持：

# proxyWeb
## Postman Lite + Web Reverse Proxy

核心原则：

> API Mode 尽可能忠实转发 HTTP。  
> Browser Mode 在安全边界内尽可能模拟原网站访问。  
> 所有目标地址在真正建立连接前都必须经过完整 SSRF 校验。  
> 网页兼容性不能凌驾于代理服务器自身安全之上。
