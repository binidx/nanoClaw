import { useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { renderMarkdownContent } from '../markdown';

import './ToolResultCard.css';

export interface ToolResultCardProps {
  toolName: string;
  output: string;
  isError?: boolean;
  collapsed?: boolean;
  /** When set, arguments are pretty-printed JSON when possible and always shown as code. */
  variant?: 'arguments' | 'result';
}

type ResultMode = 'search_web' | 'fetch_url' | 'code' | 'markdown';

function normalizeToolKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_');
}

function toolIconSvg(toolName: string): ReactNode {
  const n = normalizeToolKey(toolName);
  const wrap = (children: ReactNode) => (
    <span aria-hidden="true">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </span>
  );

  if (n.includes('grep')) {
    return wrap(
      <>
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </>,
    );
  }
  if (n.includes('glob')) {
    return wrap(
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
    );
  }
  if (n.includes('read_lint')) {
    return wrap(
      <>
        <path d="M14 2v6a2 2 0 0 0 .245.96l5.51 8.88a2 2 0 0 1-1.694 3.04H5.939a2 2 0 0 1-1.694-3.04l5.51-8.88A2 2 0 0 0 10 8V2" />
        <path d="M6.35 15h11.3" />
        <path d="M9 3v6" />
      </>,
    );
  }
  if (
    n.includes('read_file') ||
    n.includes('write') ||
    n.includes('apply_patch') ||
    n.includes('edit') ||
    n.includes('str_replace')
  ) {
    return wrap(
      <>
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14 2 14 8 20 8" />
      </>,
    );
  }
  if (
    n.includes('search_web') ||
    n.includes('web_search') ||
    n.includes('parallel_web') ||
    (n.includes('search') && n.includes('web'))
  ) {
    return wrap(
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </>,
    );
  }
  if (n.includes('fetch_url') || (n.includes('fetch') && n.includes('url'))) {
    return wrap(
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </>,
    );
  }
  if (n.includes('fetch') || n.includes('http')) {
    return wrap(
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </>,
    );
  }
  if (n.includes('search')) {
    return wrap(
      <>
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </>,
    );
  }
  return wrap(
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
  );
}

function formatMaybeJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return text;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function classifyResultMode(
  toolName: string,
  output: string,
  variant: 'arguments' | 'result',
): ResultMode {
  if (variant === 'arguments') {
    return 'code';
  }
  const n = normalizeToolKey(toolName);
  if (
    n.includes('search_web') ||
    n.includes('web_search') ||
    n.includes('parallel_web') ||
    (n.includes('search') && n.includes('web'))
  ) {
    return 'search_web';
  }
  if (n.includes('fetch_url') || (n.includes('fetch') && n.includes('url'))) {
    return 'fetch_url';
  }
  if (n.includes('grep') || n.includes('glob') || n.includes('read_lint')) {
    return 'code';
  }
  const t = output.trim();
  if (
    /^#{1,6}\s/m.test(t) ||
    /^[-*+]\s/m.test(t) ||
    /^\d+\.\s/m.test(t) ||
    /\[.+?\]\([^)]+\)/.test(t)
  ) {
    return 'markdown';
  }
  return 'code';
}

function highlightCodeLike(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const tokenRe =
    /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|https?:\/\/[^\s)<]+)/gi;
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(tokenRe)) {
    const start = match.index ?? 0;
    if (start > last) {
      parts.push(text.slice(last, start));
    }
    const raw = match[0];
    const isUrl = /^https?:\/\//i.test(raw);
    parts.push(
      <span
        key={`m-${key++}`}
        className={isUrl ? 'tool-result-tok-url' : 'tool-result-tok-lit'}
      >
        {raw}
      </span>,
    );
    last = start + raw.length;
  }

  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return parts;
}

function renderCodeBody(output: string, langLabel: string): ReactNode {
  return (
    <div className="tool-result-code-wrapper">
      <span className="md-code-lang">{langLabel}</span>
      <pre className="md-code-block turn-item-code">
        <code className="tool-result-hl-code">{highlightCodeLike(output)}</code>
      </pre>
    </div>
  );
}

export function ToolResultCard({
  toolName,
  output,
  isError = false,
  collapsed,
  variant = 'result',
}: ToolResultCardProps) {
  const { t } = useTranslation('common');
  const bodyId = useId();
  const formatted = variant === 'arguments' ? formatMaybeJson(output) : output;
  const mode = useMemo(
    () => classifyResultMode(toolName, formatted, variant),
    [toolName, formatted, variant],
  );

  const autoCollapsed = formatted.length > 500;
  const startCollapsed = collapsed === undefined ? autoCollapsed : collapsed;
  const [expanded, setExpanded] = useState(!startCollapsed);

  const icon = toolIconSvg(toolName);
  const langLabel =
    variant === 'arguments'
      ? 'input'
      : mode === 'code'
        ? normalizeToolKey(toolName) || 'output'
        : 'output';

  const body = useMemo(() => {
    if (isError) {
      return (
        <pre className="md-code-block turn-item-code turn-item-code-error">
          <code className="tool-result-hl-code">
            {highlightCodeLike(formatted)}
          </code>
        </pre>
      );
    }
    if (variant === 'arguments' || mode === 'code') {
      return renderCodeBody(formatted, langLabel);
    }
    if (mode === 'search_web') {
      return (
        <div className="tool-result-markdown tool-result-search-web">
          {renderMarkdownContent(formatted)}
        </div>
      );
    }
    if (mode === 'fetch_url' || mode === 'markdown') {
      return (
        <div className="tool-result-markdown">
          {renderMarkdownContent(formatted)}
        </div>
      );
    }
    return renderCodeBody(formatted, langLabel);
  }, [formatted, isError, langLabel, mode, variant]);

  return (
    <div
      className={`tool-result-card${isError ? ' tool-result-card--error' : ''}`}
    >
      <div className="tool-result-card-head">
        <span className="tool-result-card-icon">{icon}</span>
        <span className="tool-result-card-title" title={toolName}>
          {toolName}
        </span>
        <span className="tool-result-card-meta">{formatted.length} {t('toolResult.chars')}</span>
        <button
          type="button"
          className="tool-result-card-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={bodyId}
        >
          {expanded ? t('toolResult.collapse') : t('toolResult.expand')}
        </button>
      </div>
      <div
        id={bodyId}
        className={
          expanded ? 'tool-result-card-body' : 'tool-result-card-body-collapsed'
        }
      >
        {body}
      </div>
    </div>
  );
}
