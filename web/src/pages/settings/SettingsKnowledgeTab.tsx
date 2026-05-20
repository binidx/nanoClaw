import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type SettingsKnowledgeTabProps = {
  knowledgeConfigKeys: string[];
  memoryConfigKeys: string[];
  renderBasicConfigField: (key: string) => ReactNode;
  saveBasicSettings: () => void;
  savingBasicConfig: boolean;
  basicConfigMessage: string;
};

export function SettingsKnowledgeTab(props: SettingsKnowledgeTabProps) {
  const {
    knowledgeConfigKeys,
    memoryConfigKeys,
    renderBasicConfigField,
    saveBasicSettings,
    savingBasicConfig,
    basicConfigMessage,
  } = props;
  const { t } = useTranslation('settings');

  return (
    <div className="settings-tab-stack settings-general-layout">
      <div className="settings-subsection">
        <h3>{t('settings.knowledge.kbLimitsTitle')}</h3>
        <div className="settings-hint">
          {t('settings.knowledge.kbLimitsHint')}
        </div>

        {knowledgeConfigKeys.length > 0 ? (
          knowledgeConfigKeys.map(renderBasicConfigField)
        ) : (
          <div className="settings-hint" style={{ opacity: 0.6 }}>
            {t('settings.knowledge.noKbParams')}
          </div>
        )}
      </div>

      {memoryConfigKeys.length > 0 && (
        <div className="settings-subsection">
          <h3>{t('settings.knowledge.memoryPolicyTitle')}</h3>
          <div className="settings-hint">
            {t('settings.knowledge.memoryPolicyHint')}
          </div>
          {memoryConfigKeys.map(renderBasicConfigField)}
        </div>
      )}

      <div className="settings-save-row">
        <button
          className="btn-primary"
          onClick={saveBasicSettings}
          disabled={savingBasicConfig}
        >
          {savingBasicConfig ? t('settings.knowledge.saving') : t('settings.knowledge.saveConfig')}
        </button>
        {basicConfigMessage && (
          <span className="settings-save-message">{basicConfigMessage}</span>
        )}
      </div>
    </div>
  );
}
