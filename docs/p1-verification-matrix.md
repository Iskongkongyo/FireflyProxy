# P1 Browser Core 自动化验收矩阵

> 总体规格：[P1 Definition of Done](../proxyWeb%20vNext%20开发计划与技术方案.md#37-p1-definition-of-done)
> 执行入口：`node scripts/p1-gate.js --install`
> 最近复核：2026-08-30

P1 门禁在 P0 全量回归之上，用 Playwright Core 驱动本机 Chromium 浏览器访问本地 Browser Proxy。upstream、跨 CDN origin、DNS 校验记录和真实连接均由动态端口 Fixture 提供，不访问公网，也不修改系统 hosts。

## 一键门禁

从仓库根目录执行：

```powershell
node scripts/p1-gate.js --install
```

`--install` 会先执行 P0 的两端锁文件安装与 5 项回归检查，再执行 Browser Core E2E。已安装依赖时可省略 `--install`。后端目录提供等价入口：

```powershell
npm run verify:p1
npm run verify:p1:ci
```

E2E 使用 `playwright-core`，不会在 `npm ci` 时下载浏览器。门禁会自动寻找 Edge、Chrome 或 Chromium；CI/自定义安装位置应显式设置：

```powershell
$env:PROXYWEB_E2E_BROWSER_PATH = "C:\path\to\chrome.exe"
```

找不到浏览器会直接失败，不会跳过用例。失败时输出位于系统临时目录的诊断路径，其中包含截图、当前 HTML、浏览器 console/page error、失败请求和代理子进程日志；通过后临时目录自动删除。

## Definition of Done 映射

| P1 条件 | Playwright 证据 |
| --- | --- |
| 普通静态网页 | 从 Browser 入口经历 302 Canonical 跳转并断言本地 `/site` DOM |
| SSR 页面 | 点击已改写链接打开带查询参数的服务端渲染页面并断言动态内容 |
| 多 CSS | 两份独立样式表加载，并断言文字颜色、边框和伪元素的计算样式 |
| 多图片 | 两张同源图片和背景图片完成解码，`naturalWidth` 与计算样式有效 |
| 跨 CDN 图片 | `cdn.test` 图片经第二个 origin Token 加载，且 Token 不等于页面 Token |
| 跨 CDN JS | CDN 脚本在真实页面执行，其 `currentScript.src` 保持 Canonical CDN Token |
| 表单 GET | 新窗口提交 GET 表单，断言 upstream 方法与解码后的字段值 |
| 表单 POST | 新窗口提交 URL-encoded POST，断言 upstream 方法与原始 Body |
| 302 Login Page | 受保护页 302 到已重写的登录页，POST 登录后再 302 回受保护页 |
| Cookie Session | 登录响应的 upstream Cookie 进入服务端 Jar；页面 reload 后会话继续有效 |
| 图片 | 在页面上下文重新 fetch PNG 并逐字节比较 Fixture 内容 |
| 字体 | CSS 字体 URL 经 Browser Route 请求，并逐字节比较 WOFF2 Fixture 内容 |
| MP4 Range | 页面上下文发送 `Range: bytes=2-7`，断言 206、Content-Range、Accept-Ranges 和字节片段 |
| 文件下载 | Playwright 捕获真实浏览器下载，断言文件名及附件字节完全一致 |
| SSE | 页面 `EventSource` 经已改写 URL 收到按时发送的两条消息 |

## 核心不变量

| 最低要求 | 强制断言 |
| --- | --- |
| HTML 内资源不直接逃回原站 | 遍历 link/script/img/a/form 的原始属性，全部必须是 Canonical Browser 路径且不包含 upstream host |
| CSS `url()` 正常 | 背景图计算样式指向 Canonical Browser 路径，不包含 upstream host |
| Location 不逃回原站 | 两段登录跳转最终 URL 始终位于 `/__proxyweb/browser/<token>/...` |
| 跨域资源拥有独立 Token | 页面、同源图片和 CDN 图片的 Token 按 origin 分离 |
| Cookie Session 可以持续 | 登录后 reload 仍由 upstream Cookie Jar 识别为已登录 |
| 二进制内容不被修改 | PNG、WOFF2、MP4 Range 与下载附件逐字节比较 |

## 发布判定

只有 P0 子门禁和 Browser Core E2E 都输出 PASS，才满足当前 P1 Definition of Done。通过表示静态 Rewrite 型网站的核心链路具备本地自动化证据，不代表完整 SPA 已兼容，也不取消以下限制：

- P1 本身仍只判定静态 Rewrite 型页面；后续 4.2 Runtime Bridge 的动态 Request/fetch、XHR、EventSource、window.open 与 History 证据见 [P2 Runtime Bridge 验收矩阵](./p2-runtime-verification-matrix.md)。
- WebSocket 尚未实现。
- 服务端 Cookie Jar 无法向目标脚本模拟 `document.cookie`。
- 多 upstream 仍共享 Browser Proxy origin；生产部署需要后续 Origin Isolation 与共享 Session Store。
