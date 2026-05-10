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
  const record: MarketplaceSourceRecord = {
    id: generateMarketplaceSourceId(),
    name: input.name,
    source: input.source,
    enabled: input.enabled !== false ? 1 : 0,
    description: input.description ?? null,
    icon_url: input.iconUrl ?? null,
    sort_order: input.sortOrder ?? 0,
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
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    description: input.description !== undefined ? (input.description ?? null) : existing.description,
    icon_url: input.iconUrl !== undefined ? (input.iconUrl ?? null) : existing.icon_url,
    sort_order: input.sortOrder ?? existing.sort_order,
    updated_at: now,
  };
  await upsertMarketplaceSource(updated);
  return recordToView(updated);
}

export async function removeMarketplaceSource(sourceId: string): Promise<boolean> {
  const existing = await getMarketplaceSource(sourceId);
  if (!existing) return false;
  await deleteMarketplaceSource(sourceId);
  return true;
}

export async function listAllMarketplaceSources(enabledOnly = false): Promise<MarketplaceSourceView[]> {
  const records = await listMarketplaceSources(enabledOnly);
  return records.map(recordToView);
}

export async function getMarketplaceSourceView(sourceId: string): Promise<MarketplaceSourceView | null> {
  const record = await getMarketplaceSource(sourceId);
  return record ? recordToView(record) : null;
}
