import { describe, expect, it, vi, beforeEach } from 'vitest';

import { _initTestDatabase } from '../db.js';
import { dba } from '../db/engine-access.js';
import { runWithTenantAsync } from '../tenant/tenant-context.js';
import { recordAuditLog } from '../db/audit-log.js';
import { createAuditMutation } from '../web/web-server-support.js';

describe('audit mutation persistence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('writes protected mutation audit records to admin_audit_log', async () => {
    const info = vi.fn();
    const auditMutation = createAuditMutation({
      logger: { info },
      getAuthenticatedUsername: () => 'alice',
      getRequestClientKey: () => 'client-key',
      recordAuditLog,
    });

    await runWithTenantAsync({ userId: 'user-audit' }, async () => {
      auditMutation(
        {
          headers: { cookie: 'auth=token' },
          method: 'POST',
          path: '/api/resource-bindings',
          ip: '127.0.0.9',
          socket: { remoteAddress: '127.0.0.10' },
        } as any,
        'resource_binding.create',
        'high',
      );
    });

    await vi.waitFor(() => {
      return dba
        .prepare(`SELECT COUNT(*) AS c FROM admin_audit_log`)
        .get()
        .then((row) => {
          expect((row as { c: number }).c).toBe(1);
        });
    });

    const row = (await dba
      .prepare(
        `SELECT user_id, username, action, details_json, ip_address FROM admin_audit_log LIMIT 1`,
      )
      .get()) as {
      user_id: string;
      username: string;
      action: string;
      details_json: string;
      ip_address: string;
    };
    expect(row).toMatchObject({
      user_id: 'user-audit',
      username: 'alice',
      action: 'resource_binding.create',
      ip_address: '127.0.0.9',
    });
    expect(JSON.parse(row.details_json)).toEqual({
      risk: 'high',
      method: 'POST',
      path: '/api/resource-bindings',
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'resource_binding.create',
        risk: 'high',
        actor: 'alice',
      }),
      'Protected mutation request',
    );
  });
});
