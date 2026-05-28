#!/bin/sh
# start_ollama_proxy.sh

REPO_URL="https://github.com/ericli1018/ollama-proxy.git"

# ── 判斷是否在 Docker 容器內 ──────────────────────────────
if [ "${RUNNING_IN_DOCKER}" = "true" ]; then
  IS_DOCKER=true
  PROXY_DIR="/app"
else
  IS_DOCKER=false
  PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

# ── 環境變數（可由外部 export 覆蓋）─────────────────────
PROXY_PORT="${OLLAMA_PROXY_PORT:-11435}"
LOG_FILE="${PROXY_DIR}/ollama_proxy.log"

# ── Docker 內才需要裝 git ─────────────────────────────────
if [ "$IS_DOCKER" = "true" ] && ! command -v git > /dev/null 2>&1; then
  echo "Installing git..." >&2
  apk add --no-cache git
fi

# ── clone 或 pull ─────────────────────────────────────────
if [ ! -f "$PROXY_DIR/index.js" ]; then
  echo "index.js not found, cloning repo to $PROXY_DIR ..." >&2
  if ! command -v git > /dev/null 2>&1; then
    echo "Error: git not found, cannot clone repo" >&2
    exit 1
  fi
  git clone "$REPO_URL" "$PROXY_DIR" || {
    echo "Error: git clone failed" >&2
    exit 1
  }
elif [ "$IS_DOCKER" = "true" ]; then
  echo "Pulling latest code..." >&2
  git -C "$PROXY_DIR" pull || echo "Warning: git pull failed, using existing code" >&2
fi

# ── node 存在檢查 ─────────────────────────────────────────
if ! command -v node > /dev/null 2>&1; then
  echo "Warning: node not found, cannot start proxy" >&2
  exit 0
fi

# ── npm install ───────────────────────────────────────────
if [ "$IS_DOCKER" = "true" ]; then
  echo "Running npm install..." >&2
  (cd "$PROXY_DIR" && npm install --silent) 2>&1
else
  if [ ! -d "$PROXY_DIR/node_modules" ]; then
    echo "Running npm install in $PROXY_DIR ..." >&2
    (cd "$PROXY_DIR" && npm install --silent) >> "$LOG_FILE" 2>&1
  fi
fi

# ── Port 檢查（Docker 內跳過，容器啟動必定是乾淨的）─────
if [ "$IS_DOCKER" = "false" ]; then
  port_in_use() {
    if command -v lsof > /dev/null 2>&1; then
      lsof -i:"$1" -sTCP:LISTEN -t > /dev/null 2>&1
    elif command -v nc > /dev/null 2>&1; then
      nc -z localhost "$1" > /dev/null 2>&1
    elif command -v ss > /dev/null 2>&1; then
      ss -tlnp | grep -q ":$1 "
    else
      grep -q "$(printf '%04X' "$1")" /proc/net/tcp 2>/dev/null
    fi
  }

  if port_in_use "$PROXY_PORT"; then
    echo "ollama proxy already running on port $PROXY_PORT"
    exit 0
  fi
fi

# ── 啟動 ─────────────────────────────────────────────────
if [ "$IS_DOCKER" = "true" ]; then
  echo "Starting proxy in foreground (Docker)..."
  exec node "$PROXY_DIR/index.js"
else
  echo "Starting proxy in background (local)..."
  nohup node "$PROXY_DIR/index.js" >> "$LOG_FILE" 2>&1 &
  PROXY_PID=$!
  i=0
  while [ $i -lt 10 ]; do
    sleep 0.5
    if port_in_use "$PROXY_PORT"; then
      echo "ollama proxy started (pid $PROXY_PID)"
      exit 0
    fi
    i=$((i + 1))
  done
  echo "Warning: proxy did not start in time, check $LOG_FILE" >&2
  exit 0
fi
