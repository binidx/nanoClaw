import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  askProjectCodebase,
  type ProjectQaResponse,
} from './code-map-api';

export interface ProjectQaViewProps {
  apiBase: string;
  repositoryId: string;
  branch: string;
  selectedFile: string | null;
  scopedFiles: string[];
  onOpenFile: (filePath: string) => void;
}

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function formatNodeLocation(node: {
  filePath?: string;
  startLine?: number;
  endLine?: number;
}): string {
  if (!node.filePath) return '';
  if (node.startLine) {
    return `${node.filePath}:${node.startLine}${node.endLine ? `-${node.endLine}` : ''}`;
  }
  return node.filePath;
}

export function ProjectQaView({
  apiBase,
  repositoryId,
  branch,
  selectedFile,
  scopedFiles,
  onOpenFile,
}: ProjectQaViewProps) {
  const { t } = useTranslation('codeMap');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ProjectQaResponse | null>(null);

  const focusPaths = useMemo(() => {
    if (selectedFile) return [selectedFile];
    return scopedFiles.slice(0, 6);
  }, [scopedFiles, selectedFile]);

  const runQuestion = useCallback(async () => {
    const trimmed = question.trim();
    if (!trimmed) {
      setResult(null);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await askProjectCodebase(
        apiBase,
        repositoryId,
        branch,
        {
          question: trimmed,
          focusPaths,
        },
      );
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('qa.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, repositoryId, branch, focusPaths, question, t]);

  return (
    <div className="codemap-qa-view">
      <div className="codemap-search-panel codemap-qa-panel">
        <div className="codemap-search-panel-row codemap-qa-row">
          <input
            className="nc-input codemap-index-query-input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t('qa.placeholder')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void runQuestion();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary codemap-index-query-btn"
            onClick={() => void runQuestion()}
            disabled={loading}
          >
            {loading ? t('qa.asking') : t('qa.ask')}
          </button>
        </div>
        <div className="codemap-index-summary-strip codemap-qa-summary-strip">
          <span>
            {focusPaths.length > 0
              ? t('qa.focusedPaths', { count: focusPaths.length })
              : t('qa.globalScope')}
          </span>
          {selectedFile ? <span>{selectedFile}</span> : null}
        </div>
        {error ? <div className="codemap-error">{error}</div> : null}
      </div>

      {!result && !loading ? (
        <div className="codemap-index-empty codemap-qa-empty">
          {t('qa.hint')}
        </div>
      ) : null}

      {result ? (
        <div className="codemap-qa-results">
          <section className="codemap-qa-card codemap-qa-answer-card">
            <div className="codemap-qa-card-top">
              <strong>{t('qa.answer')}</strong>
              <div className="codemap-qa-badges">
                <span className="codemap-stats-badge">
                  {t('qa.profile')} {result.qa.retrievalProfile}
                </span>
                <span className="codemap-stats-badge">
                  {t('qa.confidence')} {formatPercent(result.result.confidence.overall)}
                </span>
                {result.noAi ? (
                  <span className="codemap-stats-badge">{t('qa.fallback')}</span>
                ) : null}
              </div>
            </div>
            <div className="codemap-qa-answer-text">{result.answer}</div>
            {result.answer !== result.fallbackAnswer ? (
              <details className="codemap-qa-fallback">
                <summary>{t('qa.showFallback')}</summary>
                <div className="codemap-qa-fallback-text">{result.fallbackAnswer}</div>
              </details>
            ) : null}
          </section>

          <section className="codemap-qa-card">
            <div className="codemap-qa-card-top">
              <strong>{t('qa.exploration')}</strong>
              {result.artifact?.id ? (
                <span className="codemap-stats-badge">{result.artifact.id}</span>
              ) : null}
            </div>
            <div className="codemap-qa-metrics">
              <span>{t('qa.selectedFiles', { count: result.qa.exploration.selectedFiles.length })}</span>
              <span>{t('qa.matchedFunctions', { count: result.qa.exploration.matchedFunctionCount })}</span>
              <span>{t('qa.matchedChunks', { count: result.qa.exploration.matchedChunkCount })}</span>
            </div>
            <div className="codemap-qa-file-list">
              {result.qa.exploration.selectedFiles.map((filePath) => (
                <button
                  type="button"
                  key={filePath}
                  className="codemap-qa-file-chip"
                  onClick={() => onOpenFile(filePath)}
                >
                  {filePath}
                </button>
              ))}
            </div>
          </section>

          <section className="codemap-qa-card">
            <div className="codemap-qa-card-top">
              <strong>{t('qa.topMatches')}</strong>
            </div>
            <div className="codemap-qa-match-grid">
              <div className="codemap-qa-match-column">
                <div className="codemap-qa-match-title">{t('qa.files')}</div>
                {result.result.matches.files.slice(0, 5).map((node) => (
                  <button
                    type="button"
                    key={node.id}
                    className="codemap-qa-match-item"
                    onClick={() => node.filePath && onOpenFile(node.filePath)}
                  >
                    <strong>{formatNodeLocation(node) || node.label}</strong>
                    <span>{formatPercent(node.score / 20)}</span>
                  </button>
                ))}
              </div>
              <div className="codemap-qa-match-column">
                <div className="codemap-qa-match-title">{t('qa.functions')}</div>
                {result.result.matches.functions.slice(0, 5).map((node) => (
                  <div key={node.id} className="codemap-qa-match-item codemap-qa-match-static">
                    <strong>{node.label}</strong>
                    <span>{formatNodeLocation(node)}</span>
                  </div>
                ))}
              </div>
              <div className="codemap-qa-match-column">
                <div className="codemap-qa-match-title">{t('qa.communities')}</div>
                {result.result.communities.slice(0, 5).map((community) => (
                  <div key={community.id} className="codemap-qa-match-item codemap-qa-match-static">
                    <strong>{community.label}</strong>
                    <span>{t('qa.communityFiles', { count: community.filePaths.length })}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
