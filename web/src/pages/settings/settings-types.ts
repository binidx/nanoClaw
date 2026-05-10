import type { Dispatch, SetStateAction } from 'react';

import type {
  Assistant,
  AiProvider,
  BasicConfigState,
  BuiltinWebFetchSiteProfilePreset,
  ChannelInstanceConfig,
  ChannelTypeDefinition,
  ConfigEffect,
  ConfigKeyMetadata,
  DoctorReport,
  ExtensionCatalogEntry,
  ExtensionInstallRecord,
  ExtensionMarketplaceSource,
  ManagedMcpServer,
  ManagedSkill,
  SenderTrustConfig,
  SettingsTab,
  StatusInfo,
  SubagentRuntimeEntry,
  TestResult,
  WorkspaceCleanupSummary,
} from '../../app-types';

export type {
  Assistant,
  AiProvider,
  BasicConfigState,
  BuiltinWebFetchSiteProfilePreset,
  ChannelInstanceConfig,
  ChannelTypeDefinition,
  ConfigEffect,
  ConfigKeyMetadata,
  DoctorReport,
  ExtensionCatalogEntry,
  ExtensionInstallRecord,
  ExtensionMarketplaceSource,
  ManagedMcpServer,
  ManagedSkill,
  SenderTrustConfig,
  SettingsTab,
  StatusInfo,
  SubagentRuntimeEntry,
  TestResult,
  WorkspaceCleanupSummary,
} from '../../app-types';

export type SubagentRunItem = Omit<SubagentRuntimeEntry, 'id'> & {
  runId: string;
  runtimeId: string;
};

export type SubagentRunSnapshotResponse = {
  generatedAt?: string;
  activeCount: number;
  recentCount: number;
  items: SubagentRunItem[];
  nextCursor?: string | null;
};

export type ExtensionMarketplaceSourceDraft = ExtensionMarketplaceSource & {
  draftKey: string;
  persistedId?: string | null;
  persistedSource?: string | null;
  persistedEnabled?: boolean | null;
};

export type ExtensionCatalogPreviewEntry = ExtensionCatalogEntry & {
  installSourceId?: string;
  installSource?: string;
};

export type MarketplaceCatalogGroup = {
  key: string;
  title: string;
  label: string;
  previewMode: 'saved' | 'preview';
  entries: ExtensionCatalogPreviewEntry[];
};

export type ExtensionActionStatus = {
  loadingCatalog: boolean;
  installingEntryId: string | null;
  importing: boolean;
  reconciling: boolean;
};

export interface SettingsPageProps {
  apiBase: string;
  embedded?: boolean;
  focusSection?: 'default-access-policy' | null;
  onFocusHandled?: () => void;
  hideSettingsTabs?: boolean;
  pageTitle?: string;
  visibleTabs?: SettingsTab[];
  hasSystemSettings?: boolean;
  hasLive2dManage?: boolean;
  pickNativeDirectory: () => Promise<string | null>;
  setEditingProvider: Dispatch<SetStateAction<Partial<AiProvider> | null>>;
  providers: AiProvider[];
  testResults: Record<string, TestResult>;
  testProvider: (id: string) => void;
  testingId: string | null;
  activateProvider: (id: string) => void;
  activateGlobalProvider: (id: string) => void;
  clearDefaultProvider: () => void;
  deleteProviderById: (id: string) => void;
  editingProvider: Partial<AiProvider> | null;
  saveProvider: () => void;
  channelTypes: ChannelTypeDefinition[];
  channelInstances: ChannelInstanceConfig[];
  setChannelInstances: Dispatch<SetStateAction<ChannelInstanceConfig[]>>;
  addChannelInstance: (type: string) => void;
  saveChannelSettings: () => void;
  savingChannelConfig: boolean;
  channelConfigMessage: string;
  basicConfig: BasicConfigState;
  builtinWebFetchSiteProfilePresets: BuiltinWebFetchSiteProfilePreset[];
  setBasicConfig: Dispatch<SetStateAction<BasicConfigState>>;
  configMeta: Record<string, ConfigKeyMetadata>;
  formatConfigEffectLabel: (effect: ConfigEffect) => string;
  saveBasicSettings: () => void;
  savingBasicConfig: boolean;
  basicConfigMessage: string;
  workspaceCleanupSummary: WorkspaceCleanupSummary | null;
  workspaceCleanupMessage: string;
  scanningWorkspaces: boolean;
  cleaningWorkspaces: boolean;
  doctorReport: DoctorReport | null;
  doctorLoading: boolean;
  refreshDoctorReport: () => void;
  refreshWorkspaceCleanupSummary: () => void;
  cleanupOrphanWorkspaces: () => void;
  assistantName: string;
  status: StatusInfo | null;
  formatUptime: (seconds: number) => string;
  senderTrustConfig: SenderTrustConfig | null;
  saveSenderTrustConfig: (config: SenderTrustConfig) => Promise<boolean>;
  savingSenderTrust: boolean;
  senderTrustMessage: string;
  managedMcpServers: ManagedMcpServer[];
  saveManagedMcpServers: (servers: ManagedMcpServer[]) => Promise<boolean>;
  installManagedMcpFromPath: (input: {
    sourcePath: string;
    id: string;
    name: string;
    entryFile: string;
    overwrite: boolean;
  }) => Promise<boolean>;
  managedSkills: ManagedSkill[];
  extensionMarketplaceSources: ExtensionMarketplaceSource[];
  extensionInstalls: ExtensionInstallRecord[];
  saveEnabledSkills: (enabledSkillIds: string[]) => Promise<boolean>;
  installSkillFromPath: (input: {
    sourcePath: string;
    skillId: string;
    overwrite: boolean;
  }) => Promise<boolean>;
  saveExtensionMarketplaceSources: (
    sources: ExtensionMarketplaceSource[],
  ) => Promise<boolean>;
  loadExtensionMarketplaceCatalog: (input?: {
    sourceId?: string;
    source?: string;
  }) => Promise<ExtensionCatalogEntry[]>;
  installMarketplaceExtension: (input: {
    sourceId?: string;
    source?: string;
    entryName: string;
    overwrite?: boolean;
  }) => Promise<boolean>;
  importExtensionFromSource: (input: {
    source: string;
    installId?: string;
    name?: string;
    overwrite?: boolean;
  }) => Promise<boolean>;
  uninstallExtensionInstall: (input: {
    installId: string;
    name?: string;
  }) => Promise<boolean>;
  reconcileExtensionInstalls: () => Promise<boolean>;
  deleteCustomSkill: (skillId: string) => Promise<boolean>;
  openCommandGuideChat?: () => void;
  extensionActionStatus?: ExtensionActionStatus;
  extensionsLoading: boolean;
  savingMcpConfig: boolean;
  savingSkillsConfig: boolean;
  extensionsMessage: string;
  assistants: Assistant[];
}
