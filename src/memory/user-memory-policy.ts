import type { UserMemoryRecord } from '../types.js';

export interface UserMemoryDocumentLike {
  metadataJson: string | null;
  sourceType: string;
}

export function parseUserMemoryDocumentMetadata(
  value: string | null | undefined,
): Record<string, unknown> {
  try {
    const parsed = value ? JSON.parse(value) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function isUserMemoryRecordCurrent(
  memory: Pick<UserMemoryRecord, 'valid_from' | 'valid_to' | 'expires_at'>,
  queryTime = new Date().toISOString(),
): boolean {
  if (memory.valid_from && memory.valid_from > queryTime) return false;
  if (memory.valid_to && memory.valid_to <= queryTime) return false;
  if (memory.expires_at && memory.expires_at <= queryTime) return false;
  return true;
}

export function isUserMemoryDocumentCurrent(
  result: UserMemoryDocumentLike,
  options?: {
    chatJid?: string;
    queryTime?: string;
  },
): boolean {
  if (result.sourceType !== 'user_memory') return true;
  const metadata = parseUserMemoryDocumentMetadata(result.metadataJson);
  const now = options?.queryTime || new Date().toISOString();
  const validFrom = typeof metadata.validFrom === 'string' ? metadata.validFrom : null;
  const validTo = typeof metadata.validTo === 'string' ? metadata.validTo : null;
  const expiresAt = typeof metadata.expiresAt === 'string' ? metadata.expiresAt : null;
  if (validFrom && validFrom > now) return false;
  if (validTo && validTo <= now) return false;
  if (expiresAt && expiresAt <= now) return false;
  if (metadata.scope === 'conversation') {
    const chatJid = options?.chatJid;
    return Boolean(chatJid) && metadata.conversationId === chatJid;
  }
  return true;
}

export function getUserMemoryDocumentImportance(result: {
  metadataJson: string | null;
}): number {
  const metadata = parseUserMemoryDocumentMetadata(result.metadataJson);
  return typeof metadata.importance === 'number' && Number.isFinite(metadata.importance)
    ? metadata.importance
    : 5;
}

export function getUserMemoryDocumentConfidence(result: {
  metadataJson: string | null;
}): number {
  const metadata = parseUserMemoryDocumentMetadata(result.metadataJson);
  return typeof metadata.confidence === 'number' && Number.isFinite(metadata.confidence)
    ? metadata.confidence
    : 0.5;
}

export function isCoreUserMemoryDocument(result: {
  metadataJson: string | null;
}): boolean {
  const metadata = parseUserMemoryDocumentMetadata(result.metadataJson);
  return metadata.tier === 'core' || getUserMemoryDocumentImportance(result) >= 8;
}
