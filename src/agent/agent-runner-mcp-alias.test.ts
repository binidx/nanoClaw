import { describe, expect, it } from 'vitest';

import {
  buildUserMcpRuntimeAlias,
  normalizeUserMcpRuntimeAlias,
} from './agent-runner-mcp-alias.js';

describe('agent-runner MCP alias helpers', () => {
  it('normalizes simple display names into runtime-safe aliases', () => {
    expect(normalizeUserMcpRuntimeAlias('  My MCP  ')).toBe('my_mcp');
  });

  it('uses the MCP name when it is unique', () => {
    expect(
      buildUserMcpRuntimeAlias(
        { id: 'user_mcp_01jxlongid', name: 'mflux' },
        new Set(['jira']),
      ),
    ).toBe('mflux');
  });

  it('falls back to a stable suffixed alias when the requested name is reserved', () => {
    expect(
      buildUserMcpRuntimeAlias(
        { id: 'abc123', name: 'nanoclaw' },
        new Set(),
      ),
    ).toBe('mcp_abc123');
  });

  it('falls back to a stable suffixed alias when the requested name is already taken', () => {
    expect(
      buildUserMcpRuntimeAlias(
        { id: 'mcp-1', name: 'mflux' },
        new Set(['mflux']),
      ),
    ).toBe('mflux_mcp-1');
  });
});
