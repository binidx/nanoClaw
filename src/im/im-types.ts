export interface ImChatMeta {
  chat_jid: string;
  chat_type: 'dm' | 'group';
  visibility: 'private' | 'public';
  owner_id: string;
  name: string | null;
  avatar_url: string | null;
  notice: string | null;
  e2ee_enabled: number;
  max_members: number;
  created_at: string;
  updated_at: string;
}

export interface ImMembership {
  chat_jid: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  nickname: string | null;
  status: 'active' | 'left' | 'kicked';
  muted_until: string | null;
  joined_at: string;
  updated_at: string;
}

export interface UserFriend {
  user_id: string;
  friend_id: string;
  remark: string | null;
  created_at: string;
}

export interface FriendRequest {
  id: string;
  from_user_id: string;
  to_user_id: string;
  message: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
  resolved_at: string | null;
}

export interface ImJoinRequest {
  id: string;
  chat_jid: string;
  user_id: string;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  handled_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ImConversationListItem {
  jid: string;
  chat_type: 'dm' | 'group';
  name: string | null;
  visibility: 'private' | 'public';
  last_message_time: string | null;
  last_message_content: string | null;
  last_message_sender: string | null;
  e2ee_enabled: number;
  member_count: number;
  is_pinned: number;
  is_muted: number;
  is_archived: number;
  unread_count: number;
}

export const IM_USER_ID = '__im__';
