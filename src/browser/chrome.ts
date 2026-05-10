import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';

import { logger } from '../logger.js';
import { waitForCdpReady } from './cdp.js';
import { BrowserError, type BrowserRuntimeConfig } from './types.js';

const STOP_TIMEOUT_MS = 5000;

export interface RunningBrowserProcess {
  pid: number;
  proc: ChildProcess;
  startedAt: string;
  userDataDir: string;
  debugPort: number;
  executablePath: string;
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a debug port')));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForExit(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new BrowserError(504, 'Timed out waiting for browser process exit'));
    }, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function buildChromeArgs(
  config: BrowserRuntimeConfig,
  debugPort: number,
): string[] {
  return [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${config.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--password-store=basic',
    ...(config.headless ? ['--headless=new'] : []),
    ...config.extraArgs,
    config.startupUrl,
  ];
}

export async function launchManagedBrowser(
  config: BrowserRuntimeConfig,
): Promise<RunningBrowserProcess> {
  if (!config.enabled) {
    throw new BrowserError(
      409,
      'Browser control is disabled. Set WEB_BROWSER_ENABLED=true first.',
    );
  }
  if (!config.resolvedExecutablePath) {
    throw new BrowserError(
      503,
      'No supported Chrome/Chromium executable was found; set WEB_BROWSER_EXECUTABLE_PATH',
    );
  }

  const debugPort = await findAvailablePort();
  fs.mkdirSync(config.userDataDir, { recursive: true });

  const proc = spawn(
    config.resolvedExecutablePath,
    buildChromeArgs(config, debugPort),
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
  });

  const running: RunningBrowserProcess = {
    pid: proc.pid || -1,
    proc,
    startedAt: new Date().toISOString(),
    userDataDir: config.userDataDir,
    debugPort,
    executablePath: config.resolvedExecutablePath,
  };

  const exited = new Promise<never>((_, reject) => {
    proc.once('error', (err) => {
      reject(
        new BrowserError(
          500,
          `Failed to launch browser: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });
    proc.once('exit', (code, signal) => {
      reject(
        new BrowserError(
          500,
          `Browser exited before becoming ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})${stderr ? `: ${stderr}` : ''}`,
        ),
      );
    });
  });

  await Promise.race([
    waitForCdpReady(`http://127.0.0.1:${debugPort}`, config.startupTimeoutMs),
    exited,
  ]);

  logger.info({ pid: running.pid, debugPort }, 'Managed browser started');
  return running;
}

export async function stopManagedBrowser(
  running: RunningBrowserProcess | null,
): Promise<void> {
  if (!running || running.proc.exitCode !== null) {
    return;
  }
  running.proc.kill('SIGTERM');
  try {
    await waitForExit(running.proc, STOP_TIMEOUT_MS);
    return;
  } catch {
    running.proc.kill('SIGKILL');
    await waitForExit(running.proc, STOP_TIMEOUT_MS).catch(() => undefined);
  }
}
