import { AsyncLocalStorage } from 'node:async_hooks';

export const SYSTEM_USER_ID = '__system__';

export interface TenantContext {
  userId: string;
}

const tenantStore = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return tenantStore.getStore();
}

export function getCurrentUserId(): string {
  return tenantStore.getStore()?.userId ?? SYSTEM_USER_ID;
}

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return tenantStore.run(ctx, fn);
}

export function runWithTenantAsync<T>(
  ctx: TenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  return tenantStore.run(ctx, fn);
}
