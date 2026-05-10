import type { CdpClient } from './cdp-client.js';
import {
  installConsoleCapture,
  injectConsoleCapture,
  withReadRetry,
  withTargetSession,
} from './cdp-session.js';
import {
  CONSOLE_BUFFER_KEY,
  PAGE_ERROR_BUFFER_KEY,
} from './cdp-scripts.js';
import {
  BrowserError,
  type BrowserLogs,
  type BrowserScreenshot,
  type BrowserSnapshot,
  type BrowserSnapshotFrame,
  type BrowserSnapshotNode,
} from './types.js';

interface RawAXNode {
  nodeId?: string;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  description?: { value?: unknown };
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

interface RawFrameTreeNode {
  frame?: {
    id?: string;
    parentId?: string;
    url?: string;
    name?: string;
  };
  childFrames?: RawFrameTreeNode[];
}

export interface ResolvedSnapshotRef {
  backendNodeId: number;
  node: BrowserSnapshotNode;
}

export function valueAsText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function frameSummaryFromTree(
  tree: RawFrameTreeNode | undefined,
): Record<
  string,
  { url?: string; name?: string; parentFrameId?: string; topFrame: boolean }
> {
  const output: Record<
    string,
    { url?: string; name?: string; parentFrameId?: string; topFrame: boolean }
  > = {};
  const rootFrameId = valueAsText(tree?.frame?.id);
  const stack = tree ? [tree] : [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const frameId = valueAsText(current.frame?.id);
    if (frameId) {
      output[frameId] = {
        url: valueAsText(current.frame?.url) || undefined,
        name: valueAsText(current.frame?.name) || undefined,
        parentFrameId: valueAsText(current.frame?.parentId) || undefined,
        topFrame: frameId === rootFrameId,
      };
    }
    for (const child of current.childFrames || []) {
      stack.push(child);
    }
  }
  return output;
}

function snapshotFramesFromTree(
  tree: RawFrameTreeNode | undefined,
): BrowserSnapshotFrame[] {
  const summary = frameSummaryFromTree(tree);
  return Object.entries(summary).map(([frameId, frame]) => ({
    frameId,
    url: frame.url,
    name: frame.name,
    parentFrameId: frame.parentFrameId,
    topFrame: frame.topFrame,
  }));
}

function formatAriaSnapshot(
  nodes: RawAXNode[],
  limit: number,
  framesById: Record<
    string,
    { url?: string; name?: string; parentFrameId?: string; topFrame: boolean }
  > = {},
): Array<BrowserSnapshotNode & { backendNodeId?: number }> {
  const byId = new Map<string, RawAXNode>();
  for (const node of nodes) {
    if (node.nodeId) {
      byId.set(node.nodeId, node);
    }
  }

  const referenced = new Set<string>();
  for (const node of nodes) {
    for (const childId of node.childIds || []) {
      referenced.add(childId);
    }
  }

  const root =
    nodes.find((node) => node.nodeId && !referenced.has(node.nodeId)) ||
    nodes[0];
  if (!root?.nodeId) {
    return [];
  }

  const output: Array<BrowserSnapshotNode & { backendNodeId?: number }> = [];
  const stack: Array<{ id: string; depth: number }> = [
    { id: root.nodeId, depth: 0 },
  ];

  while (stack.length > 0 && output.length < limit) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const node = byId.get(current.id);
    if (!node) {
      continue;
    }

    const backendNodeId =
      typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined;
    const frameId = valueAsText(node.frameId) || undefined;
    const frame = frameId ? framesById[frameId] : undefined;
    output.push({
      ref: `ax-${current.id}`,
      role: valueAsText(node.role?.value),
      name: valueAsText(node.name?.value),
      value: valueAsText(node.value?.value) || undefined,
      description: valueAsText(node.description?.value) || undefined,
      depth: current.depth,
      actionable: typeof backendNodeId === 'number',
      ...(frameId ? { frameId } : {}),
      ...(frame?.parentFrameId ? { parentFrameId: frame.parentFrameId } : {}),
      ...(frame?.url ? { frameUrl: frame.url } : {}),
      ...(frame?.name ? { frameName: frame.name } : {}),
      ...(frame ? { topFrame: frame.topFrame } : {}),
      ...(typeof backendNodeId === 'number' ? { backendNodeId } : {}),
    });

    const children = [...(node.childIds || [])].reverse();
    for (const childId of children) {
      stack.push({ id: childId, depth: current.depth + 1 });
    }
  }

  return output;
}

export async function readTargetPageState(
  client: CdpClient,
  sessionId: string,
): Promise<{ title: string; url: string }> {
  const evaluated = await client.send(
    'Runtime.evaluate',
    {
      expression: '({ title: document.title || "", url: location.href || "" })',
      returnByValue: true,
    },
    { sessionId },
  );
  const value = (evaluated.result as { value?: Record<string, unknown> } | undefined)
    ?.value;
  return {
    title: valueAsText(value?.title),
    url: valueAsText(value?.url),
  };
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function createBrowserSnapshot(input: {
  cdpUrl: string;
  targetId: string;
  maxNodes?: number;
}): Promise<BrowserSnapshot & { resolvedRefs: Record<string, ResolvedSnapshotRef> }> {
  const snapshot = await withReadRetry(async () =>
    await withTargetSession(
      input.cdpUrl,
      input.targetId,
      async (client, sessionId, tab) => {
        await client.send('Accessibility.enable', undefined, { sessionId });
        const frameTree = (await client
          .send('Page.getFrameTree', undefined, { sessionId })
          .catch(() => ({}))) as {
          frameTree?: RawFrameTreeNode;
        };
        const tree = await client.send(
          'Accessibility.getFullAXTree',
          undefined,
          { sessionId, timeoutMs: 15000 },
        );
        const rawFrameTree = frameTree.frameTree;
        const framesById = frameSummaryFromTree(rawFrameTree);
        const nodes = formatAriaSnapshot(
          Array.isArray(tree.nodes) ? (tree.nodes as RawAXNode[]) : [],
          input.maxNodes ?? 200,
          framesById,
        );
        const resolvedRefs: Record<string, ResolvedSnapshotRef> = {};
        const publicNodes: BrowserSnapshotNode[] = nodes.map((node) => {
          const { backendNodeId, ...publicNode } = node;
          if (typeof backendNodeId === 'number') {
            resolvedRefs[publicNode.ref] = {
              backendNodeId,
              node: publicNode,
            };
          }
          return publicNode;
        });
        const page = await readTargetPageState(client, sessionId);
        return {
          targetId: tab.targetId,
          title: page.title || tab.title,
          url: page.url || tab.url,
          frames: snapshotFramesFromTree(rawFrameTree),
          nodes: publicNodes,
          resolvedRefs,
        };
      },
    ),
  );
  await injectConsoleCapture(input.cdpUrl, snapshot.targetId).catch(() => undefined);
  return snapshot;
}

export async function captureBrowserScreenshot(input: {
  cdpUrl: string;
  targetId: string;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
}): Promise<BrowserScreenshot> {
  return await withReadRetry(async () =>
    await withTargetSession(
      input.cdpUrl,
      input.targetId,
      async (client, sessionId, tab) => {
        const format = input.format || 'png';
        const captureParams: Record<string, unknown> = { format };
        if ((format === 'jpeg' || format === 'webp') && typeof input.quality === 'number') {
          captureParams.quality = Math.max(0, Math.min(100, input.quality));
        }
        const captured = await client.send(
          'Page.captureScreenshot',
          captureParams,
          { sessionId, timeoutMs: 15000 },
        );
        const data = valueAsText(captured.data);
        if (!data) {
          throw new BrowserError(502, 'Browser did not return screenshot data');
        }
        const page = await readTargetPageState(client, sessionId);
        const mimeMap = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
        return {
          targetId: tab.targetId,
          title: page.title || tab.title,
          url: page.url || tab.url,
          mimeType: mimeMap[format],
          data,
        };
      },
    ),
  );
}

export async function readBrowserLogs(
  cdpUrl: string,
  targetId: string,
): Promise<BrowserLogs> {
  return await withReadRetry(async () =>
    await withTargetSession(cdpUrl, targetId, async (client, sessionId) => {
      await installConsoleCapture(client, sessionId);
      const consoleResult = await client.send(
        'Runtime.evaluate',
        {
          expression: `JSON.stringify(window.${CONSOLE_BUFFER_KEY} || [])`,
          returnByValue: true,
        },
        { sessionId, timeoutMs: 5000 },
      );
      const errorResult = await client.send(
        'Runtime.evaluate',
        {
          expression: `JSON.stringify(window.${PAGE_ERROR_BUFFER_KEY} || [])`,
          returnByValue: true,
        },
        { sessionId, timeoutMs: 5000 },
      );
      const consoleValue = (consoleResult.result as { value?: unknown } | undefined)?.value;
      const errorValue = (errorResult.result as { value?: unknown } | undefined)?.value;
      return {
        console: parseJsonArray<BrowserLogs['console'][number]>(consoleValue),
        errors: parseJsonArray<BrowserLogs['errors'][number]>(errorValue),
      };
    }),
  );
}
