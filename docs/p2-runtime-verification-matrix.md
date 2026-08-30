# P2 Runtime Bridge 与 WebSocket 自动化验收矩阵

> 总体规格：[P2-1 Runtime Bridge](../proxyWeb%20vNext%20开发计划与技术方案.md#39-p2-1-runtime-bridge)；执行入口：`node scripts/p2-gate.js --install`；最近复核：2026-08-30

当前 P2 门禁是 P1 的严格超集：先执行全部 P0/P1 测试（包含 WebSocket 安全握手与资源限制契约）、lint、生产构建和 Browser Core E2E，再用 Playwright Core 驱动本机 Chromium 运行 Runtime Bridge 与原生 WebSocket 专项页面。upstream、跨 origin DNS 与真实连接均由本地动态端口 Fixture 提供，不访问公网或修改系统 hosts。

## 一键门禁

从仓库根目录执行：

```powershell
node scripts/p2-gate.js --install
```

已安装依赖时可省略 `--install`。后端目录提供等价入口：

```powershell
npm run verify:p2
npm run verify:p2:ci
```

快速复核可拆分执行：

```powershell
npm run test:runtime
npm run test:websocket
npm run test:runtime:e2e
```

真实浏览器查找、`PROXYWEB_E2E_BROWSER_PATH` 和失败诊断规则与 P1 一致。Runtime E2E 失败时会在系统临时目录保留截图、HTML、console/page error、失败请求与代理日志；通过后自动清理。

## 规格映射

| 4.2–4.3 条件 | 自动化证据 |
| --- | --- |
| 可配置关闭 | 全局 `runtimeBridge=false`、Session `runtimeBridge=false` 或 `rewriteHtml=false` 时不注入，脚本端点返回 404 |
| 避免重复注入 | Parser 单元测试对二次 Rewrite 强制断言仅一个 `script[data-proxyweb-runtime]` |
| upstream 上下文 | 注入标记携带文档 URL 和有效 `<base>`，相对动态 fetch 命中 upstream base 路径 |
| Request / fetch | 真实页面验证普通 GET、带原始 POST Body 的 Request、返回原生 Promise，以及 data URL 保持直连 |
| XMLHttpRequest | 相对 XHR URL 映射到当前 upstream Canonical Route 并返回 JSON |
| EventSource | 相对 SSE URL 经 Bridge 收到两条分时事件 |
| WebSocket | 相对 ws URL 经 Canonical Upgrade 连接；真实 Edge 验证签名来源 Origin、应用子协议、文本/二进制与自定义关闭码 |
| window.open | 用户点击触发相对弹窗，最终 URL 和 DOM 均位于 Canonical Browser Route |
| History API | pushState 映射为 Canonical URL；后续相对请求仍按 upstream base 解析；跨 upstream origin 写入抛 `SecurityError` |
| 跨 origin 动态请求 | `cdn.test` 动态 fetch 使用独立 origin Token，并由目标虚拟 Host 响应 |
| 原生语义 | 包装器保留 `this`、prototype/static、constructor 与 Promise/error 行为；Edge 真实执行无 page error |
| Body/Token 不被捕获 | Bridge 不使用 console/localStorage/sessionStorage，不读取 Request Body；代理诊断日志强制不含 POST Fixture Body |
| 安全内核不旁路 | HTTP(S) 与 ws/wss 映射结果均进入 Canonical 边界，继续执行 URL、DNS SSRF、Pinning、Header/Cookie 与资源限制；Upgrade 在安全上游握手完成前不发送下游 101 |

## 当前边界

- Runtime Bridge 默认关闭；生产启用需同时设置 `browser.enabled: true`、`browser.rewriteHtml: true` 与 `browser.runtimeBridge: true`。
- 配置或 Session 开关控制后续注入和脚本交付；已经加载并完成 patch 的页面必须刷新才能解除。
- Bridge 不修改第三方 JavaScript 源码，不承担 WAF、CAPTCHA、DRM 或反自动化绕过。
- WebSocket 默认关闭；生产启用需额外设置 `browser.webSocket: true`，并根据业务调整 payload、idle 与总连接数上限。已经加载的页面仍需刷新才能应用开关变化。
- 服务端 Cookie Jar 仍不能模拟 `document.cookie`；多个 upstream 仍共享 Browser Proxy origin，Origin Isolation 留待 4.4。

## 发布判定

只有 P1 子门禁、WebSocket 契约和 Runtime/WebSocket Playwright E2E 均输出 PASS，才满足当前 4.2–4.3 验收。该结果证明常见 SPA 动态 HTTP/SSE/ws/wss URL 可映射，不代表高级 Service Worker/Worker、CSP 特例或完整浏览器隔离已经完成。
