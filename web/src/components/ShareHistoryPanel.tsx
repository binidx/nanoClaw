import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ShareEntry {
  id: string;
  chat_jid: string;
  title: string | null;
  assistant_name: string | null;
  created_at: string;
  view_count: number;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

export function ShareHistoryPanel({
  open,
  onClose,
  activeJid,
}: {
  open: boolean;
  onClose: () => void;
  activeJid: string | null;
}) {
  const { t } = useTranslation('share');
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [shareBaseUrl, setShareBaseUrl] = useState(window.location.origin);

  const fetchShares = useCallback(async () => {
    if (!activeJid) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/my-shares?limit=50&jid=${encodeURIComponent(activeJid)}`,
      );
      if (res.ok) {
        const data = (await res.json()) as {
          shares: ShareEntry[];
          total: number;
          shareBaseUrl?: string;
        };
        setShares(data.shares);
        setTotal(data.total);
        setShareBaseUrl(
          typeof data.shareBaseUrl === 'string' && data.shareBaseUrl
            ? data.shareBaseUrl
            : window.location.origin,
        );
      }
    } catch {
      /* offline */
    } finally {
      setLoading(false);
    }
  }, [activeJid]);

  useEffect(() => {
    if (open) void fetchShares();
  }, [open, fetchShares]);

  const handleCopy = useCallback((shareId: string) => {
    const url = `${shareBaseUrl}/share/${shareId}`;
    void copyText(url).then(() => {
      setCopiedId(shareId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, [shareBaseUrl]);

  const handleDelete = useCallback(
    async (shareId: string) => {
      setDeletingId(shareId);
      try {
        const res = await fetch(`/api/share/${shareId}`, { method: 'DELETE' });
        if (res.ok) {
          setShares((prev) => prev.filter((s) => s.id !== shareId));
          setTotal((prev) => prev - 1);
        }
      } catch {
        /* offline */
      } finally {
        setDeletingId(null);
      }
    },
    [],
  );

  const handleView = useCallback((shareId: string) => {
    window.open(`${shareBaseUrl}/share/${shareId}`, '_blank');
  }, [shareBaseUrl]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="share-history-overlay" onClick={onClose}>
      <div className="share-history-panel" onClick={(e) => e.stopPropagation()}>
        <div className="share-history-header">
          <h3>{t('title')}</h3>
          <span className="share-history-count">{t('count', { count: total })}</span>
          <button className="modal-close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="share-history-body">
          {loading && shares.length === 0 && (
            <div className="share-history-empty">{t('loading')}</div>
          )}
          {!loading && shares.length === 0 && (
            <div className="share-history-empty">{t('empty')}</div>
          )}
          {shares.map((share) => (
            <div key={share.id} className="share-history-item">
              <div className="share-history-item-info">
                <div className="share-history-item-title">
                  {share.title || t('unnamed')}
                </div>
                <div className="share-history-item-meta">
                  <span>{formatDate(share.created_at)}</span>
                  <span>·</span>
                  <span>{t('viewCount', { count: share.view_count })}</span>
                  {share.assistant_name && (
                    <>
                      <span>·</span>
                      <span>{share.assistant_name}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="share-history-item-actions">
                <button
                  className="share-history-btn view"
                  onClick={() => handleView(share.id)}
                  title={t('view')}
                >
                  ↗
                </button>
                <button
                  className={`share-history-btn copy ${copiedId === share.id ? 'copied' : ''}`}
                  onClick={() => handleCopy(share.id)}
                  title={t('copyLink')}
                >
                  {copiedId === share.id ? '✓' : '🔗'}
                </button>
                <button
                  className="share-history-btn delete"
                  onClick={() => void handleDelete(share.id)}
                  disabled={deletingId === share.id}
                  title={t('delete')}
                >
                  {deletingId === share.id ? '…' : '✕'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
