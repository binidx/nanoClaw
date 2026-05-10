import type { CodeMapFile, CodeMapRenderOptions, CodeMapSnapshot } from './code-map-types.js';

const DEFAULT_RENDER_OPTIONS: CodeMapRenderOptions = {
  maxTokens: 2048,
  groupByDirectory: true,
};

const AVG_CHARS_PER_TOKEN = 4;

export function resolveRenderOptions(
  partial?: Partial<CodeMapRenderOptions>,
): CodeMapRenderOptions {
  return { ...DEFAULT_RENDER_OPTIONS, ...partial };
}

// ---------------------------------------------------------------------------
// Render a code map snapshot to aider-style text for LLM context
// ---------------------------------------------------------------------------

export function renderCodeMapText(
  snapshot: CodeMapSnapshot,
  options?: Partial<CodeMapRenderOptions>,
): string {
  const opts = resolveRenderOptions(options);
  const charBudget = opts.maxTokens * AVG_CHARS_PER_TOKEN;

  const header = [
    `# Code Map: ${snapshot.repositoryId} (${snapshot.branch})`,
    `# ${snapshot.stats.fileCount} files, ${snapshot.stats.symbolCount} symbols, ${snapshot.stats.edgeCount} dependencies`,
    '',
  ].join('\n');

  let used = header.length;
  const sections: string[] = [header];

  const sorted = [...snapshot.files].sort((a, b) => b.rank - a.rank);

  if (opts.groupByDirectory) {
    const groups = groupFilesByDirectory(sorted);
    for (const [dir, files] of groups) {
      const section = renderDirectoryGroup(dir, files);
      if (used + section.length > charBudget) {
        sections.push('⋮... (truncated by token budget)');
        break;
      }
      sections.push(section);
      used += section.length;
    }
  } else {
    for (const file of sorted) {
      const section = renderFileSection(file);
      if (used + section.length > charBudget) {
        sections.push('⋮... (truncated by token budget)');
        break;
      }
      sections.push(section);
      used += section.length;
    }
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Render compact summary for UI tooltips / quick preview
// ---------------------------------------------------------------------------

export function renderCodeMapSummary(snapshot: CodeMapSnapshot, topN = 10): string {
  const top = [...snapshot.files]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, topN);

  const lines = [
    `Repository: ${snapshot.repositoryId} | Branch: ${snapshot.branch}`,
    `Files: ${snapshot.stats.fileCount} | Symbols: ${snapshot.stats.symbolCount} | Deps: ${snapshot.stats.edgeCount}`,
    '',
    'Top files by importance:',
  ];

  for (const file of top) {
    const symbolNames = file.symbols
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 3)
      .map((s) => s.name)
      .join(', ');
    lines.push(`  ${file.relativePath} (${file.symbols.length} symbols: ${symbolNames || 'none'})`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function groupFilesByDirectory(
  files: CodeMapFile[],
): Array<[string, CodeMapFile[]]> {
  const dirMap = new Map<string, CodeMapFile[]>();

  for (const file of files) {
    const parts = file.relativePath.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    const group = dirMap.get(dir) || [];
    group.push(file);
    dirMap.set(dir, group);
  }

  const entries = Array.from(dirMap.entries());
  entries.sort((a, b) => {
    const maxA = Math.max(...a[1].map((f) => f.rank));
    const maxB = Math.max(...b[1].map((f) => f.rank));
    return maxB - maxA;
  });

  return entries;
}

function renderDirectoryGroup(dir: string, files: CodeMapFile[]): string {
  const lines = [`${dir}/:`];

  for (const file of files) {
    const fileName = file.relativePath.split('/').pop() || file.relativePath;
    const topSymbols = file.symbols
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 8);

    if (topSymbols.length === 0) {
      lines.push(`  ${fileName}`);
      continue;
    }

    lines.push(`  ${fileName}:`);
    for (const sym of topSymbols) {
      lines.push(`  │ ${sym.signature}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function renderFileSection(file: CodeMapFile): string {
  const topSymbols = file.symbols
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 8);

  const lines = [`${file.relativePath}:`];
  for (const sym of topSymbols) {
    lines.push(`│ ${sym.signature}`);
  }
  if (file.symbols.length > 8) {
    lines.push(`│ ⋮... (${file.symbols.length - 8} more)`);
  }
  lines.push('');
  return lines.join('\n');
}
