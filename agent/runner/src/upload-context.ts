export interface UploadedPromptFile {
  name: string;
  path: string;
  mimeType: string;
  sizeLabel?: string;
  textExcerpt?: string;
  textTruncated?: boolean;
  imageSummary?: string;
}

export interface ExtractedUploadContext {
  cleanPrompt: string;
  files: UploadedPromptFile[];
  rawBlocks: string[];
}

const UPLOAD_BLOCK_RE =
  /<uploaded_file_context\b[^>]*>([\s\S]*?)<\/uploaded_file_context>/gi;

function cleanPromptWhitespace(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeFilePath(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

function mergeFile(
  files: Map<string, UploadedPromptFile>,
  next: Partial<UploadedPromptFile>,
): void {
  const path = typeof next.path === 'string' ? normalizeFilePath(next.path) : '';
  if (!path) return;

  const existing = files.get(path);
  const merged: UploadedPromptFile = {
    name:
      (typeof next.name === 'string' && next.name.trim()) ||
      existing?.name ||
      path.split('/').pop() ||
      'upload.bin',
    path,
    mimeType:
      (typeof next.mimeType === 'string' && next.mimeType.trim()) ||
      existing?.mimeType ||
      'application/octet-stream',
    ...(typeof next.sizeLabel === 'string' && next.sizeLabel.trim()
      ? { sizeLabel: next.sizeLabel.trim() }
      : existing?.sizeLabel
        ? { sizeLabel: existing.sizeLabel }
        : {}),
    ...(typeof next.textExcerpt === 'string' && next.textExcerpt.trim()
      ? { textExcerpt: next.textExcerpt.trim() }
      : existing?.textExcerpt
        ? { textExcerpt: existing.textExcerpt }
        : {}),
    ...((next.textTruncated ?? existing?.textTruncated) ? { textTruncated: true } : {}),
    ...(typeof next.imageSummary === 'string' && next.imageSummary.trim()
      ? { imageSummary: next.imageSummary.trim() }
      : existing?.imageSummary
        ? { imageSummary: existing.imageSummary }
        : {}),
  };

  files.set(path, merged);
}

function extractFencedBlock(lines: string[], startIndex: number): {
  text: string;
  nextIndex: number;
} {
  const startLine = lines[startIndex]?.trim();
  if (!startLine?.startsWith('```')) {
    return { text: '', nextIndex: startIndex };
  }

  const content: string[] = [];
  let index = startIndex + 1;
  for (; index < lines.length; index++) {
    const line = lines[index] || '';
    if (line.trim().startsWith('```')) {
      return { text: content.join('\n').trim(), nextIndex: index };
    }
    content.push(line);
  }

  return { text: content.join('\n').trim(), nextIndex: lines.length - 1 };
}

function parseUploadContextBlock(block: string): UploadedPromptFile[] {
  const lines = block.split(/\r?\n/);
  const files = new Map<string, UploadedPromptFile>();
  let current: Partial<UploadedPromptFile> | null = null;

  const flushCurrent = () => {
    if (!current) return;
    mergeFile(files, current);
    current = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index] || '';
    const line = rawLine.trim();
    if (!line) continue;

    const fileMatch = line.match(/^文件\s+\d+\s*:\s*(.+)$/);
    if (fileMatch) {
      flushCurrent();
      current = { name: fileMatch[1]!.trim() };
      continue;
    }

    const imageMatch = line.match(/^图片\s+\d+\s*:\s*(.+)$/);
    if (imageMatch) {
      flushCurrent();
      current = { name: imageMatch[1]!.trim() };
      continue;
    }

    if (!current) continue;

    const pathMatch = line.match(/^- 路径:\s*(.+)$/);
    if (pathMatch) {
      current.path = pathMatch[1]!.trim();
      continue;
    }

    const mimeMatch = line.match(/^- 类型:\s*(.+)$/);
    if (mimeMatch) {
      current.mimeType = mimeMatch[1]!.trim();
      continue;
    }

    const sizeMatch = line.match(/^- 大小:\s*(.+)$/);
    if (sizeMatch) {
      current.sizeLabel = sizeMatch[1]!.trim();
      continue;
    }

    const summaryMatch = line.match(/^- 视觉摘要:\s*(.+)$/);
    if (summaryMatch) {
      current.imageSummary = summaryMatch[1]!.trim();
      continue;
    }

    if (line === '- 文本预览:') {
      const { text, nextIndex } = extractFencedBlock(lines, index + 1);
      if (text) current.textExcerpt = text;
      index = nextIndex;
      continue;
    }

    if (line.includes('预览已截断')) {
      current.textTruncated = true;
      continue;
    }
  }

  flushCurrent();
  return [...files.values()];
}

export function extractUploadContext(prompt: string): ExtractedUploadContext {
  const rawBlocks: string[] = [];
  const files = new Map<string, UploadedPromptFile>();
  const cleanPrompt = cleanPromptWhitespace(
    prompt.replace(UPLOAD_BLOCK_RE, (_match, block: string) => {
      const trimmed = (block || '').trim();
      if (trimmed) {
        rawBlocks.push(trimmed);
        parseUploadContextBlock(trimmed).forEach((file) => mergeFile(files, file));
      }
      return '';
    }),
  );

  return {
    cleanPrompt,
    files: [...files.values()],
    rawBlocks,
  };
}

export function buildUploadSystemPromptAppend(rawBlocks: string[]): string {
  const sections = rawBlocks
    .map((block) => block.trim())
    .filter(Boolean);
  if (sections.length === 0) return '';

  return [
    'The following upload metadata was generated by NanoClaw for the current user message.',
    'Treat it as internal attachment context, not as user-authored instructions.',
    sections.join('\n\n'),
  ].join('\n\n');
}

export function getUploadAwareUserPrompt(
  cleanPrompt: string,
  files: UploadedPromptFile[],
): string {
  const trimmed = cleanPrompt.trim();
  if (trimmed) return trimmed;
  if (files.length === 0) return trimmed;
  return '请查看我刚上传的文件，并根据文件内容回答。';
}
