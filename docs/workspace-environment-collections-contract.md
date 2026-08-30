# Environment 与 Collections 契约

本文记录路线图 5.3 的本地工作区模型、变量解析、安全边界和自动化证据。功能属于 API Request 工作台，不改变 Browser Proxy Session、服务端配置环境变量或上游 Cookie Jar。

## Environment

Environment 由名称、存储范围和最多 100 个变量组成：

```json
{
  "id": "env-...",
  "name": "Development",
  "scope": "persistent",
  "variables": [
    {
      "key": "baseUrl",
      "value": "https://dev.example.test",
      "enabled": true,
      "secret": false
    }
  ]
}
```

变量名必须匹配 `[A-Za-z_][A-Za-z0-9_.-]*`，启用的变量名不能重复，单值最多 16 KiB。空白编辑行不会写入存储；非法、重复、缺失或循环引用会在发送前失败，不会保留未解析文本继续请求。

模板语法只有 `{{name}}`。它可用于 URL、Params 的 Key/Value、Headers 的 Key/Value、Raw/JSON/表单 Body、multipart 文本字段和 Basic/Bearer Auth。变量值可以递归引用其他变量，但解析器不执行 JavaScript、Shell、函数、属性访问或网络请求。例如 `{{ process.exit() }}` 不是表达式，会作为非法模板拒绝。

实际发送与 Copy as cURL 使用当前活动环境解析后的值；复制 API 链接同样必须生成可直接调用的已解析目标。cURL 使用任何 Secret 变量、或 API 链接会把 Secret 展开到 URL/Params 时必须二次确认。页面分享链接和历史记录只保存原始模板及已过滤 Header，不写入活动环境或展开后的 Secret，因此接收者必须在自己的工作区配置环境。

## Secret 与存储范围

`secret: true` 只提供输入遮罩、风险传播识别和复制/持久化确认，**不提供加密**。

- `persistent` 环境保存在当前站点的 IndexedDB，关闭浏览器后仍可能存在；持久化 Secret 前必须二次确认。
- `session` 环境保存在 `sessionStorage`，通常随当前标签页会话结束清除；刷新页面会恢复活动环境。
- 两种存储都能被同源脚本读取，也可能受浏览器扩展、本机用户资料访问、XSS、备份或浏览器同步策略影响。
- 本阶段没有账户、云同步、端到端加密、主密码、操作系统 Keychain 或团队 Secret Vault。

活动环境 ID 只作为非机密元数据保存在 IndexedDB。变量值不会发送给 proxyWeb 后端，除非它被实际引用到请求字段中；解析后的 URL、Header、Body 或 Auth 随请求发送后，应按对应凭据处理。Final URL/Redirect Chain 仍可能显示解析后的 URL 查询值。

## Collections

Collections 使用 IndexedDB v1 数据库 `proxyweb-workspace`，包含 `folders`、`requests`、`environments` 和 `meta` 四个 Object Store；Saved Request 通过 `folderId` 索引归类。最低模型包括：

- Folder：Name；
- Saved Request：Name、Folder、Method、URL、Params、Headers、Body、Auth 与 Redirect 设置；
- 创建、加载、用当前编辑器覆盖和删除 Saved Request；
- 删除 Folder 时，其中请求移动到“未分类”，不会级联删除。

请求 URL 最多 8192 字符，名称最多 80 字符，Raw/JSON Body 最多 1 MiB，Headers 最多 100 行，其他行模型最多 500 行。损坏或不符合模型的 IndexedDB 记录会在列表加载时忽略，不会作为请求执行。

Collections 未加密。保存含 Auth、敏感 Header 或 Secret 环境变量引用的请求前会二次确认；这仍不等于安全凭据存储。页面不会把 Collection 自动上传到服务器，也不提供导入/导出、版本控制、协作、Runner、测试脚本或账号同步。

浏览器授予的 `File` 对象不会写入 IndexedDB。multipart 文件字段只保存文件名占位；加载 Saved Request 后必须通过文件选择器重新授权，路径不会被读取、猜测或恢复。

## IndexedDB 失败边界

浏览器不支持 IndexedDB、隐私策略禁用存储、配额耗尽或数据库升级被旧页面阻塞时，工作区会显示受控错误，不会回退到把 Collections/Secret 塞进 URL 或普通历史记录。Session Storage 不可用时，Session 环境保存会明确失败；持久化 Collection 仍以 IndexedDB 能力为准。

当前数据库版本为 1。未来 Schema 变更必须通过 `onupgradeneeded` 迁移，不能清库伪装升级。多标签页没有实时冲突合并；最后一次成功写入生效。

## 自动化验证

前端零依赖测试覆盖：

- 递归替换、Params/Header/Body/Auth 解析；
- 未知、重复、非法、未闭合和循环变量失败；
- 间接 Secret 引用识别、敏感 Saved Request 判定；
- Saved Request 正规化、大小/行数边界和 File 能力剥离；
- Environment/Folder/Request CRUD、Folder 删除后归入未分类；
- IndexedDB Object Store 与 `folderId` 索引升级契约。

真实浏览器专项会构建前端并使用本机 Edge/Chrome/Chromium 验证 Session Environment/Secret、刷新恢复、Folder、IndexedDB Saved Request 以及加载回编辑器：

```powershell
Set-Location .\backend\nodejs
npm run test:workspace:e2e
```

完整 P3 门禁先运行全部 P2 回归，再运行工作区 E2E：

```powershell
node scripts/p3-gate.js
```
