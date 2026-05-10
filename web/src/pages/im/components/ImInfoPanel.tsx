import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addAiMember,
  blockUser,
  getActiveCalls,
  getAiInvocations,
  getAiMembers,
  getAssistantOptions,
  getConversationPrefs,
  getPinnedMessages,
  invokeAiMember,
  reportImContent,
  setE2eeEnabled,
  startCall,
  updateCall,
  updateConversationPrefs,
  type ImAiMember,
  type ImAiInvocation,
  type ImAssistantOption,
  type ImCall,
  type ImConversationDetail,
  type ImConversationPrefs,
  type ImMember,
  type ImPinnedMessage,
} from '../im-api';
import {
  buildImE2eeUiState,
  createAndShareRoomKey,
  type ImE2eeDeviceStatus,
} from '../im-e2ee';
import { InfoPanelSection } from '../../../components/chat/InfoPanelSection.js';
import { MemberCard } from '../../../components/chat/MemberCard.js';

export interface ImInfoPanelProps {
  open: boolean;
  mode?: 'overlay' | 'docked';
  onClose: () => void;
  conversation: ImConversationDetail | null;
  members: ImMember[];
  currentUserId: string;
  onDissolveGroup: (jid: string) => Promise<void>;
  busy: boolean;
  e2eeDeviceStatus?: ImE2eeDeviceStatus | null;
  onRedistributeRoomKey?: () => Promise<void>;
  onJumpToMessage?: (messageId: string) => void;
  onChanged?: () => void;
}

export function ImInfoPanel({
  open,
  mode = 'overlay',
  onClose,
  conversation,
  members,
  currentUserId,
  onDissolveGroup,
  busy,
  e2eeDeviceStatus,
  onRedistributeRoomKey,
  onJumpToMessage,
  onChanged,
}: ImInfoPanelProps) {
  const { t } = useTranslation('im');
  const [confirmDissolve, setConfirmDissolve] = useState<{
    jid: string;
    active: boolean;
  } | null>(null);
  const [prefs, setPrefs] = useState<ImConversationPrefs | null>(null);
  const [pinned, setPinned] = useState<ImPinnedMessage[]>([]);
  const [aiMembers, setAiMembers] = useState<ImAiMember[]>([]);
  const [aiInvocations, setAiInvocations] = useState<ImAiInvocation[]>([]);
  const [assistantOptions, setAssistantOptions] = useState<ImAssistantOption[]>(
    [],
  );
  const [calls, setCalls] = useState<ImCall[]>([]);
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [keyActionBusy, setKeyActionBusy] = useState(false);
  const [selectedAssistantId, setSelectedAssistantId] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [e2eeEnabled, setE2eeEnabledLocal] = useState(false);
  const e2eeState = buildImE2eeUiState({
    enabled: e2eeEnabled,
    roomKeyAvailable: e2eeDeviceStatus?.roomKeyAvailable,
    t,
  });
  const confirmDissolveActive =
    !!conversation &&
    confirmDissolve?.jid === conversation.jid &&
    confirmDissolve.active;

  const convTitle =
    conversation?.name?.trim() ||
    (conversation?.chat_type === 'group' ? t('im.群聊') : t('im.私聊'));
  const peer = useMemo(
    () => members.find((member) => member.user_id !== currentUserId) ?? null,
    [currentUserId, members],
  );

  useEffect(() => {
    if (!open || !conversation) return;
    let cancelled = false;
    setPanelError(null);
    setE2eeEnabledLocal(Number(conversation.e2ee_enabled || 0) === 1);
    void Promise.all([
      getConversationPrefs(conversation.jid),
      getPinnedMessages(conversation.jid),
      getAiMembers(conversation.jid),
      getActiveCalls(conversation.jid),
      getAssistantOptions(currentUserId),
      getAiInvocations(conversation.jid, 10),
    ])
      .then(
        ([prefRes, pinnedRes, aiRes, callRes, assistantRes, invocationRes]) => {
          if (cancelled) return;
          setPrefs(prefRes.prefs);
          setPinned(pinnedRes.pinned);
          setAiMembers(aiRes.ai_members);
          setCalls(callRes.calls);
          setAssistantOptions(assistantRes);
          setAiInvocations(invocationRes.invocations);
          setSelectedAssistantId((prev) => prev || assistantRes[0]?.id || '');
        },
      )
      .catch((err) => {
        if (!cancelled)
          setPanelError(err instanceof Error ? err.message : t('im.加载失败'));
      });
    return () => {
      cancelled = true;
    };
  }, [conversation?.jid, conversation?.e2ee_enabled, currentUserId, open, t]);

  useEffect(() => {
    if (!open || !conversation || e2eeEnabled) return;
    const timer = window.setInterval(() => {
      void getAiInvocations(conversation.jid, 10)
        .then((res) => setAiInvocations(res.invocations))
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [conversation?.jid, e2eeEnabled, open]);

  const runPanelAction = async (action: () => Promise<void>) => {
    setPanelBusy(true);
    setPanelError(null);
    try {
      await action();
      onChanged?.();
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : t('im.操作失败'));
    } finally {
      setPanelBusy(false);
    }
  };

  return (
    <>
      {mode === 'overlay' && open ? (
        <div className="im-info-backdrop" onClick={onClose} />
      ) : null}
      <aside
        className={`im-info-panel${open ? ' open' : ''}${mode === 'docked' ? ' docked' : ''}`}
      >
        <div className="im-info-panel-header">
          <strong className="im-info-panel-title">{t('im.会话信息')}</strong>
          <button
            type="button"
            className="btn-outline btn-sm"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {!conversation ? (
          <div className="im-info-panel-empty">
            {t('im.选择左侧会话查看详情。')}
          </div>
        ) : (
          <div className="im-info-panel-body">
            <div className="im-info-panel-identity">
              <div className="im-info-panel-avatar">
                {convTitle.charAt(0).toUpperCase()}
              </div>
              <div className="im-info-panel-conv-name">{convTitle}</div>
              <div className="im-info-panel-conv-meta">
                {conversation.chat_type === 'group'
                  ? t('im.群聊')
                  : t('im.私聊')}
                {' · '}
                {conversation.visibility === 'public'
                  ? t('im.公开')
                  : t('im.私有')}
                {' · '}
                {members.length || conversation.member_count} {t('im.位成员')}
                {' · '}
                {e2eeEnabled ? t('im.已加密') : t('im.未加密')}
              </div>
            </div>

            {panelError && (
              <div className="im-info-panel-alert">{panelError}</div>
            )}

            {conversation.chat_type === 'group' && conversation.notice && (
              <InfoPanelSection title={t('im.群公告')}>
                <div className="im-info-panel-notice">
                  {String(conversation.notice)}
                </div>
              </InfoPanelSection>
            )}

            <InfoPanelSection title={t('im.常用操作')} defaultOpen>
              <div className="im-info-panel-actions">
                <button
                  type="button"
                  className={`im-info-panel-action${prefs?.is_muted ? ' active' : ''}`}
                  disabled={panelBusy || !prefs}
                  onClick={() =>
                    conversation &&
                    prefs &&
                    void runPanelAction(async () => {
                      const res = await updateConversationPrefs(
                        conversation.jid,
                        {
                          is_muted: prefs.is_muted ? 0 : 1,
                        },
                      );
                      setPrefs(res.prefs);
                    })
                  }
                >
                  {prefs?.is_muted ? t('im.取消静音') : t('im.静音')}
                </button>
                <button
                  type="button"
                  className={`im-info-panel-action${prefs?.is_pinned ? ' active' : ''}`}
                  disabled={panelBusy || !prefs}
                  onClick={() =>
                    conversation &&
                    prefs &&
                    void runPanelAction(async () => {
                      const res = await updateConversationPrefs(
                        conversation.jid,
                        {
                          is_pinned: prefs.is_pinned ? 0 : 1,
                        },
                      );
                      setPrefs(res.prefs);
                    })
                  }
                >
                  {prefs?.is_pinned ? t('im.取消置顶') : t('im.置顶')}
                </button>
                <button
                  type="button"
                  className={`im-info-panel-action${prefs?.is_archived ? ' active' : ''}`}
                  disabled={panelBusy || !prefs}
                  onClick={() =>
                    conversation &&
                    prefs &&
                    void runPanelAction(async () => {
                      const res = await updateConversationPrefs(
                        conversation.jid,
                        {
                          is_archived: prefs.is_archived ? 0 : 1,
                        },
                      );
                      setPrefs(res.prefs);
                    })
                  }
                >
                  {prefs?.is_archived ? t('im.移出归档') : t('im.归档')}
                </button>
                <button
                  type="button"
                  className="im-info-panel-action"
                  disabled={panelBusy}
                  onClick={() =>
                    conversation &&
                    void runPanelAction(async () => {
                      const res = await startCall(conversation.jid, 'audio');
                      setCalls((prev) => [
                        {
                          id: res.call.id,
                          created_by: currentUserId,
                          call_type: 'audio',
                          status: res.call.status,
                          created_at: res.call.created_at,
                        },
                        ...prev,
                      ]);
                    })
                  }
                >
                  {t('im.语音通话')}
                </button>
                <button
                  type="button"
                  className="im-info-panel-action"
                  disabled={panelBusy}
                  onClick={() =>
                    conversation &&
                    void runPanelAction(async () => {
                      const res = await startCall(conversation.jid, 'video');
                      setCalls((prev) => [
                        {
                          id: res.call.id,
                          created_by: currentUserId,
                          call_type: 'video',
                          status: res.call.status,
                          created_at: res.call.created_at,
                        },
                        ...prev,
                      ]);
                    })
                  }
                >
                  {t('im.视频通话')}
                </button>
              </div>
            </InfoPanelSection>

            <InfoPanelSection title={t('im.安全与加密')} defaultOpen>
              <div className="im-info-panel-settings">
                <div className={`im-e2ee-status-card ${e2eeState.badgeClass}`}>
                  <div className="im-e2ee-status-main">
                    <strong>{e2eeState.badgeText}</strong>
                    <span>{e2eeState.headerText}</span>
                  </div>
                  {e2eeEnabled && e2eeDeviceStatus ? (
                    <div className="im-e2ee-status-grid">
                      <span>{t('im.当前设备')}</span>
                      <strong title={e2eeDeviceStatus.deviceId}>
                        {e2eeDeviceStatus.deviceId.slice(0, 10)}
                      </strong>
                      <span>{t('im.本设备密钥')}</span>
                      <strong>
                        {e2eeDeviceStatus.roomKeyAvailable
                          ? t('im.可用')
                          : t('im.缺失')}
                      </strong>
                      <span>{t('im.服务端封装密钥')}</span>
                      <strong>
                        {e2eeDeviceStatus.serverRoomKeyAvailable
                          ? t('im.已保存')
                          : t('im.未保存')}
                      </strong>
                      <span>{t('im.成员设备')}</span>
                      <strong>{e2eeDeviceStatus.memberDeviceCount}</strong>
                    </div>
                  ) : null}
                  {e2eeEnabled && onRedistributeRoomKey ? (
                    <button
                      type="button"
                      className="im-info-panel-action"
                      disabled={
                        panelBusy ||
                        keyActionBusy ||
                        !e2eeDeviceStatus?.roomKeyAvailable
                      }
                      onClick={() =>
                        void runPanelAction(async () => {
                          setKeyActionBusy(true);
                          try {
                            await onRedistributeRoomKey();
                          } finally {
                            setKeyActionBusy(false);
                          }
                        })
                      }
                    >
                      {keyActionBusy
                        ? t('im.重新分发中…')
                        : t('im.重新分发密钥')}
                    </button>
                  ) : null}
                </div>
                <label className="im-info-panel-toggle">
                  <span>{t('im.端到端加密')}</span>
                  <input
                    type="checkbox"
                    checked={e2eeEnabled}
                    disabled={panelBusy}
                    onChange={(event) => {
                      const enabled = event.currentTarget.checked;
                      if (!conversation) return;
                      void runPanelAction(async () => {
                        if (enabled) {
                          await createAndShareRoomKey(conversation.jid);
                        }
                        await setE2eeEnabled(conversation.jid, enabled);
                        setE2eeEnabledLocal(enabled);
                        if (enabled) setAiMembers([]);
                      });
                    }}
                  />
                </label>
                <div className="im-info-panel-hint">
                  {e2eeEnabled
                    ? t('im.加密会话不会允许 AI 成员读取或介入。')
                    : t('im.私聊默认启用，新群聊可由管理员启用。')}
                </div>
                {conversation.chat_type === 'dm' && peer && (
                  <div className="im-info-panel-actions">
                    <button
                      type="button"
                      className="im-info-panel-danger-btn"
                      disabled={panelBusy}
                      onClick={() =>
                        void runPanelAction(async () => {
                          await blockUser(peer.user_id);
                        })
                      }
                    >
                      {t('im.拉黑对方')}
                    </button>
                    <button
                      type="button"
                      className="im-info-panel-danger-btn"
                      disabled={panelBusy}
                      onClick={() =>
                        conversation &&
                        void runPanelAction(async () => {
                          await reportImContent({
                            chatJid: conversation.jid,
                            targetUserId: peer.user_id,
                            reason: 'user_report',
                          });
                        })
                      }
                    >
                      {t('im.举报')}
                    </button>
                  </div>
                )}
              </div>
            </InfoPanelSection>

            <InfoPanelSection title={t('im.置顶消息')} badge={pinned.length}>
              {pinned.length === 0 ? (
                <div className="im-info-panel-hint">{t('im.暂无置顶消息')}</div>
              ) : (
                <div className="im-info-panel-list">
                  {pinned.map((item) => (
                    <div
                      className="im-info-panel-list-row"
                      key={item.message_id}
                    >
                      <span>{item.message_id.slice(0, 8)}</span>
                      <small>{new Date(item.pinned_at).toLocaleString()}</small>
                      {onJumpToMessage ? (
                        <button
                          type="button"
                          className="btn-outline btn-sm"
                          onClick={() => onJumpToMessage(item.message_id)}
                        >
                          {t('im.跳转')}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </InfoPanelSection>

            <InfoPanelSection title={t('im.AI 协作')} badge={aiMembers.length}>
              {e2eeEnabled ? (
                <div className="im-info-panel-hint">
                  {t('im.加密会话中 AI 协作已关闭。')}
                </div>
              ) : (
                <div className="im-info-panel-settings">
                  <div className="im-info-panel-list">
                    {aiMembers.map((member) => (
                      <div
                        className="im-info-panel-list-row"
                        key={member.assistant_id}
                      >
                        <span>{member.display_name}</span>
                        <small>{member.kind}</small>
                      </div>
                    ))}
                    {aiMembers.length === 0 && (
                      <div className="im-info-panel-hint">
                        {t('im.暂无 AI 成员')}
                      </div>
                    )}
                  </div>
                  <select
                    className="im-info-panel-input"
                    value={selectedAssistantId}
                    onChange={(event) =>
                      setSelectedAssistantId(event.currentTarget.value)
                    }
                  >
                    {assistantOptions.map((option) => (
                      <option
                        key={`${option.kind}:${option.id}`}
                        value={option.id}
                      >
                        {option.name} · {option.kind}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="im-info-panel-action"
                    disabled={
                      panelBusy ||
                      !selectedAssistantId ||
                      assistantOptions.length === 0
                    }
                    onClick={() =>
                      conversation &&
                      void runPanelAction(async () => {
                        const option = assistantOptions.find(
                          (item) => item.id === selectedAssistantId,
                        );
                        if (!option) return;
                        const res = await addAiMember(
                          conversation.jid,
                          option.id,
                          option.name,
                          option.kind,
                        );
                        setAiMembers((prev) => [
                          ...prev.filter(
                            (m) =>
                              m.assistant_id !== res.ai_member.assistant_id,
                          ),
                          res.ai_member,
                        ]);
                      })
                    }
                  >
                    {t('im.添加 AI')}
                  </button>
                  {aiMembers.length > 0 && (
                    <>
                      <textarea
                        className="im-info-panel-textarea"
                        value={aiPrompt}
                        onChange={(event) =>
                          setAiPrompt(event.currentTarget.value)
                        }
                        placeholder={t('im.请 AI 总结或协助…')}
                      />
                      <button
                        type="button"
                        className="im-info-panel-action"
                        disabled={panelBusy || !aiPrompt.trim()}
                        onClick={() =>
                          conversation &&
                          aiMembers[0] &&
                          void runPanelAction(async () => {
                            await invokeAiMember(
                              conversation.jid,
                              aiMembers[0].assistant_id,
                              aiPrompt,
                            );
                            const res = await getAiInvocations(
                              conversation.jid,
                              10,
                            );
                            setAiInvocations(res.invocations);
                            setAiPrompt('');
                          })
                        }
                      >
                        {t('im.请求 AI 介入')}
                      </button>
                    </>
                  )}
                  {aiInvocations.length > 0 && (
                    <div className="im-info-panel-list">
                      {aiInvocations.map((invocation) => (
                        <div
                          className={`im-info-panel-list-row im-ai-invocation ${invocation.status}`}
                          key={invocation.id}
                        >
                          <span>{invocation.assistant_id}</span>
                          <small>
                            {invocation.status}
                            {invocation.status === 'failed' &&
                            invocation.error_message
                              ? ` · ${invocation.error_message}`
                              : ''}
                          </small>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </InfoPanelSection>

            <InfoPanelSection title={t('im.通话')} badge={calls.length}>
              {calls.length === 0 ? (
                <div className="im-info-panel-hint">
                  {t('im.暂无进行中的通话')}
                </div>
              ) : (
                <div className="im-info-panel-list">
                  {calls.map((call) => (
                    <div className="im-info-panel-call" key={call.id}>
                      <div>
                        <strong>
                          {call.call_type === 'video'
                            ? t('im.视频通话')
                            : t('im.语音通话')}
                        </strong>
                        <small>{call.status}</small>
                      </div>
                      <div className="im-info-panel-confirm-btns">
                        <button
                          type="button"
                          className="btn-outline btn-sm"
                          disabled={panelBusy}
                          onClick={() =>
                            void runPanelAction(async () => {
                              await updateCall(call.id, 'join');
                            })
                          }
                        >
                          {t('im.加入')}
                        </button>
                        <button
                          type="button"
                          className="btn-outline btn-sm"
                          disabled={panelBusy}
                          onClick={() =>
                            void runPanelAction(async () => {
                              await updateCall(call.id, 'end');
                              setCalls((prev) =>
                                prev.filter((item) => item.id !== call.id),
                              );
                            })
                          }
                        >
                          {t('im.结束')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </InfoPanelSection>

            <InfoPanelSection
              title={t('im.成员')}
              badge={members.length || conversation.member_count}
              defaultOpen
            >
              <div className="im-info-panel-member-list">
                {members.map((m) => (
                  <MemberCard
                    key={m.user_id}
                    userId={m.user_id}
                    displayName={m.display_name || m.username}
                    role={m.role as 'owner' | 'admin' | 'member'}
                  />
                ))}
              </div>
            </InfoPanelSection>

            <InfoPanelSection title={t('im.会话设置')}>
              {conversation.chat_type === 'group' ? (
                <div className="im-info-panel-settings">
                  {!confirmDissolveActive ? (
                    <button
                      type="button"
                      className="im-info-panel-danger-btn"
                      disabled={busy}
                      onClick={() =>
                        setConfirmDissolve({
                          jid: conversation.jid,
                          active: true,
                        })
                      }
                    >
                      <span aria-hidden="true">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <line x1="10" y1="11" x2="10" y2="17" />
                          <line x1="14" y1="11" x2="14" y2="17" />
                        </svg>
                      </span>{' '}
                      {t('im.解散群组')}
                    </button>
                  ) : (
                    <div className="im-info-panel-confirm">
                      <span className="im-info-panel-confirm-text">
                        {t('im.确定解散该群？此操作不可撤销。')}
                      </span>
                      <div className="im-info-panel-confirm-btns">
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          disabled={busy}
                          onClick={() => void onDissolveGroup(conversation.jid)}
                        >
                          {busy ? t('im.解散中…') : t('im.确认')}
                        </button>
                        <button
                          type="button"
                          className="btn-outline btn-sm"
                          disabled={busy}
                          onClick={() => setConfirmDissolve(null)}
                        >
                          {t('im.取消')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="im-info-panel-hint">
                  {t('im.私聊会话由服务端策略管理。')}
                </div>
              )}
            </InfoPanelSection>
          </div>
        )}
      </aside>
    </>
  );
}
