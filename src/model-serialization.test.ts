import { describe, expect, it, vi } from 'vitest';

import {
  formatStructuredPromptValue,
  serializeForModel,
} from './provider/model-serialization.js';
import { buildMarketReviewPrompt } from './stock-analysis/stock-analysis-prompts.js';

describe('model serialization', () => {
  it('uses TOON for uniform object arrays when forced', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    const result = serializeForModel(
      [
        { title: 'Spec', score: 95, status: 'ok' },
        { title: 'Plan', score: 87, status: 'warn' },
      ],
      { surface: 'mcp_result' },
    );

    expect(result.format).toBe('toon');
    expect(result.text).toContain('[2]{title,score,status}:');
    expect(result.text).toContain('Spec,95,ok');

    vi.unstubAllEnvs();
  });

  it('falls back to JSON for incompatible nested shapes', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'auto');

    const result = serializeForModel(
      [
        { title: 'Spec', meta: { owner: 'A' } },
        { title: 'Plan', meta: { owner: 'B' } },
      ],
      { surface: 'mcp_result' },
    );

    expect(result.format).toBe('json');
    expect(result.text).toContain('"meta":{"owner":"A"}');

    vi.unstubAllEnvs();
  });

  it('formats stock-analysis prompt payloads through the structured serializer', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    const prompt = buildMarketReviewPrompt({
      reviewData: {
        market: 'us',
        factors: [
          { key: 'trend', score: 80, signal: 'positive' },
          { key: 'volume', score: 70, signal: 'neutral' },
        ],
      },
    });

    expect(prompt).toContain('Input:');
    expect(prompt).toContain('[FORMAT: TOON]');
    expect(prompt).toContain('factors[2]{key,score,signal}:');

    vi.unstubAllEnvs();
  });

  it('keeps plain object formatting available for prompt fields', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    const output = formatStructuredPromptValue(
      { title: 'Review', confidence: 'medium' },
      { surface: 'stock_analysis_prompt' },
    );

    expect(output).toContain('[FORMAT: TOON]');
    expect(output).toContain('title: Review');
    expect(output).toContain('confidence: medium');

    vi.unstubAllEnvs();
  });

  it('supports optional fields in TOON table rows by filling missing values with null', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    const result = serializeForModel(
      [
        { title: 'Spec', score: 95 },
        { title: 'Plan', status: 'warn' },
      ],
      { surface: 'mcp_result' },
    );

    expect(result.format).toBe('toon');
    expect(result.text).toContain('[2]{title,score,status}:');
    expect(result.text).toContain('Spec,95,null');
    expect(result.text).toContain('Plan,null,warn');

    vi.unstubAllEnvs();
  });

  it('falls back to JSON when a TOON table cell contains a comma', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    const result = serializeForModel(
      [
        { title: 'Apple', summary: 'revenue, margin expansion', status: 'ok' },
        { title: 'Meta', summary: 'ads stable', status: 'warn' },
      ],
      { surface: 'mcp_result' },
    );

    expect(result.format).toBe('json');
    expect(result.text).toContain('"summary":"revenue, margin expansion"');

    vi.unstubAllEnvs();
  });

  it('falls back to JSON when a scalar array item contains a comma', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    const result = serializeForModel(
      ['revenue, margin expansion', 'ads stable'],
      { surface: 'mcp_result' },
    );

    expect(result.format).toBe('json');
    expect(result.text).toContain('"revenue, margin expansion"');

    vi.unstubAllEnvs();
  });
});
