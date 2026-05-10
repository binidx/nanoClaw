import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

export const namespaces = [
  'common', 'nav', 'chat', 'settings', 'knowledge', 'assistants',
  'soul', 'tasks', 'users', 'workteam', 'stock', 'channels', 'apps',
  'repoReview', 'errors', 'im', 'codeMap', 'live2d', 'subagent',
  'share', 'terminal', 'approval', 'browser',
] as const;

export type Namespace = (typeof namespaces)[number];

type SupportedLanguage = 'zh' | 'en';
type LocaleMessages = Record<string, string>;
type LocaleBundle = Record<Namespace, LocaleMessages>;
type LocaleModule = { default: LocaleMessages };
type LocaleLoaders = Record<Namespace, () => Promise<LocaleModule>>;

const STORAGE_KEY = 'nanoclaw_locale';

const localeLoaders: Record<SupportedLanguage, LocaleLoaders> = {
  zh: {
    common: () => import('./locales/zh/common.json'),
    nav: () => import('./locales/zh/nav.json'),
    chat: () => import('./locales/zh/chat.json'),
    settings: () => import('./locales/zh/settings.json'),
    knowledge: () => import('./locales/zh/knowledge.json'),
    assistants: () => import('./locales/zh/assistants.json'),
    soul: () => import('./locales/zh/soul.json'),
    tasks: () => import('./locales/zh/tasks.json'),
    users: () => import('./locales/zh/users.json'),
    workteam: () => import('./locales/zh/workteam.json'),
    stock: () => import('./locales/zh/stock.json'),
    channels: () => import('./locales/zh/channels.json'),
    apps: () => import('./locales/zh/apps.json'),
    repoReview: () => import('./locales/zh/repoReview.json'),
    errors: () => import('./locales/zh/errors.json'),
    im: () => import('./locales/zh/im.json'),
    codeMap: () => import('./locales/zh/codeMap.json'),
    live2d: () => import('./locales/zh/live2d.json'),
    subagent: () => import('./locales/zh/subagent.json'),
    share: () => import('./locales/zh/share.json'),
    terminal: () => import('./locales/zh/terminal.json'),
    approval: () => import('./locales/zh/approval.json'),
    browser: () => import('./locales/zh/browser.json'),
  },
  en: {
    common: () => import('./locales/en/common.json'),
    nav: () => import('./locales/en/nav.json'),
    chat: () => import('./locales/en/chat.json'),
    settings: () => import('./locales/en/settings.json'),
    knowledge: () => import('./locales/en/knowledge.json'),
    assistants: () => import('./locales/en/assistants.json'),
    soul: () => import('./locales/en/soul.json'),
    tasks: () => import('./locales/en/tasks.json'),
    users: () => import('./locales/en/users.json'),
    workteam: () => import('./locales/en/workteam.json'),
    stock: () => import('./locales/en/stock.json'),
    channels: () => import('./locales/en/channels.json'),
    apps: () => import('./locales/en/apps.json'),
    repoReview: () => import('./locales/en/repoReview.json'),
    errors: () => import('./locales/en/errors.json'),
    im: () => import('./locales/en/im.json'),
    codeMap: () => import('./locales/en/codeMap.json'),
    live2d: () => import('./locales/en/live2d.json'),
    subagent: () => import('./locales/en/subagent.json'),
    share: () => import('./locales/en/share.json'),
    terminal: () => import('./locales/en/terminal.json'),
    approval: () => import('./locales/en/approval.json'),
    browser: () => import('./locales/en/browser.json'),
  },
};

const loadedBundles: Partial<Record<SupportedLanguage, LocaleBundle>> = {};
let initPromise: Promise<typeof i18n> | null = null;
let fetchPatched = false;
let changeLanguagePatched = false;

function normalizeLanguage(value?: string | null): SupportedLanguage {
  return value?.toLowerCase().startsWith('en') ? 'en' : 'zh';
}

function resolvePreferredLanguage(): SupportedLanguage {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return normalizeLanguage(stored);
  } catch {
    /* storage unavailable */
  }
  return normalizeLanguage(window.navigator.language);
}

function addNamespaceAliases(
  namespace: Namespace,
  messages: LocaleMessages,
): LocaleMessages {
  const aliases = Object.fromEntries(
    Object.entries(messages)
      .filter(([key]) => !key.startsWith(`${namespace}.`))
      .map(([key, value]) => [`${namespace}.${key}`, value]),
  );

  return {
    ...messages,
    ...aliases,
  };
}

function addGeneratedKeyAliases(
  namespace: Namespace,
  messages: LocaleMessages,
): LocaleMessages {
  const aliases: LocaleMessages = {};
  for (const [key, value] of Object.entries(messages)) {
    const autoMatch = /^auto\.(.+)$/u.exec(key);
    if (!autoMatch) continue;
    aliases[`${namespace}.${autoMatch[1]}`] = value;
  }
  return {
    ...messages,
    ...aliases,
  };
}

function addLiteralValueAliases(
  messages: LocaleMessages,
  zhReference: LocaleMessages,
): LocaleMessages {
  const aliases: LocaleMessages = {};
  for (const [key, zhValue] of Object.entries(zhReference)) {
    const localizedValue = messages[key];
    if (
      typeof zhValue !== 'string' ||
      typeof localizedValue !== 'string' ||
      zhValue in messages
    ) {
      continue;
    }
    aliases[zhValue] = localizedValue;
  }
  return {
    ...messages,
    ...aliases,
  };
}

function buildLocaleBundle(
  bundle: LocaleBundle,
  zhReferenceBundle: LocaleBundle,
): LocaleBundle {
  const compatibilityExpanded = Object.fromEntries(
    namespaces.map((namespace) => [
      namespace,
      addGeneratedKeyAliases(
        namespace,
        addLiteralValueAliases(bundle[namespace], zhReferenceBundle[namespace]),
      ),
    ]),
  ) as LocaleBundle;

  const commonAliases = Object.fromEntries(
    namespaces.flatMap((namespace) =>
      Object.entries(compatibilityExpanded[namespace]).map(([key, value]) =>
        key.startsWith(`${namespace}.`)
          ? [key, value]
          : [`${namespace}.${key}`, value],
      ),
    ),
  ) as LocaleMessages;

  const expanded = Object.fromEntries(
    namespaces.map((namespace) => [
      namespace,
      addNamespaceAliases(namespace, compatibilityExpanded[namespace]),
    ]),
  ) as LocaleBundle;

  return {
    ...expanded,
    common: {
      ...expanded.common,
      ...commonAliases,
    },
  };
}

async function loadRawLocaleBundle(language: SupportedLanguage): Promise<LocaleBundle> {
  const entries = await Promise.all(
    namespaces.map(async (namespace) => {
      const module = await localeLoaders[language][namespace]();
      return [namespace, module.default] as const;
    }),
  );
  return Object.fromEntries(entries) as LocaleBundle;
}

function currentResources(): Partial<Record<SupportedLanguage, LocaleBundle>> {
  return Object.fromEntries(
    Object.entries(loadedBundles).filter((entry): entry is [SupportedLanguage, LocaleBundle] =>
      Boolean(entry[1]),
    ),
  ) as Partial<Record<SupportedLanguage, LocaleBundle>>;
}

async function ensureLanguageResources(language: SupportedLanguage): Promise<LocaleBundle> {
  const existing = loadedBundles[language];
  if (existing) return existing;

  if (language !== 'zh') {
    await ensureLanguageResources('zh');
  }

  const rawBundle = await loadRawLocaleBundle(language);
  const zhReference = language === 'zh' ? rawBundle : loadedBundles.zh;
  if (!zhReference) throw new Error('Chinese fallback locale failed to load');

  const bundle = buildLocaleBundle(rawBundle, zhReference);
  loadedBundles[language] = bundle;

  if (i18n.isInitialized) {
    for (const namespace of namespaces) {
      i18n.addResourceBundle(language, namespace, bundle[namespace], true, true);
    }
  }

  return bundle;
}

function patchFetchLocaleHeader(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const locale = normalizeLanguage(i18n.language || resolvePreferredLanguage());
    const headers = new Headers(init?.headers);
    if (!headers.has('X-Locale')) {
      headers.set('X-Locale', locale);
    }
    return originalFetch.call(this, input, { ...init, headers });
  };
}

function patchLanguageLoading(): void {
  if (changeLanguagePatched) return;
  changeLanguagePatched = true;
  const originalChangeLanguage = i18n.changeLanguage.bind(i18n);
  i18n.changeLanguage = ((lng?: string, callback?: Parameters<typeof i18n.changeLanguage>[1]) => {
    const language = normalizeLanguage(lng || i18n.language || resolvePreferredLanguage());
    return ensureLanguageResources(language).then(() => {
      window.localStorage.setItem(STORAGE_KEY, language);
      return originalChangeLanguage(language, callback);
    });
  }) as typeof i18n.changeLanguage;
}

function parseMissingKey(key: string): string {
  const language = normalizeLanguage(i18n.resolvedLanguage || i18n.language);
  if (language !== 'zh') return key;

  const prefixedMatch = /^([a-z]+)\.(.+)$/u.exec(key);
  if (!prefixedMatch) return key;

  const [, , suffix] = prefixedMatch;
  if (!/[\u3400-\u9fff]/u.test(suffix)) return key;
  if (/^auto[_./-]/u.test(suffix)) return key;
  return suffix.replaceAll('_', ' ');
}

export function initI18n(): Promise<typeof i18n> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const language = resolvePreferredLanguage();
    await ensureLanguageResources('zh');
    if (language !== 'zh') {
      await ensureLanguageResources(language);
    }

    await i18n
      .use(initReactI18next)
      .init({
        resources: currentResources(),
        lng: language,
        defaultNS: 'common',
        fallbackNS: 'common',
        ns: [...namespaces],
        fallbackLng: 'zh',
        interpolation: {
          escapeValue: false,
        },
        parseMissingKeyHandler: parseMissingKey,
      });

    window.localStorage.setItem(STORAGE_KEY, language);
    patchLanguageLoading();
    patchFetchLocaleHeader();
    return i18n;
  })();

  return initPromise;
}

export default i18n;
