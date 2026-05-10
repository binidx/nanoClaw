export type CodexProviderConcurrencyMode =
  | { mode: 'parallel' }
  | { mode: 'limit'; maxConcurrent: number }
  | { mode: 'global'; reason?: string };

export interface CodexProviderConcurrencyCallbacks {
  onWaitStart?: () => void;
  onWaitEnd?: () => void;
}

type SharedStateRequestKind = 'transcript' | 'ipc' | 'provider';

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async acquire(
    callbacks: CodexProviderConcurrencyCallbacks = {},
  ): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return this.createRelease();
    }

    callbacks.onWaitStart?.();
    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        callbacks.onWaitEnd?.();
        resolve();
      });
    });

    return this.createRelease();
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.flush();
    };
  }

  private flush(): void {
    if (this.active >= this.maxConcurrent) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active += 1;
    next();
  }
}

const globalSemaphore = new Semaphore(1);
const limitSemaphores = new Map<number, Semaphore>();

function parsePositiveInteger(value: string | undefined): number | null {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function resolveCodexProviderConcurrency(
  env: NodeJS.ProcessEnv,
): CodexProviderConcurrencyMode {
  const rawMode = String(
    env.NANOCLAW_CODEX_PROVIDER_CONCURRENCY || 'parallel',
  )
    .trim()
    .toLowerCase();

  if (rawMode === 'global') {
    return { mode: 'global', reason: 'explicit rollback mode' };
  }

  if (rawMode === 'limit') {
    return {
      mode: 'limit',
      maxConcurrent:
        parsePositiveInteger(env.NANOCLAW_CODEX_PROVIDER_MAX_CONCURRENT) || 1,
    };
  }

  return { mode: 'parallel' };
}

function getSemaphoreForPolicy(
  policy: CodexProviderConcurrencyMode,
): Semaphore | null {
  if (policy.mode === 'parallel') return null;
  if (policy.mode === 'global') return globalSemaphore;
  let semaphore = limitSemaphores.get(policy.maxConcurrent);
  if (!semaphore) {
    semaphore = new Semaphore(policy.maxConcurrent);
    limitSemaphores.set(policy.maxConcurrent, semaphore);
  }
  return semaphore;
}

export async function acquireCodexProviderConcurrencySlot(
  policy: CodexProviderConcurrencyMode,
  callbacks: CodexProviderConcurrencyCallbacks = {},
): Promise<() => void> {
  const semaphore = getSemaphoreForPolicy(policy);
  if (!semaphore) return () => {};
  return semaphore.acquire(callbacks);
}

export async function withCodexProviderConcurrency<T>(
  policy: CodexProviderConcurrencyMode,
  fn: () => Promise<T>,
  callbacks: CodexProviderConcurrencyCallbacks = {},
): Promise<T> {
  const release = await acquireCodexProviderConcurrencySlot(policy, callbacks);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function buildSharedStateKey(input: {
  sessionId?: string;
  runtimeId?: string;
  requestKind: SharedStateRequestKind;
}): string | null {
  if (input.requestKind === 'provider') return null;
  return `${input.requestKind}:${input.runtimeId || input.sessionId || 'ephemeral'}`;
}
