import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingsTab } from '../../app-types';
import { AppSelect } from '../../components/AppSelect';
import { AppsPageV2 } from '../AppsPageV2';
import {
  SettingsExtensionsTab,
  type SettingsExtensionsTabProps,
} from './SettingsExtensionsTab';
import type { SettingsPageProps } from './settings-types';
import { useSettingsPageModel } from './useSettingsPageModel';
import '../../styles/extensions.css';

const SettingsProvidersTab = lazy(async () => {
  const m = await import('./SettingsProvidersTab');
  return { default: m.SettingsProvidersTab };
});

const SettingsChannelsTab = lazy(async () => {
  const m = await import('./SettingsChannelsTab');
  return { default: m.SettingsChannelsTab };
});

const SettingsPromptTab = lazy(async () => {
  const m = await import('./SettingsPromptTab');
  return { default: m.SettingsPromptTab };
});

const SettingsGeneralTab = lazy(async () => {
  const m = await import('./SettingsGeneralTab');
  return { default: m.SettingsGeneralTab };
});

const SettingsSecurityTab = lazy(async () => {
  const m = await import('./SettingsSecurityTab');
  return { default: m.SettingsSecurityTab };
});

const SettingsDiagnosticsTab = lazy(async () => {
  const m = await import('./SettingsDiagnosticsTab');
  return { default: m.SettingsDiagnosticsTab };
});

const SettingsSubagentTab = lazy(async () => {
  const m = await import('./SettingsSubagentTab');
  return { default: m.SettingsSubagentTab };
});

const SettingsBrowserTab = lazy(async () => {
  const m = await import('./SettingsBrowserTab');
  return { default: m.SettingsBrowserTab };
});

const SettingsLive2DTab = lazy(async () => {
  const m = await import('./SettingsLive2DTab');
  return { default: m.SettingsLive2DTab };
});

const SettingsKnowledgeTab = lazy(async () => {
  const m = await import('./SettingsKnowledgeTab');
  return { default: m.SettingsKnowledgeTab };
});

const SettingsWebSearchTab = lazy(async () => {
  const m = await import('./SettingsWebSearchTab');
  return { default: m.SettingsWebSearchTab };
});

const SettingsSshKeysTab = lazy(async () => {
  const m = await import('./SettingsSshKeysTab');
  return { default: m.SettingsSshKeysTab };
});

const SettingsTrashTab = lazy(async () => {
  const m = await import('./SettingsTrashTab');
  return { default: m.SettingsTrashTab };
});

const SettingsAuditLogTab = lazy(async () => {
  const m = await import('./SettingsAuditLogTab');
  return { default: m.SettingsAuditLogTab };
});

type SettingsPageModel = ReturnType<typeof useSettingsPageModel>;

function extensionsModel(s: SettingsPageModel): SettingsExtensionsTabProps {
  return {
    extensionsMessage: s.extensionsMessage,
    savingSkillsConfig: s.savingSkillsConfig,
    savingMcpConfig: s.savingMcpConfig,
    extensionsLoading: s.extensionsLoading,
    extensionActionStatus: s.extensionActionStatus,
    marketplaceDraft: s.marketplaceDraft,
    marketplaceCatalog: s.marketplaceCatalog,
    marketplaceCatalogLoading: s.marketplaceCatalogLoading,
    marketplaceCatalogMessage: s.marketplaceCatalogMessage,
    groupedMarketplaceCatalog: s.groupedMarketplaceCatalog,
    extensionImportDraft: s.extensionImportDraft,
    setExtensionImportDraft: s.setExtensionImportDraft,
    refreshMarketplaceCatalog: s.refreshMarketplaceCatalog,
    addMarketplaceSource: s.addMarketplaceSource,
    removeMarketplaceSource: s.removeMarketplaceSource,
    updateMarketplaceSource: s.updateMarketplaceSource,
    handleSaveMarketplaceSources: s.handleSaveMarketplaceSources,
    handleImportExtension: s.handleImportExtension,
    pickExtensionImportDirectory: s.pickExtensionImportDirectory,
    installMarketplaceExtension: s.installMarketplaceExtension,
    extensionInstalls: s.extensionInstalls,
    reconcileExtensionInstalls: s.reconcileExtensionInstalls,
    uninstallExtensionInstall: s.uninstallExtensionInstall,
    mcpDraft: s.mcpDraft,
    normalizedMcpDraft: s.normalizedMcpDraft,
    mcpEnvTextById: s.mcpEnvTextById,
    mcpInstallDraft: s.mcpInstallDraft,
    setMcpInstallDraft: s.setMcpInstallDraft,
    mcpJsonDraft: s.mcpJsonDraft,
    setMcpJsonDraft: s.setMcpJsonDraft,
    mcpLocalMessage: s.mcpLocalMessage,
    setMcpLocalMessage: s.setMcpLocalMessage,
    addMcpServer: s.addMcpServer,
    removeMcpServer: s.removeMcpServer,
    updateMcpServer: s.updateMcpServer,
    importMcpFromJson: s.importMcpFromJson,
    handleSaveMcp: s.handleSaveMcp,
    handleInstallMcpFromPath: s.handleInstallMcpFromPath,
    pickMcpInstallDirectory: s.pickMcpInstallDirectory,
    managedSkills: s.managedSkills,
    skillInstallDraft: s.skillInstallDraft,
    setSkillInstallDraft: s.setSkillInstallDraft,
    handleInstallSkillFromPath: s.handleInstallSkillFromPath,
    pickSkillInstallDirectory: s.pickSkillInstallDirectory,
    toggleSkillEnabled: s.toggleSkillEnabled,
    skillDetailsById: s.skillDetailsById,
    skillDetailLoadingById: s.skillDetailLoadingById,
    skillDetailErrorById: s.skillDetailErrorById,
    loadSkillDetail: s.loadSkillDetail,
    deleteCustomSkill: s.deleteCustomSkill,
    openCommandGuideChat: s.openCommandGuideChat,
  };
}

export function SettingsPage(props: SettingsPageProps) {
  const { t } = useTranslation('settings');
  const s = useSettingsPageModel(props);
  const ext = extensionsModel(s);
  const settingsSections: Array<{
    key: SettingsTab;
    label: string;
  }> = [
    {
      key: 'providers',
      label: t('settings.page.AI_模型'),
    },
    {
      key: 'channels',
      label: t('settings.page.channels'),
    },
    {
      key: 'prompt',
      label: t('settings.page.prompt'),
    },
    {
      key: 'web-search',
      label: t('settings.page.webSearch'),
    },
    {
      key: 'general',
      label: t('settings.page.general'),
    },
    {
      key: 'knowledge',
      label: t('settings.page.知识库'),
    },
    {
      key: 'subagent',
      label: t('settings.page.子代理'),
    },
    {
      key: 'security',
      label: t('settings.page.security'),
    },
    {
      key: 'diagnostics',
      label: t('settings.page.diagnostics'),
    },
    {
      key: 'browser',
      label: t('settings.page.browser'),
    },
    {
      key: 'live2d',
      label: t('settings.page.live2d'),
    },
    {
      key: 'ssh-keys',
      label: t('settings.page.sshKeys'),
    },
    {
      key: 'trash',
      label: t('settings.page.回收站'),
    },
    {
      key: 'audit-log',
      label: t('settings.page.审计日志'),
    },
  ];
  const visibleSections = settingsSections.filter(
    (section) => !s.visibleTabs || s.visibleTabs.includes(section.key),
  );
  const currentSection =
    visibleSections.find((section) => section.key === s.settingsTab) ?? null;
  const sectionOptions = visibleSections.map((section) => ({
    value: section.key,
    label: section.label,
  }));
  const tabFallback = (
    <div className="provider-empty">{t('settings.page.loading')}</div>
  );

  return (
    <div
      className={`page-view settings-view${s.isStandaloneMaintenancePage ? ' extensions-mode' : ''}`}
    >
      <div className="page-header settings-hero">
        <div className="page-header-copy">
          <h2>{currentSection?.label || s.pageTitle}</h2>
        </div>
        {!s.hideSettingsTabs && currentSection && (
          <div className="page-header-actions settings-hero-actions">
            <AppSelect
              className="settings-module-select"
              value={currentSection.key}
              onChange={(value) => s.setSettingsTab(value as SettingsTab)}
              aria-label={t('settings.page.navigation')}
              options={sectionOptions}
              menuMatchTrigger
            />
          </div>
        )}
      </div>
      <div
        className={`page-body settings-body is-compact settings-body-full`}
      >
        <section className="settings-stage">
          <div className="settings-stage-panel settings-stage-panel--flush">
            <div className="settings-stage-body settings-stage-body--workspace">
              {s.settingsTab === 'providers' && (
                <Suspense fallback={tabFallback}>
                  <SettingsProvidersTab
                    apiBase={s.apiBase}
                    setEditingProvider={s.setEditingProvider}
                    providers={s.providers}
                    testResults={s.testResults}
                    testProvider={s.testProvider}
                    testingId={s.testingId}
                    activateProvider={s.activateProvider}
                    activateGlobalProvider={s.activateGlobalProvider}
                    clearDefaultProvider={s.clearDefaultProvider}
                    deleteProviderById={s.deleteProviderById}
                    editingProvider={s.editingProvider}
                    saveProvider={s.saveProvider}
                    renderSensitiveInput={s.renderSensitiveInput}
                    hasSystemSettings={s.hasSystemSettings}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'channels' && (
                <Suspense fallback={tabFallback}>
                  <SettingsChannelsTab
                    channelTypes={s.channelTypes}
                    channelInstances={s.channelInstances}
                    addChannelInstance={s.addChannelInstance}
                    saveChannelSettings={s.saveChannelSettings}
                    savingChannelConfig={s.savingChannelConfig}
                    channelConfigMessage={s.channelConfigMessage}
                    removeChannelInstance={s.removeChannelInstance}
                    updateChannelInstance={s.updateChannelInstance}
                    renderChannelField={s.renderChannelField}
                    canAddChannelInstance={s.canAddChannelInstance}
                    getOrderedChannelFields={s.getOrderedChannelFields}
                    isChannelMessageError={s.isChannelMessageError}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'prompt' && (
                <Suspense fallback={tabFallback}>
                  <SettingsPromptTab apiBase={s.apiBase} />
                </Suspense>
              )}

              {s.settingsTab === 'web-search' && (
                <Suspense fallback={tabFallback}>
                  <SettingsWebSearchTab
                    webSearchConfigKeys={s.webSearchConfigKeys}
                    renderBasicConfigField={s.renderBasicConfigField}
                    saveBasicSettings={s.saveBasicSettings}
                    savingBasicConfig={s.savingBasicConfig}
                    basicConfigMessage={s.basicConfigMessage}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'general' && (
                <Suspense fallback={tabFallback}>
                  <SettingsGeneralTab
                    defaultAccessPolicyRef={s.defaultAccessPolicyRef}
                    defaultDirectoryTemplateCount={
                      s.defaultDirectoryTemplateCount
                    }
                    configMeta={s.configMeta}
                    formatConfigEffectLabel={s.formatConfigEffectLabel}
                    selectedDefaultAccessPolicy={s.selectedDefaultAccessPolicy}
                    defaultAccessModeValue={s.defaultAccessModeValue}
                    defaultAllowedDirectories={s.defaultAllowedDirectories}
                    defaultDirectoryDraft={s.defaultDirectoryDraft}
                    setDefaultDirectoryDraft={s.setDefaultDirectoryDraft}
                    defaultDirectoryError={s.defaultDirectoryError}
                    addDefaultDirectory={s.addDefaultDirectory}
                    removeDefaultDirectory={s.removeDefaultDirectory}
                    chooseDefaultDirectory={s.chooseDefaultDirectory}
                    pickingDefaultDirectory={s.pickingDefaultDirectory}
                    updateConfigValue={s.updateConfigValue}
                    primaryConfigKeys={s.primaryConfigKeys}
                    saveBasicSettings={s.saveBasicSettings}
                    savingBasicConfig={s.savingBasicConfig}
                    basicConfigMessage={s.basicConfigMessage}
                    assistantNameValue={s.assistantNameValue}
                    webPortValue={s.webPortValue}
                    renderBasicConfigField={s.renderBasicConfigField}
                    DEFAULT_ACCESS_POLICY_OPTIONS={
                      s.DEFAULT_ACCESS_POLICY_OPTIONS
                    }
                  />
                </Suspense>
              )}

              {s.settingsTab === 'knowledge' && (
                <Suspense fallback={tabFallback}>
                  <SettingsKnowledgeTab
                    knowledgeConfigKeys={s.knowledgeConfigKeys}
                    memoryConfigKeys={s.memoryConfigKeys}
                    renderBasicConfigField={s.renderBasicConfigField}
                    saveBasicSettings={s.saveBasicSettings}
                    savingBasicConfig={s.savingBasicConfig}
                    basicConfigMessage={s.basicConfigMessage}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'security' && (
                <Suspense fallback={tabFallback}>
                  <SettingsSecurityTab
                    senderTrustMode={s.senderTrustMode}
                    setSenderTrustMode={s.setSenderTrustMode}
                    senderTrustAllowAll={s.senderTrustAllowAll}
                    setSenderTrustAllowAll={s.setSenderTrustAllowAll}
                    senderTrustAllowText={s.senderTrustAllowText}
                    setSenderTrustAllowText={s.setSenderTrustAllowText}
                    senderTrustLogDenied={s.senderTrustLogDenied}
                    setSenderTrustLogDenied={s.setSenderTrustLogDenied}
                    senderTrustOverridesText={s.senderTrustOverridesText}
                    setSenderTrustOverridesText={s.setSenderTrustOverridesText}
                    senderTrustOverridesError={s.senderTrustOverridesError}
                    setSenderTrustOverridesError={
                      s.setSenderTrustOverridesError
                    }
                    savingSenderTrust={s.savingSenderTrust}
                    senderTrustMessage={s.senderTrustMessage}
                    saveSenderTrust={s.saveSenderTrust}
                    isSenderTrustMessageError={s.isSenderTrustMessageError}
                    authConfigKeys={s.authConfigKeys}
                    renderBasicConfigField={s.renderBasicConfigField}
                    bashApprovalCommandDraft={s.bashApprovalCommandDraft}
                    setBashApprovalCommandDraft={s.setBashApprovalCommandDraft}
                    bashApprovalAllowlistState={s.bashApprovalAllowlistState}
                    bashApprovalAllowlistMessage={
                      s.bashApprovalAllowlistMessage
                    }
                    setBashApprovalAllowlistMessage={
                      s.setBashApprovalAllowlistMessage
                    }
                    addBashApprovalAllowRule={s.addBashApprovalAllowRule}
                    updateBashApprovalAllowlist={s.updateBashApprovalAllowlist}
                    toggleBashApprovalAllowRule={s.toggleBashApprovalAllowRule}
                    deleteBashApprovalAllowRule={s.deleteBashApprovalAllowRule}
                    saveBasicSettings={s.saveBasicSettings}
                    savingBasicConfig={s.savingBasicConfig}
                    basicConfigMessage={s.basicConfigMessage}
                    webLoginEnabled={s.webLoginEnabled}
                    basicConfig={s.basicConfig}
                    getStringValue={s.getStringValue}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'diagnostics' && (
                <Suspense fallback={tabFallback}>
                  <SettingsDiagnosticsTab
                    runtimeInfoItems={s.runtimeInfoItems}
                    memoryPromotionSummaryItems={s.memoryPromotionSummaryItems}
                    memoryPromotionActionItems={s.memoryPromotionActionItems}
                    memoryPromotionClassItems={s.memoryPromotionClassItems}
                    memorySearchSummaryItems={s.memorySearchSummaryItems}
                    memorySearchScopeItems={s.memorySearchScopeItems}
                    memorySearchSourceItems={s.memorySearchSourceItems}
                    memorySearchTopGroupItems={s.memorySearchTopGroupItems}
                    doctorSummaryItems={s.doctorSummaryItems}
                    doctorReport={s.doctorReport}
                    doctorLoading={s.doctorLoading}
                    refreshDoctorReport={s.refreshDoctorReport}
                    workspaceCleanupItems={s.workspaceCleanupItems}
                    workspaceCleanupSummary={s.workspaceCleanupSummary}
                    workspaceCleanupMessage={s.workspaceCleanupMessage}
                    scanningWorkspaces={s.scanningWorkspaces}
                    cleaningWorkspaces={s.cleaningWorkspaces}
                    refreshWorkspaceCleanupSummary={
                      s.refreshWorkspaceCleanupSummary
                    }
                    cleanupOrphanWorkspaces={s.cleanupOrphanWorkspaces}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'subagent' && (
                <Suspense fallback={tabFallback}>
                  <SettingsSubagentTab
                    subagentEnabled={s.subagentEnabled}
                    setSubagentEnabled={s.setSubagentEnabled}
                    subagentMaxDepth={s.subagentMaxDepth}
                    setSubagentMaxDepth={s.setSubagentMaxDepth}
                    subagentMaxActive={s.subagentMaxActive}
                    setSubagentMaxActive={s.setSubagentMaxActive}
                    subagentSaving={s.subagentSaving}
                    subagentMessage={s.subagentMessage}
                    subagentMessageTone={s.subagentMessageTone}
                    subagentDepthSummary={s.subagentDepthSummary}
                    subagentMaxActiveSummary={s.subagentMaxActiveSummary}
                    subagentActiveCapacityLabel={s.subagentActiveCapacityLabel}
                    subagentRuntime={s.subagentRuntime}
                    subagentRuntimeItems={s.subagentRuntimeItems}
                    subagentRuntimeActionKey={s.subagentRuntimeActionKey}
                    stopSubagentRuntime={s.stopSubagentRuntime}
                    sendSubagentRuntimeMessage={s.sendSubagentRuntimeMessage}
                    steerSubagentRuntime={s.steerSubagentRuntime}
                    saveSubagentConfig={s.saveSubagentConfig}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'browser' && (
                <Suspense fallback={tabFallback}>
                  <SettingsBrowserTab
                    apiBase={s.apiBase}
                    browserControlConfigKeys={s.browserControlConfigKeys}
                    renderBasicConfigField={s.renderBasicConfigField}
                    saveBasicSettings={s.saveBasicSettings}
                    savingBasicConfig={s.savingBasicConfig}
                    basicConfigMessage={s.basicConfigMessage}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'extensions' && (
                <Suspense fallback={tabFallback}>
                  <SettingsExtensionsTab {...ext} />
                </Suspense>
              )}

              {s.settingsTab === 'mcp' && (
                <Suspense fallback={tabFallback}>
                  <AppsPageV2
                    apiBase={s.apiBase}
                    isAdmin={s.hasSystemSettings}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'skills' && (
                <Suspense fallback={tabFallback}>
                  <AppsPageV2
                    apiBase={s.apiBase}
                    isAdmin={s.hasSystemSettings}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'live2d' && (
                <Suspense fallback={tabFallback}>
                  <SettingsLive2DTab
                    basicConfig={s.basicConfig}
                    setBasicConfig={s.setBasicConfig}
                    hasSystemSettings={s.hasSystemSettings}
                    hasLive2dManage={s.hasLive2dManage}
                  />
                </Suspense>
              )}

              {s.settingsTab === 'ssh-keys' && (
                <Suspense fallback={tabFallback}>
                  <SettingsSshKeysTab apiBase={s.apiBase} />
                </Suspense>
              )}

              {s.settingsTab === 'trash' && (
                <Suspense fallback={tabFallback}>
                  <SettingsTrashTab apiBase={s.apiBase} />
                </Suspense>
              )}

              {s.settingsTab === 'audit-log' && (
                <Suspense fallback={tabFallback}>
                  <SettingsAuditLogTab apiBase={s.apiBase} />
                </Suspense>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default SettingsPage;
