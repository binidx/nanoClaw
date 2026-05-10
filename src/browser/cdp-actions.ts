import type { CdpClient } from './cdp-client.js';
import { listBrowserTabs } from './cdp-client.js';
import {
  type ResolvedSnapshotRef,
  readTargetPageState,
  valueAsText,
} from './cdp-snapshot.js';
import { withTargetSession } from './cdp-session.js';
import { toAIFriendlyError } from './errors.js';
import { isPrivateHostnameResolved } from './policy.js';
import { BrowserError, type BrowserAction } from './types.js';

interface RawTargetInfo {
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
  attached?: boolean;
  parentFrameId?: string;
}

interface ActionSessionState {
  rootSessionId: string;
  frameSessionByFrameId: Map<string, string>;
  frameTargetIdByFrameId: Map<string, string | null>;
  executionContextByFrameId: Map<string, number>;
}

const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
} as const;

const KEY_ALIASES: Record<string, string> = {
  Ctrl: 'Control',
  Cmd: 'Meta',
  Command: 'Meta',
  Option: 'Alt',
};

export interface BrowserKeyDefinition {
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
}


async function resolveNodeObjectId(
  client: CdpClient,
  sessionId: string,
  backendNodeId: number,
  opts?: {
    rootSessionId?: string;
    frameId?: string;
    topFrame?: boolean;
    executionContextByFrameId?: Map<string, number>;
  },
): Promise<string> {
  let executionContextId: number | undefined;
  if (
    opts?.frameId &&
    opts.topFrame === false &&
    sessionId === opts.rootSessionId
  ) {
    executionContextId = opts.executionContextByFrameId?.get(opts.frameId);
    if (typeof executionContextId !== 'number') {
      const created = await client.send(
        'Page.createIsolatedWorld',
        {
          frameId: opts.frameId,
          worldName: 'nanoclaw-browser-control',
        },
        { sessionId },
      );
      executionContextId =
        typeof created.executionContextId === 'number'
          ? created.executionContextId
          : undefined;
      if (typeof executionContextId === 'number') {
        opts.executionContextByFrameId?.set(opts.frameId, executionContextId);
      }
    }
  }
  const resolved = await client.send(
    'DOM.resolveNode',
    {
      backendNodeId,
      ...(typeof executionContextId === 'number'
        ? { executionContextId }
        : {}),
    },
    { sessionId },
  );
  const objectId = String(
    (resolved.object as { objectId?: string } | undefined)?.objectId || '',
  ).trim();
  if (!objectId) {
    throw new BrowserError(502, `Failed to resolve DOM node ${backendNodeId}`);
  }
  return objectId;
}

async function resolveSelectorTarget(
  client: CdpClient,
  sessionId: string,
  selector: string,
): Promise<ResolvedSnapshotRef> {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new BrowserError(400, 'selector is required');
  }
  await client.send('DOM.enable', undefined, { sessionId });
  const document = await client.send('DOM.getDocument', { depth: 0 }, { sessionId });
  const root = document.root as { nodeId?: number } | undefined;
  const rootNodeId = typeof root?.nodeId === 'number'
    ? root.nodeId
    : undefined;
  if (!rootNodeId) {
    throw new BrowserError(502, 'Failed to resolve browser document root');
  }
  const found = await client.send(
    'DOM.querySelector',
    {
      nodeId: rootNodeId,
      selector: trimmed,
    },
    { sessionId },
  );
  const nodeId = typeof found.nodeId === 'number' ? found.nodeId : undefined;
  if (!nodeId) {
    throw new BrowserError(404, `Selector did not match any element: ${trimmed}`);
  }
  const described = await client.send(
    'DOM.describeNode',
    { nodeId, depth: 0 },
    { sessionId },
  );
  const describedNode = described.node as
    | { backendNodeId?: number; nodeName?: unknown }
    | undefined;
  const backendNodeId =
    typeof describedNode?.backendNodeId === 'number'
      ? describedNode.backendNodeId
      : undefined;
  if (!backendNodeId) {
    throw new BrowserError(502, `Failed to resolve selector backend node: ${trimmed}`);
  }
  return {
    backendNodeId,
    node: {
      ref: `selector:${trimmed}`,
      role: valueAsText(describedNode?.nodeName) || 'element',
      name: trimmed,
      depth: 0,
      actionable: true,
      topFrame: true,
    },
  };
}

async function selectorExists(
  client: CdpClient,
  sessionId: string,
  selector: string,
): Promise<boolean> {
  const trimmed = selector.trim();
  if (!trimmed) {
    return false;
  }
  await client.send('DOM.enable', undefined, { sessionId });
  const document = await client.send('DOM.getDocument', { depth: 0 }, { sessionId });
  const root = document.root as { nodeId?: number } | undefined;
  const rootNodeId =
    typeof root?.nodeId === 'number' ? root.nodeId : undefined;
  if (!rootNodeId) {
    return false;
  }
  const found = await client.send(
    'DOM.querySelector',
    {
      nodeId: rootNodeId,
      selector: trimmed,
    },
    { sessionId },
  );
  return typeof found.nodeId === 'number' && found.nodeId > 0;
}

async function waitForBrowserConditions(
  client: CdpClient,
  sessionId: string,
  action: Extract<BrowserAction, { kind: 'waitFor' }>,
  defaultTimeoutMs: number,
): Promise<number> {
  const timeoutMs = Math.max(
    0,
    Math.min(120000, action.timeoutMs ?? defaultTimeoutMs),
  );
  const pollIntervalMs = Math.max(
    0,
    Math.min(5000, action.pollIntervalMs ?? 250),
  );
  const selector = String(action.selector || '').trim();
  const urlIncludes = String(action.urlIncludes || '').trim();
  const titleIncludes = String(action.titleIncludes || '').trim();
  const startedAt = Date.now();

  if (!selector && !urlIncludes && !titleIncludes) {
    throw new BrowserError(
      400,
      'waitFor requires selector, urlIncludes, or titleIncludes',
    );
  }

  while (true) {
    let matched = true;
    let pageState: { title: string; url: string } | null = null;

    if (urlIncludes || titleIncludes) {
      pageState = await readTargetPageState(client, sessionId);
      if (urlIncludes && !pageState.url.includes(urlIncludes)) {
        matched = false;
      }
      if (matched && titleIncludes && !pageState.title.includes(titleIncludes)) {
        matched = false;
      }
    }

    if (matched && selector) {
      matched = await selectorExists(client, sessionId, selector);
    }

    if (matched) {
      return Date.now() - startedAt;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      const conditions = [
        selector ? `selector=${selector}` : '',
        urlIncludes ? `urlIncludes=${urlIncludes}` : '',
        titleIncludes ? `titleIncludes=${titleIncludes}` : '',
      ].filter(Boolean);
      throw new BrowserError(
        504,
        `Timed out waiting for browser condition: ${conditions.join(', ')}`,
      );
    }

    const waitMs = Math.min(pollIntervalMs, timeoutMs - elapsedMs);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function resolveActionSessionId(
  client: CdpClient,
  state: ActionSessionState,
  ref: ResolvedSnapshotRef,
): Promise<string> {
  if (!ref.node.frameId || ref.node.topFrame !== false) {
    return state.rootSessionId;
  }
  const cached = state.frameSessionByFrameId.get(ref.node.frameId);
  if (cached) {
    return cached;
  }
  let targetId = state.frameTargetIdByFrameId.get(ref.node.frameId);
  if (targetId === undefined) {
    targetId = null;
    try {
      const targets = await client.send('Target.getTargets');
      const targetInfos = Array.isArray(targets.targetInfos)
        ? (targets.targetInfos as RawTargetInfo[]).filter(
            (entry) =>
              entry.type === 'iframe' &&
              valueAsText(entry.targetId).length > 0,
          )
        : [];
      const exactMatch = targetInfos.find(
        (entry) =>
          valueAsText(entry.targetId) === ref.node.frameId,
      );
      const parentAndUrlMatches = targetInfos.filter(
        (entry) =>
          valueAsText(entry.parentFrameId) === valueAsText(ref.node.parentFrameId) &&
          valueAsText(entry.url) === valueAsText(ref.node.frameUrl),
      );
      const resolvedTarget =
        exactMatch ||
        (parentAndUrlMatches.length === 1 ? parentAndUrlMatches[0] : undefined);
      const resolvedTargetId = valueAsText(resolvedTarget?.targetId);
      targetId = resolvedTargetId || null;
    } catch {}
    state.frameTargetIdByFrameId.set(ref.node.frameId, targetId);
  }
  try {
    const attached = await client.send('Target.attachToTarget', {
      targetId: targetId || ref.node.frameId,
      flatten: true,
    });
    const sessionId = valueAsText(attached.sessionId);
    if (sessionId) {
      state.frameSessionByFrameId.set(ref.node.frameId, sessionId);
      return sessionId;
    }
  } catch {}
  return state.rootSessionId;
}

async function scrollNodeIntoView(
  client: CdpClient,
  state: ActionSessionState,
  ref: ResolvedSnapshotRef,
): Promise<void> {
  const sessionId = await resolveActionSessionId(client, state, ref);
  await client
    .send('DOM.scrollIntoViewIfNeeded', { backendNodeId: ref.backendNodeId }, { sessionId })
    .catch(async () => {
      const objectId = await resolveNodeObjectId(client, sessionId, ref.backendNodeId, {
        rootSessionId: state.rootSessionId,
        frameId: ref.node.frameId,
        topFrame: ref.node.topFrame,
        executionContextByFrameId: state.executionContextByFrameId,
      });
      await client.send(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration:
            'function(){ this.scrollIntoView({block:"center",inline:"center"}); }',
        },
        { sessionId },
      );
    });
}

async function focusResolvedNode(
  client: CdpClient,
  state: ActionSessionState,
  ref: ResolvedSnapshotRef,
): Promise<{ objectId: string; sessionId: string }> {
  const sessionId = await resolveActionSessionId(client, state, ref);
  await client
    .send('DOM.focus', { backendNodeId: ref.backendNodeId }, { sessionId })
    .catch(() => undefined);
  return {
    sessionId,
    objectId: await resolveNodeObjectId(client, sessionId, ref.backendNodeId, {
      rootSessionId: state.rootSessionId,
      frameId: ref.node.frameId,
      topFrame: ref.node.topFrame,
      executionContextByFrameId: state.executionContextByFrameId,
    }),
  };
}

async function clickNodeViaJs(
  client: CdpClient,
  state: ActionSessionState,
  ref: ResolvedSnapshotRef,
  clickCount = 1,
): Promise<void> {
  const { objectId, sessionId } = await focusResolvedNode(client, state, ref);
  await client.send(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration:
        `function(count){
          this.scrollIntoView({block:"center",inline:"center"});
          this.focus?.();
          for(let i=0;i<count;i++){this.click?.();}
          if(count>=2){this.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true}));}
        }`,
      arguments: [{ value: clickCount }],
    },
    { sessionId },
  );
}

async function getNodeCenter(
  client: CdpClient,
  sessionId: string,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  const response = await client.send(
    'DOM.getBoxModel',
    { backendNodeId },
    { sessionId },
  );
  const model = response.model as { content?: number[] } | undefined;
  const content = Array.isArray(model?.content) ? model.content : [];
  if (content.length < 8) {
    throw new BrowserError(502, `Failed to read bounds for node ${backendNodeId}`);
  }
  const xs = [content[0], content[2], content[4], content[6]];
  const ys = [content[1], content[3], content[5], content[7]];
  return {
    x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
    y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
  };
}

async function hoverNodeViaJs(
  client: CdpClient,
  state: ActionSessionState,
  ref: ResolvedSnapshotRef,
): Promise<void> {
  const sessionId = await resolveActionSessionId(client, state, ref);
  const objectId = await resolveNodeObjectId(client, sessionId, ref.backendNodeId, {
    rootSessionId: state.rootSessionId,
    frameId: ref.node.frameId,
    topFrame: ref.node.topFrame,
    executionContextByFrameId: state.executionContextByFrameId,
  });
  await client.send(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `
        function() {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = this.getBoundingClientRect();
          const init = {
            bubbles: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          };
          this.dispatchEvent(new MouseEvent('pointerover', init));
          this.dispatchEvent(new MouseEvent('mouseover', init));
          this.dispatchEvent(new MouseEvent('mouseenter', init));
        }
      `,
    },
    { sessionId },
  );
}

function shiftPrintableKey(key: string): string {
  if (key.length !== 1) {
    return key;
  }
  if (/^[a-z]$/.test(key)) {
    return key.toUpperCase();
  }
  return key;
}

function keyDefinition(key: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
} {
  const normalized = key.trim();
  const mapped: Record<
    string,
    { key: string; code: string; windowsVirtualKeyCode: number }
  > = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: {
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: {
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
    },
    ArrowLeft: {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      windowsVirtualKeyCode: 37,
    },
    ArrowRight: {
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
    },
    Delete: {
      key: 'Delete',
      code: 'Delete',
      windowsVirtualKeyCode: 46,
    },
    Space: {
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
    },
    Home: {
      key: 'Home',
      code: 'Home',
      windowsVirtualKeyCode: 36,
    },
    End: {
      key: 'End',
      code: 'End',
      windowsVirtualKeyCode: 35,
    },
  };
  if (mapped[normalized]) {
    return mapped[normalized];
  }
  if (/^[a-z]$/i.test(normalized)) {
    const upper = normalized.toUpperCase();
    return {
      key: normalized,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }
  if (/^\d$/.test(normalized)) {
    return {
      key: normalized,
      code: `Digit${normalized}`,
      windowsVirtualKeyCode: normalized.charCodeAt(0),
    };
  }
  throw new BrowserError(400, `Unsupported browser key: ${key}`);
}

export function resolveKeyPressDefinition(key: string): BrowserKeyDefinition {
  const tokens = key
    .split('+')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new BrowserError(400, 'key is required');
  }

  const modifierTokens = tokens
    .slice(0, -1)
    .map((entry) => KEY_ALIASES[entry] || entry);
  const mainToken = tokens[tokens.length - 1] || '';
  let modifiers = 0;
  for (const token of modifierTokens) {
    if (!(token in MODIFIER_BITS)) {
      throw new BrowserError(400, `Unsupported browser key modifier: ${token}`);
    }
    modifiers |= MODIFIER_BITS[token as keyof typeof MODIFIER_BITS];
  }

  const base = keyDefinition(mainToken);
  const shifted = (modifiers & MODIFIER_BITS.Shift) !== 0;
  const printableKey =
    base.key.length === 1 ? (shifted ? shiftPrintableKey(base.key) : base.key) : undefined;
  const shouldEmitText =
    Boolean(printableKey) &&
    (modifiers &
      (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt)) ===
      0;

  return {
    modifiers,
    key: printableKey || base.key,
    code: base.code,
    windowsVirtualKeyCode: base.windowsVirtualKeyCode,
    ...(shouldEmitText
      ? {
          text: printableKey,
          unmodifiedText: base.key,
        }
      : {}),
  };
}

async function clickNode(
  client: CdpClient,
  state: ActionSessionState,
  ref: ResolvedSnapshotRef,
  clickCount = 1,
): Promise<void> {
  if (ref.node.topFrame === false) {
    await clickNodeViaJs(client, state, ref, clickCount);
    return;
  }
  const sessionId = state.rootSessionId;
  await client.send('DOM.enable', undefined, { sessionId });
  try {
    await scrollNodeIntoView(client, state, ref);
    const point = await getNodeCenter(client, sessionId, ref.backendNodeId);
    await client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: point.x, y: point.y, button: 'left' },
      { sessionId },
    );
    for (let i = 1; i <= clickCount; i++) {
      await client.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: i,
        },
        { sessionId },
      );
      await client.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: i,
        },
        { sessionId },
      );
    }
  } catch {
    await clickNodeViaJs(client, state, ref, clickCount);
  }
}

async function hoverNode(
  client: CdpClient,
  state: ActionSessionState,
  ref: ResolvedSnapshotRef,
): Promise<void> {
  if (ref.node.topFrame === false) {
    await hoverNodeViaJs(client, state, ref);
    return;
  }
  const sessionId = state.rootSessionId;
  await client.send('DOM.enable', undefined, { sessionId });
  try {
    await scrollNodeIntoView(client, state, ref);
    const point = await getNodeCenter(client, sessionId, ref.backendNodeId);
    await client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' },
      { sessionId },
    );
  } catch {
    await hoverNodeViaJs(client, state, ref);
  }
}

async function typeIntoNode(
  client: CdpClient,
  state: ActionSessionState,
  ref: ResolvedSnapshotRef,
  text: string,
): Promise<void> {
  const sessionId = await resolveActionSessionId(client, state, ref);
  await client.send('DOM.enable', undefined, { sessionId });
  await scrollNodeIntoView(client, state, ref);
  const focused = await focusResolvedNode(client, state, ref);
  const objectId = focused.objectId;
  await client.send(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `
        function() {
          this.focus();
          if (typeof this.value === 'string') {
            if (typeof this.select === 'function') {
              this.select();
            } else if (typeof this.setSelectionRange === 'function') {
              this.setSelectionRange(0, this.value.length);
            }
          } else if (this.isContentEditable) {
            const selection = window.getSelection();
            if (!selection) {
              return;
            }
            const range = document.createRange();
            range.selectNodeContents(this);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }
      `,
    },
    { sessionId },
  );

  if (text.length === 0) {
    await pressTargetKey(client, sessionId, 'Backspace');
  } else {
    await client.send('Input.insertText', { text }, { sessionId });
  }

  await client.send(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration:
        'function(){ this.dispatchEvent(new Event("change", { bubbles: true })); }',
    },
    { sessionId },
  );
}

async function pressTargetKey(
  client: CdpClient,
  sessionId: string,
  key: string,
): Promise<void> {
  const definition = resolveKeyPressDefinition(key);
  await client.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      modifiers: definition.modifiers,
      ...(definition.text
        ? {
            text: definition.text,
            unmodifiedText: definition.unmodifiedText || definition.text,
          }
        : {}),
    },
    { sessionId },
  );
  if (definition.text) {
    await client.send(
      'Input.dispatchKeyEvent',
      {
        type: 'char',
        text: definition.text,
        key: definition.key,
        unmodifiedText: definition.unmodifiedText || definition.text,
        windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
        modifiers: definition.modifiers,
      },
      { sessionId },
    );
  }
  await client.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      modifiers: definition.modifiers,
    },
    { sessionId },
  );
}
export async function runBrowserAction(input: {
  cdpUrl: string;
  targetId: string;
  action: BrowserAction;
  resolvedRefs?: Record<string, ResolvedSnapshotRef>;
  defaultTimeoutMs: number;
}): Promise<{ targetId: string; title: string; url: string; waitedMs?: number; evaluateResult?: string }> {
  return await withTargetSession(
    input.cdpUrl,
    input.targetId,
    async (client, sessionId, tab) => {
      const state: ActionSessionState = {
        rootSessionId: sessionId,
        frameSessionByFrameId: new Map<string, string>(),
        frameTargetIdByFrameId: new Map<string, string | null>(),
        executionContextByFrameId: new Map<string, number>(),
      };
      const resolveRef = (ref: string): ResolvedSnapshotRef => {
        const resolved = input.resolvedRefs?.[ref];
        if (!resolved) {
          throw new BrowserError(
            409,
            `Unknown ref ${ref}. Take a fresh browser snapshot first.`,
          );
        }
        return resolved;
      };
      const resolveActionTarget = async (
        action:
          | Extract<BrowserAction, { kind: 'click' | 'hover' | 'scrollIntoView' }>
          | Extract<BrowserAction, { kind: 'type' }>
          | Extract<BrowserAction, { kind: 'select' }>
          | Extract<BrowserAction, { kind: 'scroll' }>,
      ): Promise<ResolvedSnapshotRef> => {
        if (action.ref) {
          return resolveRef(action.ref);
        }
        if (action.selector) {
          return await resolveSelectorTarget(client, sessionId, action.selector);
        }
        throw new BrowserError(400, 'ref or selector is required');
      };

      const actionErrorContext = (action: BrowserAction): { ref?: string; selector?: string; action?: string } => {
        const ctx: { ref?: string; selector?: string; action?: string } = { action: action.kind };
        if ('ref' in action && typeof action.ref === 'string') ctx.ref = action.ref;
        if ('selector' in action && typeof action.selector === 'string') ctx.selector = action.selector;
        return ctx;
      };

      try {
      switch (input.action.kind) {
        case 'navigate': {
          const timeoutMs = input.action.timeoutMs || input.defaultTimeoutMs;
          await client.send('Page.enable', undefined, { sessionId });
          const navigation = await client.send(
            'Page.navigate',
            { url: input.action.url },
            { sessionId, timeoutMs },
          );
          const errorText = valueAsText(navigation.errorText);
          if (errorText) {
            throw new BrowserError(502, `Navigation failed: ${errorText}`);
          }
          if (navigation.isDownload === true) {
            throw new BrowserError(409, 'Navigation triggered a download');
          }
          if (valueAsText(navigation.loaderId)) {
            await client.waitForEvent(
              'Page.loadEventFired',
              timeoutMs,
              sessionId,
            );
          }
          // Validate final URL after navigation (redirect chain protection)
          const postNavState = await readTargetPageState(client, sessionId).catch(() => null);
          if (postNavState?.url) {
            try {
              const finalUrl = new URL(postNavState.url);
              if (finalUrl.protocol !== 'about:') {
                // DNS-level check: catches public hostnames resolving to private IPs
                const isPrivate = await isPrivateHostnameResolved(finalUrl.hostname);
                if (isPrivate) {
                  await client.send('Page.navigate', { url: 'about:blank' }, { sessionId }).catch(() => {});
                  throw new BrowserError(403, `Navigation redirected to a private network address: ${postNavState.url}`);
                }
              }
            } catch (err) {
              if (err instanceof BrowserError) throw err;
              // URL parsing failed, ignore
            }
          }
          break;
        }
        case 'click':
          await clickNode(
            client,
            state,
            await resolveActionTarget(input.action),
            input.action.clickCount ?? 1,
          );
          break;
        case 'hover':
          await hoverNode(
            client,
            state,
            await resolveActionTarget(input.action),
          );
          break;
        case 'scrollIntoView':
          await scrollNodeIntoView(client, state, await resolveActionTarget(input.action));
          break;
        case 'type':
          await typeIntoNode(
            client,
            state,
            await resolveActionTarget(input.action),
            input.action.text,
          );
          break;
        case 'press':
          await pressTargetKey(client, sessionId, input.action.key);
          break;
        case 'wait': {
          const timeMs = Math.max(0, Math.min(30000, input.action.timeMs || 0));
          if (timeMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, timeMs));
          }
          return {
            targetId: input.targetId,
            title: tab.title,
            url: tab.url,
            waitedMs: timeMs,
          };
        }
        case 'waitFor': {
          const waitedMs = await waitForBrowserConditions(
            client,
            sessionId,
            input.action,
            input.defaultTimeoutMs,
          );
          const pageState = await readTargetPageState(client, sessionId).catch(() => ({
            title: tab.title,
            url: tab.url,
          }));
          return {
            targetId: input.targetId,
            title: pageState.title || tab.title,
            url: pageState.url || tab.url,
            waitedMs,
          };
        }
        case 'close':
          await client.send('Target.closeTarget', { targetId: input.targetId });
          return {
            targetId: input.targetId,
            title: tab.title,
            url: tab.url,
          };
        case 'back': {
          const backTimeout = input.action.timeoutMs || input.defaultTimeoutMs;
          await client.send('Page.enable', undefined, { sessionId });
          const backHistory = await client.send(
            'Page.getNavigationHistory',
            undefined,
            { sessionId },
          );
          const backCurrentIndex = typeof backHistory.currentIndex === 'number' ? backHistory.currentIndex : -1;
          if (backCurrentIndex <= 0) {
            throw new BrowserError(409, 'Cannot go back: no previous history entry');
          }
          const entries = Array.isArray(backHistory.entries) ? backHistory.entries as { id: number }[] : [];
          const prevEntry = entries[backCurrentIndex - 1];
          if (!prevEntry) {
            throw new BrowserError(409, 'Cannot go back: no previous history entry');
          }
          await client.send(
            'Page.navigateToHistoryEntry',
            { entryId: prevEntry.id },
            { sessionId, timeoutMs: backTimeout },
          );
          await client.waitForEvent('Page.loadEventFired', backTimeout, sessionId).catch(() => {});
          break;
        }
        case 'forward': {
          const fwdTimeout = input.action.timeoutMs || input.defaultTimeoutMs;
          await client.send('Page.enable', undefined, { sessionId });
          const fwdHistory = await client.send(
            'Page.getNavigationHistory',
            undefined,
            { sessionId },
          );
          const fwdCurrentIndex = typeof fwdHistory.currentIndex === 'number' ? fwdHistory.currentIndex : -1;
          const fwdEntries = Array.isArray(fwdHistory.entries) ? fwdHistory.entries as { id: number }[] : [];
          if (fwdCurrentIndex < 0 || fwdCurrentIndex >= fwdEntries.length - 1) {
            throw new BrowserError(409, 'Cannot go forward: no forward history entry');
          }
          const nextEntry = fwdEntries[fwdCurrentIndex + 1];
          if (!nextEntry) {
            throw new BrowserError(409, 'Cannot go forward: no forward history entry');
          }
          await client.send(
            'Page.navigateToHistoryEntry',
            { entryId: nextEntry.id },
            { sessionId, timeoutMs: fwdTimeout },
          );
          await client.waitForEvent('Page.loadEventFired', fwdTimeout, sessionId).catch(() => {});
          break;
        }
        case 'reload': {
          const reloadTimeout = input.action.timeoutMs || input.defaultTimeoutMs;
          await client.send('Page.enable', undefined, { sessionId });
          await client.send('Page.reload', undefined, { sessionId });
          await client.waitForEvent('Page.loadEventFired', reloadTimeout, sessionId);
          break;
        }
        case 'select': {
          const selectRef = await resolveActionTarget(input.action);
          const selectSessionId = await resolveActionSessionId(client, state, selectRef);
          const selectObjectId = await resolveNodeObjectId(client, selectSessionId, selectRef.backendNodeId, {
            rootSessionId: state.rootSessionId,
            frameId: selectRef.node.frameId,
            topFrame: selectRef.node.topFrame,
            executionContextByFrameId: state.executionContextByFrameId,
          });
          await client.send(
            'Runtime.callFunctionOn',
            {
              objectId: selectObjectId,
              functionDeclaration: `function(value) {
                if (this.tagName.toUpperCase() !== 'SELECT') throw new Error('Element is not a select');
                this.value = value;
                this.dispatchEvent(new Event('input', { bubbles: true }));
                this.dispatchEvent(new Event('change', { bubbles: true }));
              }`,
              arguments: [{ value: input.action.value }],
            },
            { sessionId: selectSessionId },
          );
          break;
        }
        case 'scroll': {
          const scrollX = input.action.x ?? 0;
          const scrollY = input.action.y ?? 0;
          if (input.action.ref || input.action.selector) {
            const scrollRef = await resolveActionTarget(input.action);
            const scrollSessionId = await resolveActionSessionId(client, state, scrollRef);
            const scrollObjectId = await resolveNodeObjectId(client, scrollSessionId, scrollRef.backendNodeId, {
              rootSessionId: state.rootSessionId,
              frameId: scrollRef.node.frameId,
              topFrame: scrollRef.node.topFrame,
              executionContextByFrameId: state.executionContextByFrameId,
            });
            await client.send(
              'Runtime.callFunctionOn',
              {
                objectId: scrollObjectId,
                functionDeclaration: `function(x, y) { this.scrollBy(x, y); }`,
                arguments: [{ value: scrollX }, { value: scrollY }],
              },
              { sessionId: scrollSessionId },
            );
          } else {
            const safeX = Number.isFinite(scrollX) ? scrollX : 0;
            const safeY = Number.isFinite(scrollY) ? scrollY : 0;
            await client.send(
              'Runtime.evaluate',
              {
                expression: `window.scrollBy(${safeX}, ${safeY})`,
                returnByValue: true,
              },
              { sessionId },
            );
          }
          break;
        }
        case 'evaluate': {
          const expression = input.action.expression;
          if (expression.length > 10000) {
            throw new BrowserError(400, 'Expression too long (max 10000 chars)');
          }
          const evalResult = await client.send(
            'Runtime.evaluate',
            {
              expression,
              returnByValue: true,
              timeout: input.defaultTimeoutMs,
            },
            { sessionId, timeoutMs: input.defaultTimeoutMs + 2000 },
          );
          const exceptionDetails = evalResult.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
          if (exceptionDetails) {
            const errorMessage = valueAsText(exceptionDetails.exception?.description) ||
              valueAsText(exceptionDetails.text) ||
              'Evaluation failed';
            throw new BrowserError(502, `Evaluate error: ${errorMessage}`);
          }
          const evalValue = (evalResult.result as { value?: unknown } | undefined)?.value;
          const evaluateResult = evalValue !== undefined ? JSON.stringify(evalValue) : 'undefined';
          const evalPage = await readTargetPageState(client, sessionId).catch(() => ({
            title: tab.title,
            url: tab.url,
          }));
          return {
            targetId: input.targetId,
            title: evalPage.title || tab.title,
            url: evalPage.url || tab.url,
            evaluateResult,
          };
        }
        default: {
          const neverAction: never = input.action;
          throw new BrowserError(
            400,
            `Unsupported browser action ${(neverAction as { kind?: string }).kind || 'unknown'}`,
          );
        }
      }
      } catch (err) {
        throw toAIFriendlyError(err, actionErrorContext(input.action));
      }

      const refreshedTab =
        (await listBrowserTabs(input.cdpUrl)).find(
          (entry) => entry.targetId === input.targetId,
        ) || tab;
      const page = await readTargetPageState(client, sessionId).catch(() => ({
        title: refreshedTab.title,
        url: refreshedTab.url,
      }));
      return {
        targetId: input.targetId,
        title: page.title || refreshedTab.title,
        url: page.url || refreshedTab.url,
      };
    },
  );
}
