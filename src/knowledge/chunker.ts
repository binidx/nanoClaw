export interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
}

export interface TextChunk {
  index: number;
  content: string;
  tokenEstimate: number;
}

/**
 * CJK-aware token estimation.
 * CJK characters average ~1.5 BPE tokens each;
 * Latin/ASCII averages ~1 token per 3.5 characters.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (isCjk(code)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.5 + other / 3.5);
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4DBF) ||  // Extension A
    (code >= 0xF900 && code <= 0xFAFF) ||  // Compatibility Ideographs
    (code >= 0x3000 && code <= 0x303F) ||  // CJK Symbols & Punctuation
    (code >= 0xFF00 && code <= 0xFFEF) ||  // Fullwidth Forms
    (code >= 0xAC00 && code <= 0xD7AF) ||  // Hangul Syllables
    (code >= 0x3040 && code <= 0x30FF)     // Hiragana + Katakana
  );
}

/**
 * Inverse of estimateTokens — approximate char count for a given token budget.
 * Used by extractOverlap to compute a tail slice length.
 */
function tokensToChars(text: string, tokens: number): number {
  if (text.length === 0) return 0;
  const estimated = estimateTokens(text);
  if (estimated === 0) return text.length;
  return Math.round((tokens / estimated) * text.length);
}

const SENTENCE_SPLIT_RE = /(?<=[.!?。！？；\n])\s*/;

export function chunkText(
  text: string,
  opts: ChunkOptions = { chunkSize: 300, chunkOverlap: 60 },
): TextChunk[] {
  const { chunkSize, chunkOverlap } = opts;
  const paragraphs = text.split(/\n{2,}/);
  const chunks: TextChunk[] = [];
  let buffer = '';
  let index = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    const combined = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
    const tokens = estimateTokens(combined);

    if (tokens > chunkSize && buffer) {
      chunks.push({ index, content: buffer.trim(), tokenEstimate: estimateTokens(buffer) });
      index++;
      const overlapText = extractOverlap(buffer, chunkOverlap);
      buffer = overlapText ? `${overlapText}\n\n${trimmed}` : trimmed;
    } else if (tokens > chunkSize && !buffer) {
      const subChunks = splitLongParagraph(trimmed, chunkSize, chunkOverlap);
      for (const sub of subChunks) {
        chunks.push({ index, content: sub, tokenEstimate: estimateTokens(sub) });
        index++;
      }
      buffer = '';
    } else {
      buffer = combined;
    }
  }

  if (buffer.trim()) {
    chunks.push({ index, content: buffer.trim(), tokenEstimate: estimateTokens(buffer) });
  }

  return chunks;
}

function extractOverlap(text: string, overlapTokens: number): string {
  const charCount = tokensToChars(text, overlapTokens);
  if (text.length <= charCount) return text;
  const tail = text.slice(-charCount);
  const breakIdx = tail.search(/[.!?。！？；]\s*/);
  if (breakIdx >= 0) {
    const afterBreak = tail.slice(breakIdx).replace(/^[.!?。！？；]\s*/, '');
    return afterBreak || tail;
  }
  return tail;
}

function splitLongParagraph(text: string, chunkSize: number, overlapTokens: number): string[] {
  const sentences = text.split(SENTENCE_SPLIT_RE).filter(Boolean);
  const chunks: string[] = [];
  let buffer = '';

  for (const sentence of sentences) {
    const combined = buffer ? `${buffer} ${sentence}` : sentence;
    if (estimateTokens(combined) > chunkSize && buffer) {
      chunks.push(buffer.trim());
      const overlap = extractOverlap(buffer, overlapTokens);
      buffer = overlap ? `${overlap} ${sentence}` : sentence;
    } else {
      buffer = combined;
    }
  }

  if (buffer.trim()) {
    chunks.push(buffer.trim());
  }

  return chunks;
}
