import { describe, expect, it } from 'vitest';

import {
  buildSharedStateKey,
  resolveCodexProviderConcurrency,
  withCodexProviderConcurrency,
} from './codex-provider-concurrency.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Codex provider concurrency policy', () => {
  it('does not serialize unrelated Codex requests by default', async () => {
    const policy = resolveCodexProviderConcurrency({});
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = withCodexProviderConcurrency(policy, async () => {
      events.push('start-a');
      markFirstStarted?.();
      await firstCanFinish;
      events.push('end-a');
    });

    await firstStarted;

    const second = withCodexProviderConcurrency(policy, async () => {
      events.push('start-b');
      events.push('end-b');
    });

    await delay(10);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(events.indexOf('start-b')).toBeLessThan(events.indexOf('end-a'));
  });

  it('serializes requests when explicit limit mode is enabled', async () => {
    const policy = resolveCodexProviderConcurrency({
      NANOCLAW_CODEX_PROVIDER_CONCURRENCY: 'limit',
      NANOCLAW_CODEX_PROVIDER_MAX_CONCURRENT: '1',
    });
    const events: string[] = [];
    const callbacks = {
      onWaitStart: () => events.push('wait-b'),
      onWaitEnd: () => events.push('resume-b'),
    };
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = withCodexProviderConcurrency(policy, async () => {
      events.push('start-a');
      markFirstStarted?.();
      await firstCanFinish;
      events.push('end-a');
    });

    await firstStarted;

    const second = withCodexProviderConcurrency(
      policy,
      async () => {
        events.push('start-b');
        events.push('end-b');
      },
      callbacks,
    );

    await delay(10);
    expect(events).toEqual(['start-a', 'wait-b']);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(events).toEqual([
      'start-a',
      'wait-b',
      'end-a',
      'resume-b',
      'start-b',
      'end-b',
    ]);
  });

  it('parses explicit concurrency modes with parallel as the default', () => {
    expect(resolveCodexProviderConcurrency({})).toEqual({ mode: 'parallel' });
    expect(
      resolveCodexProviderConcurrency({
        NANOCLAW_CODEX_PROVIDER_CONCURRENCY: 'limit',
        NANOCLAW_CODEX_PROVIDER_MAX_CONCURRENT: '4',
      }),
    ).toEqual({ mode: 'limit', maxConcurrent: 4 });
    expect(
      resolveCodexProviderConcurrency({
        NANOCLAW_CODEX_PROVIDER_CONCURRENCY: 'global',
      }),
    ).toEqual({ mode: 'global', reason: 'explicit rollback mode' });
  });

  it('keys local guards to shared state rather than provider-wide scheduling', () => {
    expect(
      buildSharedStateKey({
        requestKind: 'provider',
        runtimeId: 'runtime-a',
        sessionId: 'session-a',
      }),
    ).toBeNull();
    expect(
      buildSharedStateKey({
        requestKind: 'transcript',
        runtimeId: 'runtime-a',
      }),
    ).toBe('transcript:runtime-a');
    expect(
      buildSharedStateKey({
        requestKind: 'ipc',
        sessionId: 'session-a',
      }),
    ).toBe('ipc:session-a');
  });
});
