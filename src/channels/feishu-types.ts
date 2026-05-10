export interface FeishuMention {
  key: string;
  id: { union_id?: string; user_id?: string; open_id?: string };
  name: string;
}

export interface FeishuMessageEvent {
  sender: {
    sender_id: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
  };
  message: {
    message_id: string;
    create_time: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: FeishuMention[];
  };
}

export interface FeishuStreamCardState {
  messageId: string;
  text: string;
  pendingText: string | null;
  lastUpdateAt: number;
  queue: Promise<void>;
}

export interface FeishuChatMember {
  id: string;
  name: string;
  chatJid: string;
  source: 'feishu_api' | 'feishu_message';
}

export type FeishuDocSection =
  | {
      kind: 'heading';
      level: 1 | 2 | 3;
      text: string;
    }
  | {
      kind: 'paragraph';
      text: string;
    }
  | {
      kind: 'code';
      text: string;
      language?: string;
    };

export interface FeishuDocAuthorizationTargetResult {
  targetType: 'chat' | 'user';
  targetId: string;
  status: 'success' | 'failed';
  error?: string;
}

export interface FeishuDocChatGrantResult {
  authorizationStrategy: 'chat';
  authorizationStatus: 'complete';
  warnings: string[];
  targets: FeishuDocAuthorizationTargetResult[];
}

export interface FeishuDocPermissionBatchResult {
  batchIndex: number;
  status: 'success' | 'failed';
  memberIds: string[];
  error?: string;
}

export interface FeishuDocUserGrantResult {
  authorizationStrategy: 'users';
  authorizationStatus: 'complete' | 'partial' | 'failed';
  warnings: string[];
  batches: FeishuDocPermissionBatchResult[];
  targets: FeishuDocAuthorizationTargetResult[];
}
