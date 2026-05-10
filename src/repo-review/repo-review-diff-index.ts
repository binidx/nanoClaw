export interface RepoReviewDiffIndexEntry {
  filePath: string;
  startOffset: number;
  endOffset: number;
  estimatedBytes: number;
}

export interface RepoReviewDiffIndex {
  diffText: string;
  files: string[];
  entries: RepoReviewDiffIndexEntry[];
  entriesByFile: Map<string, RepoReviewDiffIndexEntry>;
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

export function buildRepoReviewDiffIndex(
  diffText: string,
): RepoReviewDiffIndex {
  const text = diffText || '';
  const matches = Array.from(text.matchAll(/^diff --git .*$/gm));
  const entries: RepoReviewDiffIndexEntry[] = [];

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
  }

  return {
    diffText: text,
    files: entries.map((entry) => entry.filePath),
    entries,
    entriesByFile: new Map(entries.map((entry) => [entry.filePath, entry])),
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
    .map((entry) => index.diffText.slice(entry.startOffset, entry.endOffset).trim())
    .filter(Boolean)
    .join('\n');
}
