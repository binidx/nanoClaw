import type {
  BrowserRoleSnapshot,
  BrowserRoleSnapshotRef,
  BrowserSnapshot,
  BrowserSnapshotNode,
} from './types.js';
import type { ResolvedSnapshotRef } from './cdp.js';

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

export interface BrowserRoleSnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
}

function isInteractiveNode(node: BrowserSnapshotNode): boolean {
  return node.actionable || INTERACTIVE_ROLES.has(node.role.toLowerCase());
}

function fallbackLabel(node: BrowserSnapshotNode): string | undefined {
  return node.name || node.value || node.description;
}

function includeNode(
  node: BrowserSnapshotNode,
  options: BrowserRoleSnapshotOptions,
): boolean {
  if (
    typeof options.maxDepth === 'number' &&
    Number.isFinite(options.maxDepth) &&
    node.depth > options.maxDepth
  ) {
    return false;
  }
  if (options.interactive && !isInteractiveNode(node)) {
    return false;
  }
  if (options.compact && !node.actionable && !fallbackLabel(node)) {
    return false;
  }
  return true;
}

function formatNodeLine(node: BrowserSnapshotNode): string {
  let line = `${'  '.repeat(Math.max(0, node.depth))}- ${node.role || 'node'}`;
  const label = fallbackLabel(node);
  if (label) {
    line += ` "${label}"`;
  }
  if (node.actionable) {
    line += ` [ref=${node.ref}]`;
  }
  if (node.topFrame === false) {
    line += ` [frame=${node.frameName || node.frameId || 'iframe'}]`;
  }
  return line;
}

function statsFromSnapshot(
  snapshot: string,
  refs: Record<string, BrowserRoleSnapshotRef>,
): BrowserRoleSnapshot['stats'] {
  return {
    lines: snapshot ? snapshot.split('\n').length : 0,
    chars: snapshot.length,
    refs: Object.keys(refs).length,
    interactive: Object.keys(refs).length,
  };
}

interface RoleSnapshotEntry {
  line: string;
  ref?: {
    ref: string;
    value: BrowserRoleSnapshotRef;
  };
}

function truncateEntries(
  entries: RoleSnapshotEntry[],
  maxChars?: number,
): {
  lines: string[];
  refs: Record<string, BrowserRoleSnapshotRef>;
  truncated: boolean;
} {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars <= 0) {
    const refs: Record<string, BrowserRoleSnapshotRef> = {};
    for (const entry of entries) {
      if (entry.ref) refs[entry.ref.ref] = entry.ref.value;
    }
    return {
      lines: entries.map((entry) => entry.line),
      refs,
      truncated: false,
    };
  }

  let currentLength = 0;
  let includedCount = entries.length;
  for (let index = 0; index < entries.length; index += 1) {
    const nextLength =
      currentLength + (index === 0 ? 0 : 1) + entries[index]!.line.length;
    if (nextLength > maxChars) {
      includedCount = index;
      break;
    }
    currentLength = nextLength;
  }

  if (includedCount >= entries.length) {
    const refs: Record<string, BrowserRoleSnapshotRef> = {};
    for (const entry of entries) {
      if (entry.ref) refs[entry.ref.ref] = entry.ref.value;
    }
    return {
      lines: entries.map((entry) => entry.line),
      refs,
      truncated: false,
    };
  }

  const visibleEntries = entries.slice(0, includedCount);
  const refs: Record<string, BrowserRoleSnapshotRef> = {};
  for (const entry of visibleEntries) {
    if (entry.ref) refs[entry.ref.ref] = entry.ref.value;
  }
  return {
    lines: [
      ...visibleEntries.map((entry) => entry.line),
      `[...TRUNCATED: ${entries.length - includedCount} more lines omitted]`,
    ],
    refs,
    truncated: true,
  };
}

export function buildBrowserRoleSnapshot(input: {
  snapshot: BrowserSnapshot;
  resolvedRefs: Record<string, ResolvedSnapshotRef>;
  options?: BrowserRoleSnapshotOptions;
  maxChars?: number;
}): BrowserRoleSnapshot {
  const options = input.options || {};
  const entries: RoleSnapshotEntry[] = [];

  for (const node of input.snapshot.nodes) {
    if (!includeNode(node, options)) {
      continue;
    }
    const ref =
      node.actionable && input.resolvedRefs[node.ref]
        ? {
            ref: node.ref,
            value: {
              role: node.role,
              ...(node.name ? { name: node.name } : {}),
              ...(node.frameId ? { frameId: node.frameId } : {}),
              ...(node.frameName ? { frameName: node.frameName } : {}),
              ...(typeof node.topFrame === 'boolean'
                ? { topFrame: node.topFrame }
                : {}),
            },
          }
        : undefined;
    entries.push({
      line: formatNodeLine(node),
      ...(ref ? { ref } : {}),
    });
  }

  const truncated = truncateEntries(entries, input.maxChars);
  const snapshotText = truncated.lines.join('\n');
  return {
    targetId: input.snapshot.targetId,
    title: input.snapshot.title,
    url: input.snapshot.url,
    snapshot: snapshotText,
    refs: truncated.refs,
    stats: statsFromSnapshot(snapshotText, truncated.refs),
    ...(truncated.truncated ? { truncated: true } : {}),
  };
}
