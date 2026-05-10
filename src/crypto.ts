import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getEncryptionKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string. Returns base64-encoded ciphertext.
 * Falls back to returning plaintext if ENCRYPTION_KEY is not configured.
 */
export function encryptValue(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, tag, encrypted]);
  return `enc:${combined.toString('base64')}`;
}

/**
 * Decrypt a value previously encrypted with encryptValue().
 * If the value is not encrypted (no `enc:` prefix), returns as-is.
 */
export function decryptValue(stored: string): string {
  if (!stored.startsWith('enc:')) return stored;

  const key = getEncryptionKey();
  if (!key) return stored;

  const combined = Buffer.from(stored.slice(4), 'base64');
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/**
 * Mask an API key for display: show first 4 and last 4 characters.
 */
export function maskApiKey(key: string): string {
  const plain = decryptValue(key);
  if (plain.length <= 8) return '****';
  return `${plain.slice(0, 4)}${'*'.repeat(Math.max(4, Math.min(plain.length - 8, 20)))}${plain.slice(-4)}`;
}
