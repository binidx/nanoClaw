import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatStructuredPromptValue,
  serializeForModel,
} from './model-serialization.js';

describe('runner model serialization', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders TOON for uniform MCP-style rows when forced', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    const result = serializeForModel(
      [
        { name: 'search', latencyMs: 22, ok: true },
        { name: 'fetch', latencyMs: 31, ok: true },
      ],
      { surface: 'mcp_result' },
    );

    expect(result.format).toBe('toon');
    expect(result.text).toContain('[2]{name,latencyMs,ok}:');
    expect(result.text).toContain('search,22,true');
  });

  it('includes a format tag for structured prompt blocks', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    const text = formatStructuredPromptValue(
      [{ name: 'search', latencyMs: 22 }, { name: 'fetch' }],
      { surface: 'mcp_result' },
    );

    expect(text).toContain('[FORMAT: TOON]');
    expect(text).toContain('[2]{name,latencyMs}:');
    expect(text).toContain('fetch,null');
  });

  it('falls back to JSON-tagged output when a structured cell contains a comma', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    const text = formatStructuredPromptValue(
      [
        { name: 'search', summary: 'revenue, margin expansion' },
        { name: 'fetch', summary: 'stable' },
      ],
      { surface: 'mcp_result' },
    );

    expect(text).toContain('[FORMAT: JSON]');
    expect(text).toContain('"summary":"revenue, margin expansion"');
  });
});
