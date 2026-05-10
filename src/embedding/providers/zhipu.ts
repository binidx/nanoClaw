import type { EmbeddingProvider } from '../provider.js';
import { createModuleLogger } from '../../logger.js';

const logger = createModuleLogger('embedding');

const DEFAULT_MODEL = 'embedding-3';
const DEFAULT_DIMENSIONS = 2048;
const BATCH_SIZE = 64;

export class ZhipuEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'zhipu';
  readonly configKey: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; dimensions?: number; configKey?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    this.configKey = opts.configKey ?? `${this.name}:${this.baseUrl}:${this.model}:${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map((t) => this.callAPI(t)));
      results.push(...batchResults);
    }
    return results;
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.callAPI(query);
  }

  private async callAPI(input: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input, model: this.model }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error({ status: res.status, body: text }, 'Zhipu embedding API error');
      throw new Error(`Zhipu embedding API error: ${res.status}`);
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return json.data[0].embedding;
  }
}
