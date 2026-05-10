import { memo, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ChatTimelineEntry } from '../app-types';
import { renderMarkdownContent } from '../markdown';
import { applyThemeToDocument, resolveInitialTheme } from '../theme';
import '../App.css';

interface ShareData {
  id: string;
  title: string | null;
  entries: ChatTimelineEntry[];
  assistantName: string | null;
  createdBy: string | null;
  createdAt: string;
  viewCount: number;
}

const MarkdownBlock = memo(function MarkdownBlock({
  content,
  className,
}: {
  content: string;
  className: string;
}) {
  const rendered = useMemo(() => renderMarkdownContent(content), [content]);
  return <div className={className}>{rendered}</div>;
});

function formatShareDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function ShareViewPage() {
  const { t } = useTranslation('share');
  const { shareId } = useParams<{ shareId: string }>();
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const theme = resolveInitialTheme();
    applyThemeToDocument(document, theme);

    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');
    html.style.height = 'auto';
    body.style.height = 'auto';
    body.style.overflow = 'auto';
    if (root) root.style.height = 'auto';

    return () => {
      html.style.height = '';
      body.style.height = '';
      body.style.overflow = '';
      if (root) root.style.height = '';
    };
  }, []);

  useEffect(() => {
    if (!shareId) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/share/${encodeURIComponent(shareId)}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error || t('auto.e211b5de'));
          return;
        }
        const json = await res.json();
        if (!cancelled) setData(json as ShareData);
      } catch {
        if (!cancelled) setError(t('auto.ed1c1051'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [shareId, t]);

  if (loading) {
    return (
      <div className="share-view-page">
        <div className="share-view-loading">{t('auto.f013ea9d')}</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="share-view-page">
        <div className="share-view-error">
          <div className="share-view-error-icon">
            <span aria-hidden="true">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 17H7A5 5 0 0 1 7 7h2" />
                <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </span>
          </div>
          <div className="share-view-error-text">{error || t('auto.d5fd0f4d')}</div>
        </div>
      </div>
    );
  }

  const assistantInitial = (data.assistantName || 'N')[0].toUpperCase();

  return (
    <div className={`share-view-page${isFullscreen ? ' share-view-fullscreen' : ''}`}>
      <header className="share-view-header">
        <div className="share-view-header-main">
          <h1 className="share-view-title">{data.title || t('auto.42e38e23')}</h1>
          <div className="share-view-meta">
            <span>{t('auto.8a9293aa')} {formatShareDate(data.createdAt)}</span>
            <span>·</span>
            <span>{data.viewCount} {t('auto.234409c5')}</span>
          </div>
        </div>
        <button
          type="button"
          className="share-view-fullscreen-btn"
          onClick={() => setIsFullscreen((prev) => !prev)}
          title={isFullscreen ? t('auto.4a94aeb9') : t('auto.9969816d')}
          aria-label={isFullscreen ? t('auto.4a94aeb9') : t('auto.9969816d')}
        >
          {isFullscreen ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>
      </header>
      <div className="share-view-messages">
        {data.entries.map((entry) => (
          <ShareTimelineEntry
            key={entry.key}
            entry={entry}
            assistantName={data.assistantName || 'Assistant'}
            assistantInitial={assistantInitial}
          />
        ))}
      </div>
    </div>
  );
}

function ShareTimelineEntry({
  entry,
  assistantName,
  assistantInitial,
}: {
  entry: ChatTimelineEntry;
  assistantName: string;
  assistantInitial: string;
}) {
  const { t } = useTranslation('share');
  if (entry.kind === 'user_message') {
    const content = entry.message.content || '';
    return (
      <div className="msg-row user">
        <div className="msg-bubble-wrap">
          <div className="msg-bubble user">
            <MarkdownBlock className="msg-text markdown" content={content} />
          </div>
          <div className="msg-meta">
            {entry.message.timestamp
              ? new Date(entry.message.timestamp).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : ''}
          </div>
        </div>
        <div className="msg-avatar user-avatar">U</div>
      </div>
    );
  }

  if (entry.kind === 'assistant_message') {
    return (
      <div className="msg-row bot timeline-entry-row">
        <div className="msg-avatar bot-avatar">{assistantInitial}</div>
        <div className="msg-bubble-wrap">
          <div className="assistant-turn-node assistant-turn-node-assistant_message single-entry-node">
            <div className="assistant-turn-node-main">
              <div className="assistant-turn-card assistant-response-card assistant-entry-card turn-item turn-item-response status-completed">
                <div className="turn-item-body turn-item-body-response">
                  <MarkdownBlock className="msg-text markdown assistant-turn-text" content={entry.text} />
                </div>
              </div>
            </div>
          </div>
          <div className="msg-meta">
            <span className="assistant-name-label">{assistantName}</span>
          </div>
        </div>
      </div>
    );
  }

  if (entry.kind === 'reasoning') {
    return (
      <div className="msg-row bot timeline-entry-row">
        <div className="msg-avatar bot-avatar ghost" />
        <div className="msg-bubble-wrap">
          <div className="assistant-turn-node assistant-turn-node-reasoning_group single-entry-node">
            <div className="assistant-turn-node-main">
              <details className="assistant-turn-card assistant-reasoning-card turn-item turn-item-reasoning status-completed" open>
                <summary className="turn-item-header turn-item-summary">
                  <span className="turn-item-summary-icon reasoning" aria-hidden="true" />
                  <div className="turn-item-summary-main">
                    <div className="turn-item-summary-top">
                      <span className="turn-item-kind reasoning">{t('auto.21d68b2d')}</span>
                      <span className="turn-item-title">{entry.item.title || t('auto.961a6a15')}</span>
                    </div>
                  </div>
                </summary>
                <div className="turn-item-body turn-item-body-reasoning">
                  <div className="turn-item-section">
                    <div className="assistant-activity-text assistant-activity-text-block">
                      <span className="assistant-activity-body">
                        {entry.item.text || ''}
                      </span>
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (entry.kind === 'tool_call') {
    const name = entry.item.title || 'tool';
    const statusLabel =
      entry.item.status === 'completed'
        ? t('auto.fad5222c')
        : entry.item.status === 'failed'
          ? t('auto.acd5cb84')
          : t('auto.fb852fc6');
    return (
      <div className="msg-row bot timeline-entry-row">
        <div className="msg-avatar bot-avatar ghost" />
        <div className="msg-bubble-wrap">
          <div className="assistant-turn-node assistant-turn-node-tool_call single-entry-node">
            <div className="assistant-turn-node-main">
              <details className="assistant-turn-card assistant-tool-card turn-item turn-item-tool">
                <summary className="turn-item-header turn-item-summary">
                  <span className="turn-item-summary-icon" aria-hidden="true" />
                  <div className="turn-item-summary-main">
                    <div className="turn-item-summary-top">
                      <span className="turn-item-kind tool_call">{t('auto.20dce2c6')}</span>
                      <span className="turn-item-title">{name}</span>
                      <span className={`turn-item-status ${entry.item.status}`}>{statusLabel}</span>
                    </div>
                    <span className="turn-item-preview">
                      {entry.item.resultText || entry.item.argumentsText || ''}
                    </span>
                  </div>
                </summary>
                <div className="turn-item-body">
                  {entry.item.argumentsText && (
                    <div className="turn-item-section">
                      <div className="turn-item-label">{t('auto.e47d59b1')}</div>
                      <pre className="turn-item-code">{entry.item.argumentsText}</pre>
                    </div>
                  )}
                  {entry.item.resultText && (
                    <div className="turn-item-section">
                      <div className="turn-item-label">{t('auto.5ad7f5a8')}</div>
                      <pre className="turn-item-code">{entry.item.resultText}</pre>
                    </div>
                  )}
                  {entry.item.errorText && (
                    <div className="turn-item-section">
                      <div className="turn-item-label">{t('auto.7030ff64')}</div>
                      <pre className="turn-item-code turn-item-code-error">{entry.item.errorText}</pre>
                    </div>
                  )}
                </div>
              </details>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (entry.kind === 'turn_error') {
    return (
      <div className="msg-row bot timeline-entry-row">
        <div className="msg-avatar bot-avatar ghost" />
        <div className="msg-bubble-wrap">
          <div className="turn-error">{entry.error}</div>
        </div>
      </div>
    );
  }

  return null;
}
