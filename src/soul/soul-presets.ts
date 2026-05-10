import type { UserSoulRecord } from '../types.js';
import { t } from '../i18n/index.js';

export interface SoulPresetConfig {
  name: string | null;
  emoji: string | null;
  emoji_enabled: boolean;
  creature: string | null;
  vibe: string | null;
  persona_prompt: string | null;
  tone: string | null;
  extra_instructions: string | null;
  behavior_rules: string | null;
}

export interface SoulPreset {
  id: string;
  label: string;
  description: string;
  config: SoulPresetConfig;
}

export const SOUL_PRESETS: SoulPreset[] = [
  {
    id: 'default',
    label: t('soul.auto_4c6af5', {}, undefined),
    description: t('soul.auto_efff87', {}, undefined),
    config: {
      name: null,
      emoji: null,
      emoji_enabled: false,
      creature: t('soul.auto_48456b', {}, undefined),
      vibe: t('soul.auto_6efdf4', {}, undefined),
      persona_prompt:
        t('soul.auto_51c6e6', {}, undefined),
      tone: 'professional',
      extra_instructions: null,
      behavior_rules: null,
    },
  },
  {
    id: 'gentle',
    label: t('soul.auto_ab6113', {}, undefined),
    description: t('soul.auto_263aa4', {}, undefined),
    config: {
      name: 'Luna',
      emoji: '🌙',
      emoji_enabled: true,
      creature: t('soul.auto_eeae2b', {}, undefined),
      vibe: t('soul.auto_263aa4', {}, undefined),
      persona_prompt: [
        t('soul.auto_e7aca1', {}, undefined),
        t('soul.auto_ab159d', {}, undefined),
        t('soul.auto_9d0690', {}, undefined),
        t('soul.auto_c74e93', {}, undefined),
      ].join('\n'),
      tone: 'gentle',
      extra_instructions: null,
      behavior_rules: null,
    },
  },
  {
    id: 'humor',
    label: t('soul.auto_7968f4', {}, undefined),
    description: t('soul.auto_cd64f0', {}, undefined),
    config: {
      name: 'Peanut',
      emoji: '🥜',
      emoji_enabled: true,
      creature: t('soul.auto_840ecb', {}, undefined),
      vibe: t('soul.auto_11e635', {}, undefined),
      persona_prompt: [
        t('soul.auto_f11ee8', {}, undefined),
        t('soul.auto_1164ef', {}, undefined),
        t('soul.auto_eef71b', {}, undefined),
        t('soul.auto_421c58', {}, undefined),
      ].join('\n'),
      tone: 'playful',
      extra_instructions: null,
      behavior_rules: null,
    },
  },
  {
    id: 'geek',
    label: t('soul.auto_156df0', {}, undefined),
    description: t('soul.auto_c11abe', {}, undefined),
    config: {
      name: 'Neo',
      emoji: null,
      emoji_enabled: false,
      creature: t('soul.auto_d8f2a5', {}, undefined),
      vibe: t('soul.auto_991036', {}, undefined),
      persona_prompt: [
        t('soul.auto_08fbeb', {}, undefined),
        t('soul.auto_f150d8', {}, undefined),
        t('soul.auto_e03403', {}, undefined),
        t('soul.auto_5f978c', {}, undefined),
      ].join('\n'),
      tone: 'cool',
      extra_instructions: t('soul.auto_39126b', {}, undefined),
      behavior_rules: null,
    },
  },
  {
    id: 'mentor',
    label: t('soul.auto_b81294', {}, undefined),
    description: t('soul.auto_a293ef', {}, undefined),
    config: {
      name: 'Sage',
      emoji: null,
      emoji_enabled: false,
      creature: t('soul.auto_4f402e', {}, undefined),
      vibe: t('soul.auto_fef1ef', {}, undefined),
      persona_prompt: [
        t('soul.auto_18fe35', {}, undefined),
        t('soul.auto_d54d75', {}, undefined),
        t('soul.auto_9b1f91', {}, undefined),
        t('soul.auto_c1baae', {}, undefined),
      ].join('\n'),
      tone: 'academic',
      extra_instructions: t('soul.auto_3c9a87', {}, undefined),
      behavior_rules: null,
    },
  },
];

export function getSoulPreset(presetId: string): SoulPreset | undefined {
  return SOUL_PRESETS.find((p) => p.id === presetId);
}
