import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _listChangedJsonFilesForTests,
  _processSourceGroupIpcForTests,
} from './web/ipc.js';
import type { IpcDeps } from './web/ipc.js';

describe('ipc directory polling cache', () => {
  let tempDir = '';
  let cache: Map<string, { mtimeMs: number; size: number }>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-'));
    cache = new Map();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips rescanning unchanged directories', () => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'a.json'), '{"ok":true}', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'note.txt'), 'ignore', 'utf8');

    const first = _listChangedJsonFilesForTests(tempDir, cache);
    expect(first).toEqual(['a.json']);

    const second = _listChangedJsonFilesForTests(tempDir, cache);
    expect(second).toEqual([]);
  });

  it('rescans after directory contents change', () => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'first.json'), '{"ok":1}', 'utf8');
    expect(_listChangedJsonFilesForTests(tempDir, cache)).toEqual([
      'first.json',
    ]);

    fs.writeFileSync(path.join(tempDir, 'second.json'), '{"ok":2}', 'utf8');
    const changed = _listChangedJsonFilesForTests(tempDir, cache);
    expect(changed.sort()).toEqual(['first.json', 'second.json']);
  });

  it('drops cache entries when the directory disappears', () => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'a.json'), '{"ok":true}', 'utf8');
    expect(_listChangedJsonFilesForTests(tempDir, cache)).toEqual(['a.json']);

    fs.rmSync(tempDir, { recursive: true, force: true });
    expect(_listChangedJsonFilesForTests(tempDir, cache)).toEqual([]);
    expect(cache.has(tempDir)).toBe(false);
  });

  it('keeps message processing serial within one group', async () => {
    const ipcBaseDir = path.join(tempDir, 'ipc');
    const messagesDir = path.join(ipcBaseDir, 'group-a', 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(messagesDir, '001-first.json'),
      JSON.stringify({ type: 'message', chatJid: 'chat-a', text: 'first' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(messagesDir, '002-second.json'),
      JSON.stringify({ type: 'message', chatJid: 'chat-a', text: 'second' }),
      'utf8',
    );

    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const deps: IpcDeps = {
      sendMessage: async (_jid, text) => {
        events.push(`start:${text}`);
        if (text === 'first') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        events.push(`end:${text}`);
      },
      registeredGroups: () => ({
        'chat-a': {
          name: 'Chat A',
          folder: 'group-a',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      registerGroup: () => {},
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
    };

    const pending = _processSourceGroupIpcForTests('group-a', false, {
      deps,
      dirPollCache: cache,
      ensureErrorDir: () => path.join(ipcBaseDir, 'errors'),
      ipcBaseDir,
      registeredGroups: deps.registeredGroups(),
    });

    await Promise.resolve();
    expect(events).toEqual(['start:first']);

    releaseFirst!();
    await pending;
    expect(events).toEqual([
      'start:first',
      'end:first',
      'start:second',
      'end:second',
    ]);
  });

  it('allows different groups to progress in parallel', async () => {
    const ipcBaseDir = path.join(tempDir, 'ipc');
    const groupAMessages = path.join(ipcBaseDir, 'group-a', 'messages');
    const groupBMessages = path.join(ipcBaseDir, 'group-b', 'messages');
    fs.mkdirSync(groupAMessages, { recursive: true });
    fs.mkdirSync(groupBMessages, { recursive: true });
    fs.writeFileSync(
      path.join(groupAMessages, '001.json'),
      JSON.stringify({ type: 'message', chatJid: 'chat-a', text: 'slow' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(groupBMessages, '001.json'),
      JSON.stringify({ type: 'message', chatJid: 'chat-b', text: 'fast' }),
      'utf8',
    );

    const events: string[] = [];
    let releaseSlow: (() => void) | null = null;
    const deps: IpcDeps = {
      sendMessage: async (_jid, text) => {
        events.push(`start:${text}`);
        if (text === 'slow') {
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
        }
        events.push(`end:${text}`);
      },
      registeredGroups: () => ({
        'chat-a': {
          name: 'Chat A',
          folder: 'group-a',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
        'chat-b': {
          name: 'Chat B',
          folder: 'group-b',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      registerGroup: () => {},
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
    };

    const registeredGroups = deps.registeredGroups();
    const runBoth = Promise.all([
      _processSourceGroupIpcForTests('group-a', false, {
        deps,
        dirPollCache: cache,
        ensureErrorDir: () => path.join(ipcBaseDir, 'errors'),
        ipcBaseDir,
        registeredGroups,
      }),
      _processSourceGroupIpcForTests('group-b', false, {
        deps,
        dirPollCache: cache,
        ensureErrorDir: () => path.join(ipcBaseDir, 'errors'),
        ipcBaseDir,
        registeredGroups,
      }),
    ]);

    await Promise.resolve();
    expect(events).toContain('start:slow');
    expect(events).toContain('start:fast');
    expect(events).toContain('end:fast');
    expect(events).not.toContain('end:slow');

    releaseSlow!();
    await runBoth;
    expect(events).toContain('end:slow');
  });
});
