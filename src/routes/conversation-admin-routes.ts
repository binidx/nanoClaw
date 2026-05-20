import type { Express, Request } from 'express';

import {
  resolveEffectiveConversationAccessState,
  resolveConversationAccessState,
  type AccessPolicy,
  type ConversationAccessPolicyLayers,
  type EffectiveConversationAccessState,
  type ResolvedAccessPolicy,
  resolveLegacyAccessPolicy,
} from '../auth/access-policy.js';
import type {
  RuntimeApprovalPatchRecord,
  RuntimeApprovalPatchState,
  RuntimeApprovalPatchScope,
} from '../conversation/conversation-admin-support.js';
import {
  summarizeRuntimeApprovalPatches,
} from '../conversation/conversation-admin-support.js';
import {
  assertConversationMutationRight,
  assertConversationOwnership,
  ConversationOwnershipError,
} from '../conversation/conversation-ownership.js';
import {
  getAssistantName,
  getConversationCreationMetadata,
} from '../config-store.js';
import {
  deleteConversation,
  deleteConversationMessages,
  deleteRegisteredGroup,
  getMessageCount,
  deleteSessionByJid,
  getConversationMessages,
  getConversationSummaryByJid,
  getRegisteredGroup,
  isProviderVisibleToUser,
  sanitizeStaleTurnsForChat,
  updateConversationMeta,
} from '../db.js';
import { logger } from '../logger.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { userHasPermission } from '../user/user-service.js';
import { getWebChannel } from '../channels/web.js';
import { t } from '../i18n/index.js';

function routePathParam(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? '';
  return '';
}

export type ConversationFeishuDocSection =
  | {
      kind: 'heading';
      level?: 1 | 2 | 3;
      text: string;
    }
  | {
      kind: 'paragraph' | 'code';
      text: string;
    };

export interface CreateConversationFeishuDocInput {
  chatJid: string;
  title: string;
  conversationType: 'group' | 'dm';
  sections: ConversationFeishuDocSection[];
}

export interface CreateConversationFeishuDocResult {
  documentId: string;
  url: string;
  resultStatus: string;
  title?: string;
  authorizationWarnings?: string[];
  [key: string]: unknown;
}

type ApprovalDecision = 'allow-once' | 'deny';
type ApprovalResolution = 'allow-once' | 'deny';
type ApiResolvedAccessPolicy = ResolvedAccessPolicy & {
  source: ResolvedAccessPolicy['inheritedFrom'];
};
type ConversationAccessNextActionTarget =
  | {
      type: 'assistant';
      label: string;
      assistantId?: string | null;
    }
  | {
      type: 'settings_default_access';
      label: string;
    };

export interface ConversationAccessNextAction {
  id:
    | 'manage_assistant_policy'
    | 'manage_default_policy'
    | 'promote_conversation_policy'
    | 'prefer_runtime_approval'
    | 'review_runtime_approval';
  title: string;
  description: string;
  target?: ConversationAccessNextActionTarget;
}

function serializeResolvedAccessPolicy(
  policy: ResolvedAccessPolicy,
): ApiResolvedAccessPolicy {
  return {
    ...policy,
    source: policy.inheritedFrom,
  };
}

function buildConversationAccessNextActions(input: {
  policy: ResolvedAccessPolicy;
  runtimeAccess: RuntimeApprovalPatchState;
}): ConversationAccessNextAction[] {
  const actions: ConversationAccessNextAction[] = [];

  if (input.policy.inheritedFrom === 'global') {
    actions.push({
      id: 'manage_default_policy',
      title: t('errors.auto_d8bc0c', {}, undefined),
      description:
        t('errors.auto_688429', {}, undefined),
      target: {
        type: 'settings_default_access',
        label: t('errors.auto_9168f1', {}, undefined),
      },
    });
  } else {
    actions.push({
      id: 'promote_conversation_policy',
      title: t('errors.auto_5eacfd', {}, undefined),
      description:
        t('errors.auto_975265', {}, undefined),
      target: {
        type: 'settings_default_access',
        label: t('errors.auto_9168f1', {}, undefined),
      },
    });
  }

  actions.push(
    input.runtimeAccess.hasActivePatches
      ? {
          id: 'review_runtime_approval',
          title: t('errors.auto_ebb2ec', {}, undefined),
          description: input.runtimeAccess.summary,
        }
      : {
          id: 'prefer_runtime_approval',
          title: t('errors.auto_96378b', {}, undefined),
          description:
            t('errors.auto_270348', {}, undefined),
        },
  );

  return actions;
}


export interface ConversationAdminRouteOptions {
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
  readPendingApprovalsForConversation: (
    jid: string,
  ) => unknown[] | Promise<unknown[]>;
  readActiveRuntimeApprovalPatchesForConversation?: (
    jid: string,
  ) => RuntimeApprovalPatchRecord[];
  writeApprovalDecisionForConversation: (
    jid: string,
    approvalId: string,
    decision: ApprovalResolution,
    scope?: RuntimeApprovalPatchScope,
  ) =>
    | {
        id: string;
        toolCallId: string;
        toolName: string;
        command?: string;
      }
    | Promise<{
        id: string;
        toolCallId: string;
        toolName: string;
        command?: string;
      }>;
  readPendingAsksForConversation?: (
    jid: string,
  ) => unknown[] | Promise<unknown[]>;
  writeAskAnswerForConversation?: (
    jid: string,
    askId: string,
    answer: string,
    answeredBy: string,
  ) => void | Promise<void>;
  interruptConversationReply?: (jid: string) => boolean;
  regenerateConversationReply?: (
    jid: string,
    turnId?: string,
  ) => void | Promise<void>;
  clearRuntimeApprovalPatchesForConversation?: (jid: string) => void;
  updateConversationAccessPolicy?: (
    jid: string,
    accessPolicy: {
      mode: 'allowall' | 'allowlist' | 'readonly';
      directories: string[];
    },
  ) => { folder: string } | null | Promise<{ folder: string } | null>;
  resetConversationRuntime?: (jid: string, groupFolder?: string) => void;
  clearCodexConversationState: (folder: string) => void;
  getDefaultConversationAccessPolicy: () =>
    | {
        mode: 'allowall' | 'allowlist' | 'readonly';
        directories: string[];
      }
    | Promise<{
        mode: 'allowall' | 'allowlist' | 'readonly';
        directories: string[];
      }>;
  normalizeAccessPolicyInput: (value: unknown) => {
    mode: 'allowall' | 'allowlist' | 'readonly';
    directories: string[];
  };
  normalizeAllowedDirectoriesInput: (value: unknown) => string[];
  createWebConversation?: (
    jid: string,
    name: string,
    options?: {
      assistantId?: string;
      tavernPersonaId?: string;
      accessPolicy?: {
        mode: 'allowall' | 'allowlist' | 'readonly';
        directories: string[];
      };
      mode?: string;
      ownerUserId?: string;
    },
  ) =>
    | {
        folder: string;
        accessPolicy: {
          mode: 'allowall' | 'allowlist' | 'readonly';
          directories: string[];
        };
      }
    | null
    | Promise<{
        folder: string;
        accessPolicy: {
          mode: 'allowall' | 'allowlist' | 'readonly';
          directories: string[];
        };
      } | null>;
  createChannelConversation?: (input: {
    type: string;
    instanceId?: string;
    name: string;
    assistantId?: string;
    target?: Record<string, unknown>;
  }) =>
    | {
        jid: string;
        name: string;
        accessPolicy?: {
          mode: 'allowall' | 'allowlist' | 'readonly';
          directories: string[];
        };
      }
    | null
    | Promise<{
        jid: string;
        name: string;
        accessPolicy?: {
          mode: 'allowall' | 'allowlist' | 'readonly';
          directories: string[];
        };
      } | null>;
  createConversationFeishuDoc?: (
    input: CreateConversationFeishuDocInput,
  ) =>
    | CreateConversationFeishuDocResult
    | Promise<CreateConversationFeishuDocResult>;
  setConversationProviderOverride?: (
    jid: string,
    providerId: string | null,
    model: string | null,
  ) => boolean | Promise<boolean>;
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

interface ConversationFeishuDocBody {
  title?: unknown;
  text?: unknown;
  contentMode?: unknown;
  sections?: unknown;
}

function isFeishuConversationJid(jid: string): boolean {
  return jid.startsWith('feishu:');
}

function normalizeConversationDocTitleValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatConversationDocTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

async function defaultConversationDocTitle(jid: string): Promise<string> {
  const conversation = await getConversationSummaryByJid(jid);
  const label =
    conversation?.display_name?.trim() || conversation?.name?.trim() || jid;
  return `${label} ${formatConversationDocTimestamp(new Date())}`;
}

function normalizeConversationDocSections(
  value: unknown,
): ConversationFeishuDocSection[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`sections[${index}] must be an object`);
    }

    const kind = (entry as { kind?: unknown }).kind;
    const text = normalizeConversationDocTitleValue(
      (entry as { text?: unknown }).text,
    );

    if (kind !== 'heading' && kind !== 'paragraph' && kind !== 'code') {
      throw new Error(
        `sections[${index}].kind must be "heading", "paragraph", or "code"`,
      );
    }
    if (!text) {
      throw new Error(`sections[${index}].text is required`);
    }

    if (kind === 'heading') {
      const rawLevel = (entry as { level?: unknown }).level;
      const normalizedLevel =
        typeof rawLevel === 'number' &&
        Number.isInteger(rawLevel) &&
        rawLevel >= 1 &&
        rawLevel <= 3
          ? (rawLevel as 1 | 2 | 3)
          : 1;
      return {
        kind,
        level: normalizedLevel,
        text,
      };
    }

    return {
      kind,
      text,
    };
  });
}

function normalizePlainTextConversationDocSections(
  text: string,
): ConversationFeishuDocSection[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({
      kind: 'paragraph' as const,
      text: entry,
    }));
}

function formatTranscriptMessage(
  message: Awaited<ReturnType<typeof getConversationMessages>>[number],
  assistantName: string,
): string {
  const sender =
    message.is_bot_message
      ? assistantName
      : message.sender_name || message.sender || 'Unknown';
  return `[${message.timestamp}] ${sender}: ${message.content || ''}`.trim();
}

async function buildConversationDocSectionsFromRecentTranscript(
  jid: string,
  maxMessages: number,
  promptText?: string,
): Promise<ConversationFeishuDocSection[]> {
  const totalMessages = await getMessageCount(jid);
  const boundedMax = Math.max(1, maxMessages);
  const offset = Math.max(0, totalMessages - boundedMax);
  const messages = await getConversationMessages(jid, boundedMax, offset);
  const sections: ConversationFeishuDocSection[] = [];
  const normalizedPrompt = normalizeConversationDocTitleValue(promptText);

  if (normalizedPrompt) {
    sections.push({
      kind: 'heading',
      level: 2,
      text: 'Request',
    });
    sections.push({
      kind: 'paragraph',
      text: normalizedPrompt,
    });
  }

  if (messages.length > 0) {
    sections.push({
      kind: 'heading',
      level: 2,
      text: 'Recent Transcript',
    });
    const transcriptAssistantName = await getAssistantName();
    for (const message of messages) {
      const line = formatTranscriptMessage(message, transcriptAssistantName).trim();
      if (!line) continue;
      sections.push({
        kind: 'paragraph',
        text: line,
      });
    }
  }

  if (sections.length === 0) {
    throw new Error('No content available to create a Feishu cloud doc');
  }

  return sections;
}

async function resolveFeishuConversationType(
  jid: string,
): Promise<'group' | 'dm'> {
  const conversation = await getConversationSummaryByJid(jid);
  if (!conversation) {
    throw new Error(`Conversation not found for ${jid}`);
  }
  return conversation.is_group ? 'group' : 'dm';
}

function isConversationFeishuDocSuccess(
  resultStatus: string,
): boolean {
  return (
    resultStatus === 'success' ||
    resultStatus === 'success_with_authorization_warnings'
  );
}

function buildConversationFeishuDocResultMessage(result: {
  resultStatus?: string;
  authorizationWarnings?: string[];
  lastError?: string;
}): string | undefined {
  if (result.resultStatus === 'success_with_authorization_warnings') {
    return result.authorizationWarnings?.join('; ') || 'Authorization may be incomplete.';
  }
  if (result.resultStatus === 'creation_failed') {
    return result.lastError
      ? `Feishu cloud doc creation failed: ${result.lastError}`
      : 'Feishu cloud doc creation failed.';
  }
  if (result.resultStatus === 'content_population_failed') {
    return result.lastError
      ? `Feishu cloud doc content population failed: ${result.lastError}`
      : 'Feishu cloud doc content population failed.';
  }
  if (result.resultStatus === 'url_resolution_failed') {
    return result.lastError
      ? `Feishu cloud doc URL resolution failed: ${result.lastError}`
      : 'Feishu cloud doc URL resolution failed.';
  }
  return undefined;
}

async function resolveConversationDocSections(
  jid: string,
  body: ConversationFeishuDocBody,
): Promise<ConversationFeishuDocSection[]> {
  const structuredSections = normalizeConversationDocSections(body.sections);
  if (structuredSections.length > 0) {
    return structuredSections;
  }

  const contentMode =
    body.contentMode === 'recent_transcript' ? 'recent_transcript' : 'text';
  if (contentMode === 'recent_transcript') {
    return await buildConversationDocSectionsFromRecentTranscript(
      jid,
      200,
      typeof body.text === 'string' ? body.text : undefined,
    );
  }

  const normalizedText = normalizeConversationDocTitleValue(body.text);
  if (!normalizedText) {
    throw new Error(
      'text or sections is required to create a Feishu cloud doc',
    );
  }

  const plainTextSections =
    normalizePlainTextConversationDocSections(normalizedText);
  if (plainTextSections.length === 0) {
    throw new Error(
      'text or sections is required to create a Feishu cloud doc',
    );
  }
  return plainTextSections;
}

async function buildConversationAccessResponse(
  opts: ConversationAdminRouteOptions,
  jid: string,
): Promise<{ accessPolicy: ApiResolvedAccessPolicy; allowedDirectories: string[]; policyLayers: ConversationAccessPolicyLayers; runtimeApprovalPatches: RuntimeApprovalPatchRecord[]; runtimeAccess: RuntimeApprovalPatchState; effectiveAccess: EffectiveConversationAccessState; nextActions: ConversationAccessNextAction[]; }> {
  const group = await getRegisteredGroup(jid);
  const defaultPolicy = await Promise.resolve(
    opts.getDefaultConversationAccessPolicy(),
  );
  const runtimeApprovalPatches =
    opts.readActiveRuntimeApprovalPatchesForConversation?.(jid) || [];
  const runtimeAccess = summarizeRuntimeApprovalPatches(runtimeApprovalPatches);
  const emptyLayers = {
    global: defaultPolicy,
    assistant: null,
    conversation: null,
  };
  if (!group) {
    const resolved = resolveConversationAccessState({
      defaultPolicy,
    });
    const effectiveAccess = resolveEffectiveConversationAccessState({
      persistentPolicy: resolved.policy,
      runtimeApprovalPatches,
    });
    return {
      accessPolicy: serializeResolvedAccessPolicy(resolved.policy),
      allowedDirectories: defaultPolicy.directories,
      policyLayers: resolved.policyLayers || emptyLayers,
      runtimeApprovalPatches,
      runtimeAccess,
      effectiveAccess,
      nextActions: buildConversationAccessNextActions({
        policy: resolved.policy,
        runtimeAccess,
      }),
    };
  }

  const conversationPolicy =
    group.agentConfig
      ? resolveLegacyAccessPolicy(group.agentConfig, {
          defaultMode: defaultPolicy.mode,
        })
      : null;

  const resolved = resolveConversationAccessState({
    defaultPolicy,
    conversationPolicy,
  });
  const effectiveAccess = resolveEffectiveConversationAccessState({
    persistentPolicy: resolved.policy,
    runtimeApprovalPatches,
  });

  return {
    accessPolicy: serializeResolvedAccessPolicy(resolved.policy),
    allowedDirectories: resolved.policy.directories,
    policyLayers: resolved.policyLayers,
    runtimeApprovalPatches,
    runtimeAccess,
    effectiveAccess,
    nextActions: buildConversationAccessNextActions({
      policy: resolved.policy,
      runtimeAccess,
    }),
  };
}

export function registerConversationAdminRoutes(
  app: Express,
  opts: ConversationAdminRouteOptions,
): void {
  const viewGuard = opts.requirePermission('conversation.view');
  const sendGuard = opts.requirePermission('conversation.send');
  const ownGuard = opts.requirePermission('conversation.own', 'conversation.delete');

  app.get('/api/conversations/:jid/access', viewGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      res.json(await buildConversationAccessResponse(opts, jid));
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to get conversation access');
      const message =
        err instanceof Error ? err.message : 'Failed to get conversation access';
      const status =
        /unknown assistant|disabled|不存在|停用/i.test(message) ? 400 : 500;
      res.status(status).json({ error: message });
    }
  });

  app.get('/api/conversations/:jid/approvals', viewGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      res.json({
        approvals: await Promise.resolve(
          opts.readPendingApprovalsForConversation(jid),
        ),
      });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to get pending approvals');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/conversations/:jid/approvals/:approvalId', sendGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      opts.auditMutation(req, 'conversations.approvals.resolve', 'high');
      const approvalId = decodeURIComponent(routePathParam(req.params.approvalId));
      const decision =
        req.body?.decision === 'allow-once'
          ? 'allow-once'
          : req.body?.decision === 'deny'
            ? 'deny'
            : null;
      const scope =
        req.body?.scope === 'current_tool_call'
          ? 'current_tool_call'
          : req.body?.scope === 'current_runtime'
            ? 'current_runtime'
            : 'current_runtime';

      if (!decision) {
        res
          .status(400)
          .json({
            error: 'decision must be "allow-once" or "deny"',
          });
        return;
      }

      const request = await Promise.resolve(
        opts.writeApprovalDecisionForConversation(
          jid,
          approvalId,
          decision,
          scope,
        ),
      );

      const webChannel = getWebChannel();
      if (webChannel) {
        webChannel.notifyApprovalResolved(jid, {
          id: request.id,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          decision,
          resolvedAt: new Date().toISOString(),
        });
      }

      res.json({ ok: true });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to resolve approval');
      const message =
        err instanceof Error ? err.message : 'Failed to resolve approval';
      const status = /not found/i.test(message) ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  app.get('/api/conversations/:jid/questions', viewGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      const questions = opts.readPendingAsksForConversation
        ? await Promise.resolve(opts.readPendingAsksForConversation(jid))
        : [];
      res.json({ questions });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to get pending questions');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/conversations/:jid/questions/:askId', sendGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      opts.auditMutation(req, 'conversations.questions.answer');
      const askId = decodeURIComponent(routePathParam(req.params.askId));
      const answer = typeof req.body?.answer === 'string' ? req.body.answer : '';
      const answeredBy = getTenantUserId(req) || 'web-user';

      if (!opts.writeAskAnswerForConversation) {
        res.status(501).json({ error: 'ask_user not supported' });
        return;
      }

      await Promise.resolve(
        opts.writeAskAnswerForConversation(jid, askId, answer, answeredBy),
      );
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to answer question');
      const message = err instanceof Error ? err.message : 'Internal error';
      const status = /not found/i.test(message) ? 404 : 500;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/conversations/:jid/interrupt', sendGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      opts.auditMutation(req, 'conversations.interrupt', 'normal');
      if (!opts.interruptConversationReply) {
        res.status(501).json({ error: 'Reply interruption is not available' });
        return;
      }
      const stopped = opts.interruptConversationReply(jid);
      if (!stopped) {
        const fixed = await sanitizeStaleTurnsForChat(jid);
        if (fixed === 0) {
          res.status(409).json({ error: 'No active reply to interrupt' });
          return;
        }
      }
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to interrupt conversation reply');
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  app.post('/api/conversations/:jid/regenerate', sendGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      opts.auditMutation(req, 'conversations.regenerate', 'normal');
      if (!opts.regenerateConversationReply) {
        res.status(501).json({ error: 'Reply regeneration is not available' });
        return;
      }
      const turnId =
        typeof req.body?.turnId === 'string' && req.body.turnId.trim()
          ? req.body.turnId.trim()
          : undefined;
      opts.clearRuntimeApprovalPatchesForConversation?.(jid);
      await Promise.resolve(opts.regenerateConversationReply(jid, turnId));
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to regenerate conversation reply');
      const message = err instanceof Error ? err.message : 'Internal error';
      const status =
        /not found/i.test(message)
          ? 404
          : /No assistant reply|Only the latest assistant reply|No user input|currently in progress/i.test(
                message,
              )
            ? 409
            : 500;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/conversations/:jid/feishu-docs', sendGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      opts.auditMutation(req, 'conversations.feishu_docs.create', 'normal');
      if (!isFeishuConversationJid(jid)) {
        res.status(400).json({
          error: 'Feishu cloud docs are only supported for feishu conversations',
        });
        return;
      }
      if (!opts.createConversationFeishuDoc) {
        res.status(501).json({ error: 'Feishu cloud doc service is not available' });
        return;
      }

      const body = (req.body || {}) as ConversationFeishuDocBody;
      const sections = await resolveConversationDocSections(jid, body);
      const title =
        normalizeConversationDocTitleValue(body.title) ||
        (await defaultConversationDocTitle(jid));
      const conversationType = await resolveFeishuConversationType(jid);
      const result = await Promise.resolve(
        opts.createConversationFeishuDoc({
          chatJid: jid,
          title,
          conversationType,
          sections,
        }),
      );
      const ok = isConversationFeishuDocSuccess(result.resultStatus);
      res.json({
        ok,
        ...result,
        ...(buildConversationFeishuDocResultMessage(result)
          ? { message: buildConversationFeishuDocResultMessage(result) }
          : {}),
      });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to create conversation Feishu cloud doc');
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to create conversation Feishu cloud doc';
      const status =
        /sections\[|only supported|required|not found|no content|must be/i.test(
          message,
        )
          ? 400
          : 500;
      res.status(status).json({ error: message });
    }
  });

  app.patch('/api/conversations/:jid', ownGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      opts.auditMutation(req, 'conversations.update', 'normal');
      const { customTitle, isPinned, isFavorite, allowedDirectories, accessPolicy, providerId, model } =
        req.body as {
          customTitle?: string | null;
          isPinned?: boolean;
          isFavorite?: boolean;
          allowedDirectories?: unknown;
          accessPolicy?: unknown;
          providerId?: string | null;
          model?: string | null;
        };

      if (accessPolicy !== undefined || allowedDirectories !== undefined) {
        const normalizedPolicy =
          accessPolicy !== undefined
            ? opts.normalizeAccessPolicyInput(accessPolicy)
            : {
                mode: 'allowlist' as const,
                directories:
                  opts.normalizeAllowedDirectoriesInput(allowedDirectories),
              };
        const updated = await Promise.resolve(
          opts.updateConversationAccessPolicy?.(jid, normalizedPolicy) ?? null,
        );
        if (!updated) {
          res.status(404).json({ error: 'Conversation group not found' });
          return;
        }
        opts.interruptConversationReply?.(jid);
        opts.clearRuntimeApprovalPatchesForConversation?.(jid);
        opts.resetConversationRuntime?.(jid, updated.folder);
      }

      if (providerId !== undefined || model !== undefined) {
        const nextProviderId = providerId?.trim() || null;
        if (nextProviderId && !await isProviderVisibleToUser(nextProviderId, getTenantUserId(req), 'llm')) {
          res.status(403).json({ error: 'No access to selected provider' });
          return;
        }
        const existingGroup =
          providerId === undefined ? await getRegisteredGroup(jid) : null;
        const ok = await Promise.resolve(
          opts.setConversationProviderOverride?.(
            jid,
            providerId === undefined
              ? existingGroup?.providerId ?? null
              : nextProviderId,
            model === undefined ? existingGroup?.model ?? null : model,
          ) ?? false,
        );
        if (!ok) {
          res.status(404).json({ error: 'Conversation group not found' });
          return;
        }
      }

      await updateConversationMeta(jid, {
        customTitle,
        isPinned,
        isFavorite,
      });
      res.json({
        ok: true,
        ...(await buildConversationAccessResponse(opts, jid)),
      });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to update conversation meta');
      const message =
        err instanceof Error ? err.message : 'Failed to update conversation meta';
      const status =
        /assistant-managed|unknown assistant|disabled|不存在|停用/i.test(message)
          ? 400
          : 500;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/conversations/:jid/export-md', ownGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      const exportTenantUid = getTenantUserId(req);
      const exportIsAdmin = await userHasPermission(exportTenantUid, 'conversation.manage');
      const messages = await getConversationMessages(jid, 100000, 0, exportIsAdmin ? undefined : exportTenantUid);
      const conversation = await getConversationSummaryByJid(jid);
      const title = conversation?.display_name || conversation?.name || jid;
      const lines = [
        `# ${title}`,
        '',
        t('errors.exportSessionId', { jid }, undefined),
        t('errors.exportChannel', { channel: conversation?.channel || 'unknown' }, undefined),
        t('errors.exportTime', { time: new Date().toISOString() }, undefined),
        '',
        '---',
        '',
      ];

      const assistantDisplayName = await getAssistantName();
      for (const message of messages) {
        const sender = message.is_bot_message
          ? assistantDisplayName
          : message.sender_name || message.sender || 'Unknown';
        lines.push(`## ${sender}`);
        lines.push(t('errors.exportMessageTime', { time: message.timestamp }, undefined));
        lines.push('');
        lines.push(message.content || '');
        lines.push('');
      }

      const md = lines.join('\n');
      const safeFileName =
        `${title}`
          .replace(/[\\/:*?"<>|]+/g, '_')
          .replace(/\s+/g, '_')
          .slice(0, 80) || 'conversation';

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeFileName}.md"`,
      );
      res.send(md);
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to export conversation markdown');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/conversations/:jid/reset', ownGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationMutationRight(jid, getTenantUserId(req));
      opts.auditMutation(req, 'conversations.reset', 'high');
      const registeredGroup = await getRegisteredGroup(jid);
      opts.clearRuntimeApprovalPatchesForConversation?.(jid);
      await deleteConversationMessages(jid);
      await deleteSessionByJid(jid);
      if (registeredGroup) {
        opts.clearCodexConversationState(registeredGroup.folder);
      }
      getWebChannel()?.resetConversation(jid);
      logger.info(
        { jid, groupFolder: registeredGroup?.folder },
        'Conversation reset',
      );
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to reset conversation');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/conversations/:jid', ownGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationMutationRight(jid, getTenantUserId(req));
      opts.auditMutation(req, 'conversations.delete', 'high');
      const registeredGroup = await getRegisteredGroup(jid);
      opts.clearRuntimeApprovalPatchesForConversation?.(jid);
      await deleteConversation(jid);
      if (registeredGroup) {
        await deleteRegisteredGroup(jid);
        opts.clearCodexConversationState(registeredGroup.folder);
      }
      logger.info(
        { jid, groupFolder: registeredGroup?.folder },
        'Conversation deleted',
      );
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to delete conversation');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/conversations', ownGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'conversations.create', 'normal');
      const type = String(req.body.type || req.body.channelType || 'web')
        .trim()
        .toLowerCase();
      const name = String(req.body.name || 'New Chat').trim() || 'New Chat';
      const assistantId =
        typeof req.body.assistantId === 'string'
          ? req.body.assistantId.trim()
          : '';
      const tavernPersonaId =
        typeof req.body.tavernPersonaId === 'string'
          ? req.body.tavernPersonaId.trim()
          : '';
      const instanceId =
        typeof req.body.instanceId === 'string'
          ? req.body.instanceId.trim()
          : typeof req.body.channelInstanceId === 'string'
            ? req.body.channelInstanceId.trim()
            : undefined;
      const target =
        req.body.target && typeof req.body.target === 'object'
          ? (req.body.target as Record<string, unknown>)
          : (req.body as Record<string, unknown>);
      const VALID_MODES = new Set(['companion']);
      const rawMode =
        typeof req.body.mode === 'string' ? req.body.mode.trim() || null : null;
      const mode = rawMode && VALID_MODES.has(rawMode) ? rawMode : null;

      if (assistantId && tavernPersonaId) {
        res.status(400).json({
          error: 'assistantId and tavernPersonaId cannot be combined',
        });
        return;
      }
      if (tavernPersonaId && type !== 'web') {
        res.status(400).json({
          error: 'tavernPersonaId is supported only for web conversations',
        });
        return;
      }
      if (rawMode === 'tavern' && !tavernPersonaId) {
        res.status(400).json({
          error: 'tavern mode requires tavernPersonaId',
        });
        return;
      }

      if (type === 'web') {
        const tenantUserId = getTenantUserId(req);
        const tenantSuffix = getTenantUserId(req)
          .replace(/[^a-zA-Z0-9_-]+/g, '_')
          .slice(0, 32) || 'system';
        const id = `${tenantSuffix}_web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const jid = `web:${id}`;
        const created = await Promise.resolve(
          opts.createWebConversation?.(jid, name, {
            assistantId: assistantId || undefined,
            tavernPersonaId: tavernPersonaId || undefined,
            mode: mode || undefined,
            ownerUserId: tenantUserId,
          }) ?? null,
        );
        const responseMode = tavernPersonaId ? 'tavern' : mode;
        const responsePolicy =
          created?.accessPolicy ||
          (await Promise.resolve(opts.getDefaultConversationAccessPolicy()));
        res.json({
          jid,
          name,
          mode: responseMode,
          accessPolicy: responsePolicy,
          allowedDirectories: responsePolicy.directories,
          assistantId: assistantId || null,
          tavernPersonaId: tavernPersonaId || null,
        });
        return;
      }

      const created = await Promise.resolve(
        opts.createChannelConversation?.({
          type,
          instanceId,
          name,
          assistantId: assistantId || undefined,
          target,
        }) ?? null,
      );
      if (!created) {
        res
          .status(400)
          .json({ error: `Unsupported conversation type: ${type}` });
        return;
      }
      const responsePolicy =
        created.accessPolicy ||
        (await Promise.resolve(opts.getDefaultConversationAccessPolicy()));
      res.json({
        ...created,
        accessPolicy: responsePolicy,
        allowedDirectories: responsePolicy.directories,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to create conversation');
      const message =
        err instanceof Error ? err.message : 'Internal error';
      const status =
        /unknown assistant|disabled|supported only/i.test(message) ? 400 : 500;
      res
        .status(status)
        .json({ error: message });
    }
  });

  app.get('/api/conversations/meta', viewGuard, (_req, res) => {
    try {
      res.json(getConversationCreationMetadata());
    } catch (err) {
      logger.error({ err }, 'Failed to read conversation creation metadata');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
