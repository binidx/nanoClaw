import { Client } from 'ldapts';

import { getConfigValues } from '../config-store.js';
import { createModuleLogger } from '../logger.js';

const authLog = createModuleLogger('auth');

export interface LdapAuthResult {
  username: string;
  displayName: string;
  email: string | null;
}

interface LdapAttributeMap {
  username: string;
  name: string;
  email: string;
}

const LDAP_CONFIG_KEYS = [
  'LDAP_ENABLED',
  'LDAP_URL',
  'LDAP_BIND_DN',
  'LDAP_BIND_PASSWORD',
  'LDAP_SEARCH_BASE',
  'LDAP_SEARCH_FILTER',
  'LDAP_ATTRIBUTE_MAP',
  'LDAP_FALLBACK_LOCAL',
  'LDAP_DEFAULT_ROLE',
  'ALLOW_INSECURE_TLS',
] as const;

const LDAP_OPERATION_TIMEOUT_MS = 15_000;

async function getLdapConfig() {
  const values = await getConfigValues([...LDAP_CONFIG_KEYS]);
  return {
    enabled:
      values.LDAP_ENABLED === 'true' || values.LDAP_ENABLED === '1',
    url: values.LDAP_URL || '',
    bindDn: values.LDAP_BIND_DN || '',
    bindPassword: values.LDAP_BIND_PASSWORD || '',
    searchBase: values.LDAP_SEARCH_BASE || '',
    searchFilter: values.LDAP_SEARCH_FILTER || '(sAMAccountName=%(user)s)',
    attributeMap: parseAttributeMap(values.LDAP_ATTRIBUTE_MAP),
    fallbackLocal:
      values.LDAP_FALLBACK_LOCAL !== 'false' &&
      values.LDAP_FALLBACK_LOCAL !== '0',
    defaultRole: values.LDAP_DEFAULT_ROLE || '',
    allowInsecureTls:
      values.ALLOW_INSECURE_TLS === 'true' ||
      values.ALLOW_INSECURE_TLS === '1',
  };
}

function parseAttributeMap(raw: string): LdapAttributeMap {
  const defaults: LdapAttributeMap = {
    username: 'sAMAccountName',
    name: 'cn',
    email: 'mail',
  };
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      username:
        typeof parsed.username === 'string' ? parsed.username : defaults.username,
      name: typeof parsed.name === 'string' ? parsed.name : defaults.name,
      email: typeof parsed.email === 'string' ? parsed.email : defaults.email,
    };
  } catch {
    authLog.warn({ raw }, 'Invalid LDAP_ATTRIBUTE_MAP, using defaults');
    return defaults;
  }
}

/**
 * Escape a value for safe insertion into an LDAP search filter per RFC 4515.
 * Characters: *, (, ), \, NUL are escaped as \xx hex pairs.
 */
function escapeLdapFilterValue(value: string): string {
  return value.replace(/[\\*()\x00]/g, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\${hex}`;
  });
}

function buildSearchFilter(template: string, username: string): string {
  const escaped = escapeLdapFilterValue(username);
  return template.replaceAll('%(user)s', escaped);
}

function extractAttribute(
  attributes: Record<string, unknown>,
  key: string,
): string | null {
  const value = attributes[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  return null;
}

function buildClientOptions(config: { url: string; allowInsecureTls: boolean }) {
  const opts: ConstructorParameters<typeof Client>[0] = {
    url: config.url,
    connectTimeout: 8000,
    timeout: LDAP_OPERATION_TIMEOUT_MS,
  };
  if (config.url.startsWith('ldaps://') && config.allowInsecureTls) {
    opts.tlsOptions = { rejectUnauthorized: false };
  }
  return opts;
}

export async function isLdapEnabled(): Promise<boolean> {
  const config = await getLdapConfig();
  return config.enabled && !!config.url;
}

export async function isLdapFallbackLocal(): Promise<boolean> {
  const config = await getLdapConfig();
  return config.fallbackLocal;
}

export async function getLdapDefaultRole(): Promise<string> {
  const config = await getLdapConfig();
  return config.defaultRole;
}

/**
 * Authenticate a user against LDAP.
 *
 * Flow:
 * 1. Bind with the service account to search for the user DN
 * 2. Search for the user entry using the configured filter
 * 3. Bind again with the user's own DN + password to verify credentials
 */
export async function authenticateLdap(
  username: string,
  password: string,
): Promise<LdapAuthResult | null> {
  const config = await getLdapConfig();
  if (!config.enabled || !config.url) return null;

  const client = new Client(buildClientOptions(config));

  try {
    await client.bind(config.bindDn, config.bindPassword);

    const filter = buildSearchFilter(config.searchFilter, username);
    const { searchEntries } = await client.search(config.searchBase, {
      scope: 'sub',
      filter,
      attributes: [
        config.attributeMap.username,
        config.attributeMap.name,
        config.attributeMap.email,
      ],
      sizeLimit: 1,
    });

    if (searchEntries.length === 0) {
      authLog.debug({ username }, 'LDAP user not found');
      return null;
    }

    const entry = searchEntries[0]!;
    const userDn = entry.dn;

    await client.unbind();

    const userClient = new Client(buildClientOptions(config));
    try {
      await userClient.bind(userDn, password);
    } catch {
      authLog.debug({ username }, 'LDAP user bind failed');
      return null;
    } finally {
      try { await userClient.unbind(); } catch { /* ignore */ }
    }

    const attrs = entry as unknown as Record<string, unknown>;
    const mappedUsername =
      extractAttribute(attrs, config.attributeMap.username) || username;
    const mappedName =
      extractAttribute(attrs, config.attributeMap.name) || username;
    const mappedEmail = extractAttribute(attrs, config.attributeMap.email);

    authLog.info(
      { username: mappedUsername },
      'LDAP authentication successful',
    );

    return {
      username: mappedUsername,
      displayName: mappedName,
      email: mappedEmail,
    };
  } catch (err) {
    authLog.error({ err, username }, 'LDAP authentication error');
    return null;
  } finally {
    try { await client.unbind(); } catch { /* ignore */ }
  }
}
