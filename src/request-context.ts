import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  source: 'http' | 'internal' | 'background';
  method?: string;
  path?: string;
  startedAt?: number;
}

const requestContextStore = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

export function getRequestId(): string | undefined {
  return requestContextStore.getStore()?.requestId;
}

export function getRequestLogFields(): { requestId?: string } {
  const requestId = getRequestId();
  return requestId ? { requestId } : {};
}

export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T,
): T {
  return requestContextStore.run(ctx, fn);
}

export function runWithRequestContextAsync<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStore.run(ctx, fn);
}
