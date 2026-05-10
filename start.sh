#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo
echo " ================================"
echo "  NanoClaw - Restarting..."
echo " ================================"
echo

# --- System dependency check ---
check_optional_dep() {
  local cmd="$1" pkg="$2" install_hint="$3"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "  ⚠  $pkg ($cmd) not found — $install_hint"
    return 1
  fi
  return 0
}

MISSING=0
echo " [0/3] Checking system dependencies..."

if [[ "$(uname -s)" == "Darwin" ]]; then
  check_optional_dep rg ripgrep "brew install ripgrep" || MISSING=1
elif [[ "$(uname -s)" == "Linux" ]]; then
  check_optional_dep rg ripgrep "apt-get install ripgrep  OR  dnf install ripgrep" || MISSING=1
fi

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo "  Some optional tools are missing. Agent grep/glob will use slower fallback."
  echo "  See docs/快速开始.md for full dependency list."
  echo ""
fi

echo " [1/3] Stopping existing NanoClaw (if running)..."
if [ -f "$SCRIPT_DIR/stop.sh" ]; then
  "$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true
fi
echo "       Done."
echo

node "$SCRIPT_DIR/scripts/start-runtime.mjs"
