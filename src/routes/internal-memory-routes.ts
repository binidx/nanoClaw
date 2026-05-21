import type { Express, RequestHandler } from 'express';

import {
  getConversationIdentityBinding,
  recordMemorySearchEvent,
  searchMemoryDocuments,
  storeMemoryRecallEntry,
  searchUserMemories,
  touchUserMemoryAccess,
  getUserMemories,
} from '../db.js';
import { logger } from '../logger.js';
import { addUnifiedMemory } from '../soul/soul-service.js';
import { repairUserMemoryProjections } from '../memory/user-memory-documents.js';
import {
  type IndexedMemoryScope as MemoryScope,
  refreshIndexedMemoryPathRefsForSearch,
  saveMemoryFileContentToDb,
  syncIndexedMemoryFile,
  syncIndexedMemoryFilesForSearch,
  syncMemoryDocumentToFile,
} from '../memory/document-indexing.js';

interface InternalMemoryRouteOptions {
  requireInternalApi: RequestHandler;
}

interface InternalMemorySearchResult {
  path: string;
  scope: Exclude<MemoryScope, 'all'>;
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
  sourceType: 'memory_file' | 'identity_memory';
  memoryClass: 'group_durable' | 'global_durable' | 'identity';
  ownerType: 'group' | 'global' | 'person';
  ownerId: string;
}

type RankedSearchResult = Awaited<
  ReturnType<typeof searchMemoryDocuments>
>[number];

function formatNumberedLines(lines: string[], startLine: number): string {
  return lines
    .map((line, index) => `${String(startLine + index).padStart(6)}|${line}`)
    .join('\n');
}

function tokenizeQuery(query: string): { phrase: string; tokens: string[] } {
  const phrase = String(query || '').trim().toLowerCase();
  if (!phrase) return { phrase: '', tokens: [] };
  const roughTokens = phrase
    .split(/[\s,.;:!?()[\]{}"'`~<>|/\\+-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const tokens = [...new Set(roughTokens.filter((token) => token.length >= 2))];
  if (tokens.length === 0) {
    tokens.push(phrase);
  } else if (!tokens.includes(phrase) && phrase.length <= 80) {
    tokens.unshift(phrase);
  }
  return { phrase, tokens };
}

function countOccurrences(text: string, token: string): number {
  if (!token) return 0;
  let count = 0;
  let fromIndex = 0;
  while (true) {
    const nextIndex = text.indexOf(token, fromIndex);
    if (nextIndex === -1) break;
    count += 1;
    fromIndex = nextIndex + token.length;
  }
  return count;
}

function scoreLine(text: string, phrase: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  if (phrase) {
    score += countOccurrences(lower, phrase) * Math.max(4, Math.min(10, phrase.length));
  }
  for (const token of tokens) {
    if (!token || token === phrase) continue;
    score += countOccurrences(lower, token) * Math.max(1, Math.min(6, token.length));
  }
  return score;
}

function classifyMemoryClass(result: RankedSearchResult): InternalMemorySearchResult['memoryClass'] {
  if (result.sourceType === 'identity_memory') {
    return 'identity';
  }
  return result.scope === 'global' ? 'global_durable' : 'group_durable';
}

function buildSnippetFromBody(input: {
  result: RankedSearchResult;
  query: string;
}): InternalMemorySearchResult | null {
  if (!input.result.pathRef) return null;
  const lines = String(input.result.body || '').split(/\r?\n/);
  const { phrase, tokens } = tokenizeQuery(input.query);

  let bestIndex = -1;
  let bestScore = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const lineScore = scoreLine(lines[index] || '', phrase, tokens);
    if (lineScore > bestScore) {
      bestScore = lineScore;
      bestIndex = index;
    }
  }

  if (bestIndex < 0) {
    bestIndex = 0;
  }
  const lineStart = Math.max(1, bestIndex);
  const lineEnd = Math.min(lines.length, bestIndex + 3);
  const excerpt = lines.slice(lineStart - 1, lineEnd);
  return {
    path: input.result.pathRef,
    scope: input.result.scope === 'global' ? 'global' : 'group',
    lineStart,
    lineEnd,
    score: input.result.score,
    snippet: formatNumberedLines(excerpt, lineStart),
    sourceType:
      input.result.sourceType === 'identity_memory' ? 'identity_memory' : 'memory_file',
    memoryClass: classifyMemoryClass(input.result),
    ownerType:
      input.result.ownerType === 'person'
        ? 'person'
        : input.result.ownerType === 'global'
          ? 'global'
          : 'group',
    ownerId: input.result.ownerId,
  };
}

function mergeRankedResults(
  groups: RankedSearchResult[][],
  maxResults: number,
): RankedSearchResult[] {
  return groups
    .flat()
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.exactMatchBoost !== left.exactMatchBoost) {
        return right.exactMatchBoost - left.exactMatchBoost;
      }
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt.localeCompare(left.updatedAt);
      }
      return left.docId.localeCompare(right.docId);
    })
    .slice(0, maxResults);
}

async function searchConversationMemory(input: {
  chatJid: string;
  groupFolder: string;
  query: string;
  scope: MemoryScope;
  maxResults: number;
}): Promise<any[]> {
  const groups: RankedSearchResult[][] = [];
  const includeGroup = input.scope === 'group' || input.scope === 'all';
  const includeGlobal = input.scope === 'global' || input.scope === 'all';

  if (includeGroup) {
    groups.push(
      await searchMemoryDocuments(input.query, {
        limit: input.maxResults,
        scopes: ['group'],
        ownerType: 'group',
        ownerId: input.groupFolder,
        sourceTypes: ['memory_file'],
      }),
    );
  }

  if (includeGlobal) {
    groups.push(
      await searchMemoryDocuments(input.query, {
        limit: input.maxResults,
        scopes: ['global'],
        ownerType: 'global',
        ownerId: 'global',
        sourceTypes: ['memory_file'],
      }),
    );
  }

  const identityBinding = await getConversationIdentityBinding(input.chatJid);
  if (identityBinding?.person_id) {
    groups.push(
      await searchMemoryDocuments(input.query, {
        limit: input.maxResults,
        scopes: ['global'],
        ownerType: 'person',
        ownerId: identityBinding.person_id,
        sourceTypes: ['identity_memory'],
      }),
    );
  }

  return mergeRankedResults(groups, input.maxResults);
}

export function registerInternalMemoryRoutes(
  app: Express,
  options: InternalMemoryRouteOptions,
): void {
  app.post(
    '/internal/memory/recall',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const chatJid = String(req.body?.chatJid || '').trim();
        const groupFolder = String(req.body?.groupFolder || '').trim();
        const pathRef = String(req.body?.path || '').trim();
        const scopeRaw = String(req.body?.scope || 'group').trim().toLowerCase();
        const scope = scopeRaw === 'global' ? 'global' : 'group';
        const text = String(req.body?.text || '').trim();
        const lineStart = Number.parseInt(String(req.body?.lineStart || '1'), 10);
        const lineEnd = Number.parseInt(
          String(req.body?.lineEnd || String(lineStart || 1)),
          10,
        );
        const scoreRaw = req.body?.score;
        const score =
          typeof scoreRaw === 'number' && Number.isFinite(scoreRaw)
            ? scoreRaw
            : null;
        const searchQuery = String(req.body?.searchQuery || '').trim();
        const searchRankRaw = req.body?.searchRank;
        const searchRank =
          typeof searchRankRaw === 'number' && Number.isFinite(searchRankRaw)
            ? Math.max(1, Math.trunc(searchRankRaw))
            : Number.parseInt(String(searchRankRaw || ''), 10);
        const searchMatchedAtRaw = String(req.body?.searchMatchedAt || '').trim();
        const searchMatchedAt =
          searchMatchedAtRaw && !Number.isNaN(Date.parse(searchMatchedAtRaw))
            ? searchMatchedAtRaw
            : null;
        const searchResultCountRaw = req.body?.searchResultCount;
        const parsedSearchResultCount =
          typeof searchResultCountRaw === 'number' &&
          Number.isFinite(searchResultCountRaw)
            ? Math.max(0, Math.trunc(searchResultCountRaw))
            : Number.parseInt(String(searchResultCountRaw || ''), 10);
        const sourceType = String(req.body?.sourceType || '').trim();
        const memoryClass = String(req.body?.memoryClass || '').trim();
        const ownerType = String(req.body?.ownerType || '').trim();
        const ownerId = String(req.body?.ownerId || '').trim();

        if (!chatJid || !groupFolder || !pathRef || !text) {
          res.status(400).json({ error: 'Missing required recall payload fields' });
          return;
        }

        const entry = await storeMemoryRecallEntry({
          chatJid,
          groupFolder,
          pathRef,
          scope,
          lineStart: Number.isFinite(lineStart) ? Math.max(1, lineStart) : 1,
          lineEnd: Number.isFinite(lineEnd) ? Math.max(1, lineEnd) : 1,
          text,
          score,
          searchQuery: searchQuery || null,
          searchRank: Number.isFinite(searchRank) ? Math.max(1, searchRank) : null,
          searchMatchedAt,
          searchResultCount: Number.isFinite(parsedSearchResultCount)
            ? Math.max(0, parsedSearchResultCount)
            : null,
          sourceType: sourceType || null,
          memoryClass: memoryClass || null,
          ownerType:
            ownerType === 'person' || ownerType === 'group' || ownerType === 'global'
              ? ownerType
              : null,
          ownerId: ownerId || null,
        });
        res.json({ ok: true, id: entry.id });
      } catch (err) {
        logger.error({ err }, 'Failed to persist internal memory recall');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );
  app.post(
    '/internal/memory/index-file',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const groupFolder = String(req.body?.groupFolder || '').trim();
        const pathRef = String(req.body?.path || '').trim();
        if (!groupFolder || !pathRef) {
          res.status(400).json({ error: 'Missing required index payload fields' });
          return;
        }
        const file = await syncIndexedMemoryFile({
          pathRef,
          groupFolder,
        });
        res.json({
          ok: true,
          indexed: Boolean(file),
          path: file?.pathRef || pathRef,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to index internal memory file');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  // DB-first memory save: agent sends file content, server persists to DB
  // and optionally syncs back to disk.
  app.post(
    '/internal/memory/save-file',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const groupFolder = String(req.body?.groupFolder || '').trim();
        const scopeRaw = String(req.body?.scope || '').trim().toLowerCase();
        const pathRef = String(req.body?.pathRef || '').trim();
        const content = String(req.body?.content ?? '');
        if (!groupFolder || !pathRef || !content) {
          res.status(400).json({ error: 'groupFolder, pathRef and content are required' });
          return;
        }
        const scope = scopeRaw === 'global' ? 'global' : 'group';
        const normalizedPathRef = pathRef.includes(':')
          ? pathRef
          : `${scope}:${pathRef}`;

        await saveMemoryFileContentToDb({
          pathRef: normalizedPathRef,
          groupFolder,
          content,
        });

        // Best-effort disk sync (agent already wrote the file locally)
        try {
          syncMemoryDocumentToFile(normalizedPathRef, content, { groupFolder });
        } catch (syncErr) {
          logger.warn({ err: syncErr }, 'DB→file sync after save-file failed');
        }

        res.json({ ok: true, pathRef: normalizedPathRef });
      } catch (err) {
        logger.error({ err }, 'Failed to save memory file to DB');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.post(
    '/internal/memory/search',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const chatJid = String(req.body?.chatJid || '').trim();
        const groupFolder = String(req.body?.groupFolder || '').trim();
        const query = String(req.body?.query || '').trim();
        const scopeRaw = String(req.body?.scope || 'group').trim().toLowerCase();
        const scope: MemoryScope =
          scopeRaw === 'global' || scopeRaw === 'all' ? scopeRaw : 'group';
        const maxResults = Number.parseInt(
          String(req.body?.maxResults || req.body?.max_results || '5'),
          10,
        );

        if (!chatJid || !groupFolder || !query) {
          res.status(400).json({ error: 'Missing required search payload fields' });
          return;
        }

        const safeMaxResults = Number.isFinite(maxResults)
          ? Math.max(1, Math.min(maxResults, 8))
          : 5;
        let rawResults = await searchConversationMemory({
          chatJid,
          groupFolder,
          query,
          scope,
          maxResults: safeMaxResults,
        });

        if (rawResults.length === 0) {
          await recordMemorySearchEvent({
            eventType: 'search_fallback_sync',
            scope: scope === 'all' ? 'all' : scope,
            ownerType: scope === 'global' ? 'global' : 'group',
            ownerId: scope === 'global' ? 'global' : groupFolder,
          });
          await syncIndexedMemoryFilesForSearch({
            scope,
            groupFolder,
          });
          rawResults = await searchConversationMemory({
            chatJid,
            groupFolder,
            query,
            scope,
            maxResults: safeMaxResults,
          });
        } else {
          const freshness = await refreshIndexedMemoryPathRefsForSearch({
            pathRefs: rawResults
              .filter((result) => result.sourceType === 'memory_file')
              .map((result) => result.pathRef)
              .filter((pathRef): pathRef is string => Boolean(pathRef)),
            groupFolder,
          });
          if (freshness.refreshedCount > 0 || freshness.deletedCount > 0) {
            rawResults = await searchConversationMemory({
              chatJid,
              groupFolder,
              query,
              scope,
              maxResults: safeMaxResults,
            });
          }
        }

        const results = rawResults
          .flatMap((result) => {
            const snippet = buildSnippetFromBody({
              result,
              query,
            });
            return snippet ? [snippet] : [];
          })
          .slice(0, safeMaxResults);

        if (results.length > 0) {
          const scopeCounts = results.reduce(
            (counts, result) => {
              if (result.scope === 'global') {
                counts.global += 1;
              } else {
                counts.group += 1;
              }
              return counts;
            },
            { group: 0, global: 0 },
          );
          const sourceTypeCounts = results.reduce<Record<string, number>>(
            (counts, result) => {
              counts[result.sourceType] = (counts[result.sourceType] || 0) + 1;
              return counts;
            },
            {},
          );
          const memoryClassCounts = results.reduce<Record<string, number>>(
            (counts, result) => {
              counts[result.memoryClass] = (counts[result.memoryClass] || 0) + 1;
              return counts;
            },
            {},
          );
          await recordMemorySearchEvent({
            eventType: 'search_index_hit',
            scope: scope === 'all' ? 'all' : scope,
            ownerType: scope === 'global' ? 'global' : 'group',
            ownerId: scope === 'global' ? 'global' : groupFolder,
            metadataJson: JSON.stringify({
              resultCount: results.length,
              scopeCounts,
              sourceTypeCounts,
              memoryClassCounts,
            }),
          });
        }

        res.json({ ok: true, results });
      } catch (err) {
        logger.error({ err }, 'Failed to search indexed internal memory');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  // ── Per-user memory endpoints (unified memory system) ──

  app.post(
    '/internal/memory/user/search',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const { userId, query, scope, conversationId, maxResults } =
          req.body as {
            userId?: string;
            query?: string;
            scope?: string;
            conversationId?: string;
            maxResults?: number;
          };
        if (!userId || !query) {
          res.status(400).json({ error: 'userId and query are required' });
          return;
        }
        const normalizedScope =
          scope === 'global' || scope === 'conversation' ? scope : undefined;
        const memories = await searchUserMemories(userId, query, {
          scope: normalizedScope,
          conversationId,
          limit: maxResults ?? 10,
        });
        res.json({ ok: true, memories });
      } catch (err) {
        logger.error({ err }, 'Failed to search user memories');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.post(
    '/internal/memory/user/save',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const { userId, content, category, scope, conversationId } =
          req.body as {
            userId?: string;
            content?: string;
            category?: string;
            scope?: string;
            conversationId?: string;
          };
        if (!userId || !content?.trim()) {
          res.status(400).json({ error: 'userId and content are required' });
          return;
        }
        const record = await addUnifiedMemory(userId, {
          category: (category || 'general') as import('../types.js').UserMemoryCategory,
          content: content.trim(),
          importance: 5,
          source: 'agent_tool',
          scope: scope === 'conversation' ? 'conversation' : 'global',
          conversationId: conversationId ?? undefined,
          tier: 'durable',
        });
        res.json({ ok: true, id: record.id });
      } catch (err) {
        logger.error({ err }, 'Failed to save user memory');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.post(
    '/internal/memory/user/recall',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const { memoryId } = req.body as { memoryId?: string };
        if (!memoryId) {
          res.status(400).json({ error: 'memoryId is required' });
          return;
        }
        await touchUserMemoryAccess(memoryId);
        res.json({ ok: true });
      } catch (err) {
        logger.error({ err }, 'Failed to touch user memory recall');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.post(
    '/internal/memory/user/repair-projections',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const userIdRaw = String(req.body?.userId || '').trim();
        const limitRaw = Number.parseInt(String(req.body?.limit || ''), 10);
        const result = await repairUserMemoryProjections({
          userId: userIdRaw || undefined,
          limit: Number.isFinite(limitRaw)
            ? Math.max(1, Math.min(limitRaw, 10000))
            : undefined,
        });
        res.json({ ok: true, ...result });
      } catch (err) {
        logger.error({ err }, 'Failed to repair user memory projections');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.get(
    '/internal/memory/user/list',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const userId = String(req.query.userId || '');
        if (!userId) {
          res.status(400).json({ error: 'userId is required' });
          return;
        }
        const limit = Math.min(50, parseInt(String(req.query.limit || '20'), 10) || 20);
        const memories = await getUserMemories(userId, { limit });
        res.json({ ok: true, memories });
      } catch (err) {
        logger.error({ err }, 'Failed to list user memories');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );
}
