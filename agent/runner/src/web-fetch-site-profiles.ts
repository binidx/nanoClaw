import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type BrowserFetchProviderOverride = 'basic' | 'browser_cli';
export type BrowserFetchWaitUntil =
  | 'load'
  | 'domcontentloaded'
  | 'networkidle';

export interface BrowserFetchSiteProfile {
  domains: string[];
  pathPrefixes: string[];
  forceProvider?: BrowserFetchProviderOverride;
  waitSelector: string;
  selectorTimeoutMs?: number;
  postWaitMs?: number;
  waitUntil?: BrowserFetchWaitUntil;
  viewport: string;
  userAgent: string;
}

export interface BrowserFetchSiteProfilePreset {
  id: string;
  label: string;
  profile: BrowserFetchSiteProfile;
}

const SHARED_PROFILES_RELATIVE_PATH = path.join(
  'shared',
  'web-fetch-site-profiles.json',
);

export function resolveProfilesFilePath(
  currentDir = path.dirname(fileURLToPath(import.meta.url)),
  projectRoot = process.env.NANOCLAW_PROJECT_ROOT,
): string {
  const candidates = [
    projectRoot ? path.resolve(projectRoot, SHARED_PROFILES_RELATIVE_PATH) : '',
    path.resolve(process.cwd(), SHARED_PROFILES_RELATIVE_PATH),
    path.resolve(currentDir, '../../../../shared/web-fetch-site-profiles.json'),
    path.resolve(currentDir, '../../../../../shared/web-fetch-site-profiles.json'),
    path.resolve(currentDir, '../../../shared/web-fetch-site-profiles.json'),
  ].filter(
    (candidate, index, all): candidate is string =>
      Boolean(candidate) && all.indexOf(candidate) === index,
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Builtin web fetch site profiles file not found. Tried: ${candidates.join(', ')}`,
  );
}

export function loadBuiltinBrowserSiteProfilePresets(): BrowserFetchSiteProfilePreset[] {
  const filePath = resolveProfilesFilePath();
  return JSON.parse(
    fs.readFileSync(filePath, 'utf8'),
  ) as BrowserFetchSiteProfilePreset[];
}

export const BUILTIN_BROWSER_SITE_PROFILES: BrowserFetchSiteProfile[] =
  loadBuiltinBrowserSiteProfilePresets().map((entry) => entry.profile);
