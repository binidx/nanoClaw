import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'node:stream';

// Sentinel markers must match agent-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('../config.js', () => ({
  AGENT_MAX_OUTPUT_SIZE: 10485760,
  AGENT_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('../logger.js', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    logger: mockLogger,
    createModuleLogger: vi.fn(() => mockLogger),
  };
});

vi.mock('../db.js', () => ({
  getDefaultProvider: vi.fn(() => undefined),
  getDefaultProviderForUser: vi.fn(() => undefined),
  getConfig: vi.fn(() => undefined),
  getConfigBatch: vi.fn(() => Promise.resolve({})),
  getProvider: vi.fn(() => undefined),
  listUserMcpServers: vi.fn(() => Promise.resolve([])),
  isProviderVisibleToUser: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../assistant/assistant-runtime.js', () => ({
  resolveAssistantRuntimeConfig: vi.fn(() => ({
    accessPolicyOverride: undefined,
  })),
}));

vi.mock('../config-store.js', () => ({
  getConfigValues: vi.fn(() =>
    Promise.resolve({
      MEMORY_ENABLED: 'true',
      MEMORY_WRITE_MODE: 'daily-only',
    })),
  getConfigValue: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('../auth/internal-api-auth.js', () => ({
  getInternalApiBaseUrl: vi.fn(() => 'http://127.0.0.1:3377'),
  getInternalApiToken: vi.fn(() => 'internal-browser-token'),
}));

vi.mock('../auth/local-capability-policy.js', () => ({
  resolveLocalCapabilityForUserId: vi.fn(() =>
    Promise.resolve({
      id: 'browserControl',
      permission: 'browser.control',
      enabled: false,
      available: false,
      multiUserMode: false,
      reason: 'disabled',
    })),
}));

vi.mock('../node-executable.js', () => ({
  getNodeExecutable: vi.fn(() => process.execPath),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
      readlinkSync: vi.fn(() => ''),
      rmSync: vi.fn(),
      unlinkSync: vi.fn(),
      symlinkSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('../security/mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: vi.fn(() => ''),
    spawn: vi.fn(() => fakeProc),
  };
});

import { runAgentProcess, AgentRunOutput } from './agent-runner.js';
import { resolveAssistantRuntimeConfig } from '../assistant/assistant-runtime.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: { text: 'Hello' },
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
  secrets: { ANTHROPIC_API_KEY: 'test-key' } as Record<string, string>,
};

function resetFsMockDefaults() {
  const fsMock = vi.mocked(fs, true);
  fsMock.existsSync.mockReset();
  fsMock.existsSync.mockImplementation(() => true);
  fsMock.mkdirSync.mockReset();
  fsMock.mkdirSync.mockImplementation(() => undefined);
  fsMock.writeFileSync.mockReset();
  fsMock.writeFileSync.mockImplementation(() => undefined);
  fsMock.readFileSync.mockReset();
  fsMock.readFileSync.mockImplementation(() => '');
  fsMock.readdirSync.mockReset();
  fsMock.readdirSync.mockImplementation(() => []);
  fsMock.statSync.mockReset();
  fsMock.statSync.mockImplementation(
    () => ({ isDirectory: () => false }) as fs.Stats,
  );
  fsMock.lstatSync.mockReset();
  fsMock.lstatSync.mockImplementation(
    () =>
      ({
        isSymbolicLink: () => false,
        isFile: () => false,
      }) as fs.Stats,
  );
  fsMock.readlinkSync.mockReset();
  fsMock.readlinkSync.mockImplementation(() => '');
  fsMock.rmSync.mockReset();
  fsMock.rmSync.mockImplementation(() => undefined);
  fsMock.unlinkSync.mockReset();
  fsMock.unlinkSync.mockImplementation(() => undefined);
  fsMock.symlinkSync.mockReset();
  fsMock.symlinkSync.mockImplementation(() => undefined);
  fsMock.cpSync.mockReset();
  fsMock.cpSync.mockImplementation(() => undefined);
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function startAgentRun(
  ...args: Parameters<typeof runAgentProcess>
) {
  const spawnMock = vi.mocked(spawn);
  const initialSpawnCalls = spawnMock.mock.calls.length;
  const resultPromise = runAgentProcess(...args);
  let settledResult: AgentRunOutput | undefined;
  void resultPromise.then((value) => {
    settledResult = value;
  });
  await waitForCondition(
    () =>
      spawnMock.mock.calls.length > initialSpawnCalls ||
      settledResult !== undefined,
    'spawn call',
  );
  if (settledResult && spawnMock.mock.calls.length === initialSpawnCalls) {
    throw new Error(`Agent run settled before spawn: ${JSON.stringify(settledResult)}`);
  }
  await waitForCondition(
    () =>
      fakeProc.stdin.listenerCount('error') > 0 &&
      fakeProc.stdout.listenerCount('data') > 0 &&
      fakeProc.stderr.listenerCount('data') > 0,
    'agent stream listeners',
  );
  return { resultPromise };
}

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: AgentRunOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('agent runtime timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
    resetFsMockDefaults();
    testInput.secrets = { ANTHROPIC_API_KEY: 'test-key' };
    vi.mocked(spawn).mockImplementation(() => fakeProc as any);
    vi.mocked(resolveAssistantRuntimeConfig).mockReset();
    vi.mocked(resolveAssistantRuntimeConfig).mockReturnValue({
      accessPolicyOverride: undefined,
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if the agent was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('does not SIGTERM a child that is still sending structured keepalive events', async () => {
    const onOutput = vi.fn(async () => {});
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(1829000);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      event: {
        id: 'keepalive-1',
        kind: 'status',
        status: 'in_progress',
        title: 'Waiting for Codex provider availability',
        timestamp: '2026-03-25T00:00:00.000Z',
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fakeProc.kill).not.toHaveBeenCalledWith('SIGTERM');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-keepalive',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-keepalive');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          title: 'Waiting for Codex provider availability',
        }),
      }),
    );
  });

  it('does not treat stderr as timeout-resetting activity', async () => {
    const onOutput = vi.fn(async () => {});
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(1829000);
    fakeProc.stderr.push('still waiting on provider\n');
    await vi.advanceTimersByTimeAsync(2000);

    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('bridges structured AI info logs from stderr into the main logger', async () => {
    const onOutput = vi.fn(async () => {});
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    fakeProc.stderr.push('[agent-runner-ai]{"kind":"ai_request","requestId":"req-1","provider":"codex","model":"gpt-5.4","endpoint":"https://api.example.com/v1/responses","requestTextPreview":"hello');
    fakeProc.stderr.push('","requestTextChars":5}\n');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        group: testGroup.name,
        agentLabel: expect.any(String),
        kind: 'ai_request',
        provider: 'codex',
        aiRequestId: 'req-1',
        runtime: 'agent-runner',
        requestTextPreview: 'hello',
      }),
      'AI request sent',
    );
  });

  it('bridges structured AI error logs from stderr into the error logger', async () => {
    const onOutput = vi.fn(async () => {});
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    fakeProc.stderr.push('[agent-runner-ai]{"kind":"ai_error","requestId":"req-2","provider":"codex","model":"gpt-5.4","endpoint":"https://api.example.com/v1/responses","errorMessage":"boom"}\n');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({
        group: testGroup.name,
        agentLabel: expect.any(String),
        kind: 'ai_error',
        provider: 'codex',
        aiRequestId: 'req-2',
        runtime: 'agent-runner',
        errorMessage: 'boom',
      }),
      'AI request failed',
    );
  });

  it('does not let repeated identical synthetic provider progress reset the timeout forever', async () => {
    const onOutput = vi.fn(async () => {});
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    const syntheticKeepalive = {
      status: 'success' as const,
      result: null,
      event: {
        id: 'provider-progress:wait-1',
        kind: 'status' as const,
        status: 'in_progress' as const,
        title: 'Waiting for Codex provider response',
        body: 'Codex responses request',
        timestamp: '2026-03-25T00:00:00.000Z',
      },
    };

    await vi.advanceTimersByTimeAsync(1829000);
    emitOutputMarker(fakeProc, syntheticKeepalive);
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(1828000);
    emitOutputMarker(fakeProc, {
      ...syntheticKeepalive,
      event: {
        ...syntheticKeepalive.event,
        timestamp: '2026-03-25T00:30:28.000Z',
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).toHaveBeenCalledTimes(2);
  });

  it('lets a new synthetic provider progress id reset timeout for a later request phase', async () => {
    const onOutput = vi.fn(async () => {});
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    const firstKeepalive = {
      status: 'success' as const,
      result: null,
      event: {
        id: 'provider-progress:wait-1',
        kind: 'status' as const,
        status: 'in_progress' as const,
        title: 'Waiting for Codex provider response',
        body: 'Codex responses request',
        timestamp: '2026-03-25T00:00:00.000Z',
      },
    };

    const secondKeepalive = {
      ...firstKeepalive,
      event: {
        ...firstKeepalive.event,
        id: 'provider-progress:wait-2',
        timestamp: '2026-03-25T00:30:28.000Z',
      },
    };

    await vi.advanceTimersByTimeAsync(1829000);
    emitOutputMarker(fakeProc, firstKeepalive);
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(1828000);
    emitOutputMarker(fakeProc, secondKeepalive);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fakeProc.kill).not.toHaveBeenCalledWith('SIGTERM');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'done',
      newSessionId: 'session-later-phase',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-later-phase');
    expect(onOutput).toHaveBeenCalledTimes(3);
  });

  it('does not treat progress-only turn events as completed output on timeout', async () => {
    const onOutput = vi.fn(async () => {});
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(1829000);
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      turnEvent: {
        type: 'turn.started',
        turnId: 'turn-progress-only',
        timestamp: '2026-03-25T00:00:00.000Z',
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1830000);

    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        turnEvent: expect.objectContaining({
          type: 'turn.started',
        }),
      }),
    );
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('tolerates existing node_modules link pointing to the expected target', async () => {
    const fsMock = vi.mocked(fs, true);
    const expectedNodeModules = path.join(
      process.cwd(),
      'agent',
      'runner',
      'node_modules',
    );
    const distNodeModulesSuffix = path.join(
      'data',
      'sessions',
      testGroup.folder,
      'agent-runner-dist',
      'node_modules',
    );

    fsMock.existsSync.mockImplementation((target: fs.PathLike) => {
      const value = String(target);
      if (value.endsWith(path.join('agent', 'runner', 'node_modules')))
        return true;
      if (value.endsWith(distNodeModulesSuffix)) return true;
      return true;
    });
    fsMock.lstatSync.mockImplementation(
      (target: fs.PathLike) =>
        ({
          isSymbolicLink: () => String(target).endsWith(distNodeModulesSuffix),
        }) as fs.Stats,
    );
    fsMock.readlinkSync.mockReturnValue(expectedNodeModules);
    fsMock.symlinkSync.mockImplementationOnce(() => {
      const err = new Error('already exists') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    });

    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-789',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-789');
  });
  it('replaces stale legacy node_modules symlink before recreating it', async () => {
    const fsMock = vi.mocked(fs, true);
    fsMock.symlinkSync.mockReset();
    fsMock.symlinkSync.mockImplementation(() => undefined as unknown as void);
    const distNodeModulesSuffix = path.join(
      'data',
      'sessions',
      testGroup.folder,
      'agent-runner-dist',
      'node_modules',
    );

    fsMock.existsSync.mockImplementation((target: fs.PathLike) => {
      const value = String(target);
      if (value.endsWith(path.join('agent', 'runner', 'node_modules')))
        return true;
      return true;
    });
    fsMock.lstatSync.mockImplementation((target: fs.PathLike) => {
      const value = String(target);
      if (value.endsWith(distNodeModulesSuffix)) {
        return {
          isSymbolicLink: () => true,
          isFile: () => false,
        } as fs.Stats;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    fsMock.readlinkSync.mockReturnValue(
      path.join(process.cwd(), 'container', 'agent-runner', 'node_modules'),
    );

    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-legacy-link',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-legacy-link');
    expect(fsMock.unlinkSync).toHaveBeenCalled();
  });

  it('includes extra mount host paths in allowed directories and uses mounted cwd', async () => {
    const spawnMock = vi.mocked(spawn);
    const repoPath = path.resolve(fs.mkdtempSync(path.join('/tmp', 'nanoclaw-extra-mount-')));
    const realRepoPath = fs.realpathSync(repoPath);
    const { resultPromise } = await startAgentRun(
      testGroup,
      {
        ...testInput,
        extraMounts: [
          {
            hostPath: repoPath,
            targetPath: '/workspace/extra',
            readonly: true,
          },
        ],
        allowedDirectoriesOverride: [repoPath],
        workingDirectory: '/workspace/extra',
      },
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(spawnOptions).toBeTruthy();
    expect(spawnOptions?.cwd).toBe(repoPath);
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_PROJECT_ROOT).toBe(realRepoPath);
    expect(env?.NANOCLAW_ACCESS_MODE).toBe('allowlist');
    const allowedDirs = JSON.parse(
      env?.NANOCLAW_ALLOWED_DIRS || '[]',
    ) as string[];
    expect(allowedDirs).toContain(realRepoPath);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-extra-mount',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-extra-mount');
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('preserves readonly access mode for repo-scoped directory overrides', async () => {
    const spawnMock = vi.mocked(spawn);
    const repoPath = path.resolve(
      fs.mkdtempSync(path.join('/tmp', 'nanoclaw-readonly-mount-')),
    );
    const { resultPromise } = await startAgentRun(
      testGroup,
      {
        ...testInput,
        accessModeOverride: 'readonly',
        extraMounts: [
          {
            hostPath: repoPath,
            targetPath: '/workspace/extra',
            readonly: true,
          },
        ],
        allowedDirectoriesOverride: [repoPath],
        workingDirectory: '/workspace/extra',
      },
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_ACCESS_MODE).toBe('readonly');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-readonly-mount',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-readonly-mount');
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('defaults non-main chats to the group working directory without exposing the project root', async () => {
    const spawnMock = vi.mocked(spawn);
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    const expectedGroupRoot = path.resolve(
      '/tmp',
      'nanoclaw-test-groups',
      'test-group',
    );
    expect(spawnOptions?.cwd).toBe(expectedGroupRoot);
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_PROJECT_ROOT).toBeUndefined();
    const allowedDirs = JSON.parse(
      env?.NANOCLAW_ALLOWED_DIRS || '[]',
    ) as string[];
    expect(allowedDirs).toContain(expectedGroupRoot);
    expect(allowedDirs).not.toContain(process.cwd());

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-project-root',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-project-root');
  });

  it('mounts a stable global workspace for main runs', async () => {
    const spawnMock = vi.mocked(spawn);
    const fsMock = vi.mocked(fs, true);
    const { resultPromise } = await startAgentRun(
      {
        ...testGroup,
        folder: 'main-group',
      },
      {
        ...testInput,
        groupFolder: 'main-group',
        isMain: true,
      },
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    const env = spawnOptions?.env as Record<string, string> | undefined;
    const expectedGlobalRoot = path.resolve(
      '/tmp',
      'nanoclaw-test-groups',
      'global',
    );
    expect(env?.NANOCLAW_GLOBAL_DIR).toBe(expectedGlobalRoot);
    const allowedDirs = JSON.parse(
      env?.NANOCLAW_ALLOWED_DIRS || '[]',
    ) as string[];
    expect(allowedDirs).toContain(expectedGlobalRoot);
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(expectedGlobalRoot, {
      recursive: true,
    });

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-main-global',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-main-global');
  });

  it('injects the built-in nanoclaw MCP server and internal browser API env', async () => {
    const spawnMock = vi.mocked(spawn);
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_INTERNAL_API_BASE).toBe('http://127.0.0.1:3377');
    expect(env?.NANOCLAW_INTERNAL_API_TOKEN).toBe('internal-browser-token');
    expect(env?.MEMORY_ENABLED).toBe('true');
    expect(env?.MEMORY_WRITE_MODE).toBe('daily-only');
    const mcpServers = JSON.parse(
      env?.NANOCLAW_EXTRA_MCP_SERVERS || '{}',
    ) as Record<string, Record<string, unknown>>;
    expect(mcpServers.nanoclaw).toBeTruthy();
    expect(mcpServers.nanoclaw.command).toBe(process.execPath);
    expect(mcpServers.nanoclaw.args).toEqual([
      expect.stringContaining(
        path.join(
          'tmp',
          'nanoclaw-test-data',
          'sessions',
          'test-group',
          'agent-runner-dist',
          'ipc-mcp-stdio.js',
        ),
      ),
    ]);
    expect(mcpServers.nanoclaw.env).toEqual(
      expect.objectContaining({
        NANOCLAW_CHAT_JID: 'test@g.us',
        NANOCLAW_GROUP_FOLDER: 'test-group',
        NANOCLAW_IS_MAIN: '0',
        NANOCLAW_INTERNAL_API_BASE: 'http://127.0.0.1:3377',
        NANOCLAW_INTERNAL_API_TOKEN: 'internal-browser-token',
        MEMORY_ENABLED: 'true',
        MEMORY_WRITE_MODE: 'daily-only',
      }),
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-browser-env',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-browser-env');
  });

  it('supports strict conversation repo bindings without exposing nanoclaw root', async () => {
    const spawnMock = vi.mocked(spawn);
    const repoPath = path.resolve(fs.mkdtempSync(path.join('/tmp', 'nanoclaw-review-')));
    const realRepoPath = fs.realpathSync(repoPath);
    const { resultPromise } = await startAgentRun(
      {
        ...testGroup,
        agentConfig: {
          allowedDirectories: [repoPath],
          strictAllowedDirectories: true,
          projectRoot: repoPath,
          workingDirectory: repoPath,
        },
      },
      testInput,
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(spawnOptions?.cwd).toBe(repoPath);
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_PROJECT_ROOT).toBe(repoPath);
    const allowedDirs = JSON.parse(
      env?.NANOCLAW_ALLOWED_DIRS || '[]',
    ) as string[];
    expect(allowedDirs).toContain(realRepoPath);
    expect(allowedDirs).not.toContain(process.cwd());

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-strict-review-chat',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-strict-review-chat');
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('uses the assistant workspace root instead of inheriting the app project root', async () => {
    const spawnMock = vi.mocked(spawn);
    const assistantRoot = path.resolve(fs.mkdtempSync(
      path.join('/tmp', 'nanoclaw-assistant-root-'),
    ));
    const assistantShared = path.resolve(fs.mkdtempSync(
      path.join('/tmp', 'nanoclaw-assistant-shared-'),
    ));
    const realAssistantRoot = fs.realpathSync(assistantRoot);
    const realAssistantShared = fs.realpathSync(assistantShared);
    const { resultPromise } = await startAgentRun(
      testGroup,
      {
        ...testInput,
        allowedDirectoriesOverride: [assistantRoot, assistantShared],
        projectRootOverride: assistantRoot,
        restrictProjectRootInheritance: true,
      },
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(spawnOptions?.cwd).toBe(assistantRoot);
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_PROJECT_ROOT).toBe(assistantRoot);
    expect(env?.NANOCLAW_EXTRA_DIR).toBe(
      path.join(
        '/tmp',
        'nanoclaw-test-data',
        'sessions',
        'test-group',
        'workspace-extra',
      ),
    );
    expect(env?.NANOCLAW_WORKSPACE_EXTRA_HINT).toBe(
      JSON.stringify([
        {
          label: `02-${path
            .basename(assistantShared)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 24) || 'dir'}`,
          hostPath: assistantShared,
        },
      ]),
    );
    const allowedDirs = JSON.parse(
      env?.NANOCLAW_ALLOWED_DIRS || '[]',
    ) as string[];
    expect(allowedDirs).toContain(realAssistantRoot);
    expect(allowedDirs).toContain(realAssistantShared);
    expect(allowedDirs).not.toContain(process.cwd());

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-assistant-root',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-assistant-root');
    fs.rmSync(assistantRoot, { recursive: true, force: true });
    fs.rmSync(assistantShared, { recursive: true, force: true });
  });

  it('uses default access policy when an assistant is bound (assistant no longer controls access)', async () => {
    const spawnMock = vi.mocked(spawn);
    const { resultPromise } = await startAgentRun(
      {
        ...testGroup,
        assistantId: 'assistant-1',
        agentConfig: {
          allowedDirectories: ['/tmp/legacy'],
          strictAllowedDirectories: false,
        },
      },
      testInput,
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_ACCESS_MODE).toBe('allowall');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-assistant-derived-access',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-assistant-derived-access');
  });

  it('falls back to the group folder when an assistant has no workspace directories', async () => {
    const spawnMock = vi.mocked(spawn);
    const { resultPromise } = await startAgentRun(
      testGroup,
      {
        ...testInput,
        allowedDirectoriesOverride: [],
        restrictProjectRootInheritance: true,
      },
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    const expectedGroupRoot = path.resolve(
      '/tmp',
      'nanoclaw-test-groups',
      'test-group',
    );
    expect(spawnOptions?.cwd).toBe(
      expectedGroupRoot,
    );
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_PROJECT_ROOT).toBeUndefined();
    const allowedDirs = JSON.parse(
      env?.NANOCLAW_ALLOWED_DIRS || '[]',
    ) as string[];
    expect(allowedDirs).toContain(expectedGroupRoot);
    expect(allowedDirs).not.toContain(process.cwd());

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-assistant-group-root',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-assistant-group-root');
  });

  it('forwards assistant rule mode to the agent runner environment', async () => {
    const spawnMock = vi.mocked(spawn);
    const { resultPromise } = await startAgentRun(
      testGroup,
      {
        ...testInput,
        instructionsAppend: 'Assistant profile "演示助手" system prompt:\n只处理指定任务',
        assistantRuleMode: 'locked',
      },
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_ASSISTANT_INSTRUCTIONS_APPEND).toContain('演示助手');
    expect(env?.NANOCLAW_ASSISTANT_RULE_MODE).toBe('locked');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-assistant-rule-mode',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-assistant-rule-mode');
  });

  it('forwards conversation soul system prompts to the agent runner environment', async () => {
    const spawnMock = vi.mocked(spawn);
    const { resultPromise } = await startAgentRun(
      testGroup,
      {
        ...testInput,
        soulSystemPrompt: 'Conversation soul instructions are the primary voice policy.',
      },
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_SOUL_SYSTEM_PROMPT).toContain('primary voice policy');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-soul-system-prompt',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-soul-system-prompt');
  });

  it('defaults non-main web sessions to the group folder without mounting the app project root', async () => {
    const spawnMock = vi.mocked(spawn);
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    const expectedGroupRoot = path.resolve(
      '/tmp',
      'nanoclaw-test-groups',
      'test-group',
    );
    expect(spawnOptions?.cwd).toBe(expectedGroupRoot);
    const env = spawnOptions?.env as Record<string, string> | undefined;
    expect(env?.NANOCLAW_PROJECT_ROOT).toBeUndefined();
    const allowedDirs = JSON.parse(
      env?.NANOCLAW_ALLOWED_DIRS || '[]',
    ) as string[];
    expect(allowedDirs).not.toContain(process.cwd());
    expect(
      allowedDirs.some(
        (entry) => /(^|\/|\\)test-group$/.test(entry),
      ),
    ).toBe(true);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-project-root-default',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-project-root-default');
  });

  it('tolerates EOF errors while writing agent input to stdin', async () => {
    const { resultPromise } = await startAgentRun(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.stdin.emit(
      'error',
      Object.assign(new Error('write EOF'), { code: 'EOF' }),
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-stdin-eof',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-stdin-eof');
  });
});
