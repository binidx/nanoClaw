import { execSync } from 'child_process';
import fs from 'fs';

let cached: string | undefined;

/**
 * Resolve a working Node.js binary path.
 * Tries process.execPath, then `which`/`where`, then well-known locations.
 */
export function getNodeExecutable(): string {
  if (cached) return cached;

  const execPath = process.execPath;
  if (execPath && fs.existsSync(execPath)) {
    cached = execPath;
    return execPath;
  }

  try {
    const resolved = execSync(
      process.platform === 'win32' ? 'where node' : 'which node',
      { encoding: 'utf8', timeout: 3000 },
    ).trim().split(/\r?\n/)[0];
    if (resolved && fs.existsSync(resolved!)) {
      cached = resolved!;
      return resolved!;
    }
  } catch {
    // which/where not available or node not in PATH
  }

  const fallbacks = process.platform === 'win32'
    ? []
    : ['/usr/local/bin/node', '/usr/bin/node'];
  for (const p of fallbacks) {
    if (fs.existsSync(p)) {
      cached = p;
      return p;
    }
  }
  return 'node';
}
