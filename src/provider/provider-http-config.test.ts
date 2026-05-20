import { describe, expect, it } from 'vitest';

import {
  buildProviderExtraConfigValue,
  buildProviderFetchHeaders,
  getProviderHttpConfig,
  serializeProviderForClient,
} from './provider-http-config.js';

describe('provider-http-config', () => {
  it('reads custom headers and user agent from extra_config', () => {
    expect(
      getProviderHttpConfig({
        extra_config: JSON.stringify({
          userAgent: 'NanoClaw/1.0',
          headers: {
            'X-Client': 'desktop',
            'X-Trace': 'abc',
          },
        }),
      }),
    ).toEqual({
      userAgent: 'NanoClaw/1.0',
      headers: {
        'X-Client': 'desktop',
        'X-Trace': 'abc',
      },
    });
  });

  it('merges provider http config into fetch headers', () => {
    expect(
      buildProviderFetchHeaders(
        {
          extra_config: JSON.stringify({
            userAgent: 'NanoClaw/1.0',
            headers: { 'X-Client': 'desktop' },
          }),
        },
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test',
        },
      ),
    ).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test',
      'X-Client': 'desktop',
      'User-Agent': 'NanoClaw/1.0',
    });
  });

  it('updates http config while preserving unrelated extra_config keys', () => {
    const serialized = buildProviderExtraConfigValue(
      {
        user_agent: 'NanoClaw/2.0',
        custom_headers: { 'X-Client': 'portable' },
      },
      JSON.stringify({
        codexApiMode: 'chat_completions',
        headers: { 'X-Old': '1' },
      }),
    );

    expect(JSON.parse(String(serialized))).toEqual({
      codexApiMode: 'chat_completions',
      userAgent: 'NanoClaw/2.0',
      headers: { 'X-Client': 'portable' },
    });
  });

  it('masks custom headers for client serialization', () => {
    expect(
      serializeProviderForClient({
        extra_config: JSON.stringify({
          headers: {
            Authorization: 'Bearer secret-token',
            'X-Api-Key': 'abcd',
          },
        }),
      }).custom_headers,
    ).toEqual({
      Authorization: '****oken',
      'X-Api-Key': '****',
    });
  });

  it('preserves existing header secrets when client sends masked values back', () => {
    const serialized = buildProviderExtraConfigValue(
      {
        custom_headers: {
          Authorization: '****oken',
          'X-Trace': 'new-trace',
        },
      },
      JSON.stringify({
        headers: {
          Authorization: 'Bearer secret-token',
          'X-Trace': 'old-trace',
        },
      }),
    );

    expect(JSON.parse(String(serialized))).toEqual({
      headers: {
        Authorization: 'Bearer secret-token',
        'X-Trace': 'new-trace',
      },
    });
  });
});
