import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CodeIndexMeta, CodeIndexSearchResult } from './code-map-api';
import { searchCodeIndex } from './code-map-api';

function labelSummarySource(source: 'fallback' | 'ai' | 'cache', t: (key: string) => string): string {
  switch (source) {
    case 'ai':
      return t('search.aiSummary');
    case 'cache':
      return t('search.cacheReuse');
    default:
      return t('search.ruleFallback');
  }
}

export interface CodeIndexSearchViewProps {
  apiBase: string;
  repositoryId: string;
  branch: string;
  onOpenFile: (filePath: string) => void;
}

export function CodeIndexSearchView({
  apiBase,
  repositoryId,
  branch,
  onOpenFile,
}: CodeIndexSearchViewProps) {
  const { t } = useTranslation('codeMap');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<CodeIndexSearchResult[]>([]);
  const [meta, setMeta] = useState<CodeIndexMeta | null>(null);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await searchCodeIndex(apiBase, repositoryId, branch, trimmed, 10);
      setResults(response.results);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('search.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, repositoryId, branch, query]);

  return (
    <div className="codemap-search-view">
      <div className="codemap-search-panel">
        <div className="codemap-search-panel-row">
          <input
            className="nc-input codemap-index-query-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('search.placeholder')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void runSearch();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary codemap-index-query-btn"
            onClick={() => void runSearch()}
            disabled={loading}
          >
            {loading ? t('search.searching') : t('search.semanticSearch')}
          </button>
        </div>
        {meta ? (
          <div className="codemap-index-summary-strip">
            <span>{meta.stats.chunkCount} chunks</span>
            <span>{meta.stats.functionCount} functions</span>
            <span>{meta.capabilities.embeddings ? t('search.vectorEnabled') : t('search.termOnly')}</span>
          </div>
        ) : null}
        {error ? <div className="codemap-error">{error}</div> : null}
      </div>

      {results.length === 0 && !loading ? (
        <div className="codemap-index-empty">
          {t('search.hint')}
        </div>
      ) : null}

      {results.length > 0 ? (
        <div className="codemap-index-result-list">
          {results.map((result) => (
            <button
              type="button"
              key={result.chunkId}
              className="codemap-index-result-card"
              onClick={() => onOpenFile(result.filePath)}
            >
              <div className="codemap-index-result-top">
                <strong>{result.filePath}</strong>
                <span>
                  L{result.startLine}-{result.endLine}
                </span>
              </div>
              <div className="codemap-index-result-meta">
                <span>{result.matchedBy}</span>
                <span>{Math.round(result.score * 100)}%</span>
              </div>
              <div className="codemap-index-result-meta">
                <span>{t('search.chunkSummary', { source: labelSummarySource(result.summarySource, t) })}</span>
                <span>{t('search.fileSummary', { source: labelSummarySource(result.fileSummarySource, t) })}</span>
              </div>
              <div className="codemap-index-result-summary">{result.summary}</div>
              <div className="codemap-index-result-preview">{result.preview}</div>
              {result.fileSummary ? (
                <div className="codemap-index-result-file-summary">{result.fileSummary}</div>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
