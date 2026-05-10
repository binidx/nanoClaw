import type { RequestHandler } from 'express';

import { getConfigValue } from '../config-store.js';
import {
  getUserById,
  getUserByUsername,
  isMultiUserMode,
  type UserRecord,
} from '../user/user-service.js';
import { evaluate } from './permission-engine.js';
import { isFeatureEnabled } from './web-security.js';

export type LocalCapabilityId = 'terminal' | 'browserControl' | 'localInstall';

export type LocalCapabilityReason =
  | 'disabled'
  | 'single_user'
  | 'unauthenticated'
  | 'inactive_user'
  | 'permission_denied'
  | 'permission_granted';

export interface LocalCapabilityDefinition {
  id: LocalCapabilityId;
  configKey?: string;
  permission: string;
}

export interface LocalCapabilityStatus extends LocalCapabilityDefinition {
  enabled: boolean;
  available: boolean;
  multiUserMode: boolean;
  reason: LocalCapabilityReason;
}

export interface ResolveLocalCapabilityInput {
  username?: string | null;
  userId?: string | null;
  configEnabled?: boolean;
  multiUserMode?: boolean;
}

export type LocalCapabilityStatusMap = Record<
  LocalCapabilityId,
  LocalCapabilityStatus
>;

const LOCAL_CAPABILITY_DEFINITIONS: Record<
  LocalCapabilityId,
  LocalCapabilityDefinition
> = {
  terminal: {
    id: 'terminal',
    configKey: 'WEB_TERMINAL_ENABLED',
    permission: 'terminal.access',
  },
  browserControl: {
    id: 'browserControl',
    configKey: 'WEB_BROWSER_ENABLED',
    permission: 'browser.control',
  },
  localInstall: {
    id: 'localInstall',
    permission: 'local.install',
  },
};

async function resolveConfigEnabled(
  definition: LocalCapabilityDefinition,
  explicit: boolean | undefined,
): Promise<boolean> {
  if (typeof explicit === 'boolean') {
    return explicit;
  }
  if (!definition.configKey) {
    return true;
  }
  return isFeatureEnabled(await getConfigValue(definition.configKey));
}

async function resolveUserRecord(
  input: Pick<ResolveLocalCapabilityInput, 'username' | 'userId'>,
): Promise<UserRecord | null> {
  const userId = input.userId?.trim();
  if (userId) {
    return (await getUserById(userId)) || null;
  }
  const username = input.username?.trim();
  if (username) {
    return (await getUserByUsername(username)) || null;
  }
  return null;
}

function buildStatus(
  definition: LocalCapabilityDefinition,
  input: {
    enabled: boolean;
    multiUserMode: boolean;
    available: boolean;
    reason: LocalCapabilityReason;
  },
): LocalCapabilityStatus {
  return {
    ...definition,
    enabled: input.enabled,
    multiUserMode: input.multiUserMode,
    available: input.available,
    reason: input.reason,
  };
}

export async function resolveLocalCapability(
  capabilityId: LocalCapabilityId,
  input: ResolveLocalCapabilityInput = {},
): Promise<LocalCapabilityStatus> {
  const definition = LOCAL_CAPABILITY_DEFINITIONS[capabilityId];
  const enabled = await resolveConfigEnabled(definition, input.configEnabled);
  const multiUser =
    typeof input.multiUserMode === 'boolean'
      ? input.multiUserMode
      : await isMultiUserMode();

  if (!enabled) {
    return buildStatus(definition, {
      enabled,
      multiUserMode: multiUser,
      available: false,
      reason: 'disabled',
    });
  }

  if (!multiUser) {
    return buildStatus(definition, {
      enabled,
      multiUserMode: multiUser,
      available: true,
      reason: 'single_user',
    });
  }

  const user = await resolveUserRecord(input);
  if (!user) {
    return buildStatus(definition, {
      enabled,
      multiUserMode: multiUser,
      available: false,
      reason: 'unauthenticated',
    });
  }

  if (user.status !== 'active') {
    return buildStatus(definition, {
      enabled,
      multiUserMode: multiUser,
      available: false,
      reason: 'inactive_user',
    });
  }

  const permissionResult = await evaluate(user.id, definition.permission);
  return buildStatus(definition, {
    enabled,
    multiUserMode: multiUser,
    available: permissionResult.allowed,
    reason: permissionResult.allowed ? 'permission_granted' : 'permission_denied',
  });
}

export async function resolveLocalCapabilitiesForUsername(
  username?: string | null,
  input: Partial<
    Record<LocalCapabilityId, Omit<ResolveLocalCapabilityInput, 'username'>>
  > = {},
): Promise<LocalCapabilityStatusMap> {
  return {
    terminal: await resolveLocalCapability('terminal', {
      ...input.terminal,
      username,
    }),
    browserControl: await resolveLocalCapability('browserControl', {
      ...input.browserControl,
      username,
    }),
    localInstall: await resolveLocalCapability('localInstall', {
      ...input.localInstall,
      username,
    }),
  };
}

export async function resolveLocalCapabilityForUserId(
  capabilityId: LocalCapabilityId,
  userId?: string | null,
  input: Omit<ResolveLocalCapabilityInput, 'userId' | 'username'> = {},
): Promise<LocalCapabilityStatus> {
  return resolveLocalCapability(capabilityId, {
    ...input,
    userId,
  });
}

export function getLocalCapabilityHttpStatus(
  status: LocalCapabilityStatus,
): number {
  if (status.reason === 'disabled') {
    return 404;
  }
  if (status.reason === 'unauthenticated') {
    return 401;
  }
  return 403;
}

export function createLocalCapabilityMiddleware(deps: {
  getAuthenticatedUsername: (cookieHeader?: string) => string | null;
}): (capabilityId: LocalCapabilityId) => RequestHandler {
  return (capabilityId) => async (req, res, next) => {
    try {
      const status = await resolveLocalCapability(capabilityId, {
        username: deps.getAuthenticatedUsername(req.headers.cookie),
      });
      if (status.available) {
        next();
        return;
      }
      res.status(getLocalCapabilityHttpStatus(status)).json({
        error: 'Local capability unavailable',
        capability: status.id,
        reason: status.reason,
        permission: status.permission,
      });
    } catch (err) {
      next(err);
    }
  };
}
