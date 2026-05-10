import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppSelect, type AppSelectOption } from '../AppSelect';
import { NcCheckbox } from '../common';
import type { Live2DPreferences, Live2DModelInfo } from '../../app-types';

interface Live2DChatConfigProps {
  globalEnabled: boolean;
  preferences: Live2DPreferences | null;
  onPreferencesChange: (patch: Partial<Live2DPreferences>) => void;
  onPreferencesSave: (patch: Partial<Live2DPreferences>) => void;
  onOpenFullSettings: () => void;
}

export function Live2DChatConfig({
  globalEnabled,
  preferences,
  onPreferencesChange,
  onPreferencesSave,
  onOpenFullSettings,
}: Live2DChatConfigProps) {
  const { t } = useTranslation('live2d');
  const [models, setModels] = useState<Live2DModelInfo[]>([]);
  const [localScale, setLocalScale] = useState(preferences?.modelScale ?? 1.0);
  const [localOffsetY, setLocalOffsetY] = useState(preferences?.modelOffsetY ?? 0);

  useEffect(() => {
    setLocalScale(preferences?.modelScale ?? 1.0);
    setLocalOffsetY(preferences?.modelOffsetY ?? 0);
  }, [preferences?.modelScale, preferences?.modelOffsetY]);

  useEffect(() => {
    fetch('/api/live2d/models')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setModels(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  const modelOptions: AppSelectOption[] = [
    { value: '', label: t('config.noModel') },
    ...models.map((m) => ({ value: m.id, label: m.name })),
  ];

  const positionOptions: AppSelectOption[] = [
    { value: 'right', label: t('config.position.right') },
    { value: 'left', label: t('config.position.left') },
  ];

  if (!globalEnabled) {
    return (
      <div className="live2d-chat-config">
        <p className="settings-hint">{t('config.disabled')}</p>
      </div>
    );
  }

  return (
    <div className="live2d-chat-config">
      <div className="live2d-chat-config-field">
        <div className="live2d-chat-config-toggle">
          <NcCheckbox
            checked={preferences?.enabled ?? false}
            onChange={(e) => {
              const v = e.target.checked;
              onPreferencesChange({ enabled: v });
              onPreferencesSave({ enabled: v });
            }}
            label={t('config.enable')}
          />
        </div>
      </div>

      <div className="form-group">
        <label>{t('config.currentModel')}</label>
        <AppSelect
          value={preferences?.selectedModelId || ''}
          options={modelOptions}
          onChange={(v) => {
            const patch = { selectedModelId: v || null };
            onPreferencesChange(patch);
            onPreferencesSave(patch);
          }}
          placeholder={t('config.selectModel')}
        />
      </div>

      <div className="form-group">
        <label>{t('config.position')}</label>
        <AppSelect
          value={preferences?.position || 'right'}
          options={positionOptions}
          onChange={(v) => {
            onPreferencesChange({ position: v });
            onPreferencesSave({ position: v });
          }}
        />
      </div>

      <div className="form-group">
        <label>{t('config.scale', { value: localScale.toFixed(1) })}</label>
        <input
          type="range"
          min={0.5}
          max={3.0}
          step={0.1}
          value={localScale}
          onChange={(e) => {
            const v = parseFloat(e.target.value) || 1.0;
            setLocalScale(v);
            onPreferencesChange({ modelScale: v });
          }}
          onPointerUp={() => onPreferencesSave({ modelScale: localScale })}
          onTouchEnd={() => onPreferencesSave({ modelScale: localScale })}
        />
      </div>

      <div className="form-group">
        <label>{t('config.offsetY', { value: localOffsetY })}</label>
        <input
          type="range"
          min={-200}
          max={200}
          step={5}
          value={localOffsetY}
          onChange={(e) => {
            const v = parseInt(e.target.value) || 0;
            setLocalOffsetY(v);
            onPreferencesChange({ modelOffsetY: v });
          }}
          onPointerUp={() => onPreferencesSave({ modelOffsetY: localOffsetY })}
          onTouchEnd={() => onPreferencesSave({ modelOffsetY: localOffsetY })}
        />
      </div>

      <div className="live2d-chat-config-footer">
        <button className="btn-secondary btn-sm" onClick={onOpenFullSettings}>
          {t('config.fullSettings')}
        </button>
      </div>
    </div>
  );
}
