#!/usr/bin/env bash
# Runs one Watercooler instance in the background without systemd.
#
#   ~/<instance>/<instance>.sh start|stop|restart|status|logs   e.g. ~/gang-bet/gang-bet.sh restart
#   ~/<instance>/<instance>.sh reset-password <username> <new-password>
#   ~/<instance>/<instance>.sh make-admin <username>      first admin; the rest are added at /admin
#
# Every deploy copies this script to <app-dir>/<instance>.sh and calls `restart`.
# It runs <app-dir>/current; the database, pid file and logs live in <app-dir>/shared/.
set -euo pipefail

APP_DIR=${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)}
ENTRY=apps/server/dist/index.js

# Instance settings (INSTANCE, PORT, BASE_PATH) are written into every release by
# .github/workflows/deploy.yml, so they always match how that release was built.
# The defaults cover releases built before instance.env existed.
INSTANCE=watercooler
PORT=3000
BASE_PATH=/watercooler
if [ -f "$APP_DIR/current/instance.env" ]; then
  # shellcheck source=/dev/null
  . "$APP_DIR/current/instance.env"
fi

PID_FILE="$APP_DIR/shared/$INSTANCE.pid"
LOG_DIR="$APP_DIR/shared/logs"
LOG_FILE="$LOG_DIR/$INSTANCE.log"

# Runtime settings. Optional extras (INVITE_CODE, PRIVATE_MODE, ...) go in shared/.env, which the
# app loads itself; the values exported here take precedence over it.
export NODE_ENV=production
# Only reachable through nginx, never directly from the internet.
export HOST=127.0.0.1
export PORT BASE_PATH
export DATABASE_PATH="$APP_DIR/shared/data/$INSTANCE.db"
# Credentials for the AI bots and the WeCom bot (see bot.example.json and deploy/README.md);
# admins switch them on and off at /admin.
export BOT_CONFIG="$APP_DIR/shared/bot.json"
# Lets admins restart the instance from /admin, and shows what is deployed.
export INSTANCE
export CONTROL_SCRIPT="$APP_DIR/$(basename "${BASH_SOURCE[0]}")"
RELEASE=$(basename "$(readlink -f "$APP_DIR/current" 2>/dev/null || echo unknown)")
export RELEASE

die() {
  echo "$INSTANCE: $*" >&2
  exit 1
}

# Node usually comes from nvm, which non-interactive shells (ssh, cron) don't load by themselves.
load_node() {
  if ! command -v node >/dev/null 2>&1; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      set +eu
      # shellcheck source=/dev/null
      . "$NVM_DIR/nvm.sh"
      set -eu
    fi
  fi
  command -v node >/dev/null 2>&1 || die "Node.js not found. Install it with nvm and run: nvm alias default 22"
}

pid() {
  cat "$PID_FILE" 2>/dev/null || true
}

is_running() {
  local p
  p=$(pid)
  # Also check the command line so a stale pid reused by another process is never touched.
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null && ps -p "$p" -o args= | grep -q "$ENTRY"
}

start() {
  if is_running; then
    echo "already running (pid $(pid))"
    return 0
  fi
  [ -e "$APP_DIR/current/$ENTRY" ] || die "nothing deployed at $APP_DIR/current yet"
  load_node
  mkdir -p "$LOG_DIR" "$APP_DIR/shared/data"
  # Keep the log from growing forever: rotate once it passes 10 MB.
  if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE")" -gt 10485760 ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  fi
  cd "$APP_DIR/current"
  echo "--- $(date '+%F %T') starting $(basename "$(readlink -f "$APP_DIR/current")") with node $(node -v)" >>"$LOG_FILE"
  nohup node "$ENTRY" </dev/null >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 1
  is_running || die "exited right after starting; see $LOG_FILE"
  echo "started (pid $(pid))"
}

stop() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "not running"
    return 0
  fi
  local p
  p=$(pid)
  kill "$p"
  for _ in $(seq 1 20); do
    kill -0 "$p" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$p" 2>/dev/null; then
    echo "did not stop within 10s, killing"
    kill -9 "$p"
  fi
  rm -f "$PID_FILE"
  echo "stopped"
}

status() {
  if is_running; then
    echo "running (pid $(pid)), listening on $HOST:$PORT"
  else
    echo "not running"
    return 1
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status) status ;;
  logs) tail -n 100 -f "$LOG_FILE" ;;
  reset-password | make-admin)
    load_node
    cd "$APP_DIR/current"
    node apps/server/dist/cli.js "$@"
    ;;
  *)
    echo "usage: $0 start|stop|restart|status|logs|reset-password <username> <new-password>|make-admin <username>" >&2
    exit 2
    ;;
esac
