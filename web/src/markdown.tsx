import { Fragment, useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import shell from 'highlight.js/lib/languages/shell';
import plaintext from 'highlight.js/lib/languages/plaintext';
import { createMarkdownHeadingId } from './markdown-helpers';
import {
  findDetectedUrls,
  getImageAltText,
  isLikelyImageUrl,
} from './message-link-utils';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sh', shell);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('text', plaintext);

function highlightCode(code: string, language?: string): string {
  if (language && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(code, { language }).value;
    } catch {
      /* fall through */
    }
  }
  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

interface HeadingBlock {
  kind: 'heading';
  level: number;
  text: string;
}

interface ParagraphBlock {
  kind: 'paragraph';
  text: string;
}

interface CodeBlock {
  kind: 'code';
  code: string;
  language?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
}

interface QuoteBlock {
  kind: 'quote';
  text: string;
}

interface ListBlock {
  kind: 'list';
  ordered: boolean;
  items: string[];
}

interface HrBlock {
  kind: 'hr';
}

interface TableBlock {
  kind: 'table';
  headers: string[];
  rows: string[][];
}

type MarkdownBlock =
  | HeadingBlock
  | ParagraphBlock
  | CodeBlock
  | QuoteBlock
  | ListBlock
  | HrBlock
  | TableBlock;

export interface RenderMarkdownOptions {
  headingIdPrefix?: string;
}

const INLINE_PATTERN =
  /(!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)|\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\)|`[^`]+`|\*\*[\s\S]+?\*\*|__[\s\S]+?__|~~[\s\S]+?~~|\*[^*\n]+\*|_[^_\n]+_)/g;

function safeHref(href: string): string | null {
  if (/^(https?:\/\/|mailto:|tel:)/i.test(href)) return href;
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  return null;
}

function parseInlineLinkToken(
  token: string,
): { label: string; href: string; isImage: boolean } | null {
  const isImage = token.startsWith('!');
  const match = token.match(
    isImage
      ? /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/
      : /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/,
  );
  if (!match) return null;
  return {
    label: match[1] || '',
    href: match[2] || '',
    isImage,
  };
}

function renderAutoLinkedUrl(href: string, key: string): ReactNode {
  const safe = safeHref(href);
  if (!safe) return href;

  if (isLikelyImageUrl(safe)) {
    return (
      <a
        key={key}
        className="md-image-link"
        href={safe}
        target="_blank"
        rel="noreferrer"
      >
        <img
          className="md-inline-image"
          src={safe}
          alt={getImageAltText(safe)}
          loading="lazy"
        />
      </a>
    );
  }

  return (
    <a key={key} href={safe} target="_blank" rel="noreferrer">
      {href}
    </a>
  );
}

function renderPlainTextWithAutoLinks(
  text: string,
  keyPrefix: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of findDetectedUrls(text)) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    nodes.push(renderAutoLinkedUrl(match.url, `${keyPrefix}-url-${match.index}`));

    if (match.suffix) {
      nodes.push(match.suffix);
    }

    lastIndex = match.index + match.raw.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const start = match.index ?? 0;

    if (start > lastIndex) {
      nodes.push(
        ...renderPlainTextWithAutoLinks(
          text.slice(lastIndex, start),
          `${keyPrefix}-text-${lastIndex}`,
        ),
      );
    }

    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={`${keyPrefix}-${start}`}>{token.slice(1, -1)}</code>,
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-${start}`}>{token.slice(2, -2)}</strong>,
      );
    } else if (token.startsWith('__') && token.endsWith('__')) {
      nodes.push(
        <strong key={`${keyPrefix}-${start}`}>{token.slice(2, -2)}</strong>,
      );
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<del key={`${keyPrefix}-${start}`}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={`${keyPrefix}-${start}`}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('_') && token.endsWith('_')) {
      nodes.push(<em key={`${keyPrefix}-${start}`}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[') || token.startsWith('![')) {
      const parsed = parseInlineLinkToken(token);
      if (parsed) {
        const safe = safeHref(parsed.href);
        if (safe) {
          if (parsed.isImage) {
            nodes.push(
              <a
                key={`${keyPrefix}-${start}`}
                className="md-image-link"
                href={safe}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  className="md-inline-image"
                  src={safe}
                  alt={parsed.label || 'image'}
                  loading="lazy"
                />
              </a>,
            );
          } else {
            nodes.push(
              <a
                key={`${keyPrefix}-${start}`}
                href={safe}
                target="_blank"
                rel="noreferrer"
              >
                {parsed.label}
              </a>,
            );
          }
        } else {
          nodes.push(parsed.label || token);
        }
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(token);
    }

    lastIndex = start + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      ...renderPlainTextWithAutoLinks(
        text.slice(lastIndex),
        `${keyPrefix}-text-${lastIndex}`,
      ),
    );
  }

  return nodes;
}

function renderInlineWithBreaks(text: string, keyPrefix: string): ReactNode[] {
  return text.split('\n').flatMap((line, index, arr) => {
    const nodes: ReactNode[] = [
      <Fragment key={`${keyPrefix}-line-${index}`}>
        {renderInline(line, `${keyPrefix}-line-${index}`)}
      </Fragment>,
    ];

    if (index < arr.length - 1) {
      nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
    }

    return nodes;
  });
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function isTableSeparatorLine(line: string): boolean {
  if (!line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(isTableSeparatorCell);
}

function parseCodeFenceInfo(info: string): {
  language?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
} {
  if (!info) return {};
  const parts = info.split(':');
  const language = parts[0] || undefined;
  if (parts.length === 1) return { language };
  const rest = parts.slice(1).join(':');
  // Pure line range without filepath: "42-50" or "42"
  const pureLineMatch = rest.match(/^(\d+)(?:-(\d+))?$/);
  if (pureLineMatch) {
    return {
      language,
      lineStart: parseInt(pureLineMatch[1], 10),
      lineEnd: pureLineMatch[2] ? parseInt(pureLineMatch[2], 10) : undefined,
    };
  }
  // Filepath with optional line range: "src/foo.ts:42-50" or "src/foo.ts"
  const lineMatch = rest.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (lineMatch) {
    return {
      language,
      filePath: lineMatch[1],
      lineStart: parseInt(lineMatch[2], 10),
      lineEnd: lineMatch[3] ? parseInt(lineMatch[3], 10) : undefined,
    };
  }
  return { language, filePath: rest || undefined };
}

function parseMarkdownFileLocationLine(line: string): {
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
} {
  const trimmed = line.trim();
  const match = trimmed.match(
    /^(?:\*\*文件：\*\*|文件：)\s*`?(.+?):(\d+)(?:-(\d+))?`?\s*$/u,
  );
  if (!match) return {};
  return {
    filePath: match[1] || undefined,
    lineStart: Number.parseInt(match[2], 10),
    lineEnd: match[3] ? Number.parseInt(match[3], 10) : undefined,
  };
}

function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  const isListItem = (line: string, ordered: boolean): boolean =>
    ordered ? /^\s{0,3}\d+\.\s+/.test(line) : /^\s{0,3}[-*+]\s+/.test(line);

  const isBlockBoundary = (line: string): boolean =>
    /^\s*```/.test(line) ||
    /^\s{0,3}(#{1,6})\s+/.test(line) ||
    /^\s{0,3}>\s?/.test(line) ||
    /^\s{0,3}[-*_](?:\s*[-*_]){2,}\s*$/.test(line) ||
    isListItem(line, false) ||
    isListItem(line, true);

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const codeFence = line.match(/^\s*```([^`]*)\s*$/);
    if (codeFence) {
      const infoString = codeFence[1]?.trim() || '';
      const parsed = parseCodeFenceInfo(infoString);
      const locationFallback =
        !parsed.filePath && !parsed.lineStart && index > 0
          ? parseMarkdownFileLocationLine(lines[index - 1] || '')
          : {};
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        kind: 'code',
        code: codeLines.join('\n'),
        language: parsed.language,
        filePath: parsed.filePath || locationFallback.filePath,
        lineStart: parsed.lineStart ?? locationFallback.lineStart,
        lineEnd: parsed.lineEnd ?? locationFallback.lineEnd,
      });
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (/^\s{0,3}[-*_](?:\s*[-*_]){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: quoteLines.join('\n').trim() });
      continue;
    }

    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      isTableSeparatorLine(lines[index + 1])
    ) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length) {
        const rowLine = lines[index];
        if (!rowLine.trim() || !rowLine.includes('|') || isBlockBoundary(rowLine)) {
          break;
        }
        rows.push(splitTableRow(rowLine));
        index += 1;
      }

      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    if (isListItem(line, false) || isListItem(line, true)) {
      const ordered = isListItem(line, true);
      const items: string[] = [];
      while (index < lines.length && isListItem(lines[index], ordered)) {
        items.push(
          ordered
            ? lines[index].replace(/^\s{0,3}\d+\.\s+/, '').trim()
            : lines[index].replace(/^\s{0,3}[-*+]\s+/, '').trim(),
        );
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const paragraphLines: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockBoundary(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraphLines.join('\n').trim() });
  }

  return blocks;
}

function splitHighlightedLines(code: string, language?: string): string[] {
  const highlighted = highlightCode(code, language);
  // Split the highlighted HTML by newlines while preserving open <span> tags
  const rawLines = highlighted.split('\n');
  const result: string[] = [];
  let openSpans: string[] = [];
  for (const rawLine of rawLines) {
    let line = openSpans.join('') + rawLine;
    // Track open/close spans to carry over to next line
    const opens = rawLine.match(/<span[^>]*>/g) || [];
    const closes = rawLine.match(/<\/span>/g) || [];
    // Close spans that were opened in previous lines
    const netCloses = closes.length - opens.length;
    if (netCloses > 0) {
      openSpans = openSpans.slice(0, -netCloses);
    } else if (netCloses < 0) {
      // New spans opened on this line that aren't closed
      const unclosed = opens.slice(opens.length + netCloses);
      openSpans = [...openSpans, ...unclosed];
      line += '</span>'.repeat(-netCloses);
    }
    result.push(line);
  }
  return result;
}

function CodeBlockRenderer({
  code,
  language,
  filePath,
  lineStart,
  lineEnd,
}: {
  code: string;
  language?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
}) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const startNum = lineStart ?? 1;
  const hasHeader = !!(filePath || language);

  const handleCopy = useCallback(() => {
    const doCopy = async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(code);
        } else {
          const ta = document.createElement('textarea');
          ta.value = code;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      } catch { /* silently fail */ }
    };
    void doCopy();
  }, [code]);

  const lineLabel = lineStart
    ? lineEnd
      ? `${lineStart}-${lineEnd}`
      : `${lineStart}`
    : '';
  const headerText = filePath
    ? lineLabel
      ? `${filePath}:${lineLabel}`
      : filePath
    : '';

  return (
    <pre className="md-code-block">
      {hasHeader && (
        <div className="md-code-header">
          <span className="md-code-file-path">{headerText}</span>
          <span className="md-code-header-right">
            {language && <span className="md-code-lang">{language}</span>}
            <button
              type="button"
              className="md-code-copy-btn"
              onClick={handleCopy}
              title={copied ? t('code.copied') : t('code.copy')}
              aria-label={copied ? t('code.copied') : t('code.copy')}
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </span>
        </div>
      )}
      {!hasHeader && (
        <button
          type="button"
          className="md-code-copy-btn md-code-copy-btn-float"
          onClick={handleCopy}
          title={copied ? t('code.copied') : t('code.copy')}
          aria-label={copied ? t('code.copied') : t('code.copy')}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      )}
      <div className="md-code-body">
        <table className="md-code-table">
          <tbody>
            {splitHighlightedLines(code, language).map((htmlLine, i) => (
              <tr key={i} className="md-code-line">
                <td className="md-code-line-number">{startNum + i}</td>
                <td
                  className="md-code-line-content"
                  dangerouslySetInnerHTML={{ __html: htmlLine }}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </pre>
  );
}

export function renderMarkdownContent(
  content: string,
  options: RenderMarkdownOptions = {},
): ReactNode {
  const blocks = parseBlocks(content);
  let headingIndex = 0;

  return blocks.map((block, index) => {
    const key = `md-${index}`;

    switch (block.kind) {
      case 'heading': {
        const headingClassName = `md-heading md-h${block.level}`;
        const headingId = options.headingIdPrefix
          ? createMarkdownHeadingId(options.headingIdPrefix, headingIndex++, block.text)
          : undefined;
        if (block.level === 1) {
          return (
            <h1 key={key} id={headingId} className={headingClassName}>
              {renderInlineWithBreaks(block.text, key)}
            </h1>
          );
        }
        if (block.level === 2) {
          return (
            <h2 key={key} id={headingId} className={headingClassName}>
              {renderInlineWithBreaks(block.text, key)}
            </h2>
          );
        }
        if (block.level === 3) {
          return (
            <h3 key={key} id={headingId} className={headingClassName}>
              {renderInlineWithBreaks(block.text, key)}
            </h3>
          );
        }
        if (block.level === 4) {
          return (
            <h4 key={key} id={headingId} className={headingClassName}>
              {renderInlineWithBreaks(block.text, key)}
            </h4>
          );
        }
        if (block.level === 5) {
          return (
            <h5 key={key} id={headingId} className={headingClassName}>
              {renderInlineWithBreaks(block.text, key)}
            </h5>
          );
        }
        return (
          <h6 key={key} id={headingId} className={headingClassName}>
            {renderInlineWithBreaks(block.text, key)}
          </h6>
        );
      }
      case 'paragraph':
        return (
          <p key={key} className="md-paragraph">
            {renderInlineWithBreaks(block.text, key)}
          </p>
        );
      case 'code':
        return (
          <CodeBlockRenderer
            key={key}
            code={block.code}
            language={block.language}
            filePath={block.filePath}
            lineStart={block.lineStart}
            lineEnd={block.lineEnd}
          />
        );
      case 'quote':
        return (
          <blockquote key={key} className="md-blockquote">
            {renderInlineWithBreaks(block.text, key)}
          </blockquote>
        );
      case 'list': {
        const ListTag = block.ordered ? 'ol' : 'ul';
        return (
          <ListTag key={key} className="md-list">
            {block.items.map((item, itemIndex) => (
              <li key={`${key}-item-${itemIndex}`}>
                {renderInlineWithBreaks(item, `${key}-item-${itemIndex}`)}
              </li>
            ))}
          </ListTag>
        );
      }
      case 'hr':
        return <hr key={key} className="md-hr" />;
      case 'table':
        return (
          <div key={key} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {block.headers.map((header, headerIndex) => (
                    <th key={`${key}-head-${headerIndex}`}>
                      {renderInlineWithBreaks(header, `${key}-head-${headerIndex}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={`${key}-row-${rowIndex}`}>
                    {block.headers.map((_, cellIndex) => (
                      <td key={`${key}-row-${rowIndex}-cell-${cellIndex}`}>
                        {renderInlineWithBreaks(
                          row[cellIndex] ?? '',
                          `${key}-row-${rowIndex}-cell-${cellIndex}`,
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return null;
    }
  });
}
