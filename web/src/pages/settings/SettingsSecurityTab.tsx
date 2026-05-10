
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { BasicConfigState } from '../../app-types';
import { AppSelect } from '../../components/AppSelect';
import { renderBooleanField } from './settings-field-renderers';
import { formatBashApprovalPrefix, formatIsoTimestamp } from './settings-helpers';

export type SettingsSecurityTabProps = {
  senderTrustMode: 'trigger' | 'drop';
  setSenderTrustMode: (mode: 'trigger' | 'drop') => void;
  senderTrustAllowAll: boolean;
  setSenderTrustAllowAll: (value: boolean) => void;
  senderTrustAllowText: string;
  setSenderTrustAllowText: (value: string) => void;
  senderTrustLogDenied: boolean;
  setSenderTrustLogDenied: (value: boolean) => void;
  senderTrustOverridesText: string;
  setSenderTrustOverridesText: (value: string) => void;
  senderTrustOverridesError: string;
  setSenderTrustOverridesError: (value: string) => void;
  savingSenderTrust: boolean;
  senderTrustMessage: string;
  saveSenderTrust: () => Promise<void>;
  isSenderTrustMessageError: boolean;
  authConfigKeys: string[];
  renderBasicConfigField: (key: string) => ReactNode;
  bashApprovalCommandDraft: string;
  setBashApprovalCommandDraft: (value: string) => void;
  bashApprovalAllowlistState: { rules: import('../../app-types').BashApprovalAllowRule[]; error: string | null };
  bashApprovalAllowlistMessage: string;
  setBashApprovalAllowlistMessage: (message: string) => void;
  addBashApprovalAllowRule: () => void;
  updateBashApprovalAllowlist: (rules: import('../../app-types').BashApprovalAllowRule[]) => void;
  toggleBashApprovalAllowRule: (ruleId: string) => void;
  deleteBashApprovalAllowRule: (ruleId: string) => void;
  saveBasicSettings: () => void;
  savingBasicConfig: boolean;
  basicConfigMessage: string;
  webLoginEnabled: boolean;
  basicConfig: BasicConfigState;
  getStringValue: (config: BasicConfigState, key: string) => string;
};

export function SettingsSecurityTab(props: SettingsSecurityTabProps) {
  const { t } = useTranslation('settings');
  const {
    senderTrustMode,
    setSenderTrustMode,
    senderTrustAllowAll,
    setSenderTrustAllowAll,
    senderTrustAllowText,
    setSenderTrustAllowText,
    senderTrustLogDenied,
    setSenderTrustLogDenied,
    senderTrustOverridesText,
    setSenderTrustOverridesText,
    senderTrustOverridesError,
    setSenderTrustOverridesError,
    savingSenderTrust,
    senderTrustMessage,
    saveSenderTrust,
    isSenderTrustMessageError,
    authConfigKeys,
    renderBasicConfigField,
    bashApprovalCommandDraft,
    setBashApprovalCommandDraft,
    bashApprovalAllowlistState,
    bashApprovalAllowlistMessage,
    setBashApprovalAllowlistMessage,
    addBashApprovalAllowRule,
    updateBashApprovalAllowlist,
    toggleBashApprovalAllowRule,
    deleteBashApprovalAllowRule,
    saveBasicSettings,
    savingBasicConfig,
    basicConfigMessage,
    webLoginEnabled,
    basicConfig,
    getStringValue,
  } = props;

  const loginCredentialsInvalid =
    webLoginEnabled &&
    !getStringValue(basicConfig, 'WEB_LOGIN_USERNAME').trim();

  return (
  <>
  <div className="settings-section">
    <div className="settings-subsection">
      <div className="section-header">
        <h3>{t('settings.security.a99839')}</h3>
      </div>
      <p className="settings-hint">
        {t('settings.security.f55e0c')}{t('settings.security.e7f8c6')}
      </p>

      <div className="tasks-form-grid">
        <div className="form-group">
          <label>{t('settings.security.68c082')}</label>
          <AppSelect
            value={senderTrustMode}
            onChange={(nextValue) =>
              setSenderTrustMode(nextValue as 'trigger' | 'drop')
            }
            ariaLabel={t('settings.security.68c082')}
            options={[
              { value: 'trigger', label: t('settings.security.3b410e') },
              { value: 'drop', label: t('settings.security.c208ab') },
            ]}
          />
        </div>
        <div className="form-group">
          <label>{t('settings.security.9a8ff3')}</label>
          <input
            value={senderTrustAllowText}
            onChange={(event) =>
              setSenderTrustAllowText(event.target.value)
            }
            placeholder={
              senderTrustAllowAll
                ? t('settings.security.6e7226')
                : 'sender_a, sender_b'
            }
            disabled={senderTrustAllowAll}
          />
        </div>
      </div>

      {renderBooleanField(
        'senderTrust:allowAll',
        t('settings.security.b0549c'),
        t('settings.security.037217'),
        senderTrustAllowAll,
        setSenderTrustAllowAll,
      )}
      {renderBooleanField(
        'senderTrust:logDenied',
        t('settings.security.c74dc6'),
        t('settings.security.10e879'),
        senderTrustLogDenied,
        setSenderTrustLogDenied,
      )}

      <div className="form-group">
        <label>{t('settings.security.511956')}</label>
        <textarea
          rows={8}
          value={senderTrustOverridesText}
          onChange={(event) => {
            setSenderTrustOverridesText(event.target.value);
            if (senderTrustOverridesError) {
              setSenderTrustOverridesError('');
            }
          }}
          placeholder='{"telegram:default:12345":{"allow":["alice"],"mode":"trigger"}}'
        />
        {senderTrustOverridesError ? (
          <div className="test-result error">
            {senderTrustOverridesError}
          </div>
        ) : null}
      </div>

      <div className="modal-actions">
        <button
          className="btn-primary"
          onClick={() => void saveSenderTrust()}
          disabled={savingSenderTrust}
        >
          {savingSenderTrust ? t('settings.subagent.保存中') : t('settings.subagent.保存修改')}
        </button>
      </div>
      {senderTrustMessage ? (
        <div
          className={`test-result ${isSenderTrustMessageError ? 'error' : 'success'}`}
        >
          {senderTrustMessage}
        </div>
      ) : null}
    </div>
  </div>

  {authConfigKeys.length > 0 && (
    <div className="settings-section">
      <div className="settings-subsection">
        <h3>{t('settings.security.c66643')}</h3>
        <div className="settings-hint">
          {t('settings.security.80224a')}{t('settings.security.2424a3')}
        </div>
        {authConfigKeys.map(renderBasicConfigField)}
        <div className="settings-save-row">
          <button
            className="btn-primary"
            onClick={saveBasicSettings}
            disabled={savingBasicConfig || loginCredentialsInvalid}
          >
            {savingBasicConfig ? t('settings.subagent.保存中') : t('settings.security.保存配置')}
          </button>
          {loginCredentialsInvalid && (
            <span className="test-result error">
              {t('settings.security.0563b1')}
            </span>
          )}
          {basicConfigMessage && (
            <span className="settings-save-message">{basicConfigMessage}</span>
          )}
        </div>
      </div>
    </div>
  )}

  <div className="settings-section">
    <div className="settings-subsection">
      <h3>{t('settings.security.e913e2')}</h3>
      <div className="settings-hint">
        {t('settings.security.305250')}{t('settings.security.4583c3')}
      </div>
      <div className="form-group">
        <label>{t('settings.security.6622c3')}</label>
        <input
          type="text"
          value={bashApprovalCommandDraft}
          onChange={(event) => {
            setBashApprovalCommandDraft(event.target.value);
            setBashApprovalAllowlistMessage('');
          }}
          placeholder="git push origin main"
          disabled={!!bashApprovalAllowlistState.error}
        />
      </div>
      <div className="modal-actions">
        <button
          type="button"
          className="btn-outline btn-sm"
          onClick={addBashApprovalAllowRule}
          disabled={
            !bashApprovalCommandDraft.trim() ||
            !!bashApprovalAllowlistState.error
          }
        >
          {t('settings.security.ba3c80')}
        </button>
        <button
          type="button"
          className="btn-outline btn-sm"
          onClick={() => {
            updateBashApprovalAllowlist([]);
            setBashApprovalAllowlistMessage(
              t('settings.security.42625b'),
            );
          }}
          disabled={
            bashApprovalAllowlistState.rules.length === 0 &&
            !bashApprovalAllowlistState.error
          }
        >
          {t('settings.security.288f0c')}
        </button>
      </div>
      {bashApprovalAllowlistState.error ? (
        <div className="test-result error">
          {bashApprovalAllowlistState.error}
        </div>
      ) : null}
      {bashApprovalAllowlistMessage ? (
        <div className="test-result success">
          {bashApprovalAllowlistMessage}
        </div>
      ) : null}
      {bashApprovalAllowlistState.rules.length > 0 ? (
        <div className="provider-cards">
          {bashApprovalAllowlistState.rules.map((rule) => (
            <div key={rule.id} className="provider-card">
              <div className="provider-card-header">
                <span className="provider-alias">
                  {rule.label ||
                    formatBashApprovalPrefix(rule.prefix)}
                </span>
                <span
                  className={`default-tag${rule.enabled ? '' : ' muted'}`}
                >
                  {rule.enabled ? t('settings.subagent.已启用') : t('settings.security.已停用')}
                </span>
              </div>
              <div className="provider-card-body">
                <div className="provider-field">
                  <span className="field-label">{t('settings.security.e572da')}</span>{' '}
                  <span className="field-value mono">
                    {formatBashApprovalPrefix(rule.prefix)}
                  </span>
                </div>
                <div className="provider-field">
                  <span className="field-label">{t('settings.extensions.26ca20')}</span>{' '}
                  <span className="field-value">
                    {rule.createdFrom === 'approval'
                      ? t('settings.security.aecd17')
                      : t('settings.security.079643')}
                  </span>
                </div>
                <div className="provider-field">
                  <span className="field-label">{t('settings.security.eca37c')}</span>{' '}
                  <span className="field-value">
                    {formatIsoTimestamp(rule.createdAt)}
                  </span>
                </div>
              </div>
              <div className="provider-card-actions">
                <button
                  type="button"
                  className="btn-outline btn-sm"
                  onClick={() =>
                    toggleBashApprovalAllowRule(rule.id)
                  }
                >
                  {rule.enabled ? t('settings.security.auto_5c56a8') : t('settings.security.auto_7854b5')}
                </button>
                <button
                  type="button"
                  className="btn-danger btn-sm"
                  onClick={() =>
                    deleteBashApprovalAllowRule(rule.id)
                  }
                >
                  {t('settings.extensions.2f4aad')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="provider-empty">
          {t('settings.security.bef46f')}
        </div>
      )}

      <div className="settings-save-row">
        <button
          className="btn-primary"
          onClick={saveBasicSettings}
          disabled={savingBasicConfig || loginCredentialsInvalid}
        >
          {savingBasicConfig ? t('settings.subagent.保存中') : t('settings.security.保存配置')}
        </button>
        {loginCredentialsInvalid && (
          <span className="test-result error">
            {t('settings.security.c1fcc1')}
          </span>
        )}
        {basicConfigMessage && (
          <span className="settings-save-message">{basicConfigMessage}</span>
        )}
      </div>
    </div>
  </div>
  </>
  );
}
