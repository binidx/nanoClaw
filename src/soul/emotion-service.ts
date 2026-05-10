import { getConfigValue } from '../config-store.js';
import { getProvider, getDefaultProvider, type AiProvider } from '../db.js';
import { getProviderAdapter } from '../provider/provider-adapters.js';

export type EmotionLabel = 'happy' | 'sad' | 'angry' | 'surprised' | 'thinking' | 'neutral';

const VALID_EMOTIONS: Set<string> = new Set(['happy', 'sad', 'angry', 'surprised', 'thinking', 'neutral']);

const EMOTION_PROMPT = `Classify the emotional tone of the following text into exactly ONE of these labels: happy, sad, angry, surprised, thinking, neutral.
Reply with only the label, nothing else.

Text: `;

const resultCache = new Map<string, { emotion: EmotionLabel; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE = 200;

function cacheKey(text: string): string {
  return text.slice(0, 500);
}

function pruneCache() {
  if (resultCache.size <= MAX_CACHE) return;
  const now = Date.now();
  for (const [k, v] of resultCache) {
    if (now - v.ts > CACHE_TTL) resultCache.delete(k);
  }
  if (resultCache.size > MAX_CACHE) {
    const entries = [...resultCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < entries.length - MAX_CACHE; i++) {
      resultCache.delete(entries[i]![0]);
    }
  }
}

export async function isEmotionEnabled(): Promise<boolean> {
  const globalLive2d = await getConfigValue('LIVE2D_ENABLED');
  if (globalLive2d !== 'true') return false;
  const emotionEnabled = await getConfigValue('LIVE2D_EMOTION_ENABLED');
  return emotionEnabled !== 'false';
}

export async function analyzeEmotion(
  text: string,
  emotionProviderId?: string | null,
): Promise<EmotionLabel> {
  if (!text.trim()) return 'neutral';

  const key = cacheKey(text);
  const cached = resultCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.emotion;

  let result: EmotionLabel = 'neutral';
  try {
    result = await callEmotionProvider(text, emotionProviderId);
  } catch {
    result = fallbackKeywordAnalysis(text);
  }

  pruneCache();
  resultCache.set(key, { emotion: result, ts: Date.now() });
  return result;
}

async function callEmotionProvider(
  text: string,
  providerId?: string | null,
): Promise<EmotionLabel> {
  let provider: AiProvider | undefined;

  if (providerId) {
    provider = await getProvider(providerId);
  }

  if (!provider) {
    provider = await getDefaultProvider();
  }

  if (!provider) return fallbackKeywordAnalysis(text);

  const truncated = text.length > 800 ? text.slice(0, 800) + '...' : text;
  const prompt = EMOTION_PROMPT + truncated;

  const adapter = getProviderAdapter(provider.type);
  const result = await adapter.generateText(provider, prompt, {
    maxTokens: 10,
    temperature: 0,
  });
  const label = result.text.trim().toLowerCase();
  if (VALID_EMOTIONS.has(label)) return label as EmotionLabel;
  return 'neutral';
}

function fallbackKeywordAnalysis(text: string): EmotionLabel {
  const lower = text.toLowerCase();
  const patterns: Array<[EmotionLabel, RegExp]> = [
    ['happy', /(?:开心|高兴|快乐|太好了|恭喜|棒|不错|great|happy|wonderful|excellent|good|nice|awesome)/],
    ['sad', /(?:遗憾|可惜|难过|伤心|抱歉|sorry|sad|unfortunate|regret)/],
    ['angry', /(?:生气|愤怒|恼火|讨厌|angry|furious|annoyed)/],
    ['surprised', /(?:惊讶|没想到|竟然|居然|wow|surprised|unexpected|amazing)/],
    ['thinking', /(?:让我想想|思考|分析|考虑|研究|hmm|let me think|analyzing|consider)/],
  ];
  for (const [emotion, pattern] of patterns) {
    if (pattern.test(lower)) return emotion;
  }
  return 'neutral';
}

export async function getAvailableEmotionProviders(
  userId?: string,
): Promise<
  Array<{ id: string; alias: string; type: string; model: string | null }>
> {
  const { getVisibleProvidersForUser, getAllProviders } = await import('../db.js');
  const providers = userId
    ? await getVisibleProvidersForUser(userId, 'llm')
    : await getAllProviders('llm');
  return providers.map((p) => ({
    id: p.id,
    alias: p.alias,
    type: p.type,
    model: p.model,
  }));
}
