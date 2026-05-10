import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NcSelect } from '../common';

export interface McpAiCreateDrawerProps {
  onGenerate: (input: {
    request: string;
    docsText?: string;
    name?: string;
    visibility?: 'private' | 'shared';
  }) => Promise<void>;
  onClose: () => void;
}

export function McpAiCreateDrawer({
  onGenerate,
  onClose,
}: McpAiCreateDrawerProps) {
  const { t } = useTranslation('apps');
  const [name, setName] = useState('');
  const [request, setRequest] = useState('');
  const [docsText, setDocsText] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const handleGenerate = async () => {
    if (!request.trim()) return;
    setSaving(true);
    try {
      await onGenerate({
        request: request.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(docsText.trim() ? { docsText: docsText.trim() } : {}),
        visibility,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app-drawer-overlay" onClick={onClose}>
      <div className="app-drawer app-drawer--wide" onClick={(e) => e.stopPropagation()}>
        <div className="app-drawer__header">
          <h3>{t('mcp.aiTitle')}</h3>
          <button type="button" className="app-drawer__close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="app-drawer__body">
          <div className="form-group">
            <label>{t('mcp.nameOptional')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('mcp.namePlaceholder')}
            />
          </div>
          <div className="form-group">
            <label>{t('mcp.descriptionRequired')}</label>
            <textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={5}
              placeholder={t('mcp.descriptionPlaceholder')}
            />
          </div>
          <div className="form-group">
            <label>{t('mcp.apiDoc')}</label>
            <textarea
              value={docsText}
              onChange={(e) => setDocsText(e.target.value)}
              rows={10}
              placeholder={t('mcp.apiDocPlaceholder')}
            />
          </div>
          <div className="form-group">
            <label>{t('common.visibility')}</label>
            <NcSelect
              value={visibility}
              onChange={(e) =>
                setVisibility(e.target.value as 'private' | 'shared')
              }
            >
              <option value="private">{t('visibility.private')}</option>
              <option value="shared">{t('visibility.shared')}</option>
            </NcSelect>
          </div>
        </div>
        <div className="app-drawer__footer">
          <button type="button" className="btn-outline" onClick={onClose}>
            {t('action.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleGenerate}
            disabled={saving || !request.trim()}
          >
            {saving ? t('mcp.generating') : t('mcp.generateAndInstall')}
          </button>
        </div>
      </div>
    </div>
  );
}
