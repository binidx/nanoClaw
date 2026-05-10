import fs from 'fs';
import os from 'os';
import path from 'path';

import { deleteConfig, getConfig, setConfig } from '../db.js';
import { saveDirectoryToFileStore, removeFileStoreByPrefix } from '../web/file-store-service.js';
import { logger } from '../logger.js';
import type { ManagedMcpServerConfig } from '../runtime/runtime-customization.js';
import {
  CUSTOM_SKILLS_ROOT,
  normalizeManagedMcpServers,
  serializeManagedMcpServersConfig,
  WEB_MCP_SERVERS_CONFIG_KEY,
} from '../runtime/runtime-customization.js';
import type {
  ExistingInstallBackup,
  ExtensionInstallRecord,
  ExtensionInstallResult,
  ExtensionReconcileResult,
  ExtensionUninstallResult,
  MarketplaceEntrySource,
  ResolvedBundleSource,
} from './extension-marketplace-types.js';
import { MANAGED_EXTENSIONS_ROOT } from './extension-marketplace-types.js';
import {
  deriveSourceKindFromRef,
  deriveTrustState,
  getExtensionInstallsForResponse,
  getExtensionMarketplaceSourcesForResponse,
  normalizeInstallId,
  persistExtensionInstalls,
} from './extension-marketplace-config.js';
import {
  absolutizeBundleMcpServer,
  chooseAvailableMcpId,
  chooseAvailableSkillId,
  computeBundleContentHash,
  deriveSuggestedNameFromPath,
  loadBundleScan,
  parseManagedMcpBundleFile,
  readBundleCanonicalId,
  resolveBundleRootFromPath,
} from './extension-marketplace-bundle.js';
import {
  downloadRemoteBundleFile,
  loadMarketplace,
  normalizeGitCloneSource,
  pathExists,
  resolveBundleSourceFromEntry,
  resolveLocalBundleSource,
} from './extension-marketplace-source-resolve.js';
import { t } from '../i18n/index.js';

function extensionSkillMissingMessage(skillId: string): string {
  return t('extension.skillMissing', { skillId }, undefined);
}

function extensionMcpMissingMessage(mcpId: string): string {
  return t('extension.mcpMissing', { mcpId }, undefined);
}

function extensionBundleMissingMessage(pathValue: string): string {
  return t('extension.bundleMissing', { path: pathValue }, undefined);
}

function extensionBundleValidationFailedMessage(reason: string): string {
  return t('extension.bundleValidationFailed', { reason }, undefined);
}

function isReconcileWarning(message: string): boolean {
  return (
    message.startsWith(t('extension.skillMissingPrefix', {}, undefined)) ||
    message.startsWith(t('extension.mcpMissingPrefix', {}, undefined)) ||
    message.startsWith(t('extension.bundleMissingPrefix', {}, undefined)) ||
    message === t('extension.hashChanged', {}, undefined) ||
    message.startsWith(
      t('extension.bundleValidationFailedPrefix', {}, undefined),
    )
  );
}

function mapMarketplaceEntrySourceKind(
  source: MarketplaceEntrySource,
): ExtensionInstallRecord['sourceKind'] {
  switch (source.kind) {
    case 'path':
      return 'local_path';
    case 'github':
      return 'github';
    case 'git':
      return 'git';
    case 'git-subdir':
      return 'git_subdir';
    case 'url':
      return normalizeGitCloneSource(source.url) ? 'github' : 'remote_file';
  }
}

function resolveRecordedSource(params: {
  sourceKind: ExtensionInstallRecord['sourceKind'];
  bundleRoot: string;
  sourceRef: string;
}): string {
  return params.sourceRef;
}

async function getManagedMcpServersForResponse(): Promise<ManagedMcpServerConfig[]> {
  try {
    const raw = await getConfig(WEB_MCP_SERVERS_CONFIG_KEY);
    return raw ? normalizeManagedMcpServers(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

async function removeExistingInstallArtifacts(existingInstall: ExtensionInstallRecord): Promise<void> {
  for (const skillId of existingInstall.installedSkillIds) {
    const targetDir = path.join(CUSTOM_SKILLS_ROOT, skillId);
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  }

  const existingServers = (await getManagedMcpServersForResponse()).filter(
    (server) => !existingInstall.installedMcpServerIds.includes(server.id),
  );
  if (existingServers.length === 0) {
    await deleteConfig(WEB_MCP_SERVERS_CONFIG_KEY);
  } else {
    await setConfig(
      WEB_MCP_SERVERS_CONFIG_KEY,
      serializeManagedMcpServersConfig(existingServers),
    );
  }

  const extensionDir = path.join(MANAGED_EXTENSIONS_ROOT, existingInstall.id);
  if (fs.existsSync(extensionDir)) {
    fs.rmSync(extensionDir, { recursive: true, force: true });
  }
}

async function backupExistingInstallArtifacts(
  existingInstall: ExtensionInstallRecord,
): Promise<ExistingInstallBackup> {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-extension-backup-'),
  );
  const skillsRoot = path.join(tempDir, 'skills');
  const extensionRoot = path.join(tempDir, 'extension');

  for (const skillId of existingInstall.installedSkillIds) {
    const sourceDir = path.join(CUSTOM_SKILLS_ROOT, skillId);
    if (!fs.existsSync(sourceDir)) continue;
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.cpSync(sourceDir, path.join(skillsRoot, skillId), {
      recursive: true,
      force: true,
    });
  }

  const existingExtensionDir = path.join(MANAGED_EXTENSIONS_ROOT, existingInstall.id);
  if (fs.existsSync(existingExtensionDir)) {
    fs.mkdirSync(extensionRoot, { recursive: true });
    fs.cpSync(existingExtensionDir, path.join(extensionRoot, existingInstall.id), {
      recursive: true,
      force: true,
    });
  }

  return {
    tempDir,
    rawMcpConfig: await getConfig(WEB_MCP_SERVERS_CONFIG_KEY),
  };
}

async function restoreExistingInstallArtifacts(
  existingInstall: ExtensionInstallRecord,
  backup: ExistingInstallBackup,
): Promise<void> {
  const skillsRoot = path.join(backup.tempDir, 'skills');
  for (const skillId of existingInstall.installedSkillIds) {
    const backupDir = path.join(skillsRoot, skillId);
    if (!fs.existsSync(backupDir)) continue;
    fs.mkdirSync(CUSTOM_SKILLS_ROOT, { recursive: true });
    fs.cpSync(backupDir, path.join(CUSTOM_SKILLS_ROOT, skillId), {
      recursive: true,
      force: true,
    });
  }

  const backupExtensionDir = path.join(
    backup.tempDir,
    'extension',
    existingInstall.id,
  );
  if (fs.existsSync(backupExtensionDir)) {
    fs.mkdirSync(MANAGED_EXTENSIONS_ROOT, { recursive: true });
    fs.cpSync(
      backupExtensionDir,
      path.join(MANAGED_EXTENSIONS_ROOT, existingInstall.id),
      {
        recursive: true,
        force: true,
      },
    );
  }

  if (typeof backup.rawMcpConfig === 'string' && backup.rawMcpConfig.trim()) {
    await setConfig(WEB_MCP_SERVERS_CONFIG_KEY, backup.rawMcpConfig);
  } else {
    await deleteConfig(WEB_MCP_SERVERS_CONFIG_KEY);
  }
}

function cleanupExistingInstallBackup(backup: ExistingInstallBackup | null): void {
  if (!backup) return;
  fs.rmSync(backup.tempDir, { recursive: true, force: true });
}

function copyBundleToManagedRoot(sourceDir: string, installId: string): string {
  fs.mkdirSync(MANAGED_EXTENSIONS_ROOT, { recursive: true });
  const targetDir = path.join(MANAGED_EXTENSIONS_ROOT, installId);
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
  return targetDir;
}

async function installBundleFromResolvedSource(params: {
  installId: string;
  installName: string;
  version?: string;
  sourceType: 'marketplace' | 'import';
  sourceKind: ExtensionInstallRecord['sourceKind'];
  sourceRef: string;
  resolvedSource: string;
  trustState: ExtensionInstallRecord['trustState'];
  marketplaceName?: string;
  marketplaceSource?: string;
  marketplaceEntry?: string;
  bundleRoot: string;
  overwrite?: boolean;
}): Promise<ExtensionInstallResult> {
  const installs = await getExtensionInstallsForResponse();
  const existingInstall =
    installs.find((entry) => entry.id === params.installId) || null;
  if (existingInstall && !params.overwrite) {
    throw new Error(
      t('extension.alreadyInstalled', { installId: params.installId }, undefined),
    );
  }
  let managedRoot: string | null = null;
  let backup: ExistingInstallBackup | null = null;
  const previousRawMcpConfig = await getConfig(WEB_MCP_SERVERS_CONFIG_KEY);
  let mcpConfigMutated = false;
  const installedSkillIds: string[] = [];

  try {
    if (existingInstall) {
      backup = await backupExistingInstallArtifacts(existingInstall);
      await removeExistingInstallArtifacts(existingInstall);
    }

    managedRoot = copyBundleToManagedRoot(params.bundleRoot, params.installId);
    const bundleScan = loadBundleScan(managedRoot);
    const canonicalId = readBundleCanonicalId(managedRoot, params.installId);
    const contentHash = computeBundleContentHash(managedRoot);
    if (
      bundleScan.skills.length === 0 &&
      bundleScan.commandSkills.length === 0 &&
      bundleScan.mcpFiles.length === 0 &&
      bundleScan.agentDirs.length === 0
    ) {
      throw new Error(
        t('extension.noInstallableContent', {}, undefined),
      );
    }

    fs.mkdirSync(CUSTOM_SKILLS_ROOT, { recursive: true });
    for (const entry of bundleScan.skills) {
      const skillId = chooseAvailableSkillId(entry.suggestedId, params.installId);
      fs.cpSync(entry.sourceDir, path.join(CUSTOM_SKILLS_ROOT, skillId), {
        recursive: true,
        force: true,
      });
      installedSkillIds.push(skillId);
    }
    for (const entry of bundleScan.commandSkills) {
      const skillId = chooseAvailableSkillId(entry.suggestedId, params.installId);
      const targetDir = path.join(CUSTOM_SKILLS_ROOT, skillId);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'SKILL.md'),
        fs.readFileSync(entry.sourceFile, 'utf-8'),
        'utf-8',
      );
      installedSkillIds.push(skillId);
    }

    const installedBundleRoot = managedRoot;
    let currentServers = await getManagedMcpServersForResponse();
    const installedMcpServerIds: string[] = [];
    const warnings: string[] = [];
    for (const mcpFile of bundleScan.mcpFiles) {
      const importedServers = parseManagedMcpBundleFile(mcpFile).map((server) =>
        absolutizeBundleMcpServer(server, installedBundleRoot),
      );
      for (const server of importedServers) {
        const serverId = chooseAvailableMcpId(
          server.id,
          params.installId,
          currentServers,
        );
        currentServers = currentServers
          .filter((entry) => entry.id !== serverId)
          .concat({
            ...server,
            id: serverId,
            name: server.name.trim() || serverId,
          })
          .sort((a, b) => a.id.localeCompare(b.id));
        installedMcpServerIds.push(serverId);
        if (
          !path.isAbsolute(server.command) &&
          server.command === server.command.trim()
        ) {
          warnings.push(
            t(
              'extension.externalCommandWarning',
              { serverId, command: server.command },
              undefined,
            ),
          );
        }
      }
    }

    if (currentServers.length === 0) {
      await deleteConfig(WEB_MCP_SERVERS_CONFIG_KEY);
    } else {
      await setConfig(
        WEB_MCP_SERVERS_CONFIG_KEY,
        serializeManagedMcpServersConfig(currentServers),
      );
    }
    mcpConfigMutated = true;

    const installed: ExtensionInstallRecord = {
      id: params.installId,
      canonicalId,
      name: params.installName,
      version: params.version,
      sourceType: params.sourceType,
      sourceKind: params.sourceKind,
      sourceRef: params.sourceRef,
      resolvedSource: params.resolvedSource,
      contentHash,
      trustState: params.trustState,
      marketplaceName: params.marketplaceName,
      marketplaceSource: params.marketplaceSource,
      marketplaceEntry: params.marketplaceEntry,
      installedSkillIds,
      installedMcpServerIds,
      agentCount: bundleScan.agentDirs.length,
      installedAt: new Date().toISOString(),
      status: warnings.length > 0 ? 'needs_attention' : 'installed',
      warnings,
    };

    if (managedRoot) {
      void saveDirectoryToFileStore({
        category: 'extension',
        basePathRef: params.installId,
        diskRoot: managedRoot,
      }).catch((err) => {
        logger.debug({ err, installId: params.installId }, 'Failed to save extension to file store');
      });
    }
    for (const skillId of installedSkillIds) {
      const skillDir = path.join(CUSTOM_SKILLS_ROOT, skillId);
      void saveDirectoryToFileStore({
        category: 'skill',
        basePathRef: skillId,
        diskRoot: skillDir,
      }).catch((err) => {
        logger.debug({ err, skillId }, 'Failed to save installed skill to file store');
      });
    }

    const nextInstalls = installs
      .filter((entry) => entry.id !== installed.id)
      .concat(installed);
    return {
      installs: await persistExtensionInstalls(nextInstalls),
      installed,
    };
  } catch (err) {
    for (const skillId of installedSkillIds) {
      const targetDir = path.join(CUSTOM_SKILLS_ROOT, skillId);
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    }
    if (managedRoot && fs.existsSync(managedRoot)) {
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
    if (mcpConfigMutated) {
      if (
        typeof previousRawMcpConfig === 'string' &&
        previousRawMcpConfig.trim()
      ) {
        await setConfig(WEB_MCP_SERVERS_CONFIG_KEY, previousRawMcpConfig);
      } else {
        await deleteConfig(WEB_MCP_SERVERS_CONFIG_KEY);
      }
    }
    if (existingInstall && backup) {
      await restoreExistingInstallArtifacts(existingInstall, backup);
    }
    throw err;
  } finally {
    cleanupExistingInstallBackup(backup);
  }
}

export async function installMarketplaceExtensionFromInput(input: {
  sourceId?: unknown;
  source?: unknown;
  entryName?: unknown;
  overwrite?: unknown;
}): Promise<ExtensionInstallResult> {
  const entryName =
    typeof input.entryName === 'string' ? input.entryName.trim() : '';
  if (!entryName) {
    throw new Error('entryName is required');
  }

  const sourceId =
    typeof input.sourceId === 'string' ? input.sourceId.trim() : '';
  const sourceInput =
    typeof input.source === 'string' ? input.source.trim() : '';
  const configuredSources = await getExtensionMarketplaceSourcesForResponse();
  const source = sourceId
    ? configuredSources.find((entry) => entry.id === sourceId)
    : sourceInput
      ? {
          id: 'adhoc',
          name: t('extension.temporarySource', {}, undefined),
          source: sourceInput,
          enabled: true,
        }
      : null;
  if (!source) {
    throw new Error('marketplace source not found');
  }
  if (sourceId && source.enabled === false) {
    throw new Error(`marketplace source is disabled: ${sourceId}`);
  }

  const loaded = await loadMarketplace({ source: source.source });
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }

  try {
    const entry = loaded.marketplace.manifest.plugins.find(
      (item) => item.name === entryName,
    );
    if (!entry) {
      throw new Error(`marketplace entry not found: ${entryName}`);
    }
    const resolvedSource = await resolveBundleSourceFromEntry(
      entry.source,
      loaded.marketplace.rootDir,
    );
    if (!resolvedSource.ok) {
      throw new Error(resolvedSource.error);
    }
    try {
      const installId = normalizeInstallId(entry.name);
      const sourceKind = mapMarketplaceEntrySourceKind(entry.source);
      const trustState: ExtensionInstallRecord['trustState'] = sourceId
        ? 'trusted'
        : 'needs_review';
      return await installBundleFromResolvedSource({
        installId,
        installName: entry.name,
        version: entry.version,
        sourceType: 'marketplace',
        sourceKind,
        sourceRef: source.source,
        resolvedSource: resolveRecordedSource({
          sourceKind,
          bundleRoot: resolvedSource.bundleRoot,
          sourceRef: resolvedSource.sourceRef,
        }),
        trustState,
        marketplaceName: loaded.marketplace.manifest.name || source.name,
        marketplaceSource: source.source,
        marketplaceEntry: entry.name,
        bundleRoot: resolvedSource.bundleRoot,
        overwrite: Boolean(input.overwrite),
      });
    } finally {
      await resolvedSource.cleanup?.();
    }
  } finally {
    await loaded.marketplace.cleanup?.();
  }
}

export async function importExtensionFromInput(input: {
  source?: unknown;
  installId?: unknown;
  name?: unknown;
  overwrite?: unknown;
}): Promise<ExtensionInstallResult> {
  const source =
    typeof input.source === 'string' ? input.source.trim() : '';
  if (!source) {
    throw new Error('source is required');
  }

  function isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
  }
  function isGitUrl(value: string): boolean {
    return (
      /^git@/i.test(value) ||
      /^ssh:\/\//i.test(value) ||
      /^https?:\/\/.+\.git(?:#.*)?$/i.test(value)
    );
  }
  function looksLikeGitHubRepoShorthand(value: string): boolean {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.+)?$/.test(value.trim());
  }

  let resolvedSource: ResolvedBundleSource | null = null;
  try {
    const localSourcePath = path.isAbsolute(source)
      ? source
      : path.resolve(process.cwd(), source);
    if (await pathExists(localSourcePath)) {
      resolvedSource = await resolveLocalBundleSource(localSourcePath);
    } else if (
      looksLikeGitHubRepoShorthand(source) ||
      isGitUrl(source) ||
      isHttpUrl(source)
    ) {
      if (normalizeGitCloneSource(source)) {
        resolvedSource = await resolveBundleSourceFromEntry(
          { kind: 'git', url: source },
          process.cwd(),
        );
      } else {
        resolvedSource = await downloadRemoteBundleFile(source);
      }
      if (!resolvedSource.ok) {
        throw new Error(resolvedSource.error);
      }
    } else {
      resolvedSource = {
        ok: true,
        bundleRoot: resolveBundleRootFromPath(source),
        sourceRef: source,
        suggestedName: deriveSuggestedNameFromPath(source),
      };
    }

    if (!resolvedSource) {
      throw new Error('source resolution failed');
    }
    if (!resolvedSource.ok) {
      throw new Error(resolvedSource.error);
    }
    const resolvedRoot = resolvedSource.bundleRoot;
    const fallbackName =
      resolvedSource.suggestedName || path.basename(resolvedRoot);
    const installId =
      typeof input.installId === 'string' && input.installId.trim()
        ? normalizeInstallId(input.installId)
        : normalizeInstallId(fallbackName);
    const name =
      typeof input.name === 'string' && input.name.trim()
        ? input.name.trim()
        : fallbackName;
    const sourceKind = deriveSourceKindFromRef(
      resolvedSource.sourceRef,
      'import',
    );
    return await installBundleFromResolvedSource({
      installId,
      installName: name,
      sourceType: 'import',
      sourceKind,
      sourceRef: resolvedSource.sourceRef,
      resolvedSource: resolveRecordedSource({
        sourceKind,
        bundleRoot: resolvedRoot,
        sourceRef: resolvedSource.sourceRef,
      }),
      trustState: deriveTrustState({ sourceType: 'import', sourceKind }),
      bundleRoot: resolvedRoot,
      overwrite: Boolean(input.overwrite),
    });
  } finally {
    if (resolvedSource?.ok) {
      await resolvedSource.cleanup?.();
    }
  }
}

export async function uninstallExtensionFromInput(input: {
  installId?: unknown;
  id?: unknown;
}): Promise<ExtensionUninstallResult> {
  const installId =
    typeof input.installId === 'string'
      ? input.installId.trim()
      : typeof input.id === 'string'
        ? input.id.trim()
        : '';
  if (!installId) {
    throw new Error('installId is required');
  }

  const installs = await getExtensionInstallsForResponse();
  const existingInstall = installs.find((entry) => entry.id === installId) || null;
  if (!existingInstall) {
    throw new Error(`extension install not found: ${installId}`);
  }

  await removeExistingInstallArtifacts(existingInstall);

  void removeFileStoreByPrefix('extension', `${installId}/`).catch((err) => {
    logger.debug({ err, installId }, 'Failed to remove extension file store entries');
  });
  for (const skillId of existingInstall.installedSkillIds || []) {
    void removeFileStoreByPrefix('skill', `${skillId}/`).catch((err) => {
      logger.debug({ err, skillId }, 'Failed to remove skill file store entries');
    });
  }

  const nextInstalls = installs.filter((entry) => entry.id !== installId);
  return {
    installs: await persistExtensionInstalls(nextInstalls),
    removed: existingInstall,
  };
}

export async function reconcileExtensionInstalls(): Promise<ExtensionReconcileResult> {
  const installs = await getExtensionInstallsForResponse();
  const installedMcpIds = new Set(
    (await getManagedMcpServersForResponse()).map((server) => server.id),
  );
  const reconciled = installs.map((entry) => {
    const healthWarnings: string[] = [];

    for (const skillId of entry.installedSkillIds) {
      const skillPath = path.join(CUSTOM_SKILLS_ROOT, skillId, 'SKILL.md');
      if (!fs.existsSync(skillPath)) {
        healthWarnings.push(extensionSkillMissingMessage(skillId));
      }
    }

    for (const mcpId of entry.installedMcpServerIds) {
      if (!installedMcpIds.has(mcpId)) {
        healthWarnings.push(extensionMcpMissingMessage(mcpId));
      }
    }

    const managedBundleRoot = path.join(MANAGED_EXTENSIONS_ROOT, entry.id);
    if (!fs.existsSync(managedBundleRoot)) {
      healthWarnings.push(extensionBundleMissingMessage(managedBundleRoot));
    } else {
      try {
        const nextHash = computeBundleContentHash(managedBundleRoot);
        if (entry.contentHash && entry.contentHash !== nextHash) {
          healthWarnings.push(t('extension.hashChanged', {}, undefined));
        }
      } catch (err) {
        const reason =
          err instanceof Error && err.message
            ? err.message
            : 'failed to hash extension bundle';
        healthWarnings.push(extensionBundleValidationFailedMessage(reason));
      }
    }

    const warnings = Array.from(
      new Set([
        ...entry.warnings.filter((message) => !isReconcileWarning(message)),
        ...healthWarnings,
      ]),
    );

    return {
      ...entry,
      status: warnings.length > 0 ? ('needs_attention' as const) : ('installed' as const),
      warnings,
    };
  });

  return {
    installs: await persistExtensionInstalls(reconciled),
  };
}
