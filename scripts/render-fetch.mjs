#!/usr/bin/env node
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_POST_WAIT_MS = 1200;
const DEFAULT_WAIT_UNTIL = 'domcontentloaded';
const DEFAULT_SELECTOR_TIMEOUT_MS = 10000;
const DEFAULT_VIEWPORT_WIDTH = 1440;
const DEFAULT_VIEWPORT_HEIGHT = 1200;

function printHelp() {
  console.error(`
Usage:
  node scripts/render-fetch.mjs <url>

Environment:
  RENDER_FETCH_TIMEOUT_MS   Overall timeout in ms, default ${DEFAULT_TIMEOUT_MS}
  RENDER_FETCH_POST_WAIT_MS Extra wait after navigation, default ${DEFAULT_POST_WAIT_MS}
  RENDER_FETCH_WAIT_UNTIL   load | domcontentloaded | networkidle, default ${DEFAULT_WAIT_UNTIL}
  RENDER_FETCH_WAIT_SELECTOR Optional CSS selector to wait for before reading content
  RENDER_FETCH_SELECTOR_TIMEOUT_MS Timeout for wait selector, default ${DEFAULT_SELECTOR_TIMEOUT_MS}
  RENDER_FETCH_USER_AGENT   Optional browser user-agent override
  RENDER_FETCH_HEADERS_JSON Optional JSON object of extra HTTP headers
  RENDER_FETCH_VIEWPORT     Optional viewport, format WIDTHxHEIGHT, default ${DEFAULT_VIEWPORT_WIDTH}x${DEFAULT_VIEWPORT_HEIGHT}

Output:
  JSON to stdout:
    {"body":"<html>...</html>","contentType":"text/html","finalUrl":"https://..."}

Notes:
  This script requires either "playwright" or "puppeteer" to already be installed
  in the current project/runtime environment. It does not add those dependencies itself.
`.trim());
}

function fail(message, cause) {
  console.error(message);
  if (cause) {
    console.error(cause instanceof Error ? cause.stack || cause.message : String(cause));
  }
  process.exit(1);
}

function readBoundedInt(name, fallback, min, max) {
  const parsed = Number.parseInt(String(process.env[name] || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function readWaitUntil() {
  const value = String(process.env.RENDER_FETCH_WAIT_UNTIL || '')
    .trim()
    .toLowerCase();
  if (value === 'load' || value === 'domcontentloaded' || value === 'networkidle') {
    return value;
  }
  return DEFAULT_WAIT_UNTIL;
}

function readViewport() {
  const raw = String(process.env.RENDER_FETCH_VIEWPORT || '').trim();
  if (!raw) {
    return { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT };
  }

  const match = raw.match(/^(\d{2,5})[x,](\d{2,5})$/i);
  if (!match) {
    return { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT };
  }

  const width = Math.max(320, Math.min(4096, Number.parseInt(match[1], 10)));
  const height = Math.max(320, Math.min(4096, Number.parseInt(match[2], 10)));
  return { width, height };
}

function readHeaders() {
  const raw = String(process.env.RENDER_FETCH_HEADERS_JSON || '').trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    const headers = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.trim()) continue;
      headers[key] = String(value ?? '');
    }
    return headers;
  } catch (error) {
    fail('Invalid RENDER_FETCH_HEADERS_JSON', error);
  }
}

async function tryImport(moduleName) {
  try {
    return await import(moduleName);
  } catch {
    return null;
  }
}

async function loadBrowserBackend() {
  const playwright = await tryImport('playwright');
  if (playwright?.chromium) {
    return {
      name: 'playwright',
      launch: async () => {
        const browser = await playwright.chromium.launch({ headless: true });
        return {
          browser,
          newPage: async () => browser.newPage(),
          close: async () => browser.close(),
        };
      },
    };
  }

  const puppeteer = await tryImport('puppeteer');
  if (puppeteer?.launch) {
    return {
      name: 'puppeteer',
      launch: async () => {
        const browser = await puppeteer.launch({ headless: true });
        return {
          browser,
          newPage: async () => browser.newPage(),
          close: async () => browser.close(),
        };
      },
    };
  }

  throw new Error(
    'Neither "playwright" nor "puppeteer" is installed. Install one of them before using scripts/render-fetch.mjs.',
  );
}

async function main() {
  const arg = String(process.argv[2] || '').trim();
  if (!arg || arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(arg ? 0 : 1);
  }

  let targetUrl;
  try {
    targetUrl = new URL(arg).toString();
  } catch {
    fail(`Invalid URL: ${arg}`);
  }

  const timeoutMs = readBoundedInt(
    'RENDER_FETCH_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
    1000,
    120000,
  );
  const postWaitMs = readBoundedInt(
    'RENDER_FETCH_POST_WAIT_MS',
    DEFAULT_POST_WAIT_MS,
    0,
    30000,
  );
  const waitUntil = readWaitUntil();
  const waitSelector = String(process.env.RENDER_FETCH_WAIT_SELECTOR || '').trim();
  const selectorTimeoutMs = readBoundedInt(
    'RENDER_FETCH_SELECTOR_TIMEOUT_MS',
    DEFAULT_SELECTOR_TIMEOUT_MS,
    100,
    120000,
  );
  const userAgent = String(process.env.RENDER_FETCH_USER_AGENT || '').trim();
  const extraHeaders = readHeaders();
  const viewport = readViewport();

  const timeoutHandle = setTimeout(() => {
    fail(`render-fetch timed out after ${timeoutMs}ms`);
  }, timeoutMs + 1000);

  let runtime = null;
  try {
    const backend = await loadBrowserBackend();
    runtime = await backend.launch();
    const page = await runtime.newPage();
    await page.setViewport?.(viewport);
    if (userAgent) {
      await page.setUserAgent?.(userAgent);
    }
    if (Object.keys(extraHeaders).length > 0) {
      await page.setExtraHTTPHeaders?.(extraHeaders);
    }

    const response = await page.goto(targetUrl, {
      waitUntil,
      timeout: timeoutMs,
    });
    if (waitSelector) {
      await page.waitForSelector?.(waitSelector, {
        timeout: selectorTimeoutMs,
      });
    }
    if (postWaitMs > 0) {
      await page.waitForTimeout?.(postWaitMs);
      if (!page.waitForTimeout) {
        await new Promise((resolve) => setTimeout(resolve, postWaitMs));
      }
    }

    const body = await page.content();
    const finalUrl = page.url();
    const contentType =
      response?.headers?.()['content-type'] ||
      response?.headers?.()['Content-Type'] ||
      'text/html; charset=utf-8';

    process.stdout.write(
      JSON.stringify({
        body,
        contentType,
        finalUrl,
        metadata: {
          backend: backend.name,
          waitUntil,
          waitSelector: waitSelector || null,
          viewport,
        },
      }),
    );
  } catch (error) {
    fail('render-fetch failed', error);
  } finally {
    clearTimeout(timeoutHandle);
    await runtime?.close?.().catch(() => {});
  }
}

await main();
