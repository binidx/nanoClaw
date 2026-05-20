export interface RagEvalContext {
  id: string;
  content: string;
}

export interface RagEvalSample {
  userInput: string;
  reference?: string;
  response?: string;
  retrievedContexts: RagEvalContext[];
  referenceContextIds?: string[];
}

export interface RagEvalScores {
  metricKind: 'local_lexical_heuristic';
  contextPrecision: number | null;
  contextRecall: number | null;
  faithfulness: number | null;
  answerRelevancy: number | null;
  noiseSensitivity: number | null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function tokenize(text: string): Set<string> {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 2),
  );
}

function tokenOverlap(left: string, right: string): number {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const token of a) {
    if (b.has(token)) hits += 1;
  }
  return hits / a.size;
}

function splitClaims(text: string): string[] {
  return String(text || '')
    .split(/[。.!?！？;\n]+/u)
    .map((claim) => claim.trim())
    .filter((claim) => claim.length >= 6);
}

function contextText(contexts: RagEvalContext[]): string {
  return contexts.map((context) => context.content).join('\n\n');
}

export function scoreContextPrecision(sample: RagEvalSample): number | null {
  if (sample.retrievedContexts.length === 0) return null;
  const referenceIds = new Set(sample.referenceContextIds ?? []);
  if (referenceIds.size > 0) {
    let relevantSeen = 0;
    let precisionSum = 0;
    sample.retrievedContexts.forEach((context, index) => {
      if (!referenceIds.has(context.id)) return;
      relevantSeen += 1;
      precisionSum += relevantSeen / (index + 1);
    });
    return referenceIds.size === 0 ? null : clamp01(precisionSum / referenceIds.size);
  }
  if (!sample.reference) return null;
  const relevant = sample.retrievedContexts.filter(
    (context) => tokenOverlap(sample.reference ?? '', context.content) >= 0.35,
  );
  return clamp01(relevant.length / sample.retrievedContexts.length);
}

export function scoreContextRecall(sample: RagEvalSample): number | null {
  if (!sample.reference) return null;
  const claims = splitClaims(sample.reference);
  if (claims.length === 0) return null;
  const retrieved = contextText(sample.retrievedContexts);
  const supported = claims.filter((claim) => tokenOverlap(claim, retrieved) >= 0.45);
  return clamp01(supported.length / claims.length);
}

export function scoreFaithfulness(sample: RagEvalSample): number | null {
  if (!sample.response) return null;
  const claims = splitClaims(sample.response);
  if (claims.length === 0) return null;
  const retrieved = contextText(sample.retrievedContexts);
  const supported = claims.filter((claim) => tokenOverlap(claim, retrieved) >= 0.45);
  return clamp01(supported.length / claims.length);
}

export function scoreAnswerRelevancy(sample: RagEvalSample): number | null {
  if (!sample.response) return null;
  return clamp01(tokenOverlap(sample.userInput, sample.response));
}

export function scoreNoiseSensitivity(sample: RagEvalSample): number | null {
  if (!sample.response || !sample.reference || sample.retrievedContexts.length === 0) return null;
  const responseClaims = splitClaims(sample.response);
  if (responseClaims.length === 0) return null;
  const retrieved = contextText(sample.retrievedContexts);
  const unsupportedByReference = responseClaims.filter((claim) =>
    tokenOverlap(claim, sample.reference ?? '') < 0.3 &&
    tokenOverlap(claim, retrieved) >= 0.35,
  );
  return clamp01(unsupportedByReference.length / responseClaims.length);
}

export function evaluateRagSample(sample: RagEvalSample): RagEvalScores {
  return {
    metricKind: 'local_lexical_heuristic',
    contextPrecision: scoreContextPrecision(sample),
    contextRecall: scoreContextRecall(sample),
    faithfulness: scoreFaithfulness(sample),
    answerRelevancy: scoreAnswerRelevancy(sample),
    noiseSensitivity: scoreNoiseSensitivity(sample),
  };
}
