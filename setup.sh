#!/bin/bash
set -euo pipefail

# setup.sh — Bootstrap script for NanoClaw
# Handles Node.js/npm setup, then hands off to the Node.js setup modules.
# This is the only bash script in the setup flow.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [bootstrap] $*" >> "$LOG_FILE"; }

# --- Platform detection ---

detect_platform() {
  local uname_s
  uname_s=$(uname -s)
  case "$uname_s" in
    Darwin*) PLATFORM="macos" ;;
    Linux*)  PLATFORM="linux" ;;
    *)       PLATFORM="unknown" ;;
  esac

  IS_WSL="false"
  if [ "$PLATFORM" = "linux" ] && [ -f /proc/version ]; then
    if grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
      IS_WSL="true"
    fi
  fi

  IS_ROOT="false"
  if [ "$(id -u)" -eq 0 ]; then
    IS_ROOT="true"
  fi

  log "Platform: $PLATFORM, WSL: $IS_WSL, Root: $IS_ROOT"
}

# --- Node.js check ---

check_node() {
  NODE_OK="false"
  NODE_VERSION="not_found"
  NODE_PATH_FOUND=""

  if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//')
    NODE_PATH_FOUND=$(command -v node)
    local major
    major=$(echo "$NODE_VERSION" | cut -d. -f1)
    if [ "$major" -ge 20 ] 2>/dev/null; then
      NODE_OK="true"
    fi
    log "Node $NODE_VERSION at $NODE_PATH_FOUND (major=$major, ok=$NODE_OK)"
  else
    log "Node not found"
  fi
}

# --- npm install ---

install_deps() {
  DEPS_OK="false"
  NATIVE_OK="false"

  if [ "$NODE_OK" = "false" ]; then
    log "Skipping npm install — Node not available"
    return
  fi

  cd "$PROJECT_ROOT"

  # npm install with --unsafe-perm if root (needed for native modules)
  local npm_flags=""
  if [ "$IS_ROOT" = "true" ]; then
    npm_flags="--unsafe-perm"
    log "Running as root, using --unsafe-perm"
  fi

  log "Running npm install $npm_flags"
  if npm install $npm_flags >> "$LOG_FILE" 2>&1; then
    DEPS_OK="true"
    log "npm install succeeded"
  else
    log "npm install failed"
    return
  fi

  # Verify native module (better-sqlite3)
  log "Verifying native modules"
  if node -e "require('better-sqlite3')" >> "$LOG_FILE" 2>&1; then
    NATIVE_OK="true"
    log "better-sqlite3 loads OK"
  else
    log "better-sqlite3 failed to load"
  fi
}

# --- Build tools check ---

check_build_tools() {
  HAS_BUILD_TOOLS="false"

  if [ "$PLATFORM" = "macos" ]; then
    if xcode-select -p >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  elif [ "$PLATFORM" = "linux" ]; then
    if command -v gcc >/dev/null 2>&1 && command -v make >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  fi

  log "Build tools: $HAS_BUILD_TOOLS"
}

# --- Agent tool dependencies ---

install_agent_deps() {
  HAS_RIPGREP="false"

  if command -v rg >/dev/null 2>&1; then
    HAS_RIPGREP="true"
    log "ripgrep already installed: $(rg --version | head -1)"
  else
    log "ripgrep not found, attempting install..."
    if [ "$PLATFORM" = "macos" ]; then
      if command -v brew >/dev/null 2>&1; then
        brew install ripgrep >> "$LOG_FILE" 2>&1 && HAS_RIPGREP="true"
        log "ripgrep installed via brew: $HAS_RIPGREP"
      else
        log "brew not available, skipping ripgrep auto-install"
      fi
    elif [ "$PLATFORM" = "linux" ]; then
      if command -v apt-get >/dev/null 2>&1; then
        local sudo_cmd=""
        if [ "$IS_ROOT" = "false" ] && command -v sudo >/dev/null 2>&1; then
          sudo_cmd="sudo"
        fi
        $sudo_cmd apt-get install -y ripgrep >> "$LOG_FILE" 2>&1 && HAS_RIPGREP="true"
        log "ripgrep installed via apt-get: $HAS_RIPGREP"
      elif command -v dnf >/dev/null 2>&1; then
        local sudo_cmd=""
        if [ "$IS_ROOT" = "false" ] && command -v sudo >/dev/null 2>&1; then
          sudo_cmd="sudo"
        fi
        $sudo_cmd dnf install -y ripgrep >> "$LOG_FILE" 2>&1 && HAS_RIPGREP="true"
        log "ripgrep installed via dnf: $HAS_RIPGREP"
      else
        log "No supported package manager found, skipping ripgrep install"
      fi
    fi

    if [ "$HAS_RIPGREP" = "false" ]; then
      log "WARNING: ripgrep not installed. Agent grep/glob will use slower fallback."
    fi
  fi
}

# --- Main ---

log "=== Bootstrap started ==="

detect_platform
check_node
install_deps
check_build_tools
install_agent_deps

# Emit status block
STATUS="success"
if [ "$NODE_OK" = "false" ]; then
  STATUS="node_missing"
elif [ "$DEPS_OK" = "false" ]; then
  STATUS="deps_failed"
elif [ "$NATIVE_OK" = "false" ]; then
  STATUS="native_failed"
fi

cat <<EOF
=== NANOCLAW SETUP: BOOTSTRAP ===
PLATFORM: $PLATFORM
IS_WSL: $IS_WSL
IS_ROOT: $IS_ROOT
NODE_VERSION: $NODE_VERSION
NODE_OK: $NODE_OK
NODE_PATH: ${NODE_PATH_FOUND:-not_found}
DEPS_OK: $DEPS_OK
NATIVE_OK: $NATIVE_OK
HAS_BUILD_TOOLS: $HAS_BUILD_TOOLS
HAS_RIPGREP: $HAS_RIPGREP
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

log "=== Bootstrap completed: $STATUS ==="

if [ "$NODE_OK" = "false" ]; then
  exit 2
fi
if [ "$DEPS_OK" = "false" ] || [ "$NATIVE_OK" = "false" ]; then
  exit 1
fi
