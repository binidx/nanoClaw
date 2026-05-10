import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiAnalysis, AiSection, CodeRef } from './code-map-api';
import { fetchAiAnalysisCached, fetchAiAnalysisStream, fetchFileContent } from './code-map-api';

export interface CodeMapAnalysisViewProps {
  apiBase: string;
  repositoryId: string;
  branch: string;
  scopeDir: string | null;
  selectedFile: string | null;
}

interface FileTab {
  filePath: string;
  content: string;
  language: string;
  lineCount: number;
}

export function CodeMapAnalysisView({
  apiBase,
  repositoryId,
  branch,
  scopeDir,
  selectedFile,
}: CodeMapAnalysisViewProps) {
  const { t } = useTranslation('codeMap');
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [streamText, setStreamText] = useState('');
  const [cached, setCached] = useState(false);

  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const [activeTab, setActiveTab] = useState('');
  const [highlightLine, setHighlightLine] = useState<number | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const codeRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamTextRef = useRef<HTMLDivElement>(null);

  const target = useMemo(() => {
    if (selectedFile) return { filePath: selectedFile };
    if (scopeDir) return { dirPath: scopeDir };
    return null;
  }, [selectedFile, scopeDir]);

  const targetKey = target?.filePath || target?.dirPath || '';

  useEffect(() => {
    setAnalysis(null);
    setError('');
    setStreamText('');
    setStatusMsg('');
    setCached(false);

    if (!target) return;
    let cancelled = false;
    fetchAiAnalysisCached(apiBase, repositoryId, branch, target)
      .then((res) => {
        if (cancelled) return;
        if (res.analysis) {
          setAnalysis(res.analysis);
          setCached(true);
        }
      })
      .catch(() => { /* silent - user can manually generate */ });
    return () => { cancelled = true; };
  }, [targetKey, apiBase, repositoryId, branch, target]);

  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const handleGenerate = useCallback(
    async (forceRefresh = false) => {
      if (!target) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setLoading(true);
      setError('');
      setStreamText('');
      setStatusMsg('');
      setAnalysis(null);
      setCached(false);

      try {
        await fetchAiAnalysisStream(
          apiBase,
          repositoryId,
          branch,
          { ...target, forceRefresh },
          {
            onStatus(message) {
              setStatusMsg(message);
            },
            onChunk(text) {
              setStreamText((prev) => {
                const next = prev + text;
                requestAnimationFrame(() => {
                  if (streamTextRef.current) {
                    streamTextRef.current.scrollTop = streamTextRef.current.scrollHeight;
                  }
                });
                return next;
              });
            },
            onDone(result, wasCached) {
              setAnalysis(result);
              setCached(wasCached);
              setStreamText('');
              setLoading(false);
            },
            onError(message) {
              setError(message);
              setLoading(false);
            },
          },
          ac.signal,
        );
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError(err instanceof Error ? err.message : t('analysis.loadFailed'));
        setLoading(false);
      }
    },
    [apiBase, repositoryId, branch, target],
  );

  const openFile = useCallback(
    async (filePath: string, line?: number) => {
      const existing = fileTabs.find((t) => t.filePath === filePath);
      if (existing) {
        setActiveTab(filePath);
        if (line) setHighlightLine(line);
        return;
      }
      setFileLoading(true);
      try {
        const result = await fetchFileContent(apiBase, repositoryId, branch, filePath);
        setFileTabs((prev) => {
          const next = prev.filter((t) => t.filePath !== filePath);
          next.push({
            filePath: result.filePath,
            content: result.content,
            language: result.language,
            lineCount: result.lineCount,
          });
          if (next.length > 8) next.shift();
          return next;
        });
        setActiveTab(filePath);
        if (line) setHighlightLine(line);
      } catch {
        setError(t('analysis.fileLoadFailed', { path: filePath }));
      } finally {
        setFileLoading(false);
      }
    },
    [apiBase, repositoryId, branch, fileTabs],
  );

  const handleCodeRefClick = useCallback(
    (ref: CodeRef) => {
      openFile(ref.file, ref.line);
    },
    [openFile],
  );

  const closeTab = useCallback(
    (filePath: string) => {
      setFileTabs((prev) => {
        const next = prev.filter((t) => t.filePath !== filePath);
        if (activeTab === filePath && next.length > 0) {
          setActiveTab(next[next.length - 1].filePath);
        }
        return next;
      });
    },
    [activeTab],
  );

  useEffect(() => {
    if (!highlightLine || !codeRef.current) return;
    const el = codeRef.current.querySelector(`[data-line="${highlightLine}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightLine, activeTab]);

  const activeFile = fileTabs.find((t) => t.filePath === activeTab);

  return (
    <div className="codemap-analysis-root">
      {/* Left: outline */}
      <div className="codemap-analysis-left">
        <div className="codemap-analysis-toolbar">
          <span className="codemap-analysis-scope">
            {target?.filePath
              ? t('analysis.file', { name: target.filePath.split('/').pop() })
              : target?.dirPath
                ? t('analysis.directory', { path: target.dirPath })
                : t('analysis.selectHint')}
          </span>
          <div className="codemap-analysis-toolbar-actions">
            {cached && (
              <span className="codemap-analysis-cached-badge">{t('analysis.cached')}</span>
            )}
            <button
              type="button"
              className="codemap-analysis-gen-btn"
              onClick={() => handleGenerate(false)}
              disabled={loading || !target}
            >
              {loading ? t('analysis.analyzing') : analysis ? t('analysis.reanalyze') : t('analysis.generate')}
            </button>
            {analysis && cached && (
              <button
                type="button"
                className="codemap-analysis-refresh-btn"
                onClick={() => handleGenerate(true)}
                disabled={loading}
                title={t('analysis.ignoreCache')}
              >
                {t('analysis.refresh')}
              </button>
            )}
          </div>
        </div>

        {error && <div className="codemap-analysis-error">{error}</div>}

        {loading && streamText && (
          <div className="codemap-analysis-stream" ref={streamTextRef}>
            {statusMsg && (
              <div className="codemap-analysis-status">{statusMsg}</div>
            )}
            <pre className="codemap-analysis-stream-text">{streamText}<span className="codemap-analysis-cursor">|</span></pre>
          </div>
        )}

        {loading && !streamText && (
          <div className="codemap-analysis-loading">
            {statusMsg && (
              <div className="codemap-analysis-status">{statusMsg}</div>
            )}
            <div className="codemap-analysis-skeleton" />
            <div className="codemap-analysis-skeleton short" />
            <div className="codemap-analysis-skeleton" />
            <div className="codemap-analysis-skeleton short" />
          </div>
        )}

        {analysis && !loading && (
          <div className="codemap-analysis-outline">
            <h3 className="codemap-analysis-title">{analysis.title}</h3>
            <p className="codemap-analysis-summary">{analysis.summary}</p>
            {analysis.sections.map((sec) => (
              <SectionBlock
                key={sec.id}
                section={sec}
                depth={0}
                onRefClick={handleCodeRefClick}
              />
            ))}
          </div>
        )}

        {!analysis && !loading && !error && (
          <div className="codemap-analysis-empty">
            {t('analysis.hint1')}
            {t('analysis.hint2')}
          </div>
        )}
      </div>

      {/* Right: code viewer */}
      <div className="codemap-analysis-right">
        {fileTabs.length > 0 && (
          <div className="codemap-viewer-tabs">
            {fileTabs.map((tab) => (
              <div
                key={tab.filePath}
                className={`codemap-viewer-tab${tab.filePath === activeTab ? ' active' : ''}`}
                onClick={() => {
                  setActiveTab(tab.filePath);
                  setHighlightLine(null);
                }}
              >
                <span className="codemap-viewer-tab-name">
                  {tab.filePath.split('/').pop()}
                </span>
                <button
                  type="button"
                  className="codemap-viewer-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.filePath);
                  }}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        {fileLoading && (
          <div className="codemap-viewer-loading">{t('analysis.loading')}</div>
        )}

        {activeFile && !fileLoading && (
          <div className="codemap-viewer-code" ref={codeRef}>
            <pre>
              <code>
                {activeFile.content.split('\n').map((line, idx) => {
                  const ln = idx + 1;
                  const isHl = ln === highlightLine;
                  return (
                    <div
                      key={ln}
                      className={`codemap-viewer-line${isHl ? ' highlight' : ''}`}
                      data-line={ln}
                    >
                      <span className="codemap-viewer-ln">{ln}</span>
                      <span className="codemap-viewer-text">{line || ' '}</span>
                    </div>
                  );
                })}
              </code>
            </pre>
          </div>
        )}

        {!activeFile && !fileLoading && (
          <div className="codemap-viewer-empty">
            {t('analysis.clickToView')}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionBlock({
  section,
  depth,
  onRefClick,
}: {
  section: AiSection;
  depth: number;
  onRefClick: (ref: CodeRef) => void;
}) {
  const { t } = useTranslation('codeMap');
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = (section.children?.length ?? 0) > 0;
  const hasContent = section.codeRefs.length > 0 || section.description || hasChildren;

  return (
    <div className={`codemap-section${depth > 0 ? ' codemap-section-nested' : ''}`}>
      <div className="codemap-section-header">
        {hasContent ? (
          <button
            type="button"
            className="codemap-section-toggle"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? t('analysis.expand') : t('analysis.collapse')}
          >
            <span className={`codemap-section-chevron${collapsed ? '' : ' expanded'}`}>&#9654;</span>
          </button>
        ) : (
          <span className="codemap-section-toggle-placeholder" />
        )}
        <span className="codemap-section-id">{section.id}</span>
        <span className="codemap-section-title">{section.title}</span>
      </div>
      {!collapsed && (
        <div className="codemap-section-body">
          {section.description && (
            <p className="codemap-section-desc">{section.description}</p>
          )}
          {section.codeRefs.map((ref, i) => (
            <button
              key={`${ref.file}:${ref.line}:${i}`}
              type="button"
              className="codemap-coderef"
              onClick={() => onRefClick(ref)}
            >
              <span className="codemap-coderef-label">{ref.label}</span>
              <span className="codemap-coderef-loc">
                {ref.file.split('/').pop()}:{ref.line}
              </span>
              {ref.snippet && (
                <code className="codemap-coderef-snippet">{ref.snippet}</code>
              )}
            </button>
          ))}
          {section.children?.map((child) => (
            <SectionBlock
              key={child.id}
              section={child}
              depth={depth + 1}
              onRefClick={onRefClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
