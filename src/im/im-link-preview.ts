import crypto from 'crypto';
import { dba } from '../db/engine-access.js';

export interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5000;

const MAX_REDIRECTS = 5;

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

function extractOgMeta(html: string): Partial<LinkPreviewData> {
  const result: Partial<LinkPreviewData> = {};
  const metaRe = /<meta\s+[^>]*?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*?)["'][^>]*\/?>/gi;
  const metaRe2 = /<meta\s+[^>]*?content\s*=\s*["']([^"']*?)["'][^>]*?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;

  const pairs: Array<[string, string]> = [];
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html))) pairs.push([m[1]!, m[2]!]);
  while ((m = metaRe2.exec(html))) pairs.push([m[2]!, m[1]!]);

  for (const [prop, content] of pairs) {
    const key = prop.toLowerCase();
    if (key === 'og:title' && !result.title) result.title = content;
    if (key === 'og:description' && !result.description) result.description = content;
    if (key === 'og:image' && !result.imageUrl) result.imageUrl = content;
    if (key === 'og:site_name' && !result.siteName) result.siteName = content;
  }

  if (!result.title) {
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    if (titleMatch) result.title = titleMatch[1]!.trim();
  }
  if (!result.description) {
    for (const [prop, content] of pairs) {
      if (prop.toLowerCase() === 'description') {
        result.description = content;
        break;
      }
    }
  }

  return result;
}

export async function fetchLinkPreview(url: string): Promise<LinkPreviewData | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (isSsrfTarget(parsed.hostname)) return null;

  const urlHash = crypto.createHash('sha256').update(url).digest('hex');

  const cached = (await dba
    .prepare(
      `SELECT url, title, description, image_url, site_name, fetched_at FROM im_link_previews WHERE url_hash = ? LIMIT 1`,
    )
    .get(urlHash)) as {
    url: string;
    title: string | null;
    description: string | null;
    image_url: string | null;
    site_name: string | null;
    fetched_at: string;
  } | undefined;

  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < CACHE_TTL_MS) {
      return {
        url: cached.url,
        title: cached.title,
        description: cached.description,
        imageUrl: cached.image_url,
        siteName: cached.site_name,
      };
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let currentUrl = url;
    let resp: Response | null = null;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      resp = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'NanoClawBot/1.0 (LinkPreview)',
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'manual',
      });
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) break;
        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') return null;
        if (isSsrfTarget(nextUrl.hostname)) return null;
        currentUrl = nextUrl.toString();
        continue;
      }
      break;
    }
    clearTimeout(timer);

    if (!resp || !resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('text/html') && !ct.includes('xhtml')) return null;

    const html = await resp.text();
    const og = extractOgMeta(html.slice(0, 50_000));

    const result: LinkPreviewData = {
      url,
      title: og.title?.slice(0, 200) ?? null,
      description: og.description?.slice(0, 500) ?? null,
      imageUrl: og.imageUrl?.slice(0, 2000) ?? null,
      siteName: og.siteName?.slice(0, 100) ?? null,
    };

    const now = new Date().toISOString();
    await dba
      .prepare(
        `INSERT OR REPLACE INTO im_link_previews (url_hash, url, title, description, image_url, site_name, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(urlHash, url, result.title, result.description, result.imageUrl, result.siteName, now);

    return result;
  } catch {
    return null;
  }
}
