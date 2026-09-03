# FireflyProxy 便携运行包

该压缩包已经包含编译后的前端资源和后端生产依赖，不需要再次运行 `npm install` 或 `npm run build`，但运行机器仍需安装 **Node.js 22.16.0 或更高版本**。

## 启动

- Windows：双击 `start.cmd`。
- Linux / macOS：运行 `sh start.sh`。
- 启动后访问 <http://localhost:8082/web/>。

首次启动会从 `server/main.json.example` 自动创建 `server/main.json`，同时生成随机 Session Secret。之后可以直接修改 `server/main.json`；重新打包或覆盖文件时请先备份自己的配置。

> [!WARNING]
> 默认配置用于本机和受信网络试用，代理认证与管理页面默认关闭。不要把默认实例直接暴露到公网；公网部署前至少需要配置代理认证、管理认证、HTTPS、可信 CORS Origin、限流及目标访问策略。

完整项目说明见 `PROJECT-README.md`。构建版本、Git 提交及前端代理地址记录在 `release-manifest.json`。
