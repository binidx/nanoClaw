import {
  deleteMemoryDocuments,
  getUserMemoryById,
  getUserMemoryProjectionStats,
  listUserMemoriesForProjectionRepair,
  listUserMemoryProjectionDocuments,
  upsertMemoryDocuments,
} from '../db.js';
import type { MemoryDocumentRecord, UserMemoryRecord } from '../types.js';

export interface UserMemoryProjectionRepairResult {
  checkedMemories: number;
  projectedDocuments: number;
  deletedOrphans: number;
  before: Awaited<ReturnType<typeof getUserMemoryProjectionStats>>;
  after: Awaited<ReturnType<typeof getUserMemoryProjectionStats>>;
}

export function buildUserMemoryDocumentId(memoryId: string): string {
  return `user-memory:${memoryId}`;
}

export function buildUserMemoryPathRef(memoryId: string): string {
  return `user_memory:${memoryId}`;
}

function buildUserMemoryDocument(memory: UserMemoryRecord): MemoryDocumentRecord {
  const title = `${memory.category} user memory`;
  const body = [
    `Category: ${memory.category}`,
    `Tier: ${memory.tier}`,
    `Scope: ${memory.scope}`,
    '',
    memory.content,
  ].join('\n');
  return {
    doc_id: buildUserMemoryDocumentId(memory.id),
    scope: 'global',
    owner_type: 'global',
    owner_id: memory.user_id,
    path_ref: buildUserMemoryPathRef(memory.id),
    source_type: 'user_memory',
    title,
    body,
    metadata_json: JSON.stringify({
      memoryId: memory.id,
      userId: memory.user_id,
      category: memory.category,
      scope: memory.scope,
      conversationId: memory.conversation_id,
      tier: memory.tier,
      importance: memory.importance,
      confidence: memory.confidence,
      source: memory.source,
      promotedFrom: memory.promoted_from,
      sourceEventId: memory.source_event_id,
      validFrom: memory.valid_from,
      validTo: memory.valid_to,
      expiresAt: memory.expires_at,
    }),
    updated_at: memory.updated_at || new Date().toISOString(),
  };
}

export async function projectUserMemoryToDocument(
  memoryId: string,
): Promise<MemoryDocumentRecord | null> {
  const memory = await getUserMemoryById(memoryId);
  if (!memory) return null;
  const document = buildUserMemoryDocument(memory);
  await upsertMemoryDocuments([document]);
  return document;
}

export async function deleteUserMemoryProjection(memoryId: string): Promise<void> {
  await deleteMemoryDocuments({
    sourceType: 'user_memory',
    pathRefs: [buildUserMemoryPathRef(memoryId)],
  });
}

export async function repairUserMemoryProjections(options?: {
  userId?: string;
  limit?: number;
}): Promise<UserMemoryProjectionRepairResult> {
  const userId = options?.userId?.trim() || undefined;
  const before = await getUserMemoryProjectionStats({ userId });
  const memories = await listUserMemoriesForProjectionRepair({
    userId,
    limit: options?.limit,
  });
  const documents = memories.map(buildUserMemoryDocument);
  await upsertMemoryDocuments(documents);

  const sourceIds = new Set(memories.map((memory) => memory.id));
  const projectionDocuments = await listUserMemoryProjectionDocuments({ userId });
  const orphanDocIds = options?.limit
    ? []
    : projectionDocuments
        .filter((document) => {
          const pathRef = String(document.path_ref || '');
          if (!pathRef.startsWith('user_memory:')) return true;
          return !sourceIds.has(pathRef.slice('user_memory:'.length));
        })
        .map((document) => document.doc_id)
        .filter(Boolean);

  if (orphanDocIds.length > 0) {
    await deleteMemoryDocuments({
      docIds: orphanDocIds,
      sourceType: 'user_memory',
    });
  }

  const after = await getUserMemoryProjectionStats({ userId });
  return {
    checkedMemories: memories.length,
    projectedDocuments: documents.length,
    deletedOrphans: orphanDocIds.length,
    before,
    after,
  };
}
