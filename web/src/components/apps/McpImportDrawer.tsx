import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Drawer, NcSelect } from '../common';

export interface McpImportDrawerProps {
  onImport: (input: {
    sourcePath: string;
    name?: string;
    entryFile?: string;
    visibility?: 'private' | 'shared';
  }) => Promise<void>;
  onClose: () => void;
}

export function McpImportDrawer({
  onImport,
  onClose,
}: McpImportDrawerProps) {
  const { t } = useTranslation('apps');
  const [sourcePath, setSourcePath] = useState('');
  const [name, setName] = useState('');
  const [entryFile, setEntryFile] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [saving, setSaving] = useState(false);

  const handleImport = async () => {
    if (!sourcePath.trim()) return;
    setSaving(true);
    try {
      await onImport({
        sourcePath: sourcePath.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(entryFile.trim() ? { entryFile: entryFile.trim() } : {}),
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
      title={t('mcp.importTitle')}
      width={420}
      footer={
        <>
          <button type="button" className="btn-outline" onClick={onClose}>
            {t('action.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleImport}
            disabled={saving || !sourcePath.trim()}
          >
            {saving ? t('mcp.importing') : t('mcp.importBtn')}
          </button>
        </>
      }
    >
          <div className="form-group">
            <label>{t('mcp.localPath')}</label>
            <input
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder={t('mcp.localPathPlaceholder')}
            />
            <div className="form-help">
              {t('mcp.localPathHint')}
            </div>
          </div>
          <div className="form-group">
            <label>{t('mcp.nameOptional')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('common.defaultModel')}
            />
          </div>
          <div className="form-group">
            <label>{t('mcp.entryFile')}</label>
            <input
              value={entryFile}
              onChange={(e) => setEntryFile(e.target.value)}
              placeholder={t('mcp.entryFilePlaceholder')}
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
