import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconSearch } from '../../../components/AppIcons';
import type { ImConversation, ImFriend, ImUser } from '../im-api';
import {
  getNotifications,
  markNotificationsRead,
  searchUsers,
  sendFriendRequest,
} from '../im-api';

export type ImSidebarTab = 'conversations' | 'contacts';

interface ActionFeedback {
  tone: 'success' | 'error';
  text: string;
}

export interface ImSidebarProps {
  tab: ImSidebarTab;
  onTabChange: (t: ImSidebarTab) => void;
  conversations: ImConversation[];
  friends: ImFriend[];
  activeJid: string | null;
  listsLoading: boolean;
  onSelectConversation: (jid: string) => void;
  onStartDm: (friendUserId: string) => Promise<void>;
  onOpenCreateGroup: () => void;
  onOpenFriendRequests: () => void;
  listError: string | null;
  fullWidth?: boolean;
}

function sortConversations(list: ImConversation[]): ImConversation[] {
  return [...list].sort((a, b) => {
    const pinDiff = Number(b.is_pinned || 0) - Number(a.is_pinned || 0);
    if (pinDiff !== 0) return pinDiff;
    const unreadDiff =
      Number(b.unread_count || 0) - Number(a.unread_count || 0);
    if (unreadDiff !== 0) return unreadDiff;
    const ta = a.last_message_time
      ? new Date(a.last_message_time).getTime()
      : 0;
    const tb = b.last_message_time
      ? new Date(b.last_message_time).getTime()
      : 0;
    return tb - ta;
  });
}

function formatPreviewTime(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function friendlyRequestError(msg: string): string {
  if (msg.includes('Already friends')) return '已是好友';
  if (msg.includes('pending')) return '好友请求已发送，等待对方确认';
  if (msg.includes('not found')) return '用户不存在';
  return msg;
}

export function ImSidebar({
  tab,
  onTabChange,
  conversations,
  friends,
  activeJid,
  listsLoading,
  onSelectConversation,
  onStartDm,
  onOpenCreateGroup,
  onOpenFriendRequests,
  listError,
  fullWidth,
}: ImSidebarProps) {
  const { t } = useTranslation('im');
  const [userQuery, setUserQuery] = useState('');
  const [searchHits, setSearchHits] = useState<ImUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [feedbackMap, setFeedbackMap] = useState<
    Record<string, ActionFeedback>
  >({});
  const [dmStartingId, setDmStartingId] = useState<string | null>(null);
  const [conversationFilter, setConversationFilter] = useState<
    'active' | 'archived' | 'muted'
  >('active');
  const [notificationUnread, setNotificationUnread] = useState(0);

  const friendIdSet = useMemo(
    () => new Set(friends.map((f) => f.friend_id)),
    [friends],
  );

  useEffect(() => {
    if (Object.keys(feedbackMap).length === 0) return;
    const t = window.setTimeout(() => setFeedbackMap({}), 4000);
    return () => clearTimeout(t);
  }, [feedbackMap]);

  useEffect(() => {
    const q = userQuery.trim();
    if (q.length < 2) {
      setSearchHits([]);
      setSearchErr(null);
      return;
    }
    const t = window.setTimeout(() => {
      setSearching(true);
      setSearchErr(null);
      void searchUsers(q)
        .then((res) => setSearchHits(res.users))
        .catch((e: Error) => {
          setSearchErr(e.message);
          setSearchHits([]);
        })
        .finally(() => setSearching(false));
    }, 320);
    return () => clearTimeout(t);
  }, [userQuery]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void getNotifications(1)
        .then((res) => {
          if (!cancelled) setNotificationUnread(res.unread_count);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const sendRequest = useCallback(async (userId: string) => {
    setRequestingId(userId);
    try {
      await sendFriendRequest(userId);
      setFeedbackMap((p) => ({
        ...p,
        [userId]: { tone: 'success', text: t('im.好友请求已发送') },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('im.发送失败');
      setFeedbackMap((p) => ({
        ...p,
        [userId]: { tone: 'error', text: t(`im.${friendlyRequestError(msg)}`) },
      }));
    } finally {
      setRequestingId(null);
    }
  }, []);

  const handleStartDm = useCallback(
    async (friendUserId: string) => {
      setDmStartingId(friendUserId);
      try {
        await onStartDm(friendUserId);
      } finally {
        setDmStartingId(null);
      }
    },
    [onStartDm],
  );

  const tabBtn = (id: ImSidebarTab, label: string) => (
    <button
      key={id}
      type="button"
      className={tab === id ? 'btn-primary btn-sm' : 'btn-outline btn-sm'}
      onClick={() => onTabChange(id)}
      style={{ flex: 1 }}
    >
      {label}
    </button>
  );

  const sorted = sortConversations(
    conversations.filter((item) => {
      if (conversationFilter === 'archived')
        return Number(item.is_archived || 0) === 1;
      if (conversationFilter === 'muted')
        return (
          Number(item.is_muted || 0) === 1 &&
          Number(item.is_archived || 0) !== 1
        );
      return Number(item.is_archived || 0) !== 1;
    }),
  );

  return (
    <aside
      style={{
        width: fullWidth ? '100%' : 300,
        minWidth: fullWidth ? 0 : 260,
        borderRight: fullWidth ? 'none' : '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--surface-card)',
        flex: fullWidth ? 1 : undefined,
      }}
    >
      <div
        style={{
          padding: 12,
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 8,
        }}
      >
        {tabBtn('conversations', t('im.会话'))}
        {tabBtn('contacts', t('im.联系人'))}
      </div>

      {listError ? (
        <div
          className="settings-hint"
          style={{ padding: 12, color: 'var(--error-text)' }}
        >
          {listError}
        </div>
      ) : null}

      {tab === 'conversations' ? (
        <>
          <div
            style={{
              padding: '10px 12px',
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <button
              type="button"
              className="btn-outline btn-sm"
              onClick={onOpenCreateGroup}
            >
              {t('im.新建群聊')}
            </button>
            <button
              type="button"
              className="btn-outline btn-sm"
              onClick={onOpenFriendRequests}
            >
              {t('im.好友请求')}
            </button>
            <button
              type="button"
              className={
                conversationFilter === 'archived'
                  ? 'btn-primary btn-sm'
                  : 'btn-outline btn-sm'
              }
              onClick={() =>
                setConversationFilter((value) =>
                  value === 'archived' ? 'active' : 'archived',
                )
              }
            >
              {t('im.归档')}
            </button>
            <button
              type="button"
              className={
                conversationFilter === 'muted'
                  ? 'btn-primary btn-sm'
                  : 'btn-outline btn-sm'
              }
              onClick={() =>
                setConversationFilter((value) =>
                  value === 'muted' ? 'active' : 'muted',
                )
              }
            >
              {t('im.静音')}
            </button>
            <button
              type="button"
              className={
                notificationUnread > 0
                  ? 'btn-primary btn-sm'
                  : 'btn-outline btn-sm'
              }
              onClick={() =>
                void markNotificationsRead()
                  .then((res) => setNotificationUnread(res.unread_count))
                  .catch(() => {})
              }
            >
              {notificationUnread > 0
                ? `${t('im.通知')} ${notificationUnread}`
                : t('im.通知')}
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {listsLoading && sorted.length === 0 ? (
              <div
                className="settings-hint"
                style={{ padding: 16, textAlign: 'center' }}
              >
                {t('im.加载中…')}
              </div>
            ) : sorted.length === 0 ? (
              <div className="settings-hint" style={{ padding: 16 }}>
                {t('im.暂无会话，在「联系人」中发起私聊或新建群聊。')}
              </div>
            ) : (
              sorted.map((c) => {
                const active = c.jid === activeJid;
                const title =
                  c.name?.trim() ||
                  (c.chat_type === 'group' ? t('im.群聊') : t('im.私聊'));
                return (
                  <button
                    key={c.jid}
                    type="button"
                    onClick={() => onSelectConversation(c.jid)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '12px 14px',
                      border: 'none',
                      borderBottom: '1px solid var(--border-light)',
                      background: active
                        ? 'var(--surface-accent)'
                        : 'transparent',
                      cursor: 'pointer',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                        alignItems: 'baseline',
                      }}
                    >
                      <strong style={{ fontSize: 14 }}>{title}</strong>
                      <span className="settings-hint" style={{ fontSize: 11 }}>
                        {Number(c.is_pinned || 0) === 1
                          ? `${t('im.置顶')} · `
                          : ''}
                        {formatPreviewTime(c.last_message_time)}
                      </span>
                    </div>
                    <div
                      className="settings-hint"
                      style={{
                        fontSize: 12,
                        marginTop: 4,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.last_message_content
                        ? `${c.last_message_sender ? `${c.last_message_sender}: ` : ''}${c.last_message_content}`
                        : t('im.暂无消息')}
                      {Number(c.is_muted || 0) === 1
                        ? ` · ${t('im.静音')}`
                        : ''}
                      {Number(c.unread_count || 0) > 0
                        ? ` · ${c.unread_count}`
                        : ''}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </>
      ) : (
        <>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                borderRadius: 10,
                border: '1px solid var(--border)',
                background: 'var(--input-bg)',
              }}
            >
              <input
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder={t('im.搜索用户（至少 2 字）')}
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                }}
              />
              {!userQuery && <IconSearch />}
            </div>
            {searching ? (
              <div className="settings-hint" style={{ marginTop: 8 }}>
                {t('im.搜索中…')}
              </div>
            ) : null}
            {searchErr ? (
              <div
                style={{
                  marginTop: 8,
                  color: 'var(--error-text)',
                  fontSize: 13,
                }}
              >
                {searchErr}
              </div>
            ) : null}
            {searchHits.length > 0 ? (
              <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                <div className="settings-hint">{t('im.搜索结果')}</div>
                {searchHits.map((u) => {
                  const alreadyFriend = friendIdSet.has(u.id);
                  const fb = feedbackMap[u.id];
                  return (
                    <div
                      key={u.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        padding: 8,
                        borderRadius: 10,
                        border: '1px solid var(--border)',
                        background: 'var(--surface-subtle)',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {u.display_name || u.username}
                        </div>
                        <div className="settings-hint" style={{ fontSize: 12 }}>
                          @{u.username}
                        </div>
                        {fb ? (
                          <div
                            style={{
                              fontSize: 12,
                              marginTop: 4,
                              color:
                                fb.tone === 'success'
                                  ? 'var(--success-text, #22c55e)'
                                  : 'var(--error-text)',
                            }}
                          >
                            {fb.text}
                          </div>
                        ) : null}
                      </div>
                      {alreadyFriend ? (
                        <span
                          className="settings-hint"
                          style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                        >
                          {t('im.已是好友')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn-outline btn-sm"
                          disabled={requestingId === u.id}
                          onClick={() => void sendRequest(u.id)}
                        >
                          {requestingId === u.id
                            ? t('im.发送中…')
                            : t('im.加好友')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <div className="settings-hint" style={{ padding: '10px 12px' }}>
              {t('im.好友')} ({friends.length})
            </div>
            {listsLoading && friends.length === 0 ? (
              <div
                className="settings-hint"
                style={{ padding: 16, textAlign: 'center' }}
              >
                {t('im.加载中…')}
              </div>
            ) : friends.length === 0 ? (
              <div className="settings-hint" style={{ padding: 16 }}>
                {t('im.暂无好友。搜索用户并发送好友请求。')}
              </div>
            ) : (
              friends.map((f) => {
                const label = f.display_name || f.username;
                const starting = dmStartingId === f.friend_id;
                return (
                  <div
                    key={f.friend_id}
                    style={{
                      padding: '12px 14px',
                      borderBottom: '1px solid var(--border-light)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {label}
                      </div>
                      <div className="settings-hint" style={{ fontSize: 12 }}>
                        @{f.username}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      disabled={starting}
                      onClick={() => void handleStartDm(f.friend_id)}
                    >
                      {starting ? t('im.创建中...') : t('im.发消息')}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </aside>
  );
}
