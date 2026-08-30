# Origin Isolation 威胁模型与部署约束

> 适用版本：路线图 4.4；最近复核：2026-08-31

## 安全目标

Origin Isolation 是默认关闭的 Browser Mode 高级部署。开启后，每个 upstream HTTP(S) origin 映射到不同的 proxyWeb 子域，使浏览器按真实 Same-Origin Policy 隔离 DOM、Local/Session Storage、IndexedDB、Cache Storage、Service Worker scope 和站点权限。

该模式不把 upstream 内容变成可信内容，也不替代 SSRF、认证、CORS、CSP、Cookie Jar 或恶意页面防护。它不承诺隔离同一用户的 proxyWeb 控制会话：为让启动偏好、Cookie Jar 和跨 upstream 请求连续工作，proxyWeb Session Cookie 会以精确配置的 `baseOrigin` hostname 作为 Domain，并保持 HttpOnly。页面脚本不能读取该 Cookie，但所有隔离子域处于同一 schemeful site；部署方仍须把 Browser Proxy 与管理 UI 放在不同站点，并把 Browser Mode 视为可执行不可信 upstream JavaScript 的区域。

## 信任边界与映射

配置示例：

```json
{
  "session": {
    "secure": true
  },
  "browser": {
    "originIsolation": {
      "enabled": true,
      "baseOrigin": "https://browse.example.com"
    }
  }
}
```

对于 `https://upstream.example`，代理 host label 是 upstream origin 的 SHA-256 前 128 bit，格式固定为 `o-<32 lowercase hex>`。Canonical URL 同时保留可逆 path token：

```text
https://o-<hash>.browse.example.com/__proxyweb/browser/<origin-token>/path
```

host label 只提供浏览器 Origin 分区，不是授权凭据。每次请求都从 path token 反解 upstream，并重新计算 label；Host 与 token 不一致返回 421 `PROXY_ORIGIN_ISOLATION_DENIED`，不会用 Redirect 帮攻击者探测或修正伪造子域。URL、DNS SSRF、Pinning、Redirect 和资源限制随后照常执行。

入口只允许精确 `baseOrigin`，并 302 到目标隔离 origin。隔离 host 只开放 Canonical Browser Route 和只读 Runtime Bridge；API、Legacy、管理页面及其他路径返回 421。应用不读取 `X-Forwarded-Host` 作为路由权威，反向代理必须保留经过校验的原始 Host。

## 被阻断的攻击

| 威胁 | 控制 |
| --- | --- |
| 两个 upstream 页面互读 DOM/Storage | 不同 upstream origin 使用不同派生子域；真实浏览器 E2E 强制验证 SOP `SecurityError` 与同名 localStorage 不串值 |
| 任意 wildcard Host 被当作可信代理 | 只接受精确 base host 或规范 `o-<hash>`；目标请求还必须与 path token 双重绑定 |
| 伪造 Host 指向另一个 Token | mismatch 直接 421；不执行 upstream 连接 |
| 通过隔离子域访问 API/UI | 全局 Host scope 中间件只放行 Browser Canonical 与 Runtime 脚本 |
| 跨 upstream 来源伪造 | 已访问 origin 进入有界派生标签注册表；Origin/Referer 只有在标签重新校验后才映射，上游 CORS allow-origin 也只对同一已验证来源反向映射 |
| WebSocket 借目标子域伪造来源 | Runtime 携带 HMAC 来源上下文；浏览器 Origin 必须等于该来源的派生子域，目标 Host 仍与目标 Token 绑定 |
| wildcard DNS 绕过 SSRF | DNS wildcard 只把 proxyWeb 子域送到代理；upstream 仍由 path token 得出并执行完整 SSRF/DNS Pinning |

来源标签注册表默认最多 4096 项并按最近使用回收，只保存 canonical upstream origin，不保存 URL path、查询、Body 或凭据。未知或已回收来源不会猜成目标同源：Origin 映射安全降级，可能导致跨 upstream CORS 请求失败。

## 部署前置条件

- 使用专用的至少三级 DNS namespace，例如 `browse.example.com`；Schema 拒绝 `example.com`、IP、localhost、通配字符串和非规范 Origin。
- 为 `*.browse.example.com` 配置 wildcard DNS 与 wildcard TLS certificate。生产只允许 HTTPS；`.test` 保留域可用 HTTP 运行本地自动化。
- HTTPS 模式必须启用 `session.secure: true`。Session 继续使用 HttpOnly，推荐 `sameSite: "lax"` 或更严格值。
- 反向代理必须保留 Host、正确设置受信的外部协议，并为 `/__proxyweb/browser/` 转发 WebSocket Upgrade；不要把未知 Host 规范化成 base host。
- `baseOrigin`、DNS、TLS、Session Cookie Domain 和反向代理路由是同一部署单元。修改 `originIsolation` 后必须重启，并清理旧域 Cookie；不应依赖配置热加载切换生产域名。
- 当前 Origin 标签注册表、Express Session 与 Cookie Jar 都在进程内。多进程/多实例部署需要 sticky routing，或注入共享的 Session/标签注册实现；注册缺失会 fail closed，但跨 upstream CORS 兼容性会下降。

## 明确不覆盖

- 不支持改写 Worker/Service Worker 脚本内部的任意动态 URL，也不保证复杂 CSP、COOP/COEP、DRM、WAF 或 CAPTCHA 兼容。
- Domain 级 HttpOnly proxyWeb Session 是控制平面的共享凭据，不提供“每 upstream 独立登录 proxyWeb”的认证隔离。
- 子域通常仍属于同一 site，SameSite Cookie 和部分站点级浏览器策略不能替代 Origin 级判断；高风险管理功能必须部署到不同 registrable domain。
- SHA-256 label 隐藏了原始 hostname，但这不是隐私或匿名化承诺；Canonical path token 可逆，URL 仍可能进入历史、日志和 Referer 策略边界。

## 验收证据

- 单元测试：标签确定性、Host 分类、双绑定、Schema 失败关闭。
- 集成测试：base 入口、Domain/HttpOnly Session、正确/错误 child host、隔离 host 路由收口、跨 upstream Origin/Referer 恢复。
- Edge E2E：两个 upstream 获得不同 `location.origin`，同名 localStorage 独立，跨窗口 DOM 读取抛 `SecurityError`，Runtime 跨 upstream fetch 按上游 CORS 成功。
- 完整入口：`node scripts/p2-gate.js`，Origin Isolation E2E 是 P2 的强制第三阶段。
