export function isFeatureEnabled(value: string | undefined | null): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return (
    normalized === 'true' ||
    normalized === '1' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

export function isTrustedRequestOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return true;
  if (!host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function normalizeSingleIp(value: string | undefined | null): string | null {
  const normalized = (value || '').trim();
  return normalized ? normalized : null;
}

function getForwardedClientIp(
  forwardedFor: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (!raw) return null;
  const first = raw.split(',')[0];
  return normalizeSingleIp(first);
}

export function isLoopbackAddress(
  address: string | undefined | null,
): boolean {
  const normalized = normalizeSingleIp(address);
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1'
  );
}

export function getRequestClientAddress(input: {
  ip?: string | null;
  socketRemoteAddress?: string | null;
  forwardedFor?: string | string[];
}): string {
  const socketRemoteAddress = normalizeSingleIp(input.socketRemoteAddress);
  const requestIp = normalizeSingleIp(input.ip);
  const forwardedClientIp = getForwardedClientIp(input.forwardedFor);

  if (isLoopbackAddress(socketRemoteAddress) && forwardedClientIp) {
    return forwardedClientIp;
  }

  return requestIp || socketRemoteAddress || forwardedClientIp || 'unknown';
}

interface LoginAttemptState {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

export interface LoginThrottleStore {
  isBlocked(key: string): { blocked: boolean; retryAfterMs: number };
  recordFailure(key: string): { blocked: boolean; retryAfterMs: number };
  reset(key: string): void;
}

export function createLoginThrottleStore(
  now: () => number = () => Date.now(),
  options: {
    maxAttempts?: number;
    windowMs?: number;
    blockMs?: number;
  } = {},
): LoginThrottleStore {
  const maxAttempts = options.maxAttempts ?? 8;
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const blockMs = options.blockMs ?? 15 * 60 * 1000;
  const attempts = new Map<string, LoginAttemptState>();

  function getActiveState(key: string): LoginAttemptState | undefined {
    const state = attempts.get(key);
    if (!state) return undefined;

    const current = now();
    if (state.blockedUntil > current) return state;
    if (state.blockedUntil > 0 && state.blockedUntil <= current) {
      attempts.delete(key);
      return undefined;
    }
    if (current - state.firstFailureAt > windowMs) {
      attempts.delete(key);
      return undefined;
    }
    return state;
  }

  return {
    isBlocked(key: string) {
      const state = getActiveState(key);
      if (!state || state.blockedUntil <= 0) {
        return { blocked: false, retryAfterMs: 0 };
      }
      return {
        blocked: true,
        retryAfterMs: Math.max(0, state.blockedUntil - now()),
      };
    },
    recordFailure(key: string) {
      const current = now();
      const state = getActiveState(key);
      const next: LoginAttemptState = state
        ? { ...state, failures: state.failures + 1 }
        : { failures: 1, firstFailureAt: current, blockedUntil: 0 };
      if (next.failures >= maxAttempts) {
        next.blockedUntil = current + blockMs;
      }
      attempts.set(key, next);
      return {
        blocked: next.blockedUntil > current,
        retryAfterMs:
          next.blockedUntil > current ? next.blockedUntil - current : 0,
      };
    },
    reset(key: string) {
      attempts.delete(key);
    },
  };
}
