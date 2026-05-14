import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';

import { AppSelect, type AppSelectOption } from '../components/AppSelect';
import { NcCheckbox, PageHeader } from '../components/common';
import { Pagination } from '../components/common/Pagination';
import type {
  AiProvider,
  Assistant,
  AssistantBindingSecretsResponse,
  AssistantConfig,
  AssistantMcpBindingSummary,
  AssistantRepoBindingSummary,
  AssistantResources,
  Conversation,
  ManagedMcpServer,
  ManagedSkill,
} from '../app-types';
import { RepositoryBindingPicker } from '../components/repository/RepositoryBindingPicker';
import '../styles/assistants.css';

const ASSISTANT_CARD_PAGE_SIZE = 12;

interface AssistantsPageProps {
  apiBase: string;
  assistants: Assistant[];
  loading: boolean;
  error?: string;
  focusAssistantId?: string | null;
  onFocusHandled?: () => void;
  providers: AiProvider[];
  managedMcpServers: ManagedMcpServer[];
  managedSkills: ManagedSkill[];
  conversations: Conversation[];
  onRefresh: () => void;
  onStartChat: (assistantId: string) => void;
  onSubmit: (
    assistantId: string | null,
    payload: {
      name: string;
      description?: string | null;
      enabled?: boolean;
      config: AssistantConfig;
      visibility?: 'private' | 'shared';
      initialRepositoryBindings?: Array<{
        repositoryId: string;
        branch?: string;
      }>;
    },
  ) => Promise<Assistant>;
  onDelete: (assistantId: string) => Promise<void>;
}

type AssistantFormState = {
  name: string;
  description: string;
  skillIds: string[];
  mcpServerIds: string[];
  kbIds: string[];
  providerId: string;
  model: string;
  ruleMode: 'append' | 'replace' | 'locked';
  systemPrompt: string;
  extraInstructions: string;
  personaRole: string;
  personaStyle: string;
  personaGuidelines: string;
  personaConstraints: string;
  enabled: boolean;
  visibility: 'private' | 'shared';
  inheritSoulConfig: boolean;
};

type AssistantBindingDraft = {
  alias: string;
  argsText: string;
  enabled: boolean;
};

type AssistantCatalogFilter =
  | 'all'
  | 'healthy'
  | 'attention'
  | 'missing_secrets'
  | 'disabled';

type AssistantDrawerView = 'resources' | 'secret' | null;
type AssistantResourceDrawerSection =
  | 'overview'
  | 'auth'
  | 'skills'
  | 'create'
  | 'bindings';

const getRuleModeOptions = (t: (key: string) => string): AppSelectOption[] => [
  { value: 'append', label: t('assistants.允许补充规则') },
  { value: 'replace', label: t('assistants.以助手规则为主') },
  { value: 'locked', label: t('assistants.严格锁定行为') },
];

const getAssistantCatalogFilterOptions = (
  t: (key: string) => string,
): AppSelectOption[] => [
  { value: 'all', label: t('assistants.全部助手') },
  { value: 'healthy', label: t('assistants.状态正常') },
  { value: 'attention', label: t('assistants.待补齐') },
  { value: 'missing_secrets', label: t('assistants.缺认证') },
  { value: 'disabled', label: t('assistants.已停用') },
];

const emptyFormState: AssistantFormState = {
  name: '',
  description: '',
  skillIds: [],
  mcpServerIds: [],
  kbIds: [],
  providerId: '',
  model: '',
  ruleMode: 'append',
  systemPrompt: '',
  extraInstructions: '',
  personaRole: '',
  personaStyle: '',
  personaGuidelines: '',
  personaConstraints: '',
  enabled: true,
  visibility: 'private',
  inheritSoulConfig: false,
};

interface AssistantTemplate {
  key: string;
  label: string;
  description: string;
  form: Partial<AssistantFormState>;
}

const getAssistantTemplates = (
  t: (key: string) => string,
): AssistantTemplate[] => [
  {
    key: 'customer-service',
    label: t('assistants.智能客服'),
    description: t('assistants.绑定知识库，回答用户问题'),
    form: {
      name: t('assistants.智能客服助手'),
      description: t('assistants.基于知识库的智能客服，回答用户常见问题'),
      personaRole: t('assistants.客服专员'),
      personaStyle: t('assistants.友好、专业、简洁'),
      personaGuidelines: t(
        'assistants.优先从知识库检索答案，无法回答时礼貌引导用户联系人工客服',
      ),
      personaConstraints: t('assistants.不编造信息，不回答与业务无关的问题'),
    },
  },
  {
    key: 'code-review',
    label: t('assistants.代码审查助手'),
    description: t('assistants.绑定代码仓库，执行代码审查'),
    form: {
      name: t('assistants.代码审查助手'),
      description: t('assistants.自动审查代码变更，识别风险和改进建议'),
      personaRole: t('assistants.高级代码审查员'),
      personaStyle: t('assistants.严谨、客观、有建设性'),
      personaGuidelines: t(
        'assistants.关注安全漏洞、性能问题、代码规范、可维护性',
      ),
      personaConstraints: t(
        'assistants.给出具体的代码行引用和修复建议，避免模糊评价',
      ),
    },
  },
  {
    key: 'dev-assistant',
    label: t('assistants.开发助手'),
    description: t('assistants.绑定仓库和 MCP，辅助日常开发'),
    form: {
      name: t('assistants.智能开发助手'),
      description: t('assistants.辅助日常开发，理解项目代码并提供技术建议'),
      personaRole: t('assistants.技术顾问'),
      personaStyle: t('assistants.技术导向、高效、注重实践'),
      personaGuidelines: t('assistants.基于项目实际代码给出建议，推荐最佳实践'),
      personaConstraints: t('assistants.保持建议的可落地性，避免过度设计'),
    },
  },
];

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function parseEnvInput(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const nextValue = trimmed.slice(equalsIndex + 1);
    if (!key) continue;
    env[key] = nextValue;
  }
  return env;
}

function envKeysToText(keys: string[]): string {
  return keys.map((key) => `${key}=`).join('\n');
}

function buildConfigFromState(state: AssistantFormState): AssistantConfig {
  return {
    skillIds: uniqueStrings(state.skillIds),
    mcpServerIds: uniqueStrings(state.mcpServerIds),
    kbIds: uniqueStrings(state.kbIds ?? []),
    rules: {
      mode: state.ruleMode,
      systemPrompt: state.systemPrompt.trim() || null,
      extraInstructions: state.extraInstructions.trim() || null,
    },
    persona: {
      role: state.personaRole.trim(),
      style: state.personaStyle.trim(),
      guidelines: state.personaGuidelines.trim(),
      constraints: state.personaConstraints.trim(),
    },
    providerId: state.providerId.trim() || null,
    model: state.model.trim() || null,
    ...(state.inheritSoulConfig ? { inheritSoulConfig: true } : {}),
  };
}

function toFormState(assistant: Assistant): AssistantFormState {
  const persona = assistant.config.persona || {
    role: '',
    style: '',
    guidelines: '',
    constraints: '',
  };
  return {
    name: assistant.name,
    description: assistant.description || '',
    skillIds: [...assistant.config.skillIds],
    mcpServerIds: [...assistant.config.mcpServerIds],
    kbIds: [...(assistant.config.kbIds || [])],
    providerId: assistant.config.providerId || '',
    model: assistant.config.model || '',
    ruleMode: assistant.config.rules.mode || 'append',
    systemPrompt: assistant.config.rules.systemPrompt || '',
    extraInstructions: assistant.config.rules.extraInstructions || '',
    personaRole: persona.role || '',
    personaStyle: persona.style || '',
    personaGuidelines: persona.guidelines || '',
    personaConstraints: persona.constraints || '',
    enabled: assistant.enabled,
    visibility: assistant.visibility || 'private',
    inheritSoulConfig: assistant.config.inheritSoulConfig === true,
  };
}

function hasAdvancedContent(state: AssistantFormState): boolean {
  return (
    state.skillIds.length > 0 ||
    state.mcpServerIds.length > 0 ||
    state.ruleMode !== 'append' ||
    Boolean(state.systemPrompt.trim()) ||
    Boolean(state.extraInstructions.trim()) ||
    Boolean(state.model.trim()) ||
    Boolean(state.providerId.trim()) ||
    state.inheritSoulConfig
  );
}

function toggleIdSelection(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

function formatBindingSourceLabel(
  source: AssistantMcpBindingSummary['source'],
  t: (key: string) => string,
): string {
  return source === 'legacy_config'
    ? t('assistants.兼容旧配置')
    : t('assistants.助手私有绑定');
}

function formatAssistantCatalogStatusLabel(
  status: AssistantCatalogFilter,
  t: (key: string) => string,
): string {
  switch (status) {
    case 'healthy':
      return t('assistants.正常');
    case 'missing_secrets':
      return t('assistants.缺认证');
    case 'disabled':
      return t('assistants.已停用');
    case 'attention':
      return t('assistants.待补齐');
    case 'all':
    default:
      return t('assistants.全部');
  }
}

function formatAssistantCatalogStatusTone(
  status: AssistantCatalogFilter,
): string {
  switch (status) {
    case 'healthy':
      return 'healthy';
    case 'missing_secrets':
      return 'missing-auth';
    case 'disabled':
      return 'disabled';
    case 'attention':
    case 'all':
    default:
      return 'attention';
  }
}

function normalizeAssistantResources(
  assistantId: string,
  payload: unknown,
): AssistantResources {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  const availableSkills = Array.isArray(record.availableSkills)
    ? record.availableSkills.filter(
        (entry): entry is AssistantResources['availableSkills'][number] =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as { id?: unknown }).id === 'string',
      )
    : [];
  const selectedSkillIds = Array.isArray(record.selectedSkillIds)
    ? record.selectedSkillIds.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : [];
  const availableMcpTemplates = Array.isArray(record.availableMcpTemplates)
    ? record.availableMcpTemplates.filter(
        (entry): entry is AssistantResources['availableMcpTemplates'][number] =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as { id?: unknown }).id === 'string',
      )
    : [];
  const mcpBindings = Array.isArray(record.mcpBindings)
    ? record.mcpBindings.filter(
        (entry): entry is AssistantMcpBindingSummary =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as { id?: unknown }).id === 'string',
      )
    : [];
  const repoBindings = Array.isArray(record.repoBindings)
    ? record.repoBindings.filter(
        (entry): entry is AssistantRepoBindingSummary =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as { id?: unknown }).id === 'string',
      )
    : [];
  return {
    assistantId:
      typeof record.assistantId === 'string' && record.assistantId.trim()
        ? record.assistantId
        : assistantId,
    availableSkills,
    selectedSkillIds,
    availableMcpTemplates,
    mcpBindings,
    repoBindings,
  };
}

function normalizeSecretsResponse(
  bindingId: string,
  payload: unknown,
): AssistantBindingSecretsResponse {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  const secretStatus =
    record.secretStatus && typeof record.secretStatus === 'object'
      ? (record.secretStatus as AssistantBindingSecretsResponse['secretStatus'])
      : { configured: false, keyCount: 0, updatedAt: null };
  return {
    bindingId:
      typeof record.bindingId === 'string' && record.bindingId.trim()
        ? record.bindingId
        : bindingId,
    secretStatus: {
      configured: Boolean(secretStatus.configured),
      keyCount:
        typeof secretStatus.keyCount === 'number' &&
        Number.isFinite(secretStatus.keyCount)
          ? secretStatus.keyCount
          : 0,
      updatedAt:
        typeof secretStatus.updatedAt === 'string' ||
        secretStatus.updatedAt === null
          ? secretStatus.updatedAt
          : null,
    },
    configuredKeys: Array.isArray(record.configuredKeys)
      ? record.configuredKeys.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  };
}

interface AvailableKnowledgeBase {
  id: string;
  name: string;
  description: string | null;
}

interface AvailableRepositoryResource {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string | null;
  visibility: string;
  enabled: boolean;
}

interface AssistantEditorPanelProps {
  title: string;
  subtitle: string;
  form: AssistantFormState;
  setForm: Dispatch<SetStateAction<AssistantFormState>>;
  showAdvanced: boolean;
  setShowAdvanced: Dispatch<SetStateAction<boolean>>;
  providerOptions: AppSelectOption[];
  enabledSkills: ManagedSkill[];
  enabledMcpServers: ManagedMcpServer[];
  availableKbs: AvailableKnowledgeBase[];
  availableRepositories?: AvailableRepositoryResource[];
  selectedRepositoryIds?: string[];
  onToggleRepository?: (id: string) => void;
  apiBase: string;
  assistantId: string | null;
  submitLabel: string;
  onSubmit: () => void | Promise<void>;
  headerActions?: ReactNode;
}

function ResourceCard(cardProps: {
  id: string;
  checked: boolean;
  name: string;
  detail: string;
  onToggle: (id: string) => void;
}) {
  return (
    <label
      className={`assistant-resource-card${cardProps.checked ? ' selected' : ''}`}
    >
      <input
        type="checkbox"
        checked={cardProps.checked}
        onChange={() => cardProps.onToggle(cardProps.id)}
      />
      <div className="assistant-resource-card-info">
        <span>{cardProps.name}</span>
        <small>{cardProps.detail}</small>
      </div>
    </label>
  );
}

function AssistantEditorPanel(props: AssistantEditorPanelProps) {
  const { t } = useTranslation('assistants');
  const {
    title,
    subtitle,
    form,
    setForm,
    showAdvanced,
    setShowAdvanced,
    providerOptions,
    enabledSkills,
    enabledMcpServers,
    availableKbs,
    availableRepositories = [],
    selectedRepositoryIds = [],
    onToggleRepository,
    assistantId: _assistantId,
    submitLabel,
    onSubmit,
    headerActions,
  } = props;

  const showResourceSection =
    enabledSkills.length > 0 ||
    enabledMcpServers.length > 0 ||
    availableKbs.length > 0 ||
    availableRepositories.length > 0 ||
    _assistantId != null;

  return (
    <section className="assistant-form">
      <div className="assistant-form-header">
        <div>
          <h3>{title}</h3>
          <p className="assistant-form-subtitle">{subtitle}</p>
        </div>
        {headerActions ? (
          <div className="assistant-form-header-actions">{headerActions}</div>
        ) : null}
      </div>

      <div className="assistant-form-sections">
        {/* ── 基础信息 ── */}
        <div className="assistant-form-section">
          <div className="assistant-section-heading">
            <div>
              <h4>{t('assistants.基础信息')}</h4>
              <p>
                {t(
                  'assistants.决定用户如何识别这个助手，以及它默认使用哪个模型入口',
                )}
              </p>
            </div>
          </div>
          <div className="assistant-form-grid">
            <label>
              {t('assistants.名称')}
              <input
                value={form.name}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, name: event.target.value }))
                }
                placeholder={t('assistants.例如：智能客服助手')}
              />
            </label>
            <label>
              {t('assistants.用途说明')}
              <input
                value={form.description}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    description: event.target.value,
                  }))
                }
                placeholder={t(
                  'assistants.例如：回答用户问题、检索知识库、生成回复建议',
                )}
              />
            </label>
            <label>
              Provider
              <AppSelect
                value={form.providerId}
                onChange={(nextValue) =>
                  setForm((prev) => ({ ...prev, providerId: nextValue }))
                }
                ariaLabel={t('assistants.助手 Provider')}
                options={providerOptions}
              />
            </label>
            <label>
              {t('assistants.模型')}
              <input
                value={form.model}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, model: event.target.value }))
                }
                placeholder={t('assistants.留空则跟随 Provider 默认模型')}
              />
            </label>
            <NcCheckbox
              className="assistant-toggle"
              checked={form.enabled}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, enabled: event.target.checked }))
              }
              label={t('assistants.启用助手')}
            />
            <NcCheckbox
              className="assistant-toggle"
              checked={form.visibility === 'shared'}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  visibility: event.target.checked ? 'shared' : 'private',
                }))
              }
              label={t('assistants.公开共享')}
            />
          </div>
        </div>

        {/* ── 人设配置 ── */}
        <div className="assistant-form-section">
          <div className="assistant-section-heading">
            <div>
              <h4>{t('assistants.人设配置')}</h4>
              <p>
                {t(
                  'assistants.定义助手的角色定位、回复风格、行为准则和约束限制',
                )}
              </p>
            </div>
          </div>
          <div className="assistant-persona-grid">
            <label className="assistant-field">
              <span>{t('assistants.角色定位')}</span>
              <textarea
                rows={2}
                value={form.personaRole}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, personaRole: e.target.value }))
                }
                placeholder={t(
                  'assistants.如：智能客服、代码审查助手、项目管理顾问',
                )}
              />
            </label>
            <label className="assistant-field">
              <span>{t('assistants.回复风格')}</span>
              <textarea
                rows={2}
                value={form.personaStyle}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, personaStyle: e.target.value }))
                }
                placeholder={t(
                  'assistants.如：专业简洁、友好亲切、严谨技术风格',
                )}
              />
            </label>
            <label className="assistant-field full">
              <span>{t('assistants.行为准则')}</span>
              <textarea
                rows={3}
                value={form.personaGuidelines}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    personaGuidelines: e.target.value,
                  }))
                }
                placeholder={t('assistants.描述助手应遵循的行为准则和工作流程')}
              />
            </label>
            <label className="assistant-field full">
              <span>{t('assistants.约束限制')}</span>
              <textarea
                rows={3}
                value={form.personaConstraints}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    personaConstraints: e.target.value,
                  }))
                }
                placeholder={t('assistants.描述助手不应做的事情或限制条件')}
              />
            </label>
          </div>
        </div>

        {/* ── 资源绑定 ── */}
        {showResourceSection ? (
          <div className="assistant-form-section">
            <div className="assistant-section-heading">
              <div>
                <h4>{t('assistants.资源绑定')}</h4>
                <p>
                  {t(
                    'assistants.为助手绑定知识库、技能和工具服务，仅展示你有权限使用的资源',
                  )}
                </p>
              </div>
            </div>
            <div className="assistant-resource-bind-section">
              {availableKbs.length > 0 ? (
                <div className="assistant-resource-bind-group">
                  <label>{t('assistants.知识库')}</label>
                  <div className="assistant-resource-bind-grid">
                    {availableKbs.map((kb) => (
                      <ResourceCard
                        key={kb.id}
                        id={kb.id}
                        checked={form.kbIds.includes(kb.id)}
                        name={kb.name}
                        detail={kb.description || kb.id}
                        onToggle={(id) =>
                          setForm((prev) => ({
                            ...prev,
                            kbIds: toggleIdSelection(prev.kbIds, id),
                          }))
                        }
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {enabledSkills.length > 0 ? (
                <div className="assistant-resource-bind-group">
                  <label>{t('assistants.技能')}</label>
                  <div className="assistant-resource-bind-grid">
                    {enabledSkills.map((skill) => (
                      <ResourceCard
                        key={skill.id}
                        id={skill.id}
                        checked={form.skillIds.includes(skill.id)}
                        name={skill.name}
                        detail={skill.description || skill.id}
                        onToggle={(id) =>
                          setForm((prev) => ({
                            ...prev,
                            skillIds: toggleIdSelection(prev.skillIds, id),
                          }))
                        }
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {enabledMcpServers.length > 0 ? (
                <div className="assistant-resource-bind-group">
                  <label>{t('assistants.服务')}</label>
                  <div className="assistant-resource-bind-grid">
                    {enabledMcpServers.map((server) => (
                      <ResourceCard
                        key={server.id}
                        id={server.id}
                        checked={form.mcpServerIds.includes(server.id)}
                        name={server.name}
                        detail={server.command || server.id}
                        onToggle={(id) =>
                          setForm((prev) => ({
                            ...prev,
                            mcpServerIds: toggleIdSelection(
                              prev.mcpServerIds,
                              id,
                            ),
                          }))
                        }
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {onToggleRepository &&
              (availableRepositories.length > 0 ||
                selectedRepositoryIds.length > 0) ? (
                <div className="assistant-resource-bind-group">
                  <label>{t('assistants.代码仓库')}</label>
                  <div className="assistant-resource-bind-grid">
                    {availableRepositories.map((repo) => (
                      <ResourceCard
                        key={repo.id}
                        id={repo.id}
                        checked={selectedRepositoryIds.includes(repo.id)}
                        name={repo.name}
                        detail={
                          repo.description || repo.defaultBranch || repo.id
                        }
                        onToggle={onToggleRepository}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ── 高级设置 ── */}
        <div className="assistant-form-section">
          <div className="assistant-form-toggle-row">
            <div>
              <h4>{t('assistants.高级设置')}</h4>
              <p className="assistant-inline-note">
                {t('assistants.规则约束、系统提示等进阶配置')}
              </p>
            </div>
            <button
              type="button"
              className="btn-outline btn-sm"
              onClick={() => setShowAdvanced((prev) => !prev)}
            >
              {showAdvanced ? t('assistants.收起') : t('assistants.展开')}
            </button>
          </div>

          {showAdvanced ? (
            <div className="assistant-advanced-content">
              <div className="assistant-form-grid">
                <label>
                  {t('assistants.规则模式')}
                  <AppSelect
                    value={form.ruleMode}
                    onChange={(nextValue) =>
                      setForm((prev) => ({
                        ...prev,
                        ruleMode: nextValue as AssistantFormState['ruleMode'],
                      }))
                    }
                    ariaLabel={t('assistants.规则模式')}
                    options={getRuleModeOptions(t)}
                  />
                </label>
              </div>
              <div className="assistant-form-grid">
                <label className="full">
                  System Prompt
                  <textarea
                    value={form.systemPrompt}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        systemPrompt: event.target.value,
                      }))
                    }
                    placeholder={t(
                      'assistants.例如：你是一名智能客服助手，优先基于知识库和对话上下文回答。',
                    )}
                  />
                </label>
                <label className="full">
                  Extra Instructions
                  <textarea
                    value={form.extraInstructions}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        extraInstructions: event.target.value,
                      }))
                    }
                    placeholder={t(
                      'assistants.例如：回复要先给结论，再给排查步骤；不确定时明确标注。',
                    )}
                  />
                </label>
              </div>
              <NcCheckbox
                checked={form.inheritSoulConfig}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    inheritSoulConfig: e.target.checked,
                  }))
                }
                label={t(
                  'assistants.继承用户灵魂配置（默认关闭，助手使用自己的人设）',
                )}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="assistant-form-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void onSubmit()}
          disabled={!form.name.trim()}
        >
          {submitLabel}
        </button>
      </div>
    </section>
  );
}

export function AssistantsPage({
  apiBase,
  assistants,
  loading,
  error,
  focusAssistantId,
  onFocusHandled,
  providers,
  managedMcpServers,
  managedSkills,
  conversations,
  onRefresh,
  onStartChat,
  onSubmit,
  onDelete,
}: AssistantsPageProps) {
  const { t } = useTranslation('assistants');
  const assistantCatalogFilterOptions = useMemo(
    () => getAssistantCatalogFilterOptions(t),
    [t],
  );
  const assistantTemplates = useMemo(() => getAssistantTemplates(t), [t]);
  const [selectedAssistantId, setSelectedAssistantId] = useState<string | null>(
    null,
  );
  const [assistantWorkbenchOpen, setAssistantWorkbenchOpen] = useState(false);
  const [detailForm, setDetailForm] = useState(emptyFormState);
  const [detailShowAdvanced, setDetailShowAdvanced] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyFormState);
  const [createShowAdvanced, setCreateShowAdvanced] = useState(false);
  const [createTemplateKey, setCreateTemplateKey] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogFilter, setCatalogFilter] =
    useState<AssistantCatalogFilter>('all');
  const [assistantCardPage, setAssistantCardPage] = useState(1);
  const [drawerView, setDrawerView] = useState<AssistantDrawerView>(null);
  const [resourceDrawerSection, setResourceDrawerSection] =
    useState<AssistantResourceDrawerSection>('overview');
  const [assistantResourcesById, setAssistantResourcesById] = useState<
    Record<string, AssistantResources | undefined>
  >({});
  const [assistantResourceLoadingId, setAssistantResourceLoadingId] = useState<
    string | null
  >(null);
  const [assistantResourceError, setAssistantResourceError] = useState('');
  const [assistantResourceMessage, setAssistantResourceMessage] = useState('');
  const [resourceSavingKey, setResourceSavingKey] = useState('');
  const [newBindingTemplateId, setNewBindingTemplateId] = useState('');
  const [newBindingAlias, setNewBindingAlias] = useState('');
  const [newBindingArgsText, setNewBindingArgsText] = useState('');
  const [bindingDraftsById, setBindingDraftsById] = useState<
    Record<string, AssistantBindingDraft>
  >({});
  const [secretModalBindingId, setSecretModalBindingId] = useState<
    string | null
  >(null);
  const [bindingSecretsById, setBindingSecretsById] = useState<
    Record<string, AssistantBindingSecretsResponse | undefined>
  >({});
  const [secretEnvDraft, setSecretEnvDraft] = useState('');
  const [secretLoading, setSecretLoading] = useState(false);
  const [secretSaving, setSecretSaving] = useState(false);
  const [secretMessage, setSecretMessage] = useState('');
  const [deletingAssistantId, setDeletingAssistantId] = useState<string | null>(
    null,
  );
  const [repoSaving, setRepoSaving] = useState(false);
  const [createRepositoryIds, setCreateRepositoryIds] = useState<string[]>([]);

  const enabledSkills = useMemo(
    () => managedSkills.filter((skill) => skill.enabled),
    [managedSkills],
  );

  const conversationCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of conversations) {
      if (c.assistantId)
        map.set(c.assistantId, (map.get(c.assistantId) ?? 0) + 1);
    }
    return map;
  }, [conversations]);
  const enabledMcpServers = useMemo(
    () => managedMcpServers.filter((server) => server.enabled),
    [managedMcpServers],
  );

  const [availableKbs, setAvailableKbs] = useState<AvailableKnowledgeBase[]>(
    [],
  );
  const [availableResourceSkills, setAvailableResourceSkills] = useState<
    ManagedSkill[]
  >([]);
  const [availableResourceMcpServers, setAvailableResourceMcpServers] =
    useState<ManagedMcpServer[]>([]);
  const [availableRepositories, setAvailableRepositories] = useState<
    AvailableRepositoryResource[]
  >([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${apiBase}/api/assistants/available-resources`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setAvailableKbs(
          Array.isArray(data.knowledgeBases)
            ? data.knowledgeBases.filter(
                (entry: unknown): entry is AvailableKnowledgeBase =>
                  !!entry &&
                  typeof entry === 'object' &&
                  typeof (entry as { id?: unknown }).id === 'string' &&
                  typeof (entry as { name?: unknown }).name === 'string',
              )
            : [],
        );
        setAvailableResourceSkills(
          Array.isArray(data.skills)
            ? data.skills
                .filter(
                  (entry: unknown): entry is ManagedSkill =>
                    !!entry &&
                    typeof entry === 'object' &&
                    typeof (entry as { id?: unknown }).id === 'string' &&
                    typeof (entry as { name?: unknown }).name === 'string',
                )
                .map((skill: ManagedSkill) => ({
                  id: skill.id,
                  name: skill.name,
                  description: skill.description,
                  source: skill.source || 'custom',
                  enabled: skill.enabled !== false,
                }))
            : [],
        );
        setAvailableResourceMcpServers(
          Array.isArray(data.mcpTemplates)
            ? data.mcpTemplates
                .filter(
                  (
                    entry: unknown,
                  ): entry is {
                    id: string;
                    name: string;
                    command?: string;
                    args?: string[];
                    enabled?: boolean;
                  } =>
                    !!entry &&
                    typeof entry === 'object' &&
                    typeof (entry as { id?: unknown }).id === 'string' &&
                    typeof (entry as { name?: unknown }).name === 'string',
                )
                .map(
                  (server: {
                    id: string;
                    name: string;
                    command?: string;
                    args?: string[];
                    enabled?: boolean;
                  }) => ({
                    id: server.id,
                    name: server.name,
                    command: server.command || '',
                    args: Array.isArray(server.args) ? server.args : [],
                    env: {},
                    enabled: server.enabled !== false,
                  }),
                )
            : [],
        );
        setAvailableRepositories(
          Array.isArray(data.repositories)
            ? data.repositories.filter(
                (entry: unknown): entry is AvailableRepositoryResource =>
                  !!entry &&
                  typeof entry === 'object' &&
                  typeof (entry as { id?: unknown }).id === 'string' &&
                  typeof (entry as { name?: unknown }).name === 'string',
              )
            : [],
        );
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);
  const selectableSkills = useMemo(
    () =>
      (availableResourceSkills.length > 0
        ? availableResourceSkills
        : enabledSkills
      ).filter((skill) => skill.enabled),
    [availableResourceSkills, enabledSkills],
  );
  const selectableMcpServers = useMemo(
    () =>
      (availableResourceMcpServers.length > 0
        ? availableResourceMcpServers
        : enabledMcpServers
      ).filter((server) => server.enabled),
    [availableResourceMcpServers, enabledMcpServers],
  );

  const providerOptions = useMemo<AppSelectOption[]>(
    () => [
      { value: '', label: t('assistants.默认 Provider') },
      ...providers
        .filter((provider) => (provider.capability || 'llm') === 'llm')
        .map((provider) => ({
          value: provider.id,
          label:
            provider.model && provider.is_default !== 1
              ? `${provider.alias} · ${provider.model}`
              : provider.alias,
        })),
    ],
    [providers],
  );

  const selectedAssistant = useMemo(
    () =>
      selectedAssistantId
        ? assistants.find(
            (assistant) => assistant.id === selectedAssistantId,
          ) || null
        : null,
    [assistants, selectedAssistantId],
  );
  const selectedResources = useMemo(
    () =>
      selectedAssistantId
        ? assistantResourcesById[selectedAssistantId] || null
        : null,
    [assistantResourcesById, selectedAssistantId],
  );
  const assistantCatalogMetaById = useMemo(() => {
    return Object.fromEntries(
      assistants.map((assistant) => {
        const resources = assistantResourcesById[assistant.id];
        const bindingCount =
          resources?.mcpBindings.length || assistant.config.mcpServerIds.length;
        const repoBindingsCount = resources?.repoBindings.length || 0;
        const fallbackCount =
          resources?.mcpBindings.filter(
            (binding) => binding.usesTemplateEnvFallback,
          ).length || 0;
        const missingSecretsCount =
          resources?.mcpBindings.filter(
            (binding) =>
              !binding.secretStatus?.configured ||
              binding.usesTemplateEnvFallback,
          ).length || 0;
        const hasAnyResource =
          bindingCount > 0 ||
          repoBindingsCount > 0 ||
          (assistant.config.kbIds?.length ?? 0) > 0 ||
          (assistant.config.skillIds?.length ?? 0) > 0;
        const status: Exclude<AssistantCatalogFilter, 'all'> =
          !assistant.enabled
            ? 'disabled'
            : missingSecretsCount > 0
              ? 'missing_secrets'
              : !hasAnyResource
                ? 'attention'
                : 'healthy';
        return [
          assistant.id,
          {
            status,
            bindingCount,
            fallbackCount,
            missingSecretsCount,
          },
        ];
      }),
    ) as Record<
      string,
      {
        status: Exclude<AssistantCatalogFilter, 'all'>;
        bindingCount: number;
        fallbackCount: number;
        missingSecretsCount: number;
      }
    >;
  }, [assistantResourcesById, assistants]);
  const filteredAssistants = useMemo(() => {
    const keyword = catalogSearch.trim().toLowerCase();
    return assistants.filter((assistant) => {
      const meta = assistantCatalogMetaById[assistant.id];
      if (catalogFilter !== 'all' && meta?.status !== catalogFilter) {
        return false;
      }
      if (!keyword) return true;
      return [assistant.name, assistant.description || '', assistant.id]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [assistantCatalogMetaById, assistants, catalogFilter, catalogSearch]);
  const enabledAssistantCount = useMemo(
    () => assistants.filter((assistant) => assistant.enabled).length,
    [assistants],
  );
  const configuredSecretCount = useMemo(
    () =>
      selectedResources?.mcpBindings.filter(
        (binding) => binding.secretStatus.configured,
      ).length || 0,
    [selectedResources?.mcpBindings],
  );
  const fallbackBindingCount = useMemo(
    () =>
      selectedResources?.mcpBindings.filter(
        (binding) => binding.usesTemplateEnvFallback,
      ).length || 0,
    [selectedResources?.mcpBindings],
  );
  const repoBindingCount = useMemo(
    () => selectedResources?.repoBindings.length || 0,
    [selectedResources?.repoBindings],
  );
  const loadAssistantResources = useCallback(
    async (assistantId: string, silent = false) => {
      if (!assistantId) return;
      if (!silent) {
        setAssistantResourceLoadingId(assistantId);
      }
      setAssistantResourceError('');
      try {
        const res = await fetch(
          `${apiBase}/api/assistants/${encodeURIComponent(assistantId)}/resources`,
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof (data as { error?: unknown }).error === 'string'
              ? (data as { error: string }).error
              : t('assistants.加载助手资源失败'),
          );
        }
        setAssistantResourcesById((prev) => ({
          ...prev,
          [assistantId]: normalizeAssistantResources(assistantId, data),
        }));
      } catch (err) {
        if (!silent) {
          setAssistantResourceError(
            err instanceof Error
              ? err.message
              : t('assistants.加载助手资源失败'),
          );
        }
      } finally {
        if (!silent) {
          setAssistantResourceLoadingId((current) =>
            current === assistantId ? null : current,
          );
        }
      }
    },
    [apiBase],
  );
  const repoBindingRequest = useCallback(
    async (
      assistantId: string,
      path: string,
      init: RequestInit,
    ): Promise<boolean> => {
      if (!assistantId) return false;
      try {
        const url = `${apiBase}/api/assistants/${encodeURIComponent(
          assistantId,
        )}/repo-bindings${path}`;
        const res = await fetch(url, init);
        if (!res.ok) return false;
        await loadAssistantResources(assistantId, true);
        return true;
      } catch {
        return false;
      }
    },
    [apiBase, loadAssistantResources],
  );

  const loadBindingSecrets = useCallback(
    async (assistantId: string, bindingId: string) => {
      setSecretLoading(true);
      setSecretMessage('');
      try {
        const res = await fetch(
          `${apiBase}/api/assistants/${encodeURIComponent(assistantId)}/mcp-bindings/${encodeURIComponent(bindingId)}/secrets`,
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof (data as { error?: unknown }).error === 'string'
              ? (data as { error: string }).error
              : t('assistants.加载认证状态失败'),
          );
        }
        const normalized = normalizeSecretsResponse(bindingId, data);
        setBindingSecretsById((prev) => ({
          ...prev,
          [bindingId]: normalized,
        }));
        setSecretEnvDraft(
          normalized.configuredKeys.length > 0
            ? envKeysToText(normalized.configuredKeys)
            : '',
        );
      } catch (err) {
        setSecretMessage(
          err instanceof Error ? err.message : t('assistants.加载认证状态失败'),
        );
      } finally {
        setSecretLoading(false);
      }
    },
    [apiBase],
  );

  useEffect(() => {
    if (!focusAssistantId || loading) return;
    const assistant = assistants.find((item) => item.id === focusAssistantId);
    if (!assistant) return;
    setSelectedAssistantId(assistant.id);
    setAssistantWorkbenchOpen(true);
    setDrawerView(null);
    onFocusHandled?.();
  }, [assistants, focusAssistantId, loading, onFocusHandled]);

  useEffect(() => {
    if (loading) return;
    if (
      selectedAssistantId &&
      assistants.some((item) => item.id === selectedAssistantId)
    ) {
      return;
    }
    setSelectedAssistantId(assistants[0]?.id || null);
  }, [assistants, loading, selectedAssistantId]);

  useEffect(() => {
    if (!selectedAssistant) {
      setDetailForm(emptyFormState);
      setDetailShowAdvanced(false);
      return;
    }
    const nextState = toFormState(selectedAssistant);
    setDetailForm(nextState);
    setDetailShowAdvanced(hasAdvancedContent(nextState));
  }, [selectedAssistant]);

  useEffect(() => {
    setDrawerView(null);
    setResourceDrawerSection('overview');
  }, [selectedAssistantId]);

  useEffect(() => {
    if (!selectedAssistantId) return;
    if (assistantResourcesById[selectedAssistantId]) return;
    void loadAssistantResources(selectedAssistantId);
  }, [assistantResourcesById, loadAssistantResources, selectedAssistantId]);

  useEffect(() => {
    if (!selectedResources) return;
    setBindingDraftsById(
      Object.fromEntries(
        selectedResources.mcpBindings.map((binding) => [
          binding.id,
          {
            alias: binding.alias || '',
            argsText: binding.args.join(' '),
            enabled: binding.enabled,
          },
        ]),
      ),
    );
    if (!newBindingTemplateId) {
      const firstEnabled = selectedResources.availableMcpTemplates.find(
        (template) => template.enabled,
      );
      setNewBindingTemplateId(
        firstEnabled?.id ||
          selectedResources.availableMcpTemplates[0]?.id ||
          '',
      );
    }
  }, [newBindingTemplateId, selectedResources]);

  const handleCreateOpen = () => {
    setCreateForm(emptyFormState);
    setCreateRepositoryIds([]);
    setCreateShowAdvanced(false);
    setCreateTemplateKey('');
    setCreateDialogOpen(true);
  };

  const handleCreateFromCurrentAssistant = () => {
    if (!selectedAssistant) return;
    const draft = {
      ...toFormState(selectedAssistant),
      name: `${selectedAssistant.name} ${t('assistants.副本')}`,
      description: selectedAssistant.description || '',
    };
    setCreateForm(draft);
    setCreateRepositoryIds([]);
    setCreateShowAdvanced(hasAdvancedContent(draft));
    setCreateDialogOpen(true);
  };

  const handleDeleteAssistant = useCallback(
    async (assistant: Assistant) => {
      if (
        !window.confirm(
          t('assistants.确定删除助手') +
            assistant.name +
            t('assistants.？已配置的私有资源绑定也会一起删除。'),
        )
      ) {
        return;
      }
      setDeletingAssistantId(assistant.id);
      try {
        await onDelete(assistant.id);
        if (selectedAssistantId === assistant.id) {
          setAssistantWorkbenchOpen(false);
          setDrawerView(null);
          setSecretModalBindingId(null);
        }
      } finally {
        setDeletingAssistantId((current) =>
          current === assistant.id ? null : current,
        );
      }
    },
    [onDelete, selectedAssistantId],
  );

  const handleCreateSubmit = async () => {
    if (!createForm.name.trim()) return;
    const initialRepositoryBindings = createRepositoryIds.map(
      (repositoryId) => {
        const repo = availableRepositories.find(
          (entry) => entry.id === repositoryId,
        );
        return {
          repositoryId,
          ...(repo?.defaultBranch ? { branch: repo.defaultBranch } : {}),
        };
      },
    );
    const createdAssistant = await onSubmit(null, {
      name: createForm.name.trim(),
      description: createForm.description.trim() || null,
      enabled: createForm.enabled,
      config: buildConfigFromState(createForm),
      visibility: createForm.visibility,
      ...(initialRepositoryBindings.length > 0
        ? { initialRepositoryBindings }
        : {}),
    });
    setCreateDialogOpen(false);
    setCreateRepositoryIds([]);
    setSelectedAssistantId(createdAssistant.id);
    setAssistantWorkbenchOpen(true);
    await loadAssistantResources(createdAssistant.id, true);
    if (createRepositoryIds.length > 0) {
      setResourceDrawerSection('overview');
      setDrawerView('resources');
    }
    if (createRepositoryIds.length > 0) {
      persistResourceMessage(t('assistants.助手和仓库绑定已创建。'));
    }
  };

  const handleDetailSubmit = async () => {
    if (!selectedAssistant || !detailForm.name.trim()) return;
    await onSubmit(selectedAssistant.id, {
      name: detailForm.name.trim(),
      description: detailForm.description.trim() || null,
      enabled: detailForm.enabled,
      config: buildConfigFromState(detailForm),
      visibility: detailForm.visibility,
    });
    await loadAssistantResources(selectedAssistant.id, true);
    setAssistantResourceMessage(t('assistants.助手权限和规则已保存。'));
  };

  const persistResourceMessage = (message: string) => {
    setAssistantResourceMessage(message);
    window.setTimeout(() => {
      setAssistantResourceMessage((current) =>
        current === message ? '' : current,
      );
    }, 2400);
  };

  const handleSkillToggle = async (skillId: string) => {
    if (!selectedAssistant || !selectedResources) return;
    const nextState = {
      ...detailForm,
      skillIds: toggleIdSelection(selectedResources.selectedSkillIds, skillId),
    };
    setResourceSavingKey(`skill:${skillId}`);
    try {
      await onSubmit(selectedAssistant.id, {
        name: nextState.name.trim(),
        description: nextState.description.trim() || null,
        enabled: nextState.enabled,
        config: buildConfigFromState(nextState),
      });
      setDetailForm(nextState);
      await loadAssistantResources(selectedAssistant.id, true);
      persistResourceMessage(t('assistants.助手 Skills 已更新。'));
    } catch (err) {
      setAssistantResourceError(
        err instanceof Error
          ? err.message
          : t('assistants.更新助手 Skills 失败'),
      );
    } finally {
      setResourceSavingKey('');
    }
  };

  const handleCreateBinding = async () => {
    if (!selectedAssistant || !newBindingTemplateId.trim()) return;
    setResourceSavingKey('binding:create');
    setAssistantResourceError('');
    try {
      const res = await fetch(
        `${apiBase}/api/assistants/${encodeURIComponent(selectedAssistant.id)}/mcp-bindings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            templateServerId: newBindingTemplateId.trim(),
            alias: newBindingAlias.trim() || undefined,
            args: parseList(newBindingArgsText),
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : t('assistants.创建 MCP 绑定失败'),
        );
      }
      setNewBindingAlias('');
      setNewBindingArgsText('');
      await loadAssistantResources(selectedAssistant.id, true);
      persistResourceMessage(t('assistants.已为当前助手新增 MCP 绑定。'));
    } catch (err) {
      setAssistantResourceError(
        err instanceof Error ? err.message : t('assistants.创建 MCP 绑定失败'),
      );
    } finally {
      setResourceSavingKey('');
    }
  };

  const handleUpdateBinding = async (bindingId: string) => {
    if (!selectedAssistant) return;
    const draft = bindingDraftsById[bindingId];
    if (!draft) return;
    setResourceSavingKey(`binding:${bindingId}`);
    setAssistantResourceError('');
    try {
      const res = await fetch(
        `${apiBase}/api/assistants/${encodeURIComponent(selectedAssistant.id)}/mcp-bindings/${encodeURIComponent(bindingId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            alias: draft.alias.trim() || undefined,
            args: parseList(draft.argsText),
            enabled: draft.enabled,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : t('assistants.更新 MCP 绑定失败'),
        );
      }
      await loadAssistantResources(selectedAssistant.id, true);
      persistResourceMessage(t('assistants.MCP 绑定已保存。'));
    } catch (err) {
      setAssistantResourceError(
        err instanceof Error ? err.message : t('assistants.更新 MCP 绑定失败'),
      );
    } finally {
      setResourceSavingKey('');
    }
  };

  const handleDeleteBinding = async (bindingId: string) => {
    if (!selectedAssistant) return;
    setResourceSavingKey(`binding:delete:${bindingId}`);
    setAssistantResourceError('');
    try {
      const res = await fetch(
        `${apiBase}/api/assistants/${encodeURIComponent(selectedAssistant.id)}/mcp-bindings/${encodeURIComponent(bindingId)}`,
        {
          method: 'DELETE',
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : t('assistants.删除 MCP 绑定失败'),
        );
      }
      await loadAssistantResources(selectedAssistant.id, true);
      persistResourceMessage(t('assistants.MCP 绑定已删除。'));
    } catch (err) {
      setAssistantResourceError(
        err instanceof Error ? err.message : t('assistants.删除 MCP 绑定失败'),
      );
    } finally {
      setResourceSavingKey('');
    }
  };

  const handleOpenSecrets = async (bindingId: string) => {
    if (!selectedAssistant) return;
    setSecretModalBindingId(bindingId);
    setDrawerView('secret');
    setSecretEnvDraft('');
    setSecretMessage('');
    await loadBindingSecrets(selectedAssistant.id, bindingId);
  };

  const handleSaveSecrets = async () => {
    if (!selectedAssistant || !secretModalBindingId) return;
    setSecretSaving(true);
    setSecretMessage('');
    try {
      const res = await fetch(
        `${apiBase}/api/assistants/${encodeURIComponent(selectedAssistant.id)}/mcp-bindings/${encodeURIComponent(secretModalBindingId)}/secrets`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            env: parseEnvInput(secretEnvDraft),
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : t('assistants.保存认证信息失败'),
        );
      }
      await loadBindingSecrets(selectedAssistant.id, secretModalBindingId);
      await loadAssistantResources(selectedAssistant.id, true);
      setSecretMessage(t('assistants.认证信息已保存。'));
    } catch (err) {
      setSecretMessage(
        err instanceof Error ? err.message : t('assistants.保存认证信息失败'),
      );
    } finally {
      setSecretSaving(false);
    }
  };

  const handleDeleteSecrets = async () => {
    if (!selectedAssistant || !secretModalBindingId) return;
    setSecretSaving(true);
    setSecretMessage('');
    try {
      const res = await fetch(
        `${apiBase}/api/assistants/${encodeURIComponent(selectedAssistant.id)}/mcp-bindings/${encodeURIComponent(secretModalBindingId)}/secrets`,
        {
          method: 'DELETE',
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : t('assistants.清除认证信息失败'),
        );
      }
      await loadBindingSecrets(selectedAssistant.id, secretModalBindingId);
      await loadAssistantResources(selectedAssistant.id, true);
      setSecretEnvDraft('');
      setSecretMessage(t('assistants.认证信息已清除。'));
    } catch (err) {
      setSecretMessage(
        err instanceof Error ? err.message : t('assistants.清除认证信息失败'),
      );
    } finally {
      setSecretSaving(false);
    }
  };

  const closeDrawer = () => {
    setDrawerView(null);
    setResourceDrawerSection('overview');
    setAssistantResourceError('');
    setSecretModalBindingId(null);
    setSecretEnvDraft('');
    setSecretLoading(false);
    setSecretSaving(false);
    setSecretMessage('');
  };

  const closeAssistantWorkbench = () => {
    setAssistantWorkbenchOpen(false);
    closeDrawer();
  };

  const openAssistantWorkbench = (assistantId: string) => {
    setSelectedAssistantId(assistantId);
    setAssistantWorkbenchOpen(true);
    if (!assistantResourcesById[assistantId]) {
      void loadAssistantResources(assistantId);
    }
  };

  const renderResourcesTab = () => {
    if (!selectedAssistant) return null;
    const templates = selectedResources?.availableMcpTemplates || [];
    const availableSkills = selectedResources?.availableSkills || [];
    const selectedSkillIds = new Set(
      selectedResources?.selectedSkillIds || detailForm.skillIds,
    );
    const bindings = selectedResources?.mcpBindings || [];
    const repoBindings = selectedResources?.repoBindings || [];
    const migrationBindings = bindings.filter(
      (binding) => binding.usesTemplateEnvFallback,
    );
    const missingSecretBindings = bindings.filter(
      (binding) => !binding.secretStatus.configured,
    );
    const pendingSecretBindings = bindings.filter(
      (binding) =>
        !binding.secretStatus.configured || binding.usesTemplateEnvFallback,
    );
    const showOverview = resourceDrawerSection === 'overview';
    const showAuth = resourceDrawerSection === 'auth';
    const showSkills = resourceDrawerSection === 'skills';
    const showCreate = resourceDrawerSection === 'create';
    const showBindings = resourceDrawerSection === 'bindings';

    return (
      <div className="assistant-panel-grid">
        {showOverview ? (
          <section className="assistant-form assistant-overview-card">
            <div className="assistant-section-heading">
              <div>
                <h4>{t('assistants.资源概览')}</h4>
                <p>
                  {t(
                    'assistants.助手独立持有自己的 Skills、MCP 绑定和认证状态，全局这里只作为模板库来源',
                  )}
                </p>
              </div>
              <div className="assistant-form-header-actions">
                <button
                  type="button"
                  className="btn-outline btn-sm"
                  onClick={() =>
                    void loadAssistantResources(selectedAssistant.id)
                  }
                  disabled={assistantResourceLoadingId === selectedAssistant.id}
                >
                  {assistantResourceLoadingId === selectedAssistant.id
                    ? t('assistants.刷新中...')
                    : t('assistants.刷新资源')}
                </button>
              </div>
            </div>
            <div className="assistants-page-summary">
              <div className="assistant-summary-card">
                <strong>{selectedSkillIds.size}</strong>
                <span>{t('assistants.启用')}</span>
              </div>
              <div className="assistant-summary-card">
                <strong>{bindings.length}</strong>
                <span>{t('assistants.绑定')}</span>
              </div>
              <div className="assistant-summary-card">
                <strong>{repoBindingCount}</strong>
                <span>{t('assistants.仓库绑定')}</span>
              </div>
              <div className="assistant-summary-card">
                <strong>{configuredSecretCount}</strong>
                <span>{t('assistants.认证已配置')}</span>
              </div>
              <div className="assistant-summary-card">
                <strong>{fallbackBindingCount}</strong>
                <span>{t('assistants.使用模板回退')}</span>
              </div>
            </div>
            {assistantResourceError ? (
              <div className="test-result error">{assistantResourceError}</div>
            ) : null}
            {assistantResourceMessage ? (
              <div className="test-result success">
                {assistantResourceMessage}
              </div>
            ) : null}
          </section>
        ) : null}

        {showAuth ? (
          <section className="assistant-form assistant-overview-card">
            <div className="assistant-section-heading">
              <div>
                <h4>{t('assistants.认证迁移队列')}</h4>
                <p>
                  {t(
                    'assistants.优先处理仍在使用模板回退或尚未写入助手私有认证的绑定',
                  )}
                </p>
              </div>
            </div>
            <div className="assistant-resource-summary">
              <div className="assistant-resource-summary-item">
                <strong>{migrationBindings.length}</strong>
                <span>{t('assistants.待迁移')}</span>
              </div>
              <div className="assistant-resource-summary-item">
                <strong>{missingSecretBindings.length}</strong>
                <span>{t('assistants.缺认证')}</span>
              </div>
              <div className="assistant-resource-summary-item">
                <strong>{pendingSecretBindings.length}</strong>
                <span>{t('assistants.待处理总数')}</span>
              </div>
            </div>
            {pendingSecretBindings.length > 0 ? (
              <div className="assistant-validation-list">
                {pendingSecretBindings.map((binding) => (
                  <div
                    key={`${binding.id}:pending-secret`}
                    className={`assistant-validation-item ${
                      binding.usesTemplateEnvFallback
                        ? 'is-warning'
                        : 'is-error'
                    }`}
                  >
                    <div className="assistant-validation-item-copy">
                      <strong>{binding.alias || binding.templateName}</strong>
                      <p>
                        {binding.usesTemplateEnvFallback
                          ? t(
                              'assistants.当前仍使用模板级认证回退。建议迁移为当前助手独享的密钥。',
                            )
                          : t('assistants.当前还没有配置助手私有认证。')}
                      </p>
                    </div>
                    <div className="assistant-stage-actions">
                      <span
                        className={`assistant-validation-state ${
                          binding.usesTemplateEnvFallback
                            ? 'is-warning'
                            : 'is-error'
                        }`}
                      >
                        {binding.usesTemplateEnvFallback
                          ? t('assistants.待迁移')
                          : t('assistants.缺认证')}
                      </span>
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        onClick={() => void handleOpenSecrets(binding.id)}
                      >
                        {t('assistants.管理认证')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="assistant-inline-stack">
                <strong>{t('assistants.当前没有迁移阻塞项')}</strong>
                <span>
                  {t(
                    'assistants.所有绑定都已写入当前助手自己的认证，不再依赖模板回退',
                  )}
                </span>
              </div>
            )}
          </section>
        ) : null}

        {showSkills ? (
          <section className="assistant-form assistant-overview-card">
            <div className="assistant-section-heading">
              <div>
                <h4>Skills</h4>
                <p>
                  {t(
                    'assistants.这里管理当前助手自己的技能包，不再依赖全局启停状态来决定是否可用',
                  )}
                </p>
              </div>
            </div>
            {availableSkills.length > 0 ? (
              <div className="assistant-settings-option-grid">
                {availableSkills.map((skill) => {
                  const checked = selectedSkillIds.has(skill.id);
                  return (
                    <label
                      key={skill.id}
                      className={`assistant-settings-option-card${checked ? ' selected' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => void handleSkillToggle(skill.id)}
                        disabled={resourceSavingKey === `skill:${skill.id}`}
                      />
                      <span>{skill.name}</span>
                      <small>
                        {skill.description || skill.id}
                        {skill.enabled
                          ? t('assistants. · 模板已启用')
                          : t('assistants. · 模板当前关闭')}
                      </small>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="assistant-empty-state">
                <h3>{t('assistants.当前没有可用')} Skills</h3>
                <p>
                  {t(
                    'assistants.先去全局 Skills 管理安装或启用模板，再回来选择要分配给这个助手的技能',
                  )}
                </p>
              </div>
            )}
          </section>
        ) : null}

        {showCreate ? (
          <section className="assistant-form assistant-overview-card">
            <div className="assistant-section-heading">
              <div>
                <h4>{t('assistants.新增 MCP 绑定')}</h4>
                <p>
                  {t(
                    'assistants.从全局模板库挑一个模板，为当前助手创建自己的独立绑定和认证状态',
                  )}
                </p>
              </div>
            </div>
            <div className="assistant-form-grid">
              <label>
                {t('assistants.模板')}
                <AppSelect
                  value={newBindingTemplateId}
                  onChange={setNewBindingTemplateId}
                  ariaLabel={t('assistants.选择 MCP 模板')}
                  options={templates.map((template) => ({
                    value: template.id,
                    label: `${template.name} · env ${template.envKeyCount}`,
                    disabled: !template.enabled,
                  }))}
                />
              </label>
              <label>
                {t('assistants.别名')}
                <input
                  value={newBindingAlias}
                  onChange={(event) => setNewBindingAlias(event.target.value)}
                  placeholder={t('assistants.留空则跟随模板名')}
                />
              </label>
              <label className="full">
                {t('assistants.参数覆盖')}
                <input
                  value={newBindingArgsText}
                  onChange={(event) =>
                    setNewBindingArgsText(event.target.value)
                  }
                  placeholder={t('assistants.空格分隔；留空则跟随模板参数')}
                />
              </label>
            </div>
            {templates.length > 0 ? (
              <div className="assistant-inline-stack">
                {templates.find(
                  (template) => template.id === newBindingTemplateId,
                )?.command || t('assistants.未选择模板')}
              </div>
            ) : null}
            <div className="assistant-form-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleCreateBinding()}
                disabled={
                  !newBindingTemplateId.trim() ||
                  resourceSavingKey === 'binding:create'
                }
              >
                {resourceSavingKey === 'binding:create'
                  ? t('assistants.新增中...')
                  : t('assistants.新增')}
              </button>
            </div>
          </section>
        ) : null}

        {showBindings ? (
          <section className="assistant-form assistant-overview-card">
            <div className="assistant-section-heading">
              <div>
                <h4>{t('assistants.当前绑定')}</h4>
                <p>
                  {t(
                    'assistants.这里统一管理当前助手的 MCP 绑定和代码仓库绑定。',
                  )}
                </p>
              </div>
            </div>
            <div className="assistant-inline-stack">
              <strong>{t('assistants.生效运行时')}</strong>
              <span>
                {repoBindings.length > 0
                  ? `${t('assistants.主 project root 候选：')}${
                      repoBindings[0]?.worktreePath ||
                      repoBindings[0]?.localPath ||
                      repoBindings[0]?.repositoryName
                    }`
                  : t(
                      'assistants.当前没有仓库工作目录，助手运行时不会获得 repo project root override。',
                    )}
              </span>
            </div>
            {bindings.length > 0 ? (
              <div className="assistant-binding-list">
                {bindings.map((binding) => {
                  const draft = bindingDraftsById[binding.id] || {
                    alias: binding.alias || '',
                    argsText: binding.args.join(' '),
                    enabled: binding.enabled,
                  };
                  return (
                    <div key={binding.id} className="assistant-binding-card">
                      <div className="assistant-binding-summary">
                        <div>
                          <strong>
                            {binding.alias || binding.templateName}
                          </strong>
                          <span>
                            {binding.templateName} ·{' '}
                            {formatBindingSourceLabel(binding.source, t)}
                          </span>
                        </div>
                        <div className="assistant-chip-row">
                          <span className="assistant-mini-chip">
                            {binding.secretStatus.configured
                              ? t('assistants.已配认证 {{count}}', {
                                  count: binding.secretStatus.keyCount,
                                })
                              : t('assistants.未配认证')}
                          </span>
                          {binding.usesTemplateEnvFallback ? (
                            <span className="assistant-mini-chip">
                              {t('assistants.模板认证回退')}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="assistant-binding-grid">
                        <label>
                          {t('assistants.别名')}
                          <input
                            value={draft.alias}
                            onChange={(event) =>
                              setBindingDraftsById((prev) => ({
                                ...prev,
                                [binding.id]: {
                                  ...draft,
                                  alias: event.target.value,
                                },
                              }))
                            }
                            placeholder={t('assistants.留空则显示模板名')}
                          />
                        </label>
                        <label>
                          {t('assistants.参数')}
                          <input
                            value={draft.argsText}
                            onChange={(event) =>
                              setBindingDraftsById((prev) => ({
                                ...prev,
                                [binding.id]: {
                                  ...draft,
                                  argsText: event.target.value,
                                },
                              }))
                            }
                            placeholder={t('assistants.空格分隔')}
                          />
                        </label>
                        <NcCheckbox
                          className="assistant-toggle"
                          checked={draft.enabled}
                          onChange={(event) =>
                            setBindingDraftsById((prev) => ({
                              ...prev,
                              [binding.id]: {
                                ...draft,
                                enabled: event.target.checked,
                              },
                            }))
                          }
                          label={t('assistants.启用该绑定')}
                        />
                      </div>
                      <div className="assistant-inline-stack">
                        <span>
                          {t('assistants.模板环境变量：')}
                          {binding.templateEnvKeys.length > 0
                            ? ` ${binding.templateEnvKeys.join(', ')}`
                            : ` ${t('assistants.无')}`}
                        </span>
                        <span>
                          {t('assistants.认证更新时间：')}
                          {binding.secretStatus.updatedAt ||
                            ` ${t('assistants.未配置')}`}
                        </span>
                      </div>
                      {binding.usesTemplateEnvFallback ? (
                        <div className="assistant-warning-note">
                          {t(
                            'assistants.该绑定当前仍在使用模板级 env 回退。为了满足助手隔离，建议尽快在管理认证里写入当前助手自己的密钥。',
                          )}
                        </div>
                      ) : null}
                      <div className="assistant-binding-actions">
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          onClick={() => void handleUpdateBinding(binding.id)}
                          disabled={
                            resourceSavingKey === `binding:${binding.id}`
                          }
                        >
                          {resourceSavingKey === `binding:${binding.id}`
                            ? t('assistants.保存中...')
                            : t('assistants.保存修改')}
                        </button>
                        <button
                          type="button"
                          className="btn-outline btn-sm"
                          onClick={() => void handleOpenSecrets(binding.id)}
                        >
                          {t('assistants.管理认证')}
                        </button>
                        <button
                          type="button"
                          className="btn-danger btn-sm"
                          onClick={() => void handleDeleteBinding(binding.id)}
                          disabled={
                            resourceSavingKey === `binding:delete:${binding.id}`
                          }
                        >
                          {t('assistants.删除')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="assistant-empty-state">
                <h3>{t('assistants.还没有 MCP 绑定')}</h3>
                <p>
                  {t(
                    'assistants.这正是当前页面要解决的问题。先从上面的模板库创建一个绑定，再给它配置当前助手自己的认证。',
                  )}
                </p>
              </div>
            )}
            <div
              className="assistant-section-heading"
              style={{ marginTop: '20px' }}
            >
              <div>
                <h4>{t('assistants.代码仓库绑定')}</h4>
                <p>
                  {t(
                    'assistants.这些仓库会参与助手运行时的 repo roots 与 project root 计算。',
                  )}
                </p>
              </div>
            </div>
            <RepositoryBindingPicker
              ownerType="assistant"
              ownerId={selectedAssistant.id}
              onBindingChange={() =>
                void loadAssistantResources(selectedAssistant.id, true)
              }
              renderActions={(binding) => {
                const config = binding.config || {};
                const hasWorktree = !!config.worktree_path;
                return (
                  <>
                    <button
                      type="button"
                      className="btn-outline btn-xs"
                      disabled={repoSaving}
                      onClick={() => {
                        void (async () => {
                          setRepoSaving(true);
                          try {
                            await repoBindingRequest(
                              selectedAssistant.id,
                              `/${encodeURIComponent(binding.id)}/provision`,
                              { method: 'POST' },
                            );
                          } finally {
                            setRepoSaving(false);
                          }
                        })();
                      }}
                    >
                      {hasWorktree
                        ? t('assistants.同步')
                        : t('assistants.克隆')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-xs"
                      disabled={repoSaving}
                      onClick={() => {
                        const branch = prompt(
                          t('assistants.切换到分支:'),
                          binding.branch || 'main',
                        );
                        if (branch != null && branch.trim()) {
                          void (async () => {
                            setRepoSaving(true);
                            try {
                              await repoBindingRequest(
                                selectedAssistant.id,
                                `/${encodeURIComponent(binding.id)}/switch-branch`,
                                {
                                  method: 'POST',
                                  headers: {
                                    'Content-Type': 'application/json',
                                  },
                                  body: JSON.stringify({
                                    branch: branch.trim(),
                                  }),
                                },
                              );
                            } finally {
                              setRepoSaving(false);
                            }
                          })();
                        }
                      }}
                    >
                      {t('assistants.切换分支')}
                    </button>
                  </>
                );
              }}
            />
            {repoBindings.length > 0 ? (
              <div
                className="assistant-binding-list"
                style={{ marginTop: '12px' }}
              >
                {repoBindings.map((binding) => (
                  <div key={binding.id} className="assistant-binding-card">
                    <div className="assistant-binding-summary">
                      <div>
                        <strong>{binding.repositoryName}</strong>
                        <span>
                          {binding.activeBranch || binding.defaultBranch} ·{' '}
                          {binding.enabled
                            ? t('assistants.已启用')
                            : t('assistants.已停用')}
                        </span>
                      </div>
                      <div className="assistant-chip-row">
                        <span className="assistant-mini-chip">
                          {binding.worktreePath
                            ? t('assistants.已 provision')
                            : t('assistants.未 provision')}
                        </span>
                      </div>
                    </div>
                    <div className="assistant-inline-stack">
                      <span>
                        {t('assistants.默认分支：')}
                        {binding.defaultBranch}
                      </span>
                      <span>
                        {t('assistants.分支白名单：')}
                        {binding.branchFilter.length
                          ? binding.branchFilter.join(', ')
                          : t('assistants.未限制')}
                      </span>
                      <span>
                        {t('assistants.工作目录：')}
                        {binding.worktreePath ||
                          binding.localPath ||
                          t('assistants.未生成')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    );
  };

  const renderSettingsTab = () => {
    if (!selectedAssistant) return null;
    return (
      <div className="assistant-panel-grid">
        <AssistantEditorPanel
          title={selectedAssistant.name}
          subtitle={t(
            'assistants.这里维护当前助手的人设、Provider、规则等基础配置。',
          )}
          form={detailForm}
          setForm={setDetailForm}
          showAdvanced={detailShowAdvanced}
          setShowAdvanced={setDetailShowAdvanced}
          providerOptions={providerOptions}
          enabledSkills={selectableSkills}
          enabledMcpServers={selectableMcpServers}
          availableKbs={availableKbs}
          apiBase={apiBase}
          assistantId={selectedAssistant.id}
          submitLabel={t('assistants.保存修改')}
          onSubmit={handleDetailSubmit}
          headerActions={
            <>
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={() => onStartChat(selectedAssistant.id)}
                disabled={!selectedAssistant.enabled}
              >
                {t('assistants.开始对话')}
              </button>
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={() => {
                  setResourceDrawerSection('overview');
                  setDrawerView('resources');
                }}
              >
                {t('assistants.去资源页')}
              </button>
            </>
          }
        />
      </div>
    );
  };

  return (
    <div className="page-view assistants-page">
      <PageHeader
        className="assistants-page-header"
        title="Agent"
        subtitle="Catalog, resources, and runtime wiring for every Agent."
        meta={
          <div className="nc-page-metrics">
            <div className="nc-page-metric">
              <span className="nc-page-metric-label">Agent</span>
              <strong className="nc-page-metric-value">{assistants.length}</strong>
            </div>
            <div className="nc-page-metric">
              <span className="nc-page-metric-label">{t('assistants.启用')}</span>
              <strong className="nc-page-metric-value">{enabledAssistantCount}</strong>
            </div>
            <div className="nc-page-metric">
              <span className="nc-page-metric-label">Filtered</span>
              <strong className="nc-page-metric-value">
                {filteredAssistants.length}
              </strong>
            </div>
          </div>
        }
        actions={
          <div className="nc-page-actions-group assistants-hero-actions">
            <button
              type="button"
              className="btn-outline"
              onClick={onRefresh}
              disabled={loading}
            >
              {t('assistants.刷新')}
            </button>
            <label className="btn-outline nc-page-action-file">
              Import
              <input
                type="file"
                accept=".json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = async () => {
                    try {
                      const data = JSON.parse(reader.result as string);
                      if (!data.assistant?.name || !data.assistant?.config) {
                        alert(t('assistants.无效的助手导入文件'));
                        return;
                      }
                      const createRes = await fetch(`${apiBase}/api/assistants`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          name: data.assistant.name,
                          description: data.assistant.description ?? null,
                          enabled: data.assistant.enabled ?? true,
                          config: data.assistant.config,
                          visibility: data.assistant.visibility ?? 'private',
                        }),
                      });
                      if (!createRes.ok) {
                        alert(t('assistants.创建助手失败'));
                        return;
                      }
                      const { assistant: created } = await createRes.json();
                      const aid = encodeURIComponent(created.id);
                      const bindingTasks = [
                        ...(data.mcpBindings ?? []).map(
                          (b: Record<string, unknown>) =>
                            fetch(
                              `${apiBase}/api/assistants/${aid}/mcp-bindings`,
                              {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  templateServerId: b.template_server_id,
                                  alias: b.alias,
                                  enabled: b.enabled,
                                }),
                              },
                            ),
                        ),
                        ...(data.repoBindings ?? []).map(
                          (r: Record<string, unknown>) =>
                            fetch(
                              `${apiBase}/api/assistants/${aid}/repo-bindings`,
                              {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  repoUrl: r.repo_url,
                                  name: r.name,
                                  description: r.description,
                                  defaultBranch: r.default_branch,
                                  branchFilter: r.branch_filter,
                                }),
                              },
                            ),
                        ),
                      ];
                      const results = await Promise.allSettled(bindingTasks);
                      const failCount = results.filter(
                        (r) =>
                          r.status === 'rejected' ||
                          (r.status === 'fulfilled' && !r.value.ok),
                      ).length;
                      onRefresh();
                      if (failCount > 0) {
                        alert(
                          t('assistants.助手已创建但绑定导入失败', {
                            count: failCount,
                          }),
                        );
                      }
                    } catch {
                      alert(t('assistants.解析导入文件失败'));
                    }
                  };
                  reader.readAsText(file);
                  e.target.value = '';
                }}
              />
            </label>
            <button
              type="button"
              className="btn-primary"
              onClick={handleCreateOpen}
            >
              New Agent
            </button>
          </div>
        }
      />

      {error ? (
        <div className="page-error">
          <p>{error}</p>
        </div>
      ) : null}

      <div className="assistants-catalog-section">
        {loading ? (
          <div className="assistant-empty-state assistant-compact-empty">
            <p>{t('assistants.助手列表加载中...')}</p>
          </div>
        ) : assistants.length === 0 ? (
          <div className="assistant-empty-state">
            <p>
              {t(
                'assistants.创建后这里会展示你的助手列表、资源状态和接入工作台。',
              )}
            </p>
          </div>
        ) : (
          <>
            <div className="assistant-catalog-toolbar">
              <div className="assistant-catalog-toolbar-row">
                <div className="assistant-catalog-search-wrap">
                  <input
                    className="assistant-catalog-search-input"
                    value={catalogSearch}
                    onChange={(event) => {
                      setCatalogSearch(event.target.value);
                      setAssistantCardPage(1);
                    }}
                    placeholder={t('assistants.搜索助手名称、描述或 ID')}
                  />
                  {!catalogSearch && (
                    <span
                      className="assistant-catalog-search-icon"
                      aria-hidden="true"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="11" cy="11" r="8" />
                        <path d="m21 21-4.3-4.3" />
                      </svg>
                    </span>
                  )}
                </div>
                <AppSelect
                  value={catalogFilter}
                  onChange={(nextValue) => {
                    setCatalogFilter(nextValue as AssistantCatalogFilter);
                    setAssistantCardPage(1);
                  }}
                  ariaLabel={t('assistants.筛选助手状态')}
                  options={assistantCatalogFilterOptions}
                />
              </div>
              <div className="assistant-catalog-meta-row">
                <span className="assistant-catalog-stat-value">
                  {t('assistants.助手计数', {
                    filtered: filteredAssistants.length,
                    total: assistants.length,
                  })}
                </span>
                {filteredAssistants.length > ASSISTANT_CARD_PAGE_SIZE && (
                  <Pagination
                    page={assistantCardPage}
                    pageSize={ASSISTANT_CARD_PAGE_SIZE}
                    total={filteredAssistants.length}
                    onPageChange={setAssistantCardPage}
                  />
                )}
              </div>
            </div>

            {filteredAssistants.length === 0 ? (
              <div className="assistant-empty-state assistant-compact-empty">
                <h3>{t('assistants.没有匹配结果')}</h3>
                <p>
                  {t('assistants.试试更换状态筛选，或者输入更短的关键词。')}
                </p>
              </div>
            ) : (
              <div className="assistant-cards-grid">
                {filteredAssistants
                  .slice(
                    (assistantCardPage - 1) * ASSISTANT_CARD_PAGE_SIZE,
                    assistantCardPage * ASSISTANT_CARD_PAGE_SIZE,
                  )
                  .map((assistant) => {
                    const meta = assistantCatalogMetaById[assistant.id];
                    return (
                      <div
                        key={assistant.id}
                        role="button"
                        tabIndex={0}
                        className={`assistant-card-item ${selectedAssistantId === assistant.id ? 'active' : ''}`}
                        onClick={() => openAssistantWorkbench(assistant.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openAssistantWorkbench(assistant.id);
                          }
                        }}
                      >
                        <div className="assistant-card-item-header">
                          <strong>{assistant.name}</strong>
                          <div className="assistant-card-item-badges">
                            <span
                              className={`assistant-badge ${assistant.enabled ? 'enabled' : 'disabled'}`}
                            >
                              {assistant.enabled
                                ? t('assistants.启用')
                                : t('assistants.停用')}
                            </span>
                            {meta ? (
                              <span
                                className={`assistant-card-status is-${formatAssistantCatalogStatusTone(meta.status)}`}
                              >
                                {formatAssistantCatalogStatusLabel(
                                  meta.status,
                                  t,
                                )}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="assistant-card-item-desc">
                          {assistant.description ||
                            t('assistants.尚未填写描述')}
                        </div>
                        <div className="assistant-card-item-meta">
                          {assistant.visibility === 'shared' ? (
                            <span className="assistant-card-visibility-tag shared">
                              {t('assistants.公开')}
                            </span>
                          ) : (
                            <span className="assistant-card-visibility-tag">
                              {t('assistants.私有')}
                            </span>
                          )}
                          {assistant.config.persona?.role ? (
                            <span className="assistant-card-role-tag">
                              {assistant.config.persona.role}
                            </span>
                          ) : null}
                          {(assistant.config.kbIds?.length ?? 0) > 0 ? (
                            <span>
                              {t('assistants.知识库计数', {
                                count: assistant.config.kbIds.length,
                              })}
                            </span>
                          ) : null}
                          {(assistant.config.skillIds?.length ?? 0) > 0 ? (
                            <span>
                              {assistant.config.skillIds.length} Skills
                            </span>
                          ) : null}
                          {(assistant.config.mcpServerIds?.length ?? 0) > 0 ? (
                            <span>
                              {assistant.config.mcpServerIds.length} MCP
                            </span>
                          ) : null}
                          {(conversationCountMap.get(assistant.id) ?? 0) > 0 ? (
                            <span>
                              {t('会话计数', {
                                count:
                                  conversationCountMap.get(assistant.id) ?? 0,
                              })}
                            </span>
                          ) : null}
                        </div>
                        <div className="assistant-card-item-actions">
                          <button
                            type="button"
                            className="btn-outline btn-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAssistantWorkbench(assistant.id);
                            }}
                          >
                            {t('assistants.编辑')}
                          </button>
                          <button
                            type="button"
                            className="btn-outline btn-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(
                                `${apiBase}/api/assistants/${encodeURIComponent(assistant.id)}/export`,
                                '_blank',
                              );
                            }}
                          >
                            {t('assistants.导出')}
                          </button>
                          <button
                            type="button"
                            className="btn-primary btn-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              onStartChat(assistant.id);
                            }}
                            disabled={!assistant.enabled}
                          >
                            {t('assistants.对话')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </>
        )}
      </div>

      {assistantWorkbenchOpen && selectedAssistant ? (
        <div
          className="assistant-drawer-overlay"
          onClick={closeAssistantWorkbench}
        >
          <div
            className="assistant-drawer-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="assistant-drawer-panel-header">
              <div>
                <h3>{selectedAssistant.name}</h3>
                <p>
                  {selectedAssistant.description || t('assistants.暂无描述')}
                </p>
              </div>
              <div className="assistant-drawer-panel-header-actions">
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={() => onStartChat(selectedAssistant.id)}
                  disabled={!selectedAssistant.enabled}
                >
                  {t('assistants.开始对话')}
                </button>
                <button
                  type="button"
                  className="btn-outline btn-sm"
                  onClick={handleCreateFromCurrentAssistant}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="btn-outline btn-sm"
                  onClick={() => {
                    window.open(
                      `${apiBase}/api/assistants/${encodeURIComponent(selectedAssistant.id)}/export`,
                      '_blank',
                    );
                  }}
                >
                  {t('assistants.导出')}
                </button>
                <button
                  type="button"
                  className="btn-danger btn-sm"
                  onClick={() => void handleDeleteAssistant(selectedAssistant)}
                  disabled={deletingAssistantId === selectedAssistant.id}
                >
                  {deletingAssistantId === selectedAssistant.id
                    ? t('assistants.删除中...')
                    : t('assistants.删除')}
                </button>
                <button
                  type="button"
                  className="modal-close-btn"
                  aria-label={t('assistants.关闭')}
                  onClick={closeAssistantWorkbench}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="assistant-drawer-panel-body">
              {!drawerView ? (
                <div className="assistant-edit-tabs">
                  <div className="assistant-drawer-nav">
                    <button
                      type="button"
                      className="assistant-drawer-nav-btn active"
                      onClick={() => setDrawerView(null)}
                    >
                      {t('auto.0aeca07a')}
                    </button>
                    <button
                      type="button"
                      className="assistant-drawer-nav-btn"
                      onClick={() => {
                        setResourceDrawerSection('overview');
                        setDrawerView('resources');
                      }}
                    >
                      {t('auto.6478fcbd')}
                    </button>
                  </div>
                  {renderSettingsTab()}
                </div>
              ) : drawerView === 'resources' ? (
                <div className="assistant-edit-tabs">
                  <div className="assistant-drawer-nav">
                    <button
                      type="button"
                      className="assistant-drawer-nav-btn"
                      onClick={() => setDrawerView(null)}
                    >
                      {t('auto.0aeca07a')}
                    </button>
                    <button
                      type="button"
                      className={`assistant-drawer-nav-btn ${resourceDrawerSection === 'overview' ? 'active' : ''}`}
                      onClick={() => setResourceDrawerSection('overview')}
                    >
                      {t('auto.86385379')}
                    </button>
                    <button
                      type="button"
                      className={`assistant-drawer-nav-btn ${resourceDrawerSection === 'auth' ? 'active' : ''}`}
                      onClick={() => setResourceDrawerSection('auth')}
                    >
                      {t('auto.b7158a42')}
                    </button>
                    <button
                      type="button"
                      className={`assistant-drawer-nav-btn ${resourceDrawerSection === 'skills' ? 'active' : ''}`}
                      onClick={() => setResourceDrawerSection('skills')}
                    >
                      Skills
                    </button>
                    <button
                      type="button"
                      className={`assistant-drawer-nav-btn ${resourceDrawerSection === 'create' ? 'active' : ''}`}
                      onClick={() => setResourceDrawerSection('create')}
                    >
                      {t('auto.1df372b4')}
                    </button>
                    <button
                      type="button"
                      className={`assistant-drawer-nav-btn ${resourceDrawerSection === 'bindings' ? 'active' : ''}`}
                      onClick={() => setResourceDrawerSection('bindings')}
                    >
                      {t('auto.aca24bd2')}
                    </button>
                  </div>
                  {renderResourcesTab()}
                </div>
              ) : drawerView === 'secret' && secretModalBindingId ? (
                <div className="assistant-edit-tabs">
                  <div className="assistant-drawer-nav">
                    <button
                      type="button"
                      className="assistant-drawer-nav-btn"
                      onClick={() => setDrawerView(null)}
                    >
                      {t('auto.0aeca07a')}
                    </button>
                    <button
                      type="button"
                      className="assistant-drawer-nav-btn"
                      onClick={() => {
                        setResourceDrawerSection('overview');
                        setDrawerView('resources');
                      }}
                    >
                      {t('auto.6478fcbd')}
                    </button>
                    <button
                      type="button"
                      className="assistant-drawer-nav-btn active"
                    >
                      {t('auto.40b17567')}
                    </button>
                  </div>
                  {secretLoading ? (
                    <div className="settings-hint">{t('auto.a78de363')}</div>
                  ) : null}
                  {bindingSecretsById[secretModalBindingId] ? (
                    <div className="assistant-inline-stack">
                      <strong>
                        {bindingSecretsById[secretModalBindingId]?.secretStatus
                          .configured
                          ? t('auto.7ea1dabf', {
                              count:
                                bindingSecretsById[secretModalBindingId]
                                  ?.secretStatus.keyCount,
                            })
                          : t('auto.7df6c9b5')}
                      </strong>
                    </div>
                  ) : null}
                  <label className="full">
                    {`${t('auto.b7158a42')} env (KEY=VALUE, ${t('auto.16775261')})`}
                    <textarea
                      rows={6}
                      value={secretEnvDraft}
                      onChange={(event) =>
                        setSecretEnvDraft(event.target.value)
                      }
                      placeholder="API_KEY=...\nBASE_URL=..."
                    />
                  </label>
                  {secretMessage ? (
                    <div
                      className={`test-result ${/(fail|error|invalid|失败|错误|无效)/i.test(secretMessage) ? 'error' : 'success'}`}
                    >
                      {secretMessage}
                    </div>
                  ) : null}
                  <div className="assistant-button-row">
                    <button
                      type="button"
                      className="btn-danger btn-sm"
                      onClick={() => void handleDeleteSecrets()}
                      disabled={secretSaving}
                    >
                      {t('auto.6878b8a1')}
                    </button>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() => void handleSaveSecrets()}
                      disabled={secretSaving}
                    >
                      {secretSaving
                        ? t('assistants.保存中...')
                        : t('auto.be5fbbe3')}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {createDialogOpen ? (
        <div
          className="assistant-drawer-overlay"
          onClick={() => setCreateDialogOpen(false)}
        >
          <div
            className="assistant-drawer-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="assistant-drawer-panel-header">
              <div>
                <h3>New Agent</h3>
                <p>{t('auto.35107623')}</p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setCreateDialogOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="assistant-drawer-panel-body">
              <div className="assistant-template-grid">
                {assistantTemplates.map((tpl) => (
                  <button
                    key={tpl.key}
                    type="button"
                    className={`assistant-template-card${createTemplateKey === tpl.key ? ' selected' : ''}`}
                    onClick={() => {
                      const isDirty =
                        createForm.name.trim() ||
                        createForm.personaRole.trim() ||
                        createForm.personaStyle.trim();
                      if (isDirty && !confirm(t('auto.e04776ac'))) return;
                      setCreateTemplateKey(tpl.key);
                      setCreateForm((prev) => ({ ...prev, ...tpl.form }));
                    }}
                  >
                    <strong>{tpl.label}</strong>
                    <span>{tpl.description}</span>
                  </button>
                ))}
              </div>
              <AssistantEditorPanel
                title=""
                subtitle=""
                form={createForm}
                setForm={setCreateForm}
                showAdvanced={createShowAdvanced}
                setShowAdvanced={setCreateShowAdvanced}
                providerOptions={providerOptions}
                enabledSkills={selectableSkills}
                enabledMcpServers={selectableMcpServers}
                availableKbs={availableKbs}
                availableRepositories={availableRepositories.filter(
                  (repo) => repo.enabled,
                )}
                selectedRepositoryIds={createRepositoryIds}
                onToggleRepository={(id) =>
                  setCreateRepositoryIds((prev) => toggleIdSelection(prev, id))
                }
                apiBase={apiBase}
                assistantId={null}
                submitLabel={t('auto.be5fbbe3')}
                onSubmit={handleCreateSubmit}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
