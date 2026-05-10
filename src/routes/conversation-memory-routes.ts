import type { Express, Request } from 'express';

import {
  getRegisteredGroup,
  storeMemoryPromotionEntry,
  storeSessionMemoryEntry,
} from '../db.js';
import {
  assertConversationOwnership,
  ConversationOwnershipError,
} from '../conversation/conversation-ownership.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { logger } from '../logger.js';
import { getMemoryContextConfig } from '../memory/context-config.js';
import {
  buildPromotionCandidateFromText,
  classifyMemoryDecision,
  promoteRememberedMemoryText,
} from '../memory/promotion.js';
import { addUnifiedMemory } from '../soul/soul-service.js';

type ConversationMemoryAction = 'remember' | 'session_only';

export interface ConversationMemoryRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  auditMutation?: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

function readBody(req: Request): Record<string, unknown> {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>;
  }
  return {};
}

function normalizeAction(value: unknown): ConversationMemoryAction | null {
  if (value === 'remember' || value === 'session_only') {
    return value;
  }
  return null;
}

function categoryFromRememberedText(text: string): Parameters<typeof addUnifiedMemory>[1]['category'] {
  const candidate = buildPromotionCandidateFromText({
    text,
    sourceEntryIds: [],
    origin: 'explicit_user',
  });
  if (candidate?.kind === 'identity') return 'identity';
  if (candidate?.kind === 'preference' || candidate?.kind === 'constraint') {
    return 'preference';
  }
  if (candidate?.kind === 'commitment') return 'habit';
  return 'general';
}

export function registerConversationMemoryRoutes(
  app: Express,
  options: ConversationMemoryRouteOptions,
): void {
  const guard = options.requirePermission('conversation.own');
  app.post('/api/conversations/:jid/memory-actions', guard, async (req, res) => {
    try {
      const jid = decodeURIComponent(String(req.params.jid || '')).trim();
      await assertConversationOwnership(jid, getTenantUserId(req));
      options.auditMutation?.(req, 'conversations.memory_actions', 'normal');
      const group = jid ? await getRegisteredGroup(jid) : undefined;
      if (!jid || !group) {
        res.status(404).json({ error: 'Conversation group not found' });
        return;
      }

      const body = readBody(req);
      const action = normalizeAction(body.action);
      const text = String(body.text || '').trim();
      const messageId = String(body.messageId || '').trim();
      const sender = String(body.sender || '').trim();
      const senderName = String(body.senderName || '').trim();
      if (!action || !text) {
        res.status(400).json({ error: 'action and text are required' });
        return;
      }

      const memoryConfig = await getMemoryContextConfig();
      if (!memoryConfig.memoryEnabled) {
        res.status(409).json({ error: 'Memory is disabled' });
        return;
      }

      if (action === 'remember') {
        if (!memoryConfig.memoryWriteEnabled) {
          res.status(409).json({ error: 'Durable memory write is disabled' });
          return;
        }

        const decision = classifyMemoryDecision(text);
        const sourceEntryId = messageId || `memory-action:${Date.now()}`;
        const durableScope =
          decision === 'identity' ||
          (decision === 'global_durable' && memoryConfig.globalWriteEnabled)
            ? 'global'
            : 'conversation';
        const memory = await addUnifiedMemory(getTenantUserId(req), {
          category:
            decision === 'identity' ? 'identity' : categoryFromRememberedText(text),
          content: text,
          importance:
            decision === 'identity'
              ? 9
              : decision === 'global_durable'
                ? 7
                : 6,
          source: 'manual',
          scope: durableScope,
          conversationId: durableScope === 'conversation' ? jid : undefined,
          tier: decision === 'identity' ? 'core' : 'durable',
        });
        const result =
          decision === 'identity'
            ? await promoteRememberedMemoryText({
                groupFolder: group.folder,
                chatJid: jid,
                text,
                sourceEntryId,
                sender: sender || undefined,
                senderName: senderName || undefined,
                allowGlobalWrite: memoryConfig.globalWriteEnabled,
              })
            : null;

        await storeMemoryPromotionEntry({
          groupFolder: group.folder,
          chatJid: jid,
          candidate:
            result?.candidate ||
            buildPromotionCandidateFromText({
              text,
              sourceEntryIds: [sourceEntryId],
              origin: 'explicit_user',
            }) || {
              kind: 'commitment',
              text,
              confidence: 'high',
              sourceEntryIds: [sourceEntryId],
              origin: 'explicit_user',
            },
          status: result?.status || 'written',
          pathRef: result?.pathRef || `user_memory:${memory.id}`,
          action: 'remember',
          memoryClass:
            result?.memoryClass ||
            (durableScope === 'global' ? 'global_durable' : 'group_durable'),
          origin: 'explicit_action',
        });
        res.json({
          ok: true,
          action,
          result: {
            status: result?.status || 'written',
            pathRef: result?.pathRef || `user_memory:${memory.id}`,
            lineStart: result?.lineStart || 1,
            lineEnd: result?.lineEnd || 1,
            sourceType: result?.sourceType || 'user_memory',
            memoryClass:
              result?.memoryClass ||
              (durableScope === 'global' ? 'global_durable' : 'group_durable'),
            memoryId: memory.id,
          },
        });
        return;
      }

      if (
        !memoryConfig.memoryReadEnabled ||
        !memoryConfig.promptInjectionEnabled
      ) {
        res.status(409).json({
          error: 'Session memory requires memory read and prompt injection',
        });
        return;
      }

      const entry = await storeSessionMemoryEntry({
        groupFolder: group.folder,
        chatJid: jid,
        text,
        sourceRef: messageId || null,
      });
      await storeMemoryPromotionEntry({
        groupFolder: group.folder,
        chatJid: jid,
        candidate: {
          kind: 'commitment',
          text,
          confidence: 'high',
          sourceEntryIds: messageId ? [messageId] : [],
          origin: 'explicit_action',
        },
        status: 'written',
        action: 'session_only',
        memoryClass: 'session',
        origin: 'explicit_action',
      });
      res.json({
        ok: true,
        action,
        result: {
          status: 'written',
          sourceType: entry.source_type,
          memoryClass: 'session',
          entryId: entry.id,
        },
      });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to apply conversation memory action');
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to apply memory action',
      });
    }
  });
}
