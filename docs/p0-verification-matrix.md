# P0 自动化验收矩阵

> 总体规格：[P0 Definition of Done](../proxyWeb%20vNext%20开发计划与技术方案.md#15-p0-definition-of-done)  
> 执行入口：`node scripts/p0-gate.js --install`  
> 最近复核：2026-08-29

本文把 P0 完成条件映射到仓库内的强制测试。门禁只使用本地动态端口和 Fixture，不依赖真实公网目标或系统 hosts。

## 一键门禁

从仓库根目录执行：

```powershell
node scripts/p0-gate.js --install
```

`--install` 会先在后端和前端分别执行锁文件驱动的 `npm ci`，随后串行执行：

```text
backend: npm test
backend: npm run lint
frontend: npm test
frontend: npm run lint
frontend: npm run build
```

已完成依赖安装时，可省略 `--install`。后端目录也提供等价入口：`npm run verify:p0` 与 `npm run verify:p0:ci`。

任一步骤非零退出都会立即终止门禁；只有输出 `P0 gate PASS` 才视为通过。Webpack 的 bundle 体积 warning 当前是已记录的非阻塞构建提示，不会被误报为测试成功或失败。

## Definition of Done 映射

| P0 条件 | 自动化证据 |
| --- | --- |
| 域名解析到 private IP 时阻止 | `proxy-contract.test.js` 的 private/mixed/empty/failed DNS 集成用例；`target-validator.test.js` 的全部 A/AAAA 策略用例 |
| Redirect 到 private IP 时阻止 | `proxy-contract.test.js` 的逐跳私网 Redirect 拒绝用例；`safe-redirect.test.js` 的逐跳验证单测 |
| DNS Rebinding 连接层得到控制 | `proxy-contract.test.js` 的冻结 DNS 地址连接用例；`pinned-connection.test.js` 的 hostname、family、远端地址和 Agent 用例 |
| Proxy Basic Auth 不发送给 upstream | `proxy-contract.test.js` 与 `auth.test.js` 的代理凭据隔离用例 |
| 日志不泄露 Token | `proxy-contract.test.js` 的真实子进程日志快照；`redact-logger.test.js` 和 `request-logger.test.js` |
| CORS 不反射任意带凭据 Origin | `proxy-contract.test.js` 与 `cors.test.js` 的 allowlist、wildcard、预检与非法 Origin 用例 |
| 旧 `/?url=...` 基本兼容 | `proxy-contract.test.js` 的 GET、Session target、Header、状态码和 Redirect 契约 |
| GET/POST/PUT/PATCH/DELETE/HEAD 正常 | `proxy-contract.test.js` 的逐方法端到端契约 |
| stream request 正常 | POST/PUT/PATCH/DELETE Body 转发，以及 `request-resources.test.js` 的 chunked 流式计数 |
| stream response 正常 | `/stream` 完整性、客户端断开、上游中断与畸形流集成用例 |
| Range 请求正常 | `/range` 的 206、`Content-Range` 与响应内容契约 |
| TLS 安全边界 | `pinned-connection.test.js` 的 SNI、严格证书选项和自签名证书拒绝用例 |
| 直接 IP 与 IPv6 安全边界 | `target-validator.test.js` 的公网/特殊用途 IPv4、IPv6、IPv4-mapped IPv6 用例及集成拒绝用例 |
| 资源与进程边界 | 请求/连接超时、Body/并发上限、Session 过期、API Streaming 分界与 graceful/fatal shutdown 用例 |

## 发布判定

P0 门禁通过只表示网络安全与基础架构达到了当前自动化验收标准，不代表项目已成为生产级开放代理。以下限制继续保留：

- `headers` 查询参数仍处于兼容弃用期，旧客户端可能把凭据暴露给浏览器历史或中间访问日志。
- Session Store 仍是进程内存实现，不适合多实例和长期生产部署。
- Browser Core、HTML/CSS Rewrite 与 Cookie Jar 已在后续 P1 门禁完成，Runtime Bridge 已在后续 P2 4.2 完成；WebSocket 与完整 SPA 隔离仍属于后续里程碑。
- 仓库尚无正式 `LICENSE` 文件。
