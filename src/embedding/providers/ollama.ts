import type { EmbeddingProvider } from '../provider.js';
import { createModuleLogger } from '../../logger.js';

const logger = createModuleLogger('embedding');

const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_DIMENSIONS = 768;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly configKey: string;
  readonly dimensions: number;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: { model?: string; baseUrl?: string; dimensions?: number; configKey?: string }) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    this.configKey = opts.configKey ?? `${this.name}:${this.baseUrl}:${this.model}:${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.callAPI(t)));
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.callAPI(query);
  }

  private async callAPI(input: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error({ status: res.status, body: text }, 'Ollama embedding API error');
      throw new Error(`Ollama embedding API error: ${res.status}`);
    }

    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings[0];
  }
}
