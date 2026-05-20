import {
  type MarketplaceSourceRecord,
  generateMarketplaceSourceId,
  upsertMarketplaceSource,
  getMarketplaceSource,
  listMarketplaceSources,
  deleteMarketplaceSource,
} from '../db.js';
import { logger } from '../logger.js';

export interface MarketplaceSourceInput {
  id?: string;
  name: string;
  source: string;
  enabled?: boolean;
  description?: string;
  iconUrl?: string;
  sortOrder?: number;
}

export interface MarketplaceSourceView {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  description: string | null;
  iconUrl: string | null;
  sortOrder: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function normalizeMarketplaceSourceId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!normalized) {
    throw new Error('Marketplace source id is invalid');
  }
  return normalized;
}

function normalizeMarketplaceSourceInput(
  input: MarketplaceSourceInput,
  fallbackId?: string,
): MarketplaceSourceInput & { id: string } {
  const id = normalizeMarketplaceSourceId(
    input.id || fallbackId || input.name || '',
  );
  const name = input.name.trim() || id;
  const source = input.source.trim();
  if (!source) {
    throw new Error('marketplace source is required');
  }
  return {
    id,
    name,
    source,
    enabled: input.enabled !== false,
    description: input.description?.trim() || undefined,
    iconUrl: input.iconUrl?.trim() || undefined,
    sortOrder:
      typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder)
        ? Math.trunc(input.sortOrder)
        : undefined,
  };
}

function recordToView(record: MarketplaceSourceRecord): MarketplaceSourceView {
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    enabled: record.enabled === 1,
    description: record.description,
    iconUrl: record.icon_url,
    sortOrder: record.sort_order,
    createdBy: record.created_by,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export async function createMarketplaceSource(
  adminUserId: string,
  input: MarketplaceSourceInput,
): Promise<MarketplaceSourceView> {
  const now = new Date().toISOString();
  const normalized = normalizeMarketplaceSourceInput(
    input,
    input.id || generateMarketplaceSourceId(),
  );
  const record: MarketplaceSourceRecord = {
    id: normalized.id,
    name: normalized.name,
    source: normalized.source,
    enabled: normalized.enabled !== false ? 1 : 0,
    description: normalized.description ?? null,
    icon_url: normalized.iconUrl ?? null,
    sort_order: normalized.sortOrder ?? 0,
    created_by: adminUserId,
    created_at: now,
    updated_at: now,
  };
  await upsertMarketplaceSource(record);
  return recordToView(record);
}

export async function updateMarketplaceSource(
  sourceId: string,
  input: Partial<MarketplaceSourceInput>,
): Promise<MarketplaceSourceView | null> {
  const existing = await getMarketplaceSource(sourceId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updated: MarketplaceSourceRecord = {
    ...existing,
    name: input.name ?? existing.name,
    source: input.source ?? existing.source,
    enabled:
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    description:
      input.description !== undefined
        ? (input.description ?? null)
        : existing.description,
    icon_url:
      input.iconUrl !== undefined ? (input.iconUrl ?? null) : existing.icon_url,
    sort_order: input.sortOrder ?? existing.sort_order,
    updated_at: now,
  };
  await upsertMarketplaceSource(updated);
  return recordToView(updated);
}

export async function replaceAdminMarketplaceSources(
  adminUserId: string,
  input: MarketplaceSourceInput[],
): Promise<MarketplaceSourceView[]> {
  const existing = await listMarketplaceSources(false);
  const existingById = new Map(existing.map((record) => [record.id, record]));
  const normalized = input.map((entry, index) =>
    normalizeMarketplaceSourceInput(
      entry,
      entry.id || `marketplace-${index + 1}`,
    ),
  );
  const seen = new Set<string>();
  const now = new Date().toISOString();

  for (const entry of normalized) {
    if (seen.has(entry.id)) {
      throw new Error(`Duplicate marketplace source id: ${entry.id}`);
    }
    seen.add(entry.id);
    const previous = existingById.get(entry.id);
    const record: MarketplaceSourceRecord = {
      id: entry.id,
      name: entry.name,
      source: entry.source,
      enabled: entry.enabled !== false ? 1 : 0,
      description: entry.description ?? previous?.description ?? null,
      icon_url: entry.iconUrl ?? previous?.icon_url ?? null,
      sort_order: entry.sortOrder ?? previous?.sort_order ?? 0,
      created_by: previous?.created_by ?? adminUserId,
      created_at: previous?.created_at ?? now,
      updated_at: now,
    };
    await upsertMarketplaceSource(record);
  }

  for (const record of existing) {
    if (!seen.has(record.id)) {
      await deleteMarketplaceSource(record.id);
    }
  }

  return listAllMarketplaceSources();
}

export async function removeMarketplaceSource(
  sourceId: string,
): Promise<boolean> {
  const existing = await getMarketplaceSource(sourceId);
  if (!existing) return false;
  await deleteMarketplaceSource(sourceId);
  return true;
}

export async function listAllMarketplaceSources(
  enabledOnly = false,
): Promise<MarketplaceSourceView[]> {
  const records = await listMarketplaceSources(enabledOnly);
  return records.map(recordToView);
}

export async function getMarketplaceSourceView(
  sourceId: string,
): Promise<MarketplaceSourceView | null> {
  const record = await getMarketplaceSource(sourceId);
  return record ? recordToView(record) : null;
}
