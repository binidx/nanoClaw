import { getConfigValues } from '../config-store.js';

const KB_CONFIG_KEYS = [
  'KB_MAX_FILE_SIZE_MB',
  'KB_MAX_ZIP_SIZE_MB',
  'KB_MAX_ZIP_FILES',
  'KB_MAX_IMPORT_PAGES',
  'KB_MAX_CRAWL_DEPTH',
  'KB_CRAWL_CONCURRENCY',
  'KB_FETCH_TIMEOUT_MS',
  'KB_JINA_TIMEOUT_MS',
] as const;

export interface KnowledgeLimits {
  maxFileSizeBytes: number;
  maxZipSizeBytes: number;
  maxZipFiles: number;
  maxImportPages: number;
  maxCrawlDepth: number;
  crawlConcurrency: number;
  fetchTimeoutMs: number;
  jinaTimeoutMs: number;
}

export interface KnowledgeLimitsRaw {
  maxFileSizeMb: number;
  maxZipSizeMb: number;
  maxZipFiles: number;
  maxImportPages: number;
  maxCrawlDepth: number;
  crawlConcurrency: number;
  fetchTimeoutMs: number;
  jinaTimeoutMs: number;
}

function int(val: string, fallback: number, min = 1): number {
  const n = Number(val);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export async function getKnowledgeLimits(): Promise<KnowledgeLimits> {
  const cfg = await getConfigValues([...KB_CONFIG_KEYS]);
  const fileMb = int(cfg.KB_MAX_FILE_SIZE_MB, 10);
  const zipMb = int(cfg.KB_MAX_ZIP_SIZE_MB, 50);
  return {
    maxFileSizeBytes: fileMb * 1024 * 1024,
    maxZipSizeBytes: zipMb * 1024 * 1024,
    maxZipFiles: int(cfg.KB_MAX_ZIP_FILES, 200),
    maxImportPages: int(cfg.KB_MAX_IMPORT_PAGES, 500),
    maxCrawlDepth: int(cfg.KB_MAX_CRAWL_DEPTH, 3, 0),
    crawlConcurrency: Math.min(int(cfg.KB_CRAWL_CONCURRENCY, 3), 20),
    fetchTimeoutMs: int(cfg.KB_FETCH_TIMEOUT_MS, 15000, 1000),
    jinaTimeoutMs: int(cfg.KB_JINA_TIMEOUT_MS, 30000, 1000),
  };
}

export async function getKnowledgeLimitsRaw(): Promise<KnowledgeLimitsRaw> {
  const cfg = await getConfigValues([...KB_CONFIG_KEYS]);
  return {
    maxFileSizeMb: int(cfg.KB_MAX_FILE_SIZE_MB, 10),
    maxZipSizeMb: int(cfg.KB_MAX_ZIP_SIZE_MB, 50),
    maxZipFiles: int(cfg.KB_MAX_ZIP_FILES, 200),
    maxImportPages: int(cfg.KB_MAX_IMPORT_PAGES, 500),
    maxCrawlDepth: int(cfg.KB_MAX_CRAWL_DEPTH, 3, 0),
    crawlConcurrency: Math.min(int(cfg.KB_CRAWL_CONCURRENCY, 3), 20),
    fetchTimeoutMs: int(cfg.KB_FETCH_TIMEOUT_MS, 15000, 1000),
    jinaTimeoutMs: int(cfg.KB_JINA_TIMEOUT_MS, 30000, 1000),
  };
}
