/**
 * Step: service — Generate and load service manager config.
 * Replaces 08-setup-service.sh
 *
 * Fixes: Root→system systemd, WSL nohup fallback, no `|| true` swallowing errors.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../src/logger.js';
import {
  getPlatform,
  getNodePath,
  getServiceManager,
  hasSystemd,
  isRoot,
  isWSL,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();

  logger.info({ platform, nodePath, projectRoot }, 'Setting up service');

  // Build first
  logger.info('Building TypeScript');
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  if (platform === 'macos') {
    setupLaunchd(projectRoot, nodePath, homeDir);
  } else if (platform === 'linux') {
    setupLinux(projectRoot, nodePath, homeDir);
  } else if (platform === 'windows') {
    setupWindows(projectRoot, nodePath);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
}

function setupLaunchd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    'com.nanoclaw.plist',
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/nanoclaw.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  logger.info({ plistPath }, 'Wrote launchd plist');

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    logger.info('launchctl load succeeded');
  } catch {
    logger.warn('launchctl load failed (may already be loaded)');
  }

  // Verify
  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes('com.nanoclaw');
  } catch {
    // launchctl list failed
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupLinux(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemd(projectRoot, nodePath, homeDir);
  } else {
    // WSL without systemd or other Linux without systemd
    setupNohupFallback(projectRoot, nodePath, homeDir);
  }
}

/**
 * Kill any orphaned nanoclaw node processes left from previous runs or debugging.
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
 */
function killOrphanedProcesses(projectRoot: string): void {
  try {
    if (getPlatform() === 'windows') {
      // On Windows, use WMIC to find node processes running our script
      const distIndex = path.join(projectRoot, 'dist', 'index.js');
      const escaped = distIndex.replace(/\\/g, '\\\\');
      execSync(
        `wmic process where "CommandLine like '%${escaped}%' and Name='node.exe'" call terminate`,
        { stdio: 'ignore', shell: 'cmd.exe' },
      );
    } else {
      execSync(`pkill -f '${projectRoot}/dist/index\\.js' || true`, {
        stdio: 'ignore',
      });
    }
    logger.info('Stopped any orphaned nanoclaw processes');
  } catch {
    // pkill/wmic not available or no orphans
  }
}

function setupSystemd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const runningAsRoot = isRoot();

  // Root uses system-level service, non-root uses user-level
  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = '/etc/systemd/system/nanoclaw.service';
    systemctlPrefix = 'systemctl';
    logger.info('Running as root — installing system-level systemd unit');
  } else {
    // Check if user-level systemd session is available
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn(
        'systemd user session not available — falling back to nohup wrapper',
      );
      setupNohupFallback(projectRoot, nodePath, homeDir);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, 'nanoclaw.service');
    systemctlPrefix = 'systemctl --user';
  }

  const unit = `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);
  logger.info({ unitPath }, 'Wrote systemd unit');

  // Kill orphaned nanoclaw processes to avoid channel connection conflicts
  killOrphanedProcesses(projectRoot);

  // Enable and start
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  try {
    execSync(`${systemctlPrefix} enable nanoclaw`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl enable failed');
  }

  try {
    execSync(`${systemctlPrefix} start nanoclaw`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl start failed');
  }

  // Verify
  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active nanoclaw`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch {
    // Not active
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupNohupFallback(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  logger.warn('No systemd detected — generating nohup wrapper script');

  const wrapperPath = path.join(projectRoot, 'start-nanoclaw.sh');
  const pidFile = path.join(projectRoot, 'nanoclaw.pid');

  const lines = [
    '#!/bin/bash',
    '# start-nanoclaw.sh — Start NanoClaw without systemd',
    `# To stop: kill \\$(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(projectRoot)}`,
    '',
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    '    echo "Stopping existing NanoClaw (PID $OLD_PID)..."',
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    'echo "Starting NanoClaw..."',
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot + '/dist/index.js')} \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/nanoclaw.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/nanoclaw.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    'echo "NanoClaw started (PID $!)"',
    `echo "Logs: tail -f ${projectRoot}/logs/nanoclaw.log"`,
  ];
  const wrapper = lines.join('\n') + '\n';

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  logger.info({ wrapperPath }, 'Wrote nohup wrapper script');

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

/**
 * Windows service setup using Task Scheduler (schtasks).
 * Creates a scheduled task that starts NanoClaw at user logon,
 * plus a PowerShell wrapper script for manual start/stop.
 */
function setupWindows(projectRoot: string, nodePath: string): void {
  const taskName = 'NanoClaw';
  const distIndex = path.join(projectRoot, 'dist', 'index.js');
  const logOut = path.join(projectRoot, 'logs', 'nanoclaw.log');
  const logErr = path.join(projectRoot, 'logs', 'nanoclaw.error.log');
  const pidFile = path.join(projectRoot, 'nanoclaw.pid');

  // Kill orphaned processes first
  killOrphanedProcesses(projectRoot);

  // --- 1. Write a PowerShell wrapper script ---
  const wrapperPath = path.join(projectRoot, 'start-nanoclaw.ps1');
  const ps1Lines = [
    '# start-nanoclaw.ps1 — Start NanoClaw on Windows',
    `$projectRoot = ${JSON.stringify(projectRoot)}`,
    `$nodePath    = ${JSON.stringify(nodePath)}`,
    `$distIndex   = ${JSON.stringify(distIndex)}`,
    `$pidFile     = ${JSON.stringify(pidFile)}`,
    `$logOut      = ${JSON.stringify(logOut)}`,
    `$logErr      = ${JSON.stringify(logErr)}`,
    '',
    'Set-Location $projectRoot',
    '',
    '# Stop existing instance if PID file exists',
    'if (Test-Path $pidFile) {',
    '  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue',
    '  if ($oldPid) {',
    '    try {',
    '      Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue',
    '      Write-Host "Stopped existing NanoClaw (PID $oldPid)"',
    '      Start-Sleep -Seconds 2',
    '    } catch { }',
    '  }',
    '}',
    '',
    'Write-Host "Starting NanoClaw..."',
    '$proc = Start-Process -FilePath $nodePath -ArgumentList $distIndex `',
    '  -WorkingDirectory $projectRoot `',
    '  -RedirectStandardOutput $logOut `',
    '  -RedirectStandardError $logErr `',
    '  -WindowStyle Hidden -PassThru',
    '',
    '$proc.Id | Out-File -FilePath $pidFile -Encoding ascii',
    'Write-Host "NanoClaw started (PID $($proc.Id))"',
    'Write-Host "Logs: Get-Content -Wait $logOut"',
  ];
  fs.writeFileSync(wrapperPath, ps1Lines.join('\r\n') + '\r\n');
  logger.info({ wrapperPath }, 'Wrote PowerShell wrapper script');

  // --- 2. Register a Windows Task Scheduler task (logon trigger) ---
  let taskRegistered = false;
  try {
    // Remove old task if it exists
    execSync(`schtasks /Delete /TN "${taskName}" /F`, {
      stdio: 'ignore',
      shell: 'cmd.exe',
    });
  } catch {
    // Task didn't exist yet — that's fine
  }

  try {
    execSync(
      `schtasks /Create /TN "${taskName}" /TR "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ${JSON.stringify(wrapperPath)}" /SC ONLOGON /RL HIGHEST /F`,
      { stdio: ['ignore', 'pipe', 'pipe'], shell: 'cmd.exe' },
    );
    taskRegistered = true;
    logger.info('Windows Task Scheduler task created');
  } catch (err) {
    logger.warn(
      { err },
      'Failed to create Task Scheduler task (may need admin privileges)',
    );
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'windows-task',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: taskRegistered,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
