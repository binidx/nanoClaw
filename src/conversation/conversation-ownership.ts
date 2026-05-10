import { getActiveEngine } from '../database/engine.js';
import { logger } from '../logger.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { userHasPermission } from '../user/user-service.js';
import { hasResourceAccess } from '../auth/permission-engine.js';

export class ConversationOwnershipError extends Error {
  public readonly statusCode = 403;
  constructor(jid: string) {
    super(`Forbidden: you do not own conversation ${jid}`);
    this.name = 'ConversationOwnershipError';
  }
}

const PERM_CONVERSATION_MANAGE = 'conversation.manage';

async function isReviewBoundConversation(jid: string): Promise<boolean> {
  const eng = getActiveEngine();
  const row = await eng.queryOne(
    'SELECT 1 FROM review_conversation_bindings WHERE chat_jid = ? LIMIT 1',
    [jid],
  );
  return !!row;
}

async function isReviewConversationMember(
  jid: string,
  userId: string,
): Promise<boolean> {
  const eng = getActiveEngine();
  const row = await eng.queryOne(
    `SELECT 1 FROM review_conversation_bindings rcb
     JOIN review_repository_members rrm ON rcb.repository_id = rrm.repository_id
     WHERE rcb.chat_jid = ? AND rrm.user_id = ? LIMIT 1`,
    [jid, userId],
  );
  return !!row;
}

async function hasConversationResourceAccess(
  jid: string,
  userId: string,
): Promise<boolean> {
  if (await hasResourceAccess(userId, 'conversation', jid)) return true;

  const eng = getActiveEngine();
  const binding = await eng.queryOne<{ repository_id: string }>(
    'SELECT repository_id FROM review_conversation_bindings WHERE chat_jid = ? LIMIT 1',
    [jid],
  );
  if (binding) {
    return hasResourceAccess(userId, 'review_repository', binding.repository_id);
  }
  return false;
}

/**
 * Read-access check: can the user see / interact with this conversation?
 *
 * 1. System caller → pass.
 * 2. Chat row not found → pass (first-write).
 * 3. Owner match → pass.
 * 4. resource_access ACL grant → pass.
 * 5. `__system__`-owned, not bound to any review repo → pass (public).
 * 6. Review repo member → pass.
 * 7. Deny.
 */
export async function assertConversationOwnership(
  jid: string,
  tenantUserId: string,
): Promise<void> {
  if (tenantUserId === SYSTEM_USER_ID) return;

  const eng = getActiveEngine();
  const row = await eng.queryOne<{ user_id: string }>(
    'SELECT user_id FROM chats WHERE jid = ? AND deleted_at IS NULL',
    [jid],
  );

  if (!row) return;
  if (row.user_id === tenantUserId) return;

  if (await hasConversationResourceAccess(jid, tenantUserId)) return;

  if (row.user_id === SYSTEM_USER_ID) {
    if (!(await isReviewBoundConversation(jid))) return;
    if (await isReviewConversationMember(jid, tenantUserId)) return;
    throw new ConversationOwnershipError(jid);
  }

  if (await isReviewConversationMember(jid, tenantUserId)) return;

  throw new ConversationOwnershipError(jid);
}

/**
 * Mutation-access check: can the user delete / reset this conversation?
 *
 * - System caller → pass.
 * - Owner match → pass.
 * - resource_access with editor/manager level → pass.
 * - `__system__`-owned, not review-bound + `conversation.manage` → pass.
 * - Review repo member → pass.
 * - Deny.
 */
export async function assertConversationMutationRight(
  jid: string,
  tenantUserId: string,
): Promise<void> {
  if (tenantUserId === SYSTEM_USER_ID) return;

  const eng = getActiveEngine();
  const row = await eng.queryOne<{ user_id: string }>(
    'SELECT user_id FROM chats WHERE jid = ? AND deleted_at IS NULL',
    [jid],
  );

  if (!row) return;
  if (row.user_id === tenantUserId) return;

  if (await hasResourceAccess(tenantUserId, 'conversation', jid, 'editor')) return;

  if (row.user_id === SYSTEM_USER_ID) {
    if (!(await isReviewBoundConversation(jid))) {
      if (await userHasPermission(tenantUserId, PERM_CONVERSATION_MANAGE)) return;
      throw new ConversationOwnershipError(jid);
    }
    if (await isReviewConversationMember(jid, tenantUserId)) return;
    throw new ConversationOwnershipError(jid);
  }

  if (await isReviewConversationMember(jid, tenantUserId)) return;

  throw new ConversationOwnershipError(jid);
}

/**
 * Non-throwing variant — returns `true` when the tenant has access.
 */
export async function checkConversationOwnership(
  jid: string,
  tenantUserId: string,
): Promise<boolean> {
  try {
    await assertConversationOwnership(jid, tenantUserId);
    return true;
  } catch (err) {
    if (err instanceof ConversationOwnershipError) return false;
    logger.warn(
      { err, jid, tenantUserId },
      'Ownership check failed due to infrastructure error — denying access',
    );
    return false;
  }
}
