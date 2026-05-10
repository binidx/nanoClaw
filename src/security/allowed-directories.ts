import fs from 'fs';
import os from 'os';
import path from 'path';

export function expandUserPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  const homeDir = process.env.HOME || os.homedir();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/')) return path.join(homeDir, trimmed.slice(2));
  return path.resolve(trimmed);
}

export function normalizeAllowedDirectories(entries: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const resolved = expandUserPath(trimmed);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory does not exist: ${trimmed}`);
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${trimmed}`);
    }

    const realPath = fs.realpathSync(resolved);
    if (seen.has(realPath)) continue;
    seen.add(realPath);
    normalized.push(realPath);
  }

  return normalized.sort((left, right) => left.localeCompare(right));
}

export function parseAllowedDirectoriesValue(
  raw: string | null | undefined,
): string[] {
  if (!raw) return [];

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('allowed_directories must be a JSON array of strings');
  }

  return normalizeAllowedDirectories(
    parsed.filter((entry): entry is string => typeof entry === 'string'),
  );
}
