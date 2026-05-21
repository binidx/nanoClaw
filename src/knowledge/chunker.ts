export interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
}

export type TextChunkType = 'paragraph' | 'heading' | 'list' | 'table' | 'code' | 'mixed';

export interface TextChunk {
  index: number;
  content: string;
  tokenEstimate: number;
  headingPath?: string | null;
  contextLabel?: string | null;
  chunkType?: TextChunkType;
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
const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

interface TextBlock {
  content: string;
  headingPath: string | null;
  contextLabel: string | null;
  chunkType: TextChunkType;
}

export function chunkText(
  text: string,
  opts: ChunkOptions = { chunkSize: 300, chunkOverlap: 60 },
): TextChunk[] {
  const { chunkSize, chunkOverlap } = opts;
  const blocks = buildTextBlocks(text);
  const chunks: TextChunk[] = [];
  let buffer = '';
  let bufferHeadingPath: string | null = null;
  let bufferContextLabel: string | null = null;
  let bufferChunkType: TextChunkType = 'paragraph';
  let index = 0;

  const pushChunk = (
    content: string,
    meta: Pick<TextBlock, 'headingPath' | 'contextLabel' | 'chunkType'>,
  ) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    chunks.push({
      index,
      content: trimmed,
      tokenEstimate: estimateTokens(trimmed),
      headingPath: meta.headingPath,
      contextLabel: meta.contextLabel,
      chunkType: meta.chunkType,
    });
    index++;
  };

  const flushBuffer = () => {
    if (!buffer.trim()) return;
    pushChunk(buffer, {
      headingPath: bufferHeadingPath,
      contextLabel: bufferContextLabel,
      chunkType: bufferChunkType,
    });
    buffer = '';
    bufferHeadingPath = null;
    bufferContextLabel = null;
    bufferChunkType = 'paragraph';
  };

  for (const block of blocks) {
    const trimmed = block.content.trim();
    if (!trimmed) continue;

    if (
      buffer &&
      block.headingPath &&
      bufferHeadingPath &&
      block.headingPath !== bufferHeadingPath
    ) {
      flushBuffer();
    }

    const combined = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
    const tokens = estimateTokens(combined);

    if (tokens > chunkSize && buffer) {
      const previousBuffer = buffer;
      const previousHeadingPath = bufferHeadingPath;
      flushBuffer();
      if (estimateTokens(trimmed) > chunkSize) {
        for (const sub of splitLongParagraph(trimmed, chunkSize, chunkOverlap)) {
          pushChunk(sub, block);
        }
        continue;
      }
      const overlapText = extractOverlap(previousBuffer, chunkOverlap);
      const sameHeading = previousHeadingPath && previousHeadingPath === block.headingPath;
      buffer = sameHeading && overlapText ? `${overlapText}\n\n${trimmed}` : trimmed;
      bufferHeadingPath = block.headingPath;
      bufferContextLabel = block.contextLabel;
      bufferChunkType = block.chunkType;
    } else if (tokens > chunkSize && !buffer) {
      const subChunks = splitLongParagraph(trimmed, chunkSize, chunkOverlap);
      for (const sub of subChunks) {
        pushChunk(sub, block);
      }
      buffer = '';
    } else {
      buffer = combined;
      bufferHeadingPath = mergeHeadingPath(bufferHeadingPath, block.headingPath);
      bufferContextLabel = mergeContextLabel(bufferContextLabel, block.contextLabel);
      bufferChunkType = mergeChunkType(bufferChunkType, block.chunkType, Boolean(buffer && buffer !== trimmed));
    }
  }

  flushBuffer();

  return chunks;
}

function buildTextBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const headingStack: string[] = [];
  let lines: string[] = [];
  let blockHeadingPath: string | null = null;
  let blockType: TextChunkType = 'paragraph';
  let inCodeFence = false;

  const flush = () => {
    const content = lines.join('\n').trim();
    if (!content) {
      lines = [];
      blockHeadingPath = null;
      blockType = 'paragraph';
      return;
    }
    blocks.push({
      content,
      headingPath: blockHeadingPath,
      contextLabel: blockHeadingPath,
      chunkType: blockType,
    });
    lines = [];
    blockHeadingPath = null;
    blockType = 'paragraph';
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    const isFence = trimmed.startsWith('```') || trimmed.startsWith('~~~');

    if (!inCodeFence) {
      const heading = MARKDOWN_HEADING_RE.exec(trimmed);
      if (heading) {
        flush();
        const level = heading[1].length;
        const title = normalizeHeadingTitle(heading[2]);
        headingStack.splice(level - 1);
        headingStack[level - 1] = title;
        const path = headingStack.filter(Boolean).join(' > ');
        lines = [trimmed];
        blockHeadingPath = path || null;
        blockType = 'heading';
        continue;
      }

      if (!trimmed) {
        flush();
        continue;
      }
    }

    const lineType = detectChunkType(trimmed, isFence || inCodeFence);
    if (lines.length === 0) {
      blockHeadingPath = headingStack.filter(Boolean).join(' > ') || null;
      blockType = lineType;
    } else if (blockType !== lineType) {
      blockType = 'mixed';
    }

    lines.push(line);
    if (isFence) inCodeFence = !inCodeFence;
  }

  flush();
  return blocks;
}

function normalizeHeadingTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function detectChunkType(trimmedLine: string, isFence: boolean): TextChunkType {
  if (isFence) return 'code';
  if (/^\s*([-*+]|\d+[.)])\s+/.test(trimmedLine)) return 'list';
  if (/^\|.*\|\s*$/.test(trimmedLine)) return 'table';
  return 'paragraph';
}

function mergeHeadingPath(current: string | null, next: string | null): string | null {
  if (!current) return next;
  if (!next || next === current) return current;
  return next;
}

function mergeContextLabel(current: string | null, next: string | null): string | null {
  if (!current) return next;
  if (!next || next === current) return current;
  return next;
}

function mergeChunkType(current: TextChunkType, next: TextChunkType, hadExistingBuffer: boolean): TextChunkType {
  if (!hadExistingBuffer) return next;
  if (current === next) return current;
  return 'mixed';
}

function extractOverlap(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return '';
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
