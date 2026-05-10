import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { dba } from '../db/engine-access.js';
import { adaptSql } from '../db/sql-adapters.js';
import { callKbLlm, type KbLlmConfig } from './llm-call.js';
import type {
  KnowledgeDocRelationRecord,
  KnowledgeDocSummaryRecord,
  KnowledgeRelationType,
} from '../types/context.js';
import { t } from '../i18n/index.js';

const RELATION_TYPES = new Set<string>(['supersedes', 'supplements', 'contradicts', 'references']);

// ── Embedding LRU cache ──
const EMBED_CACHE_MAX = 512;
const embedCache = new Map<string, number[]>();

function embedCacheKey(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function putEmbedCache(text: string, vec: number[]): void {
  const key = embedCacheKey(text);
  embedCache.delete(key);
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value!;
    embedCache.delete(oldest);
  }
  embedCache.set(key, vec);
}

function getEmbedCache(text: string): number[] | undefined {
  const key = embedCacheKey(text);
  const vec = embedCache.get(key);
  if (vec) {
    embedCache.delete(key);
    embedCache.set(key, vec);
  }
  return vec;
}

function stripMarkdownJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(trimmed);
  if (fence) return fence[1].trim();
  return trimmed;
}

function extractBalancedJsonFragment(raw: string, opener: '{' | '['): string | null {
  const closer = opener === '{' ? '}' : ']';
  const start = raw.indexOf(opener);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === '\\') {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1).trim();
      }
    }
  }
  return null;
}

function normalizeJsonPayload(text: string, kind: 'object' | 'array'): string {
  const body = stripMarkdownJsonFence(text);
  const direct = body.trim();
  if (!direct) return direct;
  if (kind === 'object' && direct.startsWith('{') && direct.endsWith('}')) return direct;
  if (kind === 'array' && direct.startsWith('[') && direct.endsWith(']')) return direct;
  const extracted = extractBalancedJsonFragment(direct, kind === 'object' ? '{' : '[');
  return extracted ?? direct;
}

function parseJsonObject<T>(raw: string): T {
  const body = normalizeJsonPayload(raw, 'object');
  return JSON.parse(body) as T;
}

function parseJsonArray<T>(raw: string): T[] {
  const body = normalizeJsonPayload(raw, 'array');
  const parsed = JSON.parse(body) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array');
  }
  return parsed as T[];
}

function normalizeSourceContent(content: string): string {
  const dedupedLines: string[] = [];
  let previous = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trimEnd();
    const normalized = line.trim();
    if (normalized && normalized === previous) continue;
    dedupedLines.push(normalized ? rawLine : '');
    previous = normalized;
  }
  return dedupedLines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function splitContentBlocks(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function appendBudgetedBlocks(
  target: string[],
  blocks: string[],
  indexes: number[],
  budget: number,
  seen: Set<number>,
): number {
  let used = 0;
  for (const index of indexes) {
    if (used >= budget || seen.has(index)) continue;
    const block = blocks[index];
    if (!block) continue;
    const nextLength = block.length + (target.length > 0 ? 2 : 0);
    if (used > 0 && used + nextLength > budget) break;
    target.push(block);
    seen.add(index);
    used += nextLength;
  }
  return used;
}

function buildRepresentativeExcerpt(content: string, maxTotal = 9000): string {
  if (content.length <= maxTotal) return content;

  const blocks = splitContentBlocks(content);
  if (blocks.length === 0) return content.slice(0, maxTotal);
  if (blocks.length === 1) return `${blocks[0]!.slice(0, maxTotal)}\n\n...[已截断]`;

  const seen = new Set<number>();
  const selected: string[] = [];
  const headBudget = Math.floor(maxTotal * 0.38);
  const midBudget = Math.floor(maxTotal * 0.37);
  const tailBudget = Math.floor(maxTotal * 0.2);

  const headIndexes = blocks.map((_, index) => index);
  const tailIndexes = blocks.map((_, index) => blocks.length - 1 - index);
  appendBudgetedBlocks(selected, blocks, headIndexes, headBudget, seen);

  const midIndexes: number[] = [];
  const remaining = blocks.length - seen.size;
  const sampleCount = Math.min(8, Math.max(3, Math.floor(remaining / 2)));
  if (sampleCount > 0) {
    for (let i = 1; i <= sampleCount; i += 1) {
      const ratio = i / (sampleCount + 1);
      midIndexes.push(Math.floor((blocks.length - 1) * ratio));
    }
  }
  appendBudgetedBlocks(selected, blocks, midIndexes, midBudget, seen);
  appendBudgetedBlocks(selected, blocks, tailIndexes, tailBudget, seen);

  let excerpt = selected.join('\n\n');
  if (excerpt.length > maxTotal) excerpt = excerpt.slice(0, maxTotal);
  return `${excerpt}\n\n...[已按文档结构抽样，省略其余内容]`;
}

function tokenizeForOverlap(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_\u0080-\uffff]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);
  return new Set(words);
}

function keywordOverlapScore(a: string, b: string): number {
  const sa = tokenizeForOverlap(a);
  const sb = tokenizeForOverlap(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) {
    if (sb.has(w)) inter += 1;
  }
  return inter / Math.min(sa.size, sb.size);
}

async function setLlmStatus(docId: string, status: string, expectedPrev?: string): Promise<boolean> {
  const now = new Date().toISOString();
  if (expectedPrev) {
    const sql = adaptSql(
      `UPDATE knowledge_documents SET llm_status = ?, updated_at = ? WHERE id = ? AND llm_status = ?`,
    );
    const result = await dba.prepare(sql).run(status, now, docId, expectedPrev) as unknown as { changes?: number };
    return (result?.changes ?? 0) > 0;
  }
  const sql = adaptSql(
    `UPDATE knowledge_documents SET llm_status = ?, updated_at = ? WHERE id = ?`,
  );
  await dba.prepare(sql).run(status, now, docId);
  return true;
}

function startHeartbeat(docId: string, intervalMs = 120_000): () => void {
  const timer = setInterval(() => {
    dba.prepare(
      adaptSql(`UPDATE knowledge_documents SET updated_at = ? WHERE id = ? AND llm_status = 'processing'`),
    ).run(new Date().toISOString(), docId).catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}

async function generateSummary(
  docId: string,
  docContent: string,
  config: KbLlmConfig,
): Promise<KnowledgeDocSummaryRecord> {
  const meta = (await dba
    .prepare(
      adaptSql(
        `SELECT filename, doc_path, published_at
         FROM knowledge_documents
         WHERE id = ?`,
      ),
    )
    .get(docId)) as {
    filename?: string | null;
    doc_path?: string | null;
    published_at?: string | null;
  } | undefined;
  const truncatedContent = buildRepresentativeExcerpt(normalizeSourceContent(docContent));
  const docMetaLines = [
    meta?.filename ? `文件名: ${meta.filename}` : null,
    meta?.doc_path ? `文档路径: ${meta.doc_path}` : null,
    meta?.published_at ? `发布日期: ${meta.published_at}` : null,
  ].filter(Boolean);
  const prompt = `请分析以下文档内容，输出 JSON 格式结果：
{
  "summary": t('prompts.auto_e7dcc4', {}, undefined),
  "entities": [{"name": t('prompts.auto_d041a5', {}, undefined), "type": "person|product|concept|term|org", "salience": 0.0-1.0}],
  "topics": [t('prompts.auto_9d383c', {}, undefined), t('prompts.auto_7811d8', {}, undefined)]
}

文档元信息：
---
${docMetaLines.length > 0 ? docMetaLines.join('\n') : t('errors.auto_d81bb2', {}, undefined)}
---

文档内容：
---
${truncatedContent}
---

要求：
- summary 优先写事实、定义、约束、步骤，避免空话
- 如果文档是操作说明，summary 必须包含关键步骤
- 如果文档是版本更新，summary 必须包含影响模块与新增/变更点
- topics 只保留 2-6 个高信号主题，避免“系统/功能/文档”这类空泛标签

请只输出 JSON，不要包含其他内容。`;

  const raw = await callKbLlm(config, prompt, {
    maxTokens: 2000,
    temperature: 0.3,
    jsonMode: true,
  });

  let parsed: {
    summary?: string;
    entities?: Array<{ name?: string; type?: string; salience?: number }>;
    topics?: string[];
  };
  try {
    parsed = parseJsonObject(raw);
  } catch (err) {
    logger.error({ err, docId }, 'Failed to parse KB summary JSON');
    throw err;
  }

  const summaryText = (parsed.summary || '').trim();
  if (!summaryText) {
    throw new Error('KB summary JSON missing summary');
  }

  const entitiesJson = JSON.stringify(parsed.entities || []);
  const topicsJson = JSON.stringify(parsed.topics || []);

  const { getProvider } = await import('../db/assistants.js');
  const provider = await getProvider(config.llmProviderId);
  const llmModel = provider?.model || null;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await dba.prepare(adaptSql(`DELETE FROM knowledge_doc_summaries WHERE document_id = ?`)).run(docId);
  const insertSql = adaptSql(
    `INSERT INTO knowledge_doc_summaries
      (id, document_id, summary, entities, topics, llm_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await dba
    .prepare(insertSql)
    .run(id, docId, summaryText, entitiesJson, topicsJson, llmModel, now, now);

  return {
    id,
    document_id: docId,
    summary: summaryText,
    entities: entitiesJson,
    topics: topicsJson,
    llm_model: llmModel,
    created_at: now,
    updated_at: now,
  };
}

type CandidateSummary = {
  document_id: string;
  summary: string;
};

async function loadOtherSummariesInKb(
  kbId: string,
  excludeDocId: string,
): Promise<CandidateSummary[]> {
  const sql = adaptSql(
    `SELECT s.document_id AS document_id, s.summary AS summary
     FROM knowledge_doc_summaries s
     INNER JOIN knowledge_documents d ON d.id = s.document_id
     WHERE d.kb_id = ?
       AND d.deleted_at IS NULL
       AND s.document_id != ?`,
  );
  const rows = (await dba.prepare(sql).all(kbId, excludeDocId)) as CandidateSummary[];
  return rows;
}

/** Embedding-based candidate selection cap: avoids O(N) embed calls on huge KBs. */
const EMBEDDING_CANDIDATE_CAP = 100;

async function pickTopCandidates(
  docSummary: string,
  candidates: CandidateSummary[],
  limit: number,
): Promise<CandidateSummary[]> {
  if (candidates.length <= limit) return candidates;

  if (candidates.length <= EMBEDDING_CANDIDATE_CAP) {
    try {
      const [{ resolveEmbeddingProvider }, { cosineSimilarity }] = await Promise.all([
        import('../embedding/resolve.js'),
        import('../embedding/vector-store.js'),
      ]);
      const provider = await resolveEmbeddingProvider();
      if (provider) {
        const queryVec = getEmbedCache(docSummary) ?? await provider.embedQuery(docSummary);
        putEmbedCache(docSummary, queryVec);

        const missIdxs: number[] = [];
        const candidateVecs: Array<number[]> = new Array(candidates.length);
        for (let i = 0; i < candidates.length; i++) {
          const cached = getEmbedCache(candidates[i]!.summary);
          if (cached) candidateVecs[i] = cached;
          else missIdxs.push(i);
        }
        if (missIdxs.length > 0) {
          const freshVecs = await provider.embed(missIdxs.map((i) => candidates[i]!.summary));
          for (let j = 0; j < missIdxs.length; j++) {
            const idx = missIdxs[j]!;
            candidateVecs[idx] = freshVecs[j]!;
            putEmbedCache(candidates[idx]!.summary, freshVecs[j]!);
          }
        }

        const scored = candidates.map((c, i) => ({
          c,
          score: cosineSimilarity(queryVec, candidateVecs[i] ?? []),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map((s) => s.c);
      }
    } catch (err) {
      logger.warn({ err }, 'Embedding-based candidate selection failed, falling back to keyword overlap');
    }
  }

  const scored = candidates
    .map((c) => ({ c, score: keywordOverlapScore(docSummary, c.summary) }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.c);
}

async function detectRelations(
  kbId: string,
  docId: string,
  docSummary: string,
  config: KbLlmConfig,
): Promise<KnowledgeDocRelationRecord[]> {
  const all = await loadOtherSummariesInKb(kbId, docId);
  if (all.length === 0) return [];

  const candidates = await pickTopCandidates(docSummary, all, 20);
  const inserted: KnowledgeDocRelationRecord[] = [];

  for (let i = 0; i < candidates.length; i += 5) {
    const batch = candidates.slice(i, i + 5);
    const lines = batch
      .map(
        (c, idx) =>
          `${idx + 1}. target_doc_id=${c.document_id}\n摘要：${c.summary.slice(0, 1200)}`,
      )
      .join('\n\n');

    const prompt = `你是知识库文档关系抽取助手。给定“当前文档”的摘要，以及若干候选文档的摘要，请判断当前文档与每个候选文档之间是否存在以下关系之一：
- supersedes：当前文档取代/覆盖候选文档所描述的内容
- supplements：当前文档补充候选文档
- contradicts：当前文档与候选文档存在明显矛盾
- references：当前文档引用或依赖候选文档

请只输出 JSON 数组，元素格式：
[{"target_doc_id":"...","relation_type":"supersedes|supplements|contradicts|references","confidence":0.0-1.0,"detail":t('prompts.auto_e3ca8a', {}, undefined)}]

若没有关系，输出 []。

当前文档 id：${docId}
当前文档摘要：
---
${docSummary.slice(0, 2000)}
---

候选文档（每行一个）：
${lines}

请只输出 JSON 数组，不要包含其他内容。`;

    const raw = await callKbLlm(config, prompt, {
      maxTokens: 1500,
      temperature: 0.2,
      jsonMode: true,
    });

    let items: Array<{
      target_doc_id?: string;
      relation_type?: string;
      confidence?: number;
      detail?: string | null;
    }>;
    try {
      items = parseJsonArray(raw);
    } catch (err) {
      logger.warn({ err, docId, kbId }, 'Failed to parse KB relations JSON batch');
      continue;
    }

    const now = new Date().toISOString();
    for (const item of items) {
      const targetId = item.target_doc_id;
      const rel = item.relation_type;
      const confidence = typeof item.confidence === 'number' ? item.confidence : 0;
      if (!targetId || !rel || confidence < 0.5) continue;
      if (!RELATION_TYPES.has(rel)) continue;
      if (targetId === docId) continue;
      const targetDoc = (await dba.prepare('SELECT kb_id FROM knowledge_documents WHERE id = ?').get(targetId)) as { kb_id: string } | undefined;
      if (!targetDoc || targetDoc.kb_id !== kbId) continue;

      const relationType = rel as KnowledgeRelationType;
      const id = crypto.randomUUID();
      const detail =
        item.detail === undefined || item.detail === null
          ? null
          : String(item.detail).slice(0, 2000);

      const insertRelSql = adaptSql(
        `INSERT OR IGNORE INTO knowledge_doc_relations
          (id, source_doc_id, target_doc_id, relation_type, confidence, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      await dba
        .prepare(insertRelSql)
        .run(id, docId, targetId, relationType, confidence, detail, now);

      const row = (await dba
        .prepare(
          adaptSql(
            `SELECT id, source_doc_id, target_doc_id, relation_type, confidence, detail, created_at
             FROM knowledge_doc_relations
             WHERE source_doc_id = ? AND target_doc_id = ? AND relation_type = ?`,
          ),
        )
        .get(docId, targetId, relationType)) as KnowledgeDocRelationRecord | undefined;
      if (row) inserted.push(row);

      if (relationType === 'supersedes' && confidence >= 0.8) {
        const updSql = adaptSql(
          `UPDATE knowledge_documents SET superseded_by = ?, updated_at = ? WHERE id = ?`,
        );
        await dba.prepare(updSql).run(docId, now, targetId);
      }
    }
  }

  return inserted;
}

/**
 * Process a document with LLM: generate summary, extract entities, detect relations.
 * Called async after document indexing is complete.
 */
export async function enhanceDocumentWithLlm(
  kbId: string,
  docId: string,
  docContent: string,
  config: KbLlmConfig,
): Promise<void> {
  await setLlmStatus(docId, 'processing');
  const stopHeartbeat = startHeartbeat(docId);
  try {
    const summaryRecord = await generateSummary(docId, docContent, config);
    try {
      await detectRelations(kbId, docId, summaryRecord.summary, config);
    } catch (relErr) {
      logger.warn({ err: relErr, kbId, docId }, 'KB relation detection failed (non-fatal)');
    }
    const ok = await setLlmStatus(docId, 'done', 'processing');
    if (!ok) logger.warn({ docId }, 'LLM status CAS failed on done (likely reset by recovery)');
  } catch (err) {
    logger.error({ err, kbId, docId }, 'KB LLM enhancement failed');
    await setLlmStatus(docId, 'failed');
  } finally {
    stopHeartbeat();
  }
}
