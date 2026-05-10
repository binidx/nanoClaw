import { t } from './i18n/index.js';
export type ConfigEffect = 'instant' | 'new_agent' | 'restart';
export type ConfigRisk = 'normal' | 'sensitive' | 'dangerous';
export type ChannelFieldType = 'text' | 'password' | 'select' | 'boolean';

export type ConversationCreateFieldType = 'text' | 'select';

export interface ChannelFieldOption {
  value: string;
  label: string;
}

export interface ChannelFieldDefinition {
  key: string;
  label: string;
  type: ChannelFieldType;
  required?: boolean;
  effect: ConfigEffect;
  summary: string;
  risk?: ConfigRisk;
  options?: ChannelFieldOption[];
}

export interface ChannelTypeDefinition {
  type: string;
  label: string;
  description: string;
  allowMultiple: boolean;
  runtimeInstalled?: boolean;
  webConfigurable?: boolean;
  fields: ChannelFieldDefinition[];
}

export interface ConversationCreateFieldDefinition {
  key: string;
  label: string;
  type: ConversationCreateFieldType;
  required?: boolean;
  placeholder?: string;
  summary?: string;
}

export interface ConversationCreateTargetDefinition {
  type: string;
  label: string;
  description: string;
  creatable: boolean;
  requiresConfiguredInstance: boolean;
  runtimeInstalled: boolean;
  fields: ConversationCreateFieldDefinition[];
  unavailableReason?: string;
}

const FEISHU_CHANNEL_FIELDS: ChannelFieldDefinition[] = [
  {
    key: 'appId',
    label: 'App ID',
    type: 'text',
    required: true,
    effect: 'restart',
    summary: t('config.auto_39343c', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'appSecret',
    label: 'App Secret',
    type: 'password',
    required: true,
    effect: 'restart',
    summary: t('config.auto_c4be0b', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'domain',
    label: t('config.auto_190980', {}, undefined),
    type: 'select',
    effect: 'restart',
    summary: t('config.auto_e77e0b', {}, undefined),
    options: [
      { value: 'feishu', label: 'feishu' },
      { value: 'lark', label: 'lark' },
    ],
  },
  {
    key: 'renderMode',
    label: t('config.auto_31044f', {}, undefined),
    type: 'select',
    effect: 'instant',
    summary: t('config.auto_d6877b', {}, undefined),
    options: [
      { value: 'auto', label: 'auto' },
      { value: 'text', label: 'text' },
      { value: 'card', label: 'card' },
    ],
  },
  {
    key: 'replyInThread',
    label: t('config.auto_f0e9de', {}, undefined),
    type: 'boolean',
    effect: 'instant',
    summary: t('config.auto_883a10', {}, undefined),
  },
];

const TELEGRAM_CHANNEL_FIELDS: ChannelFieldDefinition[] = [
  {
    key: 'botToken',
    label: 'Bot Token',
    type: 'password',
    required: true,
    effect: 'restart',
    summary: t('config.auto_bd68ae', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'apiBase',
    label: 'API Base URL',
    type: 'text',
    effect: 'restart',
    summary: t('config.auto_a03492', {}, undefined),
  },
];

const DISCORD_CHANNEL_FIELDS: ChannelFieldDefinition[] = [
  {
    key: 'botToken',
    label: 'Bot Token',
    type: 'password',
    required: true,
    effect: 'restart',
    summary: t('config.auto_e57f91', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'applicationId',
    label: 'Application ID',
    type: 'text',
    effect: 'restart',
    summary: t('config.auto_f0ad17', {}, undefined),
  },
];

const SLACK_CHANNEL_FIELDS: ChannelFieldDefinition[] = [
  {
    key: 'botToken',
    label: 'Bot Token',
    type: 'password',
    required: true,
    effect: 'restart',
    summary: t('config.auto_a36281', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'appToken',
    label: 'App Token',
    type: 'password',
    effect: 'restart',
    summary: t('config.auto_ce95e2', {}, undefined),
    risk: 'sensitive',
  },
];

const GMAIL_CHANNEL_FIELDS: ChannelFieldDefinition[] = [
  {
    key: 'clientId',
    label: 'Client ID',
    type: 'text',
    required: true,
    effect: 'restart',
    summary: t('config.auto_27d159', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'clientSecret',
    label: 'Client Secret',
    type: 'password',
    required: true,
    effect: 'restart',
    summary: t('config.auto_ab49b2', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'refreshToken',
    label: 'Refresh Token',
    type: 'password',
    effect: 'restart',
    summary: t('config.auto_5b5e29', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'pollIntervalSeconds',
    label: t('config.auto_496ab3', {}, undefined),
    type: 'text',
    effect: 'restart',
    summary: t('config.auto_7709bc', {}, undefined),
  },
];

const WHATSAPP_CHANNEL_FIELDS: ChannelFieldDefinition[] = [
  {
    key: 'accessToken',
    label: 'Access Token',
    type: 'password',
    required: true,
    effect: 'restart',
    summary: t('config.auto_6d57aa', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'phoneNumberId',
    label: 'Phone Number ID',
    type: 'text',
    required: true,
    effect: 'restart',
    summary: t('config.auto_e6e7aa', {}, undefined),
  },
  {
    key: 'verifyToken',
    label: 'Verify Token',
    type: 'password',
    effect: 'restart',
    summary: t('config.auto_565466', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'appSecret',
    label: 'App Secret',
    type: 'password',
    effect: 'restart',
    summary:
      t('config.auto_8a59ac', {}, undefined),
    risk: 'sensitive',
  },
  {
    key: 'graphVersion',
    label: t('config.auto_ad0e7c', {}, undefined),
    type: 'text',
    effect: 'restart',
    summary: t('config.auto_85fbea', {}, undefined),
  },
];

const CHANNEL_TYPE_DEFINITIONS: Record<string, ChannelTypeDefinition> = {
  feishu: {
    type: 'feishu',
    label: t('errors.auto_7714e5', {}, undefined),
    description:
      t('config.auto_a78f4a', {}, undefined),
    allowMultiple: true,
    runtimeInstalled: true,
    webConfigurable: true,
    fields: FEISHU_CHANNEL_FIELDS,
  },
  telegram: {
    type: 'telegram',
    label: 'Telegram',
    description: t('config.auto_e9f55a', {}, undefined),
    allowMultiple: true,
    runtimeInstalled: true,
    webConfigurable: true,
    fields: TELEGRAM_CHANNEL_FIELDS,
  },
  discord: {
    type: 'discord',
    label: 'Discord',
    description:
      t('config.auto_dcd1dc', {}, undefined),
    allowMultiple: true,
    runtimeInstalled: true,
    webConfigurable: true,
    fields: DISCORD_CHANNEL_FIELDS,
  },
  slack: {
    type: 'slack',
    label: 'Slack',
    description:
      t('config.auto_cfaa37', {}, undefined),
    allowMultiple: true,
    runtimeInstalled: true,
    webConfigurable: true,
    fields: SLACK_CHANNEL_FIELDS,
  },
  gmail: {
    type: 'gmail',
    label: 'Gmail',
    description:
      t('config.auto_f38b45', {}, undefined),
    allowMultiple: true,
    runtimeInstalled: true,
    webConfigurable: true,
    fields: GMAIL_CHANNEL_FIELDS,
  },
  whatsapp: {
    type: 'whatsapp',
    label: 'WhatsApp',
    description:
      t('config.auto_482551', {}, undefined),
    allowMultiple: true,
    runtimeInstalled: true,
    webConfigurable: true,
    fields: WHATSAPP_CHANNEL_FIELDS,
  },
};

const CONVERSATION_CREATE_TARGET_DEFINITIONS: Record<
  string,
  ConversationCreateTargetDefinition
> = {
  web: {
    type: 'web',
    label: 'Web',
    description: t('config.auto_01d767', {}, undefined),
    creatable: true,
    requiresConfiguredInstance: false,
    runtimeInstalled: true,
    fields: [
      {
        key: 'name',
        label: t('config.auto_87e2fc', {}, undefined),
        type: 'text',
        placeholder: 'New Chat',
        summary: t('config.auto_1102d4', {}, undefined),
      },
    ],
  },
  feishu: {
    type: 'feishu',
    label: t('errors.auto_7714e5', {}, undefined),
    description: t('config.auto_70f038', {}, undefined),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'chatId',
        label: 'Chat ID',
        type: 'text',
        required: true,
        placeholder: t('config.auto_a37954', {}, undefined),
        summary: t('config.auto_de91bf', {}, undefined),
      },
      {
        key: 'name',
        label: t('config.auto_fdf6f7', {}, undefined),
        type: 'text',
        placeholder: 'Feishu Chat',
        summary: t('config.auto_c1ab04', {}, undefined),
      },
    ],
  },
  telegram: {
    type: 'telegram',
    label: 'Telegram',
    description: t('config.auto_f42bb1', {}, undefined),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'chatId',
        label: 'Chat ID',
        type: 'text',
        required: true,
        placeholder: t('config.auto_aa530c', {}, undefined),
        summary: t('config.auto_fe5bd6', {}, undefined),
      },
      {
        key: 'name',
        label: t('config.auto_fdf6f7', {}, undefined),
        type: 'text',
        placeholder: 'Telegram Chat',
        summary: t('config.auto_c1ab04', {}, undefined),
      },
    ],
  },
  discord: {
    type: 'discord',
    label: 'Discord',
    description: t('config.auto_30e59e', {}, undefined),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'channelId',
        label: 'Channel ID',
        type: 'text',
        required: true,
        placeholder: 'Discord channel_id',
        summary: t('config.auto_422dc6', {}, undefined),
      },
      {
        key: 'name',
        label: t('config.auto_fdf6f7', {}, undefined),
        type: 'text',
        placeholder: 'Discord Channel',
        summary: t('config.auto_c1ab04', {}, undefined),
      },
    ],
  },
  slack: {
    type: 'slack',
    label: 'Slack',
    description: t('config.auto_6c92ad', {}, undefined),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'channelId',
        label: 'Channel ID',
        type: 'text',
        required: true,
        placeholder: 'Cxxx / Gxxx / Dxxx',
        summary: t('config.auto_b5b15f', {}, undefined),
      },
      {
        key: 'name',
        label: t('config.auto_fdf6f7', {}, undefined),
        type: 'text',
        placeholder: 'Slack Channel',
        summary: t('config.auto_c1ab04', {}, undefined),
      },
    ],
  },
  gmail: {
    type: 'gmail',
    label: 'Gmail',
    description: t('config.auto_5a2ecc', {}, undefined),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'threadId',
        label: 'Thread ID',
        type: 'text',
        required: true,
        placeholder: 'Gmail threadId',
        summary: t('config.auto_9b60a6', {}, undefined),
      },
      {
        key: 'name',
        label: t('config.auto_fdf6f7', {}, undefined),
        type: 'text',
        placeholder: 'Gmail Thread',
        summary: t('config.auto_c1ab04', {}, undefined),
      },
    ],
  },
  whatsapp: {
    type: 'whatsapp',
    label: 'WhatsApp',
    description: t('config.auto_a45b1d', {}, undefined),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'chatId',
        label: 'Chat ID',
        type: 'text',
        required: true,
        placeholder: t('config.auto_7f7d91', {}, undefined),
        summary: t('config.auto_87a52d', {}, undefined),
      },
      {
        key: 'name',
        label: t('config.auto_fdf6f7', {}, undefined),
        type: 'text',
        placeholder: 'WhatsApp Chat',
        summary: t('config.auto_c1ab04', {}, undefined),
      },
    ],
  },
};

export function getChannelTypeDefinition(
  type: string,
): ChannelTypeDefinition | undefined {
  return CHANNEL_TYPE_DEFINITIONS[type];
}

export function getChannelTypeDefinitions(): ChannelTypeDefinition[] {
  return Object.values(CHANNEL_TYPE_DEFINITIONS);
}

export function getConversationCreateTargetDefinition(
  type: string,
): ConversationCreateTargetDefinition | undefined {
  return CONVERSATION_CREATE_TARGET_DEFINITIONS[type];
}

export function getConversationCreateTargetDefinitions(): ConversationCreateTargetDefinition[] {
  return Object.values(CONVERSATION_CREATE_TARGET_DEFINITIONS);
}
