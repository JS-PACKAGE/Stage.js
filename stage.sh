#!/usr/bin/env sh
# Stage.js 控制腳本（macOS / Linux）
# 用法：./stage.sh <command> [args]，執行 `./stage.sh help` 查看指令。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/stage.pid"
LOG_FILE="$RUN_DIR/stage.log"
ENTRY="$ROOT/dist/src/index.js"
STOP_TIMEOUT=${STAGE_STOP_TIMEOUT:-15}

cd "$ROOT"

die() { printf 'stage: %s\n' "$*" >&2; exit 1; }

check_node() {
  command -v node >/dev/null 2>&1 || die "找不到 node（需要 Node.js 24 以上）"
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 24 ] || die "Node.js 版本為 $(node --version)，需要 24 以上"
}

ensure_config() {
  cfg=${STAGE_CONFIG:-$ROOT/config.yaml}
  if [ ! -f "$cfg" ]; then
    [ -z "${STAGE_CONFIG:-}" ] || die "STAGE_CONFIG 指向的檔案不存在：$cfg"
    cp "$ROOT/config.example.yaml" "$cfg"
    printf '已從 config.example.yaml 建立 config.yaml，請依環境調整後再啟動正式服務。\n'
  fi
}

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "$pid"
    return 0
  fi
  rm -f "$PID_FILE"
  return 1
}

cmd_install() { check_node; npm ci; }

cmd_build() { check_node; npm run build; }

cmd_start() {
  check_node
  if pid=$(running_pid); then die "已在執行中（pid ${pid}）"; fi
  [ -f "$ENTRY" ] || die "找不到 ${ENTRY}，請先執行 build"
  ensure_config
  mkdir -p "$RUN_DIR"
  nohup node "$ENTRY" >>"$LOG_FILE" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  # 設定錯誤或 port 被占用時程序會立刻退出，稍等一下再確認
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    printf '已啟動（pid %s），log：%s\n' "$pid" "$LOG_FILE"
  else
    rm -f "$PID_FILE"
    tail -n 20 "$LOG_FILE" >&2
    die "啟動失敗，請查看上方 log"
  fi
}

cmd_stop() {
  if ! pid=$(running_pid); then printf '未在執行\n'; return 0; fi
  # SIGTERM 讓伺服器通知所有房間並關閉連線
  kill -TERM "$pid"
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$STOP_TIMEOUT" ]; then
      printf '%s 秒內未結束，強制終止\n' "$STOP_TIMEOUT" >&2
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  rm -f "$PID_FILE"
  printf '已停止（pid %s）\n' "$pid"
}

cmd_status() {
  if pid=$(running_pid); then
    printf '執行中（pid %s）\n' "$pid"
  else
    printf '未在執行\n'
    return 3
  fi
}

cmd_logs() {
  [ -f "$LOG_FILE" ] || die "尚無 log：$LOG_FILE"
  if [ "${1:-}" = "-f" ]; then tail -n 50 -f "$LOG_FILE"; else tail -n "${1:-100}" "$LOG_FILE"; fi
}

cmd_help() {
  cat <<'EOF'
用法：./stage.sh <command> [args]

  install      安裝依賴（npm ci）
  build        建置伺服器、client 函式庫與範例前端
  start        於背景啟動已建置的伺服器（pid／log 位於 .run/）
  stop         優雅停止（SIGTERM，逾時後強制終止）
  restart      stop 後再 start
  status       顯示執行狀態（未執行時 exit code 3）
  logs [N|-f]  顯示最後 N 行 log（預設 100），-f 持續追蹤
  run          前景執行（給 systemd／容器等外部監管使用）
  dev          開發模式（伺服器 watch，直接執行 TypeScript）
  test         型別檢查 + 測試

環境變數：
  STAGE_CONFIG        設定檔路徑（預設 ./config.yaml，不存在時自動由範例建立）
  STAGE_STOP_TIMEOUT  stop 等待秒數（預設 15）
EOF
}

command=${1:-help}
[ $# -eq 0 ] || shift
case "$command" in
  install) cmd_install ;;
  build) cmd_build ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) cmd_logs "$@" ;;
  run) check_node; ensure_config; exec node "$ENTRY" ;;
  dev) check_node; ensure_config; exec npm run dev ;;
  test) check_node; npm run typecheck; npm test ;;
  help|-h|--help) cmd_help ;;
  *) cmd_help >&2; exit 2 ;;
esac
