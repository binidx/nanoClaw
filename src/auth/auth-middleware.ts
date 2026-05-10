import type { Request, Response, NextFunction } from 'express';

import {
  getUserByUsername,
  isMultiUserMode,
} from '../user/user-service.js';
import {
  evaluate,
  evaluateAny,
  type ResourceContext,
} from './permission-engine.js';

export type RequirePermissionFn = (
  ...codes: string[]
) => (req: Request, res: Response, next: NextFunction) => Promise<void>;

export interface PermissionMiddlewareDeps {
  getAuthenticatedUsername: (cookieHeader?: string) => string | null;
}

export function createPermissionMiddleware(deps: PermissionMiddlewareDeps) {
  function requirePermission(...codes: string[]) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const username = deps.getAuthenticatedUsername(req.headers.cookie);
      if (!username) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const multiUser = await isMultiUserMode();
      if (!multiUser) {
        next();
        return;
      }

      const user = await getUserByUsername(username);
      if (!user || user.status !== 'active') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (codes.length === 1) {
        const result = await evaluate(user.id, codes[0]);
        if (!result.allowed) {
          res.status(403).json({ error: 'Forbidden', required: codes[0], reason: result.reason });
          return;
        }
      } else {
        const result = await evaluateAny(user.id, codes);
        if (!result.allowed) {
          res.status(403).json({ error: 'Forbidden', required: codes, reason: result.reason });
          return;
        }
      }

      next();
    };
  }

  function requireAccess(
    action: string,
    extractResource?: (req: Request) => ResourceContext | undefined,
  ) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const username = deps.getAuthenticatedUsername(req.headers.cookie);
      if (!username) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const multiUser = await isMultiUserMode();
      if (!multiUser) {
        next();
        return;
      }

      const user = await getUserByUsername(username);
      if (!user || user.status !== 'active') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const resource = extractResource?.(req);
      const result = await evaluate(user.id, action, resource);
      if (!result.allowed) {
        res.status(403).json({ error: 'Forbidden', required: action, reason: result.reason });
        return;
      }

      next();
    };
  }

  return { requirePermission, requireAccess };
}
