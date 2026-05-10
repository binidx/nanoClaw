import type { Request } from 'express';
import { SYSTEM_USER_ID } from './tenant-context.js';

export function getTenantUserId(req: Request): string {
  return (req as Request & { tenantUserId?: string }).tenantUserId ?? SYSTEM_USER_ID;
}
