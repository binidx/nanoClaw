import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TabBar } from '../common/TabBar';
import { NcSelect } from '../common/NcSelect';
import { CodeMapTreeView } from './CodeMapTreeView';
import { CodeMapGraphView } from './CodeMapGraphView';
import { CodeMapRepoOverview } from './CodeMapRepoOverview';
import type {
  CodeMapSnapshot,
  CodeMapStats,
} from './code-map-api';
import {
  fetchCodeMap,
  fetchCodeMapStats,
  rebuildCodeMap,
} from './code-map-api';

export interface CodeMapPanelProps {
  apiBase: string;
  repositoryId: string;
  repositoryName: string;
  defaultBranch: string;
  availableBranches?: string[];
}

type ViewTab = 'tree' | 'graph' | 'text';

export function CodeMapPanel({
  apiBase,
  repositoryId,
  defaultBranch,
  availableBranches = [],
}: CodeMapPanelProps) {
  const { t } = useTranslation('codeMap');
  const [branch, setBranch] = useState(defaultBranch);
  const [snapshot, setSnapshot] = useState<CodeMapSnapshot | null>(null);
  const [stats, setStats] = useState<CodeMapStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [notBuilt, setNotBuilt] = useState(false);
  const [error, setError] = useState('');
  const [viewTab, setViewTab] = useState<ViewTab>('tree');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [overviewCollapsed, setOverviewCollapsed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadCodeMap = useCallback(async (b: string) => {
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
  }, [apiBase, repositoryId]);

  const handleRebuild = useCallback(async () => {
    setRebuilding(true);
    setError('');
    try {
      await rebuildCodeMap(apiBase, repositoryId, branch);
      await loadCodeMap(branch);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('panel.buildFailed'));
    } finally {
      setRebuilding(false);
    }
  }, [apiBase, repositoryId, branch, loadCodeMap]);

  const loadStats = useCallback(async (b: string) => {
    try {
      const s = await fetchCodeMapStats(apiBase, repositoryId, b);
      setStats(s);
    } catch { /* ignore */ }
  }, [apiBase, repositoryId]);

  useEffect(() => {
    void loadCodeMap(branch);
    void loadStats(branch);
    return () => abortRef.current?.abort();
  }, [branch, loadCodeMap, loadStats]);

  const filteredFiles = useMemo(() => {
    if (!snapshot) return [];
    if (!searchQuery.trim()) return snapshot.files;
    const q = searchQuery.toLowerCase();
    return snapshot.files.filter(
      (f) =>
        f.relativePath.toLowerCase().includes(q) ||
        f.symbols.some(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.signature.toLowerCase().includes(q),
        ),
    );
  }, [snapshot, searchQuery]);

  const selectedFileData = useMemo(() => {
    if (!snapshot || !selectedFile) return null;
    return snapshot.files.find((f) => f.relativePath === selectedFile) || null;
  }, [snapshot, selectedFile]);

  const filteredEdges = useMemo(() => {
    if (!snapshot) return [];
    if (!searchQuery.trim()) return snapshot.edges;
    const fileSet = new Set(filteredFiles.map((f) => f.relativePath));
    return snapshot.edges.filter(
      (e) => fileSet.has(e.fromFile) || fileSet.has(e.toFile),
    );
  }, [snapshot, filteredFiles, searchQuery]);

  const relatedEdges = useMemo(() => {
    if (!snapshot || !selectedFile) return [];
    return snapshot.edges.filter(
      (e) => e.fromFile === selectedFile || e.toFile === selectedFile,
    );
  }, [snapshot, selectedFile]);

  const branchOptions = useMemo(() => {
    const set = new Set([defaultBranch, ...availableBranches]);
    return Array.from(set);
  }, [defaultBranch, availableBranches]);

  if (notBuilt && !loading) {
    return (
      <div className="code-map-panel">
        <div className="code-map-toolbar">
          <div className="code-map-toolbar-left">
            <NcSelect
              className="code-map-branch-select"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            >
              {branchOptions.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </NcSelect>
          </div>
        </div>
        {error && <div className="code-map-error">{error}</div>}
        <div className="code-map-not-built">
          <div className="code-map-not-built-icon">&#128506;</div>
          <h3>{t('panel.notBuilt')}</h3>
          <p>{t('panel.notBuiltDesc')}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleRebuild}
            disabled={rebuilding}
          >
            {rebuilding ? t('panel.building') : t('panel.build')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="code-map-panel">
      <div className="code-map-toolbar">
        <div className="code-map-toolbar-left">
          <NcSelect
            className="code-map-branch-select"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          >
            {branchOptions.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </NcSelect>
          <div className="code-map-search-box">
            <input
              type="text"
              placeholder={t('panel.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="code-map-search-input"
            />
            {searchQuery && (
              <button
                className="code-map-search-clear"
                onClick={() => setSearchQuery('')}
                type="button"
              >
                ×
              </button>
            )}
          </div>
        </div>
        <div className="code-map-toolbar-right">
          {stats && (
            <span className="code-map-stats-badge">
              {t('panel.stats', { fileCount: stats.fileCount, symbolCount: stats.symbolCount, edgeCount: stats.edgeCount })}
            </span>
          )}
          <button
            type="button"
            className="btn-sm btn-outline"
            onClick={handleRebuild}
            disabled={rebuilding}
          >
            {rebuilding ? t('panel.building') : t('panel.rebuild')}
          </button>
        </div>
      </div>

      <TabBar
        tabs={[
          { key: 'tree', label: t('panel.tab.tree') },
          { key: 'graph', label: t('panel.tab.graph') },
          { key: 'text', label: t('panel.tab.text') },
        ]}
        activeKey={viewTab}
        onChange={(k) => setViewTab(k as ViewTab)}
        size="small"
      />

      {snapshot && (
        <CodeMapRepoOverview
          apiBase={apiBase}
          repositoryId={repositoryId}
          branch={branch}
          collapsed={overviewCollapsed}
          onToggleCollapse={() => setOverviewCollapsed((p) => !p)}
        />
      )}

      {error && <div className="code-map-error">{error}</div>}

      {loading && !snapshot && (
        <div className="code-map-loading">
          <div className="code-map-spinner" />
          {t('panel.loading')}
        </div>
      )}

      {snapshot && viewTab === 'tree' && (
        <CodeMapTreeView
          files={filteredFiles}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          selectedFileData={selectedFileData}
          relatedEdges={relatedEdges}
        />
      )}

      {snapshot && viewTab === 'graph' && (
        <CodeMapGraphView
          files={filteredFiles}
          edges={filteredEdges}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          allFiles={snapshot.files}
          allEdges={snapshot.edges}
          viewScope={`${repositoryId}:${branch}`}
        />
      )}

      {snapshot && viewTab === 'text' && (
        <CodeMapTextView
          apiBase={apiBase}
          repositoryId={repositoryId}
          branch={branch}
        />
      )}
    </div>
  );
}

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
      .then((t) => { if (!ctrl.signal.aborted) setText(t); })
      .catch((err) => {
        if (!ctrl.signal.aborted) setText(err instanceof Error ? err.message : t('panel.loadFailed'));
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [apiBase, repositoryId, branch]);

  if (loading) return <div className="code-map-loading">{t('panel.loading')}</div>;

  return (
    <div className="code-map-text-view">
      <div className="code-map-text-hint">
        {t('panel.llmHint')}
      </div>
      <pre className="code-map-text-content">{text}</pre>
    </div>
  );
}
