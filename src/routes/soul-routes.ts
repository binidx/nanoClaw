import type { Express } from 'express';
import crypto from 'crypto';

import {
  buildPaginatedResponse,
  parsePaginationQuery,
  paginateArray,
} from '../pagination.js';
import { ensureUserByUsername } from '../user/user-service.js';
import {
  getSoul,
  upsertSoul,
  removeSoul,
  applySoulPreset,
  listUnifiedMemories,
  addUnifiedMemory,
  editUnifiedMemory,
  removeUnifiedMemory,
} from '../soul/soul-service.js';
import {
  listUserMemoryObservations,
  deleteUserMemoryObservation,
  listPersonaInsights,
  updatePersonaInsight,
  listMemoryConsolidationLogs,
  getUserMemories,
  countMemoryEvents,
  listMemoryEvents,
  listMemoryDocuments,
  listMemorySkills,
  addMemorySkill,
  addPersonaInsight,
  addUserMemoryObservation,
  updateMemorySkill,
  deleteMemorySkill,
} from '../db.js';
import {
  runConsolidation,
  promoteObservationById,
} from '../soul/soul-consolidation.js';
import { SOUL_PRESETS } from '../soul/soul-presets.js';
import { t } from '../i18n/index.js';

export interface SoulRouteOptions {
  getAuthenticatedUsername: (cookieHeader?: string) => string | null;
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

async function resolveUserId(
  cookieHeader: string | undefined,
  opts: SoulRouteOptions,
): Promise<string | null> {
  const username = opts.getAuthenticatedUsername(cookieHeader);
  if (!username) return null;
  const user = await ensureUserByUsername(username);
  return user.id;
}

export function registerSoulRoutes(app: Express, opts: SoulRouteOptions): void {
  const viewGuard = opts.requirePermission('soul.view');
  const manageGuard = opts.requirePermission('soul.manage');
  // ---------- Soul CRUD ----------

  app.get('/api/soul', viewGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const soul = await getSoul(userId);
      res.json({ ok: true, soul: soul ?? null });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.put('/api/soul', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const body = req.body || {};
      const soul = await upsertSoul(userId, {
        name: body.name,
        emoji: body.emoji,
        emojiEnabled: body.emojiEnabled,
        creature: body.creature,
        vibe: body.vibe,
        personaPrompt: body.personaPrompt,
        tone: body.tone,
        languagePreference: body.languagePreference,
        extraInstructions: body.extraInstructions,
        userNickname: body.userNickname,
        behaviorRules: body.behaviorRules,
        autoEvolve: body.autoEvolve,
        consolidationConfig: body.consolidationConfig,
        enabled: body.enabled,
      });
      res.json({ ok: true, soul });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.delete('/api/soul', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      await removeSoul(userId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ---------- Presets ----------

  app.get('/api/soul/presets', viewGuard, (_req, res) => {
    res.json({
      ok: true,
      presets: SOUL_PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
      })),
    });
  });

  app.post('/api/soul/preset', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const { presetId } = req.body || {};
      if (!presetId || typeof presetId !== 'string') {
        res.status(400).json({
          ok: false,
          error: t('soul.templateRequired', {}, req.locale),
        });
        return;
      }
      const soul = await applySoulPreset(userId, presetId);
      if (!soul) {
        res.status(404).json({
          ok: false,
          error: t('soul.templateNotFound', {}, req.locale),
        });
        return;
      }
      res.json({ ok: true, soul });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ---------- Unified Memories (user_memories table) ----------

  app.get('/api/soul/memories', viewGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const category =
        typeof req.query.category === 'string' ? req.query.category : undefined;
      const scope =
        typeof req.query.scope === 'string' ? req.query.scope : undefined;
      const limit =
        typeof req.query.limit === 'string'
          ? parseInt(req.query.limit, 10)
          : undefined;
      const memories = await listUnifiedMemories(userId, {
        category,
        scope,
        limit,
      });
      res.json({ ok: true, memories });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/soul/memories', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const body = req.body || {};
      if (
        !body.content ||
        typeof body.content !== 'string' ||
        !body.content.trim()
      ) {
        res
          .status(400)
          .json({ ok: false, error: t('soul.memoryRequired', {}, req.locale) });
        return;
      }
      const memory = await addUnifiedMemory(userId, {
        category: body.category,
        content: body.content,
        importance: body.importance,
        source: body.source || 'manual',
        scope: body.scope,
        conversationId: body.conversationId,
        expiresAt: body.expiresAt,
      });
      res.json({ ok: true, memory });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.put('/api/soul/memories/:id', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string'
          ? rawId
          : Array.isArray(rawId)
            ? (rawId[0] ?? '')
            : '';
      const body = req.body || {};
      await editUnifiedMemory(id, userId, {
        content: body.content,
        category: body.category,
        importance: body.importance,
        scope: body.scope,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.delete('/api/soul/memories/:id', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string'
          ? rawId
          : Array.isArray(rawId)
            ? (rawId[0] ?? '')
            : '';
      await removeUnifiedMemory(id, userId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ---------- Observations ----------

  app.get('/api/soul/observations', viewGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const observationType =
        typeof req.query.type === 'string' ? req.query.type : undefined;
      const limit =
        typeof req.query.limit === 'string'
          ? parseInt(req.query.limit, 10)
          : undefined;
      const observations = await listUserMemoryObservations(userId, {
        observationType,
        limit,
      });
      res.json({ ok: true, observations });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.delete('/api/soul/observations/:id', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string'
          ? rawId
          : Array.isArray(rawId)
            ? (rawId[0] ?? '')
            : '';
      await deleteUserMemoryObservation(id, userId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ---------- Persona Insights ----------

  app.get('/api/soul/insights', viewGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const status =
        typeof req.query.status === 'string' ? req.query.status : undefined;
      const insights = await listPersonaInsights(userId, { status });
      res.json({ ok: true, insights });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.put('/api/soul/insights/:id', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string'
          ? rawId
          : Array.isArray(rawId)
            ? (rawId[0] ?? '')
            : '';
      const body = req.body || {};
      await updatePersonaInsight(id, userId, {
        status: body.status,
        content: body.content,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ---------- Consolidation ----------

  app.post('/api/soul/consolidate', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const log = await runConsolidation(userId, 'manual');
      res.json({ ok: true, log });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isLock = msg.includes(t('errors.auto_5cb9ae', {}, req.locale));
      res.status(isLock ? 409 : 500).json({ ok: false, error: msg });
    }
  });

  app.get('/api/soul/consolidation-log', viewGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const limit =
        typeof req.query.limit === 'string'
          ? parseInt(req.query.limit, 10)
          : 20;
      const logs = await listMemoryConsolidationLogs(userId, limit);
      res.json({ ok: true, logs });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ---------- Observation Promote ----------

  app.post(
    '/api/soul/observations/:id/promote',
    manageGuard,
    async (req, res) => {
      try {
        const userId = await resolveUserId(req.headers.cookie, opts);
        if (!userId) {
          res.status(401).json({ ok: false, error: 'Unauthorized' });
          return;
        }
        const rawId = req.params.id;
        const id =
          typeof rawId === 'string'
            ? rawId
            : Array.isArray(rawId)
              ? (rawId[0] ?? '')
              : '';
        const result = await promoteObservationById(userId, id);
        res.json({ ok: true, memoryId: result.memoryId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ ok: false, error: msg });
      }
    },
  );

  // ---------- Export / Import ----------

  app.get('/api/soul/export', viewGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const soul = await getSoul(userId);
      const memories = await getUserMemories(userId, { limit: 1000 });
      const observations = await listUserMemoryObservations(userId, {
        limit: 1000,
      });
      const allInsights = await listPersonaInsights(userId, { limit: 1000 });
      const skills = await listMemorySkills({ userId, limit: 1000 });
      res.json({
        ok: true,
        data: {
          exportedAt: new Date().toISOString(),
          version: 2,
          soul: soul ?? null,
          memories,
          observations,
          insights: allInsights,
          skills,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/soul/import', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const { data, dryRun } = req.body || {};
      if (!data || typeof data !== 'object') {
        res
          .status(400)
          .json({ ok: false, error: t('soul.invalidImport', {}, req.locale) });
        return;
      }
      const memories = Array.isArray(data.memories) ? data.memories : [];
      const observations = Array.isArray(data.observations)
        ? data.observations
        : [];
      const insights = Array.isArray(data.insights) ? data.insights : [];
      const skills = Array.isArray(data.skills) ? data.skills : [];
      const summary = {
        soul: data.soul ? 1 : 0,
        memories: memories.length,
        observations: observations.length,
        insights: insights.length,
        skills: skills.length,
      };
      if (dryRun) {
        res.json({ ok: true, dryRun: true, summary });
        return;
      }

      const importedSoul = data.soul;
      if (importedSoul) {
        await upsertSoul(userId, {
          name: importedSoul.name,
          emoji: importedSoul.emoji,
          emojiEnabled: !!importedSoul.emoji_enabled,
          creature: importedSoul.creature,
          vibe: importedSoul.vibe,
          personaPrompt: importedSoul.persona_prompt,
          tone: importedSoul.tone,
          languagePreference: importedSoul.language_preference,
          extraInstructions: importedSoul.extra_instructions,
          userNickname: importedSoul.user_nickname,
          behaviorRules: importedSoul.behavior_rules,
          autoEvolve: !!importedSoul.auto_evolve,
          consolidationConfig: importedSoul.consolidation_config,
          enabled: importedSoul.enabled !== 0,
        });
      }

      const existingMemoryKeys = new Set(
        (await getUserMemories(userId, { limit: 5000, timeScope: 'all' })).map(
          (memory) =>
            [
              memory.scope,
              memory.conversation_id ?? '',
              memory.category,
              memory.content.trim(),
            ].join('\u0000'),
        ),
      );
      for (const memory of memories) {
        if (!memory?.content || typeof memory.content !== 'string') continue;
        const scope = memory.scope ?? 'global';
        const conversationId =
          memory.conversation_id ?? memory.conversationId ?? null;
        const category = memory.category ?? 'general';
        const content = memory.content.trim();
        const key = [scope, conversationId ?? '', category, content].join(
          '\u0000',
        );
        if (existingMemoryKeys.has(key)) continue;
        await addUnifiedMemory(userId, {
          category,
          content,
          importance: memory.importance,
          source: memory.source || 'manual',
          scope,
          conversationId,
          tier: memory.tier,
          promotedFrom: memory.promoted_from ?? memory.promotedFrom,
          expiresAt: memory.expires_at ?? memory.expiresAt ?? null,
        });
        existingMemoryKeys.add(key);
      }

      const now = new Date().toISOString();
      const existingObservationKeys = new Set(
        (await listUserMemoryObservations(userId, { limit: 5000 })).map(
          (observation) =>
            [
              observation.conversation_id ?? '',
              observation.category,
              observation.observation_type,
              observation.content.trim(),
            ].join('\u0000'),
        ),
      );
      for (const observation of observations) {
        if (!observation?.content || typeof observation.content !== 'string')
          continue;
        const category = observation.category ?? 'general';
        const observationType = observation.observation_type ?? 'context_note';
        const conversationId = observation.conversation_id ?? null;
        const content = observation.content.trim();
        const key = [
          conversationId ?? '',
          category,
          observationType,
          content,
        ].join('\u0000');
        if (existingObservationKeys.has(key)) continue;
        await addUserMemoryObservation({
          id: crypto.randomUUID(),
          user_id: userId,
          conversation_id: conversationId,
          category,
          content,
          observation_type: observationType,
          frequency: Number.isFinite(observation.frequency)
            ? observation.frequency
            : 1,
          last_seen_at: observation.last_seen_at ?? now,
          confidence: Number.isFinite(observation.confidence)
            ? observation.confidence
            : 0.5,
          source: observation.source ?? 'import',
          promoted_to: null,
          expires_at: observation.expires_at ?? null,
          created_at: now,
          updated_at: now,
        });
        existingObservationKeys.add(key);
      }
      const existingInsightKeys = new Set(
        (await listPersonaInsights(userId, { limit: 5000 })).map((insight) =>
          [insight.insight_type, insight.content.trim()].join('\u0000'),
        ),
      );
      for (const insight of insights) {
        if (!insight?.content || typeof insight.content !== 'string') continue;
        const insightType = insight.insight_type ?? 'communication_style';
        const content = insight.content.trim();
        const key = [insightType, content].join('\u0000');
        if (existingInsightKeys.has(key)) continue;
        await addPersonaInsight({
          id: crypto.randomUUID(),
          user_id: userId,
          insight_type: insightType,
          content,
          evidence_count: Number.isFinite(insight.evidence_count)
            ? insight.evidence_count
            : 1,
          confidence: Number.isFinite(insight.confidence)
            ? insight.confidence
            : 0.5,
          status: insight.status ?? 'candidate',
          created_at: now,
          updated_at: now,
        });
        existingInsightKeys.add(key);
      }
      const existingSkillKeys = new Set(
        (await listMemorySkills({ userId, limit: 5000 })).map((skill) =>
          [
            skill.scope,
            skill.name.trim(),
            skill.trigger_pattern.trim(),
            skill.body.trim(),
          ].join('\u0000'),
        ),
      );
      for (const skill of skills) {
        if (!skill?.name || !skill?.body) continue;
        const scope = skill.scope ?? 'global';
        const name = String(skill.name).trim();
        const triggerPattern = skill.trigger_pattern ?? '';
        const body = String(skill.body).trim();
        const key = [scope, name, triggerPattern.trim(), body].join('\u0000');
        if (existingSkillKeys.has(key)) continue;
        await addMemorySkill({
          id: crypto.randomUUID(),
          user_id: userId,
          scope,
          name,
          trigger_pattern: triggerPattern,
          body,
          termination_condition: skill.termination_condition ?? null,
          success_count: 0,
          failure_count: 0,
          last_used_at: null,
          last_verified_at: null,
          status: skill.status ?? 'candidate',
          metadata_json: skill.metadata_json ?? null,
          created_at: now,
          updated_at: now,
        });
        existingSkillKeys.add(key);
      }
      res.json({
        ok: true,
        message: t('errors.auto_a44f14', {}, req.locale),
        summary,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ---------- Memory Events (Raw Ledger) ----------

  app.get('/api/soul/memory-events', viewGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const actionType =
        typeof req.query.actionType === 'string'
          ? req.query.actionType
          : undefined;
      if (typeof req.query.page === 'string') {
        const pq = parsePaginationQuery(req);
        const offset = (pq.page - 1) * pq.pageSize;
        const [events, total] = await Promise.all([
          listMemoryEvents({
            userId,
            actionType,
            limit: pq.pageSize,
            offset,
          }),
          countMemoryEvents({ userId, actionType }),
        ]);
        res.json({ ok: true, ...buildPaginatedResponse(events, total, pq) });
      } else {
        const limit =
          typeof req.query.limit === 'string'
            ? parseInt(req.query.limit, 10)
            : 100;
        const events = await listMemoryEvents({
          userId,
          actionType,
          limit: Math.min(limit, 500),
        });
        res.json({ ok: true, events });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ---------- Memory Documents ----------

  app.get('/api/soul/memory-documents', viewGuard, async (req, res) => {
    try {
      const scope =
        typeof req.query.scope === 'string'
          ? (req.query.scope as 'group' | 'global' | 'workspace')
          : undefined;
      const limit =
        typeof req.query.limit === 'string'
          ? parseInt(req.query.limit, 10)
          : 200;
      const documents = await listMemoryDocuments({
        scope,
        limit: Math.min(limit, 500),
      });
      res.json({ ok: true, documents });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ---------- Memory Skills ----------

  app.get('/api/soul/memory-skills', viewGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const status =
        typeof req.query.status === 'string' ? req.query.status : undefined;
      const skills = await listMemorySkills({ userId, status });
      res.json({ ok: true, skills });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.put('/api/soul/memory-skills/:id', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string'
          ? rawId
          : Array.isArray(rawId)
            ? (rawId[0] ?? '')
            : '';
      const body = req.body || {};
      const updated = await updateMemorySkill(
        id,
        {
          status: body.status,
          name: body.name,
          trigger_pattern: body.trigger_pattern,
          body: body.body,
        },
        userId,
      );
      if (!updated) {
        res.status(404).json({ ok: false, error: 'Memory skill not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.delete('/api/soul/memory-skills/:id', manageGuard, async (req, res) => {
    try {
      const userId = await resolveUserId(req.headers.cookie, opts);
      if (!userId) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string'
          ? rawId
          : Array.isArray(rawId)
            ? (rawId[0] ?? '')
            : '';
      const deleted = await deleteMemorySkill(id, userId);
      if (!deleted) {
        res.status(404).json({ ok: false, error: 'Memory skill not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
