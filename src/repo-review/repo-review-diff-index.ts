export interface RepoReviewDiffIndexEntry {
  filePath: string;
  startOffset: number;
  endOffset: number;
  estimatedBytes: number;
}

export interface RepoReviewDiffHunkEntry {
  filePath: string;
  oldStart: number;
  oldLineCount: number;
  oldEnd: number;
  newStart: number;
  newLineCount: number;
  newEnd: number;
  header: string;
  startOffset: number;
  endOffset: number;
  addedLineNumbers: number[];
  removedLineNumbers: number[];
  contextLineCount: number;
}

export interface RepoReviewDiffIndex {
  diffText: string;
  files: string[];
  entries: RepoReviewDiffIndexEntry[];
  entriesByFile: Map<string, RepoReviewDiffIndexEntry>;
  hunks: RepoReviewDiffHunkEntry[];
  hunksByFile: Map<string, RepoReviewDiffHunkEntry[]>;
}

function parseRepoReviewDiffHeader(line: string): {
  oldPath: string;
  newPath: string;
} | null {
  const plain = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (plain) {
    return {
      oldPath: plain[1] || '',
      newPath: plain[2] || plain[1] || '',
    };
  }
  const quoted = /^diff --git "a\/(.+?)" "b\/(.+?)"$/.exec(line);
  if (quoted) {
    return {
      oldPath: quoted[1] || '',
      newPath: quoted[2] || quoted[1] || '',
    };
  }
  return null;
}

function parseRepoReviewDiffHunks(input: {
  filePath: string;
  slice: string;
  baseOffset: number;
}): RepoReviewDiffHunkEntry[] {
  const lines = input.slice.split('\n');
  const hunks: RepoReviewDiffHunkEntry[] = [];
  let offset = input.baseOffset;
  let current:
    | (Omit<RepoReviewDiffHunkEntry, 'endOffset' | 'oldEnd' | 'newEnd'> & {
        oldLine: number;
        newLine: number;
      })
    | null = null;

  const flush = (endOffset: number) => {
    if (!current) return;
    const oldEnd =
      current.oldLineCount > 0
        ? current.oldStart + current.oldLineCount - 1
        : current.oldStart;
    const newEnd =
      current.newLineCount > 0
        ? current.newStart + current.newLineCount - 1
        : current.newStart;
    hunks.push({
      filePath: current.filePath,
      oldStart: current.oldStart,
      oldLineCount: current.oldLineCount,
      oldEnd,
      newStart: current.newStart,
      newLineCount: current.newLineCount,
      newEnd,
      header: current.header,
      startOffset: current.startOffset,
      endOffset,
      addedLineNumbers: current.addedLineNumbers,
      removedLineNumbers: current.removedLineNumbers,
      contextLineCount: current.contextLineCount,
    });
    current = null;
  };

  for (const line of lines) {
    const lineLength = Buffer.byteLength(line, 'utf8');
    const nextOffset = offset + lineLength + 1;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      flush(offset);
      const oldStart = Number(match[1]) || 0;
      const oldLineCount = match[2] === undefined ? 1 : Number(match[2]) || 0;
      const newStart = Number(match[3]) || 0;
      const newLineCount = match[4] === undefined ? 1 : Number(match[4]) || 0;
      current = {
        filePath: input.filePath,
        oldStart,
        oldLineCount,
        newStart,
        newLineCount,
        header: line,
        startOffset: offset,
        addedLineNumbers: [],
        removedLineNumbers: [],
        contextLineCount: 0,
        oldLine: oldStart,
        newLine: newStart,
      };
      offset = nextOffset;
      continue;
    }

    if (current) {
      if (line.startsWith('\\')) {
        offset = nextOffset;
        continue;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        current.addedLineNumbers.push(current.newLine);
        current.newLine += 1;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        current.removedLineNumbers.push(current.oldLine);
        current.oldLine += 1;
      } else {
        current.contextLineCount += 1;
        current.oldLine += 1;
        current.newLine += 1;
      }
    }
    offset = nextOffset;
  }
  flush(input.baseOffset + Buffer.byteLength(input.slice, 'utf8'));
  return hunks;
}

export function buildRepoReviewDiffIndex(
  diffText: string,
): RepoReviewDiffIndex {
  const text = diffText || '';
  const matches = Array.from(text.matchAll(/^diff --git .*$/gm));
  const entries: RepoReviewDiffIndexEntry[] = [];
  const hunks: RepoReviewDiffHunkEntry[] = [];

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const parsed = parseRepoReviewDiffHeader(match[0] || '');
    const filePath = parsed?.newPath || parsed?.oldPath || '';
    if (!filePath) continue;
    const startOffset = match.index ?? 0;
    const endOffset = matches[i + 1]?.index ?? text.length;
    const slice = text.slice(startOffset, endOffset).trim();
    entries.push({
      filePath,
      startOffset,
      endOffset,
      estimatedBytes: Buffer.byteLength(slice, 'utf8'),
    });
    hunks.push(
      ...parseRepoReviewDiffHunks({
        filePath,
        slice,
        baseOffset: startOffset,
      }),
    );
  }

  const hunksByFile = new Map<string, RepoReviewDiffHunkEntry[]>();
  for (const hunk of hunks) {
    const entries = hunksByFile.get(hunk.filePath) || [];
    entries.push(hunk);
    hunksByFile.set(hunk.filePath, entries);
  }

  return {
    diffText: text,
    files: entries.map((entry) => entry.filePath),
    entries,
    entriesByFile: new Map(entries.map((entry) => [entry.filePath, entry])),
    hunks,
    hunksByFile,
  };
}

export function getRepoReviewDiffSlice(
  index: RepoReviewDiffIndex,
  files: string[],
): string {
  if (files.length === 0) return '';
  const seen = new Set<string>();
  const selectedEntries = files
    .map((filePath) => {
      const normalized = String(filePath || '');
      if (!normalized || seen.has(normalized)) return null;
      seen.add(normalized);
      return index.entriesByFile.get(normalized) || null;
    })
    .filter((entry): entry is RepoReviewDiffIndexEntry => entry !== null)
    .sort((left, right) => left.startOffset - right.startOffset);

  return selectedEntries
    .map((entry) =>
      index.diffText.slice(entry.startOffset, entry.endOffset).trim(),
    )
    .filter(Boolean)
    .join('\n');
}
