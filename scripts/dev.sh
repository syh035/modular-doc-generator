#!/usr/bin/env bash
# 一键启动开发环境：后端 FastAPI（127.0.0.1:8740）+ 前端 Vite（5173，代理 /api）。
# 用法：./scripts/dev.sh   （Ctrl-C 同时结束两个进程）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
PY="$BACKEND/.venv/bin/python"

# ---- 环境自检 ----
if [ ! -x "$PY" ]; then
  # Python 3.11+ 探测：优先 python3.12，逐级降级
  PY_BIN=""
  for cand in python3.12 python3.11 python3; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
      PY_BIN="$cand"; break
    fi
  done
  if [ -z "$PY_BIN" ]; then
    echo "错误：未找到 Python 3.11+，请安装后重试（brew install python@3.12）"
    exit 1
  fi
  echo "后端 venv 不存在，正在初始化（首次约 1–2 分钟，Python: $PY_BIN）…"
  "$PY_BIN" -m venv "$BACKEND/.venv"
  "$BACKEND/.venv/bin/pip" install --quiet --upgrade pip
  "$BACKEND/.venv/bin/pip" install --quiet -e "$BACKEND[dev]"
fi

if [ ! -d "$FRONTEND/node_modules" ]; then
  echo "前端依赖不存在，正在安装…"
  (cd "$FRONTEND" && npm install)
fi

# LibreOffice 提示（缺失不阻塞，仅渲染功能不可用，D2）
if ! command -v soffice >/dev/null 2>&1 && [ ! -x "/Applications/LibreOffice.app/Contents/MacOS/soffice" ]; then
  echo "提示：未检测到 LibreOffice，渲染功能不可用。安装：brew install --cask libreoffice"
fi

# ---- 端口预检查（避免与本机其他服务冲突时静默失败） ----
check_port() {
  if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "错误：端口 $1 已被占用（可能是其他服务）。请释放该端口或修改 scripts/dev.sh 与配置中的端口。"
    exit 1
  fi
}
check_port 8740
check_port 5173

# ---- 启动双进程，退出时统一清理 ----
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "正在停止服务…"
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "已退出。"
}
trap cleanup EXIT INT TERM

echo "启动后端 http://127.0.0.1:8740 …"
(cd "$BACKEND" && "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port 8740) &
BACKEND_PID=$!

echo "启动前端 http://127.0.0.1:5173 …"
(cd "$FRONTEND" && npm run dev) &
FRONTEND_PID=$!

echo ""
echo "就绪：浏览器访问 http://127.0.0.1:5173"

# 前端就绪后自动打开浏览器（轮询最多 30s；非 macOS 或 headless 下静默跳过）
(
  for _ in $(seq 1 30); do
    if curl -sf http://127.0.0.1:5173 >/dev/null 2>&1; then
      command -v open >/dev/null 2>&1 && open "http://127.0.0.1:5173"
      break
    fi
    sleep 1
  done
) &

wait
