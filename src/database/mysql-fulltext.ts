export function isMySqlFullTextUnsupportedError(err: unknown): boolean {
  const e = err as {
    errno?: unknown;
    code?: unknown;
    message?: unknown;
    sqlMessage?: unknown;
  } | null | undefined;

  const message = [e?.message, e?.sqlMessage]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');

  return (typeof e?.errno === 'number' && e.errno === 8200)
    || (typeof e?.code === 'string' && e.code === 'ER_FULLTEXT_NOT_SUPPORTED')
    || /FULLTEXT and SPATIAL index is not supported/i.test(message);
}
