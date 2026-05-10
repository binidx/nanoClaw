import { useCallback, type Dispatch, type SetStateAction } from 'react';

import i18n from '../i18n/index.ts';

import type {
  BasicConfigState,
  ChannelInstanceConfig,
  ChannelTypeDefinition,
  ConfigEffect,
  ConfigKeyMetadata,
} from '../app-types';

type UseSettingsActionsParams = {
  apiBase: string;
  basicConfig: BasicConfigState;
  configMeta: Record<string, ConfigKeyMetadata>;
  channelTypes: ChannelTypeDefinition[];
  channelInstances: ChannelInstanceConfig[];
  isSensitiveConfigKey: (key: string, metadata?: ConfigKeyMetadata) => boolean;
  serializeConfigValue: (value: string | boolean) => string;
  createChannelInstanceId: (type: string) => string;
  buildConfigSaveMessage: (
    effects?: Record<ConfigEffect, string[]>,
    changedKeys?: string[],
  ) => string;
  setBasicConfig: Dispatch<SetStateAction<BasicConfigState>>;
  setSavingBasicConfig: Dispatch<SetStateAction<boolean>>;
  setBasicConfigMessage: Dispatch<SetStateAction<string>>;
  setChannelInstances: Dispatch<SetStateAction<ChannelInstanceConfig[]>>;
  setSavingChannelConfig: Dispatch<SetStateAction<boolean>>;
  setChannelConfigMessage: Dispatch<SetStateAction<string>>;
  loadAuthStatus: () => Promise<void> | void;
  loadConfigMeta: () => Promise<void> | void;
  loadChannelConfig: () => Promise<void> | void;
  loadChannelConfigMeta: () => Promise<void> | void;
  loadStatus: () => Promise<void> | void;
  loadDoctorReport: () => Promise<void> | void;
};

export function useSettingsActions({
  apiBase,
  basicConfig,
  configMeta,
  channelTypes,
  channelInstances,
  isSensitiveConfigKey,
  serializeConfigValue,
  createChannelInstanceId,
  buildConfigSaveMessage,
  setBasicConfig,
  setSavingBasicConfig,
  setBasicConfigMessage,
  setChannelInstances,
  setSavingChannelConfig,
  setChannelConfigMessage,
  loadAuthStatus,
  loadConfigMeta,
  loadChannelConfig,
  loadChannelConfigMeta,
  loadStatus,
  loadDoctorReport,
}: UseSettingsActionsParams) {
  const saveBasicSettings = useCallback(async () => {
    setSavingBasicConfig(true);
    setBasicConfigMessage('');
    try {
      const payload = Object.entries(basicConfig).reduce<
        Record<string, string>
      >((acc, [key, value]) => {
        const metadata = configMeta[key];
        const serialized = serializeConfigValue(value);
        if (isSensitiveConfigKey(key, metadata) && !serialized.trim()) {
          return acc;
        }
        acc[key] = serialized;
        return acc;
      }, {});

      const res = await fetch(`${apiBase}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setBasicConfigMessage(
          buildConfigSaveMessage(data.effects, data.changedKeys),
        );
        setBasicConfig(
          (prev) =>
            Object.fromEntries(
              Object.entries(prev).map(([key, value]) => [
                key,
                isSensitiveConfigKey(key, configMeta[key]) ? '' : value,
              ]),
            ) as BasicConfigState,
        );
        void loadAuthStatus();
        void loadConfigMeta();
        void loadStatus();
        void loadDoctorReport();
      } else {
        setBasicConfigMessage(i18n.t('hooks.settingsActions.saveBasicFailedCheckInput'));
      }
    } catch {
      setBasicConfigMessage(i18n.t('hooks.settingsActions.saveBasicFailedRetry'));
    }
    setSavingBasicConfig(false);
  }, [
    apiBase,
    basicConfig,
    buildConfigSaveMessage,
    configMeta,
    isSensitiveConfigKey,
    loadAuthStatus,
    loadConfigMeta,
    loadDoctorReport,
    loadStatus,
    serializeConfigValue,
    setBasicConfig,
    setBasicConfigMessage,
    setSavingBasicConfig,
  ]);

  const addChannelInstance = useCallback(
    (type: string) => {
      const definition = channelTypes.find((entry) => entry.type === type);
      if (!definition) return;
      const existingCount = channelInstances.filter(
        (entry) => entry.type === type,
      ).length;
      setChannelInstances((prev) => [
        ...prev,
        {
          id: createChannelInstanceId(type),
          type,
          name: `${definition.label} ${existingCount + 1}`,
          enabled: true,
          visibility: 'public',
          owner_id: '__system__',
          config: Object.fromEntries(
            definition.fields.map((field) => [
              field.key,
              field.type === 'boolean'
                ? false
                : field.options?.[0]?.value || '',
            ]),
          ),
        },
      ]);
      setChannelConfigMessage('');
    },
    [
      channelInstances,
      channelTypes,
      createChannelInstanceId,
      setChannelConfigMessage,
      setChannelInstances,
    ],
  );

  const saveChannelSettings = useCallback(async () => {
    setSavingChannelConfig(true);
    setChannelConfigMessage('');
    try {
      const res = await fetch(`${apiBase}/api/channel-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instances: channelInstances }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setChannelConfigMessage(data.error || i18n.t('hooks.settingsActions.saveChannelFailedCheckConfig'));
        return;
      }

      const data = await res.json().catch(() => ({}));
      setChannelConfigMessage(
        data.changed
          ? i18n.t('hooks.settingsActions.channelConfigSaved')
          : i18n.t('hooks.settingsActions.channelConfigUnchanged'),
      );
      await Promise.all([loadChannelConfig(), loadChannelConfigMeta()]);
      void loadStatus();
      void loadDoctorReport();
    } catch {
      setChannelConfigMessage(i18n.t('hooks.settingsActions.saveChannelFailedRetry'));
    } finally {
      setSavingChannelConfig(false);
    }
  }, [
    apiBase,
    channelInstances,
    loadChannelConfig,
    loadChannelConfigMeta,
    loadDoctorReport,
    loadStatus,
    setChannelConfigMessage,
    setSavingChannelConfig,
  ]);

  return {
    addChannelInstance,
    saveBasicSettings,
    saveChannelSettings,
  };
}
