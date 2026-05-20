import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearEphemeralSubagentRuntimes,
  getSubagentRuntime,
  listSubagentRunDescendants,
  listSubagentRuns,
  listSubagentRunsForController,
  listSubagentRunsForRequester,
  listSubagentRuntimeTree,
  listSubagentRuntimes,
  listPersistedSubagentRuns,
  removeEphemeralSubagentRuntime,
  recoverOrphanedSubagentRuntimes,
  requestMessageSubagentRuntime,
  requestStopSubagentRuntimes,
  requestStopSubagentRuntime,
  requestSteerSubagentRuntime,
  type SubagentRuntimeEntry,
  upsertEphemeralSubagentRuntime,
} from './subagent-runtime-registry.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function createRuntimeEntry(
  id: string,
  patch: Partial<SubagentRuntimeEntry> = {},
): SubagentRuntimeEntry {
  return {
    id,
    provider: 'codex',
    mode: 'team',
    groupFolder: 'alpha-room',
    chatJid: 'alpha@g.us',
    name: `Subagent ${id}`,
    task: `Task ${id}`,
    status: 'running',
    depth: 1,
    createdAt: '2026-03-18T00:00:00.000Z',
    updatedAt: '2026-03-18T00:00:00.000Z',
    ...patch,
  };
}

describe('subagent runtime registry', () => {
  let tempGroupsDir = '';
  let tempRunRegistryPath = '';

  beforeEach(() => {
    tempGroupsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-subagent-runtime-'),
    );
    tempRunRegistryPath = path.join(
      tempGroupsDir,
      'subagent-run-registry.json',
    );
    vi.stubEnv('NANOCLAW_GROUPS_DIR_OVERRIDE', tempGroupsDir);
    vi.stubEnv(
      'NANOCLAW_SUBAGENT_RUN_REGISTRY_PATH_OVERRIDE',
      tempRunRegistryPath,
    );
  });

  afterEach(() => {
    fs.rmSync(tempGroupsDir, { recursive: true, force: true });
    clearEphemeralSubagentRuntimes();
    vi.unstubAllEnvs();
  });

  it('merges live runtime records with archived history and prefers the newest entry', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );

    writeJson(path.join(runtimeRoot, 'history.json'), [
      createRuntimeEntry('archived-1', {
        mode: 'agent',
        status: 'completed',
        updatedAt: '2026-03-18T00:01:00.000Z',
        completedAt: '2026-03-18T00:01:00.000Z',
      }),
      createRuntimeEntry('shared-1', {
        status: 'completed',
        updatedAt: '2026-03-18T00:03:00.000Z',
        completedAt: '2026-03-18T00:03:00.000Z',
      }),
    ]);

    writeJson(
      path.join(runtimeRoot, 'shared-1', 'runtime.json'),
      createRuntimeEntry('shared-1', {
        status: 'running',
        updatedAt: '2026-03-18T00:05:00.000Z',
        pid: 4321,
      }),
    );
    writeJson(
      path.join(runtimeRoot, 'live-2', 'runtime.json'),
      createRuntimeEntry('live-2', {
        status: 'spawning',
        updatedAt: '2026-03-18T00:04:00.000Z',
      }),
    );

    const snapshot = listSubagentRuntimes(2);

    expect(snapshot.activeCount).toBe(2);
    expect(snapshot.recentCount).toBe(3);
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.map((item) => item.id)).toEqual([
      'shared-1',
      'live-2',
    ]);
    expect(snapshot.items[0]).toMatchObject({
      id: 'shared-1',
      status: 'running',
      pid: 4321,
    });
  });

  it('writes a close sentinel for active runtimes and treats archived items as already stopped', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );

    writeJson(
      path.join(runtimeRoot, 'live-1', 'runtime.json'),
      createRuntimeEntry('live-1', {
        status: 'running',
        updatedAt: '2026-03-18T00:05:00.000Z',
      }),
    );
    writeJson(path.join(runtimeRoot, 'history.json'), [
      createRuntimeEntry('archived-2', {
        status: 'completed',
        updatedAt: '2026-03-18T00:02:00.000Z',
        completedAt: '2026-03-18T00:02:00.000Z',
      }),
    ]);

    const activeResult = requestStopSubagentRuntime('live-1');
    expect(activeResult).toMatchObject({
      ok: true,
      status: 'stop_requested',
    });
    expect(
      fs.existsSync(path.join(runtimeRoot, 'live-1', 'ipc', 'input', '_close')),
    ).toBe(true);

    const archivedResult = requestStopSubagentRuntime('archived-2');
    expect(archivedResult).toMatchObject({
      ok: true,
      status: 'already_stopped',
      entry: expect.objectContaining({ id: 'archived-2' }),
    });

    expect(requestStopSubagentRuntime('missing')).toMatchObject({
      ok: false,
      status: 'not_found',
    });
  });

  it('batch-stops active runtimes for a turn and can limit to agent mode', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );

    writeJson(
      path.join(runtimeRoot, 'team-root', 'runtime.json'),
      createRuntimeEntry('team-root', {
        mode: 'team',
        originTurnId: 'turn-1',
        status: 'running',
        depth: 1,
        updatedAt: '2026-03-18T00:05:00.000Z',
      }),
    );
    writeJson(
      path.join(runtimeRoot, 'agent-child', 'runtime.json'),
      createRuntimeEntry('agent-child', {
        mode: 'agent',
        parentRuntimeId: 'team-root',
        originTurnId: 'turn-1',
        status: 'running',
        depth: 2,
        updatedAt: '2026-03-18T00:06:00.000Z',
      }),
    );
    writeJson(
      path.join(runtimeRoot, 'other-turn', 'runtime.json'),
      createRuntimeEntry('other-turn', {
        mode: 'agent',
        originTurnId: 'turn-2',
        status: 'running',
        depth: 1,
        updatedAt: '2026-03-18T00:07:00.000Z',
      }),
    );

    const agentOnly = requestStopSubagentRuntimes({
      chatJid: 'alpha@g.us',
      originTurnId: 'turn-1',
      modes: ['agent'],
    });
    expect(agentOnly).toEqual({
      matchedIds: ['agent-child'],
      stopRequestedIds: ['agent-child'],
      alreadyStoppedIds: [],
      notControllableIds: [],
    });
    expect(
      fs.existsSync(
        path.join(runtimeRoot, 'agent-child', 'ipc', 'input', '_close'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(runtimeRoot, 'team-root', 'ipc', 'input', '_close'),
      ),
    ).toBe(false);

    const allModes = requestStopSubagentRuntimes({
      chatJid: 'alpha@g.us',
      originTurnId: 'turn-1',
      modes: ['agent', 'team'],
    });
    expect(allModes).toEqual({
      matchedIds: ['agent-child', 'team-root'],
      stopRequestedIds: ['agent-child', 'team-root'],
      alreadyStoppedIds: [],
      notControllableIds: [],
    });
    expect(
      fs.existsSync(
        path.join(runtimeRoot, 'team-root', 'ipc', 'input', '_close'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(runtimeRoot, 'other-turn', 'ipc', 'input', '_close'),
      ),
    ).toBe(false);
  });

  it('supports filtered runtime listing with activeOnly and status filters', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );

    writeJson(
      path.join(runtimeRoot, 'live-running', 'runtime.json'),
      createRuntimeEntry('live-running', {
        status: 'running',
        updatedAt: '2026-03-18T00:05:00.000Z',
      }),
    );
    writeJson(
      path.join(runtimeRoot, 'live-stopping', 'runtime.json'),
      createRuntimeEntry('live-stopping', {
        status: 'stopping',
        updatedAt: '2026-03-18T00:04:00.000Z',
      }),
    );
    writeJson(path.join(runtimeRoot, 'history.json'), [
      createRuntimeEntry('archived-completed', {
        status: 'completed',
        updatedAt: '2026-03-18T00:03:00.000Z',
        completedAt: '2026-03-18T00:03:00.000Z',
      }),
    ]);

    const activeOnlySnapshot = listSubagentRuntimes({
      activeOnly: true,
      provider: 'codex',
      limit: 10,
    });
    expect(activeOnlySnapshot.items.map((item) => item.id)).toEqual([
      'live-running',
      'live-stopping',
    ]);

    const statusFilteredSnapshot = listSubagentRuntimes({
      status: 'completed',
      limit: 10,
    });
    expect(statusFilteredSnapshot.items).toEqual([
      expect.objectContaining({
        id: 'archived-completed',
        status: 'completed',
      }),
    ]);
  });

  it('accepts claude runtime entries and filters by provider', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );

    writeJson(
      path.join(runtimeRoot, 'claude-live', 'runtime.json'),
      createRuntimeEntry('claude-live', {
        provider: 'claude',
        mode: 'team',
        status: 'idle',
        updatedAt: '2026-03-18T00:06:00.000Z',
      }),
    );
    writeJson(
      path.join(runtimeRoot, 'codex-live', 'runtime.json'),
      createRuntimeEntry('codex-live', {
        provider: 'codex',
        mode: 'agent',
        status: 'running',
        updatedAt: '2026-03-18T00:05:00.000Z',
      }),
    );

    const claudeSnapshot = listSubagentRuntimes({
      provider: 'claude',
      limit: 10,
    });

    expect(claudeSnapshot.items).toEqual([
      expect.objectContaining({
        id: 'claude-live',
        provider: 'claude',
        status: 'idle',
      }),
    ]);
    expect(claudeSnapshot.activeCount).toBe(1);
  });

  it('marks history-only active runtimes as not controllable', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );

    writeJson(path.join(runtimeRoot, 'history.json'), [
      createRuntimeEntry('legacy-running', {
        status: 'running',
        updatedAt: '2026-03-18T00:03:00.000Z',
      }),
    ]);

    expect(requestStopSubagentRuntime('legacy-running')).toMatchObject({
      ok: false,
      status: 'not_controllable',
      entry: expect.objectContaining({
        id: 'legacy-running',
        controlState: 'read_only',
        controlReason: 'legacy_active_runtime',
        controllable: false,
      }),
    });
  });

  it('merges ephemeral claude runtimes into the shared runtime snapshot', () => {
    upsertEphemeralSubagentRuntime(
      createRuntimeEntry('claude-ephemeral', {
        provider: 'claude',
        status: 'running',
        updatedAt: '2026-03-18T00:07:00.000Z',
      }),
    );

    const snapshot = listSubagentRuntimes({
      provider: 'claude',
      activeOnly: true,
      limit: 10,
    });

    expect(snapshot.items).toEqual([
      expect.objectContaining({
        id: 'claude-ephemeral',
        provider: 'claude',
        controlState: 'read_only',
        controlReason: 'provider_read_only_runtime',
      }),
    ]);
    expect(getSubagentRuntime('claude-ephemeral')).toMatchObject({
      id: 'claude-ephemeral',
      provider: 'claude',
    });

    removeEphemeralSubagentRuntime('claude-ephemeral');
    expect(getSubagentRuntime('claude-ephemeral')).toBeNull();
  });

  it('builds a runtime tree with descendant counts from parentRuntimeId', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );

    writeJson(
      path.join(runtimeRoot, 'parent', 'runtime.json'),
      createRuntimeEntry('parent', {
        mode: 'team',
        status: 'idle',
        updatedAt: '2026-03-18T00:08:00.000Z',
      }),
    );
    writeJson(
      path.join(runtimeRoot, 'child', 'runtime.json'),
      createRuntimeEntry('child', {
        mode: 'team',
        parentRuntimeId: 'parent',
        status: 'running',
        updatedAt: '2026-03-18T00:07:00.000Z',
      }),
    );
    writeJson(
      path.join(runtimeRoot, 'grandchild', 'runtime.json'),
      createRuntimeEntry('grandchild', {
        mode: 'agent',
        parentRuntimeId: 'child',
        status: 'completed',
        updatedAt: '2026-03-18T00:06:00.000Z',
        completedAt: '2026-03-18T00:06:00.000Z',
      }),
    );

    const tree = listSubagentRuntimeTree({ limit: 10 });
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]?.entry).toMatchObject({
      id: 'parent',
      childCount: 1,
      descendantCount: 2,
      activeDescendantCount: 1,
    });
    expect(tree.roots[0]?.children[0]?.entry).toMatchObject({
      id: 'child',
      childCount: 1,
      descendantCount: 1,
      activeDescendantCount: 0,
    });
    const persisted = listPersistedSubagentRuns();
    expect(persisted.total).toBe(3);
    expect(fs.existsSync(tempRunRegistryPath)).toBe(true);
    expect(persisted.runs[0]).toMatchObject({
      runId: 'parent',
      runtimeId: 'parent',
      provider: 'codex',
      childRuntimeIds: ['child'],
      childCount: 1,
      descendantCount: 2,
      activeDescendantCount: 1,
    });
  });

  it('discovers and stops grandchild runtimes in nested runtime roots', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );
    const childRuntimeRoot = path.join(
      runtimeRoot,
      'parent',
      'group',
      '.nanoclaw-subagents',
    );
    const grandchildRuntimeRoot = path.join(
      childRuntimeRoot,
      'child',
      'group',
      '.nanoclaw-subagents',
    );

    writeJson(
      path.join(runtimeRoot, 'parent', 'runtime.json'),
      createRuntimeEntry('parent', {
        mode: 'team',
        status: 'idle',
        depth: 1,
        updatedAt: '2026-03-18T00:12:00.000Z',
      }),
    );
    writeJson(
      path.join(childRuntimeRoot, 'child', 'runtime.json'),
      createRuntimeEntry('child', {
        mode: 'team',
        parentRuntimeId: 'parent',
        status: 'idle',
        depth: 2,
        updatedAt: '2026-03-18T00:11:00.000Z',
      }),
    );
    writeJson(
      path.join(grandchildRuntimeRoot, 'grandchild', 'runtime.json'),
      createRuntimeEntry('grandchild', {
        mode: 'agent',
        parentRuntimeId: 'child',
        status: 'running',
        depth: 3,
        updatedAt: '2026-03-18T00:10:00.000Z',
      }),
    );

    expect(getSubagentRuntime('grandchild')).toMatchObject({
      id: 'grandchild',
      parentRuntimeId: 'child',
      controlState: 'controllable',
    });
    expect(
      listSubagentRunDescendants('parent', { limit: 10 }).items.map(
        (item) => item.runtimeId,
      ),
    ).toEqual(['child', 'grandchild']);

    const stopResult = requestStopSubagentRuntime('grandchild');
    expect(stopResult).toMatchObject({
      ok: true,
      status: 'stop_requested',
    });
    expect(
      fs.existsSync(
        path.join(
          grandchildRuntimeRoot,
          'grandchild',
          'ipc',
          'input',
          '_close',
        ),
      ),
    ).toBe(true);
  });

  it('supports persisted run queries by controller, requester, and descendants', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );

    writeJson(
      path.join(runtimeRoot, 'parent', 'runtime.json'),
      createRuntimeEntry('parent', {
        mode: 'team',
        status: 'idle',
        controllerSessionKey: 'controller-a',
        requesterSessionKey: 'requester-a',
        updatedAt: '2026-03-18T00:12:00.000Z',
      }),
    );
    writeJson(
      path.join(runtimeRoot, 'child-a', 'runtime.json'),
      createRuntimeEntry('child-a', {
        mode: 'team',
        parentRuntimeId: 'parent',
        status: 'running',
        controllerSessionKey: 'controller-a',
        requesterSessionKey: 'requester-a',
        originTurnId: 'turn-a',
        originToolCallId: 'tool-a',
        updatedAt: '2026-03-18T00:11:00.000Z',
      }),
    );
    writeJson(
      path.join(runtimeRoot, 'child-b', 'runtime.json'),
      createRuntimeEntry('child-b', {
        mode: 'agent',
        parentRuntimeId: 'parent',
        status: 'completed',
        controllerSessionKey: 'controller-b',
        requesterSessionKey: 'requester-b',
        updatedAt: '2026-03-18T00:10:00.000Z',
        completedAt: '2026-03-18T00:10:00.000Z',
      }),
    );

    expect(
      listSubagentRunsForController('controller-a', { limit: 10 }).items.map(
        (item) => item.runtimeId,
      ),
    ).toEqual(['parent', 'child-a']);
    expect(
      listSubagentRunsForRequester('requester-a', { limit: 10 }).items.map(
        (item) => item.runtimeId,
      ),
    ).toEqual(['parent', 'child-a']);
    expect(
      listSubagentRuns({ parentRuntimeId: 'parent', limit: 10 }).items.map(
        (item) => item.runtimeId,
      ),
    ).toEqual(['child-a', 'child-b']);
    expect(
      listSubagentRuns({ runtimeId: 'child-a', limit: 10 }).items.map(
        (item) => item.runtimeId,
      ),
    ).toEqual(['child-a']);
    expect(
      listSubagentRuns({ originTurnId: 'turn-a', limit: 10 }).items.map(
        (item) => item.runtimeId,
      ),
    ).toEqual(['child-a']);
    expect(
      listSubagentRuns({ originToolCallId: 'tool-a', limit: 10 }).items.map(
        (item) => item.runtimeId,
      ),
    ).toEqual(['child-a']);
    expect(
      listSubagentRunDescendants('parent', { limit: 10 }).items.map(
        (item) => item.runtimeId,
      ),
    ).toEqual(['child-a', 'child-b']);
  });

  it('writes message and steer IPC requests for controllable team runtimes', async () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );
    writeJson(
      path.join(runtimeRoot, 'live-team', 'runtime.json'),
      createRuntimeEntry('live-team', {
        mode: 'team',
        status: 'idle',
        updatedAt: '2026-03-18T00:09:00.000Z',
      }),
    );

    const messageResult = await requestMessageSubagentRuntime(
      'live-team',
      'Continue the analysis',
      { waitForResponse: false },
    );
    expect(messageResult).toMatchObject({
      ok: true,
      status: 'accepted',
      requestId: expect.any(String),
    });

    const inputDir = path.join(runtimeRoot, 'live-team', 'ipc', 'input');
    const requestFiles = fs
      .readdirSync(inputDir)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    expect(requestFiles.length).toBeGreaterThan(0);

    const firstPayload = JSON.parse(
      fs.readFileSync(path.join(inputDir, requestFiles[0]!), 'utf8'),
    ) as { type?: string; prompt?: string };
    expect(firstPayload).toMatchObject({
      type: 'message',
      prompt: 'Continue the analysis',
    });

    const steerResult = await requestSteerSubagentRuntime(
      'live-team',
      'Refocus on the failing tests',
      { waitForResponse: false },
    );
    expect(steerResult).toMatchObject({
      ok: true,
      status: 'accepted',
      requestId: expect.any(String),
    });

    const prompts = fs
      .readdirSync(inputDir)
      .filter((entry) => entry.endsWith('.json'))
      .map(
        (entry) =>
          JSON.parse(fs.readFileSync(path.join(inputDir, entry), 'utf8')) as {
            prompt?: string;
          },
      )
      .map((payload) => payload.prompt || '');
    expect(prompts.some((prompt) => prompt.includes('[STEER]'))).toBe(true);
  });

  it('treats leaf runtimes as messageable but not steerable', async () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );
    writeJson(
      path.join(runtimeRoot, 'leaf-team', 'runtime.json'),
      createRuntimeEntry('leaf-team', {
        mode: 'team',
        status: 'idle',
        role: 'leaf',
        controlScope: 'none',
        updatedAt: '2026-03-18T00:09:30.000Z',
      }),
    );

    expect(getSubagentRuntime('leaf-team')).toMatchObject({
      id: 'leaf-team',
      capabilities: expect.objectContaining({
        canMessage: true,
        canSteer: false,
        canSpawnChildren: false,
      }),
    });

    const messageResult = await requestMessageSubagentRuntime(
      'leaf-team',
      '继续执行当前任务',
      { waitForResponse: false },
    );
    expect(messageResult).toMatchObject({
      ok: true,
      status: 'accepted',
    });

    const steerResult = await requestSteerSubagentRuntime(
      'leaf-team',
      '改成继续拆分并行子任务',
      { waitForResponse: false },
    );
    expect(steerResult).toMatchObject({
      ok: false,
      status: 'not_controllable',
      entry: expect.objectContaining({ id: 'leaf-team' }),
    });
  });

  it('recovers stale active codex runtimes into failed history on startup', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );
    writeJson(
      path.join(runtimeRoot, 'stale-team', 'runtime.json'),
      createRuntimeEntry('stale-team', {
        mode: 'team',
        status: 'running',
        pid: undefined,
        updatedAt: '2026-03-18T00:10:00.000Z',
      }),
    );

    const summary = recoverOrphanedSubagentRuntimes();
    expect(summary).toMatchObject({
      recovered: 1,
      failed: 0,
      removedRuntimeDirs: 1,
    });
    expect(
      fs.existsSync(path.join(runtimeRoot, 'stale-team', 'runtime.json')),
    ).toBe(false);

    const history = JSON.parse(
      fs.readFileSync(path.join(runtimeRoot, 'history.json'), 'utf8'),
    ) as SubagentRuntimeEntry[];
    expect(history[0]).toMatchObject({
      id: 'stale-team',
      status: 'failed',
    });
    expect(history[0]?.activeRequestId).toBeUndefined();
  });

  it('recovers stale grandchild runtimes in nested runtime roots', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );
    const nestedRuntimeRoot = path.join(
      runtimeRoot,
      'parent',
      'group',
      '.nanoclaw-subagents',
      'child',
      'group',
      '.nanoclaw-subagents',
    );
    writeJson(
      path.join(runtimeRoot, 'parent', 'runtime.json'),
      createRuntimeEntry('parent', {
        mode: 'team',
        status: 'completed',
        updatedAt: '2026-03-18T00:12:00.000Z',
      }),
    );
    writeJson(
      path.join(nestedRuntimeRoot, 'grandchild-stale', 'runtime.json'),
      createRuntimeEntry('grandchild-stale', {
        mode: 'team',
        parentRuntimeId: 'child',
        status: 'running',
        depth: 3,
        pid: undefined,
        updatedAt: '2026-03-18T00:13:00.000Z',
      }),
    );

    const summary = recoverOrphanedSubagentRuntimes();
    expect(summary).toMatchObject({
      recovered: 1,
      failed: 0,
      removedRuntimeDirs: 1,
    });
    expect(
      fs.existsSync(
        path.join(nestedRuntimeRoot, 'grandchild-stale', 'runtime.json'),
      ),
    ).toBe(false);

    const history = JSON.parse(
      fs.readFileSync(path.join(nestedRuntimeRoot, 'history.json'), 'utf8'),
    ) as SubagentRuntimeEntry[];
    expect(history[0]).toMatchObject({
      id: 'grandchild-stale',
      status: 'failed',
      parentRuntimeId: 'child',
    });
  });

  it('downgrades alive orphan runtimes to read-only instead of removing them', () => {
    const runtimeRoot = path.join(
      tempGroupsDir,
      'alpha-room',
      '.nanoclaw-subagents',
    );
    writeJson(
      path.join(runtimeRoot, 'alive-team', 'runtime.json'),
      createRuntimeEntry('alive-team', {
        mode: 'team',
        status: 'idle',
        pid: process.pid,
        updatedAt: '2026-03-18T00:11:00.000Z',
      }),
    );

    const summary = recoverOrphanedSubagentRuntimes();
    expect(summary).toMatchObject({
      recovered: 0,
      failed: 0,
      removedRuntimeDirs: 0,
    });
    expect(getSubagentRuntime('alive-team')).toMatchObject({
      id: 'alive-team',
      status: 'idle',
      controlState: 'read_only',
      controlReason: 'legacy_active_runtime',
      controllable: false,
    });
  });
});
