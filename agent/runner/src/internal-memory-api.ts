const INTERNAL_API_BASE = String(
  process.env.NANOCLAW_INTERNAL_API_BASE || '',
).trim();
const INTERNAL_API_TOKEN = String(
  process.env.NANOCLAW_INTERNAL_API_TOKEN || '',
).trim();
const INTERNAL_API_TOKEN_HEADER = 'x-nanoclaw-internal-api-token';
const chatJid = String(process.env.NANOCLAW_CHAT_JID || '').trim();
const groupFolder = String(process.env.NANOCLAW_GROUP_FOLDER || '').trim();

export interface InternalMemoryRecallPayload {
  path: string;
  scope: 'group' | 'global';
  lineStart: number;
  lineEnd: number;
  text: string;
  score?: number | null;
  sourceType?: string | null;
  memoryClass?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
  searchQuery?: string | null;
  searchRank?: number | null;
  searchMatchedAt?: string | null;
  searchResultCount?: number | null;
}

export interface InternalMemorySearchPayload {
  query: string;
  scope?: 'group' | 'global' | 'all';
  maxResults?: number;
}

export interface InternalMemorySearchResult {
  path: string;
  scope: 'group' | 'global';
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
  sourceType?: string | null;
  memoryClass?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
}

function canUseInternalApi(): boolean {
  return Boolean(INTERNAL_API_BASE && INTERNAL_API_TOKEN && chatJid && groupFolder);
}

export async function notifyMemoryRecall(
  payload: InternalMemoryRecallPayload,
): Promise<void> {
  if (!canUseInternalApi()) return;

  try {
    await fetch(`${INTERNAL_API_BASE}/internal/memory/recall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_API_TOKEN_HEADER]: INTERNAL_API_TOKEN,
      },
      body: JSON.stringify({
        chatJid,
        groupFolder,
        path: payload.path,
        scope: payload.scope,
        lineStart: payload.lineStart,
        lineEnd: payload.lineEnd,
        text: payload.text,
        score:
          typeof payload.score === 'number' && Number.isFinite(payload.score)
            ? payload.score
            : null,
        sourceType: String(payload.sourceType || '').trim() || null,
        memoryClass: String(payload.memoryClass || '').trim() || null,
        ownerType: String(payload.ownerType || '').trim() || null,
        ownerId: String(payload.ownerId || '').trim() || null,
        searchQuery: String(payload.searchQuery || '').trim() || null,
        searchRank:
          typeof payload.searchRank === 'number' &&
          Number.isFinite(payload.searchRank)
            ? Math.max(1, Math.trunc(payload.searchRank))
            : null,
        searchMatchedAt:
          typeof payload.searchMatchedAt === 'string' &&
          !Number.isNaN(Date.parse(payload.searchMatchedAt))
            ? payload.searchMatchedAt
            : null,
        searchResultCount:
          typeof payload.searchResultCount === 'number' &&
          Number.isFinite(payload.searchResultCount)
            ? Math.max(0, Math.trunc(payload.searchResultCount))
            : null,
      }),
    });
  } catch {
    // Recall logging is best-effort; do not fail the tool call.
  }
}

export async function notifyMemoryIndexedFile(payload: {
  path: string;
}): Promise<void> {
  if (!canUseInternalApi()) return;

  try {
    await fetch(`${INTERNAL_API_BASE}/internal/memory/index-file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_API_TOKEN_HEADER]: INTERNAL_API_TOKEN,
      },
      body: JSON.stringify({
        groupFolder,
        path: payload.path,
      }),
    });
  } catch {
    // Index sync is best-effort; do not fail the tool call.
  }
}

// ---------------------------------------------------------------------------
// Per-user memory API (unified memory system)
// ---------------------------------------------------------------------------

const userId = String(process.env.NANOCLAW_USER_ID || '').trim();

function canUseUserMemoryApi(): boolean {
  return Boolean(INTERNAL_API_BASE && INTERNAL_API_TOKEN && userId);
}

export interface UserMemorySearchResult {
  id: string;
  category: string;
  content: string;
  importance: number;
  scope: string;
}

export async function searchUserMemoryViaApi(
  query: string,
  opts?: { scope?: string; maxResults?: number },
): Promise<UserMemorySearchResult[] | null> {
  if (!canUseUserMemoryApi()) return null;

  try {
    const response = await fetch(
      `${INTERNAL_API_BASE}/internal/memory/user/search`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_API_TOKEN_HEADER]: INTERNAL_API_TOKEN,
        },
        body: JSON.stringify({
          userId,
          query,
          scope: opts?.scope,
          conversationId: chatJid || undefined,
          maxResults: opts?.maxResults ?? 10,
        }),
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { memories?: unknown[] };
    if (!Array.isArray(data.memories)) return null;
    return data.memories.map((m: any) => ({
      id: String(m.id || ''),
      category: String(m.category || 'general'),
      content: String(m.content || ''),
      importance: Number(m.importance) || 5,
      scope: String(m.scope || 'global'),
    }));
  } catch {
    return null;
  }
}

export async function saveMemoryFileViaApi(
  content: string,
  opts: { scope: string; pathRef: string },
): Promise<boolean> {
  if (!canUseInternalApi()) return false;
  try {
    const response = await fetch(
      `${INTERNAL_API_BASE}/internal/memory/save-file`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_API_TOKEN_HEADER]: INTERNAL_API_TOKEN,
        },
        body: JSON.stringify({
          groupFolder,
          scope: opts.scope,
          pathRef: opts.pathRef,
          content,
        }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function saveUserMemoryViaApi(
  content: string,
  opts?: { category?: string; scope?: string },
): Promise<boolean> {
  if (!canUseUserMemoryApi()) return false;

  try {
    const response = await fetch(
      `${INTERNAL_API_BASE}/internal/memory/user/save`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_API_TOKEN_HEADER]: INTERNAL_API_TOKEN,
        },
        body: JSON.stringify({
          userId,
          content,
          category: opts?.category || 'general',
          scope: opts?.scope || 'global',
          conversationId: chatJid || undefined,
        }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function touchUserMemoryRecallViaApi(
  memoryId: string,
): Promise<void> {
  if (!canUseUserMemoryApi()) return;

  try {
    await fetch(`${INTERNAL_API_BASE}/internal/memory/user/recall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_API_TOKEN_HEADER]: INTERNAL_API_TOKEN,
      },
      body: JSON.stringify({ memoryId }),
    });
  } catch {
    // best-effort
  }
}

export async function searchIndexedMemory(
  payload: InternalMemorySearchPayload,
): Promise<InternalMemorySearchResult[] | null> {
  if (!canUseInternalApi()) return null;

  try {
    const response = await fetch(`${INTERNAL_API_BASE}/internal/memory/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_API_TOKEN_HEADER]: INTERNAL_API_TOKEN,
      },
      body: JSON.stringify({
        chatJid,
        groupFolder,
        query: payload.query,
        scope: payload.scope || 'group',
        maxResults:
          typeof payload.maxResults === 'number' &&
          Number.isFinite(payload.maxResults)
            ? payload.maxResults
            : undefined,
      }),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { results?: unknown };
    if (!Array.isArray(data.results)) {
      return null;
    }
    return data.results.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const result = entry as Record<string, unknown>;
      const path = String(result.path || '').trim();
      const scope = result.scope === 'global' ? 'global' : 'group';
      const lineStart = Number.parseInt(String(result.lineStart || '1'), 10);
      const lineEnd = Number.parseInt(String(result.lineEnd || '1'), 10);
      const score = Number(result.score);
      const snippet = String(result.snippet || '');
      const sourceType = String(result.sourceType || '').trim() || null;
      const memoryClass = String(result.memoryClass || '').trim() || null;
      const ownerType = String(result.ownerType || '').trim() || null;
      const ownerId = String(result.ownerId || '').trim() || null;
      if (!path || !snippet) return [];
      return [
        {
          path,
          scope,
          lineStart: Number.isFinite(lineStart) ? Math.max(1, lineStart) : 1,
          lineEnd: Number.isFinite(lineEnd) ? Math.max(1, lineEnd) : 1,
          score: Number.isFinite(score) ? score : 0,
          snippet,
          sourceType,
          memoryClass,
          ownerType,
          ownerId,
        },
      ];
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Knowledge base search (internal loopback API)
// ---------------------------------------------------------------------------

export interface KnowledgeSearchHit {
  content: string;
  score: number;
  filename?: string;
  kbName?: string;
  kind?: 'wiki' | 'chunk';
  title?: string;
  pageType?: string;
  isStale?: boolean;
  headingPath?: string | null;
  contextLabel?: string | null;
  chunkType?: string | null;
  adjacentChunks?: Array<{
    chunkId: string;
    documentId: string;
    content: string;
    chunkIndex: number;
    direction: 'previous' | 'next';
    headingPath?: string | null;
    contextLabel?: string | null;
    chunkType?: string | null;
  }>;
  evidenceChunks?: Array<{
    chunkId: string;
    documentId: string;
    filename?: string;
    kbName?: string;
    content: string;
    chunkIndex: number;
    score: number;
  }>;
}

export function isKnowledgeSearchApiConfigured(): boolean {
  return Boolean(INTERNAL_API_BASE && INTERNAL_API_TOKEN);
}

function parseAvailableKnowledgeBaseIds(): string[] | null {
  const raw = String(process.env.NANOCLAW_AVAILABLE_KB_IDS || '').trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw.split(',');
  }

  const values = Array.isArray(parsed) ? parsed : [];
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export async function searchKnowledgeBaseViaApi(
  query: string,
  topK: number,
): Promise<KnowledgeSearchHit[] | null> {
  if (!isKnowledgeSearchApiConfigured()) return null;
  const currentUserId = String(
    process.env.NANOCLAW_USER_ID || userId || '',
  ).trim();
  const currentChatJid = String(
    process.env.NANOCLAW_CHAT_JID || chatJid || '',
  ).trim();
  if (!currentUserId) return null;
  const clampedTopK = Math.max(1, Math.min(50, Math.floor(topK)));
  const availableKbIds = parseAvailableKnowledgeBaseIds();
  if (availableKbIds && availableKbIds.length === 0) return null;

  try {
    const body: Record<string, unknown> = {
      query,
      top_k: clampedTopK,
      user_id: currentUserId,
    };
    if (currentChatJid) body.chat_jid = currentChatJid;
    if (availableKbIds) body.kb_ids = availableKbIds;

    const response = await fetch(`${INTERNAL_API_BASE}/internal/knowledge/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_API_TOKEN_HEADER]: INTERNAL_API_TOKEN,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    const raw = (await response.json()) as unknown;
    const payload = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    const wikiEntries = payload && Array.isArray(payload.wiki) ? payload.wiki as unknown[] : [];
    const chunkEntries = Array.isArray(raw)
      ? raw
      : (payload && Array.isArray(payload.chunks) ? payload.chunks as unknown[] : []);
    const entries: Array<{ kind: 'wiki' | 'chunk'; entry: unknown }> = [
      ...wikiEntries.map((entry) => ({ kind: 'wiki' as const, entry })),
      ...chunkEntries.map((entry) => ({ kind: 'chunk' as const, entry })),
    ];
    if (entries.length === 0) return null;
    const out: KnowledgeSearchHit[] = [];
    for (const item of entries) {
      if (!item.entry || typeof item.entry !== 'object') continue;
      const r = item.entry as Record<string, unknown>;
      const content = String(r.content ?? '');
      const score = Number(r.score);
      out.push({
        content,
        score: Number.isFinite(score) ? score : 0,
        filename: item.kind === 'wiki'
          ? (r.title != null ? String(r.title) : undefined)
          : (r.filename != null ? String(r.filename) : undefined),
        kbName: r.kbName != null ? String(r.kbName) : undefined,
        kind: item.kind,
        title: r.title != null ? String(r.title) : undefined,
        pageType: r.pageType != null ? String(r.pageType) : (r.page_type != null ? String(r.page_type) : undefined),
        isStale: Boolean(r.isStale ?? r.is_stale),
        headingPath: r.headingPath != null ? String(r.headingPath) : null,
        contextLabel: r.contextLabel != null ? String(r.contextLabel) : null,
        chunkType: r.chunkType != null ? String(r.chunkType) : null,
        adjacentChunks: Array.isArray(r.adjacentChunks)
          ? r.adjacentChunks
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
            .map((entry) => {
              const direction = String(entry.direction ?? '') === 'previous' ? 'previous' : 'next';
              return {
                chunkId: String(entry.chunkId ?? ''),
                documentId: String(entry.documentId ?? ''),
                content: String(entry.content ?? ''),
                chunkIndex: Number.isFinite(Number(entry.chunkIndex)) ? Number(entry.chunkIndex) : 0,
                direction,
                headingPath: entry.headingPath != null ? String(entry.headingPath) : null,
                contextLabel: entry.contextLabel != null ? String(entry.contextLabel) : null,
                chunkType: entry.chunkType != null ? String(entry.chunkType) : null,
              };
            })
          : undefined,
        evidenceChunks: Array.isArray(r.evidenceChunks)
          ? r.evidenceChunks
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
            .map((entry) => ({
              chunkId: String(entry.chunkId ?? ''),
              documentId: String(entry.documentId ?? ''),
              filename: entry.filename != null ? String(entry.filename) : undefined,
              kbName: entry.kbName != null ? String(entry.kbName) : undefined,
              content: String(entry.content ?? ''),
              chunkIndex: Number.isFinite(Number(entry.chunkIndex)) ? Number(entry.chunkIndex) : 0,
              score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : 0,
            }))
          : undefined,
      });
    }
    return out;
  } catch {
    return null;
  }
}
