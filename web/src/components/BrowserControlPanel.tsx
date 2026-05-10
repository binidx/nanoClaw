import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  BrowserActionResult,
  BrowserLogs,
  BrowserRoleSnapshot,
  BrowserRuntimeStatus,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserSnapshotNode,
  BrowserTab,
} from '../app-types';
import { AppSelect, type AppSelectOption } from './AppSelect';

type BrowserActionKind =
  | 'navigate'
  | 'click'
  | 'type'
  | 'press'
  | 'hover'
  | 'scrollIntoView'
  | 'wait'
  | 'waitFor';

interface BrowserControlPanelProps {
  apiBase: string;
}

interface BrowserTabsResponse {
  running: boolean;
  tabs: BrowserTab[];
}

function buildApiUrl(apiBase: string, path: string): string {
  return `${apiBase}${path}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    suggestion?: string;
    errorContext?: {
      action?: string;
      ref?: string;
      selector?: string;
    };
  } & T;
  if (!response.ok) {
    const details = [
      data.error || `Request failed with status ${response.status}`,
      data.errorContext
        ? [
            data.errorContext.action ? `action=${data.errorContext.action}` : '',
            data.errorContext.ref ? `ref=${data.errorContext.ref}` : '',
            data.errorContext.selector ? `selector=${data.errorContext.selector}` : '',
          ]
            .filter(Boolean)
            .join(' | ')
        : '',
      data.suggestion ? `Suggestion: ${data.suggestion}` : '',
    ].filter(Boolean);
    throw new Error(details.join('\n'));
  }
  return data;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function getTabLabel(tab: BrowserTab): string {
  const title = tab.title.trim() || '(untitled)';
  const url = tab.url.trim() || 'about:blank';
  return `${title} · ${url}`;
}

function getNodeLabel(node: BrowserSnapshotNode): string {
  const role = node.role || 'node';
  const title = node.name || node.value || node.description || '(unnamed)';
  return `${node.ref} · ${role} · ${title}`;
}

function formatActionFeedback(
  actionKind: BrowserActionKind,
  result: BrowserActionResult,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts = [
    t('status.actionDone', { action: actionKind }),
    result.targetId ? t('status.target', { id: result.targetId }) : '',
    typeof result.waitedMs === 'number' ? t('status.waited', { ms: result.waitedMs }) : '',
    result.ref ? `ref=${result.ref}` : '',
    result.selector ? `selector=${result.selector}` : '',
    result.key ? `key=${result.key}` : '',
  ].filter(Boolean);
  if (result.title || result.url) {
    parts.push(
      [result.title || '(untitled)', result.url || 'about:blank']
        .filter(Boolean)
        .join(' · '),
    );
  }
  return parts.join(' | ');
}

function formatCacheState(
  cacheHit: boolean | undefined,
  t: (key: string) => string,
): string {
  if (cacheHit === true) return t('status.cacheHit');
  if (cacheHit === false) return t('status.refetch');
  return t('status.notReturned');
}

function isSnapshotMutatingAction(actionKind: BrowserActionKind): boolean {
  return (
    actionKind === 'navigate' ||
    actionKind === 'click' ||
    actionKind === 'type' ||
    actionKind === 'press'
  );
}

export function BrowserControlPanel({ apiBase }: BrowserControlPanelProps) {
  const { t } = useTranslation('browser');

  const ACTION_KIND_OPTIONS: AppSelectOption[] = useMemo(() => [
    { value: 'navigate', label: t('action.navigate') },
    { value: 'click', label: t('action.click') },
    { value: 'type', label: t('action.type') },
    { value: 'press', label: t('action.press') },
    { value: 'hover', label: t('action.hover') },
    { value: 'scrollIntoView', label: t('action.scrollIntoView') },
    { value: 'wait', label: t('action.wait') },
    { value: 'waitFor', label: t('action.waitFor') },
  ], [t]);

  const ACTION_TARGET_MODE_OPTIONS: AppSelectOption[] = useMemo(() => [
    { value: 'ref', label: t('selector.ref') },
    { value: 'selector', label: t('selector.selector') },
  ], [t]);

  const [status, setStatus] = useState<BrowserRuntimeStatus | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const [roleSnapshot, setRoleSnapshot] = useState<BrowserRoleSnapshot | null>(null);
  const [screenshot, setScreenshot] = useState<BrowserScreenshot | null>(null);
  const [logs, setLogs] = useState<BrowserLogs | null>(null);
  const [logsTargetId, setLogsTargetId] = useState('');
  const [openUrlDraft, setOpenUrlDraft] = useState('https://example.com');
  const [actionKind, setActionKind] = useState<BrowserActionKind>('navigate');
  const [actionTargetMode, setActionTargetMode] = useState<'ref' | 'selector'>('ref');
  const [actionUrlDraft, setActionUrlDraft] = useState('https://example.com');
  const [actionRef, setActionRef] = useState('');
  const [actionSelector, setActionSelector] = useState('');
  const [actionText, setActionText] = useState('');
  const [actionKey, setActionKey] = useState('Enter');
  const [actionWaitMs, setActionWaitMs] = useState('1000');
  const [actionWaitForSelector, setActionWaitForSelector] = useState('');
  const [actionWaitForUrlIncludes, setActionWaitForUrlIncludes] = useState('');
  const [actionWaitForTitleIncludes, setActionWaitForTitleIncludes] = useState('');
  const [actionWaitForTimeoutMs, setActionWaitForTimeoutMs] = useState('10000');
  const [actionWaitForPollMs, setActionWaitForPollMs] = useState('250');
  const [loadingState, setLoadingState] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [roleSnapshotLoading, setRoleSnapshotLoading] = useState(false);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [snapshotStale, setSnapshotStale] = useState(false);
  const [roleSnapshotStale, setRoleSnapshotStale] = useState(false);
  const [screenshotStale, setScreenshotStale] = useState(false);
  const [logsStale, setLogsStale] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    null,
  );

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.targetId === selectedTargetId) || null,
    [selectedTargetId, tabs],
  );
  const tabOptions = useMemo<AppSelectOption[]>(
    () =>
      tabs.map((tab) => ({
        value: tab.targetId,
        label: getTabLabel(tab),
      })),
    [tabs],
  );
  const actionableNodeOptions = useMemo<AppSelectOption[]>(
    () =>
      (snapshot?.nodes || [])
        .filter((node) => node.actionable)
        .map((node) => ({
          value: node.ref,
          label: getNodeLabel(node),
        })),
    [snapshot],
  );

  const refreshBrowserState = useCallback(
    async (keepMessage = false) => {
      setLoadingState(true);
      if (!keepMessage) {
        setFeedback(null);
      }
      try {
        const [nextStatus, nextTabs] = await Promise.all([
          requestJson<BrowserRuntimeStatus>(
            buildApiUrl(apiBase, '/api/browser/status'),
          ),
          requestJson<BrowserTabsResponse>(buildApiUrl(apiBase, '/api/browser/tabs')),
        ]);
        setStatus(nextStatus);
        setTabs(nextTabs.tabs || []);
        setSelectedTargetId((current) => {
          if (current && nextTabs.tabs.some((tab) => tab.targetId === current)) {
            return current;
          }
          if (
            nextStatus.lastTargetId &&
            nextTabs.tabs.some((tab) => tab.targetId === nextStatus.lastTargetId)
          ) {
            return nextStatus.lastTargetId;
          }
          return nextTabs.tabs[0]?.targetId || '';
        });
      } catch (error) {
        setFeedback({
          tone: 'error',
          text: error instanceof Error ? error.message : t('status.refreshFailed'),
        });
      } finally {
        setLoadingState(false);
      }
    },
    [apiBase, t],
  );

  useEffect(() => {
    void refreshBrowserState();
  }, [refreshBrowserState]);

  useEffect(() => {
    if (!selectedTargetId) {
      setSnapshot(null);
      setRoleSnapshot(null);
      setScreenshot(null);
      setLogs(null);
      setLogsTargetId('');
      setSnapshotStale(false);
      setRoleSnapshotStale(false);
      setScreenshotStale(false);
      setLogsStale(false);
      setActionRef('');
      return;
    }
    if (snapshot?.targetId && snapshot.targetId !== selectedTargetId) {
      setSnapshot(null);
      setSnapshotStale(false);
    }
    if (roleSnapshot?.targetId && roleSnapshot.targetId !== selectedTargetId) {
      setRoleSnapshot(null);
      setRoleSnapshotStale(false);
    }
    if (screenshot?.targetId && screenshot.targetId !== selectedTargetId) {
      setScreenshot(null);
      setScreenshotStale(false);
    }
  }, [selectedTargetId, roleSnapshot?.targetId, screenshot?.targetId, snapshot?.targetId]);

  useEffect(() => {
    if (!selectedTargetId || (logs && logsTargetId && logsTargetId !== selectedTargetId)) {
      setLogs(null);
      setLogsTargetId('');
      setLogsStale(false);
    }
  }, [logs, logsTargetId, selectedTargetId]);

  useEffect(() => {
    if (!actionRef && actionableNodeOptions.length > 0) {
      setActionRef(actionableNodeOptions[0]?.value || '');
    }
  }, [actionRef, actionableNodeOptions]);

  const runMutation = useCallback(
    async (run: () => Promise<string | void>, successMessage: string) => {
      setMutating(true);
      setFeedback(null);
      try {
        const customMessage = await run();
        setFeedback({
          tone: 'success',
          text:
            typeof customMessage === 'string' && customMessage.trim()
              ? customMessage
              : successMessage,
        });
      } catch (error) {
        setFeedback({
          tone: 'error',
          text: error instanceof Error ? error.message : t('status.operationFailed'),
        });
      } finally {
        setMutating(false);
      }
    },
    [t],
  );

  const handleStart = () =>
    runMutation(async () => {
      await requestJson(buildApiUrl(apiBase, '/api/browser/start'), {
        method: 'POST',
      });
      await refreshBrowserState(true);
      return status?.connectionMode === 'connect'
        ? t('status.connected')
        : t('status.started');
    }, t('status.connectedMsg'));

  const handleStop = () =>
    runMutation(async () => {
      await requestJson(buildApiUrl(apiBase, '/api/browser/stop'), {
        method: 'POST',
      });
      setSnapshot(null);
      setRoleSnapshot(null);
      setScreenshot(null);
      setLogs(null);
      setLogsTargetId('');
      setSnapshotStale(false);
      setRoleSnapshotStale(false);
      setScreenshotStale(false);
      setLogsStale(false);
      await refreshBrowserState(true);
      return status?.connectionMode === 'connect'
        ? t('status.disconnected')
        : t('status.stopped');
    }, t('status.disconnectedMsg'));

  const handleOpenTab = () =>
    runMutation(async () => {
      const created = await requestJson<BrowserTab>(
        buildApiUrl(apiBase, '/api/browser/tabs/open'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: openUrlDraft }),
        },
      );
      setSelectedTargetId(created.targetId);
      setActionUrlDraft(created.url || openUrlDraft);
      await refreshBrowserState(true);
    }, t('status.tabOpened'));

  const handleFocusTab = (targetId: string) =>
    runMutation(async () => {
      await requestJson(buildApiUrl(apiBase, '/api/browser/tabs/focus'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId }),
      });
      setSelectedTargetId(targetId);
      await refreshBrowserState(true);
    }, t('status.tabFocused'));

  const handleCloseTab = (targetId: string) =>
    runMutation(async () => {
      await requestJson(buildApiUrl(apiBase, `/api/browser/tabs/${targetId}`), {
        method: 'DELETE',
      });
      if (targetId === selectedTargetId) {
        setSnapshot(null);
        setRoleSnapshot(null);
        setScreenshot(null);
        setLogs(null);
        setLogsTargetId('');
        setSnapshotStale(false);
        setRoleSnapshotStale(false);
        setScreenshotStale(false);
        setLogsStale(false);
      }
      await refreshBrowserState(true);
    }, t('status.tabClosed'));

  const handleLoadSnapshot = async (forceRefresh = false) => {
    if (!selectedTargetId) {
      setFeedback({ tone: 'error', text: t('status.selectTabFirst') });
      return;
    }
    setSnapshotLoading(true);
    setFeedback(null);
    try {
      const params = new URLSearchParams({
        targetId: selectedTargetId,
      });
      if (forceRefresh) {
        params.set('force', 'true');
      }
      const nextSnapshot = await requestJson<BrowserSnapshot>(
        buildApiUrl(
          apiBase,
          `/api/browser/snapshot?${params.toString()}`,
        ),
      );
      setSnapshot(nextSnapshot);
      setSnapshotStale(false);
      setActionRef(
        nextSnapshot.nodes.find((node) => node.actionable)?.ref || '',
      );
      setFeedback({
        tone: 'success',
        text: t('status.snapshotRead', { cache: formatCacheState(nextSnapshot.cacheHit, t), count: nextSnapshot.nodes.length }),
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : t('status.snapshotFailed'),
      });
    } finally {
      setSnapshotLoading(false);
    }
  };

  const handleLoadRoleSnapshot = async (forceRefresh = false) => {
    if (!selectedTargetId) {
      setFeedback({ tone: 'error', text: t('status.selectTabFirst') });
      return;
    }
    setRoleSnapshotLoading(true);
    setFeedback(null);
    try {
      const params = new URLSearchParams({
        targetId: selectedTargetId,
        interactive: 'true',
        compact: 'true',
        maxDepth: '12',
      });
      if (forceRefresh) {
        params.set('force', 'true');
      }
      const nextRoleSnapshot = await requestJson<BrowserRoleSnapshot>(
        buildApiUrl(
          apiBase,
          `/api/browser/role-snapshot?${params.toString()}`,
        ),
      );
      setRoleSnapshot(nextRoleSnapshot);
      setRoleSnapshotStale(false);
      const firstRef = Object.keys(nextRoleSnapshot.refs)[0] || '';
      if (firstRef) {
        setActionRef(firstRef);
      }
      setFeedback({
        tone: 'success',
        text: t('status.roleSnapshotRead', { cache: formatCacheState(nextRoleSnapshot.cacheHit, t), count: nextRoleSnapshot.stats.refs }),
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : t('status.roleSnapshotFailed'),
      });
    } finally {
      setRoleSnapshotLoading(false);
    }
  };

  const handleLoadScreenshot = async () => {
    if (!selectedTargetId) {
      setFeedback({ tone: 'error', text: t('status.selectTabFirst') });
      return;
    }
    setScreenshotLoading(true);
    setFeedback(null);
    try {
      const nextScreenshot = await requestJson<BrowserScreenshot>(
        buildApiUrl(
          apiBase,
          `/api/browser/screenshot?targetId=${encodeURIComponent(selectedTargetId)}`,
        ),
      );
      setScreenshot(nextScreenshot);
      setScreenshotStale(false);
      setFeedback({ tone: 'success', text: t('status.screenshotCaptured') });
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : t('status.screenshotFailed'),
      });
    } finally {
      setScreenshotLoading(false);
    }
  };

  const handleLoadLogs = async () => {
    if (!selectedTargetId) {
      setFeedback({ tone: 'error', text: t('status.selectTabFirst') });
      return;
    }
    setLogsLoading(true);
    setFeedback(null);
    try {
      const nextLogs = await requestJson<BrowserLogs>(
        buildApiUrl(
          apiBase,
          `/api/browser/logs?targetId=${encodeURIComponent(selectedTargetId)}`,
        ),
      );
      setLogs(nextLogs);
      setLogsTargetId(selectedTargetId);
      setLogsStale(false);
      setFeedback({
        tone: 'success',
        text: t('status.logsRead', { console: nextLogs.console.length, errors: nextLogs.errors.length }),
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : t('status.logsFailed'),
      });
    } finally {
      setLogsLoading(false);
    }
  };

  const handleRunAction = () =>
    runMutation(async () => {
      if (!selectedTargetId) {
        throw new Error(t('status.selectTabFirst'));
      }
      const action =
        actionKind === 'navigate'
          ? { kind: 'navigate' as const, url: actionUrlDraft }
          : actionKind === 'press'
            ? { kind: 'press' as const, key: actionKey }
            : actionKind === 'type'
              ? {
                  kind: 'type' as const,
                  ...(actionTargetMode === 'selector'
                    ? { selector: actionSelector }
                    : { ref: actionRef }),
                  text: actionText,
                }
              : actionKind === 'wait'
                ? {
                    kind: 'wait' as const,
                    timeMs: Number.parseInt(actionWaitMs || '0', 10) || 0,
                  }
                : actionKind === 'waitFor'
                  ? {
                      kind: 'waitFor' as const,
                      ...(actionWaitForSelector.trim()
                        ? { selector: actionWaitForSelector.trim() }
                        : {}),
                      ...(actionWaitForUrlIncludes.trim()
                        ? { urlIncludes: actionWaitForUrlIncludes.trim() }
                        : {}),
                      ...(actionWaitForTitleIncludes.trim()
                        ? { titleIncludes: actionWaitForTitleIncludes.trim() }
                        : {}),
                      timeoutMs:
                        Number.parseInt(actionWaitForTimeoutMs || '0', 10) || 0,
                      pollIntervalMs:
                        Number.parseInt(actionWaitForPollMs || '0', 10) || 0,
                    }
                : {
                    kind: actionKind,
                    ...(actionTargetMode === 'selector'
                      ? { selector: actionSelector }
                      : { ref: actionRef }),
                  };

      const result = await requestJson<BrowserActionResult>(
        buildApiUrl(apiBase, '/api/browser/act'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetId: selectedTargetId,
            action,
          }),
        },
      );
      if (isSnapshotMutatingAction(actionKind)) {
        setSnapshotStale((current) => current || Boolean(snapshot));
        setRoleSnapshotStale((current) => current || Boolean(roleSnapshot));
        setScreenshotStale((current) => current || Boolean(screenshot));
        setLogsStale((current) => current || Boolean(logs));
      }
      await refreshBrowserState(true);
      const message = formatActionFeedback(actionKind, result, t);
      if (isSnapshotMutatingAction(actionKind)) {
        return `${message} | ${t('status.snapshotStale')}`;
      }
      return message;
    }, t('status.actionExecuted'));

  const screenshotSrc = useMemo(() => {
    if (!screenshot?.data) return '';
    return `data:${screenshot.mimeType};base64,${screenshot.data}`;
  }, [screenshot]);

  return (
    <div className="settings-section browser-control-panel">
      <div className="section-header browser-control-header">
        <div>
          <h3>{t('panel.title')}</h3>
          <p className="settings-hint">
            {t('panel.description')}
          </p>
        </div>
        <div className="browser-control-header-actions">
          <button
            className="btn-outline btn-sm"
            onClick={() => void refreshBrowserState()}
            disabled={loadingState || mutating}
          >
            {loadingState ? t('panel.refreshing') : t('panel.refresh')}
          </button>
          <button
            className="btn-primary btn-sm"
            onClick={() => void handleStart()}
            disabled={mutating || status?.running}
          >
            {status?.connectionMode === 'connect' ? t('panel.connect') : t('panel.start')}
          </button>
          <button
            className="btn-danger btn-sm"
            onClick={() => void handleStop()}
            disabled={mutating || !status?.running}
          >
            {status?.connectionMode === 'connect' ? t('panel.disconnect') : t('panel.stop')}
          </button>
        </div>
      </div>

      <div className="browser-control-summary-grid">
        <div className="config-info">
          <p>
            {t('panel.browserControl')} <strong>{status?.enabled ? t('panel.enabled') : t('panel.disabled')}</strong>
          </p>
          <p>
            {t('panel.runState')} <strong>{status?.running ? t('panel.running') : t('panel.notRunning')}</strong>
          </p>
          <p>
            {t('panel.connectionMode')}{' '}
            <strong>
              {status?.connectionMode === 'connect' ? t('panel.attachExisting') : t('panel.managedBrowser')}
            </strong>
          </p>
          <p>
            {t('panel.headless')} <strong>{status?.headless ? t('panel.yes') : t('panel.no')}</strong>
          </p>
          <p>
            {t('panel.debugPort')} <strong>{status?.debugPort ?? '-'}</strong>
          </p>
        </div>
        <div className="config-info">
          <p>
            {t('panel.currentTabs')} <strong>{tabs.length}</strong>
          </p>
          <p>
            {t('panel.recentTarget')} <strong>{status?.lastTargetId || '-'}</strong>
          </p>
          <p>
            {t('panel.startTime')} <strong>{formatTimestamp(status?.startedAt)}</strong>
          </p>
          <p>
            {t('panel.debugAddress')} <strong>{status?.remoteDebugUrl || '-'}</strong>
          </p>
          <p>
            {t('panel.executable')}{' '}
            <strong>{status?.resolvedExecutablePath || status?.executablePath || '-'}</strong>
          </p>
        </div>
      </div>

      <div className="config-info browser-control-callout">
        <p>
          {t('panel.mcpHint')}
        </p>
        <p>
          {t('panel.snapshotHint')}
        </p>
      </div>

      {!status?.enabled ? (
        <div className="test-result error">
          {t('panel.notEnabled')}
        </div>
      ) : null}

      {status?.lastError ? (
        <div className="test-result error">{status.lastError}</div>
      ) : null}

      {feedback ? (
        <div className={`test-result ${feedback.tone}`}>{feedback.text}</div>
      ) : null}

      <div className="settings-subsection browser-control-subsection">
        <div className="browser-control-toolbar">
          <div className="form-group">
            <label>{t('panel.openNewTab')}</label>
            <div className="browser-control-inline">
              <input
                value={openUrlDraft}
                onChange={(event) => setOpenUrlDraft(event.target.value)}
                placeholder="https://example.com"
              />
              <button
                className="btn-primary btn-sm"
                onClick={() => void handleOpenTab()}
                disabled={mutating || !status?.enabled}
              >
                {t('panel.open')}
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>{t('panel.currentTab')}</label>
            <AppSelect
              value={selectedTargetId}
              onChange={setSelectedTargetId}
              options={tabOptions}
              placeholder={tabs.length > 0 ? t('panel.selectTab') : t('panel.noTabs')}
              ariaLabel={t('panel.currentTab')}
              searchable
              searchPlaceholder={t('panel.filterByTitleUrl')}
              searchAriaLabel={t('panel.filterTabs')}
              disabled={tabs.length === 0}
            />
          </div>

          <div className="browser-control-inline browser-control-inline-actions">
            <button
              className="btn-outline btn-sm"
              onClick={() => void handleLoadSnapshot()}
              disabled={!selectedTargetId || snapshotLoading}
            >
              {snapshotLoading ? t('panel.reading') : t('panel.readSnapshot')}
            </button>
            <button
              className="btn-outline btn-sm"
              onClick={() => void handleLoadSnapshot(true)}
              disabled={!selectedTargetId || snapshotLoading}
            >
              {snapshotLoading ? t('panel.reading') : t('panel.forceRefreshSnapshot')}
            </button>
            <button
              className="btn-outline btn-sm"
              onClick={() => void handleLoadRoleSnapshot()}
              disabled={!selectedTargetId || roleSnapshotLoading}
            >
              {roleSnapshotLoading ? t('panel.reading') : t('panel.readRoleSnapshot')}
            </button>
            <button
              className="btn-outline btn-sm"
              onClick={() => void handleLoadRoleSnapshot(true)}
              disabled={!selectedTargetId || roleSnapshotLoading}
            >
              {roleSnapshotLoading ? t('panel.reading') : t('panel.forceRefreshRole')}
            </button>
            <button
              className="btn-outline btn-sm"
              onClick={() => void handleLoadScreenshot()}
              disabled={!selectedTargetId || screenshotLoading}
            >
              {screenshotLoading ? t('panel.capturing') : t('panel.browserScreenshot')}
            </button>
            <button
              className="btn-outline btn-sm"
              onClick={() => void handleLoadLogs()}
              disabled={!selectedTargetId || logsLoading}
            >
              {logsLoading ? t('panel.reading') : t('panel.readLogs')}
            </button>
          </div>
        </div>

        <div className="browser-control-action-grid">
          <div className="form-group">
            <label>{t('panel.actionType')}</label>
            <AppSelect
              value={actionKind}
              onChange={(nextValue) => setActionKind(nextValue as BrowserActionKind)}
              options={ACTION_KIND_OPTIONS}
              ariaLabel={t('panel.actionType')}
            />
          </div>

          {(actionKind === 'click' ||
            actionKind === 'hover' ||
            actionKind === 'scrollIntoView' ||
            actionKind === 'type') && (
            <div className="form-group">
              <label>{t('panel.targetMethod')}</label>
              <AppSelect
                value={actionTargetMode}
                onChange={(nextValue) =>
                  setActionTargetMode(nextValue as 'ref' | 'selector')
                }
                options={ACTION_TARGET_MODE_OPTIONS}
                ariaLabel={t('panel.targetMethod')}
              />
            </div>
          )}

          {(actionKind === 'click' ||
            actionKind === 'hover' ||
            actionKind === 'scrollIntoView' ||
            actionKind === 'type') &&
            actionTargetMode === 'ref' && (
              <div className="form-group">
                <label>{t('panel.targetRef')}</label>
                <AppSelect
                  value={actionRef}
                  onChange={setActionRef}
                  options={actionableNodeOptions}
                  placeholder={t('panel.selectRefFirst')}
                  ariaLabel={t('panel.targetRef')}
                  searchable
                  searchPlaceholder={t('panel.filterByRefRole')}
                  searchAriaLabel={t('panel.filterTargetRef')}
                  disabled={actionableNodeOptions.length === 0}
                />
              </div>
            )}

          {(actionKind === 'click' ||
            actionKind === 'hover' ||
            actionKind === 'scrollIntoView' ||
            actionKind === 'type') &&
            actionTargetMode === 'selector' && (
              <div className="form-group">
                <label>{t('panel.cssSelector')}</label>
                <input
                  value={actionSelector}
                  onChange={(event) => setActionSelector(event.target.value)}
                  placeholder="#search / button[type=submit]"
                />
              </div>
            )}

          {actionKind === 'navigate' && (
            <div className="form-group">
              <label>{t('panel.targetUrl')}</label>
              <input
                value={actionUrlDraft}
                onChange={(event) => setActionUrlDraft(event.target.value)}
                placeholder="https://example.com"
              />
            </div>
          )}

          {actionKind === 'type' && (
            <div className="form-group">
              <label>{t('panel.inputText')}</label>
              <input
                value={actionText}
                onChange={(event) => setActionText(event.target.value)}
                placeholder="hello world"
              />
            </div>
          )}

          {actionKind === 'press' && (
            <div className="form-group">
              <label>{t('panel.key')}</label>
              <input
                value={actionKey}
                onChange={(event) => setActionKey(event.target.value)}
                placeholder="Enter / Ctrl+L / Cmd+R"
              />
            </div>
          )}

          {actionKind === 'wait' && (
            <div className="form-group">
              <label>{t('panel.waitMs')}</label>
              <input
                value={actionWaitMs}
                onChange={(event) => setActionWaitMs(event.target.value)}
                placeholder="1000"
              />
            </div>
          )}

          {actionKind === 'waitFor' && (
            <div className="form-group">
              <label>{t('panel.waitSelector')}</label>
              <input
                value={actionWaitForSelector}
                onChange={(event) => setActionWaitForSelector(event.target.value)}
                placeholder="#result / .toast-success"
              />
            </div>
          )}

          {actionKind === 'waitFor' && (
            <div className="form-group">
              <label>{t('panel.urlContains')}</label>
              <input
                value={actionWaitForUrlIncludes}
                onChange={(event) => setActionWaitForUrlIncludes(event.target.value)}
                placeholder="/dashboard / success=true"
              />
            </div>
          )}

          {actionKind === 'waitFor' && (
            <div className="form-group">
              <label>{t('panel.titleContains')}</label>
              <input
                value={actionWaitForTitleIncludes}
                onChange={(event) => setActionWaitForTitleIncludes(event.target.value)}
                placeholder="已完成 / Dashboard"
              />
            </div>
          )}

          {actionKind === 'waitFor' && (
            <div className="form-group">
              <label>{t('panel.timeoutMs')}</label>
              <input
                value={actionWaitForTimeoutMs}
                onChange={(event) => setActionWaitForTimeoutMs(event.target.value)}
                placeholder="10000"
              />
            </div>
          )}

          {actionKind === 'waitFor' && (
            <div className="form-group">
              <label>{t('panel.pollIntervalMs')}</label>
              <input
                value={actionWaitForPollMs}
                onChange={(event) => setActionWaitForPollMs(event.target.value)}
                placeholder="250"
              />
            </div>
          )}

          <div className="browser-control-action-submit">
            <button
              className="btn-primary"
              onClick={() => void handleRunAction()}
              disabled={
                mutating ||
                !selectedTargetId ||
                ((actionKind === 'click' ||
                  actionKind === 'hover' ||
                  actionKind === 'scrollIntoView') &&
                  (actionTargetMode === 'selector'
                    ? !actionSelector.trim()
                    : !actionRef)) ||
                (actionKind === 'type' &&
                  ((actionTargetMode === 'selector'
                    ? !actionSelector.trim()
                    : !actionRef) ||
                    !actionText)) ||
                (actionKind === 'navigate' && !actionUrlDraft.trim()) ||
                (actionKind === 'press' && !actionKey.trim()) ||
                (actionKind === 'waitFor' &&
                  !actionWaitForSelector.trim() &&
                  !actionWaitForUrlIncludes.trim() &&
                  !actionWaitForTitleIncludes.trim())
              }
            >
              {mutating ? t('panel.executing') : t('panel.executeAction')}
            </button>
          </div>
        </div>
      </div>

      <div className="browser-tab-list">
        {tabs.map((tab) => (
          <div
            key={tab.targetId}
            className={`browser-tab-card ${tab.targetId === selectedTargetId ? 'active' : ''}`}
          >
            <div className="browser-tab-copy">
              <div className="browser-tab-title">{tab.title || '(untitled)'}</div>
              <div className="settings-hint browser-tab-url">{tab.url || 'about:blank'}</div>
              <div className="settings-hint browser-tab-meta">
                ID: {tab.targetId} &middot; {tab.active ? t('panel.foreground') : t('panel.background')} &middot;{' '}
                {tab.attached ? t('panel.attached') : t('panel.detached')}
              </div>
            </div>
            <div className="browser-tab-actions">
              <button
                className="btn-outline btn-sm"
                onClick={() => void handleFocusTab(tab.targetId)}
                disabled={mutating}
              >
                {t('panel.focus')}
              </button>
              <button
                className="btn-danger btn-sm"
                onClick={() => void handleCloseTab(tab.targetId)}
                disabled={mutating}
              >
                {t('panel.close')}
              </button>
            </div>
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="provider-empty">{t('panel.noTabsAvailable')}</div>
        )}
      </div>

      {activeTab ? (
        <div className="browser-control-assets">
          <details className="settings-advanced-block" open>
            <summary className="settings-advanced-summary">
              <span className="settings-advanced-title">{t('panel.pageSnapshot')}</span>
              <span className="settings-advanced-meta">
                {snapshot
                  ? `${snapshot.nodes.length} nodes / ${snapshot.frames.length} frames${snapshotStale ? ` · ${t('panel.stale')}` : ''}`
                  : t('panel.notRead')}
              </span>
            </summary>
            <div className="settings-advanced-content">
              {snapshot ? (
                <>
                  <div className="settings-hint">
                    {t('panel.currentPage')} <strong>{snapshot.title || '(untitled)'}</strong> &middot;{' '}
                    {snapshot.url || 'about:blank'}
                  </div>
                  <div className="browser-snapshot-meta">
                    <span>
                      {t('panel.cache')} <strong>{formatCacheState(snapshot.cacheHit, t)}</strong>
                    </span>
                    <span>
                      {t('panel.captureTime')} <strong>{formatTimestamp(snapshot.capturedAt)}</strong>
                    </span>
                    <span>
                      {t('panel.pageVersion')} <strong>{snapshot.pageVersion || '-'}</strong>
                    </span>
                    <span>
                      {t('panel.localState')} <strong>{snapshotStale ? t('panel.stale') : t('panel.fresh')}</strong>
                    </span>
                  </div>
                  {snapshotStale ? (
                    <div className="browser-snapshot-stale">
                      {t('panel.staleWarning')}
                    </div>
                  ) : null}
                  <div className="browser-node-list">
                    {snapshot.nodes.slice(0, 80).map((node) => (
                      <button
                        key={node.ref}
                        type="button"
                        className={`browser-node-row ${node.actionable ? 'actionable' : ''} ${actionRef === node.ref ? 'selected' : ''}`}
                        onClick={() => {
                          if (node.actionable) {
                            setActionRef(node.ref);
                          }
                        }}
                        disabled={!node.actionable}
                      >
                        <span className="browser-node-ref">{node.ref}</span>
                        <span className="browser-node-role">{node.role || 'node'}</span>
                        <span className="browser-node-name">
                          {node.name || node.value || node.description || '(unnamed)'}
                        </span>
                      </button>
                    ))}
                  </div>
                  {snapshot.nodes.length > 80 ? (
                    <div className="settings-hint">
                      {t('panel.onlyFirst80')}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="settings-hint">
                  {t('panel.readSnapshotFirst')}
                </div>
              )}
            </div>
          </details>

          <details className="settings-advanced-block" open>
            <summary className="settings-advanced-summary">
              <span className="settings-advanced-title">{t('panel.roleSnapshot')}</span>
              <span className="settings-advanced-meta">
                {roleSnapshot
                  ? `${roleSnapshot.stats.refs} refs / ${roleSnapshot.stats.lines} lines${roleSnapshotStale ? ` · ${t('panel.stale')}` : ''}`
                  : t('panel.notRead')}
              </span>
            </summary>
            <div className="settings-advanced-content">
              {roleSnapshot ? (
                <>
                  <div className="settings-hint">
                    {t('panel.roleSnapshotHint')}
                  </div>
                  <div className="browser-snapshot-meta">
                    <span>
                      {t('panel.cache')} <strong>{formatCacheState(roleSnapshot.cacheHit, t)}</strong>
                    </span>
                    <span>
                      {t('panel.captureTime')} <strong>{formatTimestamp(roleSnapshot.capturedAt)}</strong>
                    </span>
                    <span>
                      {t('panel.pageVersion')} <strong>{roleSnapshot.pageVersion || '-'}</strong>
                    </span>
                    <span>
                      {t('panel.truncated')} <strong>{roleSnapshot.truncated ? t('panel.yes') : t('panel.no')}</strong>
                    </span>
                    <span>
                      {t('panel.localState')} <strong>{roleSnapshotStale ? t('panel.stale') : t('panel.fresh')}</strong>
                    </span>
                  </div>
                  {roleSnapshotStale ? (
                    <div className="browser-snapshot-stale">
                      {t('panel.staleRoleWarning')}
                    </div>
                  ) : null}
                  {roleSnapshot.truncated ? (
                    <div className="settings-hint browser-role-snapshot-note">
                      {t('panel.truncatedHint')}
                    </div>
                  ) : null}
                  <pre className="browser-role-snapshot">{roleSnapshot.snapshot}</pre>
                </>
              ) : (
                <div className="settings-hint">
                  {t('panel.readRoleSnapshotHint')}
                </div>
              )}
            </div>
          </details>

          <details className="settings-advanced-block" open>
            <summary className="settings-advanced-summary">
              <span className="settings-advanced-title">{t('panel.screenshot')}</span>
              <span className="settings-advanced-meta">
                {screenshot ? screenshot.mimeType : t('panel.notCaptured')}
              </span>
            </summary>
            <div className="settings-advanced-content">
              {screenshotSrc ? (
                <div className="browser-screenshot-shell">
                  <img
                    src={screenshotSrc}
                    alt={screenshot?.title || 'Browser screenshot'}
                    className="browser-screenshot-image"
                  />
                </div>
              ) : (
                <div className="settings-hint">
                  {t('panel.screenshotHint')}
                </div>
              )}
              {screenshot && screenshotStale ? (
                <div className="settings-hint browser-screenshot-stale">
                  {t('panel.screenshotStale')}
                </div>
              ) : null}
            </div>
          </details>

          <details className="settings-advanced-block" open>
            <summary className="settings-advanced-summary">
              <span className="settings-advanced-title">{t('panel.browserLogs')}</span>
              <span className="settings-advanced-meta">
                {logs
                  ? `${logs.console.length} console / ${logs.errors.length} errors${logsStale ? ` · ${t('panel.stale')}` : ''}`
                  : t('panel.notRead')}
              </span>
            </summary>
            <div className="settings-advanced-content">
              {logs ? (
                <>
                  <div className="settings-hint">
                    {t('panel.logsHint')}
                  </div>
                  {logsStale ? (
                    <div className="browser-snapshot-stale">
                      {t('panel.logsStale')}
                    </div>
                  ) : null}
                  <div className="browser-log-grid">
                    <div className="browser-log-card">
                      <div className="browser-log-title">Console</div>
                      {logs.console.length > 0 ? (
                        <pre className="browser-role-snapshot browser-log-pre">
                          {logs.console
                            .map((entry) =>
                              [
                                `[${formatTimestamp(entry.timestamp)}]`,
                                `[${entry.level}]`,
                                entry.text,
                                entry.url
                                  ? `(${entry.url}${typeof entry.lineNumber === 'number' ? `:${entry.lineNumber}` : ''})`
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' '),
                            )
                            .join('\n')}
                        </pre>
                      ) : (
                        <div className="settings-hint">{t('panel.noConsole')}</div>
                      )}
                    </div>
                    <div className="browser-log-card">
                      <div className="browser-log-title">Errors</div>
                      {logs.errors.length > 0 ? (
                        <pre className="browser-role-snapshot browser-log-pre">
                          {logs.errors
                            .map((entry) =>
                              [
                                `[${formatTimestamp(entry.timestamp)}]`,
                                entry.message,
                                entry.description ? `(${entry.description})` : '',
                                entry.url
                                  ? `@ ${entry.url}${typeof entry.lineNumber === 'number' ? `:${entry.lineNumber}` : ''}`
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' '),
                            )
                            .join('\n')}
                        </pre>
                      ) : (
                        <div className="settings-hint">{t('panel.noErrors')}</div>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="settings-hint">
                  {t('panel.readLogsHint')}
                </div>
              )}
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}
