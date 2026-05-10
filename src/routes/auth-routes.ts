import type { Express, Request } from 'express';

import {
  AUTH_COOKIE_NAME,
  parseCookies,
  serializeAuthCookie,
  serializeExpiredAuthCookie,
} from '../auth/web-auth.js';
import {
  createUser,
  ensureUserByUsername,
  ensureUserFromLdap,
  LdapLocalConflictError,
  getUserByUsername,
  getUserRoleNames,
  isMultiUserMode,
  validateCredentials,
} from '../user/user-service.js';
import { getUserEffectivePermissions } from '../auth/permission-engine.js';
import {
  authenticateLdap,
  getLdapDefaultRole,
  isLdapEnabled,
  isLdapFallbackLocal,
} from '../auth/ldap-auth.js';
import { createModuleLogger } from '../logger.js';
import { t } from '../i18n/index.js';

const authLog = createModuleLogger('auth');

function clientIpFromRequest(req: Request): string {
  return req.get('x-forwarded-for') || req.ip || '';
}

function shouldSetSecureCookie(req: Request): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === 'false') return false;
  if (override === 'true') return true;
  if (process.env.NODE_ENV !== 'production') return false;
  const clientOrigin = (req.headers.origin || req.headers.referer || '') as string;
  if (clientOrigin.startsWith('http://')) return false;
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

type LoginThrottleStore = {
  isBlocked: (key: string) => {
    blocked: boolean;
    retryAfterMs: number;
  };
  recordFailure: (key: string) => {
    blocked: boolean;
    retryAfterMs: number;
  };
  reset: (key: string) => void;
};

type SessionStore = {
  create: (username: string) => { token: string };
  revoke: (token?: string) => void;
};

export interface AuthRouteOptions {
  loginThrottle: LoginThrottleStore;
  authSessions: SessionStore;
  isLoginEnabled: () => boolean;
  isRegistrationEnabled: () => boolean;
  isAuthenticatedRequest: (req: Request) => boolean;
  getRequestClientKey: (req: Request) => string;
  getLoginCredentials: () => {
    username: string;
    password: string;
    bootstrapMode: boolean;
    weakCredentials: boolean;
  };
  getAuthenticatedUsername: (cookieHeader?: string) => string | null;
}

export function registerAuthRoutes(app: Express, opts: AuthRouteOptions): void {
  app.post('/api/auth/login', async (req, res) => {
    if (!opts.isLoginEnabled()) {
      res.json({ ok: true, username: null, loginEnabled: false });
      return;
    }

    const clientKey = opts.getRequestClientKey(req);
    const throttleState = opts.loginThrottle.isBlocked(clientKey);
    if (throttleState.blocked) {
      res.setHeader(
        'Retry-After',
        String(Math.ceil(throttleState.retryAfterMs / 1000)),
      );
      res
        .status(429)
        .json({ ok: false, error: t('auth.tooManyFailures', {}, req.locale) });
      return;
    }

    const { username, password } = req.body as {
      username?: string;
      password?: string;
    };

    const clientIp = clientIpFromRequest(req);
    let localAuthMethod: 'local' | 'ldap-fallback-local' = 'local';

    if (!username || !password) {
      authLog.warn(
        { username: username || '', clientIp, authMethod: 'unknown' },
        'Login failed: missing credentials',
      );
      res.status(401).json({ ok: false, error: t('auth.invalidCredentials', {}, req.locale) });
      return;
    }

    // --- LDAP authentication (priority over local) ---
    const ldapEnabled = await isLdapEnabled();
    if (ldapEnabled) {
      const ldapResult = await authenticateLdap(username, password);
      if (ldapResult) {
        try {
          const defaultRole = await getLdapDefaultRole();
          const result = await ensureUserFromLdap({
            ...ldapResult,
            defaultRole: defaultRole || undefined,
          });
          opts.loginThrottle.reset(clientKey);
          const session = opts.authSessions.create(result.username);
          const isSecure = shouldSetSecureCookie(req);
          res.setHeader('Set-Cookie', serializeAuthCookie(session.token, isSecure));
          authLog.info(
            {
              username: result.username,
              clientIp,
              authMethod: 'ldap',
            },
            'Login succeeded',
          );
          res.json({
            ok: true,
            username: result.username,
            userId: result.userId,
            displayName: result.displayName,
            roles: result.roles,
            permissions: result.permissions,
            multiUserMode: true,
            bootstrapMode: false,
            weakCredentials: false,
            ldapAuthenticated: true,
          });
          return;
        } catch (err) {
          if (err instanceof LdapLocalConflictError) {
            authLog.warn(
              { username, clientIp, authMethod: 'ldap' },
              'Login failed: LDAP username conflicts with local account',
            );
            res.status(409).json({
              ok: false,
              error: t('auth.ldapLocalConflict', {}, req.locale),
            });
            return;
          }
          throw err;
        }
      }

      const fallback = await isLdapFallbackLocal();
      if (!fallback) {
        const failureState = opts.loginThrottle.recordFailure(clientKey);
        if (failureState.blocked) {
          res.setHeader(
            'Retry-After',
            String(Math.ceil(failureState.retryAfterMs / 1000)),
          );
          res
            .status(429)
            .json({ ok: false, error: t('auth.tooManyFailures', {}, req.locale) });
          return;
        }
        authLog.warn(
          { username, clientIp, authMethod: 'ldap' },
          'Login failed: LDAP authentication failed',
        );
        res.status(401).json({ ok: false, error: t('auth.ldapFailed', {}, req.locale) });
        return;
      }
      localAuthMethod = 'ldap-fallback-local';
      authLog.debug(
        { username, clientIp, authMethod: localAuthMethod },
        'LDAP auth failed, falling back to local',
      );
    }

    // --- Local authentication ---
    const multiUser = await isMultiUserMode();

    if (multiUser) {
      const result = await validateCredentials(username, password);
      if (!result) {
        const failureState = opts.loginThrottle.recordFailure(clientKey);
        if (failureState.blocked) {
          res.setHeader(
            'Retry-After',
            String(Math.ceil(failureState.retryAfterMs / 1000)),
          );
          res
            .status(429)
            .json({ ok: false, error: t('auth.tooManyFailures', {}, req.locale) });
          return;
        }
        authLog.warn(
          { username, clientIp, authMethod: localAuthMethod },
          'Login failed: invalid local credentials',
        );
        res.status(401).json({ ok: false, error: t('auth.invalidCredentials', {}, req.locale) });
        return;
      }

      opts.loginThrottle.reset(clientKey);
      const session = opts.authSessions.create(result.username);
      const isSecure = shouldSetSecureCookie(req);
      const cookie = serializeAuthCookie(session.token, isSecure);
      authLog.debug(
        {
          username: result.username,
          clientIp,
          authMethod: localAuthMethod,
          secureCookie: isSecure,
          cookieOverride: process.env.COOKIE_SECURE,
          xForwardedProto: req.headers['x-forwarded-proto'],
          origin: req.headers.origin,
          referer: req.headers.referer,
        },
        'Login cookie debug',
      );
      authLog.info(
        {
          username: result.username,
          clientIp,
          authMethod: localAuthMethod,
        },
        'Login succeeded',
      );
      res.setHeader('Set-Cookie', cookie);
      res.json({
        ok: true,
        username: result.username,
        userId: result.userId,
        displayName: result.displayName,
        roles: result.roles,
        permissions: result.permissions,
        multiUserMode: true,
        bootstrapMode: false,
        weakCredentials: false,
      });
      return;
    }

    const credentials = opts.getLoginCredentials();
    if (
      username !== credentials.username ||
      password !== credentials.password
    ) {
      const failureState = opts.loginThrottle.recordFailure(clientKey);
      if (failureState.blocked) {
        res.setHeader(
          'Retry-After',
          String(Math.ceil(failureState.retryAfterMs / 1000)),
        );
        res
          .status(429)
          .json({ ok: false, error: t('auth.tooManyFailures', {}, req.locale) });
        return;
      }
      authLog.warn(
        { username, clientIp, authMethod: 'local' },
        'Login failed: invalid single-user credentials',
      );
      res.status(401).json({ ok: false, error: t('auth.invalidCredentials', {}, req.locale) });
      return;
    }

    opts.loginThrottle.reset(clientKey);
    await ensureUserByUsername(credentials.username);
    const session = opts.authSessions.create(credentials.username);
    const isSecure = shouldSetSecureCookie(req);
    const cookie = serializeAuthCookie(session.token, isSecure);
    authLog.debug(
      {
        username: credentials.username,
        clientIp,
        authMethod: 'local',
        secureCookie: isSecure,
        cookieOverride: process.env.COOKIE_SECURE,
        xForwardedProto: req.headers['x-forwarded-proto'],
        origin: req.headers.origin,
        referer: req.headers.referer,
      },
      'Login cookie debug',
    );
    authLog.info(
      {
        username: credentials.username,
        clientIp,
        authMethod: 'local',
      },
      'Login succeeded',
    );
    res.setHeader('Set-Cookie', cookie);
    res.json({
      ok: true,
      username: credentials.username,
      bootstrapMode: credentials.bootstrapMode,
      weakCredentials: credentials.weakCredentials,
      multiUserMode: false,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const clientIp = clientIpFromRequest(req);
    const username =
      opts.getAuthenticatedUsername(req.headers.cookie) ?? '(unknown)';
    const cookies = parseCookies(req.headers.cookie);
    opts.authSessions.revoke(cookies[AUTH_COOKIE_NAME]);
    const isSecure = shouldSetSecureCookie(req);
    res.setHeader('Set-Cookie', serializeExpiredAuthCookie(isSecure));
    authLog.info({ username, clientIp }, 'Logout');
    res.json({ ok: true });
  });

  app.get('/api/auth/status', async (req, res) => {
    const loginEnabled = opts.isLoginEnabled();
    const authenticated = opts.isAuthenticatedRequest(req);
    const multiUser = await isMultiUserMode();
    const ldapEnabled = await isLdapEnabled();

    const username =
      authenticated && loginEnabled
        ? opts.getAuthenticatedUsername(req.headers.cookie)
        : null;

    let userId: string | null = null;
    let displayName: string | null = null;
    let roles: string[] = [];
    let permissions: string[] = [];

    if (authenticated && (multiUser || ldapEnabled) && username) {
      const user = await getUserByUsername(username);
      if (user) {
        userId = user.id;
        displayName = user.display_name;
        roles = await getUserRoleNames(user.id);
        permissions = await getUserEffectivePermissions(user.id);
      }
    }

    const credentials =
      loginEnabled && !multiUser && !ldapEnabled
        ? opts.getLoginCredentials()
        : null;

    res.json({
      authenticated,
      username,
      loginEnabled,
      ldapEnabled,
      registrationEnabled: opts.isRegistrationEnabled(),
      multiUserMode: multiUser,
      userId,
      displayName,
      roles,
      permissions,
      loginUsername: credentials?.username || (multiUser || ldapEnabled ? '' : 'admin'),
      bootstrapMode: credentials?.bootstrapMode || false,
      weakCredentials: credentials?.weakCredentials || false,
    });
  });

  app.post('/api/auth/register', async (req, res) => {
    try {
      if (!opts.isRegistrationEnabled()) {
        res.status(403).json({ ok: false, error: t('auth.registrationDisabled', {}, req.locale) });
        return;
      }

      const { username, password, displayName, email } = req.body as {
        username?: string;
        password?: string;
        displayName?: string;
        email?: string;
      };

      if (!username || !password) {
        res.status(400).json({ ok: false, error: t('auth.usernameAndPasswordRequired', {}, req.locale) });
        return;
      }
      if (username.length < 2 || username.length > 64) {
        res.status(400).json({ ok: false, error: t('auth.usernameLength', {}, req.locale) });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ ok: false, error: t('auth.passwordMinLength', {}, req.locale) });
        return;
      }
      if (/^(.)\1+$/.test(password) || /^(012|123|234|345|456|567|678|789|abc|password|admin)/i.test(password)) {
        res.status(400).json({ ok: false, error: t('auth.passwordTooWeak', {}, req.locale) });
        return;
      }

      const existing = await getUserByUsername(username);
      if (existing) {
        res.status(409).json({ ok: false, error: t('auth.usernameExists', {}, req.locale) });
        return;
      }

      const user = await createUser({
        username,
        password,
        displayName: displayName || username,
        email: email || undefined,
      });

      const session = opts.authSessions.create(user.username);
      const isSecure = shouldSetSecureCookie(req);
      res.setHeader('Set-Cookie', serializeAuthCookie(session.token, isSecure));

      res.json({
        ok: true,
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
      });
    } catch (err) {
      const clientIp = clientIpFromRequest(req);
      const attemptedUsername =
        (req.body as { username?: string })?.username ?? '';
      authLog.error(
        { err, username: attemptedUsername, clientIp },
        'Registration failed',
      );
      res.status(500).json({ ok: false, error: t('auth.registrationFailed', {}, req.locale) });
    }
  });
}
