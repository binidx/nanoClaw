const API_BASE = '/api/im';

export interface ImUser {
  id: string;
  username: string;
  display_name: string | null;
}

export interface ImFriend {
  friend_id: string;
  username: string;
  display_name: string | null;
  remark: string | null;
  created_at: string;
}

export interface ImFriendRequest {
  id: string;
  from_user_id: string;
  to_user_id: string;
  sender_username: string;
  sender_display_name: string | null;
  to_username?: string;
  to_display_name?: string | null;
  message: string | null;
  status: string;
  created_at: string;
}

export interface ImConversation {
  jid: string;
  chat_type: 'dm' | 'group';
  name: string | null;
  visibility: 'private' | 'public';
  last_message_time: string | null;
  last_message_content: string | null;
  last_message_sender: string | null;
  e2ee_enabled?: number;
  member_count: number;
  is_pinned?: number;
  is_muted?: number;
  is_archived?: number;
  unread_count?: number;
}

export interface ImConversationDetail {
  jid: string;
  chat_type: 'dm' | 'group';
  name: string | null;
  visibility: 'private' | 'public';
  notice: string | null;
  e2ee_enabled: number;
  owner_id: string;
  member_count: number;
}

export interface ImAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  encrypted?: {
    iv: string;
    fileName: string;
    mimeType: string;
    size: number;
  };
}

export interface ImReactionGroup {
  emoji: string;
  count: number;
  users: string[];
}

export interface ImMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string | null;
  content: string;
  timestamp: string;
  client_id: string | null;
  im_seq?: number | null;
  reply_to_id?: string | null;
  edited_at?: string | null;
  deleted_at?: string | null;
  attachments?: ImAttachment[];
  reactions?: ImReactionGroup[];
  encrypted?: ImEncryptedEnvelope;
  e2eeError?: string;
  delivery_status?: 'sending' | 'failed';
  delivery_error?: string;
  retry_text?: string;
  retry_attachment_ids?: string[];
  retry_encrypted_attachments?: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
    iv: string;
  }>;
}

export interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

export interface ImMember {
  user_id: string;
  username: string;
  display_name: string | null;
  role: string;
  status: string;
}

export interface ImRealtimeEvent {
  seq: number;
  event_id: string;
  event_type: string;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface ImConversationPrefs {
  chat_jid: string;
  user_id: string;
  is_pinned: number;
  is_muted: number;
  is_archived: number;
  draft_text: string | null;
  updated_at: string;
}

export interface ImNotification {
  id: string;
  user_id: string;
  chat_jid: string | null;
  event_type: string;
  actor_id: string | null;
  message_id: string | null;
  title: string | null;
  body: string | null;
  is_read: number;
  created_at: string;
}

export interface ImPinnedMessage {
  message_id: string;
  pinned_by: string;
  pinned_at: string;
}

export interface ImAiMember {
  assistant_id: string;
  display_name: string;
  kind: string;
  status: string;
}

export interface ImCall {
  id: string;
  created_by: string;
  call_type: 'audio' | 'video';
  status: string;
  created_at: string;
}

export interface ImDeviceKey {
  user_id: string;
  device_id: string;
  public_key: string;
  updated_at: string;
}

export interface ImEncryptedEnvelope {
  version: number;
  algorithm: string;
  iv: string;
  aad?: string | null;
  ciphertext: string;
}

export interface ImRoomKey {
  chat_jid: string;
  user_id: string;
  device_id: string;
  wrapped_key: string;
  algorithm: string;
  created_at: string;
}

export interface ImAiInvocation {
  id: string;
  chat_jid: string;
  assistant_id: string;
  trigger_message_id: string | null;
  requested_by: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  prompt: string;
  error_message?: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ImAssistantOption {
  id: string;
  name: string;
  kind: 'assistant' | 'soul';
}

async function apiFetch<T extends Record<string, unknown>>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('Invalid JSON response');
  }
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid response');
  }
  const record = data as { ok?: boolean; error?: string };
  if (!record.ok) {
    throw new Error(record.error || 'API error');
  }
  return data as T;
}

// Users & Friends
export const searchUsers = (q: string) =>
  apiFetch<{ ok: true; users: ImUser[] }>(
    `/users/search?q=${encodeURIComponent(q)}`,
  );

export const getFriends = () =>
  apiFetch<{ ok: true; friends: ImFriend[] }>('/friends');

export const sendFriendRequest = (toUserId: string, message?: string) =>
  apiFetch<{ ok: true }>('/friends/requests', {
    method: 'POST',
    body: JSON.stringify({ toUserId, message }),
  });

export const getFriendRequests = () =>
  apiFetch<{
    ok: true;
    received: ImFriendRequest[];
    sent: ImFriendRequest[];
  }>('/friends/requests');

export const acceptFriendRequest = (id: string) =>
  apiFetch<{ ok: true }>(`/friends/requests/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
  });

export const rejectFriendRequest = (id: string) =>
  apiFetch<{ ok: true }>(`/friends/requests/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
  });

export const removeFriend = (friendId: string) =>
  apiFetch<{ ok: true }>(`/friends/${encodeURIComponent(friendId)}`, {
    method: 'DELETE',
  });

// Conversations
export const getConversations = () =>
  apiFetch<{ ok: true; conversations: ImConversation[] }>('/conversations');

export const createDm = (targetUserId: string) =>
  apiFetch<{ ok: true; jid: string }>('/conversations/dm', {
    method: 'POST',
    body: JSON.stringify({ targetUserId }),
  });

export const createGroup = (
  name: string,
  memberIds: string[],
  visibility?: string,
) =>
  apiFetch<{ ok: true; jid: string }>('/conversations/group', {
    method: 'POST',
    body: JSON.stringify({ name, memberIds, visibility }),
  });

export const getConversationDetail = (jid: string) =>
  apiFetch<{ ok: true; conversation: ImConversationDetail }>(
    `/conversations/${encodeURIComponent(jid)}`,
  );

export const updateGroup = (jid: string, updates: Record<string, unknown>) =>
  apiFetch<{ ok: true }>(`/conversations/${encodeURIComponent(jid)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });

export const dissolveGroup = (jid: string) =>
  apiFetch<{ ok: true }>(`/conversations/${encodeURIComponent(jid)}`, {
    method: 'DELETE',
  });

// Messages
export const getMessages = (jid: string, before?: string, limit?: number) => {
  const params = new URLSearchParams();
  if (before) params.set('before', before);
  if (limit != null) params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch<{ ok: true; messages: ImMessage[]; last_seq?: number }>(
    `/conversations/${encodeURIComponent(jid)}/messages${qs ? `?${qs}` : ''}`,
  );
};

export const getConversationEvents = (
  jid: string,
  afterSeq: number,
  limit?: number,
) => {
  const params = new URLSearchParams();
  params.set('afterSeq', String(Math.max(0, Math.floor(afterSeq))));
  if (limit != null) params.set('limit', String(limit));
  return apiFetch<{
    ok: true;
    events: ImRealtimeEvent[];
    last_seq: number;
    limited?: boolean;
  }>(`/conversations/${encodeURIComponent(jid)}/events?${params.toString()}`);
};

export const getConversationPrefs = (jid: string) =>
  apiFetch<{ ok: true; prefs: ImConversationPrefs }>(
    `/conversations/${encodeURIComponent(jid)}/prefs`,
  );

export const updateConversationPrefs = (
  jid: string,
  patch: Partial<
    Pick<
      ImConversationPrefs,
      'is_pinned' | 'is_muted' | 'is_archived' | 'draft_text'
    >
  >,
) =>
  apiFetch<{ ok: true; prefs: ImConversationPrefs }>(
    `/conversations/${encodeURIComponent(jid)}/prefs`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  );

export const sendMessage = (
  jid: string,
  content: string,
  attachmentIds?: string[],
  replyToId?: string,
  encrypted?: ImEncryptedEnvelope,
) =>
  apiFetch<{ ok: true; message: ImMessage }>(
    `/conversations/${encodeURIComponent(jid)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ content, attachmentIds, replyToId, encrypted }),
    },
  );

export async function uploadImFile(
  chatJid: string,
  file: File,
  metadata?: { fileName?: string; mimeType?: string },
): Promise<ImAttachment> {
  const form = new FormData();
  form.append('chatJid', chatJid);
  form.append('file', file, metadata?.fileName || file.name);
  const res = await fetch(`${API_BASE}/files/upload`, {
    method: 'POST',
    body: form,
  });
  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    attachment?: ImAttachment;
  };
  if (!data.ok || !data.attachment)
    throw new Error(data.error || 'Upload failed');
  return data.attachment;
}

export async function getImLinkPreview(
  url: string,
): Promise<LinkPreviewData | null> {
  try {
    const res = await apiFetch<{ ok: true; preview: LinkPreviewData | null }>(
      `/link-preview?url=${encodeURIComponent(url)}`,
    );
    return res.preview;
  } catch {
    return null;
  }
}

// Members
export const getMembers = (jid: string) =>
  apiFetch<{ ok: true; members: ImMember[] }>(
    `/conversations/${encodeURIComponent(jid)}/members`,
  );

export const inviteMembers = (jid: string, userIds: string[]) =>
  apiFetch<{ ok: true }>(`/conversations/${encodeURIComponent(jid)}/members`, {
    method: 'POST',
    body: JSON.stringify({ userIds }),
  });

export const removeMember = (jid: string, userId: string) =>
  apiFetch<{ ok: true }>(
    `/conversations/${encodeURIComponent(jid)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );

// Group search
export const searchGroups = (q: string) =>
  apiFetch<{ ok: true; groups: ImConversation[] }>(
    `/groups/search?q=${encodeURIComponent(q)}`,
  );

export const requestJoinGroup = (jid: string, message?: string) =>
  apiFetch<{ ok: true }>(`/groups/${encodeURIComponent(jid)}/join-request`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });

// Enhanced IM features
export const editMessage = (
  messageId: string,
  chatJid: string,
  content: string,
) =>
  apiFetch<{ ok: true }>(`/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ chatJid, content }),
  });

export const deleteMessage = (messageId: string, chatJid: string) =>
  apiFetch<{ ok: true }>(
    `/messages/${encodeURIComponent(messageId)}?chatJid=${encodeURIComponent(chatJid)}`,
    { method: 'DELETE' },
  );

export const addReaction = (
  messageId: string,
  chatJid: string,
  emoji: string,
) =>
  apiFetch<{ ok: true }>(
    `/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: 'POST',
      body: JSON.stringify({ chatJid, emoji }),
    },
  );

export const removeReaction = (
  messageId: string,
  chatJid: string,
  emoji: string,
) =>
  apiFetch<{ ok: true }>(
    `/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}?chatJid=${encodeURIComponent(chatJid)}`,
    { method: 'DELETE' },
  );

export const markAsRead = (jid: string, messageId: string) =>
  apiFetch<{ ok: true }>(`/conversations/${encodeURIComponent(jid)}/read`, {
    method: 'POST',
    body: JSON.stringify({ messageId }),
  });

export const sendTyping = (jid: string) =>
  apiFetch<{ ok: true }>(`/conversations/${encodeURIComponent(jid)}/typing`, {
    method: 'POST',
  });

export const searchMessages = (q: string, jid?: string, limit?: number) => {
  const params = new URLSearchParams({ q });
  if (jid) params.set('jid', jid);
  if (limit != null) params.set('limit', String(limit));
  return apiFetch<{ ok: true; messages: ImMessage[] }>(
    `/messages/search?${params}`,
  );
};

export const getNotifications = (limit?: number) => {
  const params = new URLSearchParams();
  if (limit != null) params.set('limit', String(limit));
  return apiFetch<{
    ok: true;
    notifications: ImNotification[];
    unread_count: number;
  }>(`/notifications${params.toString() ? `?${params}` : ''}`);
};

export const markNotificationsRead = (ids?: string[]) =>
  apiFetch<{ ok: true; unread_count: number }>('/notifications/read', {
    method: 'PATCH',
    body: JSON.stringify({ ids }),
  });

export const blockUser = (targetUserId: string) =>
  apiFetch<{ ok: true }>(
    `/security/blocks/${encodeURIComponent(targetUserId)}`,
    {
      method: 'POST',
    },
  );

export const unblockUser = (targetUserId: string) =>
  apiFetch<{ ok: true }>(
    `/security/blocks/${encodeURIComponent(targetUserId)}`,
    {
      method: 'DELETE',
    },
  );

export const reportImContent = (input: {
  chatJid?: string;
  messageId?: string;
  targetUserId?: string;
  reason: string;
  details?: string;
}) =>
  apiFetch<{ ok: true; report: { id: string; created_at: string } }>(
    '/security/reports',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );

export const getPinnedMessages = (jid: string) =>
  apiFetch<{ ok: true; pinned: ImPinnedMessage[] }>(
    `/conversations/${encodeURIComponent(jid)}/pinned-messages`,
  );

export const pinMessage = (jid: string, messageId: string) =>
  apiFetch<{ ok: true; pinned: { pinned_at: string } }>(
    `/conversations/${encodeURIComponent(jid)}/pinned-messages`,
    {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    },
  );

export const unpinMessage = (jid: string, messageId: string) =>
  apiFetch<{ ok: true }>(
    `/conversations/${encodeURIComponent(jid)}/pinned-messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' },
  );

export const upsertDeviceKey = (deviceId: string, publicKey: string) =>
  apiFetch<{ ok: true }>('/e2ee/device-key', {
    method: 'POST',
    body: JSON.stringify({ deviceId, publicKey }),
  });

export const getDeviceKeys = (jid: string) =>
  apiFetch<{ ok: true; keys: ImDeviceKey[] }>(
    `/conversations/${encodeURIComponent(jid)}/e2ee/device-keys`,
  );

export const getRoomKeys = (jid: string, deviceId?: string) => {
  const qs = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : '';
  return apiFetch<{ ok: true; keys: ImRoomKey[] }>(
    `/conversations/${encodeURIComponent(jid)}/e2ee/room-keys${qs}`,
  );
};

export const uploadRoomKeys = (
  jid: string,
  keys: Array<{
    userId: string;
    deviceId: string;
    wrappedKey: string;
    algorithm: string;
  }>,
) =>
  apiFetch<{ ok: true }>(
    `/conversations/${encodeURIComponent(jid)}/e2ee/room-keys`,
    {
      method: 'POST',
      body: JSON.stringify({ keys }),
    },
  );

export const setE2eeEnabled = (jid: string, enabled: boolean) =>
  apiFetch<{ ok: true; e2ee_enabled: number }>(
    `/conversations/${encodeURIComponent(jid)}/e2ee`,
    {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    },
  );

export const getActiveCalls = (jid: string) =>
  apiFetch<{ ok: true; calls: ImCall[] }>(
    `/conversations/${encodeURIComponent(jid)}/calls`,
  );

export const startCall = (jid: string, callType: 'audio' | 'video') =>
  apiFetch<{
    ok: true;
    call: { id: string; status: string; created_at: string };
  }>(`/conversations/${encodeURIComponent(jid)}/calls`, {
    method: 'POST',
    body: JSON.stringify({ callType }),
  });

export const updateCall = (
  callId: string,
  action: 'join' | 'leave' | 'decline' | 'end',
) =>
  apiFetch<{ ok: true }>(
    `/calls/${encodeURIComponent(callId)}/actions/${action}`,
    {
      method: 'POST',
    },
  );

export const getAiMembers = (jid: string) =>
  apiFetch<{ ok: true; ai_members: ImAiMember[] }>(
    `/conversations/${encodeURIComponent(jid)}/ai-members`,
  );

export const addAiMember = (
  jid: string,
  assistantId: string,
  displayName: string,
  kind: 'assistant' | 'soul',
) =>
  apiFetch<{ ok: true; ai_member: ImAiMember }>(
    `/conversations/${encodeURIComponent(jid)}/ai-members`,
    {
      method: 'POST',
      body: JSON.stringify({ assistantId, displayName, kind }),
    },
  );

export const removeAiMember = (jid: string, assistantId: string) =>
  apiFetch<{ ok: true }>(
    `/conversations/${encodeURIComponent(jid)}/ai-members/${encodeURIComponent(assistantId)}`,
    { method: 'DELETE' },
  );

export const invokeAiMember = (
  jid: string,
  assistantId: string,
  prompt: string,
  triggerMessageId?: string,
) =>
  apiFetch<{
    ok: true;
    invocation: { id: string; created_at: string; status: string };
  }>(`/conversations/${encodeURIComponent(jid)}/ai-invocations`, {
    method: 'POST',
    body: JSON.stringify({ assistantId, prompt, triggerMessageId }),
  });

export const getAiInvocations = (jid: string, limit?: number) => {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return apiFetch<{ ok: true; invocations: ImAiInvocation[] }>(
    `/conversations/${encodeURIComponent(jid)}/ai-invocations${qs}`,
  );
};

export async function getAssistantOptions(
  currentUserId?: string,
): Promise<ImAssistantOption[]> {
  const [assistantRes, soulRes] = await Promise.allSettled([
    fetch('/api/assistants', { credentials: 'include' }),
    fetch('/api/soul', { credentials: 'include' }),
  ]);
  const options: ImAssistantOption[] = [];
  if (assistantRes.status === 'fulfilled' && assistantRes.value.ok) {
    const data = (await assistantRes.value.json()) as {
      assistants?: Array<{ id: string; name: string; enabled?: boolean }>;
    };
    for (const item of data.assistants || []) {
      if (!item.id || item.enabled === false) continue;
      options.push({
        id: item.id,
        name: item.name || item.id,
        kind: 'assistant',
      });
    }
  }
  if (soulRes.status === 'fulfilled' && soulRes.value.ok) {
    const data = (await soulRes.value.json()) as {
      soul?: { name?: string | null; enabled?: number | boolean };
    };
    if (
      currentUserId &&
      data.soul &&
      data.soul.enabled !== 0 &&
      data.soul.enabled !== false
    ) {
      options.push({
        id: currentUserId,
        name: data.soul.name || 'Soul',
        kind: 'soul',
      });
    }
  }
  return options;
}
