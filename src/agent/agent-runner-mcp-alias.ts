export function normalizeUserMcpRuntimeAlias(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

export function buildUserMcpRuntimeAlias(
  server: {
    id: string;
    name: string;
  },
  seen: Set<string>,
): string {
  const fallback = normalizeUserMcpRuntimeAlias(server.id) || 'user_mcp';
  const requested = normalizeUserMcpRuntimeAlias(server.name) || fallback;
  const reserved = new Set(['nanoclaw']);

  if (!reserved.has(requested) && !seen.has(requested)) {
    return requested;
  }

  const suffix = fallback.slice(-12) || 'mcp';
  const base = reserved.has(requested) ? 'mcp' : requested || 'user_mcp';
  const prefix = base.slice(0, Math.max(1, 48 - suffix.length - 1)) || 'mcp';
  let candidate = `${prefix}_${suffix}`;
  let counter = 2;
  while (reserved.has(candidate) || seen.has(candidate)) {
    const counterSuffix = `${suffix}_${counter}`;
    const counterPrefix =
      base.slice(0, Math.max(1, 48 - counterSuffix.length - 1)) || 'mcp';
    candidate = `${counterPrefix}_${counterSuffix}`;
    counter += 1;
  }
  return candidate;
}
