import { describe, expect, it, vi } from 'vitest';

import { startNonOverlappingBackgroundLoop } from './background-loop.js';

describe('startNonOverlappingBackgroundLoop', () => {
  it('does not start a second run while the previous run is active', async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | null = null;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const loop = startNonOverlappingBackgroundLoop({
      name: 'test-loop',
      intervalMs: 1000,
      task,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);

    loop.stop();
    vi.useRealTimers();
  });
});
