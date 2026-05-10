import crypto from 'crypto';

import type { Request } from 'express';

import { getConfigValue } from '../config-store.js';
import { isLoopbackAddress } from './web-security.js';

export const INTERNAL_API_TOKEN_HEADER = 'x-nanoclaw-internal-api-token';

let internalApiToken: string | null = null;

function readHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return String(value[0] || '').trim();
  }
  return String(value || '').trim();
}

async function resolveWebPort(): Promise<string> {
  const configuredPort = String(
    (await getConfigValue('WEB_PORT')) || '',
  ).trim();
  if (configuredPort) {
    return configuredPort;
  }
  const envPort = String(process.env.WEB_PORT || '').trim();
  return envPort || '3377';
}

export function getInternalApiToken(): string {
  if (!internalApiToken) {
    internalApiToken = crypto.randomBytes(24).toString('base64url');
  }
  return internalApiToken;
}

export async function getInternalApiBaseUrl(): Promise<string> {
  return `http://127.0.0.1:${await resolveWebPort()}`;
}

export function isAuthorizedInternalApiRequest(
  req: Pick<Request, 'headers' | 'ip' | 'socket'>,
): boolean {
  const providedToken = readHeaderValue(req.headers[INTERNAL_API_TOKEN_HEADER]);
  if (!providedToken || providedToken !== getInternalApiToken()) {
    return false;
  }

  return (
    isLoopbackAddress(req.socket?.remoteAddress) || isLoopbackAddress(req.ip)
  );
}

const INTERNAL_API_PATH_PREFIXES = [
  '/browser/',
];

export function isAuthorizedInternalBrowserApiRequest(
  req: Pick<Request, 'headers' | 'ip' | 'socket' | 'path'>,
): boolean {
  const pathAllowed = INTERNAL_API_PATH_PREFIXES.some((prefix) =>
    req.path.startsWith(prefix),
  );
  return pathAllowed && isAuthorizedInternalApiRequest(req);
}

export const __testing = {
  resetInternalApiToken(): void {
    internalApiToken = null;
  },
};
