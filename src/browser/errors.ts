import { BrowserError, type BrowserErrorContext } from './types.js';

/**
 * Converts raw CDP error messages into AI-friendly, actionable guidance
 * that helps the agent understand what went wrong and what to try next.
 *
 * Uses the same AI-friendly error shaping pattern applied elsewhere in NanoClaw.
 */
export function toAIFriendlyError(
  error: unknown,
  context: { ref?: string; selector?: string; action?: string },
): BrowserError {
  const message = error instanceof Error ? error.message : String(error);
  const label = context.ref || context.selector || 'element';
  const actionLabel = context.action ? ` during "${context.action}"` : '';
  const baseDetails: BrowserErrorContext = {
    ...(context.action ? { action: context.action } : {}),
    ...(context.ref ? { ref: context.ref } : {}),
    ...(context.selector ? { selector: context.selector } : {}),
  };
  const buildError = (
    status: number,
    nextMessage: string,
    suggestion?: string,
  ): BrowserError =>
    new BrowserError(status, nextMessage, {
      ...baseDetails,
      ...(suggestion ? { suggestion } : {}),
    });

  if (error instanceof BrowserError && error.details) {
    return error;
  }

  // Pattern: node not found / detached from DOM
  if (
    message.includes('Could not find node') ||
    message.includes('No node with given id') ||
    message.includes('Node with given id does not belong') ||
    message.includes('detached')
  ) {
    return buildError(
      409,
      `Element "${label}" not found or was removed from the page${actionLabel}. ` +
        `Take a fresh browser_role_snapshot to see current elements.`,
      'Take a fresh browser_role_snapshot to see current elements.',
    );
  }

  // Pattern: unknown ref (stale snapshot)
  if (message.includes('Unknown ref')) {
    return buildError(
      409,
      `Ref "${label}" is not recognized. Refs expire when the page changes. ` +
        `Take a fresh browser_role_snapshot to get valid refs.`,
      'Take a fresh browser_role_snapshot to get valid refs.',
    );
  }

  // Pattern: failed to get box model / bounding rect (hidden or zero-size element)
  if (
    message.includes('Failed to read bounds') ||
    message.includes('getBoxModel') ||
    message.includes('Could not compute bounding') ||
    message.includes('has no visible bounds')
  ) {
    return buildError(
      409,
      `Element "${label}" has no visible bounds (hidden or zero-size)${actionLabel}. ` +
        `Try scrollIntoView first, or use a different ref. ` +
        `Run a fresh snapshot if refs are stale.`,
      'Try scrollIntoView first, or use a different ref. Run a fresh snapshot if refs are stale.',
    );
  }

  // Pattern: execution context destroyed (page navigated mid-action)
  if (
    message.includes('Execution context was destroyed') ||
    message.includes('context was destroyed') ||
    message.includes('Cannot find context')
  ) {
    return buildError(
      409,
      `Page navigated during action on "${label}"${actionLabel}. ` +
        `The page content has changed — take a fresh snapshot.`,
      'The page content has changed. Take a fresh browser_role_snapshot.',
    );
  }

  // Pattern: element is not interactable (covered, hidden, disabled)
  if (
    message.includes('intercepts pointer events') ||
    message.includes('not receive pointer events') ||
    message.includes('Element is not clickable') ||
    message.includes('Node is not visible')
  ) {
    return buildError(
      409,
      `Element "${label}" is not interactable (hidden or covered by another element)${actionLabel}. ` +
        `Try scrolling it into view, closing overlays/dialogs, or use a different ref.`,
      'Try scrolling it into view, closing overlays or dialogs, or use a different ref.',
    );
  }

  // Pattern: DOM node resolution failure
  if (
    message.includes('resolve DOM node') ||
    message.includes('resolveNode') ||
    message.includes('Cannot resolve node')
  ) {
    return buildError(
      409,
      `Cannot interact with "${label}" — the DOM node reference is invalid${actionLabel}. ` +
        `This usually means the page content changed. Take a fresh snapshot.`,
      'This usually means the page content changed. Take a fresh browser_role_snapshot.',
    );
  }

  // Pattern: target closed / tab closed
  if (
    message.includes('Target closed') ||
    message.includes('Target has been closed') ||
    message.includes('Session closed') ||
    message.includes('browser has been closed')
  ) {
    return buildError(
      409,
      `The browser tab was closed${actionLabel}. ` +
        `Check browser_tabs to see available tabs, or open a new one.`,
      'Check browser_tabs to see available tabs, or open a new one.',
    );
  }

  // Pattern: timeout
  if (message.includes('Timed out') || message.includes('timed out') || message.includes('Timeout')) {
    return buildError(
      504,
      `Action on "${label}" timed out${actionLabel}. The page may be loading slowly. ` +
        `Try waiting (waitFor) and then retrying, or increase timeout.`,
      'Try waitFor and then retry, or increase timeout.',
    );
  }

  // Pattern: frame detached (common during SPA navigation)
  if (message.includes('frame has been detached') || message.includes('Frame was detached')) {
    return buildError(
      409,
      `The page frame was detached${actionLabel} (the page is navigating or an iframe was removed). ` +
        `Wait for the page to finish loading, then take a fresh snapshot.`,
      'Wait for the page to finish loading, then take a fresh browser_role_snapshot.',
    );
  }

  // Pattern: element is not the right type for the action
  if (message.includes('Element is not a select') || message.includes('not a <select>')) {
    return buildError(
      409,
      `Element "${label}" is not a <select> dropdown${actionLabel}. ` +
        `Check the element's role in the snapshot and use the correct action kind.`,
      'Check the element role in the snapshot and use the correct action kind.',
    );
  }

  // Pattern: WebSocket connection error
  if (
    message.includes('WebSocket') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ECONNRESET')
  ) {
    return buildError(
      502,
      `Browser connection error${actionLabel}: ${message}. ` +
        `Check browser_status — the browser may need to be restarted.`,
      'Check browser_status. The browser may need to be restarted.',
    );
  }

  if (error instanceof BrowserError) {
    return new BrowserError(error.status, error.message, baseDetails);
  }
  return new BrowserError(502, message, baseDetails);
}
