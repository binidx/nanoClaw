import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TabBar } from '../components/common/TabBar';
import { NcSelect } from '../components/common/NcSelect';
import { CodeMapGraphView } from '../components/code-map/CodeMapGraphView';
import { CodeMapAnalysisView } from '../components/code-map/CodeMapAnalysisView';
import { CodeMapRepoOverview } from '../components/code-map/CodeMapRepoOverview';
import { CodeIndexSearchView } from '../components/code-map/CodeIndexSearchView';
import { ProjectQaView } from '../components/code-map/ProjectQaView';
import type {
  CodeMapSnapshot,
  CodeMapStats,
  CodeMapFile,
  CodeMapEdge,
  CodeIndexFileDetail,
  CodeIndexMeta,
  CodeIndexProgress,
  CodeIndexFunctionDepsResponse,
} from '../components/code-map/code-map-api';
import {
  fetchCodeMap,
  fetchCodeMapStats,
  fetchCodeIndexFileDetail,
  fetchCodeIndexStatus,
  fetchAiSummary,
  fetchCodeIndexFunctionDeps,
  listCodeIndexFunctions,
  rebuildCodeMap,
  rebuildCodeIndex,
  KIND_LABELS,
  KIND_COLORS,
} from '../components/code-map/code-map-api';
import { fetchRepoReviewRemoteBranches } from '../components/repo-review/api';
import '../components/code-map/code-map.css';
import './CodeMapPage.css';

function labelSummarySource(
  source: 'fallback' | 'ai' | 'cache',
  t: (key: string) => string,
): string {
  switch (source) {
    case 'ai':
      return t('search.aiSummary');
    case 'cache':
      return t('search.cacheReuse');
    default:
      return t('search.ruleFallback');
  }
}

function labelCodeIndexSourceKind(
  sourceKind:
    | 'remote_worktree'
    | 'mirror'
    | 'workspace'
    | 'unknown'
    | undefined,
  t: (key: string) => string,
): string {
  switch (sourceKind) {
    case 'remote_worktree':
      return t('auto.1f3a71ae');
    case 'mirror':
      return t('auto.dc5b659f');
    case 'workspace':
      return t('auto.df3cc228');
    default:
      return t('auto.36cead0e');
  }
}

export interface CodeMapPageProps {
  apiBase: string;
  repositoryIdProp?: string;
  branchProp?: string;
  repoNameProp?: string;
  onClose?: () => void;
  embedded?: boolean;
  onNavigateBack?: () => void;
}

type ViewTab =
  | 'overview'
  | 'graph'
  | 'analysis'
  | 'detail'
  | 'search'
  | 'qa'
  | 'text';

export function CodeMapPage({
  apiBase,
  repositoryIdProp,
  branchProp,
  repoNameProp,
  onClose,
  embedded,
  onNavigateBack,
}: CodeMapPageProps) {
  const { t } = useTranslation('codeMap');
  const location = useLocation();
  const navigate = useNavigate();

  const repositoryId =
    repositoryIdProp || location.pathname.split('/')[2] || '';
  const searchParams = new URLSearchParams(location.search);
  const branchParam = branchProp || searchParams.get('branch') || 'main';
  const repoName = repoNameProp || searchParams.get('name') || repositoryId;

  const [branch, setBranch] = useState(branchParam);
  const [availableBranches, setAvailableBranches] = useState<string[]>([
    branchParam,
  ]);
  const [snapshot, setSnapshot] = useState<CodeMapSnapshot | null>(null);
  const [stats, setStats] = useState<CodeMapStats | null>(null);
  const [codeIndexMeta, setCodeIndexMeta] = useState<CodeIndexMeta | null>(
    null,
  );
  const [codeIndexProgress, setCodeIndexProgress] =
    useState<CodeIndexProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [enhancingIndex, setEnhancingIndex] = useState(false);
  const [codeIndexConcurrency, setCodeIndexConcurrency] = useState('2');
  const [savingCodeIndexConcurrency, setSavingCodeIndexConcurrency] =
    useState(false);
  const [notBuilt, setNotBuilt] = useState(false);
  const [error, setError] = useState('');
  const [viewTab, setViewTab] = useState<ViewTab>('overview');
  const [searchQuery, setSearchQuery] = useState('');
  const [scopeDir, setScopeDir] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [overviewCollapsed, setOverviewCollapsed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadCodeMap = useCallback(
    async (b: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError('');
      setNotBuilt(false);
      try {
        const result = await fetchCodeMap(apiBase, repositoryId, b);
        if (ctrl.signal.aborted) return;
        if (result.snapshot) {
          setSnapshot(result.snapshot);
          setNotBuilt(false);
        } else if (result.status === 'building') {
          setError(t('panel.buildingInProcess'));
        } else {
          setNotBuilt(true);
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setError(err instanceof Error ? err.message : t('panel.loadFailed'));
          setNotBuilt(true);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [apiBase, repositoryId, t],
  );

  const loadStats = useCallback(
    async (b: string) => {
      try {
        const s = await fetchCodeMapStats(apiBase, repositoryId, b);
        setStats(s);
      } catch {
        /* ignore */
      }
    },
    [apiBase, repositoryId],
  );

  const loadCodeIndexStatus = useCallback(
    async (b: string) => {
      try {
        const status = await fetchCodeIndexStatus(apiBase, repositoryId, b);
        setCodeIndexMeta(status.meta);
        setCodeIndexProgress(status.progress);
      } catch {
        setCodeIndexMeta(null);
        setCodeIndexProgress(null);
      }
    },
    [apiBase, repositoryId],
  );

  const handleRebuild = useCallback(async () => {
    setRebuilding(true);
    setError('');
    try {
      await rebuildCodeMap(apiBase, repositoryId, branch);
      await loadCodeMap(branch);
      await loadCodeIndexStatus(branch);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('panel.buildFailed'));
    } finally {
      setRebuilding(false);
    }
  }, [apiBase, repositoryId, branch, loadCodeMap, loadCodeIndexStatus, t]);

  const handleAiEnhanceIndex = useCallback(async () => {
    setEnhancingIndex(true);
    setError('');
    try {
      await rebuildCodeIndex(apiBase, repositoryId, branch, {
        enableAiSummaries: true,
        enableEmbeddings: true,
        summaryConcurrency: Number(codeIndexConcurrency) || 2,
      });
      await loadCodeIndexStatus(branch);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('panel.buildFailed'));
    } finally {
      setEnhancingIndex(false);
    }
  }, [
    apiBase,
    repositoryId,
    branch,
    codeIndexConcurrency,
    loadCodeIndexStatus,
    t,
  ]);

  const handleSaveCodeIndexConcurrency = useCallback(async () => {
    const normalized = String(
      Math.max(1, Math.min(16, Number(codeIndexConcurrency) || 2)),
    );
    setSavingCodeIndexConcurrency(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ CODE_INDEX_LLM_CONCURRENCY: normalized }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error || `HTTP ${res.status}`,
        );
      }
      setCodeIndexConcurrency(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('panel.buildFailed'));
    } finally {
      setSavingCodeIndexConcurrency(false);
    }
  }, [apiBase, codeIndexConcurrency, t]);

  useEffect(() => {
    if (!repositoryId) return;
    void loadCodeMap(branch);
    void loadStats(branch);
    void loadCodeIndexStatus(branch);
    return () => abortRef.current?.abort();
  }, [branch, repositoryId, loadCodeMap, loadStats, loadCodeIndexStatus]);

  useEffect(() => {
    if (!repositoryId || codeIndexProgress?.status !== 'building') return;
    const timer = window.setInterval(() => {
      void loadCodeIndexStatus(branch);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [repositoryId, branch, codeIndexProgress?.status, loadCodeIndexStatus]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/config`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (cancelled || !data) return;
        const raw = String(data.CODE_INDEX_LLM_CONCURRENCY ?? '2').trim();
        setCodeIndexConcurrency(raw || '2');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  useEffect(() => {
    setScopeDir(null);
  }, [branch]);

  useEffect(() => {
    if (!repositoryId) return;
    let cancelled = false;
    fetchRepoReviewRemoteBranches(apiBase, repositoryId)
      .then((list) => {
        if (cancelled) return;
        const names = list.map((b) => b.name);
        if (names.length > 0) setAvailableBranches(names);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiBase, repositoryId]);

  const filteredFiles = useMemo(() => {
    if (!snapshot) return [];
    let files = snapshot.files;
    if (scopeDir) {
      const scopePaths = new Set(
        files
          .filter((f) => f.relativePath.startsWith(scopeDir + '/'))
          .map((f) => f.relativePath),
      );
      const visiblePaths = new Set(scopePaths);
      for (const e of snapshot.edges) {
        if (scopePaths.has(e.fromFile)) visiblePaths.add(e.toFile);
        if (scopePaths.has(e.toFile)) visiblePaths.add(e.fromFile);
      }
      files = files.filter((f) => visiblePaths.has(f.relativePath));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      files = files.filter(
        (f) =>
          f.relativePath.toLowerCase().includes(q) ||
          f.symbols.some(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              s.signature.toLowerCase().includes(q),
          ),
      );
    }
    return files;
  }, [snapshot, searchQuery, scopeDir]);

  const filteredEdges = useMemo(() => {
    if (!snapshot) return [];
    const fileSet = new Set(filteredFiles.map((f) => f.relativePath));
    const hasFilter = scopeDir !== null || searchQuery.trim().length > 0;
    if (!hasFilter) return snapshot.edges;
    return snapshot.edges.filter(
      (e) => fileSet.has(e.fromFile) && fileSet.has(e.toFile),
    );
  }, [snapshot, filteredFiles, scopeDir, searchQuery]);

  const selectedFileData = useMemo(() => {
    if (!snapshot || !selectedFile) return null;
    return snapshot.files.find((f) => f.relativePath === selectedFile) || null;
  }, [snapshot, selectedFile]);

  const relatedEdges = useMemo(() => {
    if (!snapshot || !selectedFile) return [];
    return snapshot.edges.filter(
      (e) => e.fromFile === selectedFile || e.toFile === selectedFile,
    );
  }, [snapshot, selectedFile]);

  const handleSelectFile = useCallback((path: string | null) => {
    setSelectedFile(path);
  }, []);

  if (!repositoryId) {
    return (
      <div className="codemap-page">
        <div className="codemap-page-empty">
          <p>{t('auto.b96db51a')}</p>
          <button
            className="btn btn-primary"
            onClick={() =>
              onNavigateBack
                ? onNavigateBack()
                : onClose
                  ? onClose()
                  : navigate('/repos')
            }
          >
            {t('auto.5f411223')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`codemap-page${embedded ? ' codemap-embedded' : ''}`}>
      {/* Header */}
      <header className="codemap-header">
        <div className="codemap-header-left">
          {!embedded && (
            <button
              className="codemap-back-btn"
              onClick={() =>
                onNavigateBack
                  ? onNavigateBack()
                  : onClose
                    ? onClose()
                    : navigate('/repos')
              }
              title={t('auto.5f411223')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M10 12L6 8l4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          {!embedded && (
            <h1 className="codemap-repo-name" title={repoName}>
              {repoName}
            </h1>
          )}
          <span className="codemap-branch-select-wrap">
            <NcSelect
              className="codemap-branch-select"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              aria-label={t('auto.ec0152ae')}
            >
              {availableBranches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </NcSelect>
          </span>
        </div>
        <div className="codemap-header-center">
          <div className="codemap-search-box">
            <input
              type="text"
              placeholder={t('panel.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="codemap-search-input"
            />
            {searchQuery ? (
              <button
                className="codemap-search-clear"
                onClick={() => setSearchQuery('')}
                type="button"
              >
                &times;
              </button>
            ) : (
              <svg
                className="codemap-search-icon"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
              >
                <circle
                  cx="7"
                  cy="7"
                  r="5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M11 11l3.5 3.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </div>
        </div>
        <div className="codemap-header-right">
          {stats && (
            <span className="codemap-stats-badge">
              {stats.fileCount} {t('auto.2a0c4740')} &middot;{' '}
              {stats.symbolCount} {t('auto.9eb729ff')} &middot;{' '}
              {stats.edgeCount} {t('auto.6860b943')}
            </span>
          )}
          {(codeIndexMeta || codeIndexProgress) && (
            <span
              className={`codemap-stats-badge codemap-index-badge codemap-index-${codeIndexProgress?.status || codeIndexMeta?.status || 'missing'}`}
            >
              {t('auto.b271e427')}{' '}
              {(codeIndexProgress?.status || codeIndexMeta?.status) === 'ready'
                ? t('auto.c30ecc7a')
                : (codeIndexProgress?.status || codeIndexMeta?.status) ===
                    'building'
                  ? t('auto.32493aee')
                  : codeIndexProgress?.status || codeIndexMeta?.status}
              {codeIndexMeta?.status === 'ready'
                ? ` · ${codeIndexMeta.stats.chunkCount} chunks`
                : ''}
            </span>
          )}
          {codeIndexMeta ? (
            <span className="codemap-stats-badge">
              {labelCodeIndexSourceKind(codeIndexMeta.sourceKind, t)}
              {codeIndexMeta.sourceHeadSha
                ? ` · ${codeIndexMeta.sourceHeadSha.slice(0, 10)}`
                : ''}
            </span>
          ) : null}
          {codeIndexMeta ? (
            <span className="codemap-stats-badge">
              {t('page.baseLabel')}{' '}
              {codeIndexMeta.baseReady
                ? t('auto.c30ecc7a')
                : t('auto.0a4782f3')}
              {' · '}
              {t('page.summaryLabel')}{' '}
              {codeIndexMeta.summaryReady
                ? t('auto.c30ecc7a')
                : t('auto.5d459d55')}
              {' · '}
              {t('page.vectorLabel')}{' '}
              {codeIndexMeta.embeddingsReady
                ? t('auto.c30ecc7a')
                : t('auto.0a4782f3')}
            </span>
          ) : null}
          {codeIndexProgress?.status === 'building' ? (
            <span className="codemap-stats-badge">
              {codeIndexProgress.stage} {codeIndexProgress.processedFiles}/
              {codeIndexProgress.totalFiles}
            </span>
          ) : null}
          <button
            className="codemap-rebuild-btn"
            onClick={handleRebuild}
            disabled={rebuilding}
          >
            {rebuilding ? t('panel.building') : t('静态更新')}
          </button>
          <button
            className="codemap-rebuild-btn codemap-ai-enhance-btn"
            onClick={handleAiEnhanceIndex}
            disabled={
              enhancingIndex || codeIndexProgress?.status === 'building'
            }
          >
            {enhancingIndex ? t('panel.building') : t('AI 增强')}
          </button>
        </div>
      </header>

      {(codeIndexProgress || codeIndexMeta) && (
        <section className="codemap-index-progress-panel">
          <div className="codemap-index-progress-head">
            <div>
              <strong>{t('代码索引')}</strong>
              <span>
                {codeIndexProgress?.message ||
                  codeIndexMeta?.stage ||
                  codeIndexMeta?.status}
              </span>
            </div>
            <label className="codemap-index-concurrency">
              <span>{t('AI 并发')}</span>
              <input
                type="number"
                min={1}
                max={16}
                value={codeIndexConcurrency}
                onChange={(event) =>
                  setCodeIndexConcurrency(
                    String(
                      Math.max(
                        1,
                        Math.min(16, Number(event.target.value) || 2),
                      ),
                    ),
                  )
                }
              />
              <button
                type="button"
                className="codemap-index-save-btn"
                onClick={handleSaveCodeIndexConcurrency}
                disabled={savingCodeIndexConcurrency}
              >
                {savingCodeIndexConcurrency ? t('保存中...') : t('保存')}
              </button>
            </label>
          </div>
          <div className="codemap-index-progress-bar">
            <div
              className="codemap-index-progress-fill"
              style={{
                width: `${Math.max(
                  0,
                  Math.min(
                    100,
                    codeIndexProgress?.totalFiles
                      ? (codeIndexProgress.processedFiles /
                          codeIndexProgress.totalFiles) *
                          100
                      : codeIndexMeta?.status === 'ready'
                        ? 100
                        : 0,
                  ),
                )}%`,
              }}
            />
          </div>
          <div className="codemap-index-progress-stats">
            <span>
              {t('阶段')}{' '}
              {codeIndexProgress?.stage || codeIndexMeta?.stage || '-'}
            </span>
            <span>
              {t('已处理')} {codeIndexProgress?.processedFiles ?? 0}/
              {codeIndexProgress?.totalFiles ??
                codeIndexMeta?.stats.fileCount ??
                0}
            </span>
            <span>
              {t('排队')} {codeIndexProgress?.queuedFiles ?? 0}
            </span>
            <span>
              {t('失败')} {codeIndexProgress?.failedFiles ?? 0}
            </span>
            <span>
              {t('本轮并发')}{' '}
              {codeIndexProgress?.concurrency ?? codeIndexConcurrency}
            </span>
          </div>
          {codeIndexProgress?.activeFiles?.length ? (
            <div className="codemap-index-active-files">
              {codeIndexProgress.activeFiles.slice(0, 4).map((file) => (
                <code key={file}>{file}</code>
              ))}
            </div>
          ) : null}
        </section>
      )}

      {scopeDir && (
        <nav className="codemap-breadcrumb" aria-label={t('auto.cd0d5969')}>
          <button
            type="button"
            className="codemap-breadcrumb-item"
            onClick={() => setScopeDir(null)}
          >
            {t('auto.99ef7b0d')}
          </button>
          {scopeDir.split('/').map((segment, i, arr) => {
            const pathUpTo = arr.slice(0, i + 1).join('/');
            return (
              <span key={pathUpTo} className="codemap-breadcrumb-fragment">
                <span className="codemap-breadcrumb-separator" aria-hidden>
                  /
                </span>
                <button
                  type="button"
                  className="codemap-breadcrumb-item"
                  onClick={() => setScopeDir(pathUpTo)}
                >
                  {segment}
                </button>
              </span>
            );
          })}
          <button
            type="button"
            className="codemap-breadcrumb-clear"
            onClick={() => setScopeDir(null)}
            title={t('auto.346c6222')}
            aria-label={t('auto.346c6222')}
          >
            &times;
          </button>
        </nav>
      )}

      {error && <div className="codemap-error">{error}</div>}

      {/* Not-built state */}
      {notBuilt && !loading && (
        <div className="codemap-not-built">
          <div className="codemap-not-built-inner">
            <svg
              width="48"
              height="48"
              viewBox="0 0 48 48"
              fill="none"
              opacity="0.4"
            >
              <rect
                x="6"
                y="6"
                width="36"
                height="36"
                rx="4"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M6 18h36M18 18v24"
                stroke="currentColor"
                strokeWidth="2"
              />
              <circle
                cx="30"
                cy="30"
                r="4"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
            <h3>{t('panel.notBuilt')}</h3>
            <p>
              {t('auto.213cf6f2')} <strong>{branch}</strong>{' '}
              {t('auto.e24f2f6b')}
            </p>
            <button
              className="btn btn-primary"
              onClick={handleRebuild}
              disabled={rebuilding}
            >
              {rebuilding ? t('panel.building') : t('panel.build')}
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && !snapshot && (
        <div className="codemap-loading">
          <div className="codemap-spinner" />
          <span>{t('panel.loading')}</span>
        </div>
      )}

      {/* Main body */}
      {snapshot && (
        <div className="codemap-body">
          {/* Left sidebar - file tree */}
          <aside
            className={`codemap-sidebar${sidebarCollapsed ? ' codemap-sidebar-collapsed' : ''}`}
          >
            <div className="codemap-sidebar-header">
              <span className="codemap-sidebar-title">
                {t('auto.6f3e7364')}
              </span>
              <button
                className="codemap-sidebar-toggle"
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                title={sidebarCollapsed ? t('page.expand') : t('auto.def9e98b')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  {sidebarCollapsed ? (
                    <path
                      d="M6 4l4 4-4 4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ) : (
                    <path
                      d="M10 4L6 8l4 4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                </svg>
              </button>
            </div>
            {!sidebarCollapsed && (
              <div className="codemap-sidebar-body">
                <SidebarTree
                  files={filteredFiles}
                  selectedFile={selectedFile}
                  onSelectFile={handleSelectFile}
                  onScopeDir={setScopeDir}
                />
              </div>
            )}
          </aside>

          {/* Main content */}
          <main className="codemap-main">
            <TabBar
              tabs={[
                { key: 'overview', label: t('overview.title') },
                { key: 'graph', label: t('panel.tab.graph') },
                { key: 'analysis', label: t('auto.ffd208bb') },
                { key: 'detail', label: t('auto.e6fc1cd7') },
                { key: 'search', label: t('search.semanticSearch') },
                { key: 'qa', label: t('qa.tab') },
                { key: 'text', label: t('panel.tab.text') },
              ]}
              activeKey={viewTab}
              onChange={(k) => setViewTab(k as ViewTab)}
              size="small"
            />

            <div className="codemap-main-content">
              {viewTab === 'overview' && (
                <div className="codemap-overview-tab">
                  <CodeMapRepoOverview
                    apiBase={apiBase}
                    repositoryId={repositoryId}
                    branch={branch}
                    collapsed={overviewCollapsed}
                    onToggleCollapse={() => setOverviewCollapsed((p) => !p)}
                  />
                </div>
              )}

              {viewTab === 'graph' && (
                <CodeMapGraphView
                  files={filteredFiles}
                  edges={filteredEdges}
                  selectedFile={selectedFile}
                  onSelectFile={handleSelectFile}
                  allFiles={snapshot?.files}
                  allEdges={snapshot?.edges}
                  viewScope={`${repositoryId}:${branch}`}
                />
              )}

              {viewTab === 'analysis' && (
                <CodeMapAnalysisView
                  apiBase={apiBase}
                  repositoryId={repositoryId}
                  branch={branch}
                  scopeDir={scopeDir}
                  selectedFile={selectedFile}
                />
              )}

              {viewTab === 'detail' && (
                <div className="codemap-detail-view">
                  {selectedFileData ? (
                    <FileDetailPanel
                      file={selectedFileData}
                      relatedEdges={relatedEdges}
                      onSelectFile={handleSelectFile}
                      apiBase={apiBase}
                      repositoryId={repositoryId}
                      branch={branch}
                    />
                  ) : (
                    <div className="codemap-detail-empty">
                      {t('auto.85c89b2e')}
                    </div>
                  )}
                </div>
              )}

              {viewTab === 'search' && (
                <CodeIndexSearchView
                  apiBase={apiBase}
                  repositoryId={repositoryId}
                  branch={branch}
                  onOpenFile={(filePath) => {
                    handleSelectFile(filePath);
                    setViewTab('detail');
                  }}
                />
              )}

              {viewTab === 'qa' && (
                <ProjectQaView
                  apiBase={apiBase}
                  repositoryId={repositoryId}
                  branch={branch}
                  selectedFile={selectedFile}
                  scopedFiles={filteredFiles.map((file) => file.relativePath)}
                  onOpenFile={(filePath) => {
                    handleSelectFile(filePath);
                    setViewTab('detail');
                  }}
                />
              )}

              {viewTab === 'text' && (
                <CodeMapTextView
                  apiBase={apiBase}
                  repositoryId={repositoryId}
                  branch={branch}
                />
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}

/* --- Sidebar Tree --- */

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  file?: CodeMapFile;
}

function buildTree(files: CodeMapFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] };
  for (const file of files) {
    const parts = file.relativePath.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      const nodePath = parts.slice(0, i + 1).join('/');
      let child = current.children.find((c) => c.name === name);
      if (!child) {
        child = {
          name,
          path: nodePath,
          isDir: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        current.children.push(child);
      }
      current = child;
    }
  }
  sortTree(root);
  return root;
}

function sortTree(node: TreeNode) {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) if (child.isDir) sortTree(child);
}

function countFiles(node: TreeNode): number {
  if (!node.isDir) return 1;
  return node.children.reduce((sum, c) => sum + countFiles(c), 0);
}

const LANG_ICON: Record<string, string> = {
  java: 'J',
  kotlin: 'K',
  typescript: 'T',
  javascript: 'J',
  python: 'P',
  go: 'G',
  rust: 'R',
  scala: 'S',
  c: 'C',
  cpp: 'C',
  csharp: 'C',
  ruby: 'R',
  swift: 'S',
  php: 'P',
  sql: 'Q',
  shell: '$',
  yaml: 'Y',
  json: '{',
};

function SidebarTree({
  files,
  selectedFile,
  onSelectFile,
  onScopeDir,
}: {
  files: CodeMapFile[];
  selectedFile: string | null;
  onSelectFile: (path: string | null) => void;
  onScopeDir: (path: string) => void;
}) {
  const { t } = useTranslation('codeMap');
  const tree = useMemo(() => buildTree(files), [files]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
    const set = new Set<string>();
    function autoExpand(node: TreeNode, depth: number) {
      if (node.isDir && depth < 2) {
        set.add(node.path);
        node.children.forEach((c) => autoExpand(c, depth + 1));
      }
    }
    autoExpand(tree, -1);
    return set;
  });

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    const set = new Set<string>();
    function walk(n: TreeNode) {
      if (n.isDir) {
        set.add(n.path);
        n.children.forEach(walk);
      }
    }
    walk(tree);
    setExpandedDirs(set);
  }, [tree]);

  const collapseAll = useCallback(() => setExpandedDirs(new Set()), []);

  useEffect(() => {
    if (!selectedFile) return;
    const parts = selectedFile.split('/');
    if (parts.length <= 1) return;
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      let path = '';
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        next.add(path);
      }
      return next;
    });
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-tree-file="${CSS.escape(selectedFile)}"]`,
      );
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [selectedFile]);

  if (files.length === 0) {
    return <div className="codemap-sidebar-empty">{t('auto.5f800760')}</div>;
  }

  return (
    <div className="codemap-tree">
      <div className="codemap-tree-actions">
        <button
          className="codemap-tree-action-btn"
          onClick={expandAll}
          title={t('auto.699371fa')}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          className="codemap-tree-action-btn"
          onClick={collapseAll}
          title={t('auto.450cb370')}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 10l4-4 4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      {tree.children.map((child) => (
        <SidebarTreeNode
          key={child.path}
          node={child}
          depth={0}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          onScopeDir={onScopeDir}
          expandedDirs={expandedDirs}
          toggleDir={toggleDir}
        />
      ))}
    </div>
  );
}

function SidebarTreeNode({
  node,
  depth,
  selectedFile,
  onSelectFile,
  onScopeDir,
  expandedDirs,
  toggleDir,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string | null) => void;
  onScopeDir: (path: string) => void;
  expandedDirs: Set<string>;
  toggleDir: (path: string) => void;
}) {
  const { t } = useTranslation('codeMap');
  const indent = depth * 16 + 8;

  if (node.isDir) {
    const expanded = expandedDirs.has(node.path);
    return (
      <div className="codemap-tree-dir">
        <div className="codemap-tree-dir-row">
          <button
            type="button"
            className="codemap-tree-dir-btn"
            style={{ paddingLeft: indent }}
            onClick={() => toggleDir(node.path)}
          >
            <span
              className={`codemap-tree-chevron${expanded ? ' codemap-tree-chevron-open' : ''}`}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path
                  d="M6 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="codemap-tree-dir-name">{node.name}</span>
            <span className="codemap-tree-count">{countFiles(node)}</span>
          </button>
          <button
            type="button"
            className="codemap-scope-btn"
            title={t('auto.ece90619')}
            aria-label={t('auto.ece90619')}
            onClick={(e) => {
              e.stopPropagation();
              onScopeDir(node.path);
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
            >
              <circle
                cx="6.5"
                cy="6.5"
                r="4.5"
                stroke="currentColor"
                strokeWidth="1.25"
              />
              <path
                d="M10 10l3.5 3.5"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        {expanded &&
          node.children.map((child) => (
            <SidebarTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              onScopeDir={onScopeDir}
              expandedDirs={expandedDirs}
              toggleDir={toggleDir}
            />
          ))}
      </div>
    );
  }

  const isSelected = selectedFile === node.path;
  const lang = node.file?.language || '';
  const langIcon = LANG_ICON[lang] || '';

  return (
    <button
      className={`codemap-tree-file-btn${isSelected ? ' codemap-tree-file-selected' : ''}`}
      style={{ paddingLeft: indent }}
      onClick={() => onSelectFile(isSelected ? null : node.path)}
      data-tree-file={node.path}
    >
      {langIcon && (
        <span className={`codemap-tree-lang-icon codemap-lang-${lang}`}>
          {langIcon}
        </span>
      )}
      <span className="codemap-tree-file-name">{node.name}</span>
      {(node.file?.symbols.length ?? 0) > 0 && (
        <span className="codemap-tree-sym-count">
          {node.file!.symbols.length}
        </span>
      )}
    </button>
  );
}

/* --- File Detail Panel --- */

function FileDetailPanel({
  file,
  relatedEdges,
  onSelectFile,
  apiBase,
  repositoryId,
  branch,
}: {
  file: CodeMapFile;
  relatedEdges: CodeMapEdge[];
  onSelectFile: (path: string | null) => void;
  apiBase: string;
  repositoryId: string;
  branch: string;
}) {
  const { t } = useTranslation('codeMap');
  const sortedSymbols = useMemo(
    () => [...file.symbols].sort((a, b) => b.rank - a.rank),
    [file],
  );
  const imports = relatedEdges.filter((e) => e.fromFile === file.relativePath);
  const importedBy = relatedEdges.filter((e) => e.toFile === file.relativePath);
  const [codeIndexDetail, setCodeIndexDetail] =
    useState<CodeIndexFileDetail | null>(null);
  const [codeIndexDetailError, setCodeIndexDetailError] = useState('');
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [selectedFunctionId, setSelectedFunctionId] = useState<string | null>(
    null,
  );
  const [functionDeps, setFunctionDeps] =
    useState<CodeIndexFunctionDepsResponse | null>(null);
  const [functionDepsLoading, setFunctionDepsLoading] = useState(false);
  const [functionDepsError, setFunctionDepsError] = useState('');
  const lastAiFileRef = useRef('');

  useEffect(() => {
    if (file.relativePath !== lastAiFileRef.current) {
      setAiSummary(null);
      setAiError('');
    }
    setCodeIndexDetail(null);
    setCodeIndexDetailError('');
    setSelectedFunctionId(null);
    setFunctionDeps(null);
    setFunctionDepsError('');
  }, [file.relativePath]);

  useEffect(() => {
    let cancelled = false;
    fetchCodeIndexFileDetail(apiBase, repositoryId, branch, file.relativePath)
      .then((detail) => {
        if (!cancelled) setCodeIndexDetail(detail);
      })
      .catch((err) => {
        if (!cancelled)
          setCodeIndexDetailError(
            err instanceof Error ? err.message : t('auto.d4ef9103'),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, repositoryId, branch, file.relativePath, t]);

  const handleAiSummary = useCallback(async () => {
    setAiLoading(true);
    setAiError('');
    lastAiFileRef.current = file.relativePath;
    try {
      const result = await fetchAiSummary(apiBase, repositoryId, branch, {
        filePath: file.relativePath,
      });
      setAiSummary(result.summary);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : t('auto.eecb2e77'));
    } finally {
      setAiLoading(false);
    }
  }, [apiBase, repositoryId, branch, file.relativePath, t]);

  const handleInspectFunctionDeps = useCallback(
    async (symbol: CodeMapFile['symbols'][number]) => {
      if (!['function', 'method', 'const', 'variable'].includes(symbol.kind))
        return;
      setFunctionDepsLoading(true);
      setFunctionDepsError('');
      try {
        const lookup = await listCodeIndexFunctions(
          apiBase,
          repositoryId,
          branch,
          {
            filePath: file.relativePath,
            query: symbol.name,
            line: symbol.line,
          },
        );
        const match =
          lookup.functions.find(
            (fn) => fn.name === symbol.name && fn.line === symbol.line,
          ) || lookup.functions[0];
        if (!match) {
          setFunctionDeps(null);
          setSelectedFunctionId(null);
          setFunctionDepsError(t('auto.33386cbd'));
          return;
        }
        const deps = await fetchCodeIndexFunctionDeps(
          apiBase,
          repositoryId,
          branch,
          match.id,
          2,
        );
        setSelectedFunctionId(match.id);
        setFunctionDeps(deps);
      } catch (err) {
        setFunctionDeps(null);
        setSelectedFunctionId(null);
        setFunctionDepsError(
          err instanceof Error ? err.message : t('auto.548481cb'),
        );
      } finally {
        setFunctionDepsLoading(false);
      }
    },
    [apiBase, repositoryId, branch, file.relativePath, t],
  );

  return (
    <div className="codemap-file-detail">
      <div className="codemap-file-header">
        <h3 className="codemap-file-path">{file.relativePath}</h3>
        <div className="codemap-file-meta">
          <span className="codemap-meta-tag">{file.language}</span>
          <span className="codemap-meta-tag">
            {file.lineCount} {t('auto.2d5aef4f')}
          </span>
          <span className="codemap-meta-tag">
            {file.symbols.length} {t('auto.9eb729ff')}
          </span>
          <span className="codemap-meta-tag">
            {file.importCount} {t('auto.8d9a071e')}
          </span>
        </div>
      </div>

      <section className="codemap-detail-section">
        <div className="codemap-ai-summary-header">
          <h4 className="codemap-section-title">{t('auto.0b582f43')}</h4>
          {codeIndexDetail?.file ? (
            <span className="codemap-summary-source-badge">
              {labelSummarySource(codeIndexDetail.file.summarySource, t)}
            </span>
          ) : null}
        </div>
        {codeIndexDetailError && (
          <div className="codemap-ai-error">{codeIndexDetailError}</div>
        )}
        {codeIndexDetail?.file?.summary ? (
          <div className="codemap-ai-content">
            {codeIndexDetail.file.summary}
          </div>
        ) : null}
        {codeIndexDetail?.chunks && codeIndexDetail.chunks.length > 0 ? (
          <div className="codemap-index-chunk-summary-list">
            {codeIndexDetail.chunks.map((chunk) => (
              <div key={chunk.id} className="codemap-index-chunk-summary-item">
                <div className="codemap-index-chunk-summary-top">
                  <strong>
                    Chunk {chunk.chunkIndex + 1} &middot; L{chunk.startLine}-
                    {chunk.endLine}
                  </strong>
                  <span>{labelSummarySource(chunk.summarySource, t)}</span>
                </div>
                <div className="codemap-index-chunk-summary-text">
                  {chunk.summary}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="codemap-detail-section">
        <div className="codemap-ai-summary-header">
          <h4 className="codemap-section-title">{t('auto.b3957620')}</h4>
          <button
            className="codemap-ai-btn"
            onClick={handleAiSummary}
            disabled={aiLoading}
          >
            {aiLoading
              ? t('analysis.analyzing')
              : aiSummary
                ? t('analysis.reanalyze')
                : t('analysis.generate')}
          </button>
        </div>
        {aiError && <div className="codemap-ai-error">{aiError}</div>}
        {aiSummary && <div className="codemap-ai-content">{aiSummary}</div>}
        {!aiSummary && !aiError && !aiLoading && (
          <div className="codemap-ai-hint">{t('auto.8d1ff316')}</div>
        )}
      </section>

      {sortedSymbols.length > 0 && (
        <section className="codemap-detail-section">
          <h4 className="codemap-section-title">{t('tree.symbolDefs')}</h4>
          <div className="codemap-symbol-list">
            {sortedSymbols.map((sym, i) => {
              const kindKey = Object.prototype.hasOwnProperty.call(
                KIND_LABELS,
                sym.kind,
              )
                ? sym.kind
                : 'unknown';
              const bg = KIND_COLORS[kindKey] || KIND_COLORS.unknown;
              const canInspectDeps = [
                'function',
                'method',
                'const',
                'variable',
              ].includes(sym.kind);
              return (
                <button
                  type="button"
                  key={`${sym.name}-${sym.line}-${i}`}
                  className={`codemap-symbol-item codemap-symbol-btn${selectedFunctionId && functionDeps?.focus?.line === sym.line && functionDeps.focus.name === sym.name ? ' codemap-symbol-item-active' : ''}`}
                  onClick={() => {
                    if (canInspectDeps) void handleInspectFunctionDeps(sym);
                  }}
                  disabled={!canInspectDeps || functionDepsLoading}
                >
                  <span
                    className="codemap-kind-badge"
                    style={{ backgroundColor: bg }}
                  >
                    {KIND_LABELS[kindKey]}
                  </span>
                  <code className="codemap-symbol-sig">{sym.signature}</code>
                  <span className="codemap-symbol-line">L{sym.line}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="codemap-detail-section">
        <h4 className="codemap-section-title">{t('auto.2ab55c60')}</h4>
        {functionDepsLoading ? (
          <div className="codemap-ai-hint">{t('auto.f317e968')}</div>
        ) : null}
        {!functionDepsLoading && functionDepsError ? (
          <div className="codemap-ai-error">{functionDepsError}</div>
        ) : null}
        {!functionDepsLoading && !functionDepsError && !functionDeps ? (
          <div className="codemap-ai-hint">{t('auto.9419b62e')}</div>
        ) : null}
        {!functionDepsLoading && functionDeps ? (
          <div className="codemap-function-deps">
            <div className="codemap-function-focus">
              <strong>{functionDeps.focus?.name}</strong>
              <span>
                {functionDeps.focus?.filePath}:L{functionDeps.focus?.line}
              </span>
            </div>
            <div className="codemap-function-dep-columns">
              <div className="codemap-function-dep-column">
                <div className="codemap-function-dep-heading">
                  {t('auto.c89cc99e')} ({functionDeps.upstream.length})
                </div>
                {functionDeps.upstream.length === 0 ? (
                  <div className="codemap-ai-hint">{t('auto.bb75d51f')}</div>
                ) : null}
                {functionDeps.upstream.map(({ edge, node }) => (
                  <button
                    type="button"
                    key={edge.id}
                    className="codemap-function-dep-item"
                    onClick={() => onSelectFile(node.filePath)}
                  >
                    <strong>{node.name}</strong>
                    <span>
                      {node.filePath}:L{node.line}
                    </span>
                    <span>
                      {t('auto.55b53a40')} L{edge.line}
                    </span>
                  </button>
                ))}
              </div>
              <div className="codemap-function-dep-column">
                <div className="codemap-function-dep-heading">
                  {t('auto.c2c032c4')} ({functionDeps.downstream.length})
                </div>
                {functionDeps.downstream.length === 0 ? (
                  <div className="codemap-ai-hint">{t('auto.f67d2fad')}</div>
                ) : null}
                {functionDeps.downstream.map(({ edge, node }) => (
                  <button
                    type="button"
                    key={edge.id}
                    className="codemap-function-dep-item"
                    onClick={() => onSelectFile(node.filePath)}
                  >
                    <strong>{node.name}</strong>
                    <span>
                      {node.filePath}:L{node.line}
                    </span>
                    <span>
                      {t('auto.c198663a')} {edge.symbol}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {imports.length > 0 && (
        <section className="codemap-detail-section">
          <h4 className="codemap-section-title">
            {t('tree.dependencies', { count: imports.length })}
          </h4>
          <ul className="codemap-dep-list">
            {imports.map((e) => (
              <li key={e.toFile}>
                <button
                  className="codemap-dep-link"
                  onClick={() => onSelectFile(e.toFile)}
                >
                  &rarr; {e.toFile}
                </button>
                {e.symbols.length > 0 && (
                  <span className="codemap-dep-symbols">
                    ({e.symbols.join(', ')})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {importedBy.length > 0 && (
        <section className="codemap-detail-section">
          <h4 className="codemap-section-title">
            {t('tree.referencedBy', { count: importedBy.length })}
          </h4>
          <ul className="codemap-dep-list">
            {importedBy.map((e) => (
              <li key={e.fromFile}>
                <button
                  className="codemap-dep-link"
                  onClick={() => onSelectFile(e.fromFile)}
                >
                  &larr; {e.fromFile}
                </button>
                {e.symbols.length > 0 && (
                  <span className="codemap-dep-symbols">
                    ({e.symbols.join(', ')})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* --- LLM Text View --- */

function CodeMapTextView({
  apiBase,
  repositoryId,
  branch,
}: {
  apiBase: string;
  repositoryId: string;
  branch: string;
}) {
  const { t } = useTranslation('codeMap');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    fetch(
      `${apiBase}/api/code-map/${encodeURIComponent(repositoryId)}/text?branch=${encodeURIComponent(branch)}&maxTokens=4096`,
      { signal: ctrl.signal },
    )
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((txt) => {
        if (!ctrl.signal.aborted) setText(txt);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted)
          setText(err instanceof Error ? err.message : t('panel.loadFailed'));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [apiBase, repositoryId, branch, t]);

  if (loading) {
    return (
      <div className="codemap-loading">
        <div className="codemap-spinner" />
        <span>{t('auto.f013ea9d')}</span>
      </div>
    );
  }

  return (
    <div className="codemap-text-view">
      <div className="codemap-text-hint">{t('panel.llmHint')}</div>
      <pre className="codemap-text-content">{text}</pre>
    </div>
  );
}
