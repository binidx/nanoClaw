import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ExtensionMetadata, UserSkillView } from '../../app-types';
import { Drawer, NcSelect } from '../common';

export interface SkillCreateDrawerProps {
  editing: UserSkillView | null;
  onSave: (input: {
    name: string;
    description?: string;
    skillContent?: string;
    visibility?: 'private' | 'shared';
    metadata?: ExtensionMetadata;
  }) => Promise<void>;
  onClose: () => void;
}

function parseMetadataText(text: string): ExtensionMetadata | undefined {
  if (!text.trim()) return undefined;
  return JSON.parse(text) as ExtensionMetadata;
}

function metadataToText(metadata: ExtensionMetadata | undefined): string {
  if (!metadata) return '';
  return JSON.stringify(metadata, null, 2);
}

export function SkillCreateDrawer({ editing, onSave, onClose }: SkillCreateDrawerProps) {
  const { t } = useTranslation('apps');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [skillContent, setSkillContent] = useState(editing?.skillContent ?? '');
  const [metadataText, setMetadataText] = useState(
    metadataToText(editing?.metadata),
  );
  const [metadataError, setMetadataError] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>(editing?.visibility ?? 'private');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    let metadata: ExtensionMetadata | undefined;
    try {
      metadata = parseMetadataText(metadataText);
      setMetadataError('');
    } catch {
      setMetadataError(t('skill.invalidJson'));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        skillContent: skillContent.trim() || undefined,
        visibility,
        metadata,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={editing ? t('skill.edit') : t('skill.create')}
      width={560}
      footer={
        <>
          <button type="button" className="btn-outline" onClick={onClose}>
            {t('action.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || !name.trim()}
          >
            {saving ? t('mcp.saving') : (editing ? t('mcp.saveChanges') : t('mcp.save'))}
          </button>
        </>
      }
    >
          <div className="form-group">
            <label>{t('skill.nameRequired')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-custom-skill" />
          </div>
          <div className="form-group">
            <label>{t('skill.description')}</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="form-group">
            <label>{t('skill.content')}</label>
            <textarea
              className="skill-editor"
              value={skillContent}
              onChange={(e) => setSkillContent(e.target.value)}
              rows={15}
              placeholder="# My Skill&#10;&#10;Instructions for the AI..."
            />
          </div>
          <div className="form-group">
            <label>Metadata JSON</label>
            <textarea
              value={metadataText}
              onChange={(e) => {
                setMetadataText(e.target.value);
                if (metadataError) setMetadataError('');
              }}
              rows={8}
              placeholder={'{\n  "capabilities": ["image.generate"],\n  "requirements": {\n    "commands": [{ "command": "python" }]\n  }\n}'}
            />
            {metadataError ? (
              <div className="form-help form-help--blocked">{metadataError}</div>
            ) : null}
            {editing?.healthStatus ? (
              <div className={`form-help form-help--${editing.healthStatus.state}`}>
                {t('skill.currentStatus', { status: editing.healthStatus.summary })}
              </div>
            ) : null}
          </div>
          <div className="form-group">
            <label>{t('common.visibility')}</label>
            <NcSelect value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'shared')}>
              <option value="private">{t('visibility.private')}</option>
              <option value="shared">{t('visibility.shared')}</option>
            </NcSelect>
          </div>
    </Drawer>
  );
}
