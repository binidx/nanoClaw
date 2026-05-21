import {
  memo,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { ApprovalRequest, ApprovalScope } from '../app-types';
import { AppSelect } from './AppSelect';
import { IconX } from './AppIcons';

export function sortApprovalsByCreatedAt(
  approvals: ApprovalRequest[],
): ApprovalRequest[] {
  return [...approvals].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function getApprovalRemainingSeconds(
  expiresAt: string,
  nowMs: number,
): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMs) / 1000));
}

export function getApprovalTotalSeconds(
  createdAt: string,
  expiresAt: string,
): number {
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(createdMs) ||
    !Number.isFinite(expiresMs) ||
    expiresMs <= createdMs
  ) {
    return 120;
  }
  return Math.max(1, Math.ceil((expiresMs - createdMs) / 1000));
}

interface ApprovalOverlayProps {
  approvals: ApprovalRequest[];
  resolvingApprovalId: string | null;
  accessPolicySummary?: string;
  onOpenAccessDialog?: () => void;
  onResolve: (
    approval: ApprovalRequest,
    decision: 'allow-once' | 'deny',
    scope?: ApprovalScope,
  ) => void;
}

export const ApprovalOverlay = memo(function ApprovalOverlay({
  approvals,
  resolvingApprovalId,
  accessPolicySummary,
  onOpenAccessDialog,
  onResolve,
}: ApprovalOverlayProps) {
  const sortedApprovals = useMemo(
    () => sortApprovalsByCreatedAt(approvals),
    [approvals],
  );
  const activeApproval = sortedApprovals[0] || null;

  if (!activeApproval) return null;

  return (
    <ApprovalOverlayCard
      key={activeApproval.id}
      activeApproval={activeApproval}
      sortedApprovals={sortedApprovals}
      resolvingApprovalId={resolvingApprovalId}
      accessPolicySummary={accessPolicySummary}
      onOpenAccessDialog={onOpenAccessDialog}
      onResolve={onResolve}
    />
  );
});

interface ApprovalOverlayCardProps extends Omit<ApprovalOverlayProps, 'approvals'> {
  activeApproval: ApprovalRequest;
  sortedApprovals: ApprovalRequest[];
}

function ApprovalOverlayCard({
  activeApproval,
  sortedApprovals,
  resolvingApprovalId,
  accessPolicySummary,
  onOpenAccessDialog,
  onResolve,
}: ApprovalOverlayCardProps) {
  const { t } = useTranslation('approval');
  const [now, setNow] = useState(() => Date.now());
  const [approvalScope, setApprovalScope] =
    useState<ApprovalScope>('current_runtime');
  const activeIndex = activeApproval
    ? sortedApprovals.findIndex((approval) => approval.id === activeApproval.id)
    : -1;
  const isDirectoryAccess = activeApproval.toolName === 'DirectoryAccess';
  const effectiveApprovalScope: ApprovalScope = isDirectoryAccess
    ? 'current_tool_call'
    : approvalScope;
  const remainingSeconds = activeApproval
    ? getApprovalRemainingSeconds(activeApproval.expiresAt, now)
    : 0;
  const totalSeconds = activeApproval
    ? getApprovalTotalSeconds(activeApproval.createdAt, activeApproval.expiresAt)
    : 120;
  const resolving = !!activeApproval && resolvingApprovalId === activeApproval.id;
  const expired = remainingSeconds === 0;

  useEffect(() => {
    if (!activeApproval) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeApproval?.id]);

  return (
    <div className="approval-overlay-shell" aria-live="polite">
      <div className="approval-overlay-card">
        <div className="approval-overlay-bar">
          <div
            className="approval-overlay-progress"
            style={{
              width: `${Math.min(100, (remainingSeconds / totalSeconds) * 100)}%`,
              transition: 'width 1s linear',
            }}
          />
        </div>
        <div className="approval-overlay-header">
          <div className="approval-overlay-header-main">
            <span className="approval-overlay-label">
              {isDirectoryAccess ? t('title.directoryAccess') : t('title.commandConfirm')}
            </span>
            {sortedApprovals.length > 1 ? (
              <span className="approval-overlay-queue">
                {activeIndex + 1} / {sortedApprovals.length}
              </span>
            ) : null}
          </div>
          <div className="approval-overlay-header-actions">
            <span
              className={`approval-overlay-timer ${remainingSeconds <= 5 ? 'expired' : ''}`}
            >
              {remainingSeconds}s
            </span>
            <button
              type="button"
              className="approval-overlay-close"
              aria-label={t('button.reject')}
              title={t('button.reject')}
              onClick={() => onResolve(activeApproval, 'deny')}
              disabled={resolving || expired}
            >
              <IconX />
            </button>
          </div>
        </div>
        {isDirectoryAccess ? (
          <div className="approval-overlay-command">
            <span>{t('directoryRequest')}</span>
            <code>{activeApproval.cwd || activeApproval.command}</code>
            <div className="approval-overlay-hint" style={{ marginTop: 6 }}>
              {t('directoryHint')}
            </div>
          </div>
        ) : (
          <div className="approval-overlay-command">
            <code>{activeApproval.command}</code>
          </div>
        )}
        <div className="approval-overlay-meta">
          {isDirectoryAccess ? null : (
            <span>{t('tool', { name: activeApproval.toolName })}</span>
          )}
          {!isDirectoryAccess && activeApproval.cwd ? (
            <span>{t('directory', { path: activeApproval.cwd })}</span>
          ) : null}
        </div>
        {!isDirectoryAccess ? (
          <>
            <label className="approval-overlay-scope">
              <span>{t('scope.title')}</span>
              <AppSelect
                value={approvalScope}
                onChange={(value) => setApprovalScope(value as ApprovalScope)}
                ariaLabel={t('scope.title')}
                options={[
                  { value: 'current_runtime', label: t('scope.runtime') },
                  { value: 'current_tool_call', label: t('scope.toolCall') },
                ]}
                compact
                menuMatchTrigger
              />
            </label>
            <div className="approval-overlay-help">
              {approvalScope === 'current_runtime'
                ? t('scope.runtimeHint')
                : t('scope.toolCallHint')}
            </div>
          </>
        ) : null}
        {expired ? (
          <div className="approval-overlay-expired">
            {t('timedOut')}
          </div>
        ) : null}
        <div className="approval-overlay-footer">
          <div className="approval-overlay-footer-copy">
            {accessPolicySummary ? (
              <span className="approval-overlay-policy">
                {t('currentPolicy', { policy: accessPolicySummary })}
              </span>
            ) : null}
            {onOpenAccessDialog ? (
              <button
                type="button"
                className="approval-overlay-link"
                onClick={onOpenAccessDialog}
              >
                {t('viewPolicy')}
              </button>
            ) : null}
          </div>
          <div className="approval-overlay-actions">
            <button
              type="button"
              className="approval-overlay-btn deny"
              onClick={() => onResolve(activeApproval, 'deny')}
              disabled={resolving || expired}
            >
              {resolving ? t('button.rejecting') : t('button.rejectBtn')}
            </button>
            <button
              type="button"
              className="approval-overlay-btn allow"
              onClick={() =>
                onResolve(activeApproval, 'allow-once', effectiveApprovalScope)
              }
              disabled={resolving || expired}
            >
              {resolving
                ? t('button.allowing')
                : effectiveApprovalScope === 'current_runtime'
                  ? t('button.allowRuntime')
                  : t('button.allowOnce')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
