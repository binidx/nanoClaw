/**
 * Command-aware bash output filtering.
 *
 * Inspired by RTK's semantic compression approach: instead of blindly
 * truncating large CLI outputs, we recognize common command patterns
 * (git, npm, cargo, tsc, etc.) and apply purpose-built filters that
 * preserve errors/failures while discarding progress noise.
 *
 * The filter runs *before* `truncateToolOutput` so the generic
 * truncation only kicks in as a safety net for truly huge results.
 */

// ── Types ──

interface FilterResult {
  output: string;
  filtered: boolean;
}

// ── Config ──

const GIT_LOG_MAX_LINE_WIDTH = 120;
const GIT_LOG_MAX_BODY_LINES = 3;
const GIT_DIFF_MAX_HUNK_LINES = 100;
const GIT_DIFF_MAX_TOTAL_LINES = 500;
const GIT_STATUS_MAX_FILES = 30;
const TEST_MAX_FAILURES = 10;
const TEST_FAILURE_MAX_CHARS = 300;
const BUILD_MAX_ISSUES = 15;
const INSTALL_MAX_LINES = 20;
const TREE_MAX_LINES = 60;

// ── Helpers ──

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

// ── Command classifier ──

type CommandCategory =
  | 'git-diff'
  | 'git-log'
  | 'git-status'
  | 'test-js'
  | 'test-cargo'
  | 'test-python'
  | 'build-cargo'
  | 'build-tsc'
  | 'install-npm'
  | 'tree'
  | null;

function classifyCommand(command: string): CommandCategory {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();

  if (/^git\s+diff\b/.test(normalized)) return 'git-diff';
  if (/^git\s+log\b/.test(normalized)) {
    if (/\s(-p\d*|--patch|--stat\b|--numstat|--shortstat|--diff-merges)\b/.test(normalized)) {
      return 'git-diff';
    }
    return 'git-log';
  }
  if (/^git\s+status\b/.test(normalized)) return 'git-status';
  if (/^git\s+show\b/.test(normalized)) return 'git-diff';

  if (/^(npx\s+)?(vitest|jest)\b/.test(normalized)) return 'test-js';
  if (/^(npm|pnpm|yarn)\s+(run\s+)?test\b/.test(normalized)) return 'test-js';

  if (/^cargo\s+test\b/.test(normalized)) return 'test-cargo';

  if (/^(python|python3|pytest|py\.test)\b.*test/i.test(normalized)) return 'test-python';
  if (/^pytest\b/.test(normalized)) return 'test-python';

  if (/^cargo\s+(build|check|clippy)\b/.test(normalized)) return 'build-cargo';
  if (/^(npx\s+)?tsc\b/.test(normalized)) return 'build-tsc';
  if (/^(npm|pnpm|yarn)\s+run\s+(build|compile|typecheck)\b/.test(normalized)) return 'build-tsc';

  if (/^(npm|pnpm|yarn)\s+install\b/.test(normalized)) return 'install-npm';
  if (/^(npm|pnpm|yarn)\s+i\b/.test(normalized)) return 'install-npm';
  if (/^(npm|pnpm|yarn)\s+add\b/.test(normalized)) return 'install-npm';
  if (/^(npm|pnpm|yarn)\s+ci\b/.test(normalized)) return 'install-npm';

  if (/^(tree|ls\s+-[a-zA-Z]*R|find\s)/.test(normalized)) return 'tree';

  return null;
}

// ── Git filters ──

function filterGitDiff(output: string): FilterResult {
  const lines = output.split('\n');
  if (lines.length <= GIT_DIFF_MAX_TOTAL_LINES) {
    return { output, filtered: false };
  }

  const result: string[] = [];
  let hunkLineCount = 0;
  let truncatedHunkLines = 0;
  let inHunk = false;
  let totalKept = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (totalKept >= GIT_DIFF_MAX_TOTAL_LINES) {
      result.push(`\n... ${lines.length - i} more lines not shown (total line cap reached)`);
      break;
    }

    const isDiffHeader =
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('rename ') ||
      line.startsWith('similarity ') ||
      line.startsWith('Binary files');

    if (isDiffHeader) {
      if (inHunk && truncatedHunkLines > 0) {
        result.push(`  ... ${truncatedHunkLines} lines truncated in hunk`);
        truncatedHunkLines = 0;
      }
      inHunk = false;
      hunkLineCount = 0;
      result.push(line);
      totalKept++;
      continue;
    }

    if (line.startsWith('@@')) {
      if (inHunk && truncatedHunkLines > 0) {
        result.push(`  ... ${truncatedHunkLines} lines truncated in hunk`);
        truncatedHunkLines = 0;
      }
      inHunk = true;
      hunkLineCount = 0;
      result.push(line);
      totalKept++;
      continue;
    }

    if (inHunk) {
      hunkLineCount++;
      if (hunkLineCount <= GIT_DIFF_MAX_HUNK_LINES) {
        result.push(line);
        totalKept++;
      } else {
        truncatedHunkLines++;
      }
    } else {
      result.push(line);
      totalKept++;
    }
  }

  if (truncatedHunkLines > 0) {
    result.push(`  ... ${truncatedHunkLines} lines truncated in hunk`);
  }

  const totalOriginal = lines.length;
  const totalResult = result.length;
  if (totalResult < totalOriginal) {
    result.push(
      `\n[diff filtered: ${totalOriginal} lines → ${totalResult} lines]`,
    );
  }

  return { output: result.join('\n'), filtered: totalResult < totalOriginal };
}

function filterGitLog(output: string): FilterResult {
  const lines = output.split('\n');
  if (lines.length <= 50) {
    return { output, filtered: false };
  }

  const result: string[] = [];
  let bodyLineCount = 0;
  let inBody = false;
  let skippedBodyLines = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const isCommitHeader = /^commit [0-9a-f]{7,40}/.test(trimmed);
    const isMetaLine =
      /^(Author|Date|Merge|CommitDate|AuthorDate):/.test(trimmed);
    const isTrailer =
      /^(Signed-off-by|Co-authored-by|Reviewed-by|Acked-by|Tested-by):/.test(trimmed);

    if (isCommitHeader) {
      if (skippedBodyLines > 0) {
        result.push(`    ... ${skippedBodyLines} more lines`);
        skippedBodyLines = 0;
      }
      inBody = false;
      bodyLineCount = 0;
      result.push(line);
      continue;
    }

    if (isMetaLine) {
      result.push(line);
      continue;
    }

    if (isTrailer) continue;

    if (trimmed === '') {
      if (!inBody) {
        inBody = true;
        bodyLineCount = 0;
      }
      if (bodyLineCount < GIT_LOG_MAX_BODY_LINES) {
        result.push(line);
        bodyLineCount++;
      } else {
        skippedBodyLines++;
      }
      continue;
    }

    if (inBody || (!isCommitHeader && !isMetaLine)) {
      inBody = true;
      bodyLineCount++;
      if (bodyLineCount <= GIT_LOG_MAX_BODY_LINES) {
        const truncatedLine =
          line.length > GIT_LOG_MAX_LINE_WIDTH
            ? line.slice(0, GIT_LOG_MAX_LINE_WIDTH) + '...'
            : line;
        result.push(truncatedLine);
      } else {
        skippedBodyLines++;
      }
    }
  }

  if (skippedBodyLines > 0) {
    result.push(`    ... ${skippedBodyLines} more lines`);
  }

  const filtered = result.length < lines.length;
  if (filtered) {
    result.push(
      `\n[log filtered: ${lines.length} lines → ${result.length} lines]`,
    );
  }
  return { output: result.join('\n'), filtered };
}

function filterGitStatus(output: string): FilterResult {
  const lines = output.split('\n').filter(Boolean);
  if (lines.length <= GIT_STATUS_MAX_FILES) {
    return { output, filtered: false };
  }

  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  const other: string[] = [];

  for (const line of lines) {
    const clean = stripAnsi(line).trimStart();
    if (clean.startsWith('??') || /^\s*Untracked/.test(clean)) {
      untracked.push(line);
    } else if (/^[MADRC][\s]/.test(clean) || /^\s*(new file|modified|deleted|renamed):/.test(clean)) {
      if (/^[MADRC]\s/.test(clean)) {
        staged.push(line);
      } else {
        modified.push(line);
      }
    } else {
      other.push(line);
    }
  }

  const result: string[] = [];
  const maxPerGroup = Math.floor(GIT_STATUS_MAX_FILES / 3);

  if (staged.length > 0) {
    const shown = staged.slice(0, maxPerGroup);
    result.push(...shown);
    if (staged.length > maxPerGroup) {
      result.push(`  ... +${staged.length - maxPerGroup} more staged files`);
    }
  }

  if (modified.length > 0) {
    const shown = modified.slice(0, maxPerGroup);
    result.push(...shown);
    if (modified.length > maxPerGroup) {
      result.push(`  ... +${modified.length - maxPerGroup} more modified files`);
    }
  }

  if (untracked.length > 0) {
    const shown = untracked.slice(0, maxPerGroup);
    result.push(...shown);
    if (untracked.length > maxPerGroup) {
      result.push(`  ... +${untracked.length - maxPerGroup} more untracked files`);
    }
  }

  result.push(...other);

  result.push(
    `\n[status summary: ${staged.length} staged, ${modified.length} modified, ${untracked.length} untracked]`,
  );

  return { output: result.join('\n'), filtered: true };
}

// ── Test filters ──

function filterTestOutput(output: string): FilterResult {
  const lines = output.split('\n');
  if (lines.length <= 30) {
    return { output, filtered: false };
  }

  const clean = stripAnsi(output);

  const summaryPatterns = [
    /Tests?\s*:?\s*(\d+)\s*(passed|failed|skipped)/i,
    /test result:\s*(ok|FAILED)/i,
    /Tests:\s*\d+\s*(passed|failed)/i,
    /(\d+)\s+passing,?\s+(\d+)?\s*failing/i,
    /\d+\s+passed/i,
  ];

  const hasSummary = summaryPatterns.some((p) => p.test(clean));
  const hasFailure =
    /FAIL|FAILED|ERROR|✗|✘|×/i.test(clean) &&
    !/0 failed/i.test(clean);

  if (!hasFailure && hasSummary) {
    const summaryLines = lines.filter((line) => {
      const stripped = stripAnsi(line).trim();
      return (
        summaryPatterns.some((p) => p.test(stripped)) ||
        /^(Test Suites|Tests|Snapshots|Time|Duration|Test Files):/i.test(stripped) ||
        /^\s*✓|\s*PASS\s/i.test(stripped) === false && stripped.length > 0 && (
          /passed/i.test(stripped) ||
          /test result/i.test(stripped) ||
          /duration/i.test(stripped)
        )
      );
    });

    if (summaryLines.length > 0) {
      const result = [
        'All tests passed.',
        '',
        ...summaryLines.slice(0, 5),
        '',
        `[test output filtered: ${lines.length} lines → ${summaryLines.length + 2} lines]`,
      ];
      return { output: result.join('\n'), filtered: true };
    }
  }

  if (hasFailure) {
    const result: string[] = [];
    let failureCount = 0;
    let inFailureBlock = false;
    let failureBlockChars = 0;
    const progressPatterns = [
      /^\s*(✓|✔|PASS|ok\s+\d|running\s+\d|Compiling|Downloading|Checking)/i,
      /^\s*\.\.\./,
    ];

    for (const line of lines) {
      const stripped = stripAnsi(line).trim();

      if (progressPatterns.some((p) => p.test(stripped))) continue;

      const isFailureStart =
        /^\s*(✗|✘|×|FAIL|FAILED|ERROR|not ok|---- .* ----)/i.test(stripped) ||
        /^\s*\d+\)\s/.test(stripped);

      if (isFailureStart && failureCount < TEST_MAX_FAILURES) {
        inFailureBlock = true;
        failureBlockChars = 0;
        failureCount++;
        result.push(line);
        continue;
      }

      if (inFailureBlock) {
        failureBlockChars += line.length;
        if (failureBlockChars > TEST_FAILURE_MAX_CHARS) {
          result.push('    ... (truncated)');
          inFailureBlock = false;
          continue;
        }
        if (stripped === '' || isFailureStart) {
          inFailureBlock = false;
        }
        result.push(line);
        continue;
      }

      if (summaryPatterns.some((p) => p.test(stripped))) {
        result.push(line);
      }
    }

    if (failureCount > TEST_MAX_FAILURES) {
      result.push(`\n... +${failureCount - TEST_MAX_FAILURES} more failures not shown`);
    }

    result.push(
      `\n[test output filtered: ${lines.length} lines → ${result.length} lines, ${failureCount} failure(s) shown]`,
    );
    return { output: result.join('\n'), filtered: true };
  }

  return { output, filtered: false };
}

// ── Build filters ──

function filterBuildOutput(output: string, category: CommandCategory): FilterResult {
  const lines = output.split('\n');
  if (lines.length <= 30) {
    return { output, filtered: false };
  }

  const result: string[] = [];
  let issueCount = 0;
  let droppedProgress = 0;

  const progressPatterns =
    category === 'build-cargo'
      ? [
          /^\s*(Compiling|Checking|Downloading|Downloaded|Updating|Packaging|Verifying|Fresh)\s/,
          /^\s*Finished\s/,
        ]
      : [/^\s*\.\.\./];

  const issueLine = (line: string): boolean => {
    const stripped = stripAnsi(line).trim();
    return (
      /^error(\[E\d+\])?:/i.test(stripped) ||
      /^warning(\[.*\])?:/i.test(stripped) ||
      /:\s*error\s*(TS\d+)?:/i.test(stripped) ||
      /:\s*warning\s*/i.test(stripped) ||
      /^ERROR\s/i.test(stripped) ||
      /^(=\s*)?(note|help)(\[.*\])?:/i.test(stripped)
    );
  };

  let inIssueBlock = false;

  for (const line of lines) {
    const stripped = stripAnsi(line).trim();

    if (progressPatterns.some((p) => p.test(stripped))) {
      droppedProgress++;
      continue;
    }

    if (issueLine(line)) {
      issueCount++;
      if (issueCount <= BUILD_MAX_ISSUES) {
        inIssueBlock = true;
        result.push(line);
      }
      continue;
    }

    if (inIssueBlock) {
      if (stripped === '' || issueLine(line)) {
        inIssueBlock = false;
      }
      if (issueCount <= BUILD_MAX_ISSUES) {
        result.push(line);
      }
      continue;
    }

    const isSummary =
      /^(error|warning)\[/.test(stripped) ||
      /aborting due to/i.test(stripped) ||
      /^\d+ error/i.test(stripped) ||
      /^\d+ warning/i.test(stripped) ||
      /^Found \d+ error/i.test(stripped) ||
      /^Build (succeeded|failed)/i.test(stripped) ||
      /could not compile/i.test(stripped) ||
      /^Finished\s/i.test(stripped);

    if (isSummary) {
      result.push(line);
    }
  }

  if (issueCount > BUILD_MAX_ISSUES) {
    result.push(`\n... +${issueCount - BUILD_MAX_ISSUES} more issues`);
  }

  if (result.length === 0 && droppedProgress > 0) {
    result.push('Build completed successfully (no errors or warnings).');
  }

  result.push(
    `\n[build output filtered: ${lines.length} lines → ${result.length} lines, ${droppedProgress} progress lines dropped]`,
  );

  return { output: result.join('\n'), filtered: true };
}

// ── Install filters ──

function filterInstallOutput(output: string): FilterResult {
  const lines = output.split('\n');
  if (lines.length <= INSTALL_MAX_LINES) {
    return { output, filtered: false };
  }

  const result: string[] = [];
  const summaryPatterns = [
    /^added \d+ package/i,
    /^removed \d+ package/i,
    /^up to date/i,
    /^(npm|pnpm|yarn)\s+(warn|ERR!)/i,
    /^\d+ packages? are looking for funding/i,
    /^found \d+ vulnerabilit/i,
    /^Lockfile/i,
    /^Done in/i,
    /^Progress:/i,
    /audited \d+ packages/i,
  ];

  const warningLines: string[] = [];

  for (const line of lines) {
    const stripped = stripAnsi(line).trim();
    if (!stripped) continue;

    if (/^(npm|pnpm|yarn)\s+(warn|ERR!)/i.test(stripped)) {
      warningLines.push(line);
      continue;
    }

    if (summaryPatterns.some((p) => p.test(stripped))) {
      result.push(line);
    }
  }

  if (warningLines.length > 0) {
    result.push(...warningLines.slice(0, 5));
    if (warningLines.length > 5) {
      result.push(`  ... +${warningLines.length - 5} more warnings`);
    }
  }

  if (result.length === 0) {
    result.push('Install completed.');
  }

  result.push(
    `\n[install output filtered: ${lines.length} lines → ${result.length} lines]`,
  );

  return { output: result.join('\n'), filtered: true };
}

// ── Tree/ls filters ──

function filterTreeOutput(output: string): FilterResult {
  const lines = output.split('\n');
  if (lines.length <= TREE_MAX_LINES) {
    return { output, filtered: false };
  }

  const kept = lines.slice(0, TREE_MAX_LINES);
  const omitted = lines.length - TREE_MAX_LINES;
  kept.push(`\n... ${omitted} more entries omitted`);
  kept.push(`[tree output filtered: ${lines.length} lines → ${TREE_MAX_LINES} lines]`);

  return { output: kept.join('\n'), filtered: true };
}

// ── Public API ──

/**
 * Categories where filtering is safe — output is noisy progress/success
 * spam that the model doesn't need verbatim for decision-making.
 *
 * Categories intentionally EXCLUDED (agent needs full output for review):
 *   git-diff, git-log, git-status
 * These are "information query" commands whose completeness is critical
 * for code review, PR analysis, and change assessment.
 */
const SAFE_TO_FILTER: ReadonlySet<CommandCategory> = new Set([
  'test-js',
  'test-cargo',
  'test-python',
  'build-cargo',
  'build-tsc',
  'install-npm',
  'tree',
]);

/**
 * Apply command-aware filtering to bash output.
 * Returns the original output unchanged for unrecognized commands,
 * outputs that are already small enough, or commands whose full output
 * is critical for correctness (git diff/log/status).
 */
export function filterBashOutput(command: string, rawOutput: string): string {
  if (!rawOutput || rawOutput.length < 500) return rawOutput;

  const category = classifyCommand(command);
  if (!category || !SAFE_TO_FILTER.has(category)) return rawOutput;

  let result: FilterResult;

  switch (category) {
    case 'test-js':
    case 'test-cargo':
    case 'test-python':
      result = filterTestOutput(rawOutput);
      break;
    case 'build-cargo':
    case 'build-tsc':
      result = filterBuildOutput(rawOutput, category);
      break;
    case 'install-npm':
      result = filterInstallOutput(rawOutput);
      break;
    case 'tree':
      result = filterTreeOutput(rawOutput);
      break;
    default:
      return rawOutput;
  }

  return result.output;
}

/**
 * Estimate token count using the simple bytes/4 heuristic.
 * Fast approximation — no tokenizer dependency.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / 4);
}
