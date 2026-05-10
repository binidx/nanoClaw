import type { Express, Request } from 'express';

export interface CodeSearchRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

/** Code-search workspace APIs have been deprecated; endpoints are stubbed. */
export function registerCodeSearchRoutes(
  app: Express,
  opts: CodeSearchRouteOptions,
): void {
  const guard = opts.requirePermission('project.view', 'codemap.view');

  app.get('/api/code-search/workspaces', guard, async (_req, res) => {
    res.json({ workspaces: [] });
  });

  app.post('/api/code-search/workspaces/:workspaceId/rebuild', guard, (_req, res) => {
    res.status(410).json({
      error: 'This workspace API has been deprecated',
    });
  });

  app.get('/api/code-search/workspaces/:workspaceId/files', guard, (_req, res) => {
    res.status(410).json({
      error: 'This workspace API has been deprecated',
    });
  });

  app.get(
    '/api/code-search/workspaces/:workspaceId/symbols',
    guard,
    (_req, res) => {
      res.status(410).json({
        error: 'This workspace API has been deprecated',
      });
    },
  );

  app.get(
    '/api/code-search/workspaces/:workspaceId/references',
    guard,
    (_req, res) => {
      res.status(410).json({
        error: 'This workspace API has been deprecated',
      });
    },
  );

  app.get(
    '/api/code-search/workspaces/:workspaceId/related',
    guard,
    (_req, res) => {
      res.status(410).json({
        error: 'This workspace API has been deprecated',
      });
    },
  );
}
