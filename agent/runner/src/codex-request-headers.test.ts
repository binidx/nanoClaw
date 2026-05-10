import { afterEach, describe, expect, it } from 'vitest';

import { buildCodexRequestHeaders } from './codex-request-headers.js';

describe('codex-request-headers', () => {
  afterEach(() => {
    delete process.env.CODEX_EXTRA_HEADERS_JSON;
    delete process.env.CODEX_USER_AGENT;
  });

  it('applies configured extra headers and user agent', () => {
    process.env.CODEX_EXTRA_HEADERS_JSON = JSON.stringify({
      'X-Client': 'portable-ui',
      'X-Feature': 'gateway',
    });
    process.env.CODEX_USER_AGENT = 'NanoClaw/1.0';

    expect(
      buildCodexRequestHeaders('secret', { Accept: 'text/event-stream' }),
    ).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
      'X-Client': 'portable-ui',
      'X-Feature': 'gateway',
      Accept: 'text/event-stream',
      'User-Agent': 'NanoClaw/1.0',
    });
  });
});
