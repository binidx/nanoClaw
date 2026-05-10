import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconSend } from '../../../components/AppIcons';
import type { ImAttachment } from '../im-api';
import { uploadImFile } from '../im-api';
import { encryptAttachmentFile, type PlainAttachmentMeta } from '../im-e2ee';

interface PendingFile {
  file: File;
  preview: string | null;
  status: 'uploading' | 'done' | 'error';
  attachment?: ImAttachment;
  encryptedMeta?: PlainAttachmentMeta;
  error?: string;
}

export interface ImInputBarProps {
  disabled: boolean;
  chatJid: string | null;
  currentUserId: string;
  e2eeEnabled?: boolean;
  roomKeyAvailable?: boolean;
  e2eePlaceholder?: string;
  onSend: (
    text: string,
    attachmentIds: string[],
    encryptedAttachments?: PlainAttachmentMeta[],
  ) => void | Promise<void>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function IconAttach() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function ImInputBar({
  disabled,
  chatJid,
  currentUserId,
  e2eeEnabled,
  roomKeyAvailable = true,
  e2eePlaceholder,
  onSend,
}: ImInputBarProps) {
  const { t } = useTranslation('im');
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!chatJid || (e2eeEnabled && !roomKeyAvailable)) return;
      const entries: PendingFile[] = files.map((f) => ({
        file: f,
        preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
        status: 'uploading' as const,
      }));
      setPendingFiles((prev) => [...prev, ...entries]);

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        try {
          const encrypted = e2eeEnabled
            ? await encryptAttachmentFile(chatJid, currentUserId, entry.file)
            : null;
          const att = await uploadImFile(
            chatJid,
            encrypted?.file || entry.file,
            encrypted
              ? {
                  fileName: 'encrypted.bin',
                  mimeType: 'application/octet-stream',
                }
              : undefined,
          );
          setPendingFiles((prev) =>
            prev.map((p) =>
              p.file === entry.file
                ? {
                    ...p,
                    status: 'done',
                    attachment: att,
                    encryptedMeta: encrypted
                      ? { ...encrypted.meta, id: att.id }
                      : undefined,
                  }
                : p,
            ),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Upload failed';
          setPendingFiles((prev) =>
            prev.map((p) =>
              p.file === entry.file ? { ...p, status: 'error', error: msg } : p,
            ),
          );
        }
      }
    },
    [chatJid, currentUserId, e2eeEnabled, roomKeyAvailable],
  );

  const removeFile = useCallback((file: File) => {
    setPendingFiles((prev) => {
      const item = prev.find((p) => p.file === file);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return prev.filter((p) => p.file !== file);
    });
  }, []);

  const submit = useCallback(async () => {
    const text = value.trim();
    const readyAttachments = pendingFiles
      .filter((p) => p.status === 'done' && p.attachment)
      .map((p) => p.attachment!.id);
    const encryptedAttachments = pendingFiles
      .filter((p) => p.status === 'done' && p.encryptedMeta)
      .map((p) => p.encryptedMeta!);
    const hasUploading = pendingFiles.some((p) => p.status === 'uploading');

    if (hasUploading) return;
    if (!text && readyAttachments.length === 0) return;
    if (disabled || sending) return;

    setSending(true);
    try {
      await onSend(text, readyAttachments, encryptedAttachments);
      setValue('');
      for (const p of pendingFiles) {
        if (p.preview) URL.revokeObjectURL(p.preview);
      }
      setPendingFiles([]);
    } finally {
      setSending(false);
    }
  }, [disabled, onSend, pendingFiles, sending, value]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files: File[] = [];
      if (e.dataTransfer.files) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          files.push(e.dataTransfer.files[i]!);
        }
      }
      if (files.length > 0) void addFiles(files);
    },
    [addFiles],
  );

  useEffect(() => {
    return () => {
      for (const p of pendingFiles) {
        if (p.preview) URL.revokeObjectURL(p.preview);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasUploading = pendingFiles.some((p) => p.status === 'uploading');
  const hasReady = pendingFiles.some((p) => p.status === 'done');
  const blockedByMissingKey = Boolean(e2eeEnabled && !roomKeyAvailable);
  const canSend =
    !disabled &&
    !blockedByMissingKey &&
    !sending &&
    !hasUploading &&
    (!!value.trim() || hasReady);

  return (
    <div
      className="input-bar"
      style={dragOver ? { background: 'var(--surface-accent)' } : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {pendingFiles.length > 0 && (
        <div className="pending-upload-list">
          {pendingFiles.map((p, idx) => (
            <div key={idx} className="pending-upload-item">
              {p.preview ? (
                <img
                  src={p.preview}
                  alt=""
                  style={{
                    width: 32,
                    height: 32,
                    objectFit: 'cover',
                    borderRadius: 4,
                    flexShrink: 0,
                  }}
                />
              ) : null}
              <div className="pending-upload-meta">
                <span className="pending-upload-name" title={p.file.name}>
                  {p.file.name.slice(0, 24)}
                  {p.file.name.length > 24 ? '…' : ''}
                </span>
                <span className="pending-upload-size">
                  {formatSize(p.file.size)}
                  {p.status === 'uploading' ? t('im. · 上传中…') : ''}
                  {p.status === 'error' ? ` · ${p.error}` : ''}
                </span>
              </div>
              <button
                className="pending-upload-remove"
                onClick={() => removeFile(p.file)}
                title={t('im.移除')}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="input-wrap">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
              void addFiles(Array.from(files));
              e.target.value = '';
            }
          }}
        />
        <button
          className="upload-btn"
          disabled={disabled || blockedByMissingKey || !chatJid}
          onClick={() => fileInputRef.current?.click()}
          title={t('im.附件')}
          aria-label={t('im.附件')}
        >
          <IconAttach />
        </button>
        <textarea
          disabled={disabled || sending || blockedByMissingKey}
          placeholder={
            disabled
              ? t('im.请选择会话')
              : e2eePlaceholder ||
                (e2eeEnabled
                  ? t('im.输入端到端加密消息')
                  : t('im.输入消息，Enter 发送，可粘贴或拖拽文件'))
          }
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="send-btn"
          disabled={!canSend}
          onClick={() => void submit()}
          title={t('im.发送')}
          aria-label={t('im.发送')}
        >
          <IconSend />
        </button>
      </div>
      {blockedByMissingKey ? (
        <div className="im-input-security-hint">
          {t('im.此设备缺少房间密钥，收到密钥后会自动重试解密。')}
        </div>
      ) : null}
    </div>
  );
}
