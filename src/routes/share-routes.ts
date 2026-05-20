import crypto from 'crypto';
import type { Express } from 'express';

import { getShareBaseUrl } from '../config-store.js';
import { sanitizePersistedTurnsForWeb } from '../conversation/conversation-turn-visibility.js';
import {
  assertConversationOwnership,
  ConversationOwnershipError,
} from '../conversation/conversation-ownership.js';
import {
  createShare,
  deleteShare,
  getShareById,
  incrementShareViewCount,
  listUserShares,
} from '../db/shares.js';
import { getConversationMessages, getConversationTurns } from '../db.js';
import { logger } from '../logger.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { t } from '../i18n/index.js';

function routePathParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function generateShareId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

interface ShareTimelineEntryBase {
  key: string;
  timestamp: string;
  order: number;
}

type ShareTimelineEntry =
  | (ShareTimelineEntryBase & {
      kind: 'user_message';
      message: Awaited<ReturnType<typeof getConversationMessages>>[number];
      pending: false;
    })
  | (ShareTimelineEntryBase & {
      kind: 'assistant_message';
      text: string;
      status: 'in_progress' | 'completed' | 'failed';
      turnId?: string;
      messageId?: string;
    })
  | (ShareTimelineEntryBase & {
      kind: 'reasoning';
      item: Awaited<
        ReturnType<typeof getConversationTurns>
      >[number]['items'][number];
      turnId: string;
    })
  | (ShareTimelineEntryBase & {
      kind: 'tool_call';
      item: Awaited<
        ReturnType<typeof getConversationTurns>
      >[number]['items'][number];
      turnId: string;
    })
  | (ShareTimelineEntryBase & {
      kind: 'turn_error';
      error: string;
      turnId: string;
    });

function extractRequestedShareKeys(entries: unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const key = (entry as { key?: unknown }).key;
    if (typeof key === 'string' && key.trim()) keys.add(key.trim());
  }
  return keys;
}

async function buildShareEntriesFromServer(
  jid: string,
  userId: string,
  requestedKeys: Set<string>,
): Promise<ShareTimelineEntry[]> {
  const [messages, turns] = await Promise.all([
    getConversationMessages(jid, 100000, 0, userId),
    getConversationTurns(jid, 100000, 0),
  ]);
  const sanitizedTurns = sanitizePersistedTurnsForWeb(turns);
  const attachedBotMessageIds = new Set<string>();
  const attachedRunIds = new Set<string>();
  for (const turn of sanitizedTurns) {
    if (turn.persistedMessageId)
      attachedBotMessageIds.add(turn.persistedMessageId);
    if (turn.id) {
      attachedRunIds.add(turn.id);
    }
  }

  let order = 0;
  const entries: ShareTimelineEntry[] = [];
  for (const message of messages) {
    if (message.is_bot_message) {
      const messageRunId = message.run_id?.trim();
      const isAttachedToTurn =
        attachedBotMessageIds.has(message.id) ||
        (!!messageRunId && attachedRunIds.has(messageRunId));
      if (isAttachedToTurn) continue;
      entries.push({
        kind: 'assistant_message',
        key: `message:${message.id}`,
        timestamp: message.timestamp,
        order: order++,
        text: message.content,
        status: 'completed',
        messageId: message.id,
      });
      continue;
    }

    entries.push({
      kind: 'user_message',
      key: `message:${message.id}`,
      timestamp: message.timestamp,
      order: order++,
      message,
      pending: false,
    });
  }

  for (const turn of sanitizedTurns) {
    const turnKey = turn.clientKey || turn.id;
    let turnHasRenderableEntry = false;
    for (const item of turn.items) {
      if (item.type === 'reasoning') {
        turnHasRenderableEntry = true;
        entries.push({
          kind: 'reasoning',
          key: `turn:${turnKey}:reasoning:${item.id}`,
          timestamp: item.timestamp || turn.timestamp,
          order: order++,
          item,
          turnId: turn.id,
        });
        continue;
      }
      if (item.type === 'tool_call') {
        turnHasRenderableEntry = true;
        entries.push({
          kind: 'tool_call',
          key: `turn:${turnKey}:tool:${item.id}`,
          timestamp: item.timestamp || turn.timestamp,
          order: order++,
          item,
          turnId: turn.id,
        });
        continue;
      }
      if (item.text?.trim()) {
        turnHasRenderableEntry = true;
        entries.push({
          kind: 'assistant_message',
          key: `turn:${turnKey}:assistant:${item.id}`,
          timestamp: item.timestamp || turn.timestamp,
          order: order++,
          text: item.text,
          status: item.status,
          turnId: turn.id,
          messageId: turn.persistedMessageId,
        });
      }
    }
    if (!turnHasRenderableEntry && turn.isLive) {
      entries.push({
        kind: 'assistant_message',
        key: `turn:${turnKey}:assistant:${turn.id}:stream-assistant`,
        timestamp: turn.timestamp,
        order: order++,
        text: '',
        status: 'in_progress',
        turnId: turn.id,
      });
    }
    if (turn.error) {
      entries.push({
        kind: 'turn_error',
        key: `turn:${turnKey}:error`,
        timestamp: turn.timestamp,
        order: order++,
        error: turn.error,
        turnId: turn.id,
      });
    }
  }

  return entries
    .sort((left, right) => {
      const timeDelta =
        new Date(left.timestamp).getTime() -
        new Date(right.timestamp).getTime();
      return timeDelta || left.order - right.order;
    })
    .filter((entry) => requestedKeys.has(entry.key));
}

/**
 * Public routes — registered BEFORE requireAuth so they bypass session checks.
 */
export function registerPublicShareRoutes(app: Express): void {
  app.get('/api/share/:shareId', async (req, res) => {
    try {
      const shareId = routePathParam(req.params.shareId);
      const share = await getShareById(shareId);
      if (!share) {
        res.status(404).json({ error: t('share.notFound', {}, req.locale) });
        return;
      }

      void incrementShareViewCount(shareId).catch(() => {});

      let entries: unknown[];
      try {
        entries = JSON.parse(share.content);
      } catch {
        entries = [];
      }

      res.json({
        id: share.id,
        title: share.title,
        entries,
        assistantName: share.assistant_name,
        createdBy: share.created_by,
        createdAt: share.created_at,
        viewCount: share.view_count,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to fetch share');
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}

export interface ShareRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

/**
 * Authenticated routes — registered AFTER requireAuth.
 */
export function registerShareRoutes(
  app: Express,
  opts: ShareRouteOptions,
): void {
  const guard = opts.requirePermission(
    'conversation.share',
    'conversation.own',
  );

  app.post('/api/conversations/share', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const { jid, title, entries, assistantName } = req.body as {
        jid?: string;
        title?: string;
        entries?: unknown[];
        assistantName?: string;
      };

      if (!jid || !entries || !Array.isArray(entries) || entries.length === 0) {
        res
          .status(400)
          .json({ error: t('share.paramsRequired', {}, req.locale) });
        return;
      }

      await assertConversationOwnership(jid, userId);
      const requestedKeys = extractRequestedShareKeys(entries);
      if (requestedKeys.size === 0) {
        res
          .status(400)
          .json({ error: t('share.paramsRequired', {}, req.locale) });
        return;
      }
      const serverEntries = await buildShareEntriesFromServer(
        jid,
        userId,
        requestedKeys,
      );
      if (serverEntries.length === 0) {
        res
          .status(400)
          .json({ error: t('share.paramsRequired', {}, req.locale) });
        return;
      }

      const shareId = generateShareId();
      const content = JSON.stringify(serverEntries);

      await createShare(
        shareId,
        jid,
        title || null,
        content,
        assistantName || null,
        userId,
        userId,
      );

      const baseUrl = await getShareBaseUrl();
      res.json({ shareId, url: `${baseUrl}/share/${shareId}` });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res
          .status(err.statusCode)
          .json({ error: t('share.noPermission', {}, req.locale) });
        return;
      }
      logger.error({ err }, 'Failed to create share');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/my-shares', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const jid = typeof req.query.jid === 'string' ? req.query.jid : undefined;

      const result = await listUserShares(userId, limit, offset, jid);
      const shareBaseUrl = await getShareBaseUrl();
      res.json({ ...result, shareBaseUrl });
    } catch (err) {
      logger.error({ err }, 'Failed to list shares');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.delete('/api/share/:shareId', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const shareId = routePathParam(req.params.shareId);
      const deleted = await deleteShare(shareId, userId);
      if (!deleted) {
        res
          .status(404)
          .json({ error: t('share.noPermission', {}, req.locale) });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to delete share');
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
