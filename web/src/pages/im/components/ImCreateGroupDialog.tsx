import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImFriend } from '../im-api';
import { createGroup } from '../im-api';

export interface ImCreateGroupDialogProps {
  open: boolean;
  onClose: () => void;
  friends: ImFriend[];
  onCreated: (jid: string) => void;
}

export function ImCreateGroupDialog({
  open,
  onClose,
  friends,
  onCreated,
}: ImCreateGroupDialogProps) {
  const { t } = useTranslation('im');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    const memberIds = [...selected];
    if (saving || !name.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await createGroup(name.trim(), memberIds, visibility);
      onCreated(res.jid);
      setName('');
      setSelected(new Set());
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('im.创建失败'));
    } finally {
      setSaving(false);
    }
  }, [name, onClose, onCreated, saving, selected, visibility]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        style={{ maxWidth: 480, width: '100%' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="im-create-group-title"
      >
        <h3 id="im-create-group-title">{t('im.新建群聊')}</h3>
        <div className="form-group">
          <label>{t('im.群名称')}</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('im.输入群名称')}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--input-bg)',
              color: 'var(--text-primary)',
              fontSize: 14,
              outline: 'none',
            }}
          />
        </div>
        <div className="form-group">
          <label>{t('im.可见性')}</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className={visibility === 'private' ? 'btn-primary btn-sm' : 'btn-outline btn-sm'}
              onClick={() => setVisibility('private')}
            >
              {t('im.私有')}
            </button>
            <button
              type="button"
              className={visibility === 'public' ? 'btn-primary btn-sm' : 'btn-outline btn-sm'}
              onClick={() => setVisibility('public')}
            >
              {t('im.公开')}
            </button>
          </div>
        </div>
        <div className="form-group">
          <label>{t('im.选择成员（从好友）')}</label>
          <div
            style={{
              maxHeight: 220,
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 8,
              display: 'grid',
              gap: 6,
              background: 'var(--surface-subtle)',
            }}
          >
            {friends.length === 0 ? (
              <div className="settings-hint">{t('im.暂无好友可邀请')}</div>
            ) : (
              friends.map((f) => {
                const isSelected = selected.has(f.friend_id);
                return (
                  <button
                    type="button"
                    key={f.friend_id}
                    onClick={() => toggle(f.friend_id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '6px 8px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      border: isSelected ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                      background: isSelected ? 'var(--surface-accent)' : 'transparent',
                      color: 'var(--text-primary)',
                      textAlign: 'left',
                      width: '100%',
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        border: isSelected ? '1.5px solid var(--primary)' : '1.5px solid var(--border)',
                        background: isSelected ? 'var(--primary)' : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        color: 'white',
                        fontSize: 12,
                      }}
                    >
                      {isSelected ? '✓' : ''}
                    </span>
                    <span>
                      {f.display_name || f.username}{' '}
                      <span className="settings-hint">@{f.username}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
        {err ? (
          <div style={{ color: 'var(--error-text)', fontSize: 13, marginBottom: 8 }}>{err}</div>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" className="btn-outline btn-sm" disabled={saving} onClick={onClose}>
            {t('im.取消')}
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={saving || !name.trim()}
            onClick={() => void submit()}
          >
            {saving ? t('im.新建中...') : t('im.新建')}
          </button>
        </div>
      </div>
    </div>
  );
}
