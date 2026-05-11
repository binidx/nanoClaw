import { Suspense, lazy, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingsTab } from '../../app-types';
import {
  IconBook,
  IconCalendar,
  IconChannel,
  IconEdit,
  IconFolder,
  IconPuzzle,
  IconSearch,
  IconSettings,
  IconStar,
  IconTerminal,
  IconUsers,
  IconWand,
  IconX,
} from '../../components/AppIcons';
import { SectionNav } from '../../components/common/SectionNav';
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
    description: string;
    icon: ReactNode;
  }> = [
    {
      key: 'providers',
      label: t('settings.page.AI_模型'),
      description: '管理模型提供商、默认模型与连接状态。',
      icon: <IconWand />,
    },
    {
      key: 'channels',
      label: t('settings.page.channels'),
      description: '配置聊天渠道实例、接入方式与可见范围。',
      icon: <IconChannel />,
    },
    {
      key: 'prompt',
      label: t('settings.page.prompt'),
      description: '统一管理系统提示词、上下文模板与预览调试。',
      icon: <IconEdit />,
    },
    {
      key: 'web-search',
      label: t('settings.page.webSearch'),
      description: '控制搜索、抓取和网页能力的默认策略。',
      icon: <IconSearch />,
    },
    {
      key: 'general',
      label: t('settings.page.general'),
      description: '调整全局运行参数、目录模板与默认权限。',
      icon: <IconSettings />,
    },
    {
      key: 'knowledge',
      label: t('settings.page.知识库'),
      description: '配置知识库、文档索引与长期记忆相关开关。',
      icon: <IconBook />,
    },
    {
      key: 'subagent',
      label: t('settings.page.子代理'),
      description: '管理子代理深度、并发容量与运行控制。',
      icon: <IconPuzzle />,
    },
    {
      key: 'security',
      label: t('settings.page.security'),
      description: '配置登录、安全边界与命令白名单。',
      icon: <IconUsers />,
    },
    {
      key: 'diagnostics',
      label: t('settings.page.diagnostics'),
      description: '查看运行健康、工作区清理与记忆诊断。',
      icon: <IconTerminal />,
    },
    {
      key: 'browser',
      label: t('settings.page.browser'),
      description: '管理浏览器自动化、连接模式与调试参数。',
      icon: <IconSearch />,
    },
    {
      key: 'live2d',
      label: t('settings.page.live2d'),
      description: '配置 Live2D 形象与对话伴随体验。',
      icon: <IconStar />,
    },
    {
      key: 'ssh-keys',
      label: t('settings.page.sshKeys'),
      description: '集中管理本机 SSH 密钥与访问入口。',
      icon: <IconFolder />,
    },
    {
      key: 'trash',
      label: t('settings.page.回收站'),
      description: '清理回收站与已删除资源。',
      icon: <IconX />,
    },
    {
      key: 'audit-log',
      label: t('settings.page.审计日志'),
      description: '查看管理员关键操作和系统审计记录。',
      icon: <IconCalendar />,
    },
  ];
  const visibleSections = settingsSections.filter(
    (section) => !s.visibleTabs || s.visibleTabs.includes(section.key),
  );
  const currentSection =
    visibleSections.find((section) => section.key === s.settingsTab) ??
    visibleSections[0] ??
    null;
  const pageSummary = s.hideSettingsTabs
    ? '集中管理当前模块的配置与运行状态。'
    : '配置 NanoClaw 的全局运行环境与安全策略。';
  const tabFallback = (
    <div className="provider-empty">{t('settings.page.loading')}</div>
  );

  return (
    <div
      className={`page-view settings-view${s.isStandaloneMaintenancePage ? ' extensions-mode' : ''}`}
    >
      <div className="page-header settings-hero">
        <div className="page-header-copy">
          <h2>{s.pageTitle}</h2>
          <p>{pageSummary}</p>
        </div>
        {!s.hideSettingsTabs && currentSection && (
          <div className="page-header-actions settings-hero-actions">
            <span className="settings-hero-chip">
              {visibleSections.length} 个模块
            </span>
            <span className="settings-hero-chip is-active">
              {currentSection.label}
            </span>
          </div>
        )}
      </div>
      <div
        className={`page-body settings-body${s.hideSettingsTabs ? ' is-compact' : ''}`}
      >
        {!s.hideSettingsTabs && visibleSections.length > 0 ? (
          <aside className="settings-rail">
            <SectionNav
              className="settings-section-nav"
              ariaLabel={t('settings.page.navigation')}
              activeKey={currentSection?.key ?? s.settingsTab}
              onChange={(key) => s.setSettingsTab(key as SettingsTab)}
              orientation="vertical"
              items={visibleSections.map((section) => ({
                key: section.key,
                label: section.label,
                icon: section.icon,
              }))}
            />
            {currentSection ? (
              <div className="settings-rail-summary">
                <div className="settings-rail-kicker">当前分类</div>
                <h3>{currentSection.label}</h3>
                <p>{currentSection.description}</p>
              </div>
            ) : null}
          </aside>
        ) : null}
        <section className="settings-stage">
          <div className="settings-stage-panel">
            {currentSection ? (
              <div className="settings-stage-header">
                <div>
                  <div className="settings-section-kicker">当前分类</div>
                  <h3>{currentSection.label}</h3>
                  <p className="settings-stage-description">
                    {currentSection.description}
                  </p>
                </div>
              </div>
            ) : null}
            <div className="settings-stage-body">
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
