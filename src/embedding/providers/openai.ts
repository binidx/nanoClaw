import type { EmbeddingProvider } from '../provider.js';
import { createModuleLogger } from '../../logger.js';

const logger = createModuleLogger('embedding');

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;
const BATCH_SIZE = 100;

function inferDefaultDimensions(model: string): number {
  const normalized = model.toLowerCase();
  if (normalized.includes('qwen3-embedding-8b')) return 4096;
  return DEFAULT_DIMENSIONS;
}

function shouldSendDimensions(model: string, baseUrl: string, explicitDimensions: boolean): boolean {
  if (model.includes('embedding-3')) return true;
  if (!explicitDimensions) return false;
  return !baseUrl.startsWith('https://api.openai.com/');
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly configKey: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly sendDimensions: boolean;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; dimensions?: number; configKey?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.dimensions = opts.dimensions ?? inferDefaultDimensions(this.model);
    this.sendDimensions = shouldSendDimensions(this.model, this.baseUrl, opts.dimensions !== undefined);
    this.configKey = opts.configKey ?? `${this.name}:${this.baseUrl}:${this.model}:${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const resp = await this.callAPI(batch);
      results.push(...resp);
    }
    return results;
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vec] = await this.callAPI([query]);
    return vec;
  }

  private async callAPI(input: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = { input, model: this.model };
    if (this.sendDimensions) {
      body.dimensions = this.dimensions;
    }

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error({ status: res.status, body: text }, 'OpenAI embedding API error');
      throw new Error(`OpenAI embedding API error: ${res.status}`);
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
