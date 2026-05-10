import type { Request } from 'express';

import { recordAuditLog } from '../db/audit-log.js';

export async function auditAdminAction(
  req: Request,
  action: string,
  opts?: {
    targetType?: string;
    targetId?: string;
    targetName?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const username =
    (req as { authenticatedUsername?: string }).authenticatedUsername ||
    undefined;
  const ipAddress = req.ip || req.socket?.remoteAddress || undefined;
  await recordAuditLog({
    action,
    username,
    ipAddress,
    ...opts,
  });
}

export const AUDIT_ACTIONS = {
  PROVIDER_CREATE: 'provider.create',
  PROVIDER_UPDATE: 'provider.update',
  PROVIDER_DELETE: 'provider.delete',
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',
  USER_ROLE_ASSIGN: 'user.role.assign',
  USER_ROLE_REMOVE: 'user.role.remove',
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_DELETE: 'role.delete',
  ASSISTANT_CREATE: 'assistant.create',
  ASSISTANT_UPDATE: 'assistant.update',
  ASSISTANT_DELETE: 'assistant.delete',
  KB_CREATE: 'knowledge_base.create',
  KB_DELETE: 'knowledge_base.delete',
  CHANNEL_CREATE: 'channel.create',
  CHANNEL_DELETE: 'channel.delete',
  TRASH_RESTORE: 'trash.restore',
  TRASH_PURGE: 'trash.purge',
} as const;
