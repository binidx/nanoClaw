import { encryptValue } from '../crypto.js';

const MASKED_SECRET_PATTERN = /\*{4,}/;

export type ProviderSecretAction = 'keep' | 'rotate' | 'clear' | 'touch';

export interface ProviderSecretUpdateInput {
  currentEncryptedValue: string | null;
  rawValue?: unknown;
  action?: unknown;
}

export interface ProviderSecretUpdate {
  value: string | null;
  action: ProviderSecretAction;
  changed: boolean;
}

export function normalizeProviderSecretAction(
  raw: unknown,
): ProviderSecretAction | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (
    value === 'keep' ||
    value === 'rotate' ||
    value === 'clear' ||
    value === 'touch'
  ) {
    return value;
  }
  throw new Error('api_key_action must be one of keep, rotate, clear, touch');
}

export function resolveProviderSecretUpdate(
  input: ProviderSecretUpdateInput,
): ProviderSecretUpdate {
  const action = normalizeProviderSecretAction(input.action);
  const raw =
    typeof input.rawValue === 'string' ? input.rawValue.trim() : undefined;

  if (action === 'clear') {
    return {
      value: null,
      action: 'clear',
      changed: input.currentEncryptedValue !== null,
    };
  }

  if (action === 'touch') {
    return {
      value: input.currentEncryptedValue,
      action: 'touch',
      changed: false,
    };
  }

  if (action === 'rotate') {
    if (!raw || MASKED_SECRET_PATTERN.test(raw)) {
      throw new Error('api_key is required when api_key_action is rotate');
    }
    return {
      value: encryptValue(raw),
      action: 'rotate',
      changed: true,
    };
  }

  if (!raw || MASKED_SECRET_PATTERN.test(raw)) {
    return {
      value: input.currentEncryptedValue,
      action: 'keep',
      changed: false,
    };
  }

  return {
    value: encryptValue(raw),
    action: 'rotate',
    changed: true,
  };
}
