# API Redirect 与响应诊断契约

本文记录路线图 5.2 的已实现行为、安全边界与指标口径。功能仅作用于 API Request 工作台和 `/__proxyweb/api`；Browser Proxy 继续使用浏览器逐跳导航与 Canonical Location，不复用本契约。

## 逐请求 Redirect 控制

API Route 接受两个可选查询参数：

```text
ANY /__proxyweb/api?url=<target>&followRedirects=<true|false>&maxRedirects=<0..20>
```

| 参数 | 合法值 | 行为 |
| --- | --- | --- |
| `followRedirects` | 精确的 `true` 或 `false` | `false` 返回第一跳 3xx；`true` 仅在全局 `api.followRedirects` 已开启时生效 |
| `maxRedirects` | `0`–`20` 的十进制整数 | 生效值为请求值与全局 `api.maxRedirects` 的较小者 |

重复值、数组、大小写变体、负数、小数、前导零、空值或越界值返回 400 `PROXY_REQUEST_CONTROL_INVALID`。逐请求设置只能关闭或收紧服务端配置，不能开启全局禁用的跟随能力，也不能提高全局次数上限。

Axios 自身仍固定 `maxRedirects: 0`。启用跟随时，每一跳继续由 proxyWeb 解析 Location，并重新执行 URL 规范化、全部 DNS A/AAAA、SSRF、请求级 Pinning、TLS 与远端地址复核；跨 Origin 的认证、Cookie、Token、Secret 和 API Key 类 Header 仍会删除。UI 参数不是 SSRF allowlist，也不会绕过 301/302/303/307/308 的方法与 Body 规则。

安全逐跳循环的语义：

- 开启 Follow Redirects 且 `maxRedirects: 0` 时，首个 3xx 即以 508 停止；关闭 Follow Redirects 时则原样返回首个 3xx；
- 关闭 Follow Redirects 时不主动解析目标网络或连接 Location，链项的 `validated` 为 `false`；
- 达到次数上限或检测到循环时返回 508 `PROXY_REDIRECT_LIMIT`，诊断链保留已跟随项和停止项；
- URL、DNS 或 SSRF 校验失败继续使用既有稳定错误码，不会为了生成诊断而连接被拒绝目标。

## 服务端诊断元数据

API 响应增加以下保留 Header：

| Header | 编码/含义 |
| --- | --- |
| `X-ProxyWeb-Final-URL` | Base64URL 编码的 JSON 字符串；最终实际请求 URL |
| `X-ProxyWeb-Redirect-Chain` | Base64URL 编码的 JSON 数组；有序跳转链 |
| `X-ProxyWeb-Redirect-Count` | 截断前观察到的诊断链条目数 |
| `X-ProxyWeb-Follow-Redirects` | 实际生效的布尔值 |
| `X-ProxyWeb-Max-Redirects` | 实际生效的次数上限 |
| `X-ProxyWeb-Diagnostics-Truncated` | 值为 `true` 时表示 URL 或链因安全大小上限被截断 |

每个链项的结构为：

```json
{
  "status": 302,
  "method": "GET",
  "url": "https://example.test/start",
  "location": "https://example.test/final",
  "followed": true,
  "validated": true
}
```

`url` 是产生该 3xx 的 URL，`location` 是解析后的下一目标；因次数上限停止时可保留上游原始 Location。`followed` 表示代理是否真的发起下一跳，`validated` 表示下一目标是否已通过安全校验。

最终 URL 先限制为 2048 个字符；单个编码 Header 不超过 4096 个字符，链按完整条目截断，不生成半个 JSON 对象。上游返回的同名保留 Header 会在响应策略中删除，再由 proxyWeb 写入可信值，不能伪造诊断结果。允许的跨域 API 响应会通过 `Access-Control-Expose-Headers` 暴露这些字段；无 Origin 请求仍不获得额外 CORS 授权。

Final URL 与 Redirect Chain 可能含目标 URL 自身的 Token 或敏感查询参数。它们会出现在浏览器内存和开发者工具响应头中，应按敏感诊断数据处理，不要粘贴到公开日志、工单或聊天。服务端结构化日志仍使用原有脱敏器。

## API 工作台展示与指标口径

“重定向”页签提供 Follow Redirects 与 Max Redirects。Copy as cURL 在开启跟随时生成 `--location --max-redirs <n>`，Import cURL 支持 `-L`、`--location` 与 `--max-redirs`，但仍只进行静态文本解析，不执行 Shell 或网络操作。页面分享和复制 API 链接会保存这两个非敏感控制值。

普通 Axios 请求完成后，响应面板展示：

- HTTP Status 与 Status Text；4xx/5xx 也作为可检查的 HTTP 响应显示；
- Final URL 和有序 Redirect Chain；
- Duration、Response Size 与 Content-Type；
- 诊断头被截断时的显式警告。

当前 Duration 是可靠的客户端 `total`：从 Axios 即将分派请求时的 `performance.now()` 开始，到响应体被浏览器完整读取并交给 Axios 时结束，使用单调时钟并保留 0.1 ms。它包含浏览器、代理、全部上游跳转和完整 Body 接收，不等同于服务端处理时间；本阶段不虚构 DNS、connect、TLS 或 TTFB 分段。

Response Size 是前端实际拿到的数据大小：Blob/ArrayBuffer 使用字节长度，文本与 JSON 使用 UTF-8 序列化字节数。浏览器可能已完成内容解压，因此它不保证等于网络传输字节数或上游 `Content-Length`。

按扩展名识别的音视频仍由原生 `<video>/<audio>` 直接加载，以保留 Range 与流式播放。该路径不经 Axios，当前不显示可靠的 Status、Final URL、Redirect Chain、Duration 或 Response Size；需要诊断时可暂时使用非媒体 URL/请求方式或浏览器 Network 面板。

## 自动化验证

后端专项入口：

```powershell
Set-Location .\backend\nodejs
npm run test:diagnostics
```

契约覆盖严格参数解析、全局上限只能收紧、逐跳顺序、关闭跟随、508 停止链、CORS 暴露、保留 Header 防伪、Header 大小上限与显式截断。前端零依赖测试覆盖设置迁移、URL 控制参数、cURL 往返、恶意/损坏诊断头、UTF-8 大小和单调 total 计时。
