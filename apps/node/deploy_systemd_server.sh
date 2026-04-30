#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_CFG="$SCRIPT_DIR/config/server.json"
NODE_BIN="$(command -v node || true)"
LOG_LEVEL_VALUE="${LOG_LEVEL:-WARN}"
USE_CLUSTER="${USE_CLUSTER:-0}"
WORKERS_VALUE="${WORKERS:-2}"
LIMIT_NOFILE_VALUE="${LIMIT_NOFILE:-100000}"
APPLY_SYSCTL="${APPLY_SYSCTL:-0}"

if [[ $EUID -ne 0 ]]; then
  echo "请使用 root 执行：sudo bash deploy_systemd_server.sh"
  exit 1
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "未找到 node，请先安装 Node.js"
  exit 1
fi

if [[ ! -f "$SERVER_CFG" ]]; then
  echo "缺少配置文件：$SERVER_CFG"
  exit 1
fi

if [[ "$USE_CLUSTER" != "0" && "$USE_CLUSTER" != "1" ]]; then
  echo "USE_CLUSTER 只能是 0 或 1"
  exit 1
fi

SERVER_EXEC="$NODE_BIN $SCRIPT_DIR/src/server.js -c $SERVER_CFG"
if [[ "$USE_CLUSTER" == "1" ]]; then
  SERVER_EXEC="$NODE_BIN $SCRIPT_DIR/src/run_cluster.js -c $SERVER_CFG"
fi

SERVICE_NAME="4px"

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=4px Node Agent Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$SCRIPT_DIR
Environment=NODE_ENV=production
Environment=LOG_LEVEL=$LOG_LEVEL_VALUE
Environment=WORKERS=$WORKERS_VALUE
Environment=TARGET_SCRIPT=$SCRIPT_DIR/src/server.js
ExecStart=$SERVER_EXEC
Restart=always
RestartSec=2
LimitNOFILE=$LIMIT_NOFILE_VALUE

[Install]
WantedBy=multi-user.target
EOF

if [[ "$APPLY_SYSCTL" == "1" ]]; then
  cat >/etc/sysctl.d/99-4px-node.conf <<EOF
net.core.somaxconn=65535
net.ipv4.tcp_max_syn_backlog=65535
net.ipv4.ip_local_port_range=10240 65535
fs.file-max=1048576
EOF
  sysctl --system >/dev/null
fi

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

echo "部署完成。当前状态："
echo "USE_CLUSTER=$USE_CLUSTER WORKERS=$WORKERS_VALUE LIMIT_NOFILE=$LIMIT_NOFILE_VALUE APPLY_SYSCTL=$APPLY_SYSCTL"
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,12p'

echo
echo "查看实时日志："
echo "journalctl -u $SERVICE_NAME -f"
