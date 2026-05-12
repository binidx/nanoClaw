import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Drawer, NcSelect } from '../common';

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
    <Drawer
      open
      onClose={onClose}
      title={t('mcp.aiTitle')}
      width={560}
      footer={
        <>
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
        </>
      }
    >
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
    </Drawer>
  );
}
