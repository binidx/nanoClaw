# setup.ps1 — Bootstrap script for NanoClaw on Windows
# Equivalent of setup.sh: checks Node.js, installs deps, verifies native modules.
# Run: powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"

$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$LOG_DIR = Join-Path $PROJECT_ROOT "logs"
$LOG_FILE = Join-Path $LOG_DIR "setup.log"

if (-not (Test-Path $LOG_DIR)) { New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null }

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$ts] [bootstrap] $msg" | Out-File -Append -FilePath $LOG_FILE
}

# --- Platform detection ---
$PLATFORM = "windows"
$IS_WSL = "false"
$IS_ROOT = "false"

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        $IS_ROOT = "true"
    }
} catch { }

Log "Platform: $PLATFORM, WSL: $IS_WSL, Root: $IS_ROOT"

# --- Node.js check ---
$NODE_OK = "false"
$NODE_VERSION = "not_found"
$NODE_PATH_FOUND = "not_found"

try {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $NODE_PATH_FOUND = $nodeCmd.Source
        $NODE_VERSION = (node --version 2>$null) -replace '^v', ''
        $major = [int]($NODE_VERSION.Split('.')[0])
        if ($major -ge 20) {
            $NODE_OK = "true"
        }
        Log "Node $NODE_VERSION at $NODE_PATH_FOUND (major=$major, ok=$NODE_OK)"
    } else {
        Log "Node not found"
    }
} catch {
    Log "Node check failed: $_"
}

# --- npm install ---
$DEPS_OK = "false"
$NATIVE_OK = "false"

if ($NODE_OK -eq "true") {
    Set-Location $PROJECT_ROOT

    Log "Running npm install"
    try {
        npm install 2>&1 | Out-File -Append -FilePath $LOG_FILE
        $DEPS_OK = "true"
        Log "npm install succeeded"
    } catch {
        Log "npm install failed: $_"
    }

    if ($DEPS_OK -eq "true") {
        Log "Verifying native modules"
        try {
            node -e "require('better-sqlite3')" 2>&1 | Out-File -Append -FilePath $LOG_FILE
            $NATIVE_OK = "true"
            Log "better-sqlite3 loads OK"
        } catch {
            Log "better-sqlite3 failed to load: $_"
        }
    }
}

# --- Build tools check ---
$HAS_BUILD_TOOLS = "false"
try {
    $cl = Get-Command cl.exe -ErrorAction SilentlyContinue
    if ($cl) { $HAS_BUILD_TOOLS = "true" }
    else {
        $gcc = Get-Command gcc -ErrorAction SilentlyContinue
        if ($gcc) { $HAS_BUILD_TOOLS = "true" }
    }
} catch { }
Log "Build tools: $HAS_BUILD_TOOLS"

# --- Emit status ---
$STATUS = "success"
if ($NODE_OK -eq "false") { $STATUS = "node_missing" }
elseif ($DEPS_OK -eq "false") { $STATUS = "deps_failed" }
elseif ($NATIVE_OK -eq "false") { $STATUS = "native_failed" }

Write-Output @"
=== NANOCLAW SETUP: BOOTSTRAP ===
PLATFORM: $PLATFORM
IS_WSL: $IS_WSL
IS_ROOT: $IS_ROOT
NODE_VERSION: $NODE_VERSION
NODE_OK: $NODE_OK
NODE_PATH: $NODE_PATH_FOUND
DEPS_OK: $DEPS_OK
NATIVE_OK: $NATIVE_OK
HAS_BUILD_TOOLS: $HAS_BUILD_TOOLS
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
"@

Log "=== Bootstrap completed: $STATUS ==="

if ($NODE_OK -eq "false") { exit 2 }
if ($DEPS_OK -eq "false" -or $NATIVE_OK -eq "false") { exit 1 }
