import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImMessage } from '../im-api';

export interface ImEditMessageDialogProps {
  message: ImMessage | null;
  onClose: () => void;
  onSubmit: (messageId: string, content: string) => void | Promise<void>;
}

export function ImEditMessageDialog({
  message,
  onClose,
  onSubmit,
}: ImEditMessageDialogProps) {
  const { t } = useTranslation('im');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (message) {
      setContent(message.content);
      setBusy(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [message]);

  if (!message) return null;

  const handleSubmit = async () => {
    const trimmed = content.trim();
    if (!trimmed || trimmed === message.content) return;
    setBusy(true);
    try {
      await onSubmit(message.id, trimmed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="im-dialog-overlay" onClick={onClose} />
      <div className="im-dialog" role="dialog" aria-modal="true" aria-label={t('im.编辑消息')}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>{t('im.编辑消息')}</h3>
        <textarea
          ref={textareaRef}
          className="im-input-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          style={{
            width: '100%',
            resize: 'vertical',
            padding: 8,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--input-bg)',
            color: 'var(--text-primary)',
            fontSize: 14,
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn-outline btn-sm" onClick={onClose} disabled={busy}>
            {t('im.取消')}
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => void handleSubmit()}
            disabled={busy || !content.trim() || content.trim() === message.content}
          >
            {busy ? t('im.保存中…') : t('im.保存')}
          </button>
        </div>
      </div>
    </>
  );
}
