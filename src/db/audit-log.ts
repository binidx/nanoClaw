import { nanoid } from 'nanoid';

import { getCurrentUserId } from '../tenant/tenant-context.js';
import { dba } from './engine-access.js';

export interface AuditLogEntry {
  id: string;
  user_id: string;
  username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  details_json: string | null;
  ip_address: string | null;
  created_at: string;
}

export interface AuditLogInput {
  action: string;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  username?: string;
}

function mapRow(row: unknown): AuditLogEntry {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    user_id: String(r.user_id),
    username: r.username == null ? null : String(r.username),
    action: String(r.action),
    target_type: r.target_type == null ? null : String(r.target_type),
    target_id: r.target_id == null ? null : String(r.target_id),
    target_name: r.target_name == null ? null : String(r.target_name),
    details_json: r.details_json == null ? null : String(r.details_json),
    ip_address: r.ip_address == null ? null : String(r.ip_address),
    created_at: String(r.created_at),
  };
}

export async function recordAuditLog(input: AuditLogInput): Promise<void> {
  const userId = getCurrentUserId();
  const id = nanoid();
  const createdAt = new Date().toISOString();
  const detailsJson =
    input.details !== undefined ? JSON.stringify(input.details) : null;

  await dba
    .prepare(
      `INSERT INTO admin_audit_log (
        id, user_id, username, action, target_type, target_id, target_name, details_json, ip_address, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      input.username ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.targetName ?? null,
      detailsJson,
      input.ipAddress ?? null,
      createdAt,
    );
}

export async function listAuditLogs(
  opts?: {
    page?: number;
    pageSize?: number;
    userId?: string;
    action?: string;
    targetType?: string;
  },
): Promise<{ items: AuditLogEntry[]; total: number }> {
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 20));

  const where: string[] = [];
  const params: unknown[] = [];

  if (opts?.userId) {
    where.push('user_id = ?');
    params.push(opts.userId);
  }
  if (opts?.action) {
    where.push('action = ?');
    params.push(opts.action);
  }
  if (opts?.targetType) {
    where.push('target_type = ?');
    params.push(opts.targetType);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;

  const countRow = (await dba
    .prepare(`SELECT COUNT(*) AS c FROM admin_audit_log ${whereSql}`)
    .get(...params)) as { c: number | string } | undefined;
  const total = Number(countRow?.c ?? 0);

  const rows = (await dba
    .prepare(
      `SELECT id, user_id, username, action, target_type, target_id, target_name, details_json, ip_address, created_at
       FROM admin_audit_log ${whereSql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset)) as unknown[];

  return { items: rows.map(mapRow), total };
}

export async function getAuditLogById(id: string): Promise<AuditLogEntry | null> {
  const row = await dba
    .prepare(
      `SELECT id, user_id, username, action, target_type, target_id, target_name, details_json, ip_address, created_at
       FROM admin_audit_log WHERE id = ?`,
    )
    .get(id);
  if (!row) return null;
  return mapRow(row);
}
