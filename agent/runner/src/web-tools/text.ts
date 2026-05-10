import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

import {
  decodeHtml,
  normalizeWhitespace,
  type ExtractedContent,
} from './shared.js';

export function stripHtml(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|section|article|main|h\d|pre|blockquote)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' '),
  );
}

export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return normalizeWhitespace((match?.[1] || '').replace(/<[^>]+>/g, ' '));
}

function collectCandidateBlocks(html: string): string[] {
  const candidates: string[] = [];
  const patterns = [
    /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    /<section\b[^>]*(class|id)=["'][^"']*(content|article|post|doc|entry|markdown|body)[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi,
    /<div\b[^>]*(class|id)=["'][^"']*(content|article|post|doc|entry|markdown|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const block = match[match.length - 1] || '';
      if (block) candidates.push(block);
    }
  }

  return candidates;
}

function dedupeParagraphs(text: string): string {
  const seen = new Set<string>();
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  const deduped: string[] = [];
  for (const paragraph of paragraphs) {
    if (seen.has(paragraph)) continue;
    seen.add(paragraph);
    deduped.push(paragraph);
  }
  return deduped.join('\n\n');
}

export function extractReadableContentLegacy(html: string): ExtractedContent {
  const title = extractTitle(html);
  const candidateTexts = collectCandidateBlocks(html)
    .map((block) => stripHtml(block))
    .map((text) => dedupeParagraphs(text))
    .filter((text) => text.length >= 200);

  const fullText = dedupeParagraphs(stripHtml(html));
  const text = candidateTexts.sort((a, b) => b.length - a.length)[0] || fullText;
  return { title, text: text || fullText };
}

function buildTurndownService(): InstanceType<typeof TurndownService> {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  const noiseTags = ['script', 'style', 'nav', 'footer', 'header', 'aside'] as const;
  for (const tag of noiseTags) {
    turndownService.addRule(`strip-${tag}`, {
      filter: tag,
      replacement: () => '',
    });
  }
  return turndownService;
}

export function extractReadableContentV2(html: string): ExtractedContent {
  try {
    const dom = new JSDOM(html, {
      url: 'https://example.invalid/',
    });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article?.content || !String(article.content).trim()) {
      return extractReadableContentLegacy(html);
    }

    const contentHtml = String(article.content);
    const contentDom = new JSDOM(
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${contentHtml}</body></html>`,
      { url: 'https://example.invalid/' },
    );
    const body = contentDom.window.document.body;
    for (const tag of ['script', 'style', 'nav', 'footer', 'header', 'aside'] as const) {
      body.querySelectorAll(tag).forEach((el) => el.remove());
    }

    const turndownService = buildTurndownService();
    const markdownRaw = turndownService.turndown(body.innerHTML);
    const markdown = normalizeWhitespace(markdownRaw);
    const title = normalizeWhitespace(String(article.title || extractTitle(html)));
    const text = normalizeWhitespace(
      String(article.textContent || stripHtml(contentHtml)),
    );

    const result: ExtractedContent = { title, text };
    if (markdown) {
      result.markdown = markdown;
    }
    return result;
  } catch {
    return extractReadableContentLegacy(html);
  }
}

export function extractReadableContent(html: string): ExtractedContent {
  return extractReadableContentV2(html);
}

export function paginateText(text: string, pageSize: number): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  if (paragraphs.length === 0) return [''];

  const pages: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }
    const candidate = `${current}\n\n${paragraph}`;
    if (candidate.length <= pageSize) {
      current = candidate;
      continue;
    }
    pages.push(current);
    if (paragraph.length <= pageSize) {
      current = paragraph;
      continue;
    }

    let start = 0;
    while (start < paragraph.length) {
      const chunk = paragraph.slice(start, start + pageSize).trim();
      if (chunk) pages.push(chunk);
      start += pageSize;
    }
    current = '';
  }

  if (current) pages.push(current);
  return pages.length > 0 ? pages : [''];
}

export function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const decoded = decodeHtml(rawUrl);
    const candidate = decoded.startsWith('//')
      ? `https:${decoded}`
      : decoded.startsWith('/')
        ? `https://html.duckduckgo.com${decoded}`
        : decoded;
    const parsed = new URL(candidate);
    const redirectTarget = parsed.searchParams.get('uddg');
    return redirectTarget ? decodeURIComponent(redirectTarget) : candidate;
  } catch {
    return decodeHtml(rawUrl);
  }
}
