import type { Express } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { auditAdminAction, AUDIT_ACTIONS } from '../auth/audit-middleware.js';
import {
  buildPaginatedResponse,
  parsePaginationQuery,
  paginateArray,
} from '../pagination.js';
import {
  dba,
  listKnowledgeBases,
  listVisibleKnowledgeBasesPage,
  countVisibleKnowledgeBases,
  getKnowledgeBase,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  listKnowledgeDocuments,
  listKnowledgeDocumentsPage,
  countKnowledgeDocumentsForList,
  getKnowledgeDocument,
  deleteKnowledgeDocument,
  updateKnowledgeDocument,
  getVisibleProvidersForUser,
} from '../db.js';
import { adaptSql } from '../db/sql-adapters.js';
import {
  indexDocument,
  getKnowledgeLlmConcurrency,
  createKnowledgeLlmRun,
  getKnowledgeLlmRun,
  loadKnowledgeLlmRun,
  listKnowledgeProcessingActivity,
  runKnowledgeLlmEnhancementPool,
} from '../knowledge/pipeline.js';
import { extractText, detectFileType, isSupportedFile, sanitizeFilename, sanitizeRelativePath } from '../knowledge/file-extractors.js';
import { searchKnowledge } from '../knowledge/retrieval.js';
import { serializeProviderForClient } from '../provider/provider-http-config.js';
import { maskApiKey } from '../crypto.js';
import {
  listUserKnowledgeBindings,
  upsertUserKnowledgeBinding,
} from '../knowledge/user-kb-service.js';
import {
  KB_EVENT_TYPES,
  listRecentEvents,
  renderEventLogMarkdown,
  safeAppendKbEvent,
  type KbEventType,
} from '../knowledge/event-log.js';
import { regenerateOverviewPage } from '../knowledge/overview-maintainer.js';
import type { KnowledgeBaseRecord } from '../types.js';
import { getCurrentUserId, SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { t } from '../i18n/index.js';

const ABSOLUTE_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface KnowledgeRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

function paramId(raw: string | string[]): string {
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] ?? '' : '';
}

function getTenantUserId(req: import('express').Request): string {
  return (req as import('express').Request & { tenantUserId?: string }).tenantUserId || getCurrentUserId();
}

function parseWikiSourceDocIds(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw !== 'string') return [];
  const s = raw.trim();
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toCount(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function isKbVisibleToUser(
  kb: { user_id?: string | null; visibility?: string | null },
  userId: string,
): boolean {
  if (userId === SYSTEM_USER_ID) return true;
  if (kb.user_id === SYSTEM_USER_ID) return true;
  if (kb.user_id === userId) return true;
  return kb.visibility === 'shared';
}

async function resolveVisibleProviderIdsByCapability(
  userId: string,
  capability: 'llm' | 'embedding',
): Promise<Set<string>> {
  const providers = await getVisibleProvidersForUser(userId, capability);
  return new Set(providers.map((provider) => provider.id));
}
type KnowledgeGraphViewMode = 'overview' | 'focus' | 'full';
type KnowledgeGraphInclude = 'tree' | 'relations' | 'wiki_source';

const GRAPH_INCLUDE_VALUES: KnowledgeGraphInclude[] = ['tree', 'relations', 'wiki_source'];

function parseGraphViewMode(raw: unknown): KnowledgeGraphViewMode {
  return raw === 'focus' || raw === 'full' ? raw : 'overview';
}

function parseGraphMaxNodes(raw: unknown, view: KnowledgeGraphViewMode): number {
  const fallback = view === 'full' ? 500 : view === 'focus' ? 180 : 120;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(20, Math.min(2000, parsed));
}

function parseGraphInclude(raw: unknown): Set<KnowledgeGraphInclude> {
  if (typeof raw !== 'string' || !raw.trim()) return new Set(GRAPH_INCLUDE_VALUES);
  const selected = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is KnowledgeGraphInclude => GRAPH_INCLUDE_VALUES.includes(item as KnowledgeGraphInclude));
  return new Set(selected.length > 0 ? selected : GRAPH_INCLUDE_VALUES);
}

function parseGraphMinConfidence(raw: unknown, view: KnowledgeGraphViewMode): number {
  const fallback = view === 'overview' ? 0.7 : view === 'focus' ? 0.35 : 0;
  const parsed = Number.parseFloat(String(raw ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function rawGraphId(id: string): string {
  return id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
}

export function registerKnowledgeRoutes(
  app: Express,
  opts: KnowledgeRouteOptions,
): void {
  const viewGuard = opts.requirePermission('assistant.manage', 'knowledge.view');
  const editGuard = opts.requirePermission('assistant.manage', 'knowledge.edit', 'knowledge.create');
  const deleteGuard = opts.requirePermission('assistant.manage', 'knowledge.delete');
  const guard = viewGuard;

  // ---------- Knowledge Limits ----------

  app.get('/api/knowledge/limits', guard, async (_req, res) => {
    try {
      const { getKnowledgeLimitsRaw } = await import('../knowledge/limits.js');
      res.json(await getKnowledgeLimitsRaw());
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/provider-options', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const rawCapability = typeof req.query.capability === 'string' ? req.query.capability.trim() : '';
      const capability = rawCapability === 'embedding' ? 'embedding' : 'llm';
      const providers = await getVisibleProvidersForUser(userId, capability);
      res.json(
        providers.map((provider) => ({
          ...serializeProviderForClient(provider),
          api_key: provider.api_key ? maskApiKey(provider.api_key) : null,
        })),
      );
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---------- Knowledge Bases CRUD ----------

  app.get('/api/knowledge/bases', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      if (typeof req.query.page === 'string') {
        const pq = parsePaginationQuery(req);
        const offset = (pq.page - 1) * pq.pageSize;
        const [bases, total] = await Promise.all([
          listVisibleKnowledgeBasesPage(userId, SYSTEM_USER_ID, {
            search: pq.search,
            limit: pq.pageSize,
            offset,
          }),
          countVisibleKnowledgeBases(userId, SYSTEM_USER_ID, {
            search: pq.search,
          }),
        ]);
        res.json(buildPaginatedResponse(bases, total, pq));
      } else {
        const bases = await listKnowledgeBases();
        const visible = bases.filter(
          (b) =>
            b.user_id === userId ||
            b.user_id === SYSTEM_USER_ID ||
            b.visibility === 'shared',
        );
        res.json(visible);
      }
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/bases/:id', guard, async (req, res) => {
    try {
      const id = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(id);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      res.json(kb);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/bases', editGuard, async (req, res) => {
    try {
      const { name, description, chunk_size, chunk_overlap, cleanup_patterns, embedding_model, embedding_provider_id, category, visibility, enhancement_level, llm_provider_id, llm_model_override, temporal_half_life_days, allow_query_backfill } = req.body;
      if (!name) return res.status(400).json({ error: t('knowledge.nameRequired', {}, req.locale) });
      if (typeof embedding_model === 'string' && embedding_model.trim()) {
        return res.status(400).json({ error: t('knowledge.embeddingModelDeprecated', {}, req.locale) });
      }
      if (typeof llm_model_override === 'string' && llm_model_override.trim()) {
        return res.status(400).json({ error: t('knowledge.llmModelOverrideDisabled', {}, req.locale) });
      }
      const cs = chunk_size ?? 300;
      const co = chunk_overlap ?? 60;
      if (cs <= 0 || cs > 5000) return res.status(400).json({ error: t('errors.auto_b82150', {}, req.locale) });
      if (co < 0 || co >= cs) return res.status(400).json({ error: t('errors.auto_14ff03', {}, req.locale) });
      const validLevels = ['metadata', 'wiki_lite', 'wiki_full'] as const;
      const level = validLevels.includes(enhancement_level) ? enhancement_level : 'metadata';
      const userId = getTenantUserId(req);
      const visibleEmbeddingIds = await resolveVisibleProviderIdsByCapability(userId, 'embedding');
      const visibleLlmIds = await resolveVisibleProviderIdsByCapability(userId, 'llm');
      const nextEmbeddingProviderId = typeof embedding_provider_id === 'string' && embedding_provider_id.trim()
        ? embedding_provider_id.trim()
        : null;
      const nextLlmProviderId = typeof llm_provider_id === 'string' && llm_provider_id.trim()
        ? llm_provider_id.trim()
        : null;
      if (nextEmbeddingProviderId && !visibleEmbeddingIds.has(nextEmbeddingProviderId)) {
        return res.status(400).json({ error: t('knowledge.invalidEmbeddingProvider', {}, req.locale) });
      }
      if (level === 'metadata') {
        if (nextLlmProviderId) {
          return res.status(400).json({ error: t('knowledge.metadataNoLlm', {}, req.locale) });
        }
      } else {
        if (!nextLlmProviderId) {
          return res.status(400).json({ error: t('knowledge.llmRequired', {}, req.locale) });
        }
        if (!visibleLlmIds.has(nextLlmProviderId)) {
          return res.status(400).json({ error: t('knowledge.invalidLlmProvider', {}, req.locale) });
        }
      }
      const now = new Date().toISOString();
      const record: KnowledgeBaseRecord = {
        id: crypto.randomUUID(),
        name,
        description: description || null,
        owner_type: userId === SYSTEM_USER_ID ? 'system' : 'user',
        owner_id: userId === SYSTEM_USER_ID ? null : userId,
        embedding_model: null,
        embedding_provider_id: nextEmbeddingProviderId,
        chunk_size: cs,
        chunk_overlap: co,
        cleanup_patterns: cleanup_patterns || null,
        enabled: 1,
        user_id: userId,
        category: category || 'general',
        visibility: visibility || 'private',
        enhancement_level: level,
        llm_provider_id: level === 'metadata' ? null : nextLlmProviderId,
        llm_model_override: null,
        temporal_half_life_days: Math.max(1, Number(temporal_half_life_days) || 365),
        allow_query_backfill: allow_query_backfill === 1 || allow_query_backfill === true ? 1 : 0,
        created_at: now,
        updated_at: now,
      };
      await createKnowledgeBase(record);
      await auditAdminAction(req, AUDIT_ACTIONS.KB_CREATE, { targetType: 'knowledge_bases', targetId: record.id, targetName: record.name });
      res.json(record);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/knowledge/bases/:id', editGuard, async (req, res) => {
    try {
      const id = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const existing = await getKnowledgeBase(id);
      if (!existing) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(existing, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && existing.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }
      const { name, description, enabled, chunk_size, chunk_overlap, cleanup_patterns, embedding_model, embedding_provider_id, enhancement_level, llm_provider_id, llm_model_override, temporal_half_life_days, allow_query_backfill } = req.body;
      if (typeof embedding_model === 'string' && embedding_model.trim()) {
        return res.status(400).json({ error: t('knowledge.embeddingModelDeprecated', {}, req.locale) });
      }
      if (typeof llm_model_override === 'string' && llm_model_override.trim()) {
        return res.status(400).json({ error: t('knowledge.llmModelOverrideDisabled', {}, req.locale) });
      }
      const effectiveChunkSize = chunk_size ?? existing.chunk_size;
      const effectiveOverlap = chunk_overlap ?? existing.chunk_overlap;
      if (effectiveChunkSize <= 0 || effectiveChunkSize > 5000) {
        return res.status(400).json({ error: t('errors.auto_b82150', {}, req.locale) });
      }
      if (effectiveOverlap < 0 || effectiveOverlap >= effectiveChunkSize) {
        return res.status(400).json({ error: t('errors.auto_14ff03', {}, req.locale) });
      }
      const validLevels = ['metadata', 'wiki_lite', 'wiki_full'] as const;
      const levelUpdate = enhancement_level && validLevels.includes(enhancement_level) ? enhancement_level : undefined;
      const nextLevel = levelUpdate ?? existing.enhancement_level;
      const visibleEmbeddingIds = await resolveVisibleProviderIdsByCapability(userId, 'embedding');
      const visibleLlmIds = await resolveVisibleProviderIdsByCapability(userId, 'llm');
      const nextEmbeddingProviderId = embedding_provider_id !== undefined
        ? (typeof embedding_provider_id === 'string' && embedding_provider_id.trim() ? embedding_provider_id.trim() : null)
        : existing.embedding_provider_id;
      const nextLlmProviderId = llm_provider_id !== undefined
        ? (typeof llm_provider_id === 'string' && llm_provider_id.trim() ? llm_provider_id.trim() : null)
        : existing.llm_provider_id;
      if (nextEmbeddingProviderId && !visibleEmbeddingIds.has(nextEmbeddingProviderId)) {
        return res.status(400).json({ error: t('knowledge.invalidEmbeddingProvider', {}, req.locale) });
      }
      if (nextLevel === 'metadata') {
        if (nextLlmProviderId) {
          return res.status(400).json({ error: t('knowledge.metadataNoLlm', {}, req.locale) });
        }
      } else {
        if (!nextLlmProviderId) {
          return res.status(400).json({ error: t('knowledge.llmRequired', {}, req.locale) });
        }
        if (!visibleLlmIds.has(nextLlmProviderId)) {
          return res.status(400).json({ error: t('knowledge.invalidLlmProvider', {}, req.locale) });
        }
      }
      await updateKnowledgeBase(id, {
        name, description, enabled, chunk_size, chunk_overlap, cleanup_patterns,
        embedding_model: null,
        embedding_provider_id: embedding_provider_id !== undefined ? nextEmbeddingProviderId : undefined,
        enhancement_level: levelUpdate,
        llm_provider_id: nextLevel === 'metadata'
          ? null
          : (llm_provider_id !== undefined ? nextLlmProviderId : undefined),
        llm_model_override: null,
        temporal_half_life_days: temporal_half_life_days !== undefined ? Math.max(1, Number(temporal_half_life_days) || 365) : undefined,
        allow_query_backfill: allow_query_backfill !== undefined
          ? (allow_query_backfill === 1 || allow_query_backfill === true ? 1 : 0)
          : undefined,
      });
      const updated = await getKnowledgeBase(id);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/knowledge/bases/:id', deleteGuard, async (req, res) => {
    try {
      const id = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(id);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermissionDelete', {}, req.locale) });
      }
      await deleteKnowledgeBase(id);
      await auditAdminAction(req, AUDIT_ACTIONS.KB_DELETE, { targetType: 'knowledge_bases', targetId: id, targetName: kb.name });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---------- Documents ----------

  app.get('/api/knowledge/bases/:id/documents', guard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (typeof req.query.page === 'string') {
        const pq = parsePaginationQuery(req);
        const offset = (pq.page - 1) * pq.pageSize;
        const [docs, total] = await Promise.all([
          listKnowledgeDocumentsPage(kbId, {
            search: pq.search,
            limit: pq.pageSize,
            offset,
          }),
          countKnowledgeDocumentsForList(kbId, { search: pq.search }),
        ]);
        res.json(buildPaginatedResponse(docs, total, pq));
      } else {
        const docs = await listKnowledgeDocuments(kbId);
        res.json(docs);
      }
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/bases/:id/documents', editGuard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }
      const { filename: rawFilename, content, content_type, relative_path } = req.body;
      if (!rawFilename || !content) {
        return res.status(400).json({ error: t('knowledge.fileNameAndContentRequired', {}, req.locale) });
      }
      let filename: string;
      try {
        filename = sanitizeFilename(rawFilename);
      } catch {
        return res.status(400).json({ error: t('knowledge.invalidFilename', {}, req.locale) });
      }
      // ZIP-internal path: prefer explicit `relative_path`, fall back to a path-bearing `filename`.
      const zipPath = sanitizeRelativePath(relative_path) ?? sanitizeRelativePath(rawFilename);
      const { getKnowledgeLimits: getLimits } = await import('../knowledge/limits.js');
      const lim = await getLimits();
      const contentBytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0;
      if (contentBytes > lim.maxFileSizeBytes) {
        return res.status(413).json({
          error: t('knowledge.fileTooLarge', { current: (contentBytes / 1024 / 1024).toFixed(1), max: (lim.maxFileSizeBytes / 1024 / 1024).toFixed(0) }, req.locale),
        });
      }
      const doc = await indexDocument(
        kbId, filename, content, content_type || 'text/plain', undefined,
        zipPath ? { zipPath } : undefined,
      );
      res.json(doc);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/bases/:id/documents/upload', editGuard, async (req, res) => {
    const { getKnowledgeLimits: getLimits } = await import('../knowledge/limits.js');
    const lim = await getLimits();
    const effectiveLimit = Math.min(lim.maxFileSizeBytes, ABSOLUTE_MAX_UPLOAD_BYTES);
    const singleUpload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: effectiveLimit },
    }).single('file');

    singleUpload(req, res, async (err) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: t('knowledge.fileTooLargeSimple', { max: (effectiveLimit / 1024 / 1024).toFixed(0) }, req.locale),
        });
      }
      if (err) return res.status(400).json({ error: t('knowledge.uploadError', { error: err.message }, req.locale) });

      try {
        const kbId = paramId(req.params.id);
        const userId = getTenantUserId(req);
        const kb = await getKnowledgeBase(kbId);
        if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
        if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
        if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
          return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
        }

        const file = req.file;
        if (!file) return res.status(400).json({ error: t('knowledge.noFileUploaded', {}, req.locale) });

        let filename: string;
        try {
          filename = sanitizeFilename(file.originalname);
        } catch {
          return res.status(400).json({ error: t('knowledge.invalidFilename', {}, req.locale) });
        }
        if (!isSupportedFile(filename)) {
          return res.status(400).json({ error: t('knowledge.unsupportedFormat', { filename }, req.locale) });
        }
        // Honour browser dir-upload semantics if `relativePath` form field is present.
        const rawRelative = typeof req.body?.relativePath === 'string' ? req.body.relativePath : null;
        const zipPath = sanitizeRelativePath(rawRelative) ?? sanitizeRelativePath(file.originalname);

        const fileType = detectFileType(filename);
        const content = await extractText(file.buffer, filename);
        if (!content.trim()) {
          return res.status(400).json({ error: t('knowledge.fileExtractFailed', {}, req.locale) });
        }

        const extractedBytes = Buffer.byteLength(content, 'utf8');
        if (extractedBytes > lim.maxFileSizeBytes) {
          return res.status(413).json({
            error: t('knowledge.extractedTextTooLarge', { current: (extractedBytes / 1024 / 1024).toFixed(1), max: (lim.maxFileSizeBytes / 1024 / 1024).toFixed(0) }, req.locale),
          });
        }

        const contentType = fileType === 'pdf' ? 'application/pdf'
          : fileType === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'text/plain';
        const doc = await indexDocument(
          kbId, filename, content, contentType, undefined,
          zipPath ? { zipPath } : undefined,
        );
        res.json(doc);
      } catch (err) {
        res.status(500).json({ error: 'Internal error' });
      }
    });
  });

  app.delete('/api/knowledge/documents/:id', deleteGuard, async (req, res) => {
    try {
      const id = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const doc = await getKnowledgeDocument(id);
      if (!doc) return res.status(404).json({ error: t('knowledge.docNotFound', {}, req.locale) });
      const docKb = await getKnowledgeBase(doc.kb_id);
      if (!docKb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(docKb, userId)) return res.status(404).json({ error: t('knowledge.docNotFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && docKb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermissionDeleteDoc', {}, req.locale) });
      }
      await deleteKnowledgeDocument(id);
      safeAppendKbEvent({
        kbId: doc.kb_id,
        eventType: 'delete',
        docId: id,
        title: t('knowledge.docDeleted', { filename: doc.filename }, req.locale),
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/documents/:id/chunks', guard, async (req, res) => {
    try {
      const id = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const doc = await getKnowledgeDocument(id);
      if (!doc) return res.status(404).json({ error: t('knowledge.docNotFound', {}, req.locale) });
      const docKb = await getKnowledgeBase(doc.kb_id);
      if (!docKb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(docKb, userId)) return res.status(404).json({ error: t('knowledge.docNotFound', {}, req.locale) });
      const { getKnowledgeChunks } = await import('../db.js');
      const chunks = await getKnowledgeChunks(id);
      res.json(chunks);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---------- Search ----------

  app.post('/api/knowledge/search', guard, async (req, res) => {
    try {
      const { query, kb_ids, top_k, min_score } = req.body;
      if (!query) return res.status(400).json({ error: t('knowledge.queryRequired', {}, req.locale) });
      if (top_k !== undefined && (top_k < 1 || top_k > 50)) {
        return res.status(400).json({ error: t('knowledge.topKRange', {}, req.locale) });
      }
      if (min_score !== undefined && (min_score < 0 || min_score > 1)) {
        return res.status(400).json({ error: t('knowledge.minScoreRange', {}, req.locale) });
      }
      const userId = getTenantUserId(req);

      const bases = await listKnowledgeBases();
      const visibleIds = bases.filter((b) => isKbVisibleToUser(b, userId)).map((b) => b.id);

      let kbIdsForSearch: string[];
      if (Array.isArray(kb_ids) && kb_ids.length > 0) {
        const visibleSet = new Set(visibleIds);
        kbIdsForSearch = kb_ids.filter(
          (kid: unknown) => typeof kid === 'string' && visibleSet.has(kid),
        );
      } else {
        kbIdsForSearch = visibleIds;
      }

      const results = await searchKnowledge(query, {
        kbIds: kbIdsForSearch,
        topK: top_k,
        minScore: min_score,
      });
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---------- URL Import ----------

  app.post('/api/knowledge/bases/:id/import-url', editGuard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }

      const { url, max_depth, max_pages, force: rawForce } = req.body;
      if (!url || typeof url !== 'string') return res.status(400).json({ error: t('knowledge.urlRequired', {}, req.locale) });

      try { new URL(url); } catch { return res.status(400).json({ error: t('knowledge.invalidUrlFormat', {}, req.locale) }); }

      const { getKnowledgeLimits } = await import('../knowledge/limits.js');
      const limits = await getKnowledgeLimits();
      const depth = Math.min(Math.max(Number(max_depth) || 0, 0), limits.maxCrawlDepth);
      const pages = Math.min(Math.max(Number(max_pages) || 20, 1), limits.maxImportPages);

      const { importFromUrl } = await import('../knowledge/url-importer.js');
      const results = await importFromUrl({ kbId, url, maxDepth: depth, maxPages: pages, force: rawForce === true, limits });
      res.json({
        total: results.length,
        success: results.filter((r) => r.documentId).length,
        failed: results.filter((r) => !r.documentId && !r.skipped).length,
        skipped: results.filter((r) => r.skipped).length,
        results,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const safeMsg = msg.includes('SSRF') || msg.includes('安全策略') ? msg : t('knowledge.importFailedCheckUrl', {}, req.locale);
      res.status(500).json({ error: safeMsg });
    }
  });

  // ---------- User KB Bindings ----------

  app.get('/api/user/knowledge-bases', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const allBases = await listKnowledgeBases();
      const visible = allBases.filter(
        (b) => b.user_id === userId || b.user_id === SYSTEM_USER_ID || b.visibility === 'shared',
      );
      const bindings = await listUserKnowledgeBindings(userId);
      const bindingMap = new Map(bindings.map((b) => [b.kb_id, b.enabled]));
      const result = visible.map((kb) => ({
        ...kb,
        user_enabled: bindingMap.get(kb.id) ?? 0,
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/user/knowledge-bases/:id/enable', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const kbId = paramId(req.params.id);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      await upsertUserKnowledgeBinding(userId, kbId, true);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/user/knowledge-bases/:id/disable', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const kbId = paramId(req.params.id);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      await upsertUserKnowledgeBinding(userId, kbId, false);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---------- Knowledge Graph & Wiki ----------

  app.put('/api/knowledge/documents/:id/metadata', editGuard, async (req, res) => {
    try {
      const docId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const doc = await getKnowledgeDocument(docId);
      if (!doc) return res.status(404).json({ error: t('knowledge.docNotFound', {}, req.locale) });
      const docKb = await getKnowledgeBase(doc.kb_id);
      if (!docKb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(docKb, userId)) return res.status(404).json({ error: t('knowledge.docNotFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && docKb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }

      const { published_at, doc_path, parent_doc_id } = req.body as Record<string, unknown>;
      const updates: Parameters<typeof updateKnowledgeDocument>[1] = {};
      if (published_at !== undefined) updates.published_at = published_at as string | null;
      if (doc_path !== undefined) updates.doc_path = doc_path as string | null;
      if (parent_doc_id !== undefined) updates.parent_doc_id = parent_doc_id as string | null;
      await updateKnowledgeDocument(docId, updates);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/documents/:id/supersede', editGuard, async (req, res) => {
    try {
      const docId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const doc = await getKnowledgeDocument(docId);
      if (!doc) return res.status(404).json({ error: t('knowledge.docNotFound', {}, req.locale) });
      const docKb = await getKnowledgeBase(doc.kb_id);
      if (!docKb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(docKb, userId)) return res.status(404).json({ error: t('knowledge.docNotFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && docKb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }

      const { new_doc_id } = req.body as { new_doc_id?: unknown };
      if (!new_doc_id || typeof new_doc_id !== 'string') {
        return res.status(400).json({ error: t('knowledge.newDocIdRequired', {}, req.locale) });
      }
      const newId = paramId(new_doc_id);
      const newDoc = await getKnowledgeDocument(newId);
      if (!newDoc) return res.status(404).json({ error: t('knowledge.newDocNotFound', {}, req.locale) });
      if (newDoc.kb_id !== doc.kb_id) {
        return res.status(400).json({ error: t('knowledge.newDocSameKb', {}, req.locale) });
      }

      if (docId === newId) {
        return res.status(400).json({ error: t('knowledge.selfSupersede', {}, req.locale) });
      }
      let cursor = newId;
      const visited = new Set<string>([docId]);
      while (cursor) {
        if (visited.has(cursor)) {
          return res.status(400).json({ error: t('knowledge.circularSupersede', {}, req.locale) });
        }
        visited.add(cursor);
        const row = await dba.prepare('SELECT superseded_by FROM knowledge_documents WHERE id = ?').get(cursor) as { superseded_by: string | null } | undefined;
        cursor = row?.superseded_by ?? '';
      }
      const { markSuperseded } = await import('../knowledge/metadata-extractor.js');
      await markSuperseded(docId, newId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/bases/:id/tree', guard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      const docs = await dba
        .prepare(
          'SELECT id, filename, doc_path, depth, parent_doc_id, published_at, superseded_by, status, llm_status FROM knowledge_documents WHERE kb_id = ? AND deleted_at IS NULL ORDER BY doc_path ASC, created_at ASC',
        )
        .all(kbId);
      res.json(docs);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/bases/:id/relations', guard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      const relations = await dba
        .prepare(
          `SELECT r.* FROM knowledge_doc_relations r
           JOIN knowledge_documents d ON d.id = r.source_doc_id
           WHERE d.kb_id = ?`,
        )
        .all(kbId);
      res.json(relations);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/bases/:id/processing-status', guard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });

      const rows = (await dba
        .prepare(
          adaptSql(
            `SELECT id, filename, llm_status
             FROM knowledge_documents
             WHERE kb_id = ? AND deleted_at IS NULL AND status = 'indexed'`,
          ),
        )
        .all(kbId)) as Array<{
        id: string;
        filename: string;
        llm_status: string | null;
      }>;

      const eligibleTotal = rows.length;
      let pending = 0;
      let processing = 0;
      let done = 0;
      let failed = 0;

      for (const row of rows) {
        if (row.llm_status === 'processing') processing += 1;
        else if (row.llm_status === 'done') done += 1;
        else if (row.llm_status === 'failed') failed += 1;
        else pending += 1;
      }

      const activity = listKnowledgeProcessingActivity(kbId);
      const activeDocs = activity
        .slice(0, 5)
        .map((entry) => ({
          id: entry.docId,
          filename: entry.filename,
          llm_status: entry.stage === 'wiki' ? 'wiki' : 'processing',
          updated_at: entry.updatedAt,
        }));

      const wikiActiveCount = activity.filter((entry) => entry.stage === 'wiki').length;
      const llmActiveCount = Math.max(0, activity.length - wikiActiveCount);
      const run = await loadKnowledgeLlmRun(kbId);
      const runDone = run ? Math.max(0, run.completed - run.failed) : 0;
      const runFailed = run?.failed ?? 0;
      const runEligibleTotal = run?.total ?? eligibleTotal;
      const runProcessedTotal = run?.completed ?? (done + failed);
      const runQueued = run?.status === 'running' ? run.queued : 0;
      const progressPercent = runEligibleTotal > 0
        ? Math.max(0, Math.min(100, Math.round((runProcessedTotal / runEligibleTotal) * 100)))
        : 0;

      if (run) {
        pending = runQueued;
        processing = llmActiveCount;
        done = runDone;
        failed = runFailed;
      }

      const interruptedRun = run?.status === 'running' && activity.length === 0;

      let stage: 'idle' | 'llm_processing' | 'wiki_building' | 'completed' | 'partial_failed' = 'idle';
      if (run?.status === 'running' && !interruptedRun) {
        stage = wikiActiveCount > 0 && llmActiveCount === 0 ? 'wiki_building' : 'llm_processing';
      } else if (interruptedRun) {
        stage = 'partial_failed';
      } else if (run?.status === 'completed') {
        stage = run.failed > 0 ? 'partial_failed' : 'completed';
      } else {
        const hasWikiActivity = activeDocs.some((entry) => entry.llm_status === 'wiki');
        const hasLlmActivity = activeDocs.some((entry) => entry.llm_status === 'processing');
        const processedTotal = done + failed;
        if (hasWikiActivity && !hasLlmActivity) stage = 'wiki_building';
        else if (hasLlmActivity || pending > 0) stage = 'llm_processing';
        else if (eligibleTotal > 0 && processedTotal >= eligibleTotal && failed > 0) stage = 'partial_failed';
        else if (eligibleTotal > 0 && done >= eligibleTotal) stage = 'completed';
      }

      const lintRow = (await dba
        .prepare(
          adaptSql(
            `SELECT created_at, payload
             FROM knowledge_event_log
             WHERE kb_id = ? AND event_type = 'lint'
             ORDER BY created_at DESC
             LIMIT 1`,
          ),
        )
        .get(kbId)) as { created_at: string; payload: string | null } | undefined;

      const lintPayload = parseJsonObject(lintRow?.payload ?? null);

      res.json({
        run_id: run?.runId ?? null,
        run_mode: run?.mode ?? null,
        concurrency_used: run?.concurrency ?? null,
        started_at: run?.startedAt ?? null,
        finished_at: run?.finishedAt ?? null,
        eligible_total: runEligibleTotal,
        pending,
        queued: runQueued,
        processing,
        active_total: activity.length,
        wiki_processing: wikiActiveCount,
        done,
        failed,
        processed_total: runProcessedTotal,
        progress_percent: progressPercent,
        stage,
        active_docs: activeDocs,
        last_lint: lintRow
          ? {
            ran_at: lintRow.created_at,
            orphan_count: toCount(lintPayload?.orphanPages),
            stale_count: toCount(lintPayload?.stalePages),
            missing_count: toCount(lintPayload?.missingPages),
            contradiction_count: toCount(lintPayload?.contradictions),
            human_locked_count: toCount(lintPayload?.humanEditedPages),
          }
          : null,
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/bases/:id/health', guard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });

      const [docRow, vectorRow, wikiRow, relationRow] = await Promise.all([
        dba
          .prepare(
            adaptSql(
              `SELECT
                 COUNT(*) AS total_documents,
                 SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) AS indexed_documents,
                 SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_documents,
                 COALESCE(SUM(chunk_count), 0) AS document_chunk_count
               FROM knowledge_documents
               WHERE kb_id = ? AND deleted_at IS NULL`,
            ),
          )
          .get(kbId),
        dba
          .prepare(
            adaptSql(
              `SELECT
                 COUNT(c.id) AS total_chunks,
                 SUM(CASE WHEN ev.id IS NOT NULL THEN 1 ELSE 0 END) AS embedded_chunks,
                 SUM(CASE WHEN ev.id IS NULL THEN 1 ELSE 0 END) AS missing_vectors,
                 SUM(CASE
                   WHEN ev.id IS NOT NULL
                    AND p.dimensions IS NOT NULL
                    AND ev.dimensions != p.dimensions
                   THEN 1 ELSE 0 END) AS dimension_mismatch,
                 MAX(p.dimensions) AS expected_dimensions
               FROM knowledge_chunks c
               JOIN knowledge_documents d ON d.id = c.document_id
               JOIN knowledge_bases kb ON kb.id = d.kb_id
               LEFT JOIN ai_providers p ON p.id = kb.embedding_provider_id
               LEFT JOIN embedding_vectors ev
                 ON ev.owner_type = 'knowledge'
                AND ev.owner_id = c.id
                AND ev.embedding_provider_id = kb.embedding_provider_id
               WHERE d.kb_id = ?
                 AND d.deleted_at IS NULL
                 AND d.status = 'indexed'`,
            ),
          )
          .get(kbId),
        dba
          .prepare(
            adaptSql(
              `SELECT COUNT(*) AS wiki_pages FROM knowledge_wiki_pages WHERE kb_id = ?`,
            ),
          )
          .get(kbId),
        dba
          .prepare(
            adaptSql(
              `SELECT COUNT(*) AS relation_edges
               FROM knowledge_doc_relations r
               JOIN knowledge_documents d ON d.id = r.source_doc_id
               WHERE d.kb_id = ? AND d.deleted_at IS NULL`,
            ),
          )
          .get(kbId),
      ]) as Array<Record<string, unknown> | undefined>;

      const totalChunks = toCount(vectorRow?.total_chunks);
      const embeddedChunks = kb.embedding_provider_id ? toCount(vectorRow?.embedded_chunks) : 0;
      const missingVectors = kb.embedding_provider_id ? toCount(vectorRow?.missing_vectors) : totalChunks;
      const coverage = kb.embedding_provider_id && totalChunks > 0
        ? Math.round((embeddedChunks / totalChunks) * 1000) / 10
        : null;

      res.json({
        kb_id: kbId,
        enhancement_level: kb.enhancement_level,
        embedding_provider_id: kb.embedding_provider_id ?? null,
        expected_dimensions: vectorRow?.expected_dimensions == null
          ? null
          : Number(vectorRow.expected_dimensions),
        total_documents: toCount(docRow?.total_documents),
        indexed_documents: toCount(docRow?.indexed_documents),
        failed_documents: toCount(docRow?.failed_documents),
        document_chunk_count: toCount(docRow?.document_chunk_count),
        total_chunks: totalChunks,
        embedded_chunks: embeddedChunks,
        missing_vectors: missingVectors,
        dimension_mismatch: kb.embedding_provider_id ? toCount(vectorRow?.dimension_mismatch) : 0,
        vector_coverage_percent: coverage,
        vector_status: !kb.embedding_provider_id
          ? 'disabled'
          : totalChunks === 0
            ? 'empty'
            : missingVectors === 0 && toCount(vectorRow?.dimension_mismatch) === 0
              ? 'complete'
              : 'partial',
        wiki_pages: toCount(wikiRow?.wiki_pages),
        relation_edges: toCount(relationRow?.relation_edges),
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/bases/:id/graph', guard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });

      const view = parseGraphViewMode(req.query.view);
      const maxNodes = parseGraphMaxNodes(req.query.max_nodes, view);
      const include = parseGraphInclude(req.query.include);
      const minConfidence = parseGraphMinConfidence(req.query.min_confidence, view);
      const focusId = typeof req.query.focus_id === 'string' ? rawGraphId(req.query.focus_id.trim()) : '';

      const docs = (await dba
        .prepare(
          adaptSql(
            `SELECT id, filename, parent_doc_id, depth, status, llm_status
             FROM knowledge_documents
             WHERE kb_id = ? AND deleted_at IS NULL`,
          ),
        )
        .all(kbId)) as Array<{
        id: string;
        filename: string;
        parent_doc_id: string | null;
        depth: number | null;
        status: string | null;
        llm_status: string | null;
      }>;

      const wikiRows = (await dba
        .prepare(
          adaptSql(
            `SELECT id, title, page_type, source_doc_ids
             FROM knowledge_wiki_pages
             WHERE kb_id = ?`,
          ),
        )
        .all(kbId)) as Array<{
        id: string;
        title: string;
        page_type: string;
        source_doc_ids: string | null;
      }>;

      const relRows = (await dba
        .prepare(
          adaptSql(
            `SELECT r.source_doc_id, r.target_doc_id, r.relation_type, r.confidence
             FROM knowledge_doc_relations r
             JOIN knowledge_documents d ON d.id = r.source_doc_id
             WHERE d.kb_id = ?`,
          ),
        )
        .all(kbId)) as Array<{
        source_doc_id: string;
        target_doc_id: string;
        relation_type: string;
        confidence: number | null;
      }>;

      const docIdSet = new Set(docs.map((d) => d.id));
      const processedDocIds = new Set(
        docs.filter((doc) => (
          kb.enhancement_level === 'metadata'
            ? doc.status === 'indexed'
            : doc.llm_status === 'done'
        )).map((doc) => doc.id),
      );

      const nodes: Array<{
        id: string;
        label: string;
        type: 'document' | 'wiki';
        status: string;
        processed: boolean;
        llmStatus?: string | null;
        degree?: number;
        depth?: number;
        pageType?: string;
      }> = [
        ...docs.map((d) => ({
          id: d.id,
          label: d.filename,
          type: 'document' as const,
          status: d.status || 'unknown',
          processed: kb.enhancement_level === 'metadata' ? d.status === 'indexed' : d.llm_status === 'done',
          llmStatus: d.llm_status,
          depth: Number(d.depth) || 0,
        })),
        ...wikiRows.map((w) => ({
          id: w.id,
          label: w.title,
          type: 'wiki' as const,
          status: 'ready',
          processed: false,
          llmStatus: null,
          pageType: w.page_type,
        })),
      ];

      const links: Array<{
        source: string;
        target: string;
        type: string;
        confidence?: number;
      }> = [];

      const hiddenCounts = {
        nodes: 0,
        links: 0,
        unprocessed_nodes: 0,
        tree_leaf_nodes: 0,
        low_confidence_relations: 0,
        excluded_by_include: 0,
        max_nodes: 0,
        weak_wiki_source_edges: 0,
      };

      if (include.has('tree')) {
        for (const d of docs) {
          const pid = d.parent_doc_id;
          if (pid && docIdSet.has(pid) && docIdSet.has(d.id)) {
            links.push({ source: pid, target: d.id, type: 'parent_of' });
          }
        }
      } else {
        hiddenCounts.excluded_by_include += docs.filter((doc) => doc.parent_doc_id && docIdSet.has(doc.parent_doc_id)).length;
      }

      if (include.has('relations')) {
        for (const r of relRows) {
          if (!docIdSet.has(r.source_doc_id) || !docIdSet.has(r.target_doc_id)) continue;
          const conf = Number(r.confidence);
          const c = Number.isFinite(conf) ? conf : 0;
          if (c < minConfidence) {
            hiddenCounts.low_confidence_relations += 1;
            continue;
          }
          links.push({
            source: r.source_doc_id,
            target: r.target_doc_id,
            type: r.relation_type,
            confidence: c,
          });
        }
      } else {
        hiddenCounts.excluded_by_include += relRows.length;
      }

      if (include.has('wiki_source')) {
        for (const w of wikiRows) {
          const sourceIds = parseWikiSourceDocIds(w.source_doc_ids);
          const isKeyWikiPage = ['overview', 'synthesis', 'comparison'].includes(w.page_type) || sourceIds.length >= 2;
          for (const sid of sourceIds) {
            if (!docIdSet.has(sid)) continue;
            if (view === 'overview' && !isKeyWikiPage) {
              hiddenCounts.weak_wiki_source_edges += 1;
              continue;
            }
            links.push({ source: sid, target: w.id, type: 'wiki_source' });
          }
        }
      } else {
        hiddenCounts.excluded_by_include += wikiRows.reduce(
          (sum, wiki) => sum + parseWikiSourceDocIds(wiki.source_doc_ids).filter((sid) => docIdSet.has(sid)).length,
          0,
        );
      }

      for (const node of nodes) {
        if (node.type !== 'wiki') continue;
        const wikiRow = wikiRows.find((row) => row.id === node.id);
        const sourceIds = parseWikiSourceDocIds(wikiRow?.source_doc_ids ?? null);
        node.processed = sourceIds.length > 0 && sourceIds.some((id) => processedDocIds.has(id));
        node.status = node.processed ? 'ready' : 'pending';
      }

      const degreeById = new Map<string, number>();
      for (const link of links) {
        degreeById.set(link.source, (degreeById.get(link.source) ?? 0) + 1);
        degreeById.set(link.target, (degreeById.get(link.target) ?? 0) + 1);
      }
      for (const node of nodes) {
        node.degree = degreeById.get(node.id) ?? 0;
      }

      let visibleNodes = nodes;
      let visibleLinks = links;

      if (view === 'overview') {
        visibleNodes = visibleNodes.filter((node) => {
          if (node.processed !== false) return true;
          hiddenCounts.unprocessed_nodes += 1;
          return false;
        });
        const processedIds = new Set(visibleNodes.map((node) => node.id));
        visibleLinks = visibleLinks.filter((link) => processedIds.has(link.source) && processedIds.has(link.target));

        const nodeById = new Map(visibleNodes.map((node) => [node.id, node]));
        const linksByNodeId = new Map<string, Array<(typeof visibleLinks)[number]>>();
        const pushLink = (nodeId: string, link: (typeof visibleLinks)[number]) => {
          const list = linksByNodeId.get(nodeId) ?? [];
          list.push(link);
          linksByNodeId.set(nodeId, list);
        };
        for (const link of visibleLinks) {
          pushLink(link.source, link);
          pushLink(link.target, link);
        }

        const removable = new Set<string>();
        const queue: string[] = [];
        const enqueueIfPassiveLeaf = (nodeId: string) => {
          if (removable.has(nodeId)) return;
          const node = nodeById.get(nodeId);
          if (!node || node.type !== 'document') return;
          if ((node.depth ?? 0) <= 0) return;
          const attached = linksByNodeId.get(nodeId) ?? [];
          if (attached.length === 0) return;
          if (attached.length > 1) return;
          if (attached.some((link) => link.type !== 'parent_of')) return;
          removable.add(nodeId);
          queue.push(nodeId);
        };

        for (const node of visibleNodes) enqueueIfPassiveLeaf(node.id);

        while (queue.length > 0) {
          const nodeId = queue.shift()!;
          const attached = linksByNodeId.get(nodeId) ?? [];
          for (const link of attached) {
            const otherId = link.source === nodeId ? link.target : link.source;
            const nextLinks = (linksByNodeId.get(otherId) ?? []).filter((candidate) => (
              candidate.source !== nodeId && candidate.target !== nodeId
            ));
            linksByNodeId.set(otherId, nextLinks);
            enqueueIfPassiveLeaf(otherId);
          }
          linksByNodeId.set(nodeId, []);
        }

        if (removable.size > 0) {
          hiddenCounts.tree_leaf_nodes += removable.size;
          visibleNodes = visibleNodes.filter((node) => !removable.has(node.id));
          visibleLinks = visibleLinks.filter((link) => !removable.has(link.source) && !removable.has(link.target));
        }
      }

      if (view === 'focus' && focusId) {
        const adjacent = new Set<string>([focusId]);
        for (const link of visibleLinks) {
          if (link.source === focusId) adjacent.add(link.target);
          if (link.target === focusId) adjacent.add(link.source);
        }
        visibleNodes = visibleNodes.filter((node) => adjacent.has(node.id));
        visibleLinks = visibleLinks.filter((link) => adjacent.has(link.source) && adjacent.has(link.target));
      }

      if (visibleNodes.length > maxNodes) {
        const ranked = [...visibleNodes].sort((left, right) => {
          const focusBoostLeft = focusId && left.id === focusId ? 100000 : 0;
          const focusBoostRight = focusId && right.id === focusId ? 100000 : 0;
          const typeBoostLeft = left.type === 'wiki' ? 20 : 0;
          const typeBoostRight = right.type === 'wiki' ? 20 : 0;
          return (
            (focusBoostRight + typeBoostRight + (right.degree ?? 0))
            - (focusBoostLeft + typeBoostLeft + (left.degree ?? 0))
          );
        });
        const kept = new Set(ranked.slice(0, maxNodes).map((node) => node.id));
        hiddenCounts.max_nodes += visibleNodes.length - kept.size;
        visibleNodes = visibleNodes.filter((node) => kept.has(node.id));
        visibleLinks = visibleLinks.filter((link) => kept.has(link.source) && kept.has(link.target));
      }

      hiddenCounts.nodes += nodes.length - visibleNodes.length;
      hiddenCounts.links += links.length - visibleLinks.length;

      const stats = {
        view,
        max_nodes: maxNodes,
        min_confidence: minConfidence,
        focus_id: focusId || null,
        total_nodes: nodes.length,
        total_links: links.length,
        visible_nodes: visibleNodes.length,
        visible_links: visibleLinks.length,
        documents: docs.length,
        wiki_pages: wikiRows.length,
        tree_edges: links.filter((link) => link.type === 'parent_of').length,
        relation_edges: links.filter((link) => link.type !== 'parent_of' && link.type !== 'wiki_source').length,
        wiki_source_edges: links.filter((link) => link.type === 'wiki_source').length,
        include: [...include],
      };

      res.json({
        nodes: visibleNodes,
        links: visibleLinks,
        stats,
        truncated: visibleNodes.length < nodes.length || visibleLinks.length < links.length,
        hidden_counts: hiddenCounts,
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/bases/:id/llm-process', editGuard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }
      if (!kb.llm_provider_id) return res.status(400).json({ error: t('knowledge.llmProviderNotConfigured', {}, req.locale) });
      const existingRun = getKnowledgeLlmRun(kbId);
      if (existingRun?.status === 'running') {
        return res.json({
          status: 'already_running',
          run_id: existingRun.runId,
          mode: existingRun.mode,
          queued: existingRun.queued,
          eligible_total: existingRun.total,
          concurrency: existingRun.concurrency,
          started_at: existingRun.startedAt,
        });
      }

      const modeRaw = typeof req.body?.mode === 'string' ? req.body.mode.trim() : '';
      const mode = modeRaw === 'rebuild_all' || modeRaw === 'rebuild_docs' ? modeRaw : 'recover';
      const requestedDocIds = Array.isArray(req.body?.doc_ids)
        ? req.body.doc_ids.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];

      let pendingDocs: Array<{ id: string; filename: string }> = [];
      if (mode === 'rebuild_docs') {
        if (requestedDocIds.length === 0) {
          return res.status(400).json({ error: t('knowledge.docIdsRequired', {}, req.locale) });
        }
        const placeholders = requestedDocIds.map(() => '?').join(', ');
        pendingDocs = (await dba
          .prepare(
            `SELECT id, filename FROM knowledge_documents
             WHERE kb_id = ? AND deleted_at IS NULL AND status = 'indexed' AND id IN (${placeholders})
             ORDER BY created_at ASC`,
          )
          .all(kbId, ...requestedDocIds)) as Array<{ id: string; filename: string }>;
      } else if (mode === 'rebuild_all') {
        pendingDocs = (await dba
          .prepare(
            `SELECT id, filename FROM knowledge_documents
             WHERE kb_id = ? AND deleted_at IS NULL AND status = 'indexed'
             ORDER BY created_at ASC`,
          )
          .all(kbId)) as Array<{ id: string; filename: string }>;
      } else {
        pendingDocs = (await dba
          .prepare(
            `SELECT id, filename FROM knowledge_documents
             WHERE kb_id = ? AND deleted_at IS NULL AND status = 'indexed' AND (llm_status IS NULL OR llm_status = 'failed' OR llm_status = 'pending')
             ORDER BY created_at ASC`,
          )
          .all(kbId)) as Array<{ id: string; filename: string }>;
      }

      const concurrency = await getKnowledgeLlmConcurrency();
      if (pendingDocs.length === 0) {
        return res.json({
          status: 'idle',
          mode,
          run_id: null,
          queued: 0,
          eligible_total: 0,
          concurrency,
        });
      }

      const startedAt = new Date().toISOString();
      const run = createKnowledgeLlmRun(kbId, pendingDocs.length, concurrency, mode);
      setImmediate(() => {
        void runKnowledgeLlmEnhancementPool(kb, pendingDocs, concurrency);
      });

      res.json({
        status: 'started',
        mode,
        run_id: run.runId,
        queued: pendingDocs.length,
        eligible_total: pendingDocs.length,
        concurrency,
        started_at: startedAt,
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/documents/:id/rebuild-llm', editGuard, async (req, res) => {
    try {
      const docId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const doc = await getKnowledgeDocument(docId);
      if (!doc) return res.status(404).json({ error: t('knowledge.docNotFound', {}, req.locale) });
      if (doc.status !== 'indexed') return res.status(400).json({ error: t('knowledge.indexedOnly', {}, req.locale) });
      const kb = await getKnowledgeBase(doc.kb_id);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }
      if (!kb.llm_provider_id) return res.status(400).json({ error: t('knowledge.llmProviderNotConfigured', {}, req.locale) });

      const existingRun = getKnowledgeLlmRun(kb.id);
      if (existingRun?.status === 'running') {
        return res.json({
          status: 'already_running',
          run_id: existingRun.runId,
          mode: existingRun.mode,
          queued: existingRun.queued,
          eligible_total: existingRun.total,
          concurrency: existingRun.concurrency,
          started_at: existingRun.startedAt,
        });
      }

      const concurrency = await getKnowledgeLlmConcurrency();
      const run = createKnowledgeLlmRun(kb.id, 1, concurrency, 'rebuild_docs');
      setImmediate(() => {
        void runKnowledgeLlmEnhancementPool(kb, [{ id: doc.id, filename: doc.filename }], 1);
      });

      res.json({
        status: 'started',
        mode: 'rebuild_docs',
        run_id: run.runId,
        queued: 1,
        eligible_total: 1,
        concurrency: 1,
        started_at: run.startedAt,
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/bases/:id/wiki-pages', guard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      const pages = await dba
        .prepare(
          'SELECT id, kb_id, page_type, title, version, edited_by_human, edited_at, created_at, updated_at FROM knowledge_wiki_pages WHERE kb_id = ? ORDER BY page_type, title',
        )
        .all(kbId);
      res.json(pages);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/wiki-pages/:id', guard, async (req, res) => {
    try {
      const pageId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const page = (await dba.prepare('SELECT * FROM knowledge_wiki_pages WHERE id = ?').get(pageId)) as
        | Record<string, unknown>
        | undefined;
      if (!page) return res.status(404).json({ error: t('knowledge.wikiPageNotFound', {}, req.locale) });
      const kbId = String(page.kb_id ?? '');
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.wikiPageNotFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.wikiPageNotFound', {}, req.locale) });
      const { loadWikiClaimsWithEvidence } = await import('../knowledge/wiki-claims.js');
      const claimMap = await loadWikiClaimsWithEvidence([pageId]);
      res.json({
        ...page,
        claims: claimMap.get(pageId) ?? [],
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  /**
   * PR Q-Edit: PUT /api/knowledge/wiki-pages/:id  →  thin wrapper around
   * `applyWikiEdit` in `wiki-edit-service.ts`. The service owns validation,
   * permission, optimistic-lock, FTS sync, and event emission; the route is
   * just IO and `WikiEditError → HTTP status` translation.
   */
  app.put('/api/knowledge/wiki-pages/:id', editGuard, async (req, res) => {
    try {
      const pageId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const { applyWikiEdit, WikiEditError } = await import('../knowledge/wiki-edit-service.js');
      try {
        const out = await applyWikiEdit({
          pageId,
          userId,
          title: String(req.body?.title ?? ''),
          content: String(req.body?.content ?? ''),
          expectedVersion: Number(req.body?.expected_version),
        });
        res.json(out);
      } catch (e) {
        if (e instanceof WikiEditError) {
          return res.status(e.statusCode).json({ error: e.message, ...(e.details ?? {}) });
        }
        throw e;
      }
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  /**
   * PR Q-Edit: POST /api/knowledge/wiki-pages/:id/revert  →  thin wrapper
   * around `revertWikiHumanEdit`. Clearing `edited_by_human` does NOT touch
   * content / version / updated_at — revert just unlocks the page so the
   * next LLM sweep can rewrite it.
   */
  app.post('/api/knowledge/wiki-pages/:id/revert', editGuard, async (req, res) => {
    try {
      const pageId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const { revertWikiHumanEdit, WikiEditError } = await import('../knowledge/wiki-edit-service.js');
      try {
        const out = await revertWikiHumanEdit({ pageId, userId });
        res.json(out);
      } catch (e) {
        if (e instanceof WikiEditError) {
          return res.status(e.statusCode).json({ error: e.message, ...(e.details ?? {}) });
        }
        throw e;
      }
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/bases/:id/wiki-pages/backfill', editGuard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }
      const title = String(req.body?.title ?? '').trim();
      const content = String(req.body?.content ?? '').trim();
      const sourceQuery = String(req.body?.source_query ?? '').trim();
      const { backfillQueryToWiki, QueryBackfillError } = await import('../knowledge/query-backfill.js');
      try {
        const { pageId } = await backfillQueryToWiki({
          kbId,
          title,
          content,
          sourceQuery,
          userId,
        });
        res.json({ ok: true, page_id: pageId });
      } catch (e) {
        if (e instanceof QueryBackfillError) {
          return res.status(e.statusCode).json({ error: e.message });
        }
        throw e;
      }
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/bases/:id/lint', editGuard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }
      const { lintWiki } = await import('../knowledge/wiki-maintainer.js');
      const report = await lintWiki(kbId);
      const pages = (await dba
        .prepare('SELECT id FROM knowledge_wiki_pages WHERE kb_id = ?')
        .all(kbId)) as Array<{ id: string }>;
      const pageIds = pages.map((page) => page.id);
      let claimCoverage = {
        total_claims: 0,
        pages_with_claims: 0,
        pages_without_claims: pageIds.length,
        unevidenced_claims: 0,
        stale_claims: 0,
      };
      if (pageIds.length > 0) {
        const placeholders = pageIds.map(() => '?').join(', ');
        const claimRows = (await dba
          .prepare(
            `SELECT wc.page_id, wc.evidence_chunk_id, wc.updated_at, d.updated_at AS doc_updated_at
             FROM knowledge_wiki_claims wc
             LEFT JOIN knowledge_documents d ON d.id = wc.source_doc_id
             WHERE wc.page_id IN (${placeholders})`,
          )
          .all(...pageIds)) as Array<{
          page_id: string;
          evidence_chunk_id: string | null;
          updated_at: string;
          doc_updated_at: string | null;
        }>;
        const pagesWithClaims = new Set(claimRows.map((row) => row.page_id));
        claimCoverage = {
          total_claims: claimRows.length,
          pages_with_claims: pagesWithClaims.size,
          pages_without_claims: Math.max(0, pageIds.length - pagesWithClaims.size),
          unevidenced_claims: claimRows.filter((row) => !row.evidence_chunk_id).length,
          stale_claims: claimRows.filter((row) => row.doc_updated_at && row.doc_updated_at > row.updated_at).length,
        };
      }
      res.json({ ...report, claim_coverage: claimCoverage });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/bases/:id/events', guard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });

      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
      const rawType = typeof req.query.type === 'string' ? req.query.type : undefined;
      const eventType = rawType && (KB_EVENT_TYPES as readonly string[]).includes(rawType)
        ? (rawType as KbEventType)
        : undefined;
      res.json(await listRecentEvents(kbId, limit, eventType));
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/knowledge/bases/:id/events/export-md', guard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      const events = await listRecentEvents(kbId, 500);
      const md = renderEventLogMarkdown(events, kb.name);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="log-${kbId.slice(0, 8)}.md"`);
      res.send(md);
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/bases/:id/overview/refresh', editGuard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }
      await regenerateOverviewPage(kbId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---------- Index Maintenance ----------

  app.post('/api/knowledge/rebuild-fts', editGuard, async (req, res) => {
    try {
      const engine = (await import('../database/engine.js')).getActiveEngine();
      const results: Record<string, number> = {};

      if (engine.dialect === 'postgres') {
        const { getPgFtsConfig } = await import('../database/pg-fts-config.js');
        const cfg = getPgFtsConfig();

        await engine.exec(`DROP INDEX IF EXISTS idx_user_memories_fts`);
        await engine.exec(
          `CREATE INDEX IF NOT EXISTS idx_user_memories_fts
           ON user_memories USING GIN (to_tsvector('${cfg}', content))`,
        );

        const { createSearchEngine } = await import('../database/search-engine.js');
        const memorySearchEngine = createSearchEngine('postgres');
        await memorySearchEngine.initialize(engine);

        const msd = await engine.run(
          `UPDATE memory_search_documents SET search_vector = to_tsvector('${cfg}', COALESCE(title, '') || ' ' || body)
           WHERE search_vector IS NOT NULL`,
          [],
        );
        results.memory_search_documents = msd.changes;
      }

      const { getKnowledgeSearchEngine } = await import(
        '../knowledge/knowledge-search-engine.js'
      );
      const ftsEngine = getKnowledgeSearchEngine();
      if (ftsEngine.reindexAll) {
        results.knowledge_chunks = await ftsEngine.reindexAll(engine);
      }

      // Rebuild wiki page search vectors (PG only)
      if (engine.dialect === 'postgres') {
        const { getPgFtsConfig } = await import('../database/pg-fts-config.js');
        const cfg = getPgFtsConfig();
        const wikiResult = await engine.run(
          `UPDATE knowledge_wiki_pages SET search_vector = to_tsvector('${cfg}', COALESCE(title, '') || ' ' || COALESCE(content, ''))`,
          [],
        );
        results.wiki_pages_updated = (wikiResult as any)?.changes ?? 0;
      }

      res.json({ ok: true, ftsConfig: engine.dialect === 'postgres'
        ? (await import('../database/pg-fts-config.js')).getPgFtsConfig()
        : engine.dialect, ...results });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/backfill-embeddings', editGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const kbId = req.body?.kb_id ? paramId(req.body.kb_id) : undefined;
      if (kbId) {
        const kb = await getKnowledgeBase(kbId);
        if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
        if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
        if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
          return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
        }
      }
      const { backfillEmbeddings } = await import('../knowledge/pipeline.js');
      const result = await backfillEmbeddings(kbId ? { kbId } : undefined);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/knowledge/rebuild-embeddings', editGuard, async (_req, res) => {
    try {
      const { rebuildAllKnowledgeEmbeddings } = await import('../knowledge/pipeline.js');
      res.json(await rebuildAllKnowledgeEmbeddings());
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  app.post('/api/knowledge/bases/:id/reclean', editGuard, async (req, res) => {
    try {
      const kbId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (!isKbVisibleToUser(kb, userId)) return res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
      if (userId !== SYSTEM_USER_ID && kb.user_id !== userId) {
        return res.status(403).json({ error: t('knowledge.noPermission', {}, req.locale) });
      }
      const { recleanKnowledgeBase } = await import('../knowledge/pipeline.js');
      const result = await recleanKnowledgeBase(kbId);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
