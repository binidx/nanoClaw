
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserControlPanel } from '../../components/BrowserControlPanel';

export type SettingsBrowserTabProps = {
  apiBase: string;
  browserControlConfigKeys: string[];
  renderBasicConfigField: (key: string) => ReactNode;
  saveBasicSettings: () => void;
  savingBasicConfig: boolean;
  basicConfigMessage: string;
};

export function SettingsBrowserTab(props: SettingsBrowserTabProps) {
  const { t } = useTranslation('settings');
  const {
    apiBase,
    browserControlConfigKeys,
    renderBasicConfigField,
    saveBasicSettings,
    savingBasicConfig,
    basicConfigMessage,
  } = props;

  return (
  <>
    <BrowserControlPanel apiBase={apiBase} />

    {browserControlConfigKeys.length > 0 && (
      <div className="settings-section">
        <div className="settings-subsection">
          <h3>{t('settings.browser.controlConfig')}</h3>
          <div className="settings-hint">
            {t('settings.browser.managedBrowserHint')}
            {t('settings.browser.connectModeHint')}
          </div>
          {browserControlConfigKeys.map(renderBasicConfigField)}

          <div className="settings-save-row">
            <button
              className="btn-primary"
              onClick={saveBasicSettings}
              disabled={savingBasicConfig}
            >
              {savingBasicConfig ? t('settings.browser.saving') : t('settings.browser.saveConfig')}
            </button>
            {basicConfigMessage && (
              <span className="settings-save-message">{basicConfigMessage}</span>
            )}
          </div>
        </div>
      </div>
    )}
  </>
  );
}
