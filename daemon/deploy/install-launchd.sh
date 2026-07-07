#!/bin/bash
# 安装 pager daemon 为 launchd 常驻服务（幂等，重跑覆盖）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DAEMON_DIR="$REPO_ROOT/daemon"
SECRETS="$REPO_ROOT/hub/.secrets.production.local"
PAGER_HOME="$HOME/.pager"
PLIST="$HOME/Library/LaunchAgents/dev.jianshuo.pager.daemon.plist"
LABEL="dev.jianshuo.pager.daemon"
NODE_BIN="$(command -v node)"
HUB_URL="${HUB_URL:-https://pager-hub.jianshuo.workers.dev}"
MACHINE_ID="${MACHINE_ID:-mch_mac}"
MACHINE_NAME="${MACHINE_NAME:-建硕的 Mac}"

[ -f "$SECRETS" ] || { echo "缺少 $SECRETS"; exit 1; }
# shellcheck disable=SC1090
source "$SECRETS"   # 提供 DAEMON_TOKEN / CLIENT_TOKEN
[ -n "${DAEMON_TOKEN:-}" ] || { echo "SECRETS 里没有 DAEMON_TOKEN"; exit 1; }

echo "== build =="
(cd "$REPO_ROOT" && npm run build -w packages/protocol && npm run build -w daemon)

echo "== config =="
mkdir -p "$PAGER_HOME/logs" /tmp/pager-e2e
if [ ! -f "$PAGER_HOME/daemon.json" ]; then
  cat > "$PAGER_HOME/daemon.json" <<EOF
{
  "hubUrl": "$HUB_URL",
  "daemonToken": "$DAEMON_TOKEN",
  "machineId": "$MACHINE_ID",
  "machineName": "$MACHINE_NAME",
  "dirs": ["/tmp/pager-e2e", "$HOME/code"],
  "maxConcurrent": 4,
  "permissionTimeoutSec": 3600,
  "permissionMode": "default"
}
EOF
  chmod 600 "$PAGER_HOME/daemon.json"
  echo "已写 $PAGER_HOME/daemon.json"
else
  echo "$PAGER_HOME/daemon.json 已存在，保留"
fi

echo "== launchd =="
# bootout 是异步的：紧跟 bootstrap 会撞上「旧 label 还没注销」→ Input/output error(5)。
# 等旧 label 从 launchctl 列表消失（最多 ~5s）再继续。
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in $(seq 1 25); do
  launchctl list 2>/dev/null | grep -q "$LABEL" || break
  sleep 0.2
done
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DAEMON_DIR/dist/index.js</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PAGER_HOME/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>$PAGER_HOME/logs/daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- claude CLI 常在 ~/.local/bin；Agent SDK 会 spawn 它，PATH 必须含此目录 -->
    <key>PATH</key><string>$HOME/.local/bin:$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST" || {
  echo "bootstrap 首次失败，等 2s 重试一次…"; sleep 2
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
}
echo "已加载 ${LABEL}；日志: ${PAGER_HOME}/logs/daemon.log"
