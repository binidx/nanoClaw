import type { ImConversationDetail, ImMember, ImMessage } from './im-api';

export interface ImConversationSnapshot {
  messages: ImMessage[];
  members: ImMember[];
  detail: ImConversationDetail | null;
  hasMoreOlder: boolean;
  lastLoadedAt: number;
}

export function shouldFetchConversationSnapshot(
  snapshot: ImConversationSnapshot | undefined,
  now = Date.now(),
  ttlMs = 30_000,
): boolean {
  if (!snapshot) return true;
  return now - snapshot.lastLoadedAt > ttlMs;
}
