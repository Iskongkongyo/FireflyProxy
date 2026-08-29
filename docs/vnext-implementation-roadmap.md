# proxyWeb vNext 分阶段实施路线图

> 总体规格：[proxyWeb vNext 开发计划与技术方案](../proxyWeb%20vNext%20开发计划与技术方案.md)  
> 当前实现说明：[项目 README](../README.md)  
> 建立日期：2026-08-28

本文把总体技术方案拆成可独立实现、测试、审查和回滚的小阶段。总体技术方案定义“最终要达到什么”，本文定义“按什么顺序完成”。若两者冲突，以总体技术方案的安全约束和 Definition of Done 为准。

## 执行规则

1. 一个小阶段原则上对应一个 PR 或一组紧密相关的提交，不跨阶段混入 UI 美化或无关重构。
2. 每个阶段先补测试或 fixture，再修改实现；测试不得依赖 Google、GitHub 等真实公网服务。
3. 保留旧 `/?url=...` API，除非阶段说明明确进入有迁移期的弃用流程。
4. P0 安全门禁全部通过前，不开始 P1 Browser Core，也不宣称可公网生产部署。
5. 每阶段都要执行相关单元测试、集成测试、Lint 和构建；失败时不得通过关闭 TLS/SSRF/CORS 检查绕过。
6. 新配置必须有默认值、Schema 校验和旧配置迁移测试；时间字段统一使用 `*Ms`。
7. 日志、错误响应和测试快照不得包含 Authorization、Cookie、Token、Session secret 或本机绝对路径。
8. 阶段完成后同步更新当前 README、总体技术方案状态和本文状态表。

状态标记：`⬜ 未开始`、`🟨 进行中`、`✅ 已完成`、`⛔ 阻塞`。

## 总览与依赖

| 顺序 | 阶段 | 结果 | 前置条件 | 状态 |
| --- | --- | --- | --- | --- |
| 0.0 | 仓库基线 | 可追踪、可回滚的初始版本 | 无 | ✅ |
| 0.1 | 后端 npm 工程化 | 可复现安装、启动和测试 | 0.0 | ✅ |
| 0.2 | 本地 Fixture 与测试骨架 | 不依赖公网的测试环境 | 0.1 | ✅ |
| 0.3 | 现有行为契约 | 重构前回归保护 | 0.2 | ✅ |
| 1.1 | App Factory 与入口拆分 | 可测试的 Express 应用 | 0.3 | ✅ |
| 1.2 | 配置系统统一 | Schema、单位和迁移明确 | 1.1 | ✅ |
| 1.3 | 日志、Header 与错误基础模块 | 安全模块共用基础设施 | 1.2 | ⬜ |
| 2.1 | 认证头隔离与日志脱敏 | 先关闭凭据泄漏风险 | 1.3 | ⬜ |
| 2.2 | CORS 与 trust proxy | 明确浏览器和代理边界 | 1.3 | ⬜ |
| 2.3 | URL/IP Validator | 统一目标基础校验 | 1.3 | ⬜ |
| 2.4 | DNS SSRF 校验 | 域名全部解析结果受控 | 2.3 | ⬜ |
| 2.5 | DNS Pinning | 校验 IP 与连接 IP 一致 | 2.4 | ⬜ |
| 2.6 | 安全 Redirect Loop | 每一跳重新校验 | 2.5 | ⬜ |
| 2.7 | 进程策略与资源限制 | 错误可控、资源有界 | 2.1–2.6 | ⬜ |
| 2.8 | P0 集成门禁 | P0 Definition of Done | 2.1–2.7 | ⬜ |
| 3.1 | API/Browser 路由分离 | 两种模式边界固定 | 2.8 | ⬜ |
| 3.2 | UrlMapper | Browser Canonical URL | 3.1 | ⬜ |
| 3.3 | Transform Pipeline | 流式与 Rewrite 正确分流 | 3.2 | ⬜ |
| 3.4 | HTML Rewrite | 页面资源和导航留在代理内 | 3.3 | ⬜ |
| 3.5 | CSS 与 Location Rewrite | 样式资源和跳转可用 | 3.4 | ⬜ |
| 3.6 | Cookie Jar 与 Header Policy | 会话及上游语义映射 | 3.5 | ⬜ |
| 3.7 | Browser UI | 独立入口与兼容设置 | 3.6 | ⬜ |
| 3.8 | P1 E2E 门禁 | Browser Core 可验收 | 3.7 | ⬜ |
| 4.1 | SSE 与 Range/Media | 实时流与媒体拖动可靠 | 3.8 | ⬜ |
| 4.2 | Runtime Bridge | 常见 SPA 动态请求可映射 | 4.1 | ⬜ |
| 4.3 | WebSocket | WS/WSS 安全代理 | 4.2 | ⬜ |
| 4.4 | Origin Isolation | 多目标隔离增强 | 4.3 | ⬜ |
| 5.1 | 请求编辑增强 | Params、Body、cURL | 2.8，可并行于 P1 后执行 | ⬜ |
| 5.2 | 响应诊断 | Redirect Chain、Timing | 5.1 | ⬜ |
| 5.3 | Environment 与 Collections | 可复用请求资产 | 5.2 | ⬜ |

依赖主线：

```text
基线与测试
  → 无行为重构
  → P0 安全
  → API/Browser 分路由
  → Browser Core
  → SPA/实时能力
  → Postman Lite 增强
```

## Milestone 0：基线与可复现工程

### 0.0 仓库基线

目标：在任何重构前拥有可信的差异和回滚点。

产物：

- 确认 `.gitignore` 不会忽略源码、配置模板和测试 fixture。
- 将当前全部未跟踪文件纳入一次明确的基线提交；真实密钥和运行日志不得提交。
- 记录 Node.js 22+、npm 版本、当前启动命令和已知构建警告。
- 保存当前 README 作为行为核对依据。

完成条件：`git status` 可解释，能够从干净检出恢复到当前可构建状态。

### 0.1 后端 npm 工程化

目标：让 `backend/nodejs` 可复现安装和执行。

产物：

- `package.json`、锁文件和 `engines.node`。
- `start`、`dev`、`test`、`test:unit`、`test:integration`、`lint` 脚本。
- 明确 runtime dependencies 与 devDependencies；移除注释中未使用的依赖描述。
- 配置模板保留在仓库，真实 `main.json` 作为本地配置处理。

测试：干净目录执行 `npm ci`、`npm start`、`npm test`；启动和停止不得留下失控子进程。

### 0.2 本地 Fixture 与测试骨架

目标：建立完全本地、可重复的上游环境。

产物：

- `tests/unit/`、`tests/integration/`、`tests/fixtures/`。
- Fixture 覆盖 JSON、各 HTTP 方法、Raw/Form/Multipart、Redirect、Header Echo、下载、Range、SSE、错误和超时。
- 使用动态端口，测试结束后关闭 Server、Socket 和 Timer。
- DNS 和连接层使用可控 resolver/lookup，不修改系统 hosts。

完成条件：测试可离线运行、可并行运行、连续执行无端口占用。

### 0.3 现有行为契约

目标：为拆分 `main.js` 建立回归边界。

至少固定：

- `/?url=...` 的 GET、POST、PUT、PATCH、DELETE、HEAD 行为。
- 请求体与自定义 Header 转发。
- 状态码、常见响应头和流式响应。
- Session targetUrl、默认跳转、Basic Auth、限流、CORS 预检。
- 当前配置热加载范围。

安全缺陷不得被写成永久正确行为；对已知漏洞使用明确的待修测试或安全回归用例，并在对应 P0 阶段转为强制通过。

## Milestone 1：无行为重构

### 1.1 App Factory 与入口拆分

目标：把进程生命周期与 Express 应用分开。

产物：

- `main.js` 只负责加载配置、启动 Server 和注册 shutdown。
- `app.js` 导出可注入依赖的 `createApp()`。
- 路由、中间件和网络客户端按总体方案拆到独立目录。
- 测试直接创建 app，不通过固定端口启动整个进程。

完成条件：0.3 全部契约测试保持通过，旧 API 和默认端口不变。

### 1.2 配置系统统一

目标：消除当前字段漂移和秒/毫秒混用。

产物：

- 默认配置、Schema、Loader、校验错误和热加载策略。
- 统一 `timeoutMs`、`windowMs`、`maxAgeMs`。
- 旧 `timeout`、`cookie_max_age`、`cookie_secure`、`cookie_httponly`、`max_redirects` 的迁移适配与弃用日志。
- 区分启动期配置和请求期可热加载配置；无效新配置不覆盖最后一份有效配置。

测试：默认值、环境变量、旧配置迁移、非法类型、边界值、热加载和回滚。

### 1.3 日志、Header 与统一错误基础模块

目标：为所有后续安全逻辑提供单一实现。

产物：

- Logger、redact 工具、request ID。
- hop-by-hop Header、代理认证 Header、上游 Header 的分类工具。
- 统一错误类和 `{ error: { code, message } }` API 格式。
- 客户端不返回 Stack、内部路径或 DNS 细节。

完成条件：现有功能不变；敏感字段脱敏测试先建立并在 2.1 强制门禁。

## Milestone 2：P0 安全门禁

### 2.1 认证头隔离与日志脱敏

目标：优先关闭最直接的凭据泄漏路径。

产物：

- 代理自身认证与上游认证使用不同内部字段/处理阶段。
- 完成代理鉴权后立即删除对应凭据，禁止发送给 upstream。
- 上游 Bearer/Basic 仍可由安全的请求头路径发送。
- URL、Header、错误对象和配置日志统一脱敏。
- 前端停止主动生成包含 Authorization 的新分享/API 链接；旧 `headers` query 只保留迁移兼容并标记 deprecated。

测试：fixture 永远收不到代理密码；上游 Token 可正常收到；日志和错误快照中不存在秘密。

### 2.2 CORS 与 trust proxy

目标：使浏览器来源和客户端 IP 判断可配置、可预测。

产物：

- 明确 Origin allowlist；带 Credentials 时禁止通配反射。
- 正确处理无 Origin、非法 Origin、预检方法和请求头。
- `trustProxy` 进入配置，默认 `false`，按实际部署层数启用。
- 限流 key 使用经过明确定义的客户端地址。

测试：允许/拒绝 Origin、Credentials、OPTIONS、伪造 X-Forwarded-For、多层代理配置。

### 2.3 URL 与字面 IP Validator

目标：先完成不依赖 DNS 的纯函数校验。

产物：

- 只允许 HTTP/HTTPS，拒绝 URL credentials、空 hostname 和非法编码。
- 规范化 IPv4、IPv6、IPv4-mapped IPv6。
- 完整拒绝 loopback、private、link-local、unspecified、multicast、reserved 等非公网范围。
- 黑名单改为明确的 hostname 规则，避免直接拼接不受控正则。

测试：总体方案列出的 IPv4/IPv6、边界网段和编码变体全部覆盖。

### 2.4 DNS SSRF 校验

目标：域名的所有解析结果都必须是允许连接的公网地址。

产物：

- 注入式 DNS resolver，同时解析 A/AAAA。
- 任一结果不可用即拒绝；空结果、解析错误、混合公网/私网结果均安全失败。
- DNS 结果具有请求级上下文，供连接层使用。

测试：public、private、mixed、失败、超时、多 A/AAAA 和 IPv4-mapped IPv6。

### 2.5 DNS Pinning 与连接层

目标：确保实际 TCP/TLS 连接使用已经校验的 IP。

产物：

- 自定义 lookup/Agent 或等价连接策略，把已验证地址绑定到请求。
- HTTPS 保持正确 SNI、hostname 校验和 `rejectUnauthorized=true`。
- 连接地址与校验地址不一致时拒绝。

测试：DNS Rebinding、TOCTOU、TLS hostname、无效证书、IPv4/IPv6 连接选择。

### 2.6 安全 Redirect Loop

目标：禁止 Axios 绕过校验自动跳转。

产物：

- 网络客户端使用 `maxRedirects: 0`。
- proxyWeb 自己实现 301/302/303/307/308 跳转循环。
- 每一跳解析相对 Location、重新进行 URL/DNS/Pinning 校验。
- 限制跳转次数并记录脱敏 redirect chain。
- 按 HTTP 规范明确不同状态码的方法与请求体变化。

测试：相对/绝对跳转、循环、超限、公网跳私网、跨域敏感头清理、307/308 Body 保留。

### 2.7 进程策略与资源限制

目标：单个请求失败不会失控，资源使用有上限。

产物：

- 请求错误在路由边界转换为统一错误；不依赖 `uncaughtException` 继续运行。
- 未捕获异常进入受控 shutdown，停止接收新连接并关闭资源。
- connect/request timeout、请求体上限、Redirect 上限、Session 生命周期等配置生效。
- Streaming 与 Rewrite 使用不同大小限制，避免大响应整体缓冲。

测试：超时、客户端断开、上游中断、畸形流、并发请求和 graceful shutdown。

### 2.8 P0 集成门禁

完成条件：

- 总体方案第 15 节的 P0 Definition of Done 全部自动化验证。
- `npm ci && npm test && npm run lint` 通过，前端 `npm run lint && npm run build` 通过。
- 旧 API 的主要行为没有重大回归，弃用项有迁移说明。
- README 准确描述新的配置、错误码和剩余限制。
- 安全测试覆盖直接 IP、DNS、Redirect、IPv6、认证隔离、日志脱敏、CORS 和 TLS。

只有本阶段通过后，才允许开始 Browser Core。

## Milestone 3：P1 Browser Core

### 3.1 API Mode 与 Browser Mode 分路由

目标：避免 API 忠实转发与网页兼容改写相互污染。

产物：

- `ANY /__proxyweb/api?url=...` 作为新 API Route。
- `/__proxyweb/browser/...` 作为 Browser Route。
- 旧 `/?url=...` 作为兼容 Adapter，并输出弃用提示而非立即删除。
- 两种模式复用安全网络内核，但使用独立 Header/Response Policy。

### 3.2 UrlMapper 与 Canonical URL

目标：所有 Browser 资源具有稳定、可逆的代理 URL。

产物：encode/decode、相对 URL 解析、查询/Fragment、路径规范化和目标隔离测试；映射 Token 只作路由标识，不作为安全凭据。

### 3.3 Response Transform Pipeline

目标：只有需要 Rewrite 的内容进入有限缓冲，其余保持流式。

产物：

- 按 Content-Type 和模式选择 passthrough、stream 或 transform。
- HTML/CSS 解压、字符集处理、重写和重新压缩流程。
- `maxRewriteBytes`；超限返回明确错误或安全回退。
- Rewrite 后移除/重算 Content-Length、ETag、Content-MD5。

### 3.4 HTML Rewrite

目标：静态与 SSR 页面中的常见资源、导航和表单继续经过 proxyWeb。

覆盖 `href`、`src`、`action`、`poster`、`srcset`、`<base>`、Meta Refresh、内联 style；使用 HTML Parser，不使用正则整体重写 HTML。

### 3.5 CSS 与 Location Rewrite

目标：CSS 资源和服务端跳转保持在 Browser Route。

覆盖 CSS `url()`、`@import`、绝对/相对 `Location`、跨域 CDN；不得尝试用正则重写完整 JavaScript。

### 3.6 Cookie Jar 与 Header Policy

目标：在 proxyWeb Session 内维护上游 Cookie，同时隔离不同目标。

产物：

- 基于 upstream domain/path/secure/expiry 的 Cookie Jar。
- 不把所有上游 Cookie 直接设置到 proxyWeb 域名。
- Browser Origin/Referer 映射、Host 与 hop-by-hop Header 处理。
- API Mode 尽量保留安全响应头；Browser Mode 仅按显式兼容策略调整必要 Header。

### 3.7 Browser UI

目标：让用户明确选择 API 请求或网页代理。

产物：独立 Browser Proxy 页面、默认新标签页打开、可折叠兼容设置、安全和兼容限制提示；API UI 行为保持不变。

### 3.8 P1 E2E 门禁

使用本地 Playwright fixture 验证 HTML、图片、CSS、字体、脚本、链接、表单、Redirect、跨域 CDN、Cookie、媒体和下载。完成总体方案第 37 节 P1 Definition of Done 后，才进入 P2。

## Milestone 4：P2 SPA 与实时能力

### 4.1 SSE 与 Range/Media

分别建立专项管线与测试：SSE 不缓冲且及时 flush；Range 保留 206、Content-Range、Accept-Ranges 和正确 Content-Length；媒体拖动与大文件下载不进入 Rewrite Buffer。

### 4.2 Runtime Bridge

最小注入并保持原生函数语义，映射 `fetch`、XHR、动态 URL 和 History API。必须可配置关闭，不捕获或记录请求 Body/Token，不承担 WAF/CAPTCHA 绕过。

### 4.3 WebSocket

支持 ws/wss URL 映射、Upgrade Header、双向流、关闭码和 backpressure；握手目标同样执行 DNS SSRF、Pinning、Origin Policy 和大小限制。

### 4.4 Origin Isolation

评估子域名或等价隔离方案，解决多个 upstream 共用一个 proxyWeb origin 带来的存储和权限边界问题。该阶段需要单独威胁建模，不能为了兼容默认信任通配域名。

## Milestone 5：P3 Postman Lite

### 5.1 请求编辑与 cURL

补齐 Params 开关、Body 类型、文件 UX、Import/Export cURL；Export 必须进行正确 Shell 转义，Import 不执行命令。

### 5.2 Redirect Chain 与 Timing

展示最终 URL、跳转链、总耗时和响应大小；先实现可靠的 total，再逐步增加 DNS/connect/TLS/TTFB。

### 5.3 Environment 与 Collections

实现环境变量、Folder 和 Saved Request，优先 IndexedDB。Token 存储必须有明确风险提示，不在本阶段承诺账户同步。

## 每阶段交付模板

完成任一阶段时，在 PR/提交说明中填写：

```markdown
## 阶段
例如：2.4 DNS SSRF 校验

## 修改文件
- ...

## 行为变化
- 新行为：...
- 兼容行为：...
- 弃用项：...

## 安全影响
- 关闭的风险：...
- 剩余风险：...

## 验证
- [ ] npm ci
- [ ] npm test
- [ ] npm run lint
- [ ] 前端 lint/build（如受影响）
- [ ] 文档与配置模板已同步

## 回滚点
- 可独立回滚的提交：...
```

## 建议的第一轮执行范围

第一轮只执行 0.0–0.3：

1. 建立 Git 基线。
2. 补齐后端依赖清单和脚本。
3. 创建本地 fixture 与测试目录。
4. 固定当前 API 行为，记录安全测试待办。

第一轮不拆 `main.js`、不改变代理协议、不实现 Browser Mode。这样可以先获得可靠安全网，再从 1.1 开始重构。

### 第一轮执行记录

2026-08-28 已完成 0.0–0.3：

- `3c572cc`：建立仓库基线并排除本地敏感配置。
- `661bd06`：增加后端 `package.json`、锁文件和标准脚本。
- `bbb0220`：增加纯本地 Fixture、DNS 测试注入与进程辅助工具。
- 当前代理契约：16 项通过，5 项 P0 安全门禁标记为 TODO。
- Fixture 单元测试：2 项通过。

第一轮完成后进入 1.1 App Factory 与入口拆分。

### 第二轮执行记录

2026-08-28 已完成 1.1：

- `main.js` 缩减为进程启动、异常记录、SIGINT/SIGTERM 关闭入口。
- `app.js` 导出 `createApp({ configPath, watchConfig })`，返回隔离的 app、配置访问器、重载函数和关闭函数。
- 现有 16 项代理契约全部保持通过。
- 新增 2 项 App Factory 单元测试，验证配置注入、延迟监听与 runtime 隔离。

第二轮完成后进入 1.2 配置系统统一。

### 第三轮执行记录

2026-08-29 已完成 1.2：

- 增加 `config/defaults.js`、`config/schema.js`、`config/loader.js` 和 Zod Schema。
- 运行时统一使用 `timeoutMs`、`session.maxAgeMs`、`limiter.windowMs`。
- 兼容迁移 `timeout`、`accessOrigin`、旧 Session Cookie 字段与 `max_redirects`。
- 支持 `${ENV_NAME}` 插值、严格未知字段检查和深度冻结配置。
- 热更新改为原子替换；JSON、环境变量、Schema 或限流器失败时保留最后有效配置。
- 配置/Fixture 单元测试 12 项、代理契约 17 项通过，5 项 P0 安全门禁保持 TODO。

下一阶段为 1.3 日志、Header 与统一错误基础模块。
