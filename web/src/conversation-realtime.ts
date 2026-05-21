import i18n from './i18n/index.ts';
import type {
  ApprovalRequest,
  AssistantTurn,
  ConversationChatState,
  ConversationMessagesResponse,
  ConversationSendAck,
  Message,
  SubagentInfo,
  TurnEvent,
  TurnItem,
  TurnItemStatus,
} from './app-types';

type RawRecord = Record<string, unknown>;

type RealtimeMeta = {
  seq?: number;
  stateVersion?: number;
  eventId?: string;
  runId?: string;
  clientId?: string;
  timestamp?: string;
};

export type ConversationWatermarkSource = 'live' | 'send_ack' | 'snapshot';

export function shouldIgnoreConversationRealtimeSeq(
  state: Pick<ConversationChatState, 'lastEventSeq'> | undefined,
  seq: number | undefined,
): boolean {
  return (
    typeof seq === 'number' &&
    typeof state?.lastEventSeq === 'number' &&
    seq <= state.lastEventSeq
  );
}

export function applyConversationRealtimeWatermark<
  T extends ConversationChatState,
>(state: T, seq: number | undefined, source: ConversationWatermarkSource): T {
  if (source === 'snapshot' || !Number.isFinite(seq)) return state;
  if ((state.lastEventSeq ?? Number.NEGATIVE_INFINITY) >= (seq as number)) {
    return state;
  }
  return {
    ...state,
    lastEventSeq: seq,
  };
}

export type NormalizedConversationRealtimeEvent =
  | ({
      kind: 'message';
      jid: string;
      message: Message;
      isBot: boolean;
    } & RealtimeMeta)
  | ({
      kind: 'turn_event';
      jid: string;
      event: TurnEvent;
    } & RealtimeMeta)
  | ({
      kind: 'stream';
      jid: string;
      chunk: string;
      done: boolean;
    } & RealtimeMeta)
  | ({
      kind: 'typing';
      jid: string;
      isTyping: boolean;
    } & RealtimeMeta)
  | ({
      kind: 'agent_event';
      jid: string;
      event: {
        id: string;
        kind: 'status' | 'tool' | 'reasoning';
        status: TurnItemStatus;
        title: string;
        body?: string;
        timestamp: string;
      };
    } & RealtimeMeta)
  | ({
      kind: 'approval_request';
      jid: string;
      approval: ApprovalRequest;
    } & RealtimeMeta)
  | ({
      kind: 'approval_resolved';
      jid: string;
      resolution: { id: string };
    } & RealtimeMeta)
  | ({
      kind: 'reset';
      jid: string;
    } & RealtimeMeta)
  | ({
      kind: 'interrupted';
      jid: string;
      reason?: string;
      turnId?: string;
    } & RealtimeMeta)
  | ({
      kind: 'im_event';
      jid: string;
      eventType:
        | 'im_message_created'
        | 'im_message_edited'
        | 'im_message_deleted'
        | 'im_reaction_changed'
        | 'im_read_updated'
        | 'im_member_changed'
        | 'im_ai_invoked'
        | 'im_typing'
        | string;
      payload: RawRecord;
      message?: Message;
    } & RealtimeMeta);

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === 'object' ? (value as RawRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeUploadedChatFiles(value: unknown): Message['uploaded_files'] {
  if (!Array.isArray(value)) return undefined;
  const files = value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const name = asString(record.name);
    const mimeType = asString(record.mimeType);
    const relativePath = asString(record.relativePath);
    const size = asNumber(record.size);
    if (!name || !mimeType || !relativePath || size === undefined) return [];
    return [
      {
        name,
        mimeType,
        relativePath,
        size,
        id: asString(record.id) ?? relativePath,
        absolutePath: asString(record.absolutePath) ?? '',
        textExcerpt: asString(record.textExcerpt),
        textTruncated: asBoolean(record.textTruncated),
      },
    ];
  });
  return files.length > 0 ? files : undefined;
}

function extractMeta(raw: RawRecord): RealtimeMeta {
  return {
    seq: asNumber(raw.seq ?? raw.event_seq),
    stateVersion: asNumber(raw.state_version ?? raw.stateVersion),
    eventId: asString(raw.event_id ?? raw.eventId),
    runId: asString(raw.run_id ?? raw.runId),
    clientId: asString(raw.client_id ?? raw.clientId),
    timestamp: asString(raw.timestamp),
  };
}

function unwrapRealtimePayload(
  data: RawRecord,
): { raw: RawRecord; meta: RealtimeMeta } | null {
  const kind = asString(data.kind);
  if (kind !== 'realtime') {
    return { raw: data, meta: extractMeta(data) };
  }

  const payload = asRecord(data.payload);
  if (!payload) return null;

  const meta = extractMeta(data);
  const raw: RawRecord = {
    ...payload,
    jid: asString(payload.jid) ?? asString(data.jid),
    type: asString(payload.type) ?? asString(data.event_type),
    seq: meta.seq,
    state_version: meta.stateVersion,
    event_id: meta.eventId,
    run_id: meta.runId,
    client_id: meta.clientId,
    timestamp: meta.timestamp ?? asString(payload.timestamp),
  };
  return { raw, meta };
}

function normalizeTurnItem(value: unknown): TurnItem | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = asString(record.id);
  const type = asString(record.type);
  const status = asString(record.status) as TurnItemStatus | undefined;
  const timestamp = asString(record.timestamp) ?? new Date().toISOString();
  if (!id || !type || !status) return null;

  if (type === 'assistant_message') {
    const text = typeof record.text === 'string' ? record.text : '';
    if (status !== 'in_progress' && status !== 'completed') return null;
    return { id, type, status, text, timestamp };
  }

  if (type === 'tool_call') {
    const subagentInfoRecord = asRecord(record.subagentInfo);
    let subagentInfo: SubagentInfo | undefined;
    if (subagentInfoRecord) {
      const subagentStatus = asString(subagentInfoRecord.status);
      if (
        subagentStatus === 'spawning' ||
        subagentStatus === 'idle' ||
        subagentStatus === 'running' ||
        subagentStatus === 'stopping' ||
        subagentStatus === 'completed' ||
        subagentStatus === 'failed' ||
        subagentStatus === 'stopped'
      ) {
        subagentInfo = {
          agentName:
            asString(subagentInfoRecord.agentName) ??
            i18n.t('common.subagent.defaultName'),
          runtimeId: asString(subagentInfoRecord.runtimeId),
          provider: asString(subagentInfoRecord.provider),
          mode:
            asString(subagentInfoRecord.mode) === 'agent' ||
            asString(subagentInfoRecord.mode) === 'team'
              ? (asString(subagentInfoRecord.mode) as 'agent' | 'team')
              : undefined,
          runtimeKind:
            asString(subagentInfoRecord.runtimeKind) === 'managed_run' ||
            asString(subagentInfoRecord.runtimeKind) === 'managed_session' ||
            asString(subagentInfoRecord.runtimeKind) === 'ephemeral_snapshot'
              ? (asString(subagentInfoRecord.runtimeKind) as
                  | 'managed_run'
                  | 'managed_session'
                  | 'ephemeral_snapshot')
              : undefined,
          providerSessionId: asString(subagentInfoRecord.providerSessionId),
          parentRuntimeId: asString(subagentInfoRecord.parentRuntimeId),
          controllerSessionKey: asString(
            subagentInfoRecord.controllerSessionKey,
          ),
          requesterSessionKey: asString(subagentInfoRecord.requesterSessionKey),
          originTurnId: asString(subagentInfoRecord.originTurnId),
          originToolCallId: asString(subagentInfoRecord.originToolCallId),
          topologyRole:
            asString(subagentInfoRecord.topologyRole) === 'main' ||
            asString(subagentInfoRecord.topologyRole) === 'orchestrator' ||
            asString(subagentInfoRecord.topologyRole) === 'leaf'
              ? (asString(subagentInfoRecord.topologyRole) as
                  | 'main'
                  | 'orchestrator'
                  | 'leaf')
              : asString(subagentInfoRecord.role) === 'main' ||
                  asString(subagentInfoRecord.role) === 'orchestrator' ||
                  asString(subagentInfoRecord.role) === 'leaf'
                ? (asString(subagentInfoRecord.role) as
                    | 'main'
                    | 'orchestrator'
                    | 'leaf')
                : undefined,
          workProfile:
            asString(subagentInfoRecord.workProfile) === 'explorer' ||
            asString(subagentInfoRecord.workProfile) === 'worker'
              ? (asString(subagentInfoRecord.workProfile) as
                  | 'explorer'
                  | 'worker')
              : undefined,
          role:
            asString(subagentInfoRecord.role) === 'main' ||
            asString(subagentInfoRecord.role) === 'orchestrator' ||
            asString(subagentInfoRecord.role) === 'leaf'
              ? (asString(subagentInfoRecord.role) as
                  | 'main'
                  | 'orchestrator'
                  | 'leaf')
              : undefined,
          controlScope:
            asString(subagentInfoRecord.controlScope) === 'children' ||
            asString(subagentInfoRecord.controlScope) === 'none'
              ? (asString(subagentInfoRecord.controlScope) as
                  | 'children'
                  | 'none')
              : undefined,
          depth: asNumber(subagentInfoRecord.depth),
          chatJid: asString(subagentInfoRecord.chatJid),
          requestCount: asNumber(subagentInfoRecord.requestCount),
          controllable: asBoolean(subagentInfoRecord.controllable),
          task: asString(subagentInfoRecord.task),
          status: subagentStatus,
        };
      }
    }
    return {
      id,
      type,
      status,
      title: asString(record.title) ?? '',
      argumentsText: asString(record.argumentsText),
      resultText: asString(record.resultText),
      errorText: asString(record.errorText),
      startedAt: asString(record.startedAt),
      completedAt: asString(record.completedAt),
      subagentInfo,
      timestamp,
    };
  }

  if (type === 'reasoning') {
    return {
      id,
      type,
      status,
      title: asString(record.title) ?? '',
      text: asString(record.text),
      timestamp,
    };
  }

  return null;
}

function normalizeAssistantTurn(value: unknown): AssistantTurn | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asString(record.id);
  const timestamp = asString(record.timestamp) ?? new Date().toISOString();
  if (!id) return null;
  const rawItems = Array.isArray(record.items) ? record.items : [];
  return {
    id,
    clientKey: asString(record.clientKey),
    runId: asString(record.runId ?? record.run_id),
    timestamp,
    items: rawItems
      .map((entry) => normalizeTurnItem(entry))
      .filter((entry): entry is TurnItem => entry !== null),
    isLive: Boolean(record.isLive),
    isCompleted: Boolean(record.isCompleted),
    persistedMessageId: asString(
      record.persistedMessageId ?? record.persisted_message_id,
    ),
    error: asString(record.error),
  };
}

function normalizeTurnEvent(
  value: unknown,
  meta: RealtimeMeta,
): TurnEvent | null {
  const record = asRecord(value);
  if (!record) return null;

  const type = asString(record.type);
  const turnId = asString(record.turnId);
  const timestamp =
    asString(record.timestamp) ?? meta.timestamp ?? new Date().toISOString();
  if (!type || !turnId) return null;

  if (type === 'turn.started' || type === 'turn.completed') {
    return { type, turnId, timestamp, ...meta };
  }
  if (type === 'turn.failed') {
    return {
      type,
      turnId,
      timestamp,
      error: asString(record.error) ?? 'Turn failed',
      ...meta,
    };
  }
  if (
    type === 'item.started' ||
    type === 'item.updated' ||
    type === 'item.completed'
  ) {
    const item = normalizeTurnItem(record.item);
    if (!item) return null;
    return { type, turnId, item, timestamp, ...meta };
  }

  return null;
}

function normalizeApproval(value: unknown): ApprovalRequest | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asString(record.id);
  const toolCallId = asString(record.toolCallId);
  const toolName = asString(record.toolName);
  const command = asString(record.command);
  const createdAt = asString(record.createdAt);
  const expiresAt = asString(record.expiresAt);
  if (!id || !toolCallId || !toolName || !command || !createdAt || !expiresAt) {
    return null;
  }
  return {
    id,
    toolCallId,
    toolName,
    command,
    cwd: asString(record.cwd),
    canWhitelist: asBoolean(record.canWhitelist),
    createdAt,
    expiresAt,
  };
}

function normalizeMessage(value: unknown, meta?: RealtimeMeta): Message | null {
  const record =
    asRecord(value) ??
    asRecord({ ...(meta ? { ...meta } : {}), ...(asRecord(value) ?? {}) });
  if (!record) return null;
  const id = asString(record.id);
  const sender = asString(record.sender);
  const senderName = asString(record.sender_name ?? record.senderName);
  const content = typeof record.content === 'string' ? record.content : '';
  const timestamp =
    asString(record.timestamp) ?? meta?.timestamp ?? new Date().toISOString();
  const isBotRaw = record.is_bot_message ?? record.is_bot;
  if (!id || !sender || !senderName) return null;
  return {
    id,
    chat_jid: asString(record.chat_jid ?? record.jid),
    sender,
    sender_name: senderName,
    content,
    timestamp,
    client_id: asString(record.client_id ?? record.clientId ?? meta?.clientId),
    turn_id: asString(record.turn_id ?? record.turnId),
    run_id: asString(record.run_id ?? record.runId ?? meta?.runId),
    seq: asNumber(record.seq ?? meta?.seq),
    im_seq: asNumber(record.im_seq ?? record.room_seq),
    reply_to_id: asString(record.reply_to_id ?? record.replyToId) ?? null,
    edited_at: asString(record.edited_at ?? record.editedAt) ?? null,
    deleted_at: asString(record.deleted_at ?? record.deletedAt) ?? null,
    attachments: Array.isArray(record.attachments)
      ? (record.attachments as Message['attachments'])
      : undefined,
    reactions: Array.isArray(record.reactions)
      ? (record.reactions as Message['reactions'])
      : undefined,
    read_receipts: Array.isArray(record.read_receipts ?? record.readReceipts)
      ? ((record.read_receipts ??
          record.readReceipts) as Message['read_receipts'])
      : undefined,
    uploaded_files: normalizeUploadedChatFiles(
      record.uploaded_files ?? record.uploadedFiles,
    ),
    is_from_me:
      typeof record.is_from_me === 'boolean' ||
      typeof record.is_from_me === 'number'
        ? (record.is_from_me as boolean | number)
        : undefined,
    is_bot_message:
      typeof isBotRaw === 'boolean' || typeof isBotRaw === 'number'
        ? (isBotRaw as boolean | number)
        : 0,
  };
}

export function normalizeConversationMessagesResponse(
  data: unknown,
): ConversationMessagesResponse {
  const record = asRecord(data) ?? {};
  return {
    messages: Array.isArray(record.messages)
      ? record.messages
          .map((entry) => normalizeMessage(entry))
          .filter((entry): entry is Message => entry !== null)
      : [],
    turns: Array.isArray(record.turns)
      ? record.turns
          .map((entry) => normalizeAssistantTurn(entry))
          .filter((entry): entry is AssistantTurn => entry !== null)
      : [],
    approvals: Array.isArray(record.approvals)
      ? record.approvals
          .map((entry) => normalizeApproval(entry))
          .filter((entry): entry is ApprovalRequest => entry !== null)
      : undefined,
    total: asNumber(record.total) ?? 0,
    last_event_seq: asNumber(record.last_event_seq),
  };
}

export function normalizeConversationSendAck(
  data: unknown,
): ConversationSendAck {
  const record = asRecord(data) ?? {};
  return {
    ok: asBoolean(record.ok),
    command: asBoolean(record.command),
    success: asBoolean(record.success),
    accepted: asBoolean(record.accepted),
    clientId: asString(record.clientId ?? record.client_id),
    runId: asString(record.runId ?? record.run_id),
    serverTimestamp: asString(
      record.serverTimestamp ?? record.server_timestamp,
    ),
    last_event_seq: asNumber(record.last_event_seq),
  };
}

export function normalizeConversationRealtimeEvent(
  data: Record<string, unknown>,
): NormalizedConversationRealtimeEvent | null {
  const unwrapped = unwrapRealtimePayload(data);
  if (!unwrapped) return null;

  const { raw, meta } = unwrapped;
  const jid = asString(raw.jid);
  const type = asString(raw.type);
  if (!jid || !type) return null;

  if (type === 'message') {
    const message = normalizeMessage(raw, meta);
    if (!message) return null;
    return {
      kind: 'message',
      jid,
      message,
      isBot: Boolean(raw.is_bot ?? raw.is_bot_message),
      ...meta,
    };
  }

  if (type === 'im_event' || type.startsWith('im_')) {
    const eventType =
      type === 'im_event' ? asString(raw.event_type ?? raw.eventType) : type;
    const actualEventType =
      eventType || asString(raw.event_type ?? raw.eventType);
    if (!actualEventType) return null;
    const message =
      normalizeMessage(raw.message ?? raw, {
        ...meta,
        seq: asNumber(raw.room_seq ?? raw.seq ?? meta.seq),
      }) ?? undefined;
    return {
      kind: 'im_event',
      jid,
      eventType: actualEventType,
      payload: raw,
      ...(message ? { message } : {}),
      ...meta,
      seq: asNumber(raw.room_seq ?? raw.seq ?? meta.seq),
    };
  }

  if (type === 'turn_event') {
    const event = normalizeTurnEvent(raw.event, meta);
    if (!event) return null;
    return { kind: 'turn_event', jid, event, ...meta };
  }

  if (type === 'stream') {
    return {
      kind: 'stream',
      jid,
      chunk: typeof raw.text === 'string' ? raw.text : '',
      done: Boolean(raw.done),
      ...meta,
    };
  }

  if (type === 'typing') {
    return {
      kind: 'typing',
      jid,
      isTyping: Boolean(raw.isTyping),
      ...meta,
    };
  }

  if (type === 'agent_event') {
    const event = asRecord(raw.event);
    const id = asString(event?.id);
    const title = asString(event?.title);
    if (!id || !title) return null;
    return {
      kind: 'agent_event',
      jid,
      event: {
        id,
        kind:
          event?.kind === 'tool' || event?.kind === 'reasoning'
            ? event.kind
            : 'status',
        status:
          event?.status === 'completed' || event?.status === 'failed'
            ? event.status
            : 'in_progress',
        title,
        body: asString(event?.body),
        timestamp:
          asString(event?.timestamp) ??
          meta.timestamp ??
          new Date().toISOString(),
      },
      ...meta,
    };
  }

  if (type === 'approval_request') {
    const approval = normalizeApproval(raw.approval);
    if (!approval) return null;
    return { kind: 'approval_request', jid, approval, ...meta };
  }

  if (type === 'approval_resolved') {
    const resolution = asRecord(raw.resolution);
    const id = asString(resolution?.id);
    if (!id) return null;
    return { kind: 'approval_resolved', jid, resolution: { id }, ...meta };
  }

  if (type === 'reset') {
    return { kind: 'reset', jid, ...meta };
  }

  if (type === 'interrupted') {
    return {
      kind: 'interrupted',
      jid,
      reason: asString(raw.reason),
      turnId: asString(raw.turnId ?? raw.turn_id) ?? meta.runId,
      ...meta,
    };
  }

  return null;
}
