import crypto from 'crypto';

import { createModuleLogger } from '../logger.js';

const authLog = createModuleLogger('auth');

export const AUTH_COOKIE_NAME = 'nanoclaw_auth';
export const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface AuthSession {
  token: string;
  username: string;
  expiresAt: number;
}

export interface SessionStore {
  create(username: string): AuthSession;
  get(token?: string): AuthSession | undefined;
  revoke(token?: string): void;
  revokeAll(): void;
  size(): number;
}

export function parseCookies(cookieHeader?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) continue;
    cookies[decodeURIComponent(rawKey)] = decodeURIComponent(
      rest.join('=') || '',
    );
  }
  return cookies;
}

export function createSessionStore(now: () => number = () => Date.now()): SessionStore {
  const sessions = new Map<string, AuthSession>();
  const PURGE_INTERVAL_MS = 5 * 60 * 1000;
  let nextPurgeAt = 0;

  function purgeExpired(force = false): void {
    const currentTime = now();
    if (!force && currentTime < nextPurgeAt) {
      return;
    }
    nextPurgeAt = currentTime + PURGE_INTERVAL_MS;
    for (const [token, session] of sessions) {
      if (session.expiresAt <= currentTime) {
        sessions.delete(token);
      }
    }
  }

  return {
    create(username: string): AuthSession {
      purgeExpired();
      const token = crypto.randomBytes(32).toString('hex');
      const session = {
        token,
        username,
        expiresAt: now() + AUTH_SESSION_TTL_MS,
      };
      sessions.set(token, session);
      return session;
    },
    get(token?: string): AuthSession | undefined {
      if (!token) return undefined;
      const session = sessions.get(token);
      if (!session) return undefined;
      if (session.expiresAt <= now()) {
        sessions.delete(token);
        return undefined;
      }
      return session;
    },
    revoke(token?: string): void {
      if (!token) return;
      sessions.delete(token);
    },
    revokeAll(): void {
      sessions.clear();
      nextPurgeAt = 0;
    },
    size(): number {
      purgeExpired(true);
      return sessions.size;
    },
  };
}

/**
 * Async persistence layer for auth sessions.
 * All methods are fire-and-forget from the caller's perspective;
 * the write-through cache keeps reads synchronous.
 */
export interface DbSessionPersistence {
  insertSession(token: string, username: string, expiresAtIso: string): Promise<void>;
  deleteSession(token: string): Promise<void>;
  deleteAllSessions(): Promise<void>;
  deleteExpiredSessions(nowIso: string): Promise<void>;
  loadAllSessions(): Promise<Array<{ token: string; username: string; expires_at: string }>>;
}

/**
 * Write-through session store: in-memory Map for fast synchronous reads,
 * async DB writes for persistence across restarts.
 * Call `loadFromDb()` once at startup before serving requests.
 */
export function createDatabaseSessionStore(
  persistence: DbSessionPersistence,
  now: () => number = () => Date.now(),
): SessionStore & { loadFromDb(): Promise<void> } {
  const sessions = new Map<string, AuthSession>();
  const PURGE_INTERVAL_MS = 5 * 60 * 1000;
  let nextPurgeAt = 0;

  function purgeExpired(force = false): void {
    const currentTime = now();
    if (!force && currentTime < nextPurgeAt) return;
    nextPurgeAt = currentTime + PURGE_INTERVAL_MS;
    for (const [token, session] of sessions) {
      if (session.expiresAt <= currentTime) {
        sessions.delete(token);
      }
    }
    persistence.deleteExpiredSessions(new Date(currentTime).toISOString()).catch((err) => {
      authLog.debug({ err }, 'Failed to delete expired sessions from DB');
    });
  }

  return {
    async loadFromDb(): Promise<void> {
      const currentTime = now();
      const rows = await persistence.loadAllSessions();
      for (const row of rows) {
        const expiresAt = new Date(row.expires_at).getTime();
        if (expiresAt > currentTime) {
          sessions.set(row.token, { token: row.token, username: row.username, expiresAt });
        }
      }
      await persistence.deleteExpiredSessions(new Date(currentTime).toISOString());
    },
    create(username: string): AuthSession {
      purgeExpired();
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = now() + AUTH_SESSION_TTL_MS;
      const session: AuthSession = { token, username, expiresAt };
      sessions.set(token, session);
      persistence.insertSession(token, username, new Date(expiresAt).toISOString()).catch((err) => {
        authLog.debug({ err }, 'Failed to persist new session to DB');
      });
      return session;
    },
    get(token?: string): AuthSession | undefined {
      if (!token) return undefined;
      const session = sessions.get(token);
      if (!session) return undefined;
      if (session.expiresAt <= now()) {
        sessions.delete(token);
        persistence.deleteSession(token).catch((err) => {
          authLog.debug({ err }, 'Failed to delete expired session from DB');
        });
        return undefined;
      }
      return session;
    },
    revoke(token?: string): void {
      if (!token) return;
      sessions.delete(token);
      persistence.deleteSession(token).catch((err) => {
        authLog.debug({ err }, 'Failed to delete revoked session from DB');
      });
    },
    revokeAll(): void {
      sessions.clear();
      nextPurgeAt = 0;
      persistence.deleteAllSessions().catch((err) => {
        authLog.debug({ err }, 'Failed to delete all sessions from DB');
      });
    },
    size(): number {
      purgeExpired(true);
      return sessions.size;
    },
  };
}

export function serializeAuthCookie(token: string, secure: boolean): string {
  return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    AUTH_SESSION_TTL_MS / 1000,
  )}${secure ? '; Secure' : ''}`;
}

export function serializeExpiredAuthCookie(secure: boolean): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
