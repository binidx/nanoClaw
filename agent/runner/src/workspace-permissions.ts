import fs from 'fs';
import path from 'path';

import { requestDirectoryAccessApproval } from './mutation-approval.js';

function getRawAllowedDirs(): string[] | null {
  const raw = process.env.NANOCLAW_ALLOWED_DIRS;
  if (raw) {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      /* bad json */
    }
  }
  return null;
}

export function getAccessMode(): 'allowall' | 'allowlist' | 'readonly' {
  const raw = String(process.env.NANOCLAW_ACCESS_MODE || 'allowall')
    .trim()
    .toLowerCase();
  return raw === 'allowlist' || raw === 'readonly' ? raw : 'allowall';
}

export function resolveCanonicalPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const missingParts: string[] = [];
  let cursor = resolved;

  while (!fs.existsSync(cursor)) {
    const parsed = path.parse(cursor);
    const base = path.basename(cursor);
    if (!base || cursor === parsed.root) {
      return resolved;
    }
    missingParts.unshift(base);
    cursor = path.dirname(cursor);
  }

  try {
    const realCursor = fs.realpathSync(cursor);
    return missingParts.length > 0
      ? path.join(realCursor, ...missingParts)
      : realCursor;
  } catch {
    return resolved;
  }
}

export function checkPermission(targetPath: string): string | null {
  if (getAccessMode() === 'allowall') return null;
  const dirs = getRawAllowedDirs();
  if (!dirs) return null;
  const normalizedTarget = resolveCanonicalPath(targetPath)
    .toLowerCase()
    .replace(/\\/g, '/');
  for (const dir of dirs) {
    const normalizedDir = resolveCanonicalPath(dir)
      .toLowerCase()
      .replace(/\\/g, '/');
    if (
      normalizedTarget === normalizedDir ||
      normalizedTarget.startsWith(`${normalizedDir}/`)
    ) {
      return null;
    }
  }
  return `Permission denied: ${targetPath} is not in allowed directories`;
}

export function checkWritePermission(targetPath: string): string | null {
  if (getAccessMode() === 'readonly') {
    return `Permission denied: ${targetPath} is read-only in the current access policy`;
  }
  return checkPermission(targetPath);
}

function deriveDirectoryRoot(targetPath: string): string {
  try {
    const stat = fs.statSync(targetPath);
    return stat.isDirectory() ? targetPath : path.dirname(targetPath);
  } catch {
    return path.dirname(targetPath);
  }
}

export async function checkPermissionOrEscalate(
  targetPath: string,
  toolCallId: string,
  toolName: string,
): Promise<string | null> {
  const perm = checkPermission(targetPath);
  if (!perm) return null;

  const directoryRoot = deriveDirectoryRoot(targetPath);
  const decision = await requestDirectoryAccessApproval({
    toolCallId,
    toolName,
    targetPath: directoryRoot,
  });
  if (decision === 'allow-once') {
    return checkPermission(targetPath);
  }
  if (decision === 'expired') {
    return `Permission denied: directory access approval timed out for ${targetPath}`;
  }
  return perm;
}

export async function checkWritePermissionOrEscalate(
  targetPath: string,
  toolCallId: string,
  toolName: string,
): Promise<string | null> {
  if (getAccessMode() === 'readonly') {
    return `Permission denied: ${targetPath} is read-only in the current access policy`;
  }
  return checkPermissionOrEscalate(targetPath, toolCallId, toolName);
}

type WorkspacePathMapping = {
  virtualPrefix: string;
  envKey: string;
  fallback?: () => string;
};

const WORKSPACE_PATH_MAPPINGS: WorkspacePathMapping[] = [
  { virtualPrefix: '/workspace/project', envKey: 'NANOCLAW_PROJECT_ROOT' },
  { virtualPrefix: '/workspace/group', envKey: 'NANOCLAW_GROUP_DIR' },
  { virtualPrefix: '/workspace/global', envKey: 'NANOCLAW_GLOBAL_DIR' },
  { virtualPrefix: '/workspace/extra', envKey: 'NANOCLAW_EXTRA_DIR' },
  { virtualPrefix: '/workspace/uploads', envKey: 'NANOCLAW_UPLOADS_DIR' },
  { virtualPrefix: '/workspace/skills', envKey: 'NANOCLAW_SKILLS_DIR' },
];

export function resolveWorkspacePath(filePath: string): string {
  for (const mapping of WORKSPACE_PATH_MAPPINGS) {
    const hostRoot = process.env[mapping.envKey] || mapping.fallback?.();
    if (!hostRoot) continue;
    if (filePath === mapping.virtualPrefix) return hostRoot;
    if (filePath.startsWith(`${mapping.virtualPrefix}/`)) {
      const relativePath = filePath.slice(mapping.virtualPrefix.length + 1);
      return path.join(hostRoot, ...relativePath.split('/'));
    }
  }

  return filePath;
}

export function mapWorkspacePathsInShellCommand(command: string): string {
  let mapped = String(command || '');
  for (const mapping of WORKSPACE_PATH_MAPPINGS) {
    const hostRoot = process.env[mapping.envKey] || mapping.fallback?.();
    if (!hostRoot) continue;
    const escapedPrefix = mapping.virtualPrefix.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    mapped = mapped.replace(
      new RegExp(`${escapedPrefix}(?=$|[\\s"';&|)\\/])`, 'g'),
      () => hostRoot,
    );
  }
  return mapped;
}

export function resolvePath(filePath: string, cwd: string): string {
  const mappedPath = resolveWorkspacePath(filePath);
  return path.isAbsolute(mappedPath)
    ? mappedPath
    : path.resolve(cwd, mappedPath);
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === '`' && last === '`')
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function unwrapTransparentReadOnlyShellWrapper(command: string): string {
  let normalized = command.trim();
  const wrappers = [
    /^(?:\/bin\/)?bash\s+-lc\s+([\s\S]+)$/i,
    /^(?:\/bin\/)?bash\s+-c\s+([\s\S]+)$/i,
    /^(?:\/bin\/)?bash\s+-l\s+-c\s+([\s\S]+)$/i,
    /^(?:\/bin\/)?sh\s+-lc\s+([\s\S]+)$/i,
    /^(?:\/bin\/)?sh\s+-c\s+([\s\S]+)$/i,
    /^(?:\/bin\/)?sh\s+-l\s+-c\s+([\s\S]+)$/i,
  ];

  for (;;) {
    const wrapperMatch = wrappers
      .map((pattern) => normalized.match(pattern))
      .find((match): match is RegExpMatchArray => Boolean(match));
    if (!wrapperMatch) break;
    normalized = stripMatchingQuotes(wrapperMatch[1] || '');
  }

  for (;;) {
    const cdMatch = normalized.match(/^cd\s+[^;&|]+?\s*(?:&&|;)\s*([\s\S]+)$/i);
    if (!cdMatch) break;
    normalized = cdMatch[1]!.trim();
  }

  return normalized.trim();
}

function stripBenignReadOnlyRedirections(command: string): string {
  return command.replace(
    /(?:^|[\s;|&])(?:\d?>\s*(?:\/dev\/null|nul)\b)/gi,
    ' ',
  );
}

function isReadOnlyShellSegment(segment: string): boolean {
  const normalized = segment.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return true;

  const readOnlyPatterns = [
    /^ls\b/,
    /^dir\b/,
    /^pwd\b/,
    /^cat\b/,
    /^type\b/,
    /^less\b/,
    /^more\b/,
    /^head\b/,
    /^tail\b/,
    /^sed\s+-n\b/,
    /^wc\b/,
    /^(which|where)\b/,
    /^echo\b/,
    /^printf\b/,
    /^git\s+(?:(?:-c|--git-dir|--work-tree)\s+\S+\s+)*(?:--no-pager\s+)?(?:status|diff|log|show|branch|ls-tree|ls-files|grep|rev-parse|cat-file|blame)\b/,
    /^(node|npm|pnpm|python|python3)\s+(-v|--version)\b/,
    /^grep\b/,
    /^(rg|ripgrep)\b/,
    /^ag\b/,
    /^find\b/,
    /^fd\b/,
    /^file\b/,
    /^stat\b/,
    /^tree\b/,
    /^du\b/,
    /^df\b/,
    /^diff\b/,
    /^sort\b/,
    /^uniq\b/,
    /^cut\b/,
    /^tr\b/,
    /^awk\b/,
    /^(basename|dirname|realpath|readlink)\b/,
    /^(env|printenv|uname|whoami|id|date|hostname)\b/,
    /^(xxd|od|hexdump)\b/,
    /^(sha256sum|sha1sum|md5sum|shasum|cksum)\b/,
    /^(jq|yq)\b/,
    /^strings\b/,
    /^nl\b/,
    /^tac\b/,
    /^rev\b/,
    /^column\b/,
  ];
  return readOnlyPatterns.some((pattern) => pattern.test(normalized));
}

export function extractBashPathCandidates(command: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const unixMatches =
    command.match(
      /(^|[\s"'=])((?:\/workspace\/[^\s"'`;&|()]+)|(?:\/[^\s"'`;&|()]+))/g,
    ) || [];
  const windowsMatches =
    command.match(/(^|[\s"'=])([A-Za-z]:\\[^\s"'`;&|()]+)/g) || [];

  for (const rawMatch of [...unixMatches, ...windowsMatches]) {
    const candidate = rawMatch.replace(/^[\s"'=]+/, '').trim();
    if (!candidate || candidate.startsWith('//')) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

export function precheckBashCommandPaths(
  command: string,
  cwd: string,
): string | null {
  const candidates = extractBashPathCandidates(command);
  for (const candidate of candidates) {
    const resolvedCandidate = resolvePath(candidate, cwd);
    const perm = checkPermission(resolvedCandidate);
    if (perm) {
      return `Permission denied: bash command references path outside the workspace (${candidate})`;
    }
  }
  return null;
}

export function isReadOnlyShellCommand(command: string): boolean {
  const normalized = stripBenignReadOnlyRedirections(
    unwrapTransparentReadOnlyShellWrapper(command),
  )
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!normalized) return true;

  const dangerousTokens = [
    /\brm\b/,
    /\bmv\b/,
    /\bcp\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bmkdir\b/,
    /\brmdir\b/,
    /\btouch\b/,
    /\btee\b/,
    /\bsed\s+-i\b/,
    /\bperl\s+-pi\b/,
    /\bpython(?:3)?\s+-c\b.*\b(open|write_text|write_bytes)\b/,
    /\bnpm\s+(install|update|uninstall|run build)\b/,
    /\bpnpm\s+(install|add|update|remove)\b/,
    /\byarn\s+(add|remove|install|upgrade)\b/,
    /\bpip(?:3)?\s+install\b/,
    /\bgit\s+(reset|clean|checkout\s+--|restore\b|revert\b|commit\b|push\b|merge\b|rebase\b|apply\b|am\b)\b/,
    /(^|[^<])>/,
    /\|\s*(sh|bash|pwsh|powershell)\b/,
    /\bfind\b.*\s-(exec|execdir|delete|ok)\b/,
    /\bxargs\b/,
    /\bawk\b.*\bsystem\s*\(/,
  ];
  if (dangerousTokens.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  if (/[`(){}]/.test(normalized) || /\$\(/.test(normalized)) {
    return false;
  }

  const segments = normalized
    .split(/\s*(?:\|\||&&|\||;)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return true;
  return segments.every((segment) => isReadOnlyShellSegment(segment));
}
