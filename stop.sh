#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WEB_PORT="3377"
if [ -f "$SCRIPT_DIR/scripts/get-web-port.mjs" ]; then
  WEB_PORT="$(node "$SCRIPT_DIR/scripts/get-web-port.mjs")"
fi

echo
echo " Stopping NanoClaw..."
echo

stop_pid() {
  local pid="$1"
  local reason="$2"

  case "$pid" in
    ''|*[!0-9]*) return ;;
  esac

  if [ "$pid" -eq "$$" ] 2>/dev/null; then
    return
  fi

  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    echo "  Killed process $pid ($reason)"
  fi
}

for pid_file in .nanoclaw-pid nanoclaw.pid; do
  if [ -f "$pid_file" ]; then
    pid="$(head -n 1 "$pid_file" 2>/dev/null | tr -d '[:space:]')"
    stop_pid "$pid" "pid file $pid_file"
    rm -f "$pid_file"
  fi
done

rm -f nanoclaw.port

for port in "$WEB_PORT" 5173; do
  if command -v lsof >/dev/null 2>&1; then
    while IFS= read -r pid; do
      stop_pid "$pid" "port $port"
    done < <(lsof -ti tcp:"$port" 2>/dev/null | sort -u)
  elif command -v fuser >/dev/null 2>&1; then
    for pid in $(fuser -n tcp "$port" 2>/dev/null); do
      stop_pid "$pid" "port $port"
    done
  fi
done

echo
echo " NanoClaw stopped."
echo
