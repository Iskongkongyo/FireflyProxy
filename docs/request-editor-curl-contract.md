# 请求编辑器与 cURL 契约

本文记录路线图 5.1 的已实现行为、安全边界和验证证据。它描述 API Request 工作台，不改变 Browser Proxy 的 Canonical URL、Cookie Jar 或 Runtime Bridge。

## 编辑器模型

Params、Headers、`x-www-form-urlencoded` 与 `multipart/form-data` 字段都使用显式 `enabled` 开关。关闭的行保留在当前编辑器内，但不会进入目标 URL、实际请求或导出的 cURL。旧分享链接没有 `enabled` 字段时按启用处理；损坏的 JSON 参数会安全回退为空行，不阻断页面初始化。

Body 支持以下模式：

| 模式 | 发送值 | Content-Type |
| --- | --- | --- |
| `none` | 不设置请求体 | 不自动设置 |
| `raw` | 原始文本 | 使用编辑器中的值，可为空 |
| `json` | 通过语法校验后的 JSON 文本 | `application/json;charset=utf-8` |
| `urlencoded` | 保序、允许重复 key 的 `URLSearchParams` | `application/x-www-form-urlencoded;charset=utf-8` |
| `multipart` | 文本字段与浏览器实际选择的 `File` | 由浏览器生成含 boundary 的 Header |

multipart 每行可独立选择 Text 或 File。导入的本地路径只是可见占位信息，既不会触发读取，也不能直接发送；用户必须通过浏览器文件选择器重新授权文件。手工填写的 multipart Content-Type 会在发送前移除，由浏览器生成正确 boundary。

当前发送器只对 POST、PUT、PATCH、DELETE 发送 Body。导入带 Body 的 GET/HEAD cURL 时会保留编辑内容并显示警告，但实际发送和再次导出均不会暗中附带该 Body。

## Import cURL

Import 是本地纯文本 tokenizer/parser，不调用 Shell、`eval`、`Function`、子进程、网络或文件 API。支持：

- `-X`、`--request`；
- `-H`、`--header`；
- `-d`、`--data`、`--data-raw`、`--data-binary`；
- `-u`、`--user`；
- `-F`、`--form`、`--url`；
- `-L`、`--location` 与 `--max-redirs`（0–20）；
- 作为无状态兼容项忽略 `--compressed`、`--silent`、`--insecure`，并向用户显示提示。

单引号、双引号、反斜杠和 POSIX 反斜杠续行会按静态文本解析。以下输入会被拒绝：

- `;`、`|`、`&`、重定向等未引用 Shell 控制符；
- 反引号或 `$()` 命令替换，包括双引号内部；
- 未闭合引号、无反斜杠的多命令行和未知 cURL 选项；
- 非 HTTP(S) URL，以及内嵌 username/password 的 URL；
- 多个位置参数或格式错误的 Header/Form 字段。

引号内的控制符只作为普通字段内容保存。`-d/--data/--data-binary @path` 不读取路径，而是导入字面文本并警告；`--form name=@path` 创建必须重新选择文件的占位行。

## Copy as cURL

导出格式固定为 POSIX Shell cURL。method、完整 upstream URL、启用的 Header、Auth 和 Body 每一个用户可控 token 都使用单引号包裹，内部单引号使用标准 `'"'"'` 序列转义。编辑器不会导出 proxyWeb 内部 API URL。

JSON、Raw、URL 编码和 multipart 会分别导出为 `--data-raw` 或 `--form`；缺少的 Content-Type 会按 Body 模式补充。浏览器不能获知本地文件绝对路径，因此手选文件仅导出文件名，运行命令的人必须保证该文件位于相应工作目录或手工修改路径。

启用 Follow Redirects 时，导出会附加 `--location --max-redirs <n>`；未启用时不输出 Redirect flags。导入未带 `-L`/`--location` 的命令按 cURL 默认语义关闭跟随；单独提供 `--max-redirs` 会保留上限，但不会暗中开启跟随。逐请求 Redirect 的服务端收紧规则和响应诊断见 [`api-response-diagnostics-contract.md`](./api-response-diagnostics-contract.md)。

如果请求使用 Auth，或 Header 名匹配 Authorization、Cookie、Token、Secret、Password、API Key 等敏感规则，复制前必须二次确认。cURL 是用户明确要求的完整请求副本，因此确认后会包含这些凭据；应按密码处理，不能写入工单、日志或公共聊天。

页面分享链接、代理 API 链接和历史记录仍沿用更严格的脱敏边界：不保存 Body/Auth，敏感 Header 不进入 URL。目标 URL 自身的 query 仍可能含敏感值，分享前必须人工检查。

## 已知兼容边界

- Import 不是完整 Shell 模拟器；变量、命令替换、管道、重定向、配置文件及未知 cURL flags 不会被猜测执行。
- API 请求页手工 Cookie 仍是旧兼容行为，不等价于 Browser Proxy 的服务端 Cookie Jar，也不能保证复现 cURL Cookie 语义。
- Copy as cURL 当前输出 POSIX Shell 格式，不宣称可原样粘贴到 PowerShell 或 `cmd.exe`。
- 页面分享/历史有意不携带 Body 和认证信息；后续 Collections 必须继续采用显式 secret 边界，不能复用 cURL 的完整导出语义。

## 自动化验证

前端零依赖 Node Test 覆盖：

- 旧行模型迁移、损坏分享参数、Params 重复顺序和禁用过滤；
- `none/raw/json/urlencoded/multipart` Body 构造与文件重新授权；
- 规定的 cURL flags、类型推断、文件占位和 Basic Auth；
- Shell 控制符/命令替换/非 HTTP(S)/URL credentials 拒绝；
- POSIX 单引号转义与 Export → Import 往返；
- 敏感 Header/Auth 二次确认判定。

5.1 完成时的仓库级门禁为后端 201/201、前端 23/23。5.2 扩展 Redirect flags 后，当前门禁为后端 209/209、前端 27/27、lint/build，以及 Browser Core、Runtime/WebSocket 和 Origin Isolation 的真实 Edge 150 E2E；P0 5/5、P1 2/2、P2 3/3 全部通过。生产构建只保留既有的 3 条 bundle 体积 warning。
