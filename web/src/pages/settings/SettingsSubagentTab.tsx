
import { useTranslation } from 'react-i18next';
import { NcSelect } from '../../components/common';
import { SubagentRuntimeExplorer } from '../../components/SubagentRuntimeExplorer';
import { getSubagentMaxActiveOptions } from './settings-constants';

export type SettingsSubagentTabProps = {
  subagentEnabled: boolean;
  setSubagentEnabled: (value: boolean) => void;
  subagentMaxDepth: number;
  setSubagentMaxDepth: (value: number) => void;
  subagentMaxActive: number;
  setSubagentMaxActive: (value: number) => void;
  subagentSaving: boolean;
  subagentMessage: string;
  subagentMessageTone: 'success' | 'error';
  subagentDepthSummary: string;
  subagentMaxActiveSummary: string;
  subagentActiveCapacityLabel: string;
  subagentRuntime: import('../../app-types').SubagentRuntimeSnapshot | null;
  subagentRuntimeItems: import('../../app-types').SubagentRuntimeEntry[];
  subagentRuntimeActionKey: string;
  stopSubagentRuntime: (id: string) => Promise<boolean>;
  sendSubagentRuntimeMessage: (id: string, prompt: string) => Promise<boolean>;
  steerSubagentRuntime: (id: string, prompt: string) => Promise<boolean>;
  saveSubagentConfig: () => Promise<void>;
};

export function SettingsSubagentTab(props: SettingsSubagentTabProps) {
  const {
    subagentEnabled,
    setSubagentEnabled,
    subagentMaxDepth,
    setSubagentMaxDepth,
    subagentMaxActive,
    setSubagentMaxActive,
    subagentSaving,
    subagentMessage,
    subagentMessageTone,
    subagentDepthSummary,
    subagentMaxActiveSummary,
    subagentActiveCapacityLabel,
    subagentRuntime,
    subagentRuntimeItems,
    subagentRuntimeActionKey,
    stopSubagentRuntime,
    sendSubagentRuntimeMessage,
    steerSubagentRuntime,
    saveSubagentConfig,
  } = props;

  const { t } = useTranslation('settings');
  const subagentMaxActiveOptions = getSubagentMaxActiveOptions(t);

  return (
  <div className="settings-tab-stack">
    <div className="settings-subsection">
      <h3>{t('settings.subagent.title')}</h3>
      <div className="settings-hint">
        {t('settings.subagent.description')}
      </div>
      <div className="subagent-settings-overview">
        <article className={`subagent-settings-overview-card ${subagentEnabled ? 'is-enabled' : 'is-disabled'}`}>
          <span className="subagent-settings-overview-label">{t('settings.subagent.currentStrategy')}</span>
          <strong>{subagentEnabled ? t('settings.subagent.已启用子代理') : t('settings.subagent.子代理已关闭')}</strong>
          <p>{subagentEnabled ? t('settings.subagent.主_Agent_可以委派并行任务_适合复杂任务拆分和长流程编排') : t('settings.subagent.所有任务保持单_Agent_执行_不再暴露委派相关工具')}</p>
        </article>
        <article className="subagent-settings-overview-card">
          <span className="subagent-settings-overview-label">{t('settings.subagent.recursiveDepth')}</span>
          <strong>{subagentDepthSummary}</strong>
          <p>{t('settings.subagent.abddb7')}</p>
        </article>
        <article className="subagent-settings-overview-card">
          <span className="subagent-settings-overview-label">{t('settings.subagent.c8f3e5')}</span>
          <strong>{subagentActiveCapacityLabel}</strong>
          <p>{t('settings.subagent.activeLimitSummary', { max: subagentMaxActive, summary: subagentMaxActiveSummary })}</p>
        </article>
      </div>
      <div className="subagent-settings-grid">
        <div className="subagent-settings-card subagent-settings-card-accent">
          <div className="subagent-settings-card-header">
            <label>{t('settings.subagent.134276')}</label>
            <span className="subagent-settings-badge">{subagentEnabled ? t('settings.subagent.已启用') : t('settings.subagent.已关闭')}</span>
          </div>
          <div className="subagent-settings-card-value">{subagentEnabled ? t('settings.subagent.允许_Agent_创建和控制子代理') : t('settings.subagent.禁止创建子代理')}</div>
          <div className="settings-hint subagent-settings-card-hint">
            {t('settings.subagent.5a95e3')}
          </div>
          <label className="settings-checkbox-field">
            <input type="checkbox" checked={subagentEnabled} onChange={(event) => setSubagentEnabled(event.target.checked)} disabled={subagentSaving} />
            <span>{t('settings.subagent.30035d')}</span>
          </label>
        </div>
        <div className="subagent-settings-card">
          <div className="subagent-settings-card-header">
            <label htmlFor="subagent-max-depth">{t('settings.subagent.299b9c')}</label>
            <span className="subagent-settings-badge">{subagentDepthSummary}</span>
          </div>
          <div className="subagent-settings-card-value">{t('settings.subagent.depthValue', { depth: subagentMaxDepth })}</div>
          <div className="settings-hint subagent-settings-card-hint">{t('settings.subagent.1f2ed6')}</div>
          <div className="subagent-settings-select-wrap">
            <NcSelect id="subagent-max-depth" value={subagentMaxDepth} onChange={(event) => setSubagentMaxDepth(Math.max(1, Math.min(5, Number(event.target.value) || 1)))} disabled={subagentSaving}>
              <option value={1}>{t('settings.subagent.aa2ef9')}</option>
              <option value={2}>{t('settings.subagent.e560c6')}</option>
              <option value={3}>{t('settings.subagent.2c2d3d')}</option>
              <option value={4}>{t('settings.subagent.8b245f')}</option>
              <option value={5}>{t('settings.subagent.4f4c90')}</option>
            </NcSelect>
          </div>
        </div>
        <div className="subagent-settings-card">
          <div className="subagent-settings-card-header">
            <label htmlFor="subagent-max-active">{t('settings.subagent.1ce6ee')}</label>
            <span className="subagent-settings-badge">{subagentMaxActive}</span>
          </div>
          <div className="subagent-settings-card-value">{t('settings.subagent.maxActiveValue', { max: subagentMaxActive })}</div>
          <div className="settings-hint subagent-settings-card-hint">{t('settings.subagent.bccd04')}</div>
          <div className="subagent-settings-select-wrap">
            <NcSelect id="subagent-max-active" value={subagentMaxActive} onChange={(event) => setSubagentMaxActive(Math.max(1, Math.min(16, Number(event.target.value) || 1)))} disabled={subagentSaving}>
              {subagentMaxActiveOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label} · {option.description}</option>
              ))}
            </NcSelect>
          </div>
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn-primary" onClick={() => void saveSubagentConfig()} disabled={subagentSaving}>
          {subagentSaving ? t('settings.subagent.保存中') : t('settings.subagent.保存修改')}
        </button>
      </div>
      {subagentMessage ? (<div className={`test-result ${subagentMessageTone}`}>{subagentMessage}</div>) : null}
    </div>

    <div className="settings-subsection">
      <h3>{t('settings.subagent.90197a')}</h3>
      <p className="settings-hint">{t('settings.subagent.59630b')}</p>
      {subagentRuntime ? (
        <>
          <SubagentRuntimeExplorer
            items={subagentRuntimeItems}
            pendingActionKey={subagentRuntimeActionKey}
            onStop={stopSubagentRuntime}
            onMessage={sendSubagentRuntimeMessage}
            onSteer={steerSubagentRuntime}
          />
        </>
      ) : (
        <div className="config-info">
          <p>{t('settings.subagent.a21bbe')}</p>
        </div>
      )}
    </div>
  </div>

  );
}
