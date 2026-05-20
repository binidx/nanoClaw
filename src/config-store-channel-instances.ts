import { getConfig, getConfigBatch, setConfig } from './db.js';
import {
  getResolvedChannelTypeDefinition,
  getResolvedChannelTypeDefinitions,
} from './conversation/channel-metadata.js';
import type {
  ChannelFieldDefinition,
  ChannelTypeDefinition,
} from './config-channel-definitions.js';
import { DEFAULTS } from './config-store-defaults.js';
import { SYSTEM_USER_ID } from './tenant/tenant-context.js';
import { getAllEnabledChannelInstances } from './tenant/tenant-db.js';
import { decryptValue } from './crypto.js';
import { t } from './i18n/index.js';
import { createModuleLogger } from './logger.js';

export const CHANNEL_INSTANCES_CONFIG_KEY = 'CHANNEL_INSTANCES';

const channelConfigLog = createModuleLogger('channel-config');

export type ChannelVisibility = 'public' | 'private';

export interface ChannelInstanceConfig {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  visibility: ChannelVisibility;
  owner_id: string;
  config: Record<string, string | boolean>;
}

interface TenantChannelInstanceRow {
  id: string;
  user_id: string;
  type: string;
  name: string;
  config_json: string;
}

function normalizeBooleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function normalizeStringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function decryptConfigValue(value: unknown): string | boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return decryptValue(value);
  if (value === null || value === undefined) return '';
  return String(value);
}

function parseTenantChannelConfig(
  row: TenantChannelInstanceRow,
): Record<string, string | boolean> {
  const parsed = JSON.parse(row.config_json) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config_json must be an object');
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
      key,
      decryptConfigValue(value),
    ]),
  );
}

function makeDefaultFieldValue(
  field: ChannelFieldDefinition,
): string | boolean {
  if (field.type === 'boolean') return false;
  if (field.options?.length) return field.options[0]!.value;
  return '';
}

function slugifyInstanceId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'instance';
}

function ensureUniqueId(base: string, used: Set<string>): string {
  let next = base;
  let index = 2;
  while (used.has(next)) {
    next = `${base}-${index}`;
    index += 1;
  }
  used.add(next);
  return next;
}

function normalizeChannelFieldValue(
  value: unknown,
  field: ChannelFieldDefinition,
  fallback?: string | boolean,
): string | boolean {
  const defaultValue = fallback ?? makeDefaultFieldValue(field);
  if (field.type === 'boolean') {
    return normalizeBooleanValue(value, Boolean(defaultValue));
  }

  const normalized = normalizeStringValue(value, String(defaultValue || ''));
  if (field.options?.length) {
    const option = field.options.find((entry) => entry.value === normalized);
    return option ? option.value : field.options[0]!.value;
  }
  return normalized;
}

async function buildLegacyFeishuInstance(): Promise<ChannelInstanceConfig[]> {
  const keys = [
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_DOMAIN',
    'FEISHU_RENDER_MODE',
    'FEISHU_REPLY_IN_THREAD',
  ] as const;
  const batch = await getConfigBatch([...keys]);
  const values: Record<string, string> = {};
  for (const key of keys) {
    values[key] = batch[key] ?? DEFAULTS[key] ?? '';
  }
  const appId = values.FEISHU_APP_ID || '';
  const appSecret = values.FEISHU_APP_SECRET || '';
  const domain = values.FEISHU_DOMAIN || 'feishu';
  const renderMode = values.FEISHU_RENDER_MODE || 'auto';
  const replyInThread = normalizeBooleanValue(
    values.FEISHU_REPLY_IN_THREAD,
    false,
  );

  const hasAnyValue = [appId, appSecret].some(
    (entry) => String(entry || '').trim().length > 0,
  );
  if (!hasAnyValue) {
    return [];
  }

  return [
    {
      id: 'default',
      type: 'feishu',
      name: t('config.defaultFeishu', {}, undefined),
      enabled: true,
      visibility: 'public' as ChannelVisibility,
      owner_id: SYSTEM_USER_ID,
      config: {
        appId,
        appSecret,
        domain,
        renderMode,
        replyInThread,
      },
    },
  ];
}

async function getStoredChannelInstancesRaw(): Promise<unknown[] | null> {
  const raw = await getConfig(CHANNEL_INSTANCES_CONFIG_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('CHANNEL_INSTANCES must be a JSON array');
  }
  return parsed;
}

function normalizeInstanceName(
  name: unknown,
  definition: ChannelTypeDefinition,
  index: number,
): string {
  const normalized = normalizeStringValue(name);
  if (normalized) return normalized;
  return `${definition.label} ${index + 1}`;
}

export async function getConfiguredChannelInstances(): Promise<
  ChannelInstanceConfig[]
> {
  const rawInstances = await getStoredChannelInstancesRaw();
  const configured = rawInstances
    ? await normalizeChannelInstances(rawInstances)
    : await buildLegacyFeishuInstance();
  const userInstances = await getConfiguredUserChannelInstances(configured);
  return [...configured, ...userInstances];
}

export async function getConfiguredUserChannelInstances(
  existingInstances: ChannelInstanceConfig[] = [],
): Promise<ChannelInstanceConfig[]> {
  const rows = await getAllEnabledChannelInstances();
  const normalized: ChannelInstanceConfig[] = [];
  for (const row of rows) {
    try {
      const candidate = {
        id: row.id,
        type: row.type,
        name: row.name,
        enabled: true,
        visibility: 'private',
        owner_id: row.user_id,
        config: parseTenantChannelConfig(row),
      };
      const normalizedAll = await normalizeChannelInstances(
        [...existingInstances, ...normalized, candidate],
        [...existingInstances, ...normalized],
      );
      const instance = normalizedAll[normalizedAll.length - 1];
      if (instance) normalized.push(instance);
    } catch (err) {
      channelConfigLog.warn(
        { err, instanceId: row.id, type: row.type, userId: row.user_id },
        'Skipping invalid user channel instance',
      );
    }
  }
  return normalized;
}

export async function getSanitizedChannelInstances(): Promise<
  ChannelInstanceConfig[]
> {
  const definitions = new Map(
    getResolvedChannelTypeDefinitions().map((entry) => [entry.type, entry]),
  );
  return (await getConfiguredChannelInstances()).map((instance) => {
    const definition = definitions.get(instance.type);
    if (!definition) return instance;
    return {
      ...instance,
      config: Object.fromEntries(
        definition.fields.map((field) => [
          field.key,
          field.risk === 'sensitive' ? '' : instance.config[field.key],
        ]),
      ),
    };
  });
}

export async function getSanitizedChannelInstancesForUser(
  userId: string,
): Promise<ChannelInstanceConfig[]> {
  const all = await getSanitizedChannelInstances();
  if (!userId || userId === SYSTEM_USER_ID) return all;
  return all.filter(
    (instance) =>
      instance.visibility === 'public' || instance.owner_id === userId,
  );
}

export async function normalizeChannelInstances(
  rawInstances: unknown[],
  existingInstances?: ChannelInstanceConfig[],
): Promise<ChannelInstanceConfig[]> {
  const resolvedExisting =
    existingInstances ?? (await getConfiguredChannelInstancesSafe());
  const usedIds = new Set<string>();
  const instancesById = new Map(
    resolvedExisting.map((entry) => [entry.id, entry]),
  );
  const perTypeCounts = new Map<string, number>();
  const normalized = rawInstances.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(
        t('config.channelInstanceInvalid', { index: index + 1 }, undefined),
      );
    }

    const record = raw as Record<string, unknown>;
    const type = normalizeStringValue(record.type).toLowerCase();
    const definition = getResolvedChannelTypeDefinition(type);
    if (!definition) {
      throw new Error(
        t(
          'config.channelTypeUnsupported',
          { type: type || `#${index + 1}` },
          undefined,
        ),
      );
    }

    const currentCount = perTypeCounts.get(type) || 0;
    perTypeCounts.set(type, currentCount + 1);

    const existing = instancesById.get(normalizeStringValue(record.id));
    const id = ensureUniqueId(
      slugifyInstanceId(
        normalizeStringValue(record.id) || `${type}-${currentCount + 1}`,
      ),
      usedIds,
    );

    const configInput =
      record.config && typeof record.config === 'object'
        ? (record.config as Record<string, unknown>)
        : {};
    const nextConfig: Record<string, string | boolean> = {};

    for (const field of definition.fields) {
      const incomingValue = configInput[field.key];
      const existingValue =
        existing?.type === type ? existing.config[field.key] : undefined;
      let normalizedValue = normalizeChannelFieldValue(
        incomingValue,
        field,
        existingValue,
      );

      if (
        field.risk === 'sensitive' &&
        typeof normalizedValue === 'string' &&
        !normalizedValue &&
        typeof existingValue === 'string' &&
        existingValue
      ) {
        normalizedValue = existingValue;
      }

      nextConfig[field.key] = normalizedValue;
    }

    const rawVisibility = normalizeStringValue(record.visibility).toLowerCase();
    const visibility: ChannelVisibility =
      rawVisibility === 'private' ? 'private' : 'public';
    const ownerId =
      normalizeStringValue(record.owner_id) ||
      existing?.owner_id ||
      SYSTEM_USER_ID;

    return {
      id,
      type,
      name: normalizeInstanceName(record.name, definition, currentCount),
      enabled: record.enabled !== false,
      visibility,
      owner_id: ownerId,
      config: nextConfig,
    } satisfies ChannelInstanceConfig;
  });

  validateChannelInstances(normalized);
  return normalized;
}

async function getConfiguredChannelInstancesSafe(): Promise<
  ChannelInstanceConfig[]
> {
  try {
    const rawInstances = await getStoredChannelInstancesRaw();
    if (!rawInstances) return buildLegacyFeishuInstance();
    const existing = rawInstances.map(
      (entry) => entry as ChannelInstanceConfig,
    );
    return existing.filter(
      (entry) =>
        entry && typeof entry === 'object' && typeof entry.type === 'string',
    );
  } catch {
    return buildLegacyFeishuInstance();
  }
}

export function validateChannelInstances(
  instances: ChannelInstanceConfig[],
): void {
  const typeCounts = new Map<string, number>();
  const feishuSecrets = new Map<string, string>();

  for (const instance of instances) {
    const definition = getResolvedChannelTypeDefinition(instance.type);
    if (!definition) {
      throw new Error(
        t('config.channelTypeUnsupported', { type: instance.type }, undefined),
      );
    }

    typeCounts.set(instance.type, (typeCounts.get(instance.type) || 0) + 1);

    if (instance.enabled) {
      const missingFields = definition.fields
        .filter((field) => field.required)
        .filter((field) => {
          const value = instance.config[field.key];
          if (field.type === 'boolean')
            return value !== true && value !== false;
          return !normalizeStringValue(value);
        })
        .map((field) => field.label);
      if (missingFields.length > 0) {
        throw new Error(
          t(
            'config.channelMissingFields',
            { name: instance.name, fields: missingFields.join('、') },
            undefined,
          ),
        );
      }
    }

    if (instance.type === 'feishu') {
      const appId = normalizeStringValue(instance.config.appId);
      const appSecret = normalizeStringValue(instance.config.appSecret);
      if (appId && appSecret) {
        const dedupKey = `${appId}::${appSecret}`;
        const conflict = feishuSecrets.get(dedupKey);
        if (conflict) {
          throw new Error(
            t(
              'config.feishuDuplicateCredentials',
              { name: instance.name, conflict },
              undefined,
            ),
          );
        }
        feishuSecrets.set(dedupKey, instance.name);
      }
    }
  }

  for (const [type, count] of typeCounts) {
    const definition = getResolvedChannelTypeDefinition(type);
    if (definition && !definition.allowMultiple && count > 1) {
      throw new Error(
        t(
          'config.channelSingleInstanceOnly',
          { label: definition.label },
          undefined,
        ),
      );
    }
  }
}

export async function saveChannelInstances(
  rawInstances: unknown[],
): Promise<ChannelInstanceConfig[]> {
  const normalized = await normalizeChannelInstances(rawInstances);
  await setConfig(CHANNEL_INSTANCES_CONFIG_KEY, JSON.stringify(normalized));
  return normalized;
}

export const saveConfiguredChannelInstances = saveChannelInstances;
