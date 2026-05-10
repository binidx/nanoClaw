import { getConfig, setConfig } from '../db.js';
import {
  generateMcpServerId,
  generateSkillId,
  upsertUserMcpServer,
  upsertUserSkill,
  generateMarketplaceSourceId,
  upsertMarketplaceSource,
  generateInstallId,
  upsertMarketplaceInstall,
  listFileStoreEntries,
} from '../db.js';
import { logger } from '../logger.js';
import {
  WEB_MCP_SERVERS_CONFIG_KEY,
  WEB_ENABLED_SKILLS_CONFIG_KEY,
  parseManagedMcpServersConfig,
  parseEnabledSkillsConfig,
  listManagedSkills,
} from '../runtime/runtime-customization.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';

const MIGRATION_KEY = 'MCP_SKILLS_V2_MIGRATED';

export async function shouldRunMcpSkillsMigration(): Promise<boolean> {
  const value = await getConfig(MIGRATION_KEY);
  return value !== 'true';
}

export async function runMcpSkillsMigration(): Promise<{
  mcpServers: number;
  skills: number;
  marketplaceSources: number;
  installs: number;
}> {
  const report = { mcpServers: 0, skills: 0, marketplaceSources: 0, installs: 0 };
  const now = new Date().toISOString();

  report.mcpServers = await migrateMcpServers(now);
  report.skills = await migrateSkills(now);
  report.marketplaceSources = await migrateMarketplaceSources(now);
  report.installs = await migrateInstalls(now);

  await setConfig(MIGRATION_KEY, 'true');
  logger.info(report, 'MCP/Skills v2 migration complete');
  return report;
}

async function migrateMcpServers(now: string): Promise<number> {
  let count = 0;
  try {
    const raw = await getConfig(WEB_MCP_SERVERS_CONFIG_KEY);
    if (!raw) return count;

    const servers = parseManagedMcpServersConfig(raw);
    for (const server of servers) {
      try {
        await upsertUserMcpServer({
          id: server.id || generateMcpServerId(),
          user_id: SYSTEM_USER_ID,
          name: server.name,
          description: null,
          command: server.command,
          args_json: JSON.stringify(server.args || []),
          env_json: JSON.stringify(server.env || {}),
          metadata_json: null,
          enabled: server.enabled ? 1 : 0,
          visibility: 'shared',
          source_type: 'manual',
          source_ref: null,
          icon_url: null,
          tags_json: null,
          created_at: now,
          updated_at: now,
        });
        count++;
      } catch (err) {
        logger.warn({ err, serverId: server.id }, 'mcp-migration: failed to migrate server');
      }
    }

    await setConfig(`${WEB_MCP_SERVERS_CONFIG_KEY}_MIGRATED`, raw);
  } catch (err) {
    logger.warn({ err }, 'mcp-migration: failed to migrate MCP servers');
  }
  return count;
}

async function migrateSkills(now: string): Promise<number> {
  let count = 0;
  try {
    const managedSkills = listManagedSkills(process.cwd());
    let enabledSet: Set<string> | null = null;
    try {
      enabledSet = parseEnabledSkillsConfig(
        await getConfig(WEB_ENABLED_SKILLS_CONFIG_KEY),
      );
    } catch {
      /* fallback to all enabled */
    }

    const allSkillEntries = await listFileStoreEntries({
      category: 'skill',
      limit: 2000,
    });

    for (const skill of managedSkills) {
      try {
        let content: string | null = null;
        const matched = allSkillEntries.find(
          (e) => e.path_ref === skill.id || e.path_ref.endsWith(`/${skill.id}/SKILL.md`),
        );
        if (matched) {
          content = matched.content;
        }

        await upsertUserSkill({
          id: skill.id || generateSkillId(),
          user_id: SYSTEM_USER_ID,
          name: skill.name,
          description: skill.description ?? null,
          summary: null,
          skill_content: content,
          metadata_json: null,
          enabled: enabledSet ? (enabledSet.has(skill.id) ? 1 : 0) : 1,
          visibility: 'shared',
          source_type: skill.source === 'builtin' ? 'builtin' : 'manual',
          source_ref: null,
          icon_url: null,
          tags_json: null,
          created_at: now,
          updated_at: now,
        });
        count++;
      } catch (err) {
        logger.warn({ err, skillId: skill.id }, 'skill-migration: failed to migrate skill');
      }
    }

    const enabledRaw = await getConfig(WEB_ENABLED_SKILLS_CONFIG_KEY);
    if (enabledRaw) {
      await setConfig(`${WEB_ENABLED_SKILLS_CONFIG_KEY}_MIGRATED`, enabledRaw);
    }
  } catch (err) {
    logger.warn({ err }, 'skill-migration: failed to migrate skills');
  }
  return count;
}

async function migrateMarketplaceSources(now: string): Promise<number> {
  let count = 0;
  try {
    const raw = await getConfig('WEB_EXTENSION_MARKETPLACES');
    if (!raw) return count;

    let sources: Array<{ id?: string; name?: string; source?: string; enabled?: boolean }>;
    try {
      sources = JSON.parse(raw);
    } catch {
      return count;
    }
    if (!Array.isArray(sources)) return count;

    for (const src of sources) {
      if (!src.source) continue;
      try {
        await upsertMarketplaceSource({
          id: src.id || generateMarketplaceSourceId(),
          name: src.name || src.id || 'unnamed',
          source: src.source,
          enabled: src.enabled !== false ? 1 : 0,
          description: null,
          icon_url: null,
          sort_order: count,
          created_by: SYSTEM_USER_ID,
          created_at: now,
          updated_at: now,
        });
        count++;
      } catch (err) {
        logger.warn({ err, sourceId: src.id }, 'marketplace-migration: failed to migrate source');
      }
    }

    await setConfig('WEB_EXTENSION_MARKETPLACES_MIGRATED', raw);
  } catch (err) {
    logger.warn({ err }, 'marketplace-migration: failed to migrate marketplace sources');
  }
  return count;
}

async function migrateInstalls(now: string): Promise<number> {
  let count = 0;
  try {
    const raw = await getConfig('WEB_EXTENSION_INSTALLS');
    if (!raw) return count;

    let installs: Array<{
      installId?: string;
      sourceType?: string;
      marketplaceEntry?: string;
      marketplaceSource?: string;
      status?: string;
      installedAt?: string;
    }>;
    try {
      installs = JSON.parse(raw);
    } catch {
      return count;
    }
    if (!Array.isArray(installs)) return count;

    for (const inst of installs) {
      try {
        await upsertMarketplaceInstall({
          id: inst.installId || generateInstallId(),
          user_id: SYSTEM_USER_ID,
          source_id: null,
          entry_name: inst.marketplaceEntry || 'unknown',
          entry_type: 'extension',
          installed_version: null,
          target_id: null,
          status: inst.status || 'installed',
          created_at: inst.installedAt || now,
          updated_at: now,
        });
        count++;
      } catch (err) {
        logger.warn({ err }, 'install-migration: failed to migrate install record');
      }
    }

    await setConfig('WEB_EXTENSION_INSTALLS_MIGRATED', raw);
  } catch (err) {
    logger.warn({ err }, 'install-migration: failed to migrate installs');
  }
  return count;
}
