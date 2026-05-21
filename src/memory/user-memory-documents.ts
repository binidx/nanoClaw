import {
  deleteMemoryDocuments,
  getUserMemoryById,
  getUserMemoryProjectionStats,
  listUserMemoriesForProjectionRepair,
  listUserMemoryProjectionDocuments,
  recordMemoryEvent,
  upsertMemoryDocuments,
} from '../db.js';
import type { MemoryDocumentRecord, UserMemoryRecord } from '../types.js';
import { isUserMemoryRecordCurrent } from './user-memory-policy.js';

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
  if (!isUserMemoryRecordCurrent(memory)) {
    await deleteUserMemoryProjection(memoryId);
    return null;
  }
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
    timeScope: 'current',
  });
  const projectionDocumentsBefore = await listUserMemoryProjectionDocuments({ userId });
  const existingProjectionPathRefs = new Set(
    projectionDocumentsBefore
      .map((document) => document.path_ref)
      .filter((pathRef): pathRef is string => Boolean(pathRef)),
  );
  const documents = memories.map(buildUserMemoryDocument);
  await upsertMemoryDocuments(documents);

  const sourceIds = new Set(memories.map((memory) => memory.id));
  const orphanDocIds = options?.limit
    ? []
    : projectionDocumentsBefore
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

  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const createdDocuments = documents.filter(
    (document) => document.path_ref && !existingProjectionPathRefs.has(document.path_ref),
  );
  await Promise.all(
    createdDocuments.map((document) => {
      const memoryId = document.path_ref?.startsWith('user_memory:')
        ? document.path_ref.slice('user_memory:'.length)
        : '';
      const memory = memoryById.get(memoryId);
      return recordMemoryEvent({
        user_id: memory?.user_id || userId || document.owner_id || null,
        scope: memory?.scope || document.scope,
        action_type: 'ADD',
        target_type: 'memory_document',
        target_id: document.doc_id,
        conversation_id: memory?.conversation_id || null,
        source_message_id: null,
        before_snapshot: null,
        after_snapshot: JSON.stringify({
          docId: document.doc_id,
          pathRef: document.path_ref,
          sourceType: document.source_type,
          sourceMemoryId: memoryId || null,
        }),
        decision_reason: 'repair_user_memory_projection',
        metadata_json: JSON.stringify({
          source: 'user_memory_projection_repair',
        }),
      });
    }),
  );
  const orphanDocumentsById = new Map(
    projectionDocumentsBefore.map((document) => [document.doc_id, document]),
  );
  await Promise.all(
    orphanDocIds.map((docId) => {
      const document = orphanDocumentsById.get(docId);
      return recordMemoryEvent({
        user_id: userId || document?.owner_id || null,
        scope: document?.scope || 'global',
        action_type: 'DELETE',
        target_type: 'memory_document',
        target_id: docId,
        conversation_id: null,
        source_message_id: null,
        before_snapshot: JSON.stringify({
          docId,
          pathRef: document?.path_ref || null,
          sourceType: document?.source_type || 'user_memory',
        }),
        after_snapshot: null,
        decision_reason: 'repair_user_memory_projection_orphan',
        metadata_json: JSON.stringify({
          source: 'user_memory_projection_repair',
        }),
      });
    }),
  );

  const after = await getUserMemoryProjectionStats({ userId });
  return {
    checkedMemories: memories.length,
    projectedDocuments: documents.length,
    deletedOrphans: orphanDocIds.length,
    before,
    after,
  };
}
