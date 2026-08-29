# proxyWeb

轻量的浏览器 API 调试界面与 Node.js HTTP 代理实验项目。当前版本可用于本地开发和受信网络中的 API 调试；vNext 计划在此基础上补齐安全边界、测试体系和 Browser Proxy 能力。

![界面预览](./vue-request-app/review.png)

> [!WARNING]
> 当前后端已完成路线图 2.1–2.7，但 P0 集成门禁尚未收口，**不要直接暴露到公网，也不要把它当作生产级开放代理**。完整问题和改造顺序见 [vNext 开发计划与技术方案](./proxyWeb%20vNext%20开发计划与技术方案.md)。

## 当前能力

| 模块 | 已实现 |
| --- | --- |
| API 请求 | GET、POST、PUT、DELETE、PATCH、HEAD；查询参数；自定义请求头 |
| 请求体 | URL 编码表单、multipart 文件、JSON、纯文本 |
| 上游认证 | Basic Auth、Bearer Token |
| 响应 | JSON/文本格式化、响应头、图片/音视频预览、文件下载 |
| 本地功能 | 响应式界面、分享链接、浏览器本地历史记录 |
| 后端 | 流式转发、Session 目标地址、限流、日志、部分配置热加载 |

当前并没有完整的网页反向代理模式；HTML/CSS URL 重写、Cookie Jar、WebSocket 和 SPA 兼容属于 vNext 规划，而不是已完成功能。

## 目录结构

```text
proxyWeb/
├── backend/
│   ├── main.json.example        # 后端配置模板
│   ├── echo.js                  # 独立回显服务（开发辅助）
│   └── nodejs/
│       ├── main.js              # 进程启动与关闭入口
│       ├── app.js               # Express App Factory 与当前代理逻辑
│       ├── config/              # 默认值、Schema 与配置加载
│       ├── core/                # 日志脱敏、Header 与错误基础模块
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
| `api.followRedirects` | 是否启用 proxyWeb 安全逐跳循环 | 是 |
| `api.maxRedirects` | 安全逐跳循环的最大次数 | 是 |
| `api.connectTimeoutMs` | 每一跳 TCP/TLS 连接超时，毫秒 | 是 |
| `api.maxRequestBodyBytes` | 非 GET/HEAD 请求体与 Redirect 重放缓存上限，字节 | 是 |
| `api.maxConcurrentRequests` | 同时执行的代理请求上限，超出返回 503 | 是 |

旧配置仍会迁移：`timeout` 按秒转换为 `timeoutMs`，`cookie_max_age` 按秒转换为 `session.maxAgeMs`，`session.cookie.maxAge` 保持毫秒，`accessOrigin`、`blacklist` 和 `max_redirects` 分别迁移到 `cors.allowedOrigins`、`security.blockedHostnames` 与 `api.maxRedirects`。旧 `accessOrigin: "*"` 会以 `allowCredentials: false` 迁移；旧黑名单值按精确主机或前导通配子域规则校验，不再作为正则执行。迁移会记录弃用警告，建议按模板尽快更新。

## 当前安全边界

- URL Validator 已拒绝非 HTTP(S) 协议、URL credentials、非法编码、localhost，以及 loopback/private/link-local/unspecified/multicast/reserved 等字面 IPv4/IPv6。域名使用 `lookup(all: true, verbatim: true)` 校验全部 A/AAAA，任一结果非公网即整体拒绝；请求级 HTTP/HTTPS Agent 的 `lookup` 只能返回该验证集合，并保持原 hostname、Host、SNI 和严格 TLS 证书校验。
- Axios 自身固定 `maxRedirects: 0`；启用 `api.followRedirects` 时由 proxyWeb 处理 301/302/303/307/308，每一跳重新执行 URL、DNS 与 Pinning 校验。跨域跳转会删除认证、Cookie、Token、Secret 与 API Key 类 Header，循环或超限返回 508。
- 代理请求同时受 `timeoutMs`、`api.connectTimeoutMs`、`api.maxRequestBodyBytes` 与 `api.maxConcurrentRequests` 约束；客户端断开会取消上游，异常响应流由管道边界回收。API 响应仍保持流式转发，不受 Rewrite 缓冲上限影响。
- 未捕获异常和未处理 Promise rejection 不再作为可继续运行的恢复机制，而会停止接收连接、关闭 runtime，并在超时后强制退出。
- 代理自身 Basic Auth 已与上游认证隔离：普通 `Authorization` 只用于代理鉴权，上游认证使用 `X-ProxyWeb-Upstream-Authorization`。
- 旧 `headers` 查询参数仍为兼容而接受，并会返回弃用提示；新版前端不再用它发送 Header，也不会把敏感 Header 写入分享/API 链接或历史。目标 URL 自身若包含 Token 仍可能进入浏览器历史和剪贴板。
- CORS 使用显式 Origin allowlist；非法或未授权 Origin 会被拒绝，无 Origin 请求不会获得 CORS 响应头。`allowCredentials: true` 与 `allowedOrigins: ["*"]` 的组合会在配置加载时被拒绝。
- `trustProxy` 的模板、内置默认值和旧配置补全值均为 `false`，限流默认以直连地址识别客户端并忽略伪造的 `X-Forwarded-For`。只有位于可信反向代理后方时，才应按实际代理跳数或地址显式启用。
- Session 使用进程内存存储，不适合多实例或长期生产运行。

其中未完成的问题已作为 vNext P0 阻塞项记录。更详细的运行方式与限制见 [后端文档](./backend/nodejs/README.md)，前端数据与构建说明见 [前端文档](./vue-request-app/README.md)。

## 文档索引

- [前端 README](./vue-request-app/README.md)
- [Node.js 后端 README](./backend/nodejs/README.md)
- [vNext 开发计划与技术方案](./proxyWeb%20vNext%20开发计划与技术方案.md)
- [vNext 分阶段实施路线图](./docs/vnext-implementation-roadmap.md)

## 许可证状态

仓库当前没有 `LICENSE` 文件，因此暂不声明具体开源许可证。发布或接受外部贡献前，建议补充正式许可证文件，并再恢复许可证徽章与声明。
