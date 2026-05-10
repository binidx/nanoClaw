#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const backendEntry = path.join(projectRoot, 'dist', 'index.js');
const frontendEntry = path.join(projectRoot, 'web', 'dist', 'index.html');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCliPath = process.platform === 'win32' ? findWindowsNpmCliPath() : null;
const runInBackground = process.argv.includes('--background');
const cleanTargets = [
  'dist',
  'tsconfig.tsbuildinfo',
  path.join('web', 'dist'),
  path.join('web', '.tsbuildinfo'),
];

function fail(message) {
  console.error(`       Error: ${message}`);
  process.exit(1);
}

function findWindowsNpmCliPath() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function resolveCommand(command, args) {
  if (process.platform === 'win32' && command === npmCommand && npmCliPath) {
    return {
      command: process.execPath,
      args: [npmCliPath, ...args],
    };
  }

  return { command, args };
}

function runCommand(command, args, options = {}) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) {
    fail(`failed to run ${command}: ${result.error.message}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.signal) {
    fail(`${command} exited with signal ${result.signal}.`);
  }
}

function commandExists(command, args = ['--version']) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  if (result.error) return false;
  return result.status === 0;
}

function appendNodeOption(existing, option) {
  const tokens = String(existing || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.includes(option)) {
    return tokens.join(' ');
  }
  return [...tokens, option].join(' ').trim();
}

function validateRuntimePrerequisites() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '', 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
    fail(`NanoClaw requires Node.js >= 20. Current version: ${process.version}`);
  }

  if (process.platform === 'win32' && !npmCliPath) {
    fail('failed to locate npm-cli.js for the current Node.js installation.');
  }

  if (!commandExists(npmCommand)) {
    fail('npm is not installed or not in PATH.');
  }

  if (!commandExists('rg')) {
    console.log('');
    console.log('  ⚠  ripgrep (rg) is NOT installed.');
    console.log('     Agent grep/glob tools will use a slower Node.js fallback.');
    console.log('     Recommended install:');
    if (process.platform === 'darwin') {
      console.log('       brew install ripgrep');
    } else if (process.platform === 'win32') {
      console.log('       winget install BurntSushi.ripgrep.MSVC');
      console.log('       or: choco install ripgrep');
    } else {
      console.log('       apt-get install ripgrep   (Debian/Ubuntu)');
      console.log('       dnf install ripgrep        (Fedora/RHEL)');
    }
    console.log('');
  }

  if (!fs.existsSync(path.join(projectRoot, 'node_modules', 'node-pty', 'package.json'))) {
    console.log(' [2/3] Installing backend dependencies...');
    runCommand(npmCommand, ['install']);
  }

  const agentRunnerRoot = path.join(projectRoot, 'agent', 'runner');
  if (fs.existsSync(path.join(agentRunnerRoot, 'package.json'))) {
    if (
      !fs.existsSync(
        path.join(
          agentRunnerRoot,
          'node_modules',
          '@anthropic-ai',
          'claude-agent-sdk',
          'package.json',
        ),
      )
    ) {
      console.log(' [2/3] Installing agent-runner dependencies...');
      runCommand(npmCommand, ['install'], {
        cwd: agentRunnerRoot,
      });
    }
  }

  const webRoot = path.join(projectRoot, 'web');
  if (fs.existsSync(path.join(webRoot, 'package.json'))) {
    if (!fs.existsSync(path.join(webRoot, 'node_modules', 'vite', 'package.json'))) {
      console.log(' [2/3] Installing frontend dependencies...');
      runCommand(npmCommand, ['install'], {
        cwd: webRoot,
      });
    }
  }
}

function getWebPort() {
  const explicitPort = String(process.env.WEB_PORT || '').trim();
  if (/^\d+$/.test(explicitPort)) return explicitPort;

  const scriptPath = path.join(scriptDir, 'get-web-port.mjs');
  if (!fs.existsSync(scriptPath)) return '3377';

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return '3377';

  const port = String(result.stdout || '').trim();
  return /^\d+$/.test(port) ? port : '3377';
}

function writeRuntimeState(pid, webPort) {
  const pidText = `${pid}\n`;
  fs.writeFileSync(path.join(projectRoot, '.nanoclaw-pid'), pidText, 'ascii');
  fs.writeFileSync(path.join(projectRoot, 'nanoclaw.pid'), pidText, 'ascii');
  fs.writeFileSync(path.join(projectRoot, 'nanoclaw.port'), `${webPort}\n`, 'ascii');
}

function clearRuntimeState() {
  for (const fileName of ['.nanoclaw-pid', 'nanoclaw.pid', 'nanoclaw.port']) {
    fs.rmSync(path.join(projectRoot, fileName), { force: true });
  }
}

function rebuildRuntime() {
  console.log(' [2/3] Cleaning and rebuilding backend/frontend/agent-runner...');
  console.log('       Cleaning backend and frontend build output...');
  for (const target of cleanTargets) {
    fs.rmSync(path.join(projectRoot, target), { recursive: true, force: true });
  }

  // Build agent-runner if it exists
  const agentRunnerRoot = path.join(projectRoot, 'agent', 'runner');
  if (fs.existsSync(path.join(agentRunnerRoot, 'package.json'))) {
    console.log('       Building agent-runner...');
    runCommand(npmCommand, ['run', 'build'], {
      cwd: agentRunnerRoot,
    });
    if (!fs.existsSync(path.join(agentRunnerRoot, 'dist', 'index.js'))) {
      fail('agent-runner build output is missing after rebuild.');
    }
  }

  console.log('       Building backend...');
  runCommand(npmCommand, ['run', 'build']);
  if (!fs.existsSync(backendEntry)) {
    fail('backend build output is missing after rebuild.');
  }

  fs.mkdirSync(path.join(projectRoot, 'web', '.tsbuildinfo'), {
    recursive: true,
  });
  console.log('       Building frontend...');
  runCommand(npmCommand, ['run', 'build'], {
    cwd: path.join(projectRoot, 'web'),
  });
  if (!fs.existsSync(frontendEntry)) {
    fail('frontend build output is missing after rebuild.');
  }

  console.log('       Done.');
  console.log();
}

function startRuntime() {
  const webPort = getWebPort();
  const webUrl = `http://localhost:${webPort}`;

  console.log(' [3/3] Starting NanoClaw...');
  console.log();
  console.log(`       URL:  ${webUrl}`);
  console.log();

  if (!runInBackground) {
    const childProcess = spawn(process.execPath, [backendEntry], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        WEB_PORT: webPort,
        NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, '--use-system-ca'),
      },
      windowsHide: false,
    });

    if (!childProcess.pid) {
      fail('failed to start NanoClaw runtime.');
    }

    writeRuntimeState(childProcess.pid, webPort);
    console.log(`       PID:  ${childProcess.pid}`);
    console.log();
    console.log(' NanoClaw is running in this window. Press Ctrl+C to stop.');
    console.log();

    let cleaningUp = false;
    const cleanup = () => {
      if (cleaningUp) return;
      cleaningUp = true;
      clearRuntimeState();
    };

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(signal, () => {
        if (!childProcess.killed) {
          childProcess.kill(signal);
        }
      });
    }

    childProcess.on('exit', (code, signal) => {
      cleanup();
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    return;
  }

  const logDate = new Date().toISOString().slice(0, 10);
  const customLogDir = process.env.NANOCLAW_LOG_DIR;
  const logDir = customLogDir || path.join(projectRoot, 'logs', logDate);
  const runtimeLogPath = path.join(logDir, 'runtime.log');
  const runtimeErrorLogPath = path.join(logDir, 'runtime.error.log');

  fs.mkdirSync(logDir, { recursive: true });

  const stdoutFd = fs.openSync(runtimeLogPath, 'a');
  const stderrFd = fs.openSync(runtimeErrorLogPath, 'a');
  const childProcess = spawn(process.execPath, [backendEntry], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    env: {
      ...process.env,
      WEB_PORT: webPort,
      NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, '--use-system-ca'),
    },
    windowsHide: true,
  });

  if (!childProcess.pid) {
    fail('failed to start NanoClaw runtime.');
  }

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  childProcess.unref();

  writeRuntimeState(childProcess.pid, webPort);
  console.log(`       Logs: ${path.relative(projectRoot, logDir)}`);
  console.log(`       PID:  ${childProcess.pid}`);
  console.log();
  console.log(' NanoClaw started in background.');
  console.log();
}

validateRuntimePrerequisites();
rebuildRuntime();
startRuntime();
