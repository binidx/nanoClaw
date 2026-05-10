import type { Dispatch, SetStateAction } from 'react';
import type { AppSelectOption } from '../../components/AppSelect';
import { AppSelect } from '../../components/AppSelect';
import { IconEye, IconEyeOff } from '../../components/AppIcons';
import { NcToggle } from '../../components/common';
import type {
  BasicConfigState,
  ChannelFieldDefinition,
  ChannelInstanceConfig,
  ConfigEffect,
  ConfigKeyMetadata,
} from '../../app-types';
import {
  getBrowserConnectionModeOptions,
  getDefaultAccessModeOptions,
  getMemorySearchScopeOptions,
  getMemoryWriteModeOptions,
  WEB_FETCH_PROVIDER_OPTIONS,
  WEB_SEARCH_PROVIDER_OPTIONS,
} from './settings-constants';
import i18n from '../../i18n/index';
import { getBooleanValue, isSensitiveKey } from './settings-helpers';

export function renderBooleanField(
  key: string,
  label: string,
  hint: string | null,
  checked: boolean,
  onChange: (checked: boolean) => void,
  disabled = false,
) {
  return (
    <div key={key} className="form-group channel-boolean-field">
      <div className="settings-boolean-row">
        <div className="settings-boolean-copy">
          <label>{label}</label>
          {hint ? <div className="settings-hint">{hint}</div> : null}
        </div>
        <div className="channel-boolean-control">
          <NcToggle checked={checked} onChange={onChange} disabled={disabled} />
        </div>
      </div>
    </div>
  );
}

export function renderSensitiveInput(
  visiblePasswords: Record<string, boolean>,
  setVisiblePasswords: Dispatch<SetStateAction<Record<string, boolean>>>,
  inputId: string,
  value: string,
  onChange: (value: string) => void,
  placeholder?: string,
  disabled = false,
) {
  const visible = visiblePasswords[inputId] === true;

  return (
    <div className="password-field">
      <input
        className="password-field-input"
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <button
        type="button"
        className={`password-visibility-indicator${visible ? ' is-visible' : ''}`}
        onClick={() =>
          setVisiblePasswords((prev) => ({
            ...prev,
            [inputId]: !prev[inputId],
          }))
        }
        aria-label={visible ? i18n.t('settings.renderers.隐藏密码') : i18n.t('settings.renderers.显示密码')}
        title={visible ? i18n.t('settings.renderers.隐藏密码') : i18n.t('settings.renderers.显示密码')}
        disabled={disabled}
      >
        {visible ? <IconEyeOff /> : <IconEye />}
      </button>
    </div>
  );
}

export type RenderBasicConfigFieldDeps = {
  basicConfig: BasicConfigState;
  configMeta: Record<string, ConfigKeyMetadata>;
  formatConfigEffectLabel: (effect: ConfigEffect) => string;
  updateConfigValue: (key: string, value: string | boolean) => void;
  webLoginEnabled: boolean;
  webSearchEnabled: boolean;
  webSearchProvider: string;
  webFetchProvider: string;
  browserConnectionMode: string;
  visiblePasswords: Record<string, boolean>;
  setVisiblePasswords: Dispatch<SetStateAction<Record<string, boolean>>>;
  siteProfilePreset: string;
  setSiteProfilePreset: (value: string) => void;
  webFetchSiteProfilePresetOptions: AppSelectOption[];
  hasBuiltinWebFetchSiteProfilePresets: boolean;
  browserSiteProfilesDraftState: {
    profiles: Array<Record<string, unknown>>;
    error: string | null;
  };
  siteProfileToolMessage: string;
  selectedSiteProfilePresetLabel: string;
  importFetchSiteProfilePreset: (replace: boolean) => void;
  validateFetchSiteProfilesDraft: () => void;
  formatFetchSiteProfilesDraft: () => void;
  clearFetchSiteProfilesDraft: () => void;
  restoreBuiltinFetchSiteProfiles: () => void;
};

export function createRenderBasicConfigField(deps: RenderBasicConfigFieldDeps) {
  const ldapEnabled = getBooleanValue(deps.basicConfig, 'LDAP_ENABLED');
  const LDAP_SUB_KEYS = new Set([
    'LDAP_URL', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD',
    'LDAP_SEARCH_BASE', 'LDAP_SEARCH_FILTER', 'LDAP_ATTRIBUTE_MAP',
    'LDAP_FALLBACK_LOCAL', 'LDAP_DEFAULT_ROLE',
  ]);

  return (key: string) => {
    const {
      basicConfig,
      configMeta,
      formatConfigEffectLabel,
      updateConfigValue,
      webLoginEnabled,
      webSearchEnabled,
      webSearchProvider,
      webFetchProvider,
      browserConnectionMode,
      visiblePasswords,
      setVisiblePasswords,
      siteProfilePreset,
      setSiteProfilePreset,
      webFetchSiteProfilePresetOptions,
      hasBuiltinWebFetchSiteProfilePresets,
      browserSiteProfilesDraftState,
      siteProfileToolMessage,
      selectedSiteProfilePresetLabel,
      importFetchSiteProfilePreset,
      validateFetchSiteProfilesDraft,
      formatFetchSiteProfilesDraft,
      clearFetchSiteProfilesDraft,
      restoreBuiltinFetchSiteProfiles,
    } = deps;
    const metadata = configMeta[key];
    const label = metadata?.label || key;
    const value = basicConfig[key];
    const disabled =
      ((key === 'WEB_LOGIN_USERNAME' || key === 'WEB_LOGIN_PASSWORD') &&
        !webLoginEnabled) ||
      (LDAP_SUB_KEYS.has(key) && !ldapEnabled);
    const isConnectBrowserMode = browserConnectionMode === 'connect';
    const browserFieldDisabled =
      ([
        'WEB_BROWSER_HEADLESS',
        'WEB_BROWSER_EXECUTABLE_PATH',
        'WEB_BROWSER_EXTRA_ARGS',
      ].includes(key) &&
        isConnectBrowserMode) ||
      (key === 'WEB_BROWSER_REMOTE_DEBUG_URL' && !isConnectBrowserMode);

    if (typeof value === 'boolean') {
      return renderBooleanField(
        key,
        label,
        metadata
          ? `${formatConfigEffectLabel(metadata.effect)} · ${metadata.summary}`
          : null,
        value,
        (nextValue) => updateConfigValue(key, nextValue),
        disabled || browserFieldDisabled,
      );
    }

    if (key === 'WEB_BROWSER_CONNECTION_MODE') {
      return (
        <div key={key} className="form-group">
          <label>{label}</label>
          {metadata ? (
            <div className="settings-hint">
              {formatConfigEffectLabel(metadata.effect)} · {metadata.summary}
            </div>
          ) : null}
          <AppSelect
            value={typeof value === 'string' ? value : 'managed'}
            onChange={(nextValue) => updateConfigValue(key, nextValue)}
            ariaLabel={label}
            options={getBrowserConnectionModeOptions(i18n.t)}
          />
        </div>
      );
    }

    if (key === 'WEB_SEARCH_PROVIDER') {
      return (
        <div key={key} className="form-group">
          <label>{label}</label>
          {metadata ? (
            <div className="settings-hint">
              {formatConfigEffectLabel(metadata.effect)} · {metadata.summary}
            </div>
          ) : null}
          <AppSelect
            value={typeof value === 'string' ? value : 'auto'}
            onChange={(nextValue) => updateConfigValue(key, nextValue)}
            ariaLabel={label}
            options={WEB_SEARCH_PROVIDER_OPTIONS}
            disabled={!webSearchEnabled}
          />
        </div>
      );
    }

    if (key === 'WEB_FETCH_PROVIDER') {
      return (
        <div key={key} className="form-group">
          <label>{label}</label>
          {metadata ? (
            <div className="settings-hint">
              {formatConfigEffectLabel(metadata.effect)} · {metadata.summary}
            </div>
          ) : null}
          <AppSelect
            value={typeof value === 'string' ? value : 'auto'}
            onChange={(nextValue) => updateConfigValue(key, nextValue)}
            ariaLabel={label}
            options={WEB_FETCH_PROVIDER_OPTIONS}
            disabled={!webSearchEnabled}
          />
        </div>
      );
    }

    if (key === 'DEFAULT_ACCESS_MODE') {
      return (
        <div key={key} className="form-group">
          <label>{label}</label>
          {metadata ? (
            <div className="settings-hint">
              {formatConfigEffectLabel(metadata.effect)} · {metadata.summary}
            </div>
          ) : null}
          <AppSelect
            value={typeof value === 'string' ? value : 'allowall'}
            onChange={(nextValue) => updateConfigValue(key, nextValue)}
            ariaLabel={label}
            options={getDefaultAccessModeOptions()}
          />
        </div>
      );
    }

    if (key === 'MEMORY_WRITE_MODE') {
      return (
        <div key={key} className="form-group">
          <label>{label}</label>
          {metadata ? (
            <div className="settings-hint">
              {formatConfigEffectLabel(metadata.effect)} · {metadata.summary}
            </div>
          ) : null}
          <AppSelect
            value={typeof value === 'string' ? value : 'daily-only'}
            onChange={(nextValue) => updateConfigValue(key, nextValue)}
            ariaLabel={label}
            options={getMemoryWriteModeOptions(i18n.t)}
          />
        </div>
      );
    }

    if (key === 'MEMORY_SEARCH_SCOPE_DEFAULT') {
      return (
        <div key={key} className="form-group">
          <label>{label}</label>
          {metadata ? (
            <div className="settings-hint">
              {formatConfigEffectLabel(metadata.effect)} · {metadata.summary}
            </div>
          ) : null}
          <AppSelect
            value={typeof value === 'string' ? value : 'group'}
            onChange={(nextValue) => updateConfigValue(key, nextValue)}
            ariaLabel={label}
            options={getMemorySearchScopeOptions(i18n.t)}
          />
        </div>
      );
    }

    if (key === 'WEB_SEARCH_ALLOWED_DOMAINS') {
      return (
        <div key={key} className="form-group">
          <label>{label}</label>
          {metadata ? (
            <div className="settings-hint">
              {formatConfigEffectLabel(metadata.effect)} · {metadata.summary}
            </div>
          ) : null}
          <textarea
            rows={5}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => updateConfigValue(key, event.target.value)}
            disabled={!webSearchEnabled}
            placeholder={'docs.example.com\napi.example.com'}
          />
        </div>
      );
    }

    if (
      key === 'WEB_SEARCH_SEARXNG_BASE_URL' ||
      key === 'WEB_SEARCH_TAVILY_API_KEY' ||
      key === 'WEB_FETCH_BROWSER_COMMAND' ||
      key === 'WEB_FETCH_BROWSER_SITE_PROFILES'
    ) {
      const shouldDisable =
        !webSearchEnabled ||
        (key === 'WEB_SEARCH_SEARXNG_BASE_URL' &&
          !['auto', 'searxng'].includes(webSearchProvider)) ||
        (key === 'WEB_SEARCH_TAVILY_API_KEY' &&
          !['auto', 'tavily'].includes(webSearchProvider)) ||
        ((key === 'WEB_FETCH_BROWSER_COMMAND' ||
          key === 'WEB_FETCH_BROWSER_SITE_PROFILES') &&
          !['auto', 'browser_cli'].includes(webFetchProvider));
      return (
        <div key={key} className="form-group">
          <label>{label}</label>
          {metadata ? (
            <div className="settings-hint">
              {formatConfigEffectLabel(metadata.effect)} · {metadata.summary}
            </div>
          ) : null}
          {isSensitiveKey(key, metadata) ? (
            renderSensitiveInput(
              visiblePasswords,
              setVisiblePasswords,
              `basic:${key}`,
              typeof value === 'string' ? value : '',
              (nextValue) => updateConfigValue(key, nextValue),
              key === 'WEB_FETCH_BROWSER_COMMAND'
                ? i18n.t('settings.renderers.可填JSON数组命令或shell模板')
                : i18n.t('settings.renderers.留空表示保持不变'),
              shouldDisable,
            )
          ) : key === 'WEB_FETCH_BROWSER_COMMAND' ||
            key === 'WEB_FETCH_BROWSER_SITE_PROFILES' ? (
            <>
              <textarea
                rows={key === 'WEB_FETCH_BROWSER_SITE_PROFILES' ? 10 : 4}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => updateConfigValue(key, event.target.value)}
                disabled={shouldDisable}
                placeholder={
                  key === 'WEB_FETCH_BROWSER_SITE_PROFILES'
                    ? '[\n  {\n    "domains": ["cloud.tencent.com"],\n    "forceProvider": "browser_cli",\n    "waitSelector": ".article",\n    "postWaitMs": 1500\n  }\n]'
                    : '["node","scripts/render-fetch.mjs","{url}"]'
                }
              />
              {key === 'WEB_FETCH_BROWSER_SITE_PROFILES' ? (
                <>
                  <div className="settings-inline-actions">
                    <div className="settings-inline-select">
                      <AppSelect
                        value={siteProfilePreset}
                        onChange={setSiteProfilePreset}
                        ariaLabel={i18n.t('settings.renderers.内置站点规则预置')}
                        options={webFetchSiteProfilePresetOptions}
                        disabled={
                          shouldDisable || !hasBuiltinWebFetchSiteProfilePresets
                        }
                      />
                    </div>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() => importFetchSiteProfilePreset(false)}
                      disabled={
                        shouldDisable ||
                        !hasBuiltinWebFetchSiteProfilePresets ||
                        !!browserSiteProfilesDraftState.error
                      }
                    >
                      {i18n.t('settings.renderers.插入')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() => importFetchSiteProfilePreset(true)}
                      disabled={
                        shouldDisable || !hasBuiltinWebFetchSiteProfilePresets
                      }
                    >
                      {i18n.t('settings.renderers.替换')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={validateFetchSiteProfilesDraft}
                      disabled={shouldDisable}
                    >
                      {i18n.t('settings.renderers.校验')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={formatFetchSiteProfilesDraft}
                      disabled={
                        shouldDisable || !!browserSiteProfilesDraftState.error
                      }
                    >
                      {i18n.t('settings.renderers.格式化')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={clearFetchSiteProfilesDraft}
                      disabled={shouldDisable}
                    >
                      {i18n.t('settings.renderers.清空')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={restoreBuiltinFetchSiteProfiles}
                      disabled={
                        shouldDisable || !hasBuiltinWebFetchSiteProfilePresets
                      }
                    >
                      {i18n.t('settings.renderers.恢复内置')}
                    </button>
                  </div>
                  <div className="settings-hint">
                    {i18n.t('settings.renderers.导入到自定义规则后_自定义规则优先于内置规则')}
                    {browserSiteProfilesDraftState.error
                      ? ` ${browserSiteProfilesDraftState.error}`
                      : ''}
                    {siteProfileToolMessage ? ` ${siteProfileToolMessage}` : ''}
                  </div>
                  <div className="settings-hint">
                    {i18n.t('settings.renderers.当前自定义规则')}{browserSiteProfilesDraftState.error
                      ? i18n.t('settings.renderers.无法统计')
                      : ` ${browserSiteProfilesDraftState.profiles.length} ${i18n.t('settings.renderers.条')}`}
                    {i18n.t('settings.renderers.当前预置选择')}{selectedSiteProfilePresetLabel}。
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <input
              type="text"
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => updateConfigValue(key, event.target.value)}
              disabled={shouldDisable || browserFieldDisabled}
            />
          )}
        </div>
      );
    }

    return (
      <div key={key} className="form-group">
        <label>{label}</label>
        {metadata ? (
          <div className="settings-hint">
            {formatConfigEffectLabel(metadata.effect)} · {metadata.summary}
          </div>
        ) : null}
        {isSensitiveKey(key, metadata) ? (
          renderSensitiveInput(
            visiblePasswords,
            setVisiblePasswords,
            `basic:${key}`,
            typeof value === 'string' ? value : '',
            (nextValue) => updateConfigValue(key, nextValue),
            key === 'WEB_LOGIN_PASSWORD'
              ? webLoginEnabled
                ? i18n.t('settings.renderers.留空表示不修改当前密码')
                : i18n.t('settings.renderers.关闭登录保护时无需填写')
              : key === 'LDAP_BIND_PASSWORD'
                ? ldapEnabled
                  ? i18n.t('settings.renderers.留空表示不修改')
                  : i18n.t('settings.renderers.未启用LDAP')
                : undefined,
            disabled || browserFieldDisabled,
          )
        ) : (
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => updateConfigValue(key, event.target.value)}
            disabled={disabled || browserFieldDisabled}
          />
        )}
      </div>
    );

  };
}

export type RenderChannelFieldDeps = {
  formatConfigEffectLabel: (effect: ConfigEffect) => string;
  updateChannelInstance: (
    id: string,
    updater: (instance: ChannelInstanceConfig) => ChannelInstanceConfig,
  ) => void;
  visiblePasswords: Record<string, boolean>;
  setVisiblePasswords: Dispatch<SetStateAction<Record<string, boolean>>>;
};

export function createRenderChannelField(deps: RenderChannelFieldDeps) {
  const {
    formatConfigEffectLabel,
    updateChannelInstance,
    visiblePasswords,
    setVisiblePasswords,
  } = deps;

  return (instance: ChannelInstanceConfig, field: ChannelFieldDefinition) => {
    const fieldValue = instance.config[field.key];

    if (field.type === 'boolean') {
      return renderBooleanField(
        field.key,
        field.label,
        `${formatConfigEffectLabel(field.effect)} · ${field.summary}`,
        fieldValue === true,
        (nextValue) =>
          updateChannelInstance(instance.id, (current) => ({
            ...current,
            config: { ...current.config, [field.key]: nextValue },
          })),
      );
    }

    if (field.type === 'select') {
      return (
        <div key={field.key} className="form-group">
          <label>
            {field.label}
            {field.required ? ' *' : ''}
          </label>
          <div className="settings-hint">
            {formatConfigEffectLabel(field.effect)} · {field.summary}
          </div>
          <AppSelect
            value={typeof fieldValue === 'string' ? fieldValue : ''}
            onChange={(nextValue) =>
              updateChannelInstance(instance.id, (current) => ({
                ...current,
                config: { ...current.config, [field.key]: nextValue },
              }))
            }
            ariaLabel={field.label}
            options={(field.options || []).map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />
        </div>
      );
    }

    return (
      <div key={field.key} className="form-group">
        <label>
          {field.label}
          {field.required ? ' *' : ''}
        </label>
        <div className="settings-hint">
          {formatConfigEffectLabel(field.effect)} · {field.summary}
        </div>
        {field.type === 'password' || field.risk === 'sensitive' ? (
          renderSensitiveInput(
            visiblePasswords,
            setVisiblePasswords,
            `channel:${instance.id}:${field.key}`,
            typeof fieldValue === 'string' ? fieldValue : '',
            (nextValue) =>
              updateChannelInstance(instance.id, (current) => ({
                ...current,
                config: { ...current.config, [field.key]: nextValue },
              })),
            field.risk === 'sensitive' ? i18n.t('settings.renderers.已脱敏留空表示保持不变') : undefined,
          )
        ) : (
          <input
            type="text"
            value={typeof fieldValue === 'string' ? fieldValue : ''}
            onChange={(event) =>
              updateChannelInstance(instance.id, (current) => ({
                ...current,
                config: { ...current.config, [field.key]: event.target.value },
              }))
            }
          />
        )}
      </div>
    );
  };
}
