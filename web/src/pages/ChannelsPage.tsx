import { useTranslation } from 'react-i18next';
import type { DoctorReport, StatusInfo } from '../app-types';
import '../styles/channels.css';

function getDoctorSeverityWeight(severity: string): number {
  if (severity === 'error') return 0;
  if (severity === 'warn') return 1;
  return 2;
}

export interface ChannelsPageProps {
  status: StatusInfo | null;
  doctorReport: DoctorReport | null;
  formatUptime: (seconds: number) => string;
  openSettings: () => void;
  refreshDoctorReport: () => void;
  section?: 'all' | 'overview' | 'diagnostics';
  showHeader?: boolean;
}

export function ChannelsPage({
  status,
  doctorReport,
  formatUptime,
  openSettings,
  refreshDoctorReport,
  section = 'all',
  showHeader = true,
}: ChannelsPageProps) {
  const { t } = useTranslation('channels');
  const orderedChannels = [...(status?.channels || [])].sort((left, right) => {
    if (left.connected === right.connected) {
      return left.name.localeCompare(right.name);
    }
    return left.connected ? 1 : -1;
  });
  const doctorChecks = [...(doctorReport?.checks || [])].sort((left, right) => {
    const severityDiff =
      getDoctorSeverityWeight(left.severity) -
      getDoctorSeverityWeight(right.severity);
    if (severityDiff !== 0) return severityDiff;
    return left.summary.localeCompare(right.summary, 'zh-Hans-CN');
  });
  const totalChannels = status?.channels.length ?? 0;
  const connectedChannels =
    status?.channels.filter((channel) => channel.connected).length ?? 0;
  const disconnectedChannels = totalChannels - connectedChannels;
  const warningCount = doctorReport?.counts.warn ?? 0;
  const errorCount = doctorReport?.counts.error ?? 0;
  const infoCount = doctorReport?.counts.info ?? 0;
  const overallStatusKey =
    errorCount > 0 ? 'channels.page.hasErrors' : warningCount > 0 ? 'channels.page.hasWarnings' : 'channels.page.normal';
  const providerLabel = status?.providerAlias || status?.provider || '-';

  return (
    <div className="page-view">
      {showHeader ? (
        <div className="page-header">
          <div className="page-header-copy">
            <h2>{t('channels.page.title')}</h2>
            <p>{t('channels.page.subtitle')}</p>
          </div>
          <div className="page-header-actions">
            <button
              className="btn-outline btn-sm"
              onClick={openSettings}
              type="button"
            >
              {t('channels.page.goToConfig')}
            </button>
            <button
              className="btn-outline btn-sm"
              onClick={refreshDoctorReport}
              type="button"
            >
              {t('channels.page.refreshDiagnostics')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="page-body channel-status-body">
        {section !== 'diagnostics' ? (
        <>
        <div className="status-overview-grid channel-overview-grid">
          <div className="status-card status-overview-card channel-overview-card">
            <div className="card-header">
              <span className="card-title">{t('channels.page.channelConnections')}</span>
              <span
                className={`channel-overview-tag ${
                  disconnectedChannels > 0 ? 'risk' : 'healthy'
                }`}
              >
                {disconnectedChannels > 0 ? t('channels.page.needsAttention') : t('channels.page.stable')}
              </span>
            </div>
            <div className="card-value">
              {connectedChannels}/{totalChannels}
            </div>
            <div className="card-meta">
              {disconnectedChannels > 0
                ? t('channels.page.channelsPendingRestore', { count: disconnectedChannels })
                : t('channels.page.allChannelsConnected')}
            </div>
          </div>

          <div className="status-card status-overview-card channel-overview-card">
            <div className="card-header">
              <span className="card-title">{t('channels.page.activeAgents')}</span>
              <span className="channel-overview-tag">{t('channels.page.running')}</span>
            </div>
            <div className="card-value">
              {status?.agents.activeAgents ?? '-'}
            </div>
            <div className="card-meta">
              {t('channels.page.providerLabel')}{providerLabel}
            </div>
          </div>

          <div className="status-card status-overview-card channel-overview-card">
            <div className="card-header">
              <span className="card-title">{t('channels.page.uptime')}</span>
              <span className="channel-overview-tag">{t('channels.page.service')}</span>
            </div>
            <div className="card-value">
              {status ? formatUptime(status.uptime) : '-'}
            </div>
            <div className="card-meta">
              {t('channels.page.webTerminal')} {status?.webTerminalEnabled ? t('channels.page.enabled') : t('channels.page.disabled')}
            </div>
          </div>

          <div className="status-card status-overview-card channel-overview-card">
            <div className="card-header">
              <span className="card-title">{t('channels.page.diagnosticStatus')}</span>
              <span
                className={`channel-overview-tag ${
                  errorCount > 0 ? 'risk' : warningCount > 0 ? 'warn' : 'healthy'
                }`}
              >
                {t(overallStatusKey)}
              </span>
            </div>
            <div className="card-value">{t(overallStatusKey)}</div>
            <div className="card-meta">
              {t('channels.page.errorWarnInfoCounts', { errors: errorCount, warnings: warningCount, infos: infoCount })}
            </div>
          </div>
        </div>

        <div className="channel-status-layout">
          <section className="status-card channel-health-panel status-runtime-panel">
            <div className="section-header">
              <div>
                <h3>{t('channels.page.serviceStatus')}</h3>
                <p className="settings-hint channel-panel-hint">
                  {t('channels.page.serviceStatusHint')}
                </p>
              </div>
            </div>
            <div className="status-detail-grid">
              <div className="status-detail-item">
                <span className="status-detail-label">{t('channels.page.currentProvider')}</span>
                <strong className="status-detail-value">
                  {status?.providerAlias || status?.provider || '-'}
                </strong>
              </div>
              <div className="status-detail-item">
                <span className="status-detail-label">{t('channels.page.webTerminal')}</span>
                <strong className="status-detail-value">
                  {status?.webTerminalEnabled ? t('channels.page.enabled') : t('channels.page.disabled')}
                </strong>
              </div>
              <div className="status-detail-item">
                <span className="status-detail-label">{t('channels.page.insecureTls')}</span>
                <strong className="status-detail-value">
                  {status?.allowInsecureTls ? t('channels.page.enabled') : t('channels.page.disabled')}
                </strong>
              </div>
              <div className="status-detail-item">
                <span className="status-detail-label">{t('channels.page.subagentOrchestration')}</span>
                <strong className="status-detail-value">
                  {status?.subagentsEnabled === true
                    ? t('channels.page.enabled')
                    : status?.subagentsEnabled === false
                      ? t('channels.page.disabled')
                      : t('channels.page.unknown')}
                </strong>
              </div>
            </div>
          </section>

          <section className="status-card channel-health-panel">
            <div className="section-header">
              <div>
                <h3>{t('channels.page.channelStatus')}</h3>
                <p className="settings-hint channel-panel-hint">
                  {t('channels.page.channelStatusHint')}
                </p>
              </div>
            </div>
            {orderedChannels.length ? (
              <div className="channel-health-list channel-service-list">
                {orderedChannels.map((channel) => (
                  <div
                    key={channel.name}
                    className={`channel-health-item channel-service-item ${
                      channel.connected ? 'is-connected' : 'is-disconnected'
                    }`}
                  >
                    <span
                      className={`status-dot ${channel.connected ? 'online' : ''}`}
                    />
                    <div className="channel-health-copy">
                      <strong>{channel.name}</strong>
                      <p>
                        {channel.connected
                          ? t('channels.page.channelConnected')
                          : t('channels.page.channelDisconnected')}
                      </p>
                      {!channel.connected ? (
                        <p className="settings-hint channel-service-tip">
                          {t('channels.page.checkConfigHint')}
                        </p>
                      ) : null}
                    </div>
                    <span
                      className={`channel-instance-status ${channel.connected ? 'enabled' : 'disabled'}`}
                    >
                      {channel.connected ? t('channels.page.connected') : t('channels.page.disconnected')}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-hint">{t('channels.page.noChannelStatus')}</div>
            )}
          </section>
        </div>
        </>
        ) : null}

        {section !== 'overview' ? (
        <section className="status-card channel-health-panel status-risk-panel">
          <div className="section-header">
              <div>
                <h3>{t('channels.page.diagnosticRisks')}</h3>
                <p className="settings-hint channel-panel-hint">
                  {t('channels.page.diagnosticRisksHint')}
                </p>
              </div>
            <span
              className={`channel-overview-tag ${
                errorCount > 0 ? 'risk' : warningCount > 0 ? 'warn' : 'healthy'
              }`}
            >
              {t('channels.page.items', { count: doctorChecks.length })}
            </span>
          </div>
          {doctorChecks.length > 0 ? (
            <div className="channel-health-list">
              {doctorChecks.map((check) => (
                <div
                  key={check.id}
                  className={`channel-health-item channel-risk-item severity-${check.severity}`}
                >
                  <span className={`setup-status-dot ${check.severity}`}></span>
                  <div className="channel-health-copy">
                    <strong>{check.summary}</strong>
                    {check.detail ? <p>{check.detail}</p> : null}
                    {check.suggestedFix ? (
                      <p className="settings-hint">
                        {t('channels.page.suggestionPrefix')}{check.suggestedFix}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="settings-hint">{t('channels.page.noRisks')}</div>
          )}
        </section>
        ) : null}
      </div>
    </div>
  );
}
