import crypto from 'crypto';
import { t } from '../i18n/index.js';

/**
 * Strips boilerplate (navigation, feedback forms, repeated templates)
 * from scraped web content before chunking.
 *
 * Two-pass design:
 *   1. `cleanContent()` — per-document static pattern removal
 *   2. `buildBoilerplateFilter()` + `stripBoilerplate()` — cross-document
 *      dedup: learns which text blocks repeat across many documents in the
 *      same import batch and strips them.
 */

// ── Per-document cleaning ─────────────────────────────────────────────

const MIN_MEANINGFUL_LENGTH = 40;

const TAIL_BOILERPLATE_SIGNALS = [
  /是否对您有帮助/,
  /未能解决你的问题/,
  /联系我们/,
  /找不到描述的入口/,
  /以上都不是/,
  /咨询\s*电话/,
];

const TAIL_CONFIRM_SIGNALS = [
  /提交/,
  /暂时没有/,
  /有帮助/,
  /无帮助/,
  /\d{3,4}[-\s]?\d{3,4}[-\s]?\d{3,4}/,
];

function isTailBoilerplate(paragraph: string): boolean {
  const primary = TAIL_BOILERPLATE_SIGNALS.filter((r) => r.test(paragraph)).length;
  const confirm = TAIL_CONFIRM_SIGNALS.filter((r) => r.test(paragraph)).length;
  return primary >= 1 && confirm >= 1;
}

const NAV_BREADCRUMB_RE = /^上一篇\s+\S+\s+下一篇\s+\S+$/;
const EMPTY_PAGE_RE = /^暂无数据[\s\S]{0,100}找不到您要找的页面/;

const HEAD_NAV_KEYWORDS = [
  t('errors.auto_c39ced', {}, undefined), t('errors.auto_aec25b', {}, undefined), t('errors.auto_4a5267', {}, undefined), t('errors.auto_d4e541', {}, undefined), t('errors.auto_fe4416', {}, undefined),
  t('errors.auto_7964da', {}, undefined), t('errors.auto_6f4098', {}, undefined), t('errors.auto_50d52d', {}, undefined), t('errors.auto_7f72e8', {}, undefined), t('errors.auto_1ed104', {}, undefined),
  t('errors.auto_db1c89', {}, undefined), t('errors.auto_725965', {}, undefined), t('errors.auto_a7d800', {}, undefined), t('errors.auto_3b2e36', {}, undefined),
];

function isHeadNavParagraph(paragraph: string): boolean {
  if (paragraph.length > 80) return false;
  const words = paragraph.split(/[\s,，、;；|/]+/).filter(Boolean);
  if (words.length < 2 || words.length > 10) return false;
  const navHits = words.filter((w) => HEAD_NAV_KEYWORDS.some((k) => w.includes(k)));
  return navHits.length >= Math.ceil(words.length * 0.6);
}

/**
 * Per-document content cleaning. Only strips boilerplate from tail
 * paragraphs (last 5) to avoid false positives in body content.
 * @param customPatterns - newline-separated literal strings to strip,
 *   stored in knowledge_bases.cleanup_patterns
 */
export function cleanContent(raw: string, customPatterns?: string | null): string {
  let text = raw;

  if (customPatterns) {
    for (const line of customPatterns.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'g'), '');
    }
  }

  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  if (EMPTY_PAGE_RE.test(paragraphs[0] ?? '')) return '';

  const cleaned = paragraphs.filter((p, idx) => {
    if (NAV_BREADCRUMB_RE.test(p)) return false;
    if (idx < 3 && isHeadNavParagraph(p)) return false;
    const isTail = idx >= paragraphs.length - 5;
    return !(isTail && isTailBoilerplate(p));
  });

  const result = collapseWhitespace(cleaned.join('\n\n'));
  if (result.length < MIN_MEANINGFUL_LENGTH) return '';
  return result;
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ── Cross-document boilerplate detection ──────────────────────────────

const LINE_BLOCK_SIZE = 3;
const BOILERPLATE_THRESHOLD = 0.3;

/**
 * Scans a batch of documents and identifies text blocks that appear in
 * more than `threshold` fraction of documents. Returns a filter function
 * that strips those blocks from any given text.
 *
 * A "block" is a sliding window of `LINE_BLOCK_SIZE` consecutive non-empty
 * lines. This catches repeated headers, footers, sidebars, and ad copy
 * without needing exact full-document matching.
 */
export function buildBoilerplateFilter(
  documents: string[],
  threshold = BOILERPLATE_THRESHOLD,
): (text: string) => string {
  if (documents.length < 3) return (t) => t;

  const blockDocCount = new Map<string, number>();
  const minDocs = Math.max(2, Math.ceil(documents.length * threshold));

  for (const doc of documents) {
    const lines = doc.split('\n').filter((l) => l.trim().length > 0);
    const seen = new Set<string>();

    for (let i = 0; i <= lines.length - LINE_BLOCK_SIZE; i++) {
      const block = lines.slice(i, i + LINE_BLOCK_SIZE).map((l) => l.trim()).join('\n');
      const key = hashBlock(block);
      if (seen.has(key)) continue;
      seen.add(key);
      blockDocCount.set(key, (blockDocCount.get(key) ?? 0) + 1);
    }
  }

  const boilerplateKeys = new Set<string>();
  for (const [key, count] of blockDocCount) {
    if (count >= minDocs) boilerplateKeys.add(key);
  }

  if (boilerplateKeys.size === 0) return (t) => t;

  return (text: string): string => {
    const lines = text.split('\n');
    const nonEmpty = lines.map((l, i) => ({ line: l.trim(), idx: i })).filter((e) => e.line.length > 0);
    const removeLines = new Set<number>();

    for (let i = 0; i <= nonEmpty.length - LINE_BLOCK_SIZE; i++) {
      const block = nonEmpty.slice(i, i + LINE_BLOCK_SIZE).map((e) => e.line).join('\n');
      if (boilerplateKeys.has(hashBlock(block))) {
        for (let j = i; j < i + LINE_BLOCK_SIZE; j++) {
          removeLines.add(nonEmpty[j].idx);
        }
      }
    }

    if (removeLines.size === 0) return text;

    const cleaned = lines.filter((_, i) => !removeLines.has(i)).join('\n');
    return collapseWhitespace(cleaned);
  };
}

function hashBlock(block: string): string {
  return crypto.createHash('md5').update(block).digest('hex').slice(0, 12);
}

/**
 * Incremental boilerplate collector — feeds documents one-by-one so the
 * caller never needs to hold all texts in memory simultaneously.
 */
export class BoilerplateCollector {
  private blockDocCount = new Map<string, number>();
  private docCount = 0;
  private threshold: number;

  constructor(threshold = BOILERPLATE_THRESHOLD) {
    this.threshold = threshold;
  }

  addDocument(text: string): void {
    this.docCount++;
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const seen = new Set<string>();
    for (let i = 0; i <= lines.length - LINE_BLOCK_SIZE; i++) {
      const block = lines.slice(i, i + LINE_BLOCK_SIZE).map((l) => l.trim()).join('\n');
      const key = hashBlock(block);
      if (seen.has(key)) continue;
      seen.add(key);
      this.blockDocCount.set(key, (this.blockDocCount.get(key) ?? 0) + 1);
    }
  }

  buildFilter(): (text: string) => string {
    if (this.docCount < 3) return (t) => t;

    const minDocs = Math.max(2, Math.ceil(this.docCount * this.threshold));
    const boilerplateKeys = new Set<string>();
    for (const [key, count] of this.blockDocCount) {
      if (count >= minDocs) boilerplateKeys.add(key);
    }
    this.blockDocCount.clear();

    if (boilerplateKeys.size === 0) return (t) => t;

    return (text: string): string => {
      const lines = text.split('\n');
      const nonEmpty = lines.map((l, i) => ({ line: l.trim(), idx: i })).filter((e) => e.line.length > 0);
      const removeLines = new Set<number>();

      for (let i = 0; i <= nonEmpty.length - LINE_BLOCK_SIZE; i++) {
        const block = nonEmpty.slice(i, i + LINE_BLOCK_SIZE).map((e) => e.line).join('\n');
        if (boilerplateKeys.has(hashBlock(block))) {
          for (let j = i; j < i + LINE_BLOCK_SIZE; j++) {
            removeLines.add(nonEmpty[j].idx);
          }
        }
      }

      if (removeLines.size === 0) return text;
      const cleaned = lines.filter((_, idx) => !removeLines.has(idx)).join('\n');
      return collapseWhitespace(cleaned);
    };
  }
}
