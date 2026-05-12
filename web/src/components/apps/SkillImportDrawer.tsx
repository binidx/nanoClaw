import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Drawer, NcSelect } from '../common';

export interface SkillImportDrawerProps {
  onImport: (input: {
    sourcePath: string;
    name?: string;
    visibility?: 'private' | 'shared';
  }) => Promise<void>;
  onClose: () => void;
}

export function SkillImportDrawer({
  onImport,
  onClose,
}: SkillImportDrawerProps) {
  const { t } = useTranslation('apps');
  const [sourcePath, setSourcePath] = useState('');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [saving, setSaving] = useState(false);

  const handleImport = async () => {
    if (!sourcePath.trim()) return;
    setSaving(true);
    try {
      await onImport({
        sourcePath: sourcePath.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
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
      title={t('skill.importTitle')}
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
            {saving ? t('skill.importing') : t('mcp.importBtn')}
          </button>
        </>
      }
    >
          <div className="form-group">
            <label>{t('skill.localPath')}</label>
            <input
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder={t('skill.localPathPlaceholder')}
            />
            <div className="form-help">
              {t('skill.localPathHint')}
            </div>
          </div>
          <div className="form-group">
            <label>{t('skill.nameOptional')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('skill.namePlaceholder')}
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
