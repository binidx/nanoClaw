import dns from 'dns/promises';
import net from 'net';

import { BrowserError } from './types.js';

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return a === 0;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === '::1' || normalized === '::') {
    return true;
  }
  return normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb');
}

export function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '0.0.0.0'
  ) {
    return true;
  }
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(normalized);
  }
  return false;
}

/**
 * DNS-based private IP detection: resolves a hostname and checks whether
 * any resolved address is a private/loopback IP. This catches SSRF bypasses
 * where a public hostname (e.g. evil.com) resolves to 127.0.0.1.
 */
export async function isPrivateHostnameResolved(hostname: string): Promise<boolean> {
  // Fast path: check the hostname string first
  if (isPrivateHostname(hostname)) {
    return true;
  }
  // If it's already an IP literal, no DNS needed
  if (net.isIP(hostname)) {
    return false; // already checked by isPrivateHostname above
  }
  try {
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    if (addresses.some((addr) => isPrivateIpv4(addr))) {
      return true;
    }
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    if (addresses6.some((addr) => isPrivateIpv6(addr))) {
      return true;
    }
    return false;
  } catch {
    // DNS resolution failed entirely — block conservatively
    return true;
  }
}

export function normalizeBrowserUrl(
  value: unknown,
  field = 'url',
): string {
  const text = String(value || '').trim();
  if (!text) {
    throw new BrowserError(400, `${field} is required`);
  }
  if (text === 'about:blank') {
    return text;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BrowserError(400, `${field} must be a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError(
      400,
      `${field} must use http:, https:, or about:blank`,
    );
  }

  if (isPrivateHostname(url.hostname)) {
    throw new BrowserError(
      400,
      `${field} cannot target localhost or a private network address`,
    );
  }

  return url.toString();
}
