import type { Express } from 'express';

import { getPromptTraceById, listPromptTraces } from '../db/prompt-configs.js';
import { getPromptDefinition, getPromptDefinitions } from '../prompt/prompt-registry.js';
import {
  buildPromptPreviewFromRuntime,
  buildPromptPreviewFromScenario,
  getPromptPreviewScenarios,
} from '../prompt/prompt-preview-service.js';
import {
  buildPromptPreviewEnvelope,
  removePromptConfig,
  resolvePromptText,
  savePromptConfig,
} from '../prompt/prompt-service.js';
import { buildConversationPromptPreview } from '../runtime/runtime-dispatch.js';
import type { NewMessage } from '../types.js';
import { listUsers } from '../user/user-service.js';

export interface PromptRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  auditMutation: (
    req: import('express').Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

function buildPreviewMessage(chatJid: string, text: string, senderName: string): NewMessage {
  return {
    id: `prompt-preview-${Date.now()}`,
    chat_jid: chatJid,
    sender: 'web_user',
    sender_name: senderName || 'prompt-preview',
    content: text,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
  };
}

export function registerPromptRoutes(app: Express, opts: PromptRouteOptions): void {
  const viewGuard = opts.requirePermission('system.settings', 'system.settings.view');
  const editGuard = opts.requirePermission('system.settings', 'system.settings.edit');

  app.get('/api/prompt-configs/bootstrap', viewGuard, async (_req, res) => {
    try {
      const users = await listUsers();
      res.json({
        ok: true,
        definitions: getPromptDefinitions(),
        previewScenarios: getPromptPreviewScenarios(),
        users: users.map((user) => ({
          id: user.id,
          username: user.username,
          status: user.status,
        })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/prompt-configs', viewGuard, async (req, res) => {
    try {
      const promptKey =
        typeof req.query.promptKey === 'string' ? req.query.promptKey.trim() : '';
      const targetUserId =
        typeof req.query.targetUserId === 'string' ? req.query.targetUserId.trim() : '';
      const definition = promptKey ? getPromptDefinition(promptKey) : null;
      if (promptKey && !definition) {
        res.status(404).json({ ok: false, error: 'Unknown prompt key' });
        return;
      }
      if (!promptKey || !definition) {
        res.json({ ok: true, definitions: getPromptDefinitions() });
        return;
      }
      const system = await resolvePromptText({
        promptKey,
        variables: {},
      });
      const user = targetUserId
        ? await resolvePromptText({
            promptKey,
            targetUserId,
            variables: {},
          })
        : null;
      res.json({
        ok: true,
        definition,
        system,
        user,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.put('/api/prompt-configs/:promptKey', editGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'prompt-configs.update', 'high');
      const promptKey = String(req.params.promptKey || '').trim();
      const definition = getPromptDefinition(promptKey);
      if (!definition) {
        res.status(404).json({ ok: false, error: 'Unknown prompt key' });
        return;
      }
      if (definition.mutability && definition.mutability !== 'configurable') {
        res.status(400).json({ ok: false, error: 'Prompt is read-only' });
        return;
      }
      const body = (req.body || {}) as {
        scopeKind?: unknown;
        targetUserId?: unknown;
        templateText?: unknown;
        notes?: unknown;
      };
      const scopeKind = body.scopeKind === 'user' ? 'user' : 'system';
      const targetUserId =
        typeof body.targetUserId === 'string' ? body.targetUserId.trim() : '';
      if (scopeKind === 'user' && !targetUserId) {
        res.status(400).json({ ok: false, error: 'targetUserId is required for user scope' });
        return;
      }
      const templateText =
        typeof body.templateText === 'string' ? body.templateText : '';
      if (!templateText.trim()) {
        res.status(400).json({ ok: false, error: 'templateText is required' });
        return;
      }
      const record = await savePromptConfig({
        scopeKind,
        ownerUserId: targetUserId,
        promptKey,
        featureScope: definition.featureScope,
        templateText,
        notes: typeof body.notes === 'string' ? body.notes : null,
      });
      res.json({ ok: true, record });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.delete('/api/prompt-configs/:promptKey', editGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'prompt-configs.delete', 'high');
      const promptKey = String(req.params.promptKey || '').trim();
      const definition = getPromptDefinition(promptKey);
      if (!definition) {
        res.status(404).json({ ok: false, error: 'Unknown prompt key' });
        return;
      }
      if (definition.mutability && definition.mutability !== 'configurable') {
        res.status(400).json({ ok: false, error: 'Prompt is read-only' });
        return;
      }
      const scopeKind = req.query.scopeKind === 'user' ? 'user' : 'system';
      const targetUserId =
        typeof req.query.targetUserId === 'string' ? req.query.targetUserId.trim() : '';
      await removePromptConfig({
        scopeKind,
        ownerUserId: targetUserId,
        promptKey,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/prompt-configs/preview', viewGuard, async (req, res) => {
    try {
      const body = (req.body || {}) as {
        mode?: unknown;
        promptKey?: unknown;
        targetUserId?: unknown;
        variables?: unknown;
        scenarioId?: unknown;
        chatJid?: unknown;
        messageText?: unknown;
        senderName?: unknown;
      };
      const mode = body.mode === 'conversation' ? 'conversation' : 'template';
      if (mode === 'conversation') {
        const chatJid = typeof body.chatJid === 'string' ? body.chatJid.trim() : '';
        const messageText =
          typeof body.messageText === 'string' ? body.messageText.trim() : '';
        if (!chatJid || !messageText) {
          res.status(400).json({ ok: false, error: 'chatJid and messageText are required' });
          return;
        }
        const envelope = await buildConversationPromptPreview(chatJid, [
          buildPreviewMessage(
            chatJid,
            messageText,
            typeof body.senderName === 'string' ? body.senderName : 'prompt-preview',
          ),
        ]);
        if (!envelope) {
          res.status(404).json({ ok: false, error: 'Conversation not found or not registered' });
          return;
        }
        res.json({
          ok: true,
          preview: buildPromptPreviewEnvelope({
            traceKind: 'agent_envelope',
            featureScope: 'conversation',
            promptKey: 'conversation.runtime',
            targetUserId: envelope.resolvedUserId || null,
            chatJid,
            systemPromptText: envelope.soulSystemPrompt || null,
            userPromptText: envelope.prompt.text,
            providerInputText: envelope.prompt.text,
            segments: envelope.segments,
            resolution: [],
            metadata: {
              assistantId: envelope.assistantRuntime.assistantId,
              assistantName: envelope.assistantRuntime.assistantName,
              companionMode: envelope.companionMode,
            },
          }),
        });
        return;
      }

      const promptKey =
        typeof body.promptKey === 'string' ? body.promptKey.trim() : '';
      const definition = getPromptDefinition(promptKey);
      if (!definition) {
        res.status(404).json({ ok: false, error: 'Unknown prompt key' });
        return;
      }
      const targetUserId =
        typeof body.targetUserId === 'string' ? body.targetUserId.trim() : '';
      const variables =
        body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables)
          ? (body.variables as Record<string, unknown>)
          : {};
      const scenarioId =
        typeof body.scenarioId === 'string' ? body.scenarioId.trim() : '';
      if (scenarioId) {
        const scenarioPreview = await buildPromptPreviewFromScenario({
          scenarioId,
          targetUserId,
          variables,
        });
        if (scenarioPreview) {
          res.json({ ok: true, preview: scenarioPreview });
          return;
        }
      }
      const runtimePreview = await buildPromptPreviewFromRuntime({
        promptKey,
        targetUserId,
        variables,
      });
      if (runtimePreview) {
        res.json({ ok: true, preview: runtimePreview });
        return;
      }
      const resolved = await resolvePromptText({
        promptKey,
        targetUserId,
        variables,
        fallbackText: definition.defaultTemplate,
      });
      res.json({
        ok: true,
        preview: buildPromptPreviewEnvelope({
          traceKind: 'direct_provider',
          featureScope: definition.featureScope,
          promptKey,
          targetUserId: targetUserId || null,
          userPromptText: resolved.text,
          providerInputText: resolved.text,
          segments: [
            {
              id: promptKey,
              label: definition.title,
              promptKey,
              source:
                resolved.resolution.source === 'user_override'
                  ? 'user_override'
                  : resolved.resolution.source === 'system_default'
                    ? 'system_default'
                    : 'builtin',
              content: resolved.text,
            },
          ],
          resolution: [resolved.resolution],
        }),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/prompt-traces', viewGuard, async (req, res) => {
    try {
      const limit =
        typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
      const offset =
        typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0;
      const result = await listPromptTraces({
        featureScope:
          typeof req.query.featureScope === 'string'
            ? req.query.featureScope.trim()
            : undefined,
        promptKey:
          typeof req.query.promptKey === 'string'
            ? req.query.promptKey.trim()
            : undefined,
        chatJid:
          typeof req.query.chatJid === 'string'
            ? req.query.chatJid.trim()
            : undefined,
        targetUserId:
          typeof req.query.targetUserId === 'string'
            ? req.query.targetUserId.trim()
            : undefined,
        limit,
        offset,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/prompt-traces/:id', viewGuard, async (req, res) => {
    try {
      const trace = await getPromptTraceById(String(req.params.id || '').trim());
      if (!trace) {
        res.status(404).json({ ok: false, error: 'Trace not found' });
        return;
      }
      res.json({ ok: true, trace });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
