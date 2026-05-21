import crypto from 'crypto';
import {
  createKnowledgeDocument,
  updateKnowledgeDocument,
  insertKnowledgeChunks,
  deleteKnowledgeChunksByDocument,
  getKnowledgeBase,
  getKnowledgeDocument,
  getKnowledgeChunks,
  getProvider,
  getRuntimeState,
  listKnowledgeBases,
  listKnowledgeDocuments,
  setRuntimeState,
} from '../db.js';
import { getActiveEngine } from '../database/engine.js';
import { getConfigValue } from '../config-store.js';
import { buildEmbeddingProviderFromAiProvider } from '../embedding/resolve.js';
import { batchEmbedAndStore } from '../embedding/vector-store.js';
import { chunkText } from './chunker.js';
import { getKnowledgeSearchEngine } from './knowledge-search-engine.js';
import { createModuleLogger } from '../logger.js';
import { dba } from '../db/engine-access.js';
import { safeAppendKbEvent } from './event-log.js';
import type { KnowledgeDocumentRecord, KnowledgeChunkRecord, KnowledgeBaseRecord } from '../types.js';
import { t } from '../i18n/index.js';

const logger = createModuleLogger('knowledge');
export const DEFAULT_KB_LLM_CONCURRENCY = 4;
const KNOWLEDGE_LLM_RUN_STATE_PREFIX = 'knowledge_llm_run:';
const MAX_KB_LLM_CONCURRENCY = 16;

export type KnowledgeProcessingActivityStage = 'llm' | 'wiki';
export type KnowledgeLlmRunMode = 'recover' | 'rebuild_all' | 'rebuild_docs';

export interface KnowledgeProcessingActivity {
  docId: string;
  kbId: string;
  filename: string;
  stage: KnowledgeProcessingActivityStage;
  updatedAt: string;
}

export interface KnowledgeLlmRunState {
  runId: string;
  kbId: string;
  mode: KnowledgeLlmRunMode;
  total: number;
  queued: number;
  completed: number;
  failed: number;
  concurrency: number;
  status: 'running' | 'completed';
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const knowledgeProcessingActivity = new Map<string, KnowledgeProcessingActivity>();
const knowledgeLlmRunsByKb = new Map<string, KnowledgeLlmRunState>();

interface KnowledgeLlmQueueTask {
  docId: string;
  kbId: string;
  filename: string;
  content: string;
  kb: KnowledgeBaseRecord;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
  onStart?: () => void;
  onFinish?: (failed: boolean) => void;
}

interface KnowledgeLlmQueueState {
  concurrency: number;
  active: number;
  pumping: boolean;
  queue: KnowledgeLlmQueueTask[];
  queuedByDocId: Map<string, KnowledgeLlmQueueTask>;
}

const knowledgeLlmQueues = new Map<string, KnowledgeLlmQueueState>();

function getKnowledgeLlmQueueState(kbId: string, concurrency: number): KnowledgeLlmQueueState {
  const existing = knowledgeLlmQueues.get(kbId);
  if (existing) {
    existing.concurrency = Math.max(1, Math.min(concurrency, MAX_KB_LLM_CONCURRENCY));
    return existing;
  }
  const state: KnowledgeLlmQueueState = {
    concurrency: Math.max(1, Math.min(concurrency, MAX_KB_LLM_CONCURRENCY)),
    active: 0,
    pumping: false,
    queue: [],
    queuedByDocId: new Map(),
  };
  knowledgeLlmQueues.set(kbId, state);
  return state;
}

async function executeKnowledgeLlmQueueTask(task: KnowledgeLlmQueueTask): Promise<void> {
  task.onStart?.();
  try {
    await runTrackedLlmEnhancement(task.kbId, task.docId, task.filename, task.content, task.kb);
    task.onFinish?.(false);
    task.resolve();
  } catch (err) {
    task.onFinish?.(true);
    task.reject(err);
    throw err;
  }
}

function pumpKnowledgeLlmQueue(kbId: string): void {
  const state = knowledgeLlmQueues.get(kbId);
  if (!state || state.pumping) return;
  state.pumping = true;

  try {
    while (state.active < state.concurrency) {
      const task = state.queue.shift();
      if (!task) break;

      state.active += 1;
      void executeKnowledgeLlmQueueTask(task)
        .catch((err) => {
          logger.warn({ err, kbId: task.kbId, docId: task.docId }, 'Knowledge LLM queue task failed');
        })
        .finally(() => {
          state.active = Math.max(0, state.active - 1);
          const current = state.queuedByDocId.get(task.docId);
          if (current === task) {
            state.queuedByDocId.delete(task.docId);
          }
          if (state.queue.length > 0) {
            queueMicrotask(() => pumpKnowledgeLlmQueue(kbId));
          }
        });
    }
  } finally {
    state.pumping = false;
  }
}

async function enqueueKnowledgeLlmEnhancement(
  kb: KnowledgeBaseRecord,
  docId: string,
  filename: string,
  content: string,
  concurrency: number,
  hooks?: {
    onStart?: () => void;
    onFinish?: (failed: boolean) => void;
  },
): Promise<void> {
  const state = getKnowledgeLlmQueueState(kb.id, concurrency);
  const existing = state.queuedByDocId.get(docId);
  if (existing) return existing.promise;

  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const task: KnowledgeLlmQueueTask = {
    docId,
    kbId: kb.id,
    filename,
    content,
    kb,
    promise,
    resolve,
    reject,
    onStart: hooks?.onStart,
    onFinish: hooks?.onFinish,
  };

  state.queue.push(task);
  state.queuedByDocId.set(docId, task);
  pumpKnowledgeLlmQueue(kb.id);
  return promise;
}

export async function getKnowledgeLlmConcurrency(): Promise<number> {
  const raw = await getConfigValue('KB_LLM_CONCURRENCY');
  const parsed = Number.parseInt(String(raw || ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_KB_LLM_CONCURRENCY;
  return Math.max(1, Math.min(MAX_KB_LLM_CONCURRENCY, parsed));
}

function getKnowledgeLlmRunStateKey(kbId: string): string {
  return `${KNOWLEDGE_LLM_RUN_STATE_PREFIX}${kbId}`;
}

async function persistKnowledgeLlmRunState(state: KnowledgeLlmRunState): Promise<void> {
  await setRuntimeState(getKnowledgeLlmRunStateKey(state.kbId), JSON.stringify(state));
}

function persistKnowledgeLlmRunStateBestEffort(state: KnowledgeLlmRunState): void {
  void persistKnowledgeLlmRunState(state).catch((err) => {
    logger.warn({ err, kbId: state.kbId, runId: state.runId }, 'Failed to persist knowledge LLM run state');
  });
}

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function updateKnowledgeProcessingActivity(
  docId: string,
  kbId: string,
  filename: string,
  stage: KnowledgeProcessingActivityStage,
): void {
  knowledgeProcessingActivity.set(docId, {
    docId,
    kbId,
    filename,
    stage,
    updatedAt: new Date().toISOString(),
  });
}

function clearKnowledgeProcessingActivity(docId: string): void {
  knowledgeProcessingActivity.delete(docId);
}

export function listKnowledgeProcessingActivity(kbId: string): KnowledgeProcessingActivity[] {
  return [...knowledgeProcessingActivity.values()]
    .filter((entry) => entry.kbId === kbId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function touchKnowledgeLlmRun(
  kbId: string,
  mutate: (current: KnowledgeLlmRunState) => KnowledgeLlmRunState,
): KnowledgeLlmRunState | null {
  const current = knowledgeLlmRunsByKb.get(kbId);
  if (!current) return null;
  const next = mutate(current);
  knowledgeLlmRunsByKb.set(kbId, next);
  persistKnowledgeLlmRunStateBestEffort(next);
  return next;
}

export function createKnowledgeLlmRun(
  kbId: string,
  total: number,
  concurrency: number,
  mode: KnowledgeLlmRunMode,
): KnowledgeLlmRunState {
  const now = new Date().toISOString();
  const state: KnowledgeLlmRunState = {
    runId: crypto.randomUUID(),
    kbId,
    mode,
    total,
    queued: total,
    completed: 0,
    failed: 0,
    concurrency: Math.max(1, concurrency),
    status: 'running',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  knowledgeLlmRunsByKb.set(kbId, state);
  persistKnowledgeLlmRunStateBestEffort(state);
  return state;
}

export function getKnowledgeLlmRun(kbId: string): KnowledgeLlmRunState | null {
  const state = knowledgeLlmRunsByKb.get(kbId);
  return state ? { ...state } : null;
}

export async function loadKnowledgeLlmRun(kbId: string): Promise<KnowledgeLlmRunState | null> {
  const inMemory = getKnowledgeLlmRun(kbId);
  if (inMemory) return inMemory;
  try {
    const raw = await getRuntimeState(getKnowledgeLlmRunStateKey(kbId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KnowledgeLlmRunState;
    if (!parsed || parsed.kbId !== kbId) return null;
    knowledgeLlmRunsByKb.set(kbId, parsed);
    return { ...parsed };
  } catch (err) {
    logger.warn({ err, kbId }, 'Failed to load persisted knowledge LLM run state');
    return null;
  }
}

export function clearKnowledgeLlmRun(kbId: string): void {
  knowledgeLlmRunsByKb.delete(kbId);
}

function markKnowledgeLlmRunDocStarted(kbId: string): void {
  touchKnowledgeLlmRun(kbId, (current) => ({
    ...current,
    queued: Math.max(0, current.queued - 1),
    updatedAt: new Date().toISOString(),
  }));
}

function markKnowledgeLlmRunDocFinished(kbId: string, failed: boolean): void {
  touchKnowledgeLlmRun(kbId, (current) => {
    const completed = Math.min(current.total, current.completed + 1);
    const failedCount = current.failed + (failed ? 1 : 0);
    const finishedAt = completed >= current.total ? new Date().toISOString() : null;
    return {
      ...current,
      completed,
      failed: failedCount,
      status: completed >= current.total ? 'completed' : current.status,
      updatedAt: new Date().toISOString(),
      finishedAt,
    };
  });
}

function deduplicateChunks(chunks: import('./chunker.js').TextChunk[], docId: string): KnowledgeChunkRecord[] {
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const records: KnowledgeChunkRecord[] = [];

  for (const c of chunks) {
    const hash = contentHash(c.content);
    if (seen.has(hash)) {
      logger.debug({ docId, chunkIndex: c.index }, 'Skipped duplicate chunk');
      continue;
    }
    seen.add(hash);
    records.push({
      id: crypto.randomUUID(),
      document_id: docId,
      chunk_index: c.index,
      content: c.content,
      token_count: c.tokenEstimate,
      created_at: now,
    });
  }

  if (records.length < chunks.length) {
    logger.info({ docId, original: chunks.length, deduped: records.length }, 'Chunk dedup removed duplicates');
  }
  return records;
}

function buildKnowledgeChunkEmbeddingText(
  doc: Pick<KnowledgeDocumentRecord, 'filename' | 'doc_path' | 'source_url' | 'published_at'>,
  chunk: Pick<KnowledgeChunkRecord, 'content' | 'chunk_index'>,
): string {
  const contextLines = [
    doc.filename ? `Document: ${doc.filename}` : null,
    doc.doc_path ? `Path: ${doc.doc_path}` : null,
    doc.source_url ? `Source URL: ${doc.source_url}` : null,
    doc.published_at ? `Published at: ${doc.published_at}` : null,
    `Chunk: ${chunk.chunk_index + 1}`,
  ].filter((line): line is string => Boolean(line));
  return `${contextLines.join('\n')}\n\n${chunk.content}`;
}

function buildKnowledgeChunkEmbeddingItems(
  doc: Pick<KnowledgeDocumentRecord, 'filename' | 'doc_path' | 'source_url' | 'published_at'>,
  chunks: KnowledgeChunkRecord[],
): Array<{ ownerId: string; text: string }> {
  return chunks.map((chunk) => ({
    ownerId: chunk.id,
    text: buildKnowledgeChunkEmbeddingText(doc, chunk),
  }));
}

async function resolveKnowledgeEmbeddingProvider(
  kb: Pick<KnowledgeBaseRecord, 'id' | 'embedding_provider_id'>,
) {
  if (!kb.embedding_provider_id) return null;
  const provider = await getProvider(kb.embedding_provider_id);
  if (!provider) {
    logger.warn({ kbId: kb.id, providerId: kb.embedding_provider_id }, 'Knowledge base embedding provider not found');
    return null;
  }
  const embeddingProvider = buildEmbeddingProviderFromAiProvider(provider);
  if (!embeddingProvider) {
    logger.warn({ kbId: kb.id, providerId: provider.id }, 'Knowledge base embedding provider is invalid');
    return null;
  }
  return { provider, embeddingProvider };
}

async function runPostIndexEnhancement(
  kbId: string,
  docId: string,
  content: string,
  kb: KnowledgeBaseRecord,
  sourceUrl?: string,
  filename?: string,
  htmlMeta?: Record<string, string>,
  zipPath?: string,
): Promise<void> {
  // L1: metadata extraction (always runs, zero LLM cost)
  try {
    const {
      extractPublishedAt,
      buildDocPath,
      findParentDoc,
      detectSupersession,
      markSuperseded,
    } = await import('./metadata-extractor.js');

    const publishedAt = extractPublishedAt(content, sourceUrl, htmlMeta);
    const { docPath, depth } = buildDocPath(sourceUrl, zipPath);

    let parentDocId: string | null = null;
    if (docPath) {
      parentDocId = await findParentDoc(kbId, docPath);
    }

    const metaUpdates: Partial<KnowledgeDocumentRecord> = {};
    if (publishedAt) metaUpdates.published_at = publishedAt;
    if (docPath) { metaUpdates.doc_path = docPath; metaUpdates.depth = depth; }
    if (parentDocId) metaUpdates.parent_doc_id = parentDocId;
    // updateKnowledgeDocument is a no-op when no defined fields were collected.
    await updateKnowledgeDocument(docId, metaUpdates);

    const supersededDocId = await detectSupersession(kbId, docId, sourceUrl ?? null, filename ?? '');
    if (supersededDocId) {
      await markSuperseded(supersededDocId, docId);
      logger.info({ kbId, docId, supersededDocId }, 'Document superseded older version');
    }
  } catch (err) {
    logger.warn({ err, docId }, 'L1 metadata extraction failed (non-fatal)');
  }

  // L2/L3: async LLM enhancement (fire-and-forget)
  if (kb.enhancement_level === 'wiki_lite' || kb.enhancement_level === 'wiki_full') {
    if (kb.llm_provider_id) {
      await updateKnowledgeDocument(docId, { llm_status: 'pending' });
      const concurrency = await getKnowledgeLlmConcurrency();
      void enqueueKnowledgeLlmEnhancement(kb, docId, filename || docId, content, concurrency).catch((err) => {
        logger.warn({ err, docId }, 'Async LLM enhancement failed');
      });
    } else {
      logger.warn({ kbId }, 'L2/L3 mode configured but no llm_provider_id set');
    }
  }
}

/** In-process de-dup for concurrent enhancement runs on the same document. */
const llmEnhancementInFlight = new Map<string, Promise<void>>();

function parseSummaryJsonField<T>(raw: unknown, docId: string, label: string, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    logger.warn({ docId, label }, 'Malformed JSON in summary, using fallback');
    return fallback;
  }
}

/**
 * Run L2 (summary + relations) and conditional L3 (wiki page maintenance) for a single document.
 * Caller is responsible for choosing sync/async invocation; this function awaits all work.
 *
 * Used both by the post-index pipeline (via setImmediate) and the manual `POST .../llm-process`
 * route, so manual retries always re-run wiki maintenance for `wiki_full` KBs.
 *
 * Concurrent calls for the same `docId` share a single in-flight promise to avoid running
 * the LLM chain twice (e.g. rapid manual retries while indexing is still settling).
 */
export async function runLlmEnhancementChain(
  kbId: string,
  docId: string,
  content: string,
  kb: KnowledgeBaseRecord,
  opts?: {
    onStageChange?: (stage: KnowledgeProcessingActivityStage) => void;
  },
): Promise<void> {
  if (!kb.llm_provider_id) return;
  const existing = llmEnhancementInFlight.get(docId);
  if (existing) return existing;

  const promise = (async () => {
    const llmConfig = {
      userId: kb.user_id,
      llmProviderId: kb.llm_provider_id!,
    };

    opts?.onStageChange?.('llm');
    const { enhanceDocumentWithLlm } = await import('./llm-enhancer.js');
    await enhanceDocumentWithLlm(kbId, docId, content, llmConfig);
    safeAppendKbEvent({
      kbId,
      eventType: 'llm_enhance',
      docId,
      title: `LLM 增强完成（${kb.enhancement_level}）`,
    });

    if (kb.enhancement_level !== 'wiki_full') return;

    try {
      opts?.onStageChange?.('wiki');
      const summaryRow = (await dba
        .prepare('SELECT * FROM knowledge_doc_summaries WHERE document_id = ?')
        .get(docId)) as Record<string, unknown> | undefined;
      if (!summaryRow) return;

      const entities = parseSummaryJsonField<Array<{ name: string; type: string; salience: number }>>(
        summaryRow.entities, docId, 'entities', [],
      );
      const topics = parseSummaryJsonField<string[]>(summaryRow.topics, docId, 'topics', []);

      const { updateOrCreateWikiPages } = await import('./wiki-maintainer.js');
      await updateOrCreateWikiPages(
        kbId, docId, entities, topics, String(summaryRow.summary ?? ''), llmConfig,
      );
    } catch (wikiErr) {
      logger.warn({ err: wikiErr, docId }, 'L3 wiki update failed (non-fatal)');
    }
  })();

  llmEnhancementInFlight.set(docId, promise);
  try {
    return await promise;
  } finally {
    llmEnhancementInFlight.delete(docId);
  }
}

async function runTrackedLlmEnhancement(
  kbId: string,
  docId: string,
  filename: string,
  content: string,
  kb: KnowledgeBaseRecord,
): Promise<void> {
  updateKnowledgeProcessingActivity(docId, kbId, filename, 'llm');
  try {
    await runLlmEnhancementChain(kbId, docId, content, kb, {
      onStageChange(stage) {
        updateKnowledgeProcessingActivity(docId, kbId, filename, stage);
      },
    });
  } finally {
    clearKnowledgeProcessingActivity(docId);
  }
}

async function loadKnowledgeDocumentContent(docId: string): Promise<string> {
  const chunks = (await dba
    .prepare(
      'SELECT content FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index ASC',
    )
    .all(docId)) as Array<{ content: string }>;
  return chunks.map((chunk) => chunk.content).join('\n\n');
}

export async function runKnowledgeLlmEnhancementPool(
  kb: KnowledgeBaseRecord,
  docs: Array<{ id: string; filename: string }>,
  concurrency: number = DEFAULT_KB_LLM_CONCURRENCY,
): Promise<void> {
  if (!kb.llm_provider_id || docs.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, docs.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const currentIndex = cursor;
        cursor += 1;
        const doc = docs[currentIndex];
        if (!doc) return;

        let content: string;
        try {
          content = await loadKnowledgeDocumentContent(doc.id);
        } catch (err) {
          markKnowledgeLlmRunDocStarted(kb.id);
          markKnowledgeLlmRunDocFinished(kb.id, true);
          logger.warn({ err, kbId: kb.id, docId: doc.id }, 'Manual KB LLM enhancement worker failed to load content');
          continue;
        }

        try {
          await enqueueKnowledgeLlmEnhancement(
            kb,
            doc.id,
            doc.filename,
            content,
            concurrency,
            {
              onStart() {
                markKnowledgeLlmRunDocStarted(kb.id);
              },
              onFinish(failed) {
                markKnowledgeLlmRunDocFinished(kb.id, failed);
              },
            },
          );
        } catch (err) {
          logger.warn({ err, kbId: kb.id, docId: doc.id }, 'Manual KB LLM enhancement worker failed');
        }
      }
    }),
  );
}

export interface IndexDocumentOptions {
  /** Pre-extracted HTML meta tag values; preferred source for `published_at`. */
  htmlMeta?: Record<string, string>;
  /** ZIP-internal relative path (with subdirectories); drives `doc_path` / `depth`. */
  zipPath?: string;
}

export async function indexDocument(
  kbId: string,
  filename: string,
  content: string,
  contentType: string = 'text/plain',
  sourceUrl?: string,
  opts?: IndexDocumentOptions,
): Promise<KnowledgeDocumentRecord> {
  const kb = await getKnowledgeBase(kbId);
  if (!kb) throw new Error(t('knowledge.notFound', {}, undefined));

  const hash = contentHash(content);
  const now = new Date().toISOString();
  const docId = crypto.randomUUID();

  const doc: KnowledgeDocumentRecord = {
    id: docId,
    kb_id: kbId,
    filename,
    content_type: contentType,
    content_hash: hash,
    char_count: content.length,
    chunk_count: 0,
    status: 'pending',
    error_message: null,
    source_url: sourceUrl ?? null,
    published_at: null,
    superseded_by: null,
    parent_doc_id: null,
    doc_path: null,
    depth: 0,
    llm_status: null,
    created_at: now,
    updated_at: now,
  };

  await createKnowledgeDocument(doc);

  try {
    await updateKnowledgeDocument(docId, { status: 'indexing' });

    const chunks = chunkText(content, {
      chunkSize: kb.chunk_size,
      chunkOverlap: kb.chunk_overlap,
    });

    const chunkRecords = deduplicateChunks(chunks, docId);

    await insertKnowledgeChunks(chunkRecords);

    try {
      const ftsEngine = getKnowledgeSearchEngine();
      await ftsEngine.indexChunks(getActiveEngine(), chunkRecords);
    } catch (ftsErr) {
      logger.warn({ err: ftsErr, docId }, 'FTS indexing failed (non-fatal)');
    }

    const embeddingConfig = await resolveKnowledgeEmbeddingProvider(kb);
    if (embeddingConfig) {
      await batchEmbedAndStore(
        'knowledge',
        buildKnowledgeChunkEmbeddingItems(doc, chunkRecords),
        embeddingConfig.embeddingProvider,
        embeddingConfig.provider.id,
      );
    }

    await updateKnowledgeDocument(docId, {
      status: 'indexed',
      chunk_count: chunkRecords.length,
    });

    doc.status = 'indexed';
    doc.chunk_count = chunkRecords.length;
    logger.info({ docId, filename, chunks: chunkRecords.length }, 'Document indexed');
    safeAppendKbEvent({
      kbId,
      eventType: 'ingest',
      docId,
      title: `${filename} 入库（${chunkRecords.length} chunks）`,
    });

    await runPostIndexEnhancement(
      kbId, docId, content, kb, sourceUrl, filename,
      opts?.htmlMeta, opts?.zipPath,
    );
    const indexedDoc = await getKnowledgeDocument(docId);
    if (indexedDoc) Object.assign(doc, indexedDoc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { await deleteKnowledgeChunksByDocument(docId); } catch { /* best-effort cleanup */ }
    await updateKnowledgeDocument(docId, { status: 'failed', error_message: msg });
    doc.status = 'failed';
    doc.error_message = msg;
    logger.error({ err, docId }, 'Document indexing failed');
  }

  return doc;
}

export async function reindexDocument(
  docId: string,
  content: string,
  opts?: { skipEmbedding?: boolean },
): Promise<void> {
  const doc = await getKnowledgeDocument(docId);
  if (!doc) throw new Error(t('knowledge.docNotFound', {}, undefined));

  const kb = await getKnowledgeBase(doc.kb_id);
  if (!kb) throw new Error(t('knowledge.notFound', {}, undefined));

  const hash = contentHash(content);
  if (hash === doc.content_hash) return;

  try {
    try {
      const ftsEngine = getKnowledgeSearchEngine();
      await ftsEngine.deleteByDocumentId(getActiveEngine(), docId);
    } catch { /* best-effort FTS cleanup */ }

    await deleteKnowledgeChunksByDocument(docId);

    const chunks = chunkText(content, {
      chunkSize: kb.chunk_size,
      chunkOverlap: kb.chunk_overlap,
    });

    const chunkRecords = deduplicateChunks(chunks, docId);

    await insertKnowledgeChunks(chunkRecords);

    try {
      const ftsEngine = getKnowledgeSearchEngine();
      await ftsEngine.indexChunks(getActiveEngine(), chunkRecords);
    } catch (ftsErr) {
      logger.warn({ err: ftsErr, docId }, 'FTS reindexing failed (non-fatal)');
    }

    if (!opts?.skipEmbedding) {
      const embeddingConfig = await resolveKnowledgeEmbeddingProvider(kb);
      if (embeddingConfig) {
        await batchEmbedAndStore(
          'knowledge',
          buildKnowledgeChunkEmbeddingItems(doc, chunkRecords),
          embeddingConfig.embeddingProvider,
          embeddingConfig.provider.id,
        );
      }
    }

    await updateKnowledgeDocument(docId, {
      status: 'indexed',
      chunk_count: chunkRecords.length,
      content_hash: hash,
      char_count: content.length,
    });
    safeAppendKbEvent({
      kbId: doc.kb_id,
      eventType: 'reindex',
      docId,
      title: `${doc.filename} 重新索引（${chunkRecords.length} chunks）`,
    });

    // Run L1/L2/L3 enhancement
    await runPostIndexEnhancement(doc.kb_id, docId, content, kb, doc.source_url ?? undefined, doc.filename);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateKnowledgeDocument(docId, { status: 'failed', error_message: msg });
    logger.error({ err, docId }, 'Document reindexing failed');
    throw err;
  }
}

/**
 * Finds knowledge chunks that have no embedding vectors and embeds them
 * with the current provider. Skips chunks that already have vectors
 * (regardless of model/dimensions — use re-embed for model changes).
 */
export async function backfillEmbeddings(
  opts?: { kbId?: string },
): Promise<{ embedded: number; skipped: number }> {
  const kbFilter = opts?.kbId
    ? `AND d.kb_id = ?`
    : '';
  const params: unknown[] = opts?.kbId ? [opts.kbId] : [];

  const unembedded = (await dba
    .prepare(
      `SELECT c.id, c.content, c.chunk_index,
              d.filename, d.doc_path, d.source_url, d.published_at,
              kb.embedding_provider_id
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.id = c.document_id
       JOIN knowledge_bases kb ON kb.id = d.kb_id
       WHERE d.status = 'indexed'
         AND kb.embedding_provider_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM embedding_vectors ev
           WHERE ev.owner_type = 'knowledge'
             AND ev.owner_id = c.id
             AND ev.embedding_provider_id = kb.embedding_provider_id
         )
         ${kbFilter}
       ORDER BY c.created_at ASC`,
    )
    .all(...params)) as Array<{
    id: string;
    content: string;
    chunk_index: number;
    filename: string | null;
    doc_path: string | null;
    source_url: string | null;
    published_at: string | null;
    embedding_provider_id: string | null;
  }>;

  if (unembedded.length === 0) return { embedded: 0, skipped: 0 };

  const groups = new Map<string, Array<{ ownerId: string; text: string }>>();
  for (const row of unembedded) {
    if (!row.embedding_provider_id) continue;
    const group = groups.get(row.embedding_provider_id) ?? [];
    group.push({
      ownerId: row.id,
      text: buildKnowledgeChunkEmbeddingText(
        {
          filename: row.filename ?? '',
          doc_path: row.doc_path,
          source_url: row.source_url,
          published_at: row.published_at,
        },
        {
          content: row.content,
          chunk_index: Number(row.chunk_index ?? 0),
        },
      ),
    });
    groups.set(row.embedding_provider_id, group);
  }

  const BATCH = 50;
  let embedded = 0;
  let skipped = 0;
  for (const [providerId, items] of groups.entries()) {
    const provider = await getProvider(providerId);
    const embeddingProvider = provider ? buildEmbeddingProviderFromAiProvider(provider) : null;
    if (!provider || !embeddingProvider) {
      skipped += items.length;
      logger.warn({ providerId, count: items.length }, 'Skipping knowledge embedding backfill for invalid provider');
      continue;
    }
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      try {
        const count = await batchEmbedAndStore(
          'knowledge',
          batch,
          embeddingProvider,
          provider.id,
        );
        embedded += count;
      } catch (err) {
        skipped += batch.length;
        logger.warn({ err, batch: batch.length, providerId }, 'Backfill embedding batch failed');
      }
    }
  }
  skipped += Math.max(0, unembedded.length - embedded - skipped);

  logger.info(
    { embedded, total: unembedded.length },
    'Knowledge embedding backfill complete',
  );
  return { embedded, skipped };
}

export async function rebuildAllKnowledgeEmbeddings(): Promise<{ rebuilt: number; skipped: number }> {
  const knowledgeRows = (await dba
    .prepare(
      `SELECT c.id, c.content, c.chunk_index,
              d.filename, d.doc_path, d.source_url, d.published_at,
              kb.embedding_provider_id
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.id = c.document_id
       JOIN knowledge_bases kb ON kb.id = d.kb_id
       WHERE d.status = 'indexed'
         AND d.deleted_at IS NULL
         AND kb.deleted_at IS NULL
         AND kb.embedding_provider_id IS NOT NULL
       ORDER BY c.created_at ASC`,
    )
    .all()) as Array<{
    id: string;
    content: string;
    chunk_index: number;
    filename: string | null;
    doc_path: string | null;
    source_url: string | null;
    published_at: string | null;
    embedding_provider_id: string | null;
  }>;

  if (knowledgeRows.length === 0) return { rebuilt: 0, skipped: 0 };

  await dba.prepare(`DELETE FROM embedding_vectors WHERE owner_type = 'knowledge'`).run();

  const groups = new Map<string, Array<{ ownerId: string; text: string }>>();
  for (const row of knowledgeRows) {
    if (!row.embedding_provider_id) continue;
    const group = groups.get(row.embedding_provider_id) ?? [];
    group.push({
      ownerId: row.id,
      text: buildKnowledgeChunkEmbeddingText(
        {
          filename: row.filename ?? '',
          doc_path: row.doc_path,
          source_url: row.source_url,
          published_at: row.published_at,
        },
        {
          content: row.content,
          chunk_index: Number(row.chunk_index ?? 0),
        },
      ),
    });
    groups.set(row.embedding_provider_id, group);
  }

  const BATCH = 50;
  let rebuilt = 0;
  let skipped = 0;
  for (const [providerId, items] of groups.entries()) {
    const provider = await getProvider(providerId);
    const embeddingProvider = provider ? buildEmbeddingProviderFromAiProvider(provider) : null;
    if (!provider || !embeddingProvider) {
      skipped += items.length;
      logger.warn({ providerId, count: items.length }, 'Skipping knowledge embedding rebuild for invalid provider');
      continue;
    }
    try {
      for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH);
        rebuilt += await batchEmbedAndStore(
          'knowledge',
          batch,
          embeddingProvider,
          provider.id,
        );
      }
    } catch (err) {
      skipped += items.length;
      logger.warn({ err, providerId, count: items.length }, 'Knowledge embedding rebuild failed for provider');
    }
  }

  logger.info({ rebuilt, skipped, total: knowledgeRows.length }, 'Knowledge embedding rebuild complete');
  return { rebuilt, skipped };
}

/**
 * Re-cleans all documents in a knowledge base:
 *   Pass 1 — read chunks and collect boilerplate statistics (no full-text caching)
 *   Pass 2 — re-read chunks, apply boilerplate filter + cleanContent, reindex or delete
 *
 * Embedding is skipped for speed — run "向量补录" afterwards.
 */
export async function recleanKnowledgeBase(
  kbId: string,
): Promise<{ total: number; processed: number; cleaned: number; deleted: number; unchanged: number; failed: number }> {
  const { cleanContent, BoilerplateCollector } = await import('./content-cleaner.js');
  const { deleteKnowledgeDocument } = await import('../db.js');

  const kb = await getKnowledgeBase(kbId);
  if (!kb) throw new Error(t('knowledge.notFound', {}, undefined));

  const docs = await listKnowledgeDocuments(kbId);
  const indexedDocs = docs.filter((d) => d.status === 'indexed');

  // Pass 1: scan all docs for boilerplate stats — text is NOT cached
  const READ_CONCURRENCY = 20;
  const collector = new BoilerplateCollector();
  const emptyDocIds = new Set<string>();
  let readFailed = 0;

  for (let i = 0; i < indexedDocs.length; i += READ_CONCURRENCY) {
    const batch = indexedDocs.slice(i, i + READ_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (doc) => {
        const chunks = await getKnowledgeChunks(doc.id);
        const text = chunks.map((c) => c.content).join('\n\n');
        return { id: doc.id, text, hasChunks: chunks.length > 0 };
      }),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        if (!r.value.hasChunks || !r.value.text.trim()) {
          emptyDocIds.add(r.value.id);
          logger.warn({ docId: r.value.id }, 'Reclean: indexed document has no chunks or empty content');
        } else {
          collector.addDocument(r.value.text);
        }
      } else {
        readFailed++;
        logger.error({ err: r.reason }, 'Reclean: failed to read chunks for document');
      }
    }
  }

  const stripBoilerplate = collector.buildFilter();

  // Pass 2: re-read each doc, clean, and decide action — concurrent batches
  let processed = 0;
  let cleaned = 0;
  let deleted = 0;
  let unchanged = 0;
  let failed = 0;

  const WRITE_CONCURRENCY = 10;

  // First: handle empty/broken docs — delete them
  const emptyDocs = indexedDocs.filter((d) => emptyDocIds.has(d.id));
  for (let i = 0; i < emptyDocs.length; i += WRITE_CONCURRENCY) {
    const batch = emptyDocs.slice(i, i + WRITE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (doc) => {
        logger.info({ docId: doc.id, filename: doc.filename }, 'Reclean: indexed document has no content, deleting');
        await deleteKnowledgeDocument(doc.id);
      }),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        failed++;
        logger.error({ err: r.reason }, 'Reclean: failed to delete empty document');
      } else {
        deleted++;
        processed++;
      }
    }
  }

  failed += readFailed;

  // Then: process remaining docs
  const validDocs = indexedDocs.filter((d) => !emptyDocIds.has(d.id));

  for (let i = 0; i < validDocs.length; i += WRITE_CONCURRENCY) {
    const batch = validDocs.slice(i, i + WRITE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (doc) => {
        const chunks = await getKnowledgeChunks(doc.id);
        const raw = chunks.map((c) => c.content).join('\n\n');

        const stripped = stripBoilerplate(raw);
        const cleanedText = cleanContent(stripped, kb!.cleanup_patterns);

        if (!cleanedText || cleanedText.length < 40) {
          logger.info({ docId: doc.id, filename: doc.filename, originalLen: raw.length }, 'Reclean: content is junk, deleting document');
          await deleteKnowledgeDocument(doc.id);
          return 'deleted' as const;
        }

        if (cleanedText === raw) return 'unchanged' as const;

        await reindexDocument(doc.id, cleanedText, { skipEmbedding: true });
        return 'cleaned' as const;
      }),
    );

    for (const r of results) {
      if (r.status === 'rejected') {
        failed++;
        logger.error({ err: r.reason }, 'Reclean failed for document');
      } else if (r.value === 'deleted') {
        deleted++;
        processed++;
      } else if (r.value === 'cleaned') {
        cleaned++;
        processed++;
      } else {
        unchanged++;
      }
    }
  }

  logger.info({ kbId, total: indexedDocs.length, processed, cleaned, deleted, unchanged, failed }, 'Knowledge base reclean complete');
  return { total: indexedDocs.length, processed, cleaned, deleted, unchanged, failed };
}
