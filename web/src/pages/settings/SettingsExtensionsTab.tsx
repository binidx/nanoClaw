import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown } from '../../components/AppIcons';
import type {
  ExtensionInstallRecord,
  ManagedMcpServer,
  ManagedSkill,
  ManagedSkillDetail,
} from '../../app-types';
import type { ExtensionActionStatus, ExtensionCatalogPreviewEntry, ExtensionMarketplaceSourceDraft, MarketplaceCatalogGroup } from './settings-types';
import { renderBooleanField } from './settings-field-renderers';
import {
  getCollapsedSkillSummary,
  isMarketplaceSourceDraftDirty,
  parseEnvInput,
  slugifyMarketplaceSourceId,
} from './settings-helpers';

export type SettingsExtensionsTabProps = {
  extensionsMessage: string;
  savingSkillsConfig: boolean;
  savingMcpConfig: boolean;
  extensionsLoading: boolean;
  extensionActionStatus?: ExtensionActionStatus;
  marketplaceDraft: ExtensionMarketplaceSourceDraft[];
  marketplaceCatalog: ExtensionCatalogPreviewEntry[];
  marketplaceCatalogLoading: boolean;
  marketplaceCatalogMessage: string;
  groupedMarketplaceCatalog: MarketplaceCatalogGroup[];
  extensionImportDraft: {
    source: string;
    installId: string;
    name: string;
    overwrite: boolean;
  };
  setExtensionImportDraft: Dispatch<
    SetStateAction<{
      source: string;
      installId: string;
      name: string;
      overwrite: boolean;
    }>
  >;
  refreshMarketplaceCatalog: (input?: { sourceDraftKey?: string }) => Promise<void>;
  addMarketplaceSource: () => void;
  removeMarketplaceSource: (draftKey: string) => void;
  updateMarketplaceSource: (
    draftKey: string,
    updater: (source: ExtensionMarketplaceSourceDraft) => ExtensionMarketplaceSourceDraft,
  ) => void;
  handleSaveMarketplaceSources: () => Promise<void>;
  handleImportExtension: () => Promise<void>;
  pickExtensionImportDirectory: () => Promise<void>;
  installMarketplaceExtension: (input: {
    sourceId?: string;
    source?: string;
    entryName: string;
    overwrite?: boolean;
  }) => Promise<boolean>;
  extensionInstalls: ExtensionInstallRecord[];
  reconcileExtensionInstalls: () => Promise<boolean>;
  uninstallExtensionInstall: (input: { installId: string; name?: string }) => Promise<boolean>;
  mcpDraft: ManagedMcpServer[];
  normalizedMcpDraft: ManagedMcpServer[];
  mcpEnvTextById: Map<string, string>;
  mcpInstallDraft: {
    sourcePath: string;
    id: string;
    name: string;
    entryFile: string;
    overwrite: boolean;
  };
  setMcpInstallDraft: Dispatch<
    SetStateAction<{
      sourcePath: string;
      id: string;
      name: string;
      entryFile: string;
      overwrite: boolean;
    }>
  >;
  mcpJsonDraft: string;
  setMcpJsonDraft: Dispatch<SetStateAction<string>>;
  mcpLocalMessage: string;
  setMcpLocalMessage: Dispatch<SetStateAction<string>>;
  addMcpServer: () => void;
  removeMcpServer: (id: string) => void;
  updateMcpServer: (
    id: string,
    updater: (server: ManagedMcpServer) => ManagedMcpServer,
  ) => void;
  importMcpFromJson: () => void;
  handleSaveMcp: () => Promise<void>;
  handleInstallMcpFromPath: () => Promise<void>;
  pickMcpInstallDirectory: () => Promise<void>;
  managedSkills: ManagedSkill[];
  skillInstallDraft: { sourcePath: string; skillId: string; overwrite: boolean };
  setSkillInstallDraft: Dispatch<
    SetStateAction<{ sourcePath: string; skillId: string; overwrite: boolean }>
  >;
  handleInstallSkillFromPath: () => Promise<void>;
  pickSkillInstallDirectory: () => Promise<void>;
  toggleSkillEnabled: (skillId: string) => void;
  skillDetailsById: Record<string, ManagedSkillDetail | undefined>;
  skillDetailLoadingById: Record<string, boolean>;
  skillDetailErrorById: Record<string, string>;
  loadSkillDetail: (skillId: string) => Promise<void>;
  deleteCustomSkill: (skillId: string) => Promise<boolean>;
  openCommandGuideChat?: () => void;
};

export type SettingsExtensionsTabVariant = 'full' | 'mcp' | 'skills';

export function SettingsExtensionsTab(
  props: SettingsExtensionsTabProps & { variant?: SettingsExtensionsTabVariant },
) {
  const { t } = useTranslation('settings');
  const variant = props.variant ?? 'full';
  const {
    extensionsMessage,
    savingSkillsConfig,
    savingMcpConfig,
    extensionsLoading,
    extensionActionStatus,
    marketplaceDraft,
    marketplaceCatalog,
    marketplaceCatalogLoading,
    marketplaceCatalogMessage,
    groupedMarketplaceCatalog,
    extensionImportDraft,
    setExtensionImportDraft,
    refreshMarketplaceCatalog,
    addMarketplaceSource,
    removeMarketplaceSource,
    updateMarketplaceSource,
    handleSaveMarketplaceSources,
    handleImportExtension,
    pickExtensionImportDirectory,
    installMarketplaceExtension,
    extensionInstalls,
    reconcileExtensionInstalls,
    uninstallExtensionInstall,
    mcpDraft,
    normalizedMcpDraft,
    mcpEnvTextById,
    mcpInstallDraft,
    setMcpInstallDraft,
    mcpJsonDraft,
    setMcpJsonDraft,
    mcpLocalMessage,
    setMcpLocalMessage,
    addMcpServer,
    removeMcpServer,
    updateMcpServer,
    importMcpFromJson,
    handleSaveMcp,
    handleInstallMcpFromPath,
    pickMcpInstallDirectory,
    managedSkills,
    skillInstallDraft,
    setSkillInstallDraft,
    handleInstallSkillFromPath,
    pickSkillInstallDirectory,
    toggleSkillEnabled,
    skillDetailsById,
    skillDetailLoadingById,
    skillDetailErrorById,
    loadSkillDetail,
    deleteCustomSkill,
    openCommandGuideChat,
  } = props;


const renderExtensionMarketplaceSection = () => (
  <div className="settings-section extensions-panel extensions-panel-skills">
    <div className="section-header">
      <div>
        <h3>{t('settings.extensions.扩展市场')}</h3>
        <p className="settings-hint">
          {t('settings.extensions.兼容_Claude_marketplace')}
        </p>
      </div>
      <div className="modal-actions">
        <button
          type="button"
          className="btn-outline btn-sm"
          onClick={() => void refreshMarketplaceCatalog()}
          disabled={
            savingSkillsConfig ||
            marketplaceCatalogLoading ||
            extensionActionStatus?.loadingCatalog
          }
        >
          {marketplaceCatalogLoading || extensionActionStatus?.loadingCatalog
            ? t('settings.extensions.58afd9')
            : t('settings.extensions.6b7705')}
        </button>
        <button
          type="button"
          className="btn-primary btn-sm"
          onClick={addMarketplaceSource}
          disabled={savingSkillsConfig}
        >
          + {t('settings.extensions.28cb42')}
        </button>
      </div>
    </div>

    <details
      className="settings-advanced-block extensions-action-block"
      open
    >
      <summary className="settings-advanced-summary">
        <span className="settings-advanced-title">{t('settings.extensions.1ffbe4')}</span>
        <span className="settings-advanced-meta">
          GitHub / git / {t('settings.extensions.本地marketplace')}
        </span>
      </summary>
      <div className="settings-advanced-content">
        <div className="channel-instance-list extensions-skills-list">
          {marketplaceDraft.map((entry) => (
            <div
              key={entry.draftKey}
              className="channel-instance-card channel-instance-content"
            >
              <div className="extensions-meta-row">
                <span className="extensions-chip muted">
                  ID: {entry.id}
                </span>
                {!entry.persistedId ? (
                  <span className="extensions-chip warning">{t('settings.extensions.39ef65')}</span>
                ) : null}
                {isMarketplaceSourceDraftDirty(entry) ? (
                  <span className="extensions-chip warning">{t('settings.extensions.48b4cc')}</span>
                ) : (
                  <span className="extensions-chip success">{t('settings.extensions.16c65e')}</span>
                )}
                {entry.enabled === false ? (
                  <span className="extensions-chip muted">{t('settings.extensions.1c1ed9')}</span>
                ) : null}
              </div>
              <div className="channel-instance-grid">
                <div className="form-group">
                  <label>{t('settings.extensions.e4b825')}</label>
                  <input
                    value={entry.name}
                    onChange={(event) =>
                      updateMarketplaceSource(entry.draftKey, (current) => ({
                        ...current,
                        name: event.target.value,
                        id:
                          slugifyMarketplaceSourceId(event.target.value) ||
                          current.id,
                      }))
                    }
                    placeholder="official-claude"
                  />
                </div>
                <div className="form-group">
                  <label>source</label>
                  <input
                    value={entry.source}
                    onChange={(event) =>
                      updateMarketplaceSource(entry.draftKey, (current) => ({
                        ...current,
                        source: event.target.value,
                      }))
                    }
                    placeholder={t('settings.extensions.dce62b')}
                  />
                </div>
                {renderBooleanField(
                  `marketplace:${entry.draftKey}:enabled`,
                  t('settings.extensions.e98e8d'),
                  t('settings.extensions.c8d515'),
                  entry.enabled,
                  (nextValue) =>
                    updateMarketplaceSource(entry.draftKey, (current) => ({
                      ...current,
                      enabled: nextValue,
                    })),
                  savingSkillsConfig,
                )}
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-outline btn-sm"
                  onClick={() => void refreshMarketplaceCatalog({ sourceDraftKey: entry.draftKey })}
                  disabled={
                    savingSkillsConfig ||
                    marketplaceCatalogLoading ||
                    extensionActionStatus?.loadingCatalog ||
                    !entry.source.trim()
                  }
                >
                  {marketplaceCatalogLoading || extensionActionStatus?.loadingCatalog
                    ? t('settings.extensions.58afd9')
                    : t('settings.extensions.918803')}
                </button>
                <button
                  type="button"
                  className="btn-danger btn-sm"
                  onClick={() => removeMarketplaceSource(entry.draftKey)}
                  disabled={savingSkillsConfig}
                >
                  {t('settings.extensions.2f4aad')}
                </button>
              </div>
            </div>
          ))}
          {marketplaceDraft.length === 0 && (
            <div className="provider-empty">{t('settings.extensions.e435be')}</div>
          )}
        </div>
        <div className="settings-hint">
          {t('settings.extensions.92416b')}
        </div>
        <div className="modal-actions">
          <button
            className="btn-primary"
            onClick={() => void handleSaveMarketplaceSources()}
            disabled={savingSkillsConfig}
          >
            {savingSkillsConfig ? t('settings.extensions.保存中') : t('settings.extensions.auto_be5fbb')}
          </button>
        </div>
      </div>
    </details>

    <details className="settings-advanced-block extensions-action-block">
      <summary className="settings-advanced-summary">
        <span className="settings-advanced-title">{t('settings.extensions.927fc3')}</span>
        <span className="settings-advanced-meta">
          {t('settings.extensions.c5a2d1')}
        </span>
      </summary>
      <div className="settings-advanced-content">
        <div className="channel-instance-grid">
          <div className="form-group">
            <label>source *</label>
            <div className="path-picker-row">
              <input
                value={extensionImportDraft.source}
                onChange={(event) =>
                  setExtensionImportDraft((prev) => ({
                    ...prev,
                    source: event.target.value,
                  }))
                }
                placeholder={t('settings.extensions.78baaf')}
              />
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={() => void pickExtensionImportDirectory()}
                disabled={savingSkillsConfig}
              >
                {t('settings.extensions.选择目录')}
              </button>
            </div>
          </div>
          <div className="form-group">
            <label>{t('settings.extensions.9aad03')}</label>
            <input
              value={extensionImportDraft.installId}
              onChange={(event) =>
                setExtensionImportDraft((prev) => ({
                  ...prev,
                  installId: event.target.value,
                }))
              }
              placeholder="repo-review-bundle"
            />
          </div>
          <div className="form-group">
            <label>{t('settings.extensions.605e68')}</label>
            <input
              value={extensionImportDraft.name}
              onChange={(event) =>
                setExtensionImportDraft((prev) => ({
                  ...prev,
                  name: event.target.value,
                }))
              }
              placeholder="Repo Review Bundle"
            />
          </div>
        </div>
        {renderBooleanField(
          'extension-import-overwrite',
          t('settings.extensions.c4362b'),
          t('settings.extensions.2c2f1e'),
          extensionImportDraft.overwrite,
          (nextValue) =>
            setExtensionImportDraft((prev) => ({
              ...prev,
              overwrite: nextValue,
            })),
          savingSkillsConfig,
        )}
        <div className="modal-actions">
          <button
            className="btn-primary"
            onClick={() => void handleImportExtension()}
            disabled={
              savingSkillsConfig ||
              extensionActionStatus?.importing ||
              !extensionImportDraft.source.trim()
            }
          >
            {extensionActionStatus?.importing ? t('settings.extensions.fb905a') : savingSkillsConfig ? t('settings.extensions.7fc54d') : t('settings.extensions.207c6c')}
          </button>
        </div>
      </div>
    </details>

    <div className="settings-section">
      <div className="section-header">
        <div>
          <h3>{t('settings.extensions.c54c78')}</h3>
          <p className="settings-hint">
            {t('settings.extensions.0db066')}
          </p>
        </div>
      </div>
      {marketplaceCatalogMessage ? (
        <div
          className={`test-result ${/失败|错误|error|invalid|unsupported/i.test(marketplaceCatalogMessage) ? 'error' : 'success'}`}
        >
          {marketplaceCatalogMessage}
        </div>
      ) : null}
      <div className="channel-instance-list extensions-skills-list">
        {groupedMarketplaceCatalog.map((group) => (
          <div key={group.key} className="extensions-marketplace-group">
            <div className="channel-instance-summary-main">
              <div className="channel-instance-title">
                {group.title}
                {group.label ? ` · ${group.label}` : ''}
              </div>
              <div className="settings-hint">
                {group.previewMode === 'saved'
                  ? t('settings.extensions.59b356')
                  : t('settings.extensions.8ea64b')}
              </div>
              <div className="extensions-summary-text">
                {t('settings.extensions.entryCount', { count: group.entries.length })}
              </div>
            </div>
            <div className="extensions-marketplace-group-list">
              {group.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="channel-instance-card channel-instance-content"
                >
                  <div className="channel-instance-summary-main">
                    <div className="channel-instance-title">
                      {entry.title}
                      {entry.version ? ` · ${entry.version}` : ''}
                    </div>
                    <div className="settings-hint">
                      {entry.sourceName} · {entry.marketplaceName || entry.sourceLabel}
                      {!entry.installSourceId && entry.installSource ? (
                        <span className="extensions-summary-meta">
                          ({t('settings.extensions.预览')} {entry.installSource})
                        </span>
                      ) : null}
                    </div>
                    <div className="extensions-summary-text">
                      {entry.description ||
                        `skills ${entry.skillCount} · MCP ${entry.mcpCount} · agents ${entry.agentCount}`}
                    </div>
                  </div>
                  <div className="extensions-entry-meta">
                    <span
                      className={`extensions-summary-meta ${entry.installable ? 'enabled' : 'disabled'}`}
                    >
                      {entry.installSourceId ? t('settings.extensions.7e3777') : t('settings.extensions.6e3fab')}
                    </span>
                    {!entry.installable ? (
                      <span className="extensions-summary-meta disabled">
                        {t('settings.extensions.当前条目不可安装')}
                      </span>
                    ) : null}
                  </div>
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() =>
                        void installMarketplaceExtension({
                          ...(entry.installSourceId
                            ? { sourceId: entry.installSourceId }
                            : { source: entry.installSource || entry.sourceLabel }),
                          entryName: entry.entryName,
                        })
                      }
                      disabled={
                        savingSkillsConfig ||
                        extensionActionStatus?.installingEntryId ===
                          entry.entryName ||
                        !entry.installable ||
                        (!entry.installSourceId && !entry.installSource)
                      }
                    >
                      {extensionActionStatus?.installingEntryId ===
                      entry.entryName
                        ? t('settings.extensions.f1d5c1')
                        : t('settings.extensions.098981')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {marketplaceCatalog.length === 0 && (
          <div className="provider-empty">{t('settings.extensions.991664')}</div>
        )}
      </div>
    </div>

    <div className="settings-section">
      <div className="section-header">
        <div>
          <h3>{t('settings.extensions.已安装扩展')}</h3>
          <p className="settings-hint">
            {t('settings.extensions.6ed367')}
          </p>
        </div>
        <button
          type="button"
          className="btn-outline btn-sm"
          onClick={() => void reconcileExtensionInstalls()}
          disabled={savingSkillsConfig || extensionActionStatus?.reconciling}
        >
          {extensionActionStatus?.reconciling ? t('settings.extensions.4996ad') : t('settings.extensions.d75842')}
        </button>
      </div>
      <div className="channel-instance-list extensions-skills-list">
        {extensionInstalls.map((entry) => (
          <div
            key={entry.id}
            className="channel-instance-card channel-instance-content"
          >
              <div className="channel-instance-summary-main">
                <div className="channel-instance-title">
                  {entry.name}
                  {entry.version ? ` · ${entry.version}` : ''}
                </div>
                <div className="settings-hint">
                  {entry.sourceType === 'marketplace'
                    ? `${entry.marketplaceName || entry.marketplaceSource} · ${entry.marketplaceEntry || entry.id}`
                    : entry.sourceRef}
                </div>
                <div className="extensions-summary-text">
                  Skills {entry.installedSkillIds.length} · MCP{' '}
                  {entry.installedMcpServerIds.length} · Agents {entry.agentCount}
                </div>
                <div className="extensions-detail-block">
                  <div className="extensions-detail-label">{t('settings.extensions.1e4414')}</div>
                  <div className="extensions-detail-text">
                    {entry.canonicalId} ·{' '}
                    {entry.trustState === 'trusted'
                      ? t('settings.extensions.11498b')
                      : entry.trustState === 'local'
                        ? t('settings.extensions.1efe1a')
                        : t('settings.extensions.d10c91')}
                  </div>
                </div>
                <div className="extensions-detail-block">
                  <div className="extensions-detail-label">{t('settings.extensions.安装根路径')}</div>
                  <div className="extensions-detail-text">
                    {entry.resolvedSource}
                  </div>
                </div>
              {entry.warnings.length > 0 ? (
                <div className="extensions-detail-block">
                  <div className="extensions-detail-label">{t('settings.extensions.900c70')}</div>
                  <div className="extensions-detail-text">
                    {entry.warnings.map((warning) => (
                      <div
                        key={warning}
                        className={`test-result ${entry.status === 'needs_attention' ? 'error' : 'success'} extensions-warning`}
                      >
                        {warning}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="channel-instance-summary-side">
              <span
                className={`channel-instance-status ${entry.status === 'needs_attention' ? 'disabled' : 'enabled'}`}
              >
                {entry.status === 'needs_attention' ? t('settings.extensions.0cc14d') : t('settings.extensions.31ee39')}
              </span>
              <button
                type="button"
                className="btn-danger btn-sm"
                onClick={() =>
                  void uninstallExtensionInstall({
                    installId: entry.id,
                    name: entry.name,
                  })
                }
                disabled={savingSkillsConfig}
              >
                {t('settings.extensions.81824c')}
              </button>
            </div>
          </div>
        ))}
        {extensionInstalls.length === 0 && (
          <div className="provider-empty">{t('settings.extensions.16d6c8')}</div>
        )}
      </div>
    </div>
  </div>
);

const renderMcpManagementSection = () => (
  <div className="settings-section extensions-panel extensions-panel-mcp">
    <div className="section-header">
      <div>
        <h3>{t('settings.trash.MCP_服务器')}</h3>
        <p className="settings-hint">
          {t('settings.extensions.b28469')}
        </p>
      </div>
      <button
        type="button"
        className="btn-primary btn-sm"
        onClick={addMcpServer}
        disabled={savingMcpConfig}
      >
        + {t('settings.extensions.7477cd')}
      </button>
    </div>

    <details className="settings-advanced-block extensions-action-block">
      <summary className="settings-advanced-summary">
        <span className="settings-advanced-title">{t('settings.extensions.从本地路径安装_MCP')}</span>
        <span className="settings-advanced-meta">
          {t('settings.extensions.默认折叠')}
        </span>
      </summary>
      <div className="settings-advanced-content">
        <div className="channel-instance-grid">
          <div className="form-group">
            <label>sourcePath *</label>
            <div className="path-picker-row">
              <input
                value={mcpInstallDraft.sourcePath}
                onChange={(event) =>
                  setMcpInstallDraft((prev) => ({
                    ...prev,
                    sourcePath: event.target.value,
                  }))
                }
                placeholder={t('settings.extensions.5b37bc')}
              />
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={() => void pickMcpInstallDirectory()}
                disabled={savingMcpConfig}
              >
                {t('settings.extensions.选择目录')}
              </button>
            </div>
          </div>
          <div className="form-group">
            <label>{t('settings.extensions.MCP_ID_可选')}</label>
            <input
              value={mcpInstallDraft.id}
              onChange={(event) =>
                setMcpInstallDraft((prev) => ({
                  ...prev,
                  id: event.target.value,
                }))
              }
              placeholder="mysql"
            />
          </div>
          <div className="form-group">
            <label>{t('settings.extensions.605e68')}</label>
            <input
              value={mcpInstallDraft.name}
              onChange={(event) =>
                setMcpInstallDraft((prev) => ({
                  ...prev,
                  name: event.target.value,
                }))
              }
              placeholder="MySQL MCP"
            />
          </div>
          <div className="form-group">
            <label>{t('settings.extensions.entryFile_目录安装时可选')}</label>
            <input
              value={mcpInstallDraft.entryFile}
              onChange={(event) =>
                setMcpInstallDraft((prev) => ({
                  ...prev,
                  entryFile: event.target.value,
                }))
              }
              placeholder="index.mjs"
            />
          </div>
        </div>
        {renderBooleanField(
          'mcp-install-overwrite',
          t('settings.extensions.cafd7b'),
          t('settings.extensions.071361'),
          mcpInstallDraft.overwrite,
          (nextValue) =>
            setMcpInstallDraft((prev) => ({
              ...prev,
              overwrite: nextValue,
            })),
          savingMcpConfig,
        )}
        <div className="modal-actions">
          <button
            className="btn-primary"
            onClick={() => void handleInstallMcpFromPath()}
            disabled={savingMcpConfig || !mcpInstallDraft.sourcePath.trim()}
          >
            {savingMcpConfig ? t('settings.extensions.7fc54d') : t('settings.extensions.2655de')}
          </button>
        </div>
      </div>
    </details>

    <details className="settings-advanced-block extensions-action-block">
      <summary className="settings-advanced-summary">
        <span className="settings-advanced-title">{t('settings.extensions.从_JSON_导入_MCP')}</span>
        <span className="settings-advanced-meta">
          {t('settings.extensions.3dc87a')}
        </span>
      </summary>
      <div className="settings-advanced-content">
        <div className="form-group">
          <label>MCP JSON</label>
          <textarea
            rows={10}
            value={mcpJsonDraft}
            onChange={(event) => {
              setMcpJsonDraft(event.target.value);
              setMcpLocalMessage('');
            }}
            placeholder={`{
"mcpServers": {
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
    "env": {
      "ROOT": "./workspace"
    }
  }
}
}`}
          />
          <div className="settings-hint">
            {t('settings.extensions.b4ec26')}
          </div>
        </div>
        <div className="modal-actions">
          <button
            className="btn-primary"
            onClick={importMcpFromJson}
            disabled={savingMcpConfig || !mcpJsonDraft.trim()}
          >
            {t('settings.extensions.10890f')}
          </button>
        </div>
      </div>
    </details>

    {extensionsLoading && mcpDraft.length === 0 ? (
      <div className="provider-empty">{t('settings.extensions.26b5bd')}</div>
    ) : (
      <div className="channel-instance-list extensions-mcp-list">
        {normalizedMcpDraft.map((server) => {
          const commandSummary = [server.command, ...server.args]
            .filter(Boolean)
            .join(' ')
            .trim();
          const envCount = Object.keys(server.env || {}).length;
          return (
            <details
              key={server.id}
              className="channel-instance-card channel-instance-details"
              open={!server.command.trim()}
            >
              <summary className="channel-instance-summary">
                <div className="channel-instance-summary-main">
                  <div className="channel-instance-title">
                    {server.name || server.id || t('settings.extensions.c9bb24')}
                  </div>
                  <div className="settings-hint">ID: {server.id || '-'}</div>
                  <div className="extensions-summary-text">
                    {commandSummary || t('settings.extensions.dc5e7a')}
                  </div>
                </div>
                <div className="channel-instance-summary-side">
                  <span
                    className={`channel-instance-status ${server.enabled ? 'enabled' : 'disabled'}`}
                  >
                    {server.enabled ? t('settings.subagent.已启用') : t('settings.extensions.已关闭')}
                  </span>
                  <span className="extensions-summary-meta">
                    {t('settings.extensions.环境变量')} {envCount}
                  </span>
                  <span className="channel-instance-summary-icon">
                    <IconChevronDown />
                  </span>
                </div>
              </summary>
              <div className="channel-instance-content">
                <div className="channel-instance-grid">
                  <div className="form-group">
                    <label>{t('settings.extensions.e4b825')}</label>
                    <input
                      value={server.name}
                      onChange={(event) =>
                        updateMcpServer(server.id, (current) => {
                          const name = event.target.value;
                          const normalizedId =
                            name
                              .trim()
                              .toLowerCase()
                              .replace(/[^a-z0-9_-]+/g, '_')
                              .replace(/^_+|_+$/g, '') || current.id;
                          return { ...current, name, id: normalizedId };
                        })
                      }
                      placeholder="filesystem"
                    />
                  </div>
                  <div className="form-group">
                    <label>{t('settings.extensions.命令')}</label>
                    <input
                      value={server.command}
                      onChange={(event) =>
                        updateMcpServer(server.id, (current) => ({
                          ...current,
                          command: event.target.value,
                        }))
                      }
                      placeholder="npx"
                    />
                  </div>
                  <div className="form-group">
                    <label>{t('settings.extensions.参数_空格分隔')}</label>
                    <input
                      value={server.args.join(' ')}
                      onChange={(event) =>
                        updateMcpServer(server.id, (current) => ({
                          ...current,
                          args: event.target.value
                            .split(/\s+/)
                            .filter(Boolean),
                        }))
                      }
                      placeholder="-y @modelcontextprotocol/server-filesystem ./"
                    />
                  </div>
                  <div className="form-group">
                    <label>{t('settings.extensions.7b605f')}</label>
                    <textarea
                      rows={5}
                      value={mcpEnvTextById.get(server.id) || ''}
                      onChange={(event) =>
                        updateMcpServer(server.id, (current) => ({
                          ...current,
                          env: parseEnvInput(event.target.value),
                        }))
                      }
                    />
                  </div>
                  {renderBooleanField(
                    `mcp:${server.id}:enabled`,
                    t('settings.extensions.2cff3e'),
                    t('settings.extensions.fa944d'),
                    server.enabled,
                    (nextValue) =>
                      updateMcpServer(server.id, (current) => ({
                        ...current,
                        enabled: nextValue,
                      })),
                    savingMcpConfig,
                  )}
                </div>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn-danger btn-sm"
                    onClick={() => removeMcpServer(server.id)}
                    disabled={savingMcpConfig}
                  >
                    {t('settings.extensions.2f4aad')}
                  </button>
                </div>
              </div>
            </details>
          );
        })}
        {mcpDraft.length === 0 && (
          <div className="provider-empty">{t('settings.extensions.9e0aee')}</div>
        )}
      </div>
    )}

    {mcpLocalMessage ? (
      <div
        className={`test-result ${/失败|错误|无效|缺少|空的|请先输入/i.test(mcpLocalMessage) ? 'error' : 'success'}`}
      >
        {mcpLocalMessage}
      </div>
    ) : null}

    <div className="modal-actions">
      <button
        className="btn-primary"
        onClick={() => void handleSaveMcp()}
        disabled={savingMcpConfig}
      >
        {savingMcpConfig ? t('settings.extensions.保存中') : t('settings.extensions.auto_be5fbb')}
      </button>
    </div>
  </div>
);

const renderSkillsManagementSection = () => (
  <div className="settings-section extensions-panel extensions-panel-skills">
    <div className="section-header">
      <div>
        <h3>{t('settings.extensions.b0dee6')}</h3>
        <p className="settings-hint">
          {t('settings.extensions.8e6911')}
        </p>
      </div>
      {openCommandGuideChat ? (
        <button
          type="button"
          className="btn-primary btn-sm"
          onClick={openCommandGuideChat}
        >
          {t('settings.extensions.智能创建')}
        </button>
      ) : null}
    </div>

    <details className="settings-advanced-block extensions-action-block">
      <summary className="settings-advanced-summary">
        <span className="settings-advanced-title">{t('settings.extensions.从本地目录安装_Skill')}</span>
        <span className="settings-advanced-meta">
          {t('settings.extensions.294d35')}
        </span>
      </summary>
      <div className="settings-advanced-content">
        <div className="channel-instance-grid">
          <div className="form-group">
            <label>sourcePath *</label>
            <div className="path-picker-row">
              <input
                value={skillInstallDraft.sourcePath}
                onChange={(event) =>
                  setSkillInstallDraft((prev) => ({
                    ...prev,
                    sourcePath: event.target.value,
                  }))
                }
                placeholder={t('settings.extensions.afe323')}
              />
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={() => void pickSkillInstallDirectory()}
                disabled={savingSkillsConfig}
              >
                {t('settings.extensions.选择目录')}
              </button>
            </div>
          </div>
          <div className="form-group">
            <label>{t('settings.extensions.4a2326')}</label>
            <input
              value={skillInstallDraft.skillId}
              onChange={(event) =>
                setSkillInstallDraft((prev) => ({
                  ...prev,
                  skillId: event.target.value,
                }))
              }
              placeholder="skill-creator"
            />
          </div>
        </div>
        {renderBooleanField(
          'skill-install-overwrite',
          t('settings.extensions.1edabe'),
          t('settings.extensions.c0fc60'),
          skillInstallDraft.overwrite,
          (nextValue) =>
            setSkillInstallDraft((prev) => ({
              ...prev,
              overwrite: nextValue,
            })),
          savingSkillsConfig,
        )}
        <div className="modal-actions">
          <button
            className="btn-primary"
            onClick={() => void handleInstallSkillFromPath()}
            disabled={
              savingSkillsConfig || !skillInstallDraft.sourcePath.trim()
            }
          >
            {savingSkillsConfig ? t('settings.extensions.7fc54d') : t('settings.extensions.7d69ce')}
          </button>
        </div>
      </div>
    </details>

    <div className="channel-instance-list extensions-skills-list">
      {managedSkills.map((skill) => {
        const detail = skillDetailsById[skill.id];
        const loading = skillDetailLoadingById[skill.id];
        const error = skillDetailErrorById[skill.id];
        return (
          <details
            key={skill.id}
            className="channel-instance-card channel-instance-details"
            onToggle={(event) => {
              if (event.currentTarget.open) {
                void loadSkillDetail(skill.id);
              }
            }}
          >
            <summary className="channel-instance-summary">
              <div className="channel-instance-summary-main">
                <div className="channel-instance-title">
                  {skill.name || skill.id}
                </div>
                <div className="settings-hint">
                  {skill.id} ·{' '}
                  {skill.source === 'builtin' ? t('settings.extensions.auto_89e180') : t('settings.extensions.d95144')}
                </div>
                <div className="extensions-summary-text">
                  {getCollapsedSkillSummary(skill, detail)}
                </div>
              </div>
              <div className="channel-instance-summary-side">
                <span
                  className={`channel-instance-status ${skill.enabled ? 'enabled' : 'disabled'}`}
                >
                  {skill.enabled ? t('settings.subagent.已启用') : t('settings.extensions.已关闭')}
                </span>
                <span className="channel-instance-summary-icon">
                  <IconChevronDown />
                </span>
              </div>
            </summary>
            <div className="channel-instance-content">
              <div className="channel-instance-grid">
                <div className="form-group">
                  <label>Skill ID</label>
                  <input value={skill.id} disabled />
                </div>
                <div className="form-group">
                  <label>{t('settings.extensions.26ca20')}</label>
                  <input
                    value={skill.source === 'builtin' ? t('settings.extensions.auto_89e180') : t('settings.extensions.d95144')}
                    disabled
                  />
                </div>
                <div className="form-group">
                  <label>{t('settings.extensions.3bdd08')}</label>
                  <textarea
                    rows={3}
                    value={skill.description || t('settings.extensions.5b9801')}
                    disabled
                  />
                </div>
                <div className="form-group">
                  <label>{t('settings.extensions.0227c0')}</label>
                  <textarea
                    rows={3}
                    value={
                      detail?.dirPath || (loading ? t('settings.extensions.0a0a2f') : '')
                    }
                    disabled
                  />
                </div>
                {renderBooleanField(
                  `skill:${skill.id}:enabled`,
                  t('settings.extensions.75e158'),
                  t('settings.extensions.171693'),
                  skill.enabled,
                  () => toggleSkillEnabled(skill.id),
                  savingSkillsConfig,
                )}
              </div>

              {loading ? (
                <div className="settings-hint extensions-detail-block">
                  {t('settings.extensions.0a0a2f')}
                </div>
              ) : null}
              {error ? (
                <div className="test-result error">{error}</div>
              ) : null}
              {detail?.summary ? (
                <div className="extensions-detail-block">
                  <div className="extensions-detail-label">{t('settings.extensions.SKILL_摘要')}</div>
                  <div className="extensions-detail-text">
                    {detail.summary}
                  </div>
                </div>
              ) : null}

              {skill.source === 'custom' ? (
                <div className="modal-actions">
                  <button
                    className="btn-danger btn-sm"
                    onClick={() => void deleteCustomSkill(skill.id)}
                    disabled={savingSkillsConfig}
                  >
                    {t('settings.extensions.2f4aad')}
                  </button>
                </div>
              ) : null}
            </div>
          </details>
        );
      })}
      {managedSkills.length === 0 && (
        <div className="provider-empty">{t('settings.extensions.7ae434')}</div>
      )}
    </div>
  </div>
);


  const extensionsFeedback =
    extensionsMessage ? (
      <div
        className={`test-result extensions-feedback ${/失败|错误|error/i.test(extensionsMessage) ? 'error' : 'success'}`}
      >
        {extensionsMessage}
      </div>
    ) : null;

  if (variant === 'mcp') {
    return (
      <>
        {renderMcpManagementSection()}
        {extensionsFeedback}
      </>
    );
  }

  if (variant === 'skills') {
    return (
      <>
        {renderSkillsManagementSection()}
        {extensionsFeedback}
      </>
    );
  }

  return (
    <div className="extensions-layout">
      {renderExtensionMarketplaceSection()}
      {renderMcpManagementSection()}
      {renderSkillsManagementSection()}
      {extensionsFeedback}
    </div>
  );
}
