import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImFriendRequest } from '../im-api';
import {
  acceptFriendRequest,
  getFriendRequests,
  rejectFriendRequest,
} from '../im-api';

export interface ImFriendRequestDialogProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

function getStatusLabel(status: string, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    pending: t('im.待处理'),
    accepted: t('im.已同意'),
    rejected: t('im.已拒绝'),
  };
  return labels[status] || status;
}

interface RowFeedback {
  tone: 'success' | 'error';
  text: string;
}

export function ImFriendRequestDialog({
  open,
  onClose,
  onChanged,
}: ImFriendRequestDialogProps) {
  const { t } = useTranslation('im');
  const [received, setReceived] = useState<ImFriendRequest[]>([]);
  const [sent, setSent] = useState<ImFriendRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowFeedback, setRowFeedback] = useState<Record<string, RowFeedback>>({});

  useEffect(() => {
    if (Object.keys(rowFeedback).length === 0) return;
    const t = window.setTimeout(() => setRowFeedback({}), 4000);
    return () => clearTimeout(t);
  }, [rowFeedback]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await getFriendRequests();
      setReceived(res.received);
      setSent(res.sent);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('im.加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const accept = async (id: string) => {
    setBusyId(id);
    try {
      await acceptFriendRequest(id);
      setRowFeedback((p) => ({ ...p, [id]: { tone: 'success', text: t('im.已同意') } }));
      onChanged();
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('im.操作失败');
      setRowFeedback((p) => ({ ...p, [id]: { tone: 'error', text: msg } }));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (id: string) => {
    setBusyId(id);
    try {
      await rejectFriendRequest(id);
      setRowFeedback((p) => ({ ...p, [id]: { tone: 'success', text: t('im.已拒绝') } }));
      onChanged();
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('im.操作失败');
      setRowFeedback((p) => ({ ...p, [id]: { tone: 'error', text: msg } }));
    } finally {
      setBusyId(null);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        style={{ maxWidth: 520, width: '100%' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="im-fr-title"
      >
        <h3 id="im-fr-title">{t('im.好友请求')}</h3>
        {loading ? <div className="settings-hint">{t('im.加载中…')}</div> : null}
        {err ? (
          <div style={{ color: 'var(--error-text)', marginBottom: 8 }}>{err}</div>
        ) : null}

        <div className="form-group">
          <label>{t('im.收到的请求')}</label>
          {received.length === 0 ? (
            <div className="settings-hint">{t('im.暂无待处理请求')}</div>
          ) : (
            <ul style={{ listStyle: 'none', display: 'grid', gap: 10, padding: 0, margin: 0 }}>
              {received.map((r) => {
                const fb = rowFeedback[r.id];
                return (
                  <li
                    key={r.id}
                    style={{
                      padding: 12,
                      borderRadius: 12,
                      border: '1px solid var(--border)',
                      background: 'var(--surface-subtle)',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {r.sender_display_name || r.sender_username}
                      <span className="settings-hint" style={{ marginLeft: 8, fontWeight: 400 }}>
                        @{r.sender_username}
                      </span>
                    </div>
                    {r.message ? (
                      <div style={{ fontSize: 13, marginTop: 6 }}>{r.message}</div>
                    ) : null}
                    {fb ? (
                      <div
                        style={{
                          fontSize: 12,
                          marginTop: 6,
                          color: fb.tone === 'success' ? 'var(--success-text, #22c55e)' : 'var(--error-text)',
                        }}
                      >
                        {fb.text}
                      </div>
                    ) : null}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button
                        type="button"
                        className="btn-primary btn-sm"
                        disabled={busyId === r.id}
                        onClick={() => void accept(r.id)}
                      >
                        {busyId === r.id ? t('im.处理中…') : t('im.同意')}
                      </button>
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        disabled={busyId === r.id}
                        onClick={() => void reject(r.id)}
                      >
                        {t('im.拒绝')}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="form-group">
          <label>{t('im.已发送')}</label>
          {sent.length === 0 ? (
            <div className="settings-hint">{t('im.暂无记录')}</div>
          ) : (
            <ul style={{ listStyle: 'none', display: 'grid', gap: 8, padding: 0, margin: 0 }}>
              {sent.map((r) => {
                const name = r.to_display_name || r.to_username || r.to_user_id.slice(0, 8) + '…';
                return (
                  <li
                    key={r.id}
                    style={{
                      padding: 10,
                      borderRadius: 10,
                      border: '1px solid var(--border)',
                      fontSize: 13,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span>→ {String(name)}</span>
                    <span
                      className="settings-hint"
                      style={{
                        fontSize: 12,
                        color:
                          r.status === 'accepted'
                            ? 'var(--success-text, #22c55e)'
                            : r.status === 'rejected'
                              ? 'var(--error-text)'
                              : undefined,
                      }}
                    >
                      {getStatusLabel(r.status, t)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="btn-outline btn-sm"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? t('im.加载中…') : t('im.刷新')}
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={onClose}>
            {t('im.关闭')}
          </button>
        </div>
      </div>
    </div>
  );
}
