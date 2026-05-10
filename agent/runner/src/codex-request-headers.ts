function parseExtraHeaders(raw: string | undefined): Record<string, string> {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [String(key || '').trim(), String(value ?? '').trim()])
        .filter(([key, value]) => key && value),
    );
  } catch {
    return {};
  }
}

export function buildCodexRequestHeaders(
  apiKey: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  const configuredHeaders = parseExtraHeaders(process.env.CODEX_EXTRA_HEADERS_JSON);
  const nextHeaders = {
    ...baseHeaders,
    ...configuredHeaders,
    ...extraHeaders,
  };
  const userAgent = String(process.env.CODEX_USER_AGENT || '').trim();
  if (userAgent) {
    nextHeaders['User-Agent'] = userAgent;
  }
  return nextHeaders;
}
