@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0server"

where node >nul 2>nul
if errorlevel 1 (
  echo [FireflyProxy] 未找到 Node.js，请先安装 Node.js 22.16.0 或更高版本。
  pause
  exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 16) ? 0 : 1)"
if errorlevel 1 (
  echo [FireflyProxy] Node.js 版本过低，当前版本：
  node --version
  echo 请升级到 Node.js 22.16.0 或更高版本。
  pause
  exit /b 1
)

echo [FireflyProxy] 启动后请访问 http://localhost:8082/web/
node bootstrap.js
if errorlevel 1 pause
