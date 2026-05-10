import {
  type UserMcpServerRecord,
  type UserSkillRecord,
  listUserMcpServers,
  listUserSkills,
} from '../db.js';
import { parseExtensionMetadata } from './extension-metadata.js';
import { listAllMarketplaceSources, type MarketplaceSourceView } from './marketplace-source-service.js';
import { t } from '../i18n/index.js';

export type PublicLibraryItemType = 'mcp' | 'skill';
export type PublicLibraryItemSource = 'user-shared' | 'marketplace';

export interface PublicLibraryItem {
  id: string;
  type: PublicLibraryItemType;
  name: string;
  description: string | null;
  source: PublicLibraryItemSource;
  sourceLabel: string;
  ownerUserId: string | null;
  iconUrl: string | null;
  tags: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function mcpToLibraryItem(record: UserMcpServerRecord): PublicLibraryItem {
  const metadata = parseExtensionMetadata(record.metadata_json);
  return {
    id: record.id,
    type: 'mcp',
    name: record.name,
    description: record.description,
    source: 'user-shared',
    sourceLabel: t('errors.auto_2d4ca8', {}, undefined),
    ownerUserId: record.user_id,
    iconUrl: record.icon_url,
    tags: Array.from(
      new Set([
        ...safeParse<string[]>(record.tags_json, []),
        ...metadata.capabilities,
      ]),
    ),
    enabled: record.enabled === 1,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function skillToLibraryItem(record: UserSkillRecord): PublicLibraryItem {
  const metadata = parseExtensionMetadata(record.metadata_json);
  return {
    id: record.id,
    type: 'skill',
    name: record.name,
    description: record.description,
    source: 'user-shared',
    sourceLabel: t('errors.auto_2d4ca8', {}, undefined),
    ownerUserId: record.user_id,
    iconUrl: record.icon_url,
    tags: Array.from(
      new Set([
        ...safeParse<string[]>(record.tags_json, []),
        ...metadata.capabilities,
      ]),
    ),
    enabled: record.enabled === 1,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export interface PublicLibraryQuery {
  type?: PublicLibraryItemType;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PublicLibraryResult {
  items: PublicLibraryItem[];
  total: number;
  marketplaceSources: MarketplaceSourceView[];
}

export async function queryPublicLibrary(query: PublicLibraryQuery): Promise<PublicLibraryResult> {
  const items: PublicLibraryItem[] = [];

  if (!query.type || query.type === 'mcp') {
    const mcpRecords = await listUserMcpServers({ visibility: 'shared' });
    items.push(...mcpRecords.map(mcpToLibraryItem));
  }

  if (!query.type || query.type === 'skill') {
    const skillRecords = await listUserSkills({ visibility: 'shared' });
    items.push(...skillRecords.map(skillToLibraryItem));
  }

  let filtered = items;
  if (query.search) {
    const term = query.search.toLowerCase();
    filtered = items.filter(
      (item) =>
        item.name.toLowerCase().includes(term) ||
        (item.description ?? '').toLowerCase().includes(term) ||
        item.tags.some((t) => t.toLowerCase().includes(term)),
    );
  }

  filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const total = filtered.length;
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  const paged = filtered.slice(offset, offset + limit);

  const marketplaceSources = await listAllMarketplaceSources(true);

  return { items: paged, total, marketplaceSources };
}
