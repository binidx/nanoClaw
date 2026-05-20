import { useTranslation } from 'react-i18next';

export type SettingsDiagnosticsTabProps = {
  runtimeInfoItems: Array<{ label: string; value: string }>;
  memoryPromotionSummaryItems: Array<{ label: string; value: string }>;
  memoryPromotionActionItems: Array<{ label: string; value: string }>;
  memoryPromotionClassItems: Array<{ label: string; value: string }>;
  memorySearchSummaryItems: Array<{ label: string; value: string }>;
  memorySearchScopeItems: Array<{ label: string; value: string; meta: string }>;
  memorySearchSourceItems: Array<{ label: string; value: string; meta: string }>;
  memorySearchTopGroupItems: Array<{ label: string; value: string; meta: string }>;
  doctorSummaryItems: Array<{ label: string; value: string }>;
  doctorReport: import('../../app-types').DoctorReport | null;
  doctorLoading: boolean;
  refreshDoctorReport: () => void;
  workspaceCleanupItems: Array<{ label: string; value: string }>;
  workspaceCleanupSummary: import('../../app-types').WorkspaceCleanupSummary | null;
  workspaceCleanupMessage: string;
  scanningWorkspaces: boolean;
  cleaningWorkspaces: boolean;
  refreshWorkspaceCleanupSummary: () => void;
  cleanupOrphanWorkspaces: () => void;
};

export function SettingsDiagnosticsTab(props: SettingsDiagnosticsTabProps) {
  const {
    runtimeInfoItems,
    memoryPromotionSummaryItems,
    memoryPromotionActionItems,
    memoryPromotionClassItems,
    memorySearchSummaryItems,
    memorySearchScopeItems,
    memorySearchSourceItems,
    memorySearchTopGroupItems,
    doctorSummaryItems,
    doctorReport,
    doctorLoading,
    refreshDoctorReport,
    workspaceCleanupItems,
    workspaceCleanupSummary,
    workspaceCleanupMessage,
    scanningWorkspaces,
    cleaningWorkspaces,
    refreshWorkspaceCleanupSummary,
    cleanupOrphanWorkspaces,
  } = props;

  const { t } = useTranslation('settings');

  return (
  <div className="settings-section">
    <div className="settings-subsection">
      <h3>{t('settings.diagnostics.currentRuntimeInfo')}</h3>
      <div className="settings-runtime-summary-grid">
        {runtimeInfoItems.map((item) => (
          <div
            key={item.label}
            className="status-detail-item settings-runtime-stat"
          >
            <span className="status-detail-label">{item.label}</span>
            <strong className="status-detail-value">{item.value}</strong>
          </div>
        ))}
      </div>
    </div>

    <div className="settings-subsection">
      <h3>{t('settings.diagnostics.memoryConsolidationHealth')}</h3>
      <p className="settings-hint">
        {t('settings.diagnostics.memoryConsolidationHint')}
      </p>
      <div className="settings-runtime-summary-grid settings-runtime-summary-grid-compact">
        {memoryPromotionSummaryItems.map((item) => (
          <div key={item.label} className="status-detail-item settings-runtime-stat settings-memory-runtime-stat">
            <span className="status-detail-label">{item.label}</span>
            <strong className="status-detail-value">{item.value}</strong>
          </div>
        ))}
      </div>
      <div className="settings-runtime-summary-grid settings-runtime-summary-grid-compact">
        {memoryPromotionActionItems.map((item) => (
          <div key={item.label} className="status-detail-item settings-runtime-stat settings-memory-runtime-stat">
            <span className="status-detail-label">{item.label}</span>
            <strong className="status-detail-value">{item.value}</strong>
          </div>
        ))}
      </div>
      <div className="settings-runtime-summary-grid settings-runtime-summary-grid-compact">
        {memoryPromotionClassItems.map((item) => (
          <div key={item.label} className="status-detail-item settings-runtime-stat settings-memory-runtime-stat">
            <span className="status-detail-label">{item.label}</span>
            <strong className="status-detail-value">{item.value}</strong>
          </div>
        ))}
      </div>
    </div>

    <div className="settings-subsection">
      <h3>{t('settings.diagnostics.memoryRetrievalHealth')}</h3>
      <p className="settings-hint">
        {t('settings.diagnostics.memoryRetrievalHint')}
      </p>
      <div className="settings-runtime-summary-grid settings-runtime-summary-grid-compact">
        {memorySearchSummaryItems.map((item) => (
          <div key={item.label} className="status-detail-item settings-runtime-stat settings-memory-runtime-stat">
            <span className="status-detail-label">{item.label}</span>
            <strong className="status-detail-value">{item.value}</strong>
          </div>
        ))}
      </div>
      <div className="settings-runtime-summary-grid settings-runtime-summary-grid-compact">
        {memorySearchScopeItems.map((item) => (
          <div key={item.label} className="status-detail-item settings-runtime-stat settings-memory-runtime-stat">
            <span className="status-detail-label">{item.label}</span>
            <strong className="status-detail-value">{item.value}</strong>
            <span className="status-detail-label">{item.meta}</span>
          </div>
        ))}
      </div>
      {memorySearchSourceItems.length > 0 ? (
        <div className="settings-runtime-summary-grid settings-runtime-summary-grid-compact">
          {memorySearchSourceItems.map((item) => (
            <div key={item.label} className="status-detail-item settings-runtime-stat settings-memory-runtime-stat">
              <span className="status-detail-label">{t('settings.diagnostics.sourceLabel', { label: item.label })}</span>
              <strong className="status-detail-value">{item.value}</strong>
              <span className="status-detail-label">{item.meta}</span>
            </div>
          ))}
        </div>
      ) : null}
      {memorySearchTopGroupItems.length > 0 ? (
        <div className="settings-memory-group-list">
          {memorySearchTopGroupItems.map((item) => (
            <div key={item.label} className="status-detail-item settings-runtime-stat settings-memory-runtime-stat settings-memory-group-stat">
              <span className="status-detail-label">Group · {item.label}</span>
              <strong className="status-detail-value">{item.value}</strong>
              <span className="status-detail-label">{item.meta}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>

    <div className="settings-subsection">
      <div className="section-header">
        <h3>{t('settings.diagnostics.runtimeDiagnostics')}</h3>
        <button className="btn-outline btn-sm" onClick={refreshDoctorReport} disabled={doctorLoading}>
          {doctorLoading ? t('settings.diagnostics.diagnosing') : t('settings.diagnostics.rediagnose')}
        </button>
      </div>
      <div className="settings-runtime-summary-grid settings-runtime-summary-grid-compact">
        {doctorSummaryItems.map((item) => (
          <div key={item.label} className="status-detail-item settings-runtime-stat">
            <span className="status-detail-label">{item.label}</span>
            <strong className="status-detail-value">{item.value}</strong>
          </div>
        ))}
      </div>
      {doctorReport?.checks.length ? (
        <div className="config-info settings-diagnostics-list">
          {doctorReport.checks.slice(0, 6).map((check) => (
            <p key={check.id}>
              <strong>[{check.severity.toUpperCase()}]</strong>{' '}
              {check.summary}
              {check.detail ? t('settings.diagnostics.checkDetail', { detail: check.detail }) : ''}
              {check.suggestedFix ? t('settings.diagnostics.suggestedFix', { fix: check.suggestedFix }) : ''}
            </p>
          ))}
        </div>
      ) : null}
    </div>

    <div className="settings-subsection">
      <div className="section-header">
        <h3>{t('settings.diagnostics.workspaceCleanup')}</h3>
        <button className="btn-outline btn-sm" onClick={refreshWorkspaceCleanupSummary} disabled={scanningWorkspaces || cleaningWorkspaces}>
          {scanningWorkspaces ? t('settings.diagnostics.scanning') : t('settings.diagnostics.rescan')}
        </button>
      </div>
      <div className="settings-runtime-summary-grid settings-runtime-summary-grid-compact">
        {workspaceCleanupItems.map((item) => (
          <div key={item.label} className="status-detail-item settings-runtime-stat">
            <span className="status-detail-label">{item.label}</span>
            <strong className="status-detail-value">{item.value}</strong>
          </div>
        ))}
      </div>
      {workspaceCleanupSummary && (workspaceCleanupSummary.orphanDirectories.length > 0 || workspaceCleanupSummary.staleRegisteredGroups.length > 0) && (
        <div className="test-result error">
          {workspaceCleanupSummary.orphanDirectories.length > 0 && (
            <>
              {t('settings.diagnostics.orphanDirectoriesDetected')}
              {workspaceCleanupSummary.orphanDirectories.slice(0, 6).map((entry) => ` ${entry.root}/${entry.folder}`).join('、')}
              {workspaceCleanupSummary.orphanDirectories.length > 6 ? ' ...' : ''}
            </>
          )}
          {workspaceCleanupSummary.staleRegisteredGroups.length > 0 && (
            <>
              {workspaceCleanupSummary.orphanDirectories.length > 0 ? '；' : ''}
              {t('settings.diagnostics.staleGroupMappingsDetected')}
              {workspaceCleanupSummary.staleRegisteredGroups.slice(0, 4).map((entry) => ` ${entry.folder}`).join('、')}
              {workspaceCleanupSummary.staleRegisteredGroups.length > 4 ? ' ...' : ''}
            </>
          )}
        </div>
      )}
      {workspaceCleanupMessage && (
        <div className="test-result success">{workspaceCleanupMessage}</div>
      )}
      <div className="modal-actions">
        <button className="btn-danger" onClick={cleanupOrphanWorkspaces} disabled={cleaningWorkspaces || scanningWorkspaces}>
          {cleaningWorkspaces ? t('settings.diagnostics.cleaning') : t('settings.diagnostics.cleanOrphanDirectories')}
        </button>
      </div>
    </div>
  </div>

  );
}
