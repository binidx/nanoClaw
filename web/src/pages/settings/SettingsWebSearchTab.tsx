import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type SettingsWebSearchTabProps = {
  webSearchConfigKeys: string[];
  renderBasicConfigField: (key: string) => ReactNode;
  saveBasicSettings: () => void;
  savingBasicConfig: boolean;
  basicConfigMessage: string;
};

export function SettingsWebSearchTab(props: SettingsWebSearchTabProps) {
  const { t } = useTranslation('settings');
  const {
    webSearchConfigKeys,
    renderBasicConfigField,
    saveBasicSettings,
    savingBasicConfig,
    basicConfigMessage,
  } = props;

  return (
    <div className="settings-general-layout">
      <div className="settings-section">
        <div className="settings-subsection">
          <h3>{t('settings.webSearch.title')}</h3>
          <div className="settings-hint">
            {t('settings.webSearch.description')}
          </div>

          {webSearchConfigKeys.length > 0 ? (
            webSearchConfigKeys.map(renderBasicConfigField)
          ) : (
            <div className="settings-hint" style={{ opacity: 0.6 }}>
              {t('settings.webSearch.noConfigParams')}
            </div>
          )}
        </div>

        <div className="settings-save-row">
          <button
            className="btn-primary"
            onClick={saveBasicSettings}
            disabled={savingBasicConfig}
          >
            {savingBasicConfig ? t('settings.webSearch.saving') : t('settings.webSearch.saveConfig')}
          </button>
          {basicConfigMessage && (
            <span className="settings-save-message">{basicConfigMessage}</span>
          )}
        </div>
      </div>
    </div>
  );
}
