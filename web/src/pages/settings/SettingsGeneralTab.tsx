
import type { RefObject, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigEffect } from '../../app-types';

export type SettingsGeneralTabProps = {
  defaultAccessPolicyRef: RefObject<HTMLDivElement | null>;
  defaultDirectoryTemplateCount: number;
  configMeta: Record<string, import('../../app-types').ConfigKeyMetadata>;
  formatConfigEffectLabel: (effect: ConfigEffect) => string;
  selectedDefaultAccessPolicy: { label: string; description: string; value: string };
  defaultAccessModeValue: string;
  defaultAllowedDirectories: string[];
  defaultDirectoryDraft: string;
  setDefaultDirectoryDraft: (value: string) => void;
  defaultDirectoryError: string;
  addDefaultDirectory: (candidate?: string) => void;
  removeDefaultDirectory: (index: number) => void;
  chooseDefaultDirectory: () => Promise<void>;
  pickingDefaultDirectory: boolean;
  updateConfigValue: (key: string, value: string | boolean) => void;
  primaryConfigKeys: string[];
  saveBasicSettings: () => void;
  savingBasicConfig: boolean;
  basicConfigMessage: string;
  assistantNameValue: string;
  webPortValue: string;
  renderBasicConfigField: (key: string) => ReactNode;
  DEFAULT_ACCESS_POLICY_OPTIONS: readonly {
    value: string;
    label: string;
    description: string;
  }[];
};

export function SettingsGeneralTab(props: SettingsGeneralTabProps) {
  const {
    defaultAccessPolicyRef,
    defaultDirectoryTemplateCount,
    configMeta,
    formatConfigEffectLabel,
    selectedDefaultAccessPolicy,
    defaultAccessModeValue,
    defaultAllowedDirectories,
    defaultDirectoryDraft,
    setDefaultDirectoryDraft,
    defaultDirectoryError,
    addDefaultDirectory,
    removeDefaultDirectory,
    chooseDefaultDirectory,
    pickingDefaultDirectory,
    updateConfigValue,
    primaryConfigKeys,
    saveBasicSettings,
    savingBasicConfig,
    basicConfigMessage,
    assistantNameValue,
    webPortValue,
    renderBasicConfigField,
    DEFAULT_ACCESS_POLICY_OPTIONS,
  } = props;

  const { t } = useTranslation('settings');

  return (
    <div className="settings-tab-stack settings-general-layout">
      <section className="settings-subsection settings-general-panel">
        <h3>{t('settings.general.b6453a')}</h3>
        <p className="settings-hint">
          {t('settings.general.91b4ac')}
          {t('settings.general.8396fe')}
        </p>
        <div
          ref={defaultAccessPolicyRef}
          className="settings-access-policy-block"
        >
          <h3>{t('settings.general.3fb4ed')}</h3>
          <p className="settings-hint">
            {t('settings.general.4794ee')}
          </p>
          {configMeta.DEFAULT_ACCESS_MODE ? (
            <div className="settings-hint">
              {formatConfigEffectLabel(configMeta.DEFAULT_ACCESS_MODE.effect)} ·{' '}
              {configMeta.DEFAULT_ACCESS_MODE.summary}
            </div>
          ) : null}
          <div className="settings-summary-grid">
            <div className="settings-summary-card">
              <span className="settings-summary-label">{t('settings.general.c366d1')}</span>
              <strong>{selectedDefaultAccessPolicy.label}</strong>
              <p>{selectedDefaultAccessPolicy.description}</p>
            </div>
            <div className="settings-summary-card">
              <span className="settings-summary-label">{t('settings.general.a9f1ce')}</span>
              <strong>{defaultDirectoryTemplateCount}</strong>
              <p>
                {defaultDirectoryTemplateCount > 0
                  ? t('settings.general.这些目录会作为_allowlist/readonly_会话的默认附加目录')
                  : t('settings.general.当前没有附加模板目录_只保留主项目目录')}
              </p>
            </div>
            <div className="settings-summary-card">
              <span className="settings-summary-label">{t('settings.general.47c96d')}</span>
              <strong>{t('settings.general.27df93')}</strong>
              <p>{t('settings.general.725bbc')}</p>
            </div>
          </div>
          <div className="assistant-section-label">{t('settings.general.3c7f78')}</div>
          <div className="assistant-choice-grid access-policy-mode-grid">
            {DEFAULT_ACCESS_POLICY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`assistant-choice-card ${
                  defaultAccessModeValue === option.value ? 'active' : ''
                }`}
                onClick={() =>
                  updateConfigValue('DEFAULT_ACCESS_MODE', option.value)
                }
              >
                <strong>{option.label}</strong>
                <span>{option.description}</span>
              </button>
            ))}
          </div>
          <div className="assistant-choice-help">
            {t('settings.general.currentSelection', { desc: selectedDefaultAccessPolicy.description })}
          </div>
          <div className="assistant-section-label">{t('settings.general.023b3e')}</div>
          <div className="settings-summary-grid">
            <div className="settings-summary-card">
              <span className="settings-summary-label">{t('settings.general.8b8597')}</span>
              <strong>{t('settings.general.7a8c95')}</strong>
              <p>{t('settings.general.b9bb4e')}</p>
            </div>
            <div className="settings-summary-card">
              <span className="settings-summary-label">{t('settings.general.7042e0')}</span>
              <strong>{t('settings.general.000392')}</strong>
              <p>{t('settings.general.6510c7')}</p>
            </div>
            <div className="settings-summary-card">
              <span className="settings-summary-label">{t('settings.general.83f9f2')}</span>
              <strong>{t('settings.general.1cd55a')}</strong>
              <p>{t('settings.general.9ff759')}</p>
            </div>
          </div>
          <div className="assistant-section-label">{t('settings.general.36c2c8')}</div>
          {configMeta.allowed_directories ? (
            <div className="settings-hint">
              {formatConfigEffectLabel(configMeta.allowed_directories.effect)} ·{' '}
              {configMeta.allowed_directories.summary}
            </div>
          ) : null}
          <div className="dir-list">
            {defaultAllowedDirectories.map((directory, index) => (
              <div key={`${directory}-${index}`} className="dir-item">
                <span className="dir-path">{directory}</span>
                <button
                  type="button"
                  className="btn-danger btn-sm"
                  onClick={() => removeDefaultDirectory(index)}
                >
                  {t('settings.general.86048b')}
                </button>
              </div>
            ))}
            {defaultAllowedDirectories.length === 0 ? (
              <div className="dir-empty">
                {t('settings.general.50edd5')}
              </div>
            ) : null}
          </div>
          <div className="dir-add">
            <input
              type="text"
              placeholder="/path/to/shared-knowledge"
              value={defaultDirectoryDraft}
              onChange={(event) =>
                setDefaultDirectoryDraft(event.target.value)
              }
            />
            <button type="button" onClick={() => addDefaultDirectory()}>
              {t('settings.general.66ab5e')}
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => void chooseDefaultDirectory()}
              disabled={pickingDefaultDirectory}
            >
              {pickingDefaultDirectory ? t('settings.general.选择中') : t('settings.general.选择目录')}
            </button>
          </div>
          <div className="assistant-choice-help">
            {t('settings.general.852370')}
          </div>
          {defaultDirectoryError ? (
            <div className="test-result error">{defaultDirectoryError}</div>
          ) : null}
        </div>

        {primaryConfigKeys.map(renderBasicConfigField)}

        <div className="settings-save-row">
          <button
            className="btn-primary"
            onClick={saveBasicSettings}
            disabled={
              savingBasicConfig ||
              !assistantNameValue.trim() ||
              !webPortValue.trim()
            }
          >
            {savingBasicConfig ? t('settings.general.saving') : t('settings.general.saveChanges')}
          </button>
        </div>

        {basicConfigMessage && (
          <div className="test-result success">
            {basicConfigMessage}
          </div>
        )}
      </section>
    </div>

  );
}
