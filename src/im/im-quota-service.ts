import { getConfigValue } from '../config-store.js';
import { dba } from '../db/engine-access.js';

import { isFriend } from './im-friend-service.js';

function periodStartUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getQuotaLimit(): Promise<number> {
  const raw = await getConfigValue('IM_NON_FRIEND_DAILY_LIMIT');
  const n = parseInt(raw || '10', 10);
  if (!Number.isFinite(n) || n < 0) return 10;
  return n;
}

export async function checkQuota(
  senderId: string,
  recipientId: string,
): Promise<{ allowed: boolean; remaining: number }> {
  if (await isFriend(senderId, recipientId)) {
    return { allowed: true, remaining: -1 };
  }
  const limit = await getQuotaLimit();
  const period = periodStartUtcDate();
  const row = (await dba
    .prepare(
      `
    SELECT count FROM im_message_quotas
    WHERE sender_id = ? AND recipient_id = ? AND period_start = ?
    LIMIT 1
  `,
    )
    .get(senderId, recipientId, period)) as { count: number } | undefined;
  const used = Number(row?.count ?? 0);
  const remaining = Math.max(0, limit - used);
  return { allowed: used < limit, remaining };
}

/**
 * Atomically check and consume one quota unit. Returns false if the
 * quota has already been exhausted (no unit consumed).
 */
export async function tryConsumeQuota(
  senderId: string,
  recipientId: string,
): Promise<boolean> {
  if (await isFriend(senderId, recipientId)) return true;
  const limit = await getQuotaLimit();
  const period = periodStartUtcDate();

  let consumed = false;
  const tx = dba.transaction(async () => {
    const row = (await dba
      .prepare(
        `
      SELECT count FROM im_message_quotas
      WHERE sender_id = ? AND recipient_id = ? AND period_start = ?
      LIMIT 1
    `,
      )
      .get(senderId, recipientId, period)) as { count: number } | undefined;
    const used = Number(row?.count ?? 0);
    if (used >= limit) {
      consumed = false;
      return;
    }
    await dba
      .prepare(
        `
      INSERT OR REPLACE INTO im_message_quotas (sender_id, recipient_id, period_start, count)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(senderId, recipientId, period, used + 1);
    consumed = true;
  });
  await tx();
  return consumed;
}
