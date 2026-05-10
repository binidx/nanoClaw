import { DEFAULTS } from '../config-store.js';
import { getStartupConfigValue } from '../config.js';
import {
  AUTH_COOKIE_NAME,
  type SessionStore,
  createSessionStore,
  parseCookies,
} from './web-auth.js';
import {
  createLoginThrottleStore,
  getRequestClientAddress,
  isFeatureEnabled,
} from './web-security.js';

export function createWebAuthRuntime(
  deps: {
    getConfigEntry?: (key: string) => string | undefined;
    getConfigValueEntry?: (key: string) => string;
    readEnvEntries?: (keys: string[]) => Record<string, string | undefined>;
    env?: NodeJS.ProcessEnv;
    logger?: { warn: (obj: object, msg: string) => void };
    authSessions?: SessionStore;
    loginThrottle?: ReturnType<typeof createLoginThrottleStore>;
  } = {},
) {
  let authSessions: SessionStore = deps.authSessions || createSessionStore();
  const loginThrottle = deps.loginThrottle || createLoginThrottleStore();

  function getRawConfigValue(key: string): string {
    const custom = deps.getConfigEntry?.(key);
    if (custom !== undefined) return custom;
    if (deps.getConfigValueEntry) {
      return deps.getConfigValueEntry(key) || DEFAULTS[key] || '';
    }
    const fromDb = getStartupConfigValue(key);
    if (fromDb !== '') return fromDb;
    return DEFAULTS[key] || '';
  }

  function getLoginCredentials(): {
    username: string;
    password: string;
    bootstrapMode: boolean;
    weakCredentials: boolean;
  } {
    const configuredUsername =
      getRawConfigValue('WEB_LOGIN_USERNAME').trim();
    const configuredPassword =
      getRawConfigValue('WEB_LOGIN_PASSWORD').trim();

    const username = configuredUsername || 'admin';
    const password = configuredPassword || 'admin123';

    if (isLoginEnabled() && (!configuredUsername || !configuredPassword)) {
      deps.logger?.warn(
        { missingUsername: !configuredUsername, missingPassword: !configuredPassword },
        'WEB_LOGIN_ENABLED=true but credentials are empty or missing; falling back to default credentials. ' +
        'Set WEB_LOGIN_USERNAME and WEB_LOGIN_PASSWORD to secure your instance.',
      );
    }

    return {
      username,
      password,
      bootstrapMode: false,
      weakCredentials: username === 'admin' && password === 'admin123',
    };
  }

  function clearBootstrapCredentials(): void {
    // Preserved for API compatibility with existing callers/tests.
  }

  function getAuthenticatedUsername(cookieHeader?: string): string | null {
    const cookies = parseCookies(cookieHeader);
    return authSessions.get(cookies[AUTH_COOKIE_NAME])?.username || null;
  }

  function isLoginEnabled(): boolean {
    const value = (
      getRawConfigValue('WEB_LOGIN_ENABLED') || 'true'
    ).toLowerCase();
    return value !== 'false' && value !== '0' && value !== 'off';
  }

  function isRegistrationEnabled(): boolean {
    return isFeatureEnabled(getRawConfigValue('WEB_REGISTRATION_ENABLED'));
  }

  function isWebTerminalEnabled(): boolean {
    return isFeatureEnabled(getRawConfigValue('WEB_TERMINAL_ENABLED'));
  }

  function isStockAnalysisEnabled(): boolean {
    return isFeatureEnabled(getRawConfigValue('WEB_STOCK_ANALYSIS_ENABLED'));
  }

  function getRequestClientKey(
    req: Pick<import('express').Request, 'ip' | 'headers' | 'socket'>,
  ): string {
    return getRequestClientAddress({
      ip: req.ip,
      socketRemoteAddress: req.socket.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'],
    });
  }

  function isAuthenticatedRequest(req: import('express').Request): boolean {
    if (!isLoginEnabled()) return true;
    return getAuthenticatedUsername(req.headers.cookie) !== null;
  }

  function replaceSessionStore(newStore: SessionStore): void {
    authSessions = newStore;
  }

  return {
    get authSessions() { return authSessions; },
    loginThrottle,
    getRawConfigValue,
    getLoginCredentials,
    clearBootstrapCredentials,
    getAuthenticatedUsername,
    isLoginEnabled,
    isRegistrationEnabled,
    isStockAnalysisEnabled,
    isWebTerminalEnabled,
    getRequestClientKey,
    isAuthenticatedRequest,
    replaceSessionStore,
  };
}
