import i18next from 'i18next';
import { createRequire } from 'module';
import type { Request } from 'express';

const require = createRequire(import.meta.url);

// Load all backend locale JSON files
const zhErrors = require('./locales/zh/errors.json');
const zhDoctor = require('./locales/zh/doctor.json');
const zhOnboard = require('./locales/zh/onboard.json');
const zhConfig = require('./locales/zh/config.json');
const zhPermissions = require('./locales/zh/permissions.json');
const zhRepoReview = require('./locales/zh/repoReview.json');
const zhStock = require('./locales/zh/stock.json');
const zhSoul = require('./locales/zh/soul.json');
const zhKnowledge = require('./locales/zh/knowledge.json');
const zhPrompts = require('./locales/zh/prompts.json');
const zhChannels = require('./locales/zh/channels.json');
const zhWorkteam = require('./locales/zh/workteam.json');
const zhSlashCommands = require('./locales/zh/slashCommands.json');

const enErrors = require('./locales/en/errors.json');
const enDoctor = require('./locales/en/doctor.json');
const enOnboard = require('./locales/en/onboard.json');
const enConfig = require('./locales/en/config.json');
const enPermissions = require('./locales/en/permissions.json');
const enRepoReview = require('./locales/en/repoReview.json');
const enStock = require('./locales/en/stock.json');
const enSoul = require('./locales/en/soul.json');
const enKnowledge = require('./locales/en/knowledge.json');
const enPrompts = require('./locales/en/prompts.json');
const enChannels = require('./locales/en/channels.json');
const enWorkteam = require('./locales/en/workteam.json');
const enSlashCommands = require('./locales/en/slashCommands.json');

export const backendNamespaces = [
  'errors', 'doctor', 'onboard', 'config', 'permissions',
  'repoReview', 'stock', 'soul', 'knowledge', 'prompts',
  'channels', 'workteam', 'slashCommands',
] as const;

const resources = {
  zh: {
    errors: zhErrors,
    doctor: zhDoctor,
    onboard: zhOnboard,
    config: zhConfig,
    permissions: zhPermissions,
    repoReview: zhRepoReview,
    stock: zhStock,
    soul: zhSoul,
    knowledge: zhKnowledge,
    prompts: zhPrompts,
    channels: zhChannels,
    workteam: zhWorkteam,
    slashCommands: zhSlashCommands,
  },
  en: {
    errors: enErrors,
    doctor: enDoctor,
    onboard: enOnboard,
    config: enConfig,
    permissions: enPermissions,
    repoReview: enRepoReview,
    stock: enStock,
    soul: enSoul,
    knowledge: enKnowledge,
    prompts: enPrompts,
    channels: enChannels,
    workteam: enWorkteam,
    slashCommands: enSlashCommands,
  },
};

const i18nInstance = i18next.createInstance();

i18nInstance.init({
  resources,
  defaultNS: 'errors',
  ns: [...backendNamespaces],
  fallbackLng: 'zh',
  interpolation: {
    escapeValue: false,
  },
});

export type BackendNamespace = (typeof backendNamespaces)[number];

function inferNamespaceFromKey(
  key: string,
  ns?: BackendNamespace,
): { ns: BackendNamespace; key: string; originalKey: string } {
  if (ns) return { ns, key, originalKey: key };
  const dot = key.indexOf('.');
  if (dot > 0) {
    const prefix = key.slice(0, dot);
    if ((backendNamespaces as readonly string[]).includes(prefix)) {
      return {
        ns: prefix as BackendNamespace,
        key: key.slice(dot + 1),
        originalKey: key,
      };
    }
  }
  return { ns: 'errors', key, originalKey: key };
}

/**
 * Translate a key for a given locale.
 * Usage: t('knowledge.notFound', {}, 'en')
 */
export function t(
  key: string,
  params?: Record<string, unknown>,
  locale?: string,
  ns?: BackendNamespace,
): string {
  const resolved = inferNamespaceFromKey(key, ns);
  const lng = locale || 'zh';
  if (i18nInstance.exists(resolved.key, { lng, ns: resolved.ns })) {
    return i18nInstance.t(resolved.key, {
      lng,
      ns: resolved.ns,
      ...params,
    });
  }
  if (resolved.originalKey !== resolved.key && i18nInstance.exists(resolved.originalKey, { lng, ns: 'errors' })) {
    return i18nInstance.t(resolved.originalKey, {
      lng,
      ns: 'errors',
      ...params,
    });
  }
  return i18nInstance.t(resolved.key, {
    lng: locale || 'zh',
    ns: resolved.ns,
    ...params,
  });
}

/**
 * Extract locale from an Express request.
 * Checks X-Locale header first, then Accept-Language, defaults to 'zh'.
 */
export function getLocaleFromReq(req: Request): string {
  const headerLocale = req.headers['x-locale'] as string | undefined;
  if (headerLocale && ['zh', 'en'].includes(headerLocale)) return headerLocale;

  const acceptLang = req.headers['accept-language'];
  if (acceptLang && acceptLang.startsWith('en')) return 'en';

  return 'zh';
}
