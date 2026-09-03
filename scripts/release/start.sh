#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/server"

if ! command -v node >/dev/null 2>&1; then
  echo "[FireflyProxy] 未找到 Node.js，请先安装 Node.js 22.16.0 或更高版本。" >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 16) ? 0 : 1)'; then
  echo "[FireflyProxy] Node.js 版本过低，当前版本：$(node --version)；请升级到 22.16.0 或更高版本。" >&2
  exit 1
fi

echo "[FireflyProxy] 启动后请访问 http://localhost:8082/web/"
exec node bootstrap.js
