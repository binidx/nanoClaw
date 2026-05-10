import { useTranslation } from 'react-i18next';

import type { SubagentInfo } from '../app-types';

import { ToolResultCard } from './ToolResultCard';

interface SubagentActivityProps {
  info: SubagentInfo;
  argumentsText?: string;
  resultText?: string;
  errorText?: string;
}

function getSubagentStatusLabel(status: SubagentInfo['status'], t: (key: string) => string): string {
  switch (status) {
    case 'spawning':
      return t('status.creating');
    case 'idle':
      return t('status.idle');
    case 'running':
      return t('status.running');
    case 'stopping':
      return t('status.stopping');
    case 'completed':
      return t('status.completed');
    case 'failed':
      return t('status.failed');
    case 'stopped':
      return t('status.stopped');
    default:
      return status;
  }
}

export function SubagentActivity({
  info,
  argumentsText,
  resultText,
  errorText,
}: SubagentActivityProps) {
  const { t } = useTranslation('subagent');
  const metaParts = [
    info.provider ? `Provider ${info.provider}` : '',
    info.runtimeId ? `ID ${info.runtimeId}` : '',
    info.runtimeKind ? t('info.type', { kind: info.runtimeKind }) : '',
    info.mode ? (info.mode === 'agent' ? t('info.mode.agent') : t('info.mode.team')) : '',
    info.workProfile ? t('info.workProfile', { name: info.workProfile }) : '',
    (info.topologyRole || info.role)
      ? t('info.topologyRole', { role: info.topologyRole || info.role })
      : '',
    info.controlScope ? t('info.controlScope', { scope: info.controlScope }) : '',
    typeof info.depth === 'number' ? t('info.depth', { depth: info.depth }) : '',
    typeof info.requestCount === 'number' ? t('info.requestCount', { count: info.requestCount }) : '',
    info.controllable === false ? t('info.readonly') : '',
  ].filter(Boolean);
  return (
    <div className="subagent-activity-card">
      <div className="subagent-activity-head">
        <span className="subagent-activity-kind">{t('kind.subagent')}</span>
        <span className="subagent-activity-name">{info.agentName || t('kind.subagent')}</span>
        <span className={`subagent-activity-status ${info.status}`}>
          {getSubagentStatusLabel(info.status, t)}
        </span>
      </div>
      {info.task ? (
        <div className="subagent-activity-task">{info.task}</div>
      ) : null}
      {metaParts.length > 0 ? (
        <div className="subagent-activity-task">{metaParts.join(' / ')}</div>
      ) : null}
      {argumentsText ? (
        <details className="subagent-activity-details">
          <summary>{t('action.viewInput')}</summary>
          <ToolResultCard
            toolName={t('toolName.input')}
            variant="arguments"
            output={argumentsText}
          />
        </details>
      ) : null}
      {resultText ? (
        <details className="subagent-activity-details">
          <summary>{t('action.viewResult')}</summary>
          <ToolResultCard
            toolName={info.agentName || t('kind.subagent')}
            output={resultText}
          />
        </details>
      ) : null}
      {errorText ? (
        <details className="subagent-activity-details" open>
          <summary>{t('action.viewError')}</summary>
          <ToolResultCard toolName={t('toolName.error')} output={errorText} isError />
        </details>
      ) : null}
    </div>
  );
}
