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
| 1.3 | 日志、Header 与错误基础模块 | 安全模块共用基础设施 | 1.2 | ✅ |
| 2.1 | 认证头隔离与日志脱敏 | 先关闭凭据泄漏风险 | 1.3 | ✅ |
| 2.2 | CORS 与 trust proxy | 明确浏览器和代理边界 | 1.3 | ✅ |
| 2.3 | URL/IP Validator | 统一目标基础校验 | 1.3 | ✅ |
| 2.4 | DNS SSRF 校验 | 域名全部解析结果受控 | 2.3 | ✅ |
| 2.5 | DNS Pinning | 校验 IP 与连接 IP 一致 | 2.4 | ✅ |
| 2.6 | 安全 Redirect Loop | 每一跳重新校验 | 2.5 | ✅ |
| 2.7 | 进程策略与资源限制 | 错误可控、资源有界 | 2.1–2.6 | ✅ |
| 2.8 | P0 集成门禁 | P0 Definition of Done | 2.1–2.7 | ✅ |
| 3.1 | API/Browser 路由分离 | 两种模式边界固定 | 2.8 | ✅ |
| 3.2 | UrlMapper | Browser Canonical URL | 3.1 | ✅ |
| 3.3 | Transform Pipeline | 流式与 Rewrite 正确分流 | 3.2 | ✅ |
| 3.4 | HTML Rewrite | 页面资源和导航留在代理内 | 3.3 | ✅ |
| 3.5 | CSS 与 Location Rewrite | 样式资源和跳转可用 | 3.4 | ✅ |
| 3.6 | Cookie Jar 与 Header Policy | 会话及上游语义映射 | 3.5 | ✅ |
| 3.7 | Browser UI | 独立入口与兼容设置 | 3.6 | ✅ |
| 3.8 | P1 E2E 门禁 | Browser Core 可验收 | 3.7 | ✅ |
| 4.1 | SSE 与 Range/Media | 实时流与媒体拖动可靠 | 3.8 | ✅ |
| 4.2 | Runtime Bridge | 常见 SPA 动态请求可映射 | 4.1 | ✅ |
| 4.3 | WebSocket | WS/WSS 安全代理 | 4.2 | ✅ |
| 4.4 | Origin Isolation | 多目标隔离增强 | 4.3 | ✅ |
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

### 第四轮执行记录

2026-08-29 已完成 1.3：

- 增加 `core/logger.js`、`core/redact.js`，应用不再覆写全局 `console`；所有 transport 写入前统一脱敏。
- 增加服务端 request ID 和 `X-Request-ID` 响应头，请求日志不记录 Body，并脱敏敏感查询字段。
- 增加 `core/headers.js`，集中分类并过滤 hop-by-hop、代理认证和上游请求/响应 Header；`Cookie` 不再被错误归类为 hop-by-hop。
- 增加 `ProxyError`、稳定错误代码和 `{ error: { code, message } }` 响应；502/504 不再返回底层 Stack、路径或网络细节。
- 后端测试 41 项通过，5 项后续 P0 门禁保持 TODO，0 项失败。

下一阶段为 2.1 认证头隔离与日志脱敏强制门禁。

### 第五轮执行记录

2026-08-29 已完成 2.1：

- 新增 `middleware/auth.js`；普通 `Authorization` 只用于 proxyWeb Basic Auth，校验后立即删除，内部仅保留不含密码的认证上下文。
- 新增 `X-ProxyWeb-Upstream-Authorization` 安全通道；上游 Bearer/Basic 正常透传，控制头和代理凭据均不会到达 upstream。
- 旧 `headers` query 保持兼容，但返回 `Deprecation: true` 和 `Warning: 299`，并记录不含值的弃用日志。
- 前端请求改用真实 HTTP Header，分享/API 链接和历史记录过滤敏感 Header，移除包含 URL、配置和错误响应的调试日志。
- 代理凭据隔离与真实子进程日志脱敏 TODO 已转为强制测试；后端 48 项通过、3 项后续 P0 门禁 TODO，前端 3 项通过。
- 更新前端兼容范围内的锁定生产依赖，生产审计降为 0；Vue CLI 5 开发工具链的 17 个间接公告记录为后续构建迁移项，不执行 npm 建议的破坏性强制降级。

下一阶段为 2.2 CORS 与 `trust proxy` 边界收紧。

### 第六轮执行记录

2026-08-29 已完成 2.2：

- 新增独立严格 CORS 中间件；仅接受规范 HTTP(S) Origin，显式拒绝未授权 Origin，并正确区分普通 OPTIONS 与带 `Access-Control-Request-Method` 的预检请求。
- `allowCredentials: true` 必须使用显式 Origin allowlist，Schema 拒绝与 `*` 组合；旧 `accessOrigin: "*"` 自动以关闭 Credentials 的安全方式迁移。
- 响应只向有效跨域请求暴露实际响应头；无 Origin 请求不再依据 Referer 生成 CORS 响应。
- `trustProxy` 的内置默认值改为 `false`；限流沿用 Express 基于显式信任策略计算的 `req.ip`，默认忽略伪造的 `X-Forwarded-For`。
- 新增允许/拒绝 Origin、Credentials、OPTIONS、非法请求头、伪造 XFF 和多层代理跳数测试；后端 58 项通过、2 项后续 P0 门禁 TODO、0 项失败。

下一阶段为 2.3 URL 与字面 IP Validator。

### 第七轮执行记录

2026-08-29 已完成 2.3：

- 新增 `core/targetValidator.js`，以稳定错误代码区分非法 URL、禁用协议和 SSRF 拦截，并返回后续 DNS/Pinning 阶段可扩展的规范目标结构。
- 仅允许规范 HTTP(S) URL；拒绝 URL credentials、空/非法 hostname、异常百分号编码、反斜线和未编码控制字符。
- 规范化 IPv4、IPv6 与 IPv4-mapped IPv6，拒绝 loopback、private、CGNAT、link-local、unspecified、multicast、broadcast、reserved 及特殊用途范围；兼容拦截十进制、八进制、十六进制和缩写 IPv4 表示。
- `blacklist` 迁移为 `security.blockedHostnames`，只支持精确 hostname 与 `*.example.com` 前导通配子域，不再拼接或执行正则；已有 Session 目标会在后续请求重新应用热加载规则。
- URL userinfo 在请求日志阶段即脱敏，空目标使用统一错误响应，预留配置不能关闭字面地址门禁；新增纯函数、配置迁移和子进程集成门禁，后端 71 项通过、2 项后续 P0 门禁 TODO、0 项失败。

下一阶段为 2.4 DNS SSRF 校验。

### 第八轮执行记录

2026-08-29 已完成 2.4：

- 新增 `core/dnsResolver.js`，默认使用 `dns.promises.lookup(hostname, { all: true, verbatim: true })`，并提供可注入 lookup、5 秒上界、空结果与失败分类。
- `validateTarget()` 对域名的全部 A/AAAA 结果进行格式、family、一致性与显式特殊用途 CIDR 校验；任一 private、mixed 或非法结果即整体拒绝，不从结果中挑选性放行。
- 解析结果按规范地址去重并保留顺序，IPv4-mapped IPv6 转换为 IPv4；完整 `addresses` 与 `selectedAddress` 写入请求级目标上下文，供 2.5 连接层消费。
- 测试 DNS 与真实连接解析分层，避免依赖公网；覆盖 public、private、mixed、空结果、失败、超时、多 A/AAAA、重复记录、family 不一致和 IPv4-mapped IPv6。
- 私网域名 TODO 已转为强制门禁；后端 80 项通过、2 项后续 P0 门禁 TODO（DNS Pinning、Redirect）、0 项失败。

下一阶段为 2.5 DNS Pinning 与连接层。

### 第九轮执行记录

2026-08-29 已完成 2.5：

- 新增 `core/pinnedConnection.js`；每个请求创建独立 HTTP/HTTPS Agent，连接 `lookup` 仅返回 `validateTarget()` 冻结的地址集合，不再进行第二次系统 DNS 查询。
- lookup 严格绑定原 hostname，支持 IPv4/IPv6 family 与 `all` 语义；hostname 变化或请求不存在的 family 会安全失败。
- Axios 显式关闭环境代理发现，并注入请求级 Agent；HTTPS 保留原 Host/SNI，显式启用 `rejectUnauthorized: true`。
- 平台暴露远端 socket 地址时，会规范化 IPv4-mapped IPv6 并再次核对验证集合；不一致返回稳定 SSRF 拒绝。
- 测试层使用独立连接工厂把公网测试地址映射到本地 Fixture，不在生产配置中加入私网绕过开关；DNS Rebinding/二次解析 TODO 已转为强制门禁。
- 后端 87 项通过、1 项后续 P0 门禁 TODO（Redirect）、0 项失败；覆盖多地址/family、hostname 变化、远端地址不一致、TLS SNI/严格证书选项与自签名证书拒绝。

下一阶段为 2.6 安全 Redirect Loop。

### 第十轮执行记录

2026-08-29 已完成 2.6：

- 新增 `core/safeRedirect.js`；Axios 每一跳固定 `maxRedirects: 0`，由 proxyWeb 显式处理 301/302/303/307/308。
- 相对与绝对 `Location` 每一跳都重新执行 URL、DNS 和 Pinning，并创建新的请求级 Agent；公网跳私网会在连接前拒绝。
- 实现循环检测与 `api.maxRedirects` 上限，统一返回 508 `PROXY_REDIRECT_LIMIT`；关闭 `api.followRedirects` 时原样返回首个 3xx。
- 明确方法/Body 规则：301/302 POST 与 303 转 GET，307/308 保留方法和 Body；首跳继续流式发送，同时有限捕获最多 5 MiB，仅在需要重放且超限时返回 413。
- 跨 Origin 删除认证、Cookie、Token、Password、Secret 与 API Key 类 Header；Redirect Chain 日志通过统一脱敏器处理，并修复多层编码目标 URL 的日志泄漏。
- 后端 97 项通过、0 项 TODO、0 项失败；覆盖相对/绝对、循环、超限、私网目标、跨域凭据、方法/Body、逐跳连接和日志脱敏。

下一阶段为 2.7 进程策略与资源限制。

### 第十一轮执行记录

2026-08-29 已完成 2.7：

- 新增 `core/requestResources.js`，以流式 Transform 统一限制非 GET/HEAD 请求体与 Redirect 重放缓存；`api.maxRequestBodyBytes` 默认 5 MiB，超限返回 413 `PROXY_REQUEST_BODY_LIMIT`。
- 新增动态并发门闩，`api.maxConcurrentRequests` 默认 64，达到上限时 fail-fast 返回 503 `PROXY_CONCURRENCY_LIMIT`，不会建立无界等待队列。
- 请求级 pinned HTTP/HTTPS Agent 应用 `api.connectTimeoutMs`，Axios 继续应用 `timeoutMs`；连接与请求阶段分别返回稳定 504 错误码。
- 每个代理请求绑定 AbortController；客户端断开与 runtime 关闭会取消上游。响应使用 `pipeline` 转发，上游半截响应、错误 Content-Length 等异常流不会逃逸路由边界。
- 新增 `core/processLifecycle.js`；SIGINT/SIGTERM 执行 graceful shutdown，未捕获异常与未处理 rejection 以非零状态走同一受控关闭路径，不再记录后继续运行。
- API 大响应保持流式传输，与 `security.maxRewriteBytes` 解耦；Session `maxAgeMs` 的真实过期行为已纳入集成测试。
- 后端 111 项通过、0 项 TODO、0 项失败；新增覆盖请求超时、连接定时器、Body/并发上限、客户端断开、上游中断、畸形流、Session 过期、Streaming/Rewrite 分界及 graceful/fatal shutdown。

下一阶段为 2.8 P0 集成门禁。

### 第十二轮执行记录

2026-08-29 已完成 2.8：

- 新增跨平台 `scripts/p0-gate.js`，支持复用现有依赖的 5 步门禁，以及带前后端 `npm ci` 的 7 步干净安装门禁；任一步骤失败都会立即非零退出。
- 新增 `docs/p0-verification-matrix.md`，将总体方案第 15 节每一条 Definition of Done 映射到强制单元/集成测试，并明确 P0 通过不等于生产级开放代理。
- 后端提供 `npm run verify:p0` 与 `npm run verify:p0:ci`，统一执行后端测试/语法检查和前端测试/lint/build，避免发布前遗漏某一侧。
- 安全矩阵覆盖直接 IP、全部 DNS A/AAAA、Redirect、DNS Pinning/Rebinding、IPv6、TLS、认证隔离、日志脱敏、CORS、旧 API 方法、双向 Streaming、Range 与进程资源边界。
- 干净安装门禁 7/7 通过：后端 111 项、前端 3 项测试均为 0 TODO/0 失败，后端语法检查、前端 lint 和 production build 成功；仅保留已记录的 Vue CLI 旧依赖提示与 bundle 体积 warning。

Milestone 2 P0 安全门禁至此完成，可以进入 3.1 API Mode 与 Browser Mode 分路由。

### 第十三轮执行记录

2026-08-30 已完成 3.1：

- 抽取 `core/proxyExecutor.js`，API、Browser 与 Legacy Adapter 复用 URL Validator、DNS/Pinning、受控 Redirect、请求资源限制和流式响应边界，不复制安全内核。
- 新增 `ANY /__proxyweb/api?url=...`；前端已迁移到该入口，不再隐式创建 Legacy Session。API Policy 保留上游 CSP/X-Frame-Options，并继续使用显式 CORS allowlist。
- 新增默认关闭的 `/__proxyweb/browser?url=...` 骨架；它不使用 API CORS，拥有独立 Redirect/Header Policy。`compat` 仅在 Browser Mode 移除嵌入限制头，`strict` 保留。
- 旧 `/?url=...` 与 Session 路径行为由独立 Adapter 保留，并返回 `Deprecation`、`Warning`、后继路由 `Link`；未知 `/__proxyweb/*` 返回稳定 404，不会落入旧 Session 路径。
- 后端 120 项、前端 4 项测试通过，覆盖新 API、Legacy 兼容与弃用、Browser 开关、CORS 隔离、Header Policy、Redirect 上限和前端 URL 构造；语法检查、前端 lint/build 均纳入统一门禁。

下一阶段为 3.2 UrlMapper 与 Canonical URL。

### 第十四轮执行记录

2026-08-30 已完成 3.2：

- 新增 `core/urlMapper.js`，提供 `encodeOrigin()`、`decodeOrigin()`、`toProxyUrl()`、`fromProxyRequest()` 与 `resolveTargetUrl()`；HTTP(S) origin 使用无填充 base64url Token，可严格、唯一地往返。
- Browser 入口在完整目标校验后 302 到 `/__proxyweb/browser/<originToken>/<path>`；Canonical 子路径可直接代理且不写入 Session，不同 origin/CDN 可安全并发隔离。
- Token 只承担映射，不承担授权；非规范 Token、畸形编码和 origin 越界稳定返回 `PROXY_BROWSER_URL_INVALID`，私网 origin 即使能编码也仍由 SSRF/DNS/Pinning 门禁拒绝。
- 映射保留 percent-encoded path、upstream query 与客户端 Fragment，规范化 dot segment；相对 URL 按 document URL 解析，并为后续 Rewrite 明确忽略 `javascript:`、`data:`、`blob:`、`mailto:`、`tel:` 与纯 Fragment。
- Canonical query 完全归 upstream 所有，`method`、`headers` 等同名字段不会触发 API/Legacy 控制面；新增跨 origin 并发、查询隔离、无 Session、错误契约和真实路由测试。
- 后端 128 项、前端 4 项测试通过，语法检查、前端 lint/build 继续纳入统一门禁。

下一阶段为 3.3 Response Transform Pipeline。

### 第十五轮执行记录

2026-08-30 已完成 3.3：

- 新增 `core/responsePipeline.js`，按模式、方法、状态、Content-Type、Range、下载语义和缓存指令选择 transform 或原始 stream；API/Legacy 始终保持既有流式边界。
- Browser HTML/XHTML/CSS 支持 identity、gzip、deflate 与 br 的受限解压，按声明 Charset 解码、经可插拔文本转换器处理、统一输出 UTF-8，并使用原 Content-Encoding 重新压缩；当前转换器为恒等实现，供 3.4–3.5 接入具体 Rewrite。
- `security.maxRewriteBytes` 按解压后的字节数计算，防止压缩炸弹绕过。超限在响应头发出前返回 413 `PROXY_REWRITE_LIMIT` 并回收上游流；畸形压缩返回受控 502，后续请求保持健康。
- Transform 后移除 `Content-Length`、`ETag`、`Content-MD5` 并规范 Charset；SSE、206/Content-Range、附件、`no-transform`、音视频、PDF、二进制及不支持的 Encoding/Charset 保持字节级 passthrough，并保留合法长度/缓存元数据。
- Browser 请求优先发送 `Accept-Encoding: identity`，但对忽略该偏好的上游仍完整覆盖三种压缩格式；新增分类、Charset、压缩、上限、异常流、SSE 和二进制集成测试。
- 后端 137 项、前端 4 项测试通过，语法检查、前端 lint/build 继续纳入统一门禁。

下一阶段为 3.4 HTML Rewrite。

### 第十六轮执行记录

2026-08-30 已完成 3.4：

- 新增 `browser-proxy/htmlRewriter.js`，使用 Cheerio 解析 HTML/XHTML，不使用正则整体替换文档；常见 `href`、`src`、`action`、`formaction`、`poster` 与 `data` 属性统一通过 `UrlMapper` 生成 Canonical Browser URL。
- 第一个 `<base href>` 为有效 HTTP(S) 目标时形成 effective base，否则回退文档 URL；所有相对资源、导航与表单按该基准解析，随后 `<base>` 自身也被映射，跨 origin/CDN 资源使用独立 origin Token。
- `img/source srcset` 按候选项解析，只改写 URL 并保留 `1x`、`2x`、`480w` 等 descriptor；Meta Refresh 只改 URL 段，内联 style 使用 CSS value parser 处理 `url()`。
- `javascript:`、`data:`、`blob:`、`mailto:`、`tel:`、纯 Fragment、带 credentials 与畸形目标保持原值；新生成的 Canonical 子请求仍完整执行 SSRF、DNS 与 Pinning 校验。
- `browser.rewriteHtml: false` 保持 HTML 字节与长度/缓存元数据直通；新增解析器单元测试、真实 fixture、跨域映射和可请求导航集成测试。生产依赖经 npm 官方安全公告库审计为 0 个已知漏洞。
- 后端 143 项、前端 4 项测试通过，语法检查、前端 lint/build 继续纳入统一门禁。

下一阶段为 3.5 CSS 与 Location Rewrite。

### 第十七轮执行记录

2026-08-30 已完成 3.5：

- 新增 `browser-proxy/cssRewriter.js`，使用 PostCSS AST 遍历 CSS 声明与 `@import`，再通过 CSS value parser 定位 `url()` token；不使用正则整体改写 CSS，也不处理完整 JavaScript。
- 独立样式表的相对 URL 严格基于 CSS 文件自身 upstream URL，覆盖 root-relative、跨 origin/CDN、字体、嵌套 `image-set(url())` 和带 media/layer 条件的 `@import`；data URL、纯 Fragment、非 HTTP(S) 与复杂转义保持原值。
- HTML `<style>` 复用同一 CSS AST 管线并遵循 effective base，非 `text/css` 的 Less/Sass 等预处理器块保持原样；`browser.rewriteCss: false` 继续保持独立 CSS 字节与长度/缓存元数据直通。
- Redirect 内核新增 validation-only 模式。Browser 301/302/303/307/308 不再由服务端吞掉第二跳：相对/绝对 Location 先执行 URL、SSRF 和 DNS 校验，再映射到对应 origin Token 的 Canonical Location 交给浏览器；私网或非法目标在发出 3xx 前安全失败并回收上游流。
- API/Legacy 原有服务端 follow、循环/次数上限、跨域敏感 Header 清理与方法/Body 规则保持不变；`browser.maxRedirects` 作为旧行为兼容字段保留，当前 Browser 跳转链由客户端逐跳处理。
- 新增 CSS Parser、Location Header、Redirect validation-only 单元测试和真实 CSS/相对/跨域/私网 Location 集成测试；生产依赖经 npm 官方安全公告库审计为 0 个已知漏洞。
- 后端 152 项、前端 4 项测试通过，语法检查、前端 lint/build 继续纳入统一门禁。

下一阶段为 3.6 Cookie Jar 与 Header Policy。

### 第十八轮执行记录

2026-08-30 已完成 3.6：

- 新增 `browser-proxy/sessionStateStore.js`，以可替换的进程内 Store 为每个 proxyWeb Session 维护独立 `tough-cookie` Jar；Session 到期状态按 `session.maxAgeMs` 回收，runtime 关闭时清空，为后续 Redis 等共享实现保留抽象边界。
- Browser 请求不转发客户端的 proxyWeb Cookie，只按完整 upstream URL 从 Jar 注入可见 Cookie；上游 `Set-Cookie` 在响应头发送前写入 Jar 并从下游剥离，不会把目标站 Cookie 设置到 proxyWeb 主域。
- Cookie 匹配遵循 upstream Domain、Path、Secure、Expiry、HttpOnly 等语义；`browser.cookieJar: false` 时既不创建 Browser Session 状态，也不吸收/发送目标 Cookie。不同 proxyWeb Session 与不同 upstream host 互相隔离。
- Browser Origin/Referer 只从当前 proxy origin 下可严格反解的 Canonical Referer 还原；跨 CDN 请求的 Origin 使用来源页面 origin，来源未知时安全降级为 `null` 而不伪装成目标同源。Host 继续由验证后的目标连接生成，hop-by-hop 与代理认证 Header 仍统一删除。
- `browser.headerPolicy` 新增方案中的 `preserve` 值，并保留既有 `strict` 作为相同保留语义的兼容值；`compat` 只在 Browser Mode 移除 CSP/CSP-Report-Only、X-Frame-Options、CORP/COOP/COEP 与 Clear-Site-Data，API/Legacy 边界不变。
- 新增 Cookie 属性、Session/host/path 隔离、开关关闭、Origin/Referer 跨 origin 映射、未知来源降级和完整安全响应头策略测试；后端 161 项、前端 4 项测试通过，生产依赖审计为 0 个已知漏洞。

下一阶段为 3.7 Browser UI。

### 第十九轮执行记录

2026-08-30 已完成 3.7：

- 前端新增独立 `/web/browser` 与 `BrowserProxy.vue`，并通过 `ModeSwitcher.vue` 在现有 API 请求页和网页代理页之间显式切换；API 请求编排、响应展示、分享与历史行为保持原路径和传输逻辑。
- Browser UI 对目标执行无 credentials 的 HTTP(S) URL 校验，默认使用 `noopener,noreferrer` 新标签页打开；只有 `VUE_APP_PROXY_BROWSE_URL` 与管理 UI 不同 Origin 时才开放 sandbox iframe 预览，并提示第三方 Cookie、CSP/防嵌入与隐私策略限制。
- 高级折叠面板提供 HTML Rewrite、CSS Rewrite、Cookie Jar 与 Compatibility Headers 开关；Runtime Bridge 明确禁用并标记为 P2。偏好写入 Browser 入口并绑定签名 Session，最近一次启动对该 Session 生效。
- 新增 `browser-proxy/preferences.js`。入口偏好只能关闭全局允许的能力，不能启用服务器关闭项，也不能把 `preserve/strict` 降级为 `compat`；非法、重复或非布尔值稳定返回 400。无偏好入口会清除旧值并恢复服务器配置。
- `VUE_APP_PROXY_API_URL` 与 `VUE_APP_PROXY_BROWSE_URL` 支持独立部署；未配置时依次回退到旧 `VUE_APP_PROXY_URL` 和本地默认值，保留旧部署兼容。
- 新增前端 Browser URL/偏好/iframe Origin 工具测试，以及后端偏好解析、全局上限和真实 Session 路由测试；后端 166 项、前端 7 项测试通过，lint 和生产构建继续纳入统一门禁。

下一阶段为 3.8 P1 E2E 门禁。

### 第二十轮执行记录

2026-08-30 已完成 3.8：

- 新增本地 `browser-e2e-site.js`，以动态端口同时承载 `fixture.test` 与 `cdn.test` 两个虚拟 upstream origin；测试 DNS 预加载器支持显式多 hostname 连接映射，验证阶段仍返回独立公网地址记录，不访问公网或修改系统 hosts。
- 新增基于 `playwright-core` 的 `browser-core.e2e.js`，自动查找 Edge、Chrome 或 Chromium，也允许通过 `PROXYWEB_E2E_BROWSER_PATH` 指定；缺少浏览器时稳定失败，不以 skip 伪装通过。
- 真实浏览器场景覆盖普通静态页、SSR、多 CSS/图片、跨 CDN 图片与脚本、链接、GET/POST 表单、302 登录页、Cookie Session、图片、字体、MP4 Range、下载和 SSE；登录后 reload 继续命中服务端 upstream Cookie Jar。
- 强制遍历 HTML URL 属性并校验不包含 upstream host，检查 CSS 计算样式的 Canonical URL、Location 跳转全程留在 Browser Route、跨 origin Token 不复用，以及 PNG/WOFF2/Range/附件逐字节不变。
- E2E 失败会在系统临时目录保留页面截图、HTML、console/page error、失败请求和代理日志；成功后安全清理临时目录。`playwright-core` 不下载浏览器，避免将浏览器二进制隐式加入 npm 安装。
- 新增 `scripts/p1-gate.js`。P1 门禁先完整执行 P0 回归，再执行 Browser Core E2E；支持带两端 `npm ci` 的 `--install` 模式，后端提供 `test:e2e`、`verify:p1` 与 `verify:p1:ci` 等价入口。
- 新增 [`docs/p1-verification-matrix.md`](./p1-verification-matrix.md)，逐项映射总体方案第 37 节的 15 类页面/资源场景与 6 项核心不变量。
- 后端 166 项、前端 7 项回归继续通过，P0 Gate 5/5、P1 Gate 2/2 与 Edge 真实浏览器场景全部 PASS；两端生产依赖经 npm 官方安全公告库审计均为 0 个已知漏洞。前端生产构建仍只有既有的 3 条 bundle 体积 warning。

下一阶段为 4.1 SSE 与 Range/Media 专项可靠性。

### 第二十一轮执行记录

2026-08-30 已完成 4.1：

- 新增 `core/streamingPolicy.js`。`text/event-stream` 保持 stream 分类，代理在 Body 首块前显式 `flushHeaders()`，并强制下游 `X-Accel-Buffering: no`，避免 Nginx 等兼容反向代理重新缓冲；非 SSE 响应不触发该策略。
- API、Legacy 与 Browser Policy 仅在 Response Pipeline 明确认定 Body 未变换时保留合法 `Content-Length`；hop-by-hop Header 继续删除，HTML/CSS Transform 后仍清理长度、ETag 与 Content-MD5，不会把已失效元数据带回客户端。
- Fixture 新增延迟 SSE、2 MiB 确定性 MP4 字节流、开放/后缀 Range 与分块 HTML 附件；Range Parser 按 HTTP suffix 语义修正 `bytes=-N`，无效范围继续返回 416。
- 新增 `streaming-contract.test.js`：同时验证 API/Browser SSE 的响应头与两条事件分时到达；验证 API/Legacy/Browser 的 206、Content-Range、Accept-Ranges、Content-Length、Content-Type、ETag 和字节片段完全一致。
- 以 `security.maxRewriteBytes: 32` 强制证明完整 2 MiB 媒体与 512 KiB `text/html` 附件不进入 Rewrite Buffer；附件首块在上游结束前到达，Content-Length 和二进制内容保持不变。
- 新增 `npm run test:streaming` 专项入口，覆盖 Streaming Policy、Response Pipeline 与真实代理时序契约；后端测试由 166 项增至 172 项。
- 后端全量 172/172 与专项 12/12 已通过，P0 Gate 5/5、P1 Gate 2/2 和 Edge Browser Core E2E 全部 PASS；前端生产构建仍只有既有的 3 条 bundle 体积 warning。Nginx 部署说明明确要求 SSE 路由关闭响应缓冲，并说明 proxyWeb 已发送 `X-Accel-Buffering: no`，但外层代理仍需正确配置。

下一阶段为 4.2 Runtime Bridge。

### 第二十二轮执行记录

2026-08-30 已完成 4.2：

- 新增 `browser-proxy/runtimeBridge.js` 与受保护的 `/__proxyweb/runtime.js` 端点。脚本仅在 `browser.enabled`、`browser.runtimeBridge` 和有效 HTML Rewrite 同时开启时提供，使用 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`；全局或 Session 关闭时稳定返回 404。
- HTML Rewrite 在 upstream 脚本前注入唯一 `data-proxyweb-runtime` 标记，携带 upstream 文档 URL 与有效 `<base>`；重复 Rewrite 不会二次注入。Bridge 默认关闭，已加载页面需要刷新后才会应用关闭状态。
- Runtime Bridge 映射 `Request`/`fetch`、XHR、EventSource、`window.open`、`history.pushState` 与 `replaceState`，并在 popstate/hashchange 后同步 upstream URL。相对 URL 遵循有效 upstream `<base>`；History 保持 upstream 同源限制，跨 upstream origin 的 History 写入抛出 `SecurityError`。
- 包装器保留原函数 `this`、prototype/static、Promise 与错误行为。`Request` 在构造阶段只替换 URL，不读取、缓冲或记录 Body；真实 POST Body 未出现在代理日志。动态请求仍进入 Canonical Route，逐次执行 URL、DNS SSRF、Pinning、Header/Cookie 与资源限制。
- Browser UI 已启用受限 Runtime Bridge 开关，入口偏好只能关闭服务器已允许的能力，不能从前端开启全局禁用功能。WebSocket 构造器未在 4.2 提前包装，待 4.3 与安全 Upgrade 代理一并实现。
- 新增 13 项 `npm run test:runtime` 专项契约与独立 Edge Runtime E2E，覆盖普通/Request POST fetch、XHR、SSE EventSource、data URL、跨 upstream origin Token、window.open、History、`<base>` 和日志不含 Body。后端全量测试由 172 项增至 178 项。
- 新增 `scripts/p2-gate.js`、`verify:p2` 与 `verify:p2:ci`，完整复用 P1 回归后追加 Runtime Bridge Playwright E2E；逐项证据见 `docs/p2-runtime-verification-matrix.md`。
- 后端 178/178、Runtime 专项 13/13、前端 7/7、P0 Gate 5/5、P1 Gate 2/2 与当前 P2 Gate 2/2 全部 PASS；两个真实浏览器阶段均使用 Edge 150。前端生产构建仍只有既有的 3 条 bundle 体积 warning。

下一阶段为 4.3 WebSocket。

### 第二十三轮执行记录

2026-08-30 已完成 4.3：

- 新增 `browser-proxy/webSocketProxy.js` 与 `webSocketUrl.js`，使用锁定的 `ws@8.21.3` 接管 HTTP Server Upgrade。ws/wss 继续复用 HTTP(S) Canonical origin Token，并在每次握手重新执行 URL 规范化、DNS SSRF、请求级 Pinning、TLS 校验与远端地址复核。
- Upgrade 路径独立接回 Basic Auth、Express Session 和 SessionStateStore；只向上游发送 allowlist Header 与 Cookie Jar 中匹配目标 URL 的 Cookie。浏览器 Origin 必须严格命中当前 proxy Host，Runtime 注入的 upstream 来源 Origin 使用 HMAC 签名子协议标记传递，代理验证后移除，保留应用自身子协议。
- 下游 101 仅在上游握手及 Pinning 成功后完成。文本、二进制、应用子协议与合法关闭码双向透传；ping/pong 在两条连接上本地应答。每条消息发送期间暂停来源读取，以 `ws.send` 完成回调恢复，形成有界 backpressure。
- 新增默认关闭的 `browser.webSocket`，以及 `webSocketMaxPayloadBytes`（默认 1 MiB、Schema 最大 16 MiB）、`webSocketIdleTimeoutMs`（默认 60 秒）和 `webSocketMaxConnections`（默认 64）。配置和 Session UI 偏好只能收紧能力；超限、空闲、shutdown 与握手失败均会关闭相关 socket/Agent。
- Runtime Bridge 仅在 WebSocket 能力有效时包装原生 `WebSocket`，映射相对及 ws/wss URL，保留 constructor/prototype/static 元数据；Browser UI 已增加独立 WebSocket Proxy 开关。真实 Edge 已验证 Origin、子协议、文本/二进制与自定义关闭码完整往返。
- 新增 `npm run test:websocket`，覆盖 Canonical 映射、签名防篡改、Upgrade Header、Header allowlist、Basic Auth 隔离、Cookie/Origin、子协议、文本/二进制、关闭码、SSRF/Origin 拒绝、连接数、payload 与 idle 上限。后端全量 191/191、WebSocket 专项 11/11、Runtime 专项 14/14、前端 7/7、lint、生产构建与 Edge Runtime E2E 均通过；npm 官方安全公告库审计为 0 个已知漏洞。前端生产构建仍只有既有的 3 条 bundle 体积 warning。

下一阶段为 4.4 Origin Isolation。

### 第二十四轮执行记录

2026-08-31 已完成 4.4：

- 新增默认关闭的 `browser.originIsolation`。启用时要求专用至少三级 `baseOrigin`；生产强制 HTTPS 与 Secure Session，`.test` 仅用于本地 HTTP 自动化。每个 upstream origin 使用 SHA-256 前 128 bit 派生的 `o-<hex>` 子域，同时保留可逆 path token 作为第二绑定。
- 新增全局 Origin scope 中间件：只接受精确 base host 或规范派生 host；base host 负责入口，隔离 host 只开放 Canonical Browser Route 与 Runtime 脚本。Host/Token 不匹配、任意 wildcard host 及隔离 host 上的 API/UI/Legacy 路由返回 421 `PROXY_ORIGIN_ISOLATION_DENIED`，不会建立 upstream 连接。
- HTML/CSS/Location Rewrite、Runtime Bridge 与 WebSocket 已统一接入派生 Origin。Runtime 内置同步 SHA-256 映射；WebSocket 同时校验目标 Host/Token 与 HMAC 来源 Origin 子域。跨 upstream HTTP 来源通过 4096 项有界标签注册表复核，Origin/Referer 和 upstream CORS allow-origin 双向映射，未知来源安全降级而不猜目标同源。
- proxyWeb 控制 Session 在该模式下使用精确 base hostname 的 Domain 与 HttpOnly，在隔离子域间共享启动偏好和服务端 Cookie Jar；DOM、Local/Session Storage、IndexedDB、Worker scope 与权限仍由浏览器 Origin 分区。该边界不宣称每 upstream 独立 proxyWeb 登录，管理 UI 必须位于不同站点。
- 新增 [`origin-isolation-threat-model.md`](./origin-isolation-threat-model.md)，明确 wildcard DNS/TLS、Host 转发、Session、反向代理、多实例 sticky/shared state、Service Worker 和同站 CSRF 边界；通配 DNS 只用于部署路由，不构成应用信任或 SSRF allowlist。
- 新增 5 项纯函数/Host 双绑定单测、4 项子进程集成契约与独立 Edge Origin Isolation E2E。真实浏览器强制验证两个 upstream 的 `location.origin` 与同名 localStorage 分离、跨窗口 DOM 读取抛 `SecurityError`，以及 Runtime 跨 upstream fetch 按上游 CORS 工作。
- 后端全量 201/201、lint 与独立 Edge Origin Isolation E2E 已通过；P2 Gate 已扩展为 P1 回归、Runtime/WebSocket E2E、Origin Isolation E2E 三阶段。下一主线阶段为 5.1 请求编辑与 cURL；高级 Worker/Service Worker 兼容仍作为独立后续项。

下一阶段为 5.1 请求编辑与 cURL。
