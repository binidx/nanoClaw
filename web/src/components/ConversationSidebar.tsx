import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import type {
  ChannelFilter,
  Conversation,
  ConversationSort,
} from '../app-types';
import {
  getConversationChannelLabel,
  getConversationMentionCandidates,
} from '../app-helpers';
import { AppSelect, type AppSelectOption } from './AppSelect';
import { IconCheckSquare, IconPin, IconSort } from './AppIcons';
import { NcCheckbox } from './common';
import { useTranslation } from 'react-i18next';

interface ConversationSidebarProps {
  channelFilter: ChannelFilter;
  availableChannels: string[];
  channelCounts: Record<string, number>;
  busyByJid: Record<string, boolean>;
  unreadRepliesByJid: Record<string, number>;
  setChannelFilter: (filter: ChannelFilter) => void;
  conversationSort: ConversationSort;
  setConversationSort: (value: ConversationSort) => void;
  batchDeleteEnabled: boolean;
  allVisibleSelected: boolean;
  visibleConversationJids: string[];
  selectedConversationJids: Set<string>;
  filteredConversations: Conversation[];
  activeJid: string | null;
  createConversation: (assistantId?: string | null) => void;
  toggleSelectAllVisible: () => void;
  deleteSelectedConversations: () => void;
  toggleBatchDeleteEnabled: () => void;
  toggleConversationSelection: (jid: string) => void;
  switchConversation: (jid: string) => void;
  updateConversationMeta: (
    jid: string,
    updates: {
      customTitle?: string | null;
      isPinned?: boolean;
      isFavorite?: boolean;
    },
  ) => void;
  renameConversation: (conversation: Conversation) => void | Promise<void>;
  deleteConversationByJid: (jid: string, name: string) => void | Promise<void>;
  getConversationTitle: (
    conversation: Conversation | null | undefined,
  ) => string;
  stripLeadingMention: (content: string, name?: string | string[]) => string;
  getDisplayContent: (
    content: string,
    isBot: boolean,
    channel?: string,
    name?: string | string[],
  ) => string;
  formatTime: (ts: string) => string;
}

interface PreparedConversationItem {
  conversation: Conversation;
  title: string;
  preview: string;
  sourceLabel: string;
  isBusy: boolean;
  unreadCount: number;
  formattedTime: string | null;
  assistantName?: string | null;
}

function getChannelBadge(channel: string): string {
  switch (channel) {
    case 'web':
      return 'W';
    case 'feishu':
      return '飞';
    case 'telegram':
      return 'T';
    case 'discord':
      return 'D';
    case 'slack':
      return 'S';
    case 'gmail':
      return 'G';
    case 'whatsapp':
      return 'WA';
    default:
      return channel ? channel.slice(0, 2).toUpperCase() : '#';
  }
}

export const ConversationSidebar = memo(function ConversationSidebar({
  channelFilter,
  availableChannels,
  channelCounts,
  busyByJid,
  unreadRepliesByJid,
  setChannelFilter,
  conversationSort,
  setConversationSort,
  batchDeleteEnabled,
  allVisibleSelected,
  visibleConversationJids,
  selectedConversationJids,
  filteredConversations,
  activeJid,
  createConversation,
  toggleSelectAllVisible,
  deleteSelectedConversations,
  toggleBatchDeleteEnabled,
  toggleConversationSelection,
  switchConversation,
  updateConversationMeta,
  renameConversation,
  deleteConversationByJid,
  getConversationTitle,
  stripLeadingMention,
  getDisplayContent,
  formatTime,
}: ConversationSidebarProps) {
  const { t } = useTranslation('chat');
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const sortOptions = useMemo<AppSelectOption[]>(() => [
    { value: 'recent', label: t('sort.recent') },
    { value: 'unread', label: t('sort.unread') },
    { value: 'name', label: t('sort.name') },
  ], [t]);

  const channelLabel = useCallback((channel: string): string => {
    switch (channel) {
      case 'all': return t('channel.all');
      case 'web': return 'Web';
      case 'feishu': return t('channel.feishu');
      case 'telegram': return 'Telegram';
      case 'discord': return 'Discord';
      case 'slack': return 'Slack';
      case 'gmail': return 'Gmail';
      case 'whatsapp': return 'WhatsApp';
      default: return channel ? channel[0].toUpperCase() + channel.slice(1) : t('channel.unknown');
    }
  }, [t]);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    searchRef.current?.focus();
  }, []);

  const realChannels = useMemo(
    () => availableChannels.filter((channel) => channel && channel !== 'all'),
    [availableChannels],
  );
  const channelTabs = useMemo(
    () => (realChannels.length > 1 ? ['all', ...realChannels] : ['all']),
    [realChannels],
  );
  const sortLabel =
    conversationSort === 'unread'
      ? t('sort.unread')
      : conversationSort === 'name'
        ? t('sort.name')
        : t('sort.recent');
  const activeChannelLabel = channelLabel(channelFilter);
  const batchDeleteTitle =
    selectedConversationJids.size === 0
      ? t('batch.selectTitle')
      : t('batch.deleteTitle', { count: selectedConversationJids.size });
  const batchManageTitle =
    filteredConversations.length === 0
      ? t('batch.manageTitleDisabled')
      : t('batch.manageTitle', { count: filteredConversations.length });
  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const sidebarVirtuosoRef = useRef<VirtuosoHandle>(null);
  const [sidebarScrollParent, setSidebarScrollParent] =
    useState<HTMLDivElement | null>(null);
  const bindConversationListEl = useCallback(
    (el: HTMLDivElement | null) => {
      conversationListRef.current = el;
      setSidebarScrollParent((prev) => (prev === el ? prev : el));
    },
    [],
  );
  const sortSelect = (
    <AppSelect
      value={conversationSort}
      onChange={(nextValue) =>
        setConversationSort(nextValue as ConversationSort)
      }
      ariaLabel={t('sort.ariaLabel', { label: sortLabel })}
      disabled={filteredConversations.length === 0}
      iconOnly
      triggerIcon={<IconSort />}
      compact
      className="conversation-sort-select conversation-sort-icon-button"
      options={sortOptions}
    />
  );

  const preparedConversations = useMemo<PreparedConversationItem[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = filteredConversations.map((conversation) => {
      const mentionCandidates =
        getConversationMentionCandidates(conversation);
      const previewSource = conversation.last_message || '';
      const preview =
        (conversation.channel === 'web'
          ? stripLeadingMention(previewSource, mentionCandidates)
          : getDisplayContent(
              previewSource,
              false,
              conversation.channel,
              mentionCandidates,
            )
        ).slice(0, 80) || t('empty.noMessages');

      return {
        conversation,
        title: getConversationTitle(conversation) || conversation.jid,
        preview,
        sourceLabel: getConversationChannelLabel(conversation),
        isBusy: !!busyByJid[conversation.jid],
        unreadCount: unreadRepliesByJid[conversation.jid] || 0,
        formattedTime: conversation.last_message_time
          ? formatTime(conversation.last_message_time)
          : null,
        assistantName: conversation.assistantName || null,
      };
    });
    if (!q) return list;
    return list.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.preview.toLowerCase().includes(q),
    );
  }, [
    busyByJid,
    filteredConversations,
    formatTime,
    getConversationTitle,
    getDisplayContent,
    searchQuery,
    stripLeadingMention,
    t,
    unreadRepliesByJid,
  ]);

  useEffect(() => {
    if (!activeJid) return;
    const idx = preparedConversations.findIndex(
      (item) => item.conversation.jid === activeJid,
    );
    if (idx === -1) return;

    const frameId = window.requestAnimationFrame(() => {
      sidebarVirtuosoRef.current?.scrollToIndex({
        index: idx,
        align: 'center',
        behavior: 'smooth',
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeJid, preparedConversations]);

  const activateConversationItem = (jid: string) => {
    if (batchDeleteEnabled) toggleConversationSelection(jid);
    else switchConversation(jid);
  };

  const focusConversationItemAtIndex = useCallback(
    (nextIndex: number) => {
      const max = preparedConversations.length - 1;
      const clamped = Math.max(0, Math.min(max, nextIndex));
      sidebarVirtuosoRef.current?.scrollToIndex({
        index: clamped,
        align: 'center',
      });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          conversationListRef.current
            ?.querySelector<HTMLElement>(
              `[data-conversation-item-index="${clamped}"]`,
            )
            ?.focus();
        });
      });
    },
    [preparedConversations],
  );

  const stopConversationActionPropagation = (
    event: ReactKeyboardEvent<HTMLElement>,
  ) => {
    event.stopPropagation();
  };

  const handleConversationItemKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    jid: string,
    itemIndex: number,
  ) => {
    if (event.target !== event.currentTarget) return;

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateConversationItem(jid);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusConversationItemAtIndex(itemIndex + 1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusConversationItemAtIndex(itemIndex - 1);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      focusConversationItemAtIndex(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      focusConversationItemAtIndex(preparedConversations.length - 1);
    }
  };

  return (
    <aside className="conv-panel">
      <button
        type="button"
        className="new-chat-btn"
        onClick={() => createConversation()}
      >
        {t('newConversation')}
      </button>

      <div className="conversation-search">
        <input
          ref={searchRef}
          className="conversation-search-input"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          onKeyDown={(e) => { if (e.key === 'Escape') clearSearch(); }}
        />
        {searchQuery ? (
          <button className="conversation-search-clear" onClick={clearSearch}>×</button>
        ) : (
          <span className="conversation-search-icon" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
        )}
      </div>

      <div className="channel-tabs-row">
        <div className="channel-tabs">
          {channelTabs.map((key) => (
            <button
              key={key}
              type="button"
              className={`channel-tab ${channelFilter === key ? 'active' : ''}`}
              onClick={() => setChannelFilter(key)}
              aria-pressed={channelFilter === key}
            >
              <span>{channelLabel(key)}</span>
              <span className="channel-tab-count">
                {channelCounts[key] || 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="conversation-toolbar">
        <div
          className={`conversation-toolbar-shell ${batchDeleteEnabled ? 'is-batch' : ''}`}
        >
          <div className="conversation-toolbar-status" aria-live="polite">
            <span className="conversation-toolbar-status-value">
              {batchDeleteEnabled
                ? t('batch.selected', { selected: selectedConversationJids.size, total: visibleConversationJids.length })
                : t('batch.count', { channel: activeChannelLabel, count: filteredConversations.length })}
            </span>
          </div>

          {batchDeleteEnabled ? (
            <div className="conversation-toolbar-inline conversation-toolbar-inline-batch">
              <NcCheckbox
                className="conversation-select-all"
                checked={allVisibleSelected}
                onChange={toggleSelectAllVisible}
                disabled={visibleConversationJids.length === 0}
                label={t('batch.selectAll')}
              />
              <button
                type="button"
                className="btn-danger btn-sm"
                onClick={deleteSelectedConversations}
                disabled={selectedConversationJids.size === 0}
                title={batchDeleteTitle}
              >
                {t('batch.delete')}
              </button>
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={toggleBatchDeleteEnabled}
              >
                {t('batch.done')}
              </button>
            </div>
          ) : (
            <div className="conversation-toolbar-inline">
              <button
                type="button"
                className="conversation-toolbar-icon-btn conversation-batch-trigger"
                onClick={toggleBatchDeleteEnabled}
                disabled={filteredConversations.length === 0}
                aria-label={batchManageTitle}
                title={batchManageTitle}
              >
                <IconCheckSquare />
              </button>
              {sortSelect}
            </div>
          )}
        </div>
      </div>

      <div className="conversation-list" ref={bindConversationListEl}>
        {preparedConversations.length === 0 ? (
          <div className="conv-empty">{t('empty.noConversations')}</div>
        ) : sidebarScrollParent ? (
          <Virtuoso
            ref={sidebarVirtuosoRef}
            customScrollParent={sidebarScrollParent}
            style={{ flex: 1, minHeight: 0 }}
            data={preparedConversations}
            itemContent={(index, item) => {
              const {
                conversation,
                formattedTime,
                isBusy,
                preview,
                sourceLabel,
                title,
                unreadCount,
                assistantName,
              } = item;
              const checked = selectedConversationJids.has(conversation.jid);
              return (
            <div
              className={`conversation-item ${conversation.jid === activeJid ? 'active' : ''} ${batchDeleteEnabled && checked ? 'selected' : ''}`}
              onClick={() => activateConversationItem(conversation.jid)}
              onKeyDown={(event) =>
                handleConversationItemKeyDown(event, conversation.jid, index)
              }
              tabIndex={0}
              role="button"
              data-conversation-item-index={index}
              data-conversation-active={
                conversation.jid === activeJid ? 'true' : 'false'
              }
              aria-pressed={batchDeleteEnabled ? checked : undefined}
              aria-current={conversation.jid === activeJid ? 'page' : undefined}
              aria-label={
                batchDeleteEnabled ? t('sidebar.a11y.select', { title }) : t('sidebar.a11y.open', { title })
              }
            >
              {batchDeleteEnabled && (
                <label
                  className="conversation-checkbox"
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      toggleConversationSelection(conversation.jid)
                    }
                    aria-label={t('sidebar.a11y.select', { title })}
                  />
                </label>
              )}
              <div className="conv-icon">
                {getChannelBadge(conversation.channel)}
              </div>
              <div className="conv-info">
                <div className="conv-top-row">
                  <div className="conv-name-row">
                    <div className="conv-name" title={title}>
                      {title}
                    </div>
                  </div>
                  <div className="conv-actions">
                    <button
                      type="button"
                      className={`conv-action-btn ${conversation.is_pinned ? 'active' : ''}`}
                      title={conversation.is_pinned ? t('action.unpin') : t('action.pin')}
                      aria-label={
                        conversation.is_pinned
                          ? t('sidebar.a11y.unpin', { title })
                          : t('sidebar.a11y.pin', { title })
                      }
                      aria-pressed={!!conversation.is_pinned}
                      onKeyDown={stopConversationActionPropagation}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateConversationMeta(conversation.jid, {
                          isPinned: !conversation.is_pinned,
                        });
                      }}
                    >
                      <IconPin filled={!!conversation.is_pinned} />
                    </button>
                    <button
                      type="button"
                      className="conv-action-btn"
                      title={t('action.rename')}
                      aria-label={t('sidebar.a11y.rename', { title })}
                      onKeyDown={stopConversationActionPropagation}
                      onClick={(event) => {
                        event.stopPropagation();
                        renameConversation(conversation);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="conv-delete-btn"
                      title={t('action.delete')}
                      aria-label={t('sidebar.a11y.delete', { title })}
                      onKeyDown={stopConversationActionPropagation}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteConversationByJid(
                          conversation.jid,
                          getConversationTitle(conversation),
                        );
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="conv-preview">{preview}</div>
                <div className="conv-meta-row">
                  {sourceLabel ? (
                    <span className="conv-badge source">{sourceLabel}</span>
                  ) : null}
                  {assistantName ? (
                    <span className="conv-badge assistant">{assistantName}</span>
                  ) : null}
                  {isBusy ? (
                    <span className="conv-badge busy">{t('status.processing')}</span>
                  ) : null}
                  {unreadCount > 0 ? (
                    <span className="conv-badge unread">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  ) : null}
                  {conversation.is_pinned ? (
                    <span className="conv-badge pin">{t('status.pinned')}</span>
                  ) : null}
                  {formattedTime ? (
                    <div className="conv-time">{formattedTime}</div>
                  ) : null}
                </div>
              </div>
            </div>
              );
            }}
          />
        ) : null}
      </div>
    </aside>
  );
});
