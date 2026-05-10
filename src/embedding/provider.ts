export interface EmbeddingProvider {
  readonly name: string;
  readonly configKey: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

export interface EmbeddingProviderConfig {
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}
