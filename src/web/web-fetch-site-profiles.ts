import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface BuiltinWebFetchSiteProfile {
  domains: string[];
  pathPrefixes: string[];
  forceProvider?: 'basic' | 'browser_cli';
  waitSelector: string;
  selectorTimeoutMs?: number;
  postWaitMs?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  viewport: string;
  userAgent: string;
}

export interface BuiltinWebFetchSiteProfilePreset {
  id: string;
  label: string;
  profile: BuiltinWebFetchSiteProfile;
}

function getProfilesFilePath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '../shared/web-fetch-site-profiles.json');
}

export function loadBuiltinWebFetchSiteProfilePresets(): BuiltinWebFetchSiteProfilePreset[] {
  const filePath = getProfilesFilePath();
  return JSON.parse(
    fs.readFileSync(filePath, 'utf8'),
  ) as BuiltinWebFetchSiteProfilePreset[];
}

export function loadBuiltinWebFetchSiteProfiles(): BuiltinWebFetchSiteProfile[] {
  return loadBuiltinWebFetchSiteProfilePresets().map((entry) => entry.profile);
}
