import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { info, warn, error } = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  createModuleLogger: vi.fn(() => ({ info, warn, error })),
}));

describe('database-logger', () => {
  const originalMode = process.env.NANOCLAW_LOG_DB_MODE;

  beforeEach(() => {
    process.env.NANOCLAW_LOG_DB_MODE = 'all';
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.NANOCLAW_LOG_DB_MODE;
    } else {
      process.env.NANOCLAW_LOG_DB_MODE = originalMode;
    }
    info.mockReset();
    warn.mockReset();
    error.mockReset();
    vi.resetModules();
  });

  it('logs query summaries with the outer request id', async () => {
    const { runWithRequestContextAsync } = await import('../request-context.js');
    const { withDbQueryLogging } = await import('./database-logger.js');

    const rows = await runWithRequestContextAsync(
      {
        requestId: 'db-request-1',
        source: 'http',
      },
      () =>
        withDbQueryLogging(
          {
            dialect: 'sqlite',
            operation: 'queryAll',
            sql: 'SELECT * FROM users WHERE api_key = ?',
            params: ['sk-secret-value-1234567890'],
            summarizeResult: (result: Array<{ id: number }>) => ({
              rowCount: result.length,
            }),
          },
          async () => [{ id: 1 }],
        ),
    );

    expect(rows).toEqual([{ id: 1 }]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'db-request-1',
        kind: 'db_query',
        dialect: 'sqlite',
        operation: 'queryAll',
        rowCount: 1,
        paramsPreview: ['[REDACTED]'],
      }),
      'DB query completed',
    );
  });
});
