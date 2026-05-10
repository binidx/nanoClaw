import * as cheerio from 'cheerio';
import { createModuleLogger } from '../logger.js';
import { indexDocument } from './pipeline.js';
import { findDocumentBySourceUrl } from '../db.js';
import { cleanContent, buildBoilerplateFilter } from './content-cleaner.js';
import type { KnowledgeLimits } from './limits.js';
import { t } from '../i18n/index.js';

const logger = createModuleLogger('knowledge');

const USER_AGENT = 'NanoClaw-KB-Importer/1.0';
const MAX_HTML_SIZE = 5 * 1024 * 1024;

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\./,
  /^::1$/,
  /^localhost$/i,
  /^fc00:/i,
  /^fe80:/i,
  /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i,
  /^metadata\.google\.internal$/i,
];

function isSsrfTarget(hostname: string): boolean {
  return PRIVATE_IP_PATTERNS.some((p) => p.test(hostname));
}

const REMOVE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'svg',
  'nav', 'header', 'footer',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '.sidebar', '.menu', '.breadcrumb', '.pagination',
].join(', ');

// ---------------------------------------------------------------------------
// Link / URL helpers
// ---------------------------------------------------------------------------

function canonicalizeUrl(href: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Given a seed URL like `/help/article/foo`, infer a path prefix `/help/article/`
 * so sibling pages can be prioritized in BFS.
 */
function inferPathPrefix(seedUrl: string): string {
  const parsed = new URL(seedUrl);
  const segments = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.length <= 1) return '/';
  return '/' + segments.slice(0, -1).join('/') + '/';
}

function matchesPathPrefix(url: string, prefix: string): boolean {
  try {
    return new URL(url).pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

interface ParseResult {
  title: string;
  text: string;
  links: string[];
  meta: Record<string, string>;
}

// Mirrors `metadata-extractor.META_DATE_KEYS`; collecting more here would
// silently drop into the meta map without any consumer.
const META_KEYS_TO_COLLECT = [
  'article:published_time',
  'og:updated_time',
  'datePublished',
] as const;

function extractHtmlMeta($: cheerio.CheerioAPI): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const key of META_KEYS_TO_COLLECT) {
    const byProp = $(`meta[property="${key}"]`).attr('content')?.trim();
    if (byProp) { meta[key] = byProp; continue; }
    const byName = $(`meta[name="${key}"]`).attr('content')?.trim();
    if (byName) meta[key] = byName;
  }
  return meta;
}

function parseHtml(html: string, url: string): ParseResult {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim()
    || $('meta[property="og:title"]').attr('content')?.trim()
    || new URL(url).pathname;

  const meta = extractHtmlMeta($);

  const base = new URL(url);
  const seen = new Set<string>();
  const links: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const canonical = canonicalizeUrl(href, url);
    if (!canonical) return;
    try {
      if (new URL(canonical).hostname !== base.hostname) return;
    } catch { return; }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      links.push(canonical);
    }
  });

  $(REMOVE_SELECTORS).remove();
  const mainEl = $('article, main, [role="main"]').first();
  const root = mainEl.length ? mainEl : $('body');
  const text = root
    .text()
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text, links, meta };
}

/**
 * Scan raw HTML/JS source for URL paths matching a pattern prefix.
 * Useful for SPAs that embed route data in JavaScript bundles.
 */
function scanSourceForUrls(html: string, origin: string, hostname: string, pathPrefix: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const escapedPrefix = pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:["'\`])((${escapedPrefix}[^"'\`\\s<>{}()]*))`, 'g');

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const path = match[1];
    if (!path || path.includes('{{') || path.includes('${')) continue;
    try {
      const fullUrl = new URL(path, origin).toString();
      if (new URL(fullUrl).hostname !== hostname) continue;
      const canonical = canonicalizeUrl(fullUrl, origin);
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        found.push(canonical);
      }
    } catch { /* skip */ }
  }

  const fullUrlPattern = new RegExp(`https?://${hostname.replace(/\./g, '\\.')}${escapedPrefix}[^"'\`\\s<>{}()]*`, 'g');
  while ((match = fullUrlPattern.exec(html)) !== null) {
    const url = match[0];
    const canonical = canonicalizeUrl(url, origin);
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      found.push(canonical);
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;

function validateUrl(urlStr: string): URL {
  const parsed = new URL(urlStr);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(t('knowledge.unsupportedProtocol', { protocol: parsed.protocol }, undefined));
  }
  if (isSsrfTarget(parsed.hostname)) {
    throw new Error(t('knowledge.restrictedHost', { host: parsed.hostname }, undefined));
  }
  return parsed;
}

async function fetchPage(url: string, timeoutMs = 15_000): Promise<string> {
  validateUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = url;

    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const res = await fetch(currentUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
        signal: controller.signal,
        redirect: 'manual',
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(t('knowledge.redirectMissingLocation', {}, undefined));
        const nextUrl = new URL(location, currentUrl).toString();
        validateUrl(nextUrl);
        currentUrl = nextUrl;
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml')) {
        throw new Error(t('knowledge.unsupportedContentType', { contentType: ct }, undefined));
      }

      const arrayBuf = await res.arrayBuffer();
      if (arrayBuf.byteLength > MAX_HTML_SIZE) {
        throw new Error(
          t(
            'knowledge.pageTooLarge',
            { sizeMb: (arrayBuf.byteLength / 1024 / 1024).toFixed(1) },
            undefined,
          ),
        );
      }

      const charsetMatch = ct.match(/charset=([^\s;]+)/i);
      const encoding = charsetMatch?.[1] || 'utf-8';
      return new TextDecoder(encoding).decode(arrayBuf);
    }

    throw new Error(t('knowledge.redirectLimitExceeded', { count: MAX_REDIRECTS }, undefined));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Sitemap discovery
// ---------------------------------------------------------------------------

const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap.txt'];
const MAX_SITEMAP_SIZE = 5 * 1024 * 1024;

async function fetchWithSsrfGuard(url: string, timeoutMs: number): Promise<Response> {
  validateUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = url;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const res = await fetch(currentUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(t('knowledge.auto_afd780', {}, undefined));
        const nextUrl = new URL(location, currentUrl).toString();
        validateUrl(nextUrl);
        currentUrl = nextUrl;
        continue;
      }
      return res;
    }
    throw new Error(t('knowledge.redirectLimitExceeded', { count: MAX_REDIRECTS }, undefined));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSitemapBody(sitemapUrl: string, timeoutMs = 15_000): Promise<string | null> {
  const res = await fetchWithSsrfGuard(sitemapUrl, timeoutMs);
  if (!res.ok) return null;

  const arrayBuf = await res.arrayBuffer();
  if (arrayBuf.byteLength > MAX_SITEMAP_SIZE) {
    logger.warn({ sitemapUrl, size: arrayBuf.byteLength }, 'Sitemap too large, skipping');
    return null;
  }
  return new TextDecoder('utf-8').decode(arrayBuf);
}

const MAX_SITEMAP_DEPTH = 2;

function parseSitemapXml(body: string, hostname: string): { pageUrls: string[]; childSitemapUrls: string[] } {
  const $ = cheerio.load(body, { xmlMode: true });
  const pageUrls: string[] = [];
  const childSitemapUrls: string[] = [];

  $('sitemap > loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (!loc) return;
    try {
      if (new URL(loc).hostname === hostname) childSitemapUrls.push(loc);
    } catch { /* skip */ }
  });

  $('url > loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (!loc) return;
    try {
      if (new URL(loc).hostname === hostname) pageUrls.push(loc);
    } catch { /* skip */ }
  });

  return { pageUrls, childSitemapUrls };
}

async function trySitemap(origin: string, hostname: string, fetchTimeout = 15_000): Promise<string[]> {
  const urls: string[] = [];

  for (const path of SITEMAP_PATHS) {
    try {
      const sitemapUrl = origin + path;
      const body = await fetchSitemapBody(sitemapUrl, fetchTimeout);
      if (!body) continue;

      if (path.endsWith('.txt')) {
        for (const line of body.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('http')) {
            try {
              if (new URL(trimmed).hostname === hostname) urls.push(trimmed);
            } catch { /* skip */ }
          }
        }
      } else {
        const { pageUrls, childSitemapUrls } = parseSitemapXml(body, hostname);
        urls.push(...pageUrls);

        const childQueue = childSitemapUrls.map((u) => ({ url: u, depth: 1 }));
        while (childQueue.length > 0) {
          const child = childQueue.shift()!;
          if (child.depth > MAX_SITEMAP_DEPTH) continue;
          try {
            const childBody = await fetchSitemapBody(child.url, fetchTimeout);
            if (!childBody) continue;
            const parsed = parseSitemapXml(childBody, hostname);
            urls.push(...parsed.pageUrls);
            if (child.depth < MAX_SITEMAP_DEPTH) {
              for (const sub of parsed.childSitemapUrls) {
                childQueue.push({ url: sub, depth: child.depth + 1 });
              }
            }
          } catch {
            /* child sitemap fetch failed, skip */
          }
        }
      }

      if (urls.length > 0) {
        logger.info({ sitemapUrl, count: urls.length }, 'Sitemap discovered');
        break;
      }
    } catch {
      /* sitemap not available, try next */
    }
  }

  return urls;
}

// ---------------------------------------------------------------------------
// Jina Reader fallback for SPA / JS-rendered pages
// ---------------------------------------------------------------------------

interface JinaResult {
  title: string;
  text: string;
  links: string[];
}

const MIN_STATIC_TEXT_LENGTH = 100;
const MIN_STATIC_LINKS = 3;

async function fetchViaJina(url: string, hostname: string, timeoutMs = 30_000): Promise<JinaResult | null> {
  try {
    const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(jinaUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/plain',
        },
        signal: controller.signal,
      });

      if (!res.ok) return null;

      const markdown = await res.text();
      if (!markdown || markdown.length < MIN_STATIC_TEXT_LENGTH) return null;

      const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || new URL(url).pathname;

      const links: string[] = [];
      const linkPattern = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
      let match: RegExpExecArray | null;
      while ((match = linkPattern.exec(markdown)) !== null) {
        const linkUrl = match[2];
        try {
          if (new URL(linkUrl).hostname === hostname) {
            const canonical = canonicalizeUrl(linkUrl, url);
            if (canonical && !links.includes(canonical)) links.push(canonical);
          }
        } catch { /* skip */ }
      }

      const bareUrlPattern = /^(https?:\/\/\S+)$/gm;
      while ((match = bareUrlPattern.exec(markdown)) !== null) {
        const linkUrl = match[1];
        try {
          if (new URL(linkUrl).hostname === hostname) {
            const canonical = canonicalizeUrl(linkUrl, url);
            if (canonical && !links.includes(canonical)) links.push(canonical);
          }
        } catch { /* skip */ }
      }

      logger.info({ url, textLen: markdown.length, links: links.length }, 'Jina Reader fallback used');
      return { title, text: markdown, links };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.debug({ url, err }, 'Jina Reader fallback failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main import logic
// ---------------------------------------------------------------------------

export interface UrlImportResult {
  url: string;
  title: string;
  documentId: string | null;
  error?: string;
  skipped?: boolean;
}

export interface UrlImportOptions {
  kbId: string;
  url: string;
  maxDepth?: number;
  maxPages?: number;
  force?: boolean;
  limits: KnowledgeLimits;
}

interface CrawledPage {
  url: string;
  title: string;
  text: string;
  contentType: string;
  existingId?: string;
  meta?: Record<string, string>;
}

export async function importFromUrl(opts: UrlImportOptions): Promise<UrlImportResult[]> {
  const { kbId, url, maxDepth: rawDepth = 0, maxPages = 20, force = false, limits } = opts;
  const maxDepth = Math.min(rawDepth, limits.maxCrawlDepth);
  const limit = Math.min(maxPages, limits.maxImportPages);
  const maxVisited = limit * 3;
  const visited = new Set<string>();
  const results: UrlImportResult[] = [];
  const crawled: CrawledPage[] = [];

  const seedParsed = new URL(url);
  const hostname = seedParsed.hostname;
  const origin = seedParsed.origin;
  const pathPrefix = inferPathPrefix(url);

  const queue: Array<{ url: string; depth: number; priority: number }> = [
    { url, depth: 0, priority: 0 },
  ];

  if (maxDepth > 0) {
    try {
      const sitemapUrls = await trySitemap(origin, hostname, limits.fetchTimeoutMs);
      const prefixMatches = sitemapUrls.filter((u) => matchesPathPrefix(u, pathPrefix));
      const toAdd = prefixMatches.length > 0 ? prefixMatches : sitemapUrls;

      for (const surl of toAdd.slice(0, limit * 2)) {
        const canonical = canonicalizeUrl(surl, url);
        if (canonical && !visited.has(canonical)) {
          queue.push({ url: canonical, depth: 1, priority: matchesPathPrefix(canonical, pathPrefix) ? 1 : 2 });
        }
      }

      if (toAdd.length > 0) {
        logger.info({ prefix: pathPrefix, added: Math.min(toAdd.length, limit * 2) }, 'Sitemap URLs added to queue');
      }
    } catch (err) {
      logger.debug({ err }, 'Sitemap discovery failed');
    }
  }

  // ── Phase 1: concurrent crawl & collect pages ──────────────────────
  const CRAWL_CONCURRENCY = limits.crawlConcurrency;

  async function crawlOne(item: { url: string; depth: number; priority: number }): Promise<void> {
    try {
      const existing = await findDocumentBySourceUrl(kbId, item.url);
      if (existing && !force) {
        results.push({ url: item.url, title: existing.filename, documentId: null, skipped: true });
        return;
      }

      let title: string;
      let text: string;
      let links: string[];
      let meta: Record<string, string>;
      let usedJina = false;

      const html = await fetchPage(item.url, limits.fetchTimeoutMs);
      const parsed = parseHtml(html, item.url);
      title = parsed.title;
      text = parsed.text;
      links = parsed.links;
      meta = parsed.meta;

      const isSeedPage = item.depth === 0;

      if (isSeedPage && maxDepth > 0 && pathPrefix.length > 1) {
        const scannedUrls = scanSourceForUrls(html, origin, hostname, pathPrefix);
        if (scannedUrls.length > 0) {
          const mergedLinks = new Set(links);
          for (const su of scannedUrls) mergedLinks.add(su);
          links = [...mergedLinks];
          logger.info({ scanned: scannedUrls.length, merged: links.length }, 'URL pattern scan found additional links');
        }
      }

      const staticContentWeak = text.length < MIN_STATIC_TEXT_LENGTH;
      const staticLinksWeak = links.length < MIN_STATIC_LINKS;
      const needJinaFallback = staticContentWeak
        || (isSeedPage && maxDepth > 0)
        || (staticLinksWeak && isSeedPage)
        || (staticLinksWeak && item.depth < maxDepth);

      if (needJinaFallback) {
        const jinaResult = await fetchViaJina(item.url, hostname, limits.jinaTimeoutMs);
        if (jinaResult) {
          if (jinaResult.text.length > text.length) {
            title = jinaResult.title || title;
            text = jinaResult.text;
            usedJina = true;
          }
          if (jinaResult.links.length > links.length) {
            const merged = new Set(links);
            for (const l of jinaResult.links) merged.add(l);
            links = [...merged];
          }
        }
      }

      if (!text || text.length < 50) {
        results.push({ url: item.url, title, documentId: null, error: t('knowledge.auto_8d1ade', {}, undefined) });
        return;
      }

      crawled.push({
        url: item.url,
        title,
        text,
        contentType: usedJina ? 'text/markdown' : 'text/html',
        existingId: existing?.id,
        meta,
      });

      if (item.depth < maxDepth && crawled.length < limit) {
        const prefixLinks = links.filter((l) => matchesPathPrefix(l, pathPrefix));
        const otherLinks = links.filter((l) => !matchesPathPrefix(l, pathPrefix));
        const sortedLinks = [...prefixLinks, ...otherLinks];

        const remaining = limit - crawled.length - queue.length;
        for (const link of sortedLinks.slice(0, Math.max(0, remaining))) {
          if (!visited.has(link)) {
            queue.push({
              url: link,
              depth: item.depth + 1,
              priority: matchesPathPrefix(link, pathPrefix) ? 1 : 2,
            });
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ url: item.url, err: msg }, 'URL import failed for page');
      results.push({ url: item.url, title: '', documentId: null, error: msg });
    }
  }

  while (queue.length > 0 && crawled.length < limit && visited.size < maxVisited) {
    queue.sort((a, b) => a.priority - b.priority);

    const batch: typeof queue = [];
    while (batch.length < CRAWL_CONCURRENCY && queue.length > 0 && crawled.length + batch.length < limit) {
      const item = queue.shift()!;
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      batch.push(item);
    }

    if (batch.length === 0) break;
    await Promise.allSettled(batch.map(crawlOne));
  }

  // ── Phase 2: cross-document boilerplate removal + clean + index ─────

  const { getKnowledgeBase } = await import('../db.js');
  const kb = await getKnowledgeBase(kbId);
  const kbCleanupPatterns = kb?.cleanup_patterns ?? null;

  const stripBoilerplate = buildBoilerplateFilter(crawled.map((p) => p.text));

  const INDEX_CONCURRENCY = CRAWL_CONCURRENCY;

  async function indexOne(page: CrawledPage): Promise<void> {
    try {
      const stripped = stripBoilerplate(page.text);
      const cleaned = cleanContent(stripped, kbCleanupPatterns);
      if (!cleaned || cleaned.length < 50) {
        results.push({ url: page.url, title: page.title, documentId: null, error: t('knowledge.auto_84e9d2', {}, undefined) });
        return;
      }

      const doc = await indexDocument(
        kbId,
        page.title || page.url,
        cleaned,
        page.contentType,
        page.url,
        { htmlMeta: page.meta },
      );

      if (page.existingId) {
        try {
          const { deleteKnowledgeDocument } = await import('../db.js');
          await deleteKnowledgeDocument(page.existingId);
        } catch (delErr) {
          logger.error({ url: page.url, oldId: page.existingId, newId: doc.id, err: delErr },
            'Failed to delete old document after successful re-index; rolling back new document');
          try {
            const { deleteKnowledgeDocument } = await import('../db.js');
            await deleteKnowledgeDocument(doc.id);
          } catch { /* best-effort rollback */ }
          const msg = delErr instanceof Error ? delErr.message : String(delErr);
          results.push({
            url: page.url,
            title: page.title,
            documentId: null,
            error: t('knowledge.oldDocumentDeleteFailed', { message: msg }, undefined),
          });
          return;
        }
      }

      results.push({ url: page.url, title: page.title, documentId: doc.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ url: page.url, err: msg }, 'Document indexing failed after cleanup');
      results.push({ url: page.url, title: page.title, documentId: null, error: msg });
    }
  }

  for (let i = 0; i < crawled.length; i += INDEX_CONCURRENCY) {
    const batch = crawled.slice(i, i + INDEX_CONCURRENCY);
    await Promise.allSettled(batch.map(indexOne));
  }

  return results;
}
