export interface ImRandomSource {
  randomUUID?: () => string;
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export function createImUuid(
  source: ImRandomSource = globalThis.crypto,
): string {
  if (typeof source?.randomUUID === 'function') {
    return source.randomUUID();
  }
  if (typeof source?.getRandomValues !== 'function') {
    throw new Error('Secure random source is required to create an IM UUID');
  }

  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, toHex);
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}
