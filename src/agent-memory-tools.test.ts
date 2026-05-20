import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/runner/src/codex-mcp-tools.js', () => ({
  listCodexMcpTools: vi.fn(async () => []),
  executeCodexMcpTool: vi.fn(async () => null),
}));

const createdPaths: string[] = [];
const memoryToolsModulePath = '../agent/runner/src/memory-tools.js';
const codexToolsModulePath = '../agent/runner/src/codex-tools.js';
type ScopedMemoryResult = { path: string };
type CodexFunctionTool = { type: 'function'; name: string };

function importMemoryTools() {
  return import(memoryToolsModulePath);
}

function importCodexTools() {
  return import(codexToolsModulePath);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const target of createdPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

function createMemoryWorkspace(): { groupDir: string; globalDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-tools-'));
  const groupDir = path.join(root, 'group');
  const globalDir = path.join(root, 'global');
  fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(globalDir, 'memory'), { recursive: true });
  createdPaths.push(root);
  return { groupDir, globalDir };
}

describe('agent runner memory tools', () => {
  it('searches group and global memory with scoped path refs', async () => {
    const { groupDir, globalDir } = createMemoryWorkspace();
    fs.writeFileSync(
      path.join(groupDir, 'MEMORY.md'),
      ['# Durable Notes', 'Deployment window is Friday night.', 'Owner: Alice'].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(globalDir, 'memory', '2026-03-17.md'),
      ['# Daily', 'Alice asked for a Friday deployment reminder.'].join('\n'),
      'utf8',
    );

    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);

    const { searchMemory, readMemoryFile } = await importMemoryTools();

    const results = searchMemory('Friday deployment', { scope: 'all' });
    expect(results).toHaveLength(2);
    expect(results.map((result: ScopedMemoryResult) => result.path)).toContain(
      'group:MEMORY.md',
    );
    expect(results.map((result: ScopedMemoryResult) => result.path)).toContain(
      'global:memory/2026-03-17.md',
    );

    const snippet = readMemoryFile('group:MEMORY.md', { from: 1, lines: 3 });
    expect(snippet.path).toBe('group:MEMORY.md');
    expect(snippet.text).toContain('Deployment window is Friday night.');
  });

  it('uses indexed internal search when the internal API is available', async () => {
    vi.stubEnv('NANOCLAW_INTERNAL_API_BASE', 'http://127.0.0.1:3377');
    vi.stubEnv('NANOCLAW_INTERNAL_API_TOKEN', 'secret-token');
    vi.stubEnv('NANOCLAW_CHAT_JID', 'memory-tools@g.us');
    vi.stubEnv('NANOCLAW_GROUP_FOLDER', 'memory-tools-group');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            path: 'group:MEMORY.md',
            scope: 'group',
            lineStart: 1,
            lineEnd: 2,
            score: 0.92,
            snippet: '000001|# Durable Notes\n000002|Deployment window is Friday night.',
          },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const { searchMemoryRuntime } = await importMemoryTools();
    const results = await searchMemoryRuntime('Friday deployment', {
      scope: 'group',
      maxResults: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe('group:MEMORY.md');
    expect(results[0]?.snippet).toContain('Friday night');
  });

  it('lets memory_get read user:memory refs returned by memory_search', async () => {
    const { groupDir, globalDir } = createMemoryWorkspace();
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    vi.stubEnv('NANOCLAW_INTERNAL_API_BASE', 'http://127.0.0.1:3377');
    vi.stubEnv('NANOCLAW_INTERNAL_API_TOKEN', 'secret-token');
    vi.stubEnv('NANOCLAW_USER_ID', 'memory-user');
    vi.stubEnv('NANOCLAW_CHAT_JID', 'memory-tools@g.us');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/internal/memory/user/search')) {
        return {
          ok: true,
          json: async () => ({
            memories: [
              {
                id: 'memory-1',
                category: 'preference',
                content: 'Alice prefers concise status updates.',
                importance: 8,
                scope: 'global',
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const { executeTool } = await importCodexTools();

    const searchOutput = await executeTool(
      'memory_search',
      {
        query: 'concise status',
        max_results: 3,
      },
      groupDir,
    );
    const getOutput = await executeTool(
      'memory_get',
      {
        path: 'user:memory/memory-1',
      },
      groupDir,
    );

    expect(searchOutput).toContain('user:memory/memory-1');
    expect(getOutput).toContain('user:memory/memory-1#L1-L1');
    expect(getOutput).toContain('Alice prefers concise status updates.');
  });

  it('attaches recent search follow-up metadata when memory_get reads a searched hit', { timeout: 15_000 }, async () => {
    const { groupDir, globalDir } = createMemoryWorkspace();
    fs.writeFileSync(
      path.join(groupDir, 'MEMORY.md'),
      ['# Durable Notes', 'Deployment window is Friday night.', 'Owner: Alice'].join('\n'),
      'utf8',
    );
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    vi.stubEnv('NANOCLAW_INTERNAL_API_BASE', 'http://127.0.0.1:3377');
    vi.stubEnv('NANOCLAW_INTERNAL_API_TOKEN', 'secret-token');
    vi.stubEnv('NANOCLAW_CHAT_JID', 'memory-tools@g.us');
    vi.stubEnv('NANOCLAW_GROUP_FOLDER', 'memory-tools-group');

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/internal/memory/search')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                path: 'group:MEMORY.md',
                scope: 'group',
                lineStart: 1,
                lineEnd: 2,
                score: 0.92,
                snippet:
                  '000001|# Durable Notes\n000002|Deployment window is Friday night.',
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const { executeTool } = await importCodexTools();
    await executeTool(
      'memory_search',
      {
        query: 'Friday deployment',
        scope: 'group',
        max_results: 3,
      },
      groupDir,
    );
    await executeTool(
      'memory_get',
      {
        path: 'group:MEMORY.md',
        from: 1,
        lines: 2,
      },
      groupDir,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const recallCall = fetchMock.mock.calls[1];
    expect(String(recallCall?.[0])).toContain('/internal/memory/recall');
    const recallPayload = JSON.parse(String(recallCall?.[1]?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(recallPayload).toMatchObject({
      path: 'group:MEMORY.md',
      searchQuery: 'Friday deployment',
      searchRank: 1,
      searchResultCount: 1,
    });
    expect(typeof recallPayload.searchMatchedAt).toBe('string');
  });

  it('builds a structured search response while preserving text rendering', async () => {
    const { buildMemorySearchResponse } = await importMemoryTools();

    const response = buildMemorySearchResponse('Friday deployment', [
      {
        path: 'group:MEMORY.md',
        scope: 'group',
        lineStart: 1,
        lineEnd: 2,
        score: 9,
        snippet:
          '000001|# Durable Notes\n000002|Deployment window is Friday night.',
      },
    ]);

    expect(response.query).toBe('Friday deployment');
    expect(response.resultCount).toBe(1);
    expect(response.results[0]?.path).toBe('group:MEMORY.md');
    expect(response.renderedText).toContain(
      'Memory matches for "Friday deployment":',
    );
    expect(response.renderedText).toContain(
      'group:MEMORY.md#L1-L2 (score=9)',
    );
  });

  it('rejects non-memory paths', async () => {
    const { groupDir, globalDir } = createMemoryWorkspace();
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);

    const { resolveMemoryPathRef } = await importMemoryTools();

    expect(() => resolveMemoryPathRef('group:notes.txt')).toThrow(
      /Memory path is not allowed/i,
    );
    expect(() => resolveMemoryPathRef('group:../secret.md')).toThrow(
      /Memory path is not allowed/i,
    );
  });

  it('appends a note to today daily memory file', async () => {
    const { groupDir, globalDir } = createMemoryWorkspace();
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    vi.stubEnv('NANOCLAW_IS_MAIN', '0');
    vi.stubEnv('NANOCLAW_INTERNAL_API_BASE', 'http://127.0.0.1:3377');
    vi.stubEnv('NANOCLAW_INTERNAL_API_TOKEN', 'secret-token');
    vi.stubEnv('NANOCLAW_CHAT_JID', 'memory-tools@g.us');
    vi.stubEnv('NANOCLAW_GROUP_FOLDER', 'memory-tools-group');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const { readMemoryFile, saveMemoryNote } = await importMemoryTools();

    const result = saveMemoryNote('Remember the Friday deployment window.', {
      scope: 'group',
      now: new Date('2026-03-17T08:30:00'),
    });

    expect(result.path).toBe('group:memory/2026-03-17.md');
    expect(result.appendedText).toContain('Remember the Friday deployment window.');

    const saved = readMemoryFile('group:memory/2026-03-17.md', {
      from: 1,
      lines: 10,
    });
    expect(saved.text).toContain('# Daily Memory 2026-03-17');
    expect(saved.text).toContain('Remember the Friday deployment window.');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3377/internal/memory/save-file',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"pathRef":"group:memory/2026-03-17.md"'),
      }),
    );
  });

  it('rejects global memory writes outside the main session', async () => {
    const { groupDir, globalDir } = createMemoryWorkspace();
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    vi.stubEnv('NANOCLAW_IS_MAIN', '0');
    vi.stubEnv('MEMORY_GLOBAL_WRITE_ENABLED', 'true');

    const { saveMemoryNote } = await importMemoryTools();

    expect(() =>
      saveMemoryNote('Do not allow this.', { scope: 'global' }),
    ).toThrow(/only allowed in the main session/i);
  });

  it('disables memory tools when memory is disabled by configuration', async () => {
    vi.stubEnv('NANOCLAW_WEB_SEARCH_ENABLED', 'false');
    vi.stubEnv('MEMORY_ENABLED', 'false');
    vi.resetModules();

    const { buildCodexResponsesTools, executeTool } = await importCodexTools();

    const tools = await buildCodexResponsesTools();
    const functionToolNames = tools.flatMap((tool: CodexFunctionTool) =>
      tool.type === 'function' && 'name' in tool ? [tool.name] : [],
    );

    for (const toolName of ['memory_search', 'memory_get', 'memory_save']) {
      if (!functionToolNames.includes(toolName)) continue;
      const output = await executeTool(
        toolName,
        toolName === 'memory_save'
          ? { note: 'blocked note' }
          : toolName === 'memory_get'
            ? { path: 'group:MEMORY.md' }
            : { query: 'deployment' },
        process.cwd(),
      );
      expect(output).toMatch(/disabled by configuration/i);
    }
  });

  it('rejects group memory writes when write mode is disabled', async () => {
    const { groupDir, globalDir } = createMemoryWorkspace();
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    vi.stubEnv('MEMORY_WRITE_MODE', 'disabled');

    const { saveMemoryNote } = await importMemoryTools();

    expect(() => saveMemoryNote('blocked note', { scope: 'group' })).toThrow(
      /writes are disabled by configuration/i,
    );
  });

  it('does not best-effort save user memory before disabled write checks pass', async () => {
    const { groupDir, globalDir } = createMemoryWorkspace();
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    vi.stubEnv('MEMORY_WRITE_MODE', 'disabled');
    vi.stubEnv('NANOCLAW_INTERNAL_API_BASE', 'http://127.0.0.1:3377');
    vi.stubEnv('NANOCLAW_INTERNAL_API_TOKEN', 'secret-token');
    vi.stubEnv('NANOCLAW_USER_ID', 'memory-user');
    vi.stubEnv('NANOCLAW_CHAT_JID', 'memory-tools@g.us');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const { saveMemoryNote } = await importMemoryTools();

    expect(() => saveMemoryNote('blocked note', { scope: 'group' })).toThrow(
      /writes are disabled by configuration/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds memory_search, memory_get, and memory_save to codex tool definitions', async () => {
    vi.stubEnv('NANOCLAW_WEB_SEARCH_ENABLED', 'false');
    const { buildCodexResponsesTools } = await importCodexTools();

    const tools = await buildCodexResponsesTools();
    const functionToolNames = tools.flatMap((tool: CodexFunctionTool) =>
      tool.type === 'function' && 'name' in tool ? [tool.name] : [],
    );

    expect(functionToolNames).toContain('memory_search');
    expect(functionToolNames).toContain('memory_get');
    expect(functionToolNames).toContain('memory_save');
  });
});
