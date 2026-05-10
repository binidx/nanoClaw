import type {
  ExtensionCatalogEntry,
  ExtensionMarketplaceSource,
} from './extension-marketplace-types.js';
import { getExtensionMarketplaceSourcesForResponse } from './extension-marketplace-config.js';
import {
  describeCatalogEntrySource,
  loadMarketplace,
} from './extension-marketplace-source-resolve.js';
import { t } from '../i18n/index.js';

export * from './extension-marketplace-types.js';
export * from './extension-marketplace-config.js';
export * from './extension-marketplace-archive.js';
export * from './extension-marketplace-bundle.js';
export * from './extension-marketplace-source-resolve.js';
export * from './extension-marketplace-install.js';

export async function getExtensionMarketplaceCatalog(input?: {
  sourceId?: string;
  source?: string;
}): Promise<{ sources: ExtensionMarketplaceSource[]; entries: ExtensionCatalogEntry[] }> {
  const configuredSources = await getExtensionMarketplaceSourcesForResponse();
  const resolvedSources =
    input?.sourceId && input.sourceId.trim()
      ? configuredSources.filter((entry) => entry.id === input.sourceId?.trim())
      : input?.source && input.source.trim()
        ? [
            {
              id: 'adhoc',
              name: t('extension.temporarySource', {}, undefined),
              source: input.source.trim(),
              enabled: true,
            } satisfies ExtensionMarketplaceSource,
          ]
        : configuredSources.filter((entry) => entry.enabled);

  const entries: ExtensionCatalogEntry[] = [];
  for (const source of resolvedSources) {
    const loaded = await loadMarketplace({ source: source.source });
    if (!loaded.ok) {
      entries.push({
        id: `${source.id}:__error__`,
        entryName: '__error__',
        title: source.name,
        description: loaded.error,
        sourceId: source.id,
        sourceName: source.name,
        sourceLabel: source.source,
        skillCount: 0,
        mcpCount: 0,
        agentCount: 0,
        installable: false,
      });
      continue;
    }
    try {
      for (const entry of loaded.marketplace.manifest.plugins) {
        entries.push(
          await describeCatalogEntrySource(
            source.id,
            source.name,
            loaded.marketplace.sourceLabel,
            loaded.marketplace.rootDir,
            loaded.marketplace.manifest,
            entry,
          ),
        );
      }
    } finally {
      await loaded.marketplace.cleanup?.();
    }
  }

  return {
    sources: configuredSources,
    entries: entries.sort((a, b) => {
      if (a.sourceId !== b.sourceId) return a.sourceId.localeCompare(b.sourceId);
      return a.entryName.localeCompare(b.entryName);
    }),
  };
}
