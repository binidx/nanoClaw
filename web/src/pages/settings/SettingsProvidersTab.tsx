import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AiProvider, TestResult } from '../../app-types';
import { NcSelect } from '../../components/common';
import { providerVisibilityBadgeLabel } from './settings-helpers';
import { renderBooleanField } from './settings-field-renderers';

interface RoleRecord {
  id: string;
  name: string;
  description: string | null;
  is_system: number;
}

interface ProviderGrantUserRecord {
  id: string;
  username: string;
  displayName: string | null;
  status: string;
}

interface ProviderShareRecord {
  user_id: string;
  username: string | null;
  display_name: string | null;
  granted_by: string;
  created_at: string;
}

interface ProviderShareCandidate {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  status: string;
}

type ProviderStatusTone = 'success' | 'warning' | 'error' | 'idle';

type ProviderStatusSummary = {
  label: string;
  tone: ProviderStatusTone;
  detail: string;
};

const PROVIDER_TYPE_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  openai: 'OpenAI',
  zhipu: '智谱',
  gemini: 'Gemini',
  cursor: 'Cursor',
  openai_compatible: 'OpenAI Compatible',
  ollama: 'Ollama',
};

const PROVIDER_TYPE_TONES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  openai: 'openai',
  zhipu: 'zhipu',
  gemini: 'gemini',
  cursor: 'cursor',
  openai_compatible: 'compatible',
  ollama: 'ollama',
};

export type SettingsProvidersTabProps = {
  apiBase: string;
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
  renderSensitiveInput: (
    inputId: string,
    value: string,
    onChange: (value: string) => void,
    placeholder?: string,
    disabled?: boolean,
  ) => ReactNode;
  hasSystemSettings?: boolean;
};

function getProviderTypeLabel(type: string) {
  return PROVIDER_TYPE_LABELS[type] || type || 'Provider';
}

function getProviderTypeTone(type: string) {
  return PROVIDER_TYPE_TONES[type] || 'default';
}

function getProviderInitial(alias: string | null | undefined, type: string) {
  const text = (alias || getProviderTypeLabel(type) || 'P').trim();
  return text.slice(0, 1).toUpperCase();
}

function isProviderConfigured(provider: AiProvider) {
  return Boolean(
    (provider.api_key && provider.api_key.trim()) ||
      (provider.base_url && provider.base_url.trim()) ||
      (provider.model && provider.model.trim()),
  );
}

function buildProviderStatus(
  provider: AiProvider,
  testResult: TestResult | undefined,
  isTesting: boolean,
): ProviderStatusSummary {
  if (isTesting) {
    return {
      label: '连接测试中',
      tone: 'warning',
      detail: '正在校验当前配置的可用性。',
    };
  }
  if (testResult?.ok) {
    return {
      label: '响应正常',
      tone: 'success',
      detail:
        testResult.latencyMs !== undefined
          ? `最近一次测试延迟 ${testResult.latencyMs} ms`
          : testResult.message || '最近一次测试已通过。',
    };
  }
  if (testResult && !testResult.ok) {
    return {
      label: '测试失败',
      tone: 'error',
      detail: testResult.message || '最近一次测试未通过，请检查模型和网络。',
    };
  }
  if (isProviderConfigured(provider)) {
    return {
      label: '已配置',
      tone: 'idle',
      detail: '已填写主要连接信息，建议执行一次连接测试。',
    };
  }
  return {
    label: '待完善',
    tone: 'warning',
    detail: '当前配置还不完整，保存前请补充模型或连接参数。',
  };
}

function providerSourceLabel(source?: AiProvider['source']) {
  if (source === 'system') return '系统';
  if (source === 'shared') return '共享';
  return '个人';
}

function ProviderEditorModal({
  t,
  editingProvider,
  setEditingProvider,
  saveProvider,
  activateGlobalProvider,
  renderSensitiveInput,
  hasSystemSettings,
  isEmbeddingEditor,
  selectedRoleIds,
  selectedUserIds,
  rolesLoaded,
  usersLoaded,
  allRoles,
  allUsers,
  toggleRole,
  toggleUser,
  shareSearchQuery,
  setShareSearchQuery,
  shareSearchLoading,
  shareCandidates,
  shareProviderToUser,
  shareTargetUserId,
  setShareTargetUserId,
  shareProvider,
  providerShares,
  revokeProviderShare,
}: {
  t: (key: string, options?: Record<string, unknown>) => string;
  editingProvider: Partial<AiProvider>;
  setEditingProvider: Dispatch<SetStateAction<Partial<AiProvider> | null>>;
  saveProvider: () => void;
  activateGlobalProvider: (id: string) => void;
  renderSensitiveInput: SettingsProvidersTabProps['renderSensitiveInput'];
  hasSystemSettings?: boolean;
  isEmbeddingEditor: boolean;
  selectedRoleIds: string[];
  selectedUserIds: string[];
  rolesLoaded: boolean;
  usersLoaded: boolean;
  allRoles: RoleRecord[];
  allUsers: ProviderGrantUserRecord[];
  toggleRole: (roleId: string) => void;
  toggleUser: (userId: string) => void;
  shareSearchQuery: string;
  setShareSearchQuery: Dispatch<SetStateAction<string>>;
  shareSearchLoading: boolean;
  shareCandidates: ProviderShareCandidate[];
  shareProviderToUser: (targetUserId: string) => void;
  shareTargetUserId: string;
  setShareTargetUserId: Dispatch<SetStateAction<string>>;
  shareProvider: () => void;
  providerShares: ProviderShareRecord[];
  revokeProviderShare: (targetUserId: string) => void;
}) {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="modal-overlay provider-editor-overlay"
      onClick={() => setEditingProvider(null)}
    >
      <div
        className="modal provider-editor-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header provider-editor-header">
          <div className="provider-editor-title-row">
            <span
              className={`settings-provider-avatar settings-provider-avatar--lg tone-${getProviderTypeTone(
                editingProvider.type || (isEmbeddingEditor ? 'openai' : 'claude'),
              )}`}
              aria-hidden="true"
            >
              {getProviderInitial(
                editingProvider.alias,
                editingProvider.type || (isEmbeddingEditor ? 'openai' : 'claude'),
              )}
            </span>
            <div>
              <div className="provider-editor-kicker">
                {editingProvider.id ? '编辑 AI Provider' : '新增 AI Provider'}
              </div>
              <h3>
                {editingProvider.id
                  ? editingProvider.alias || '未命名 Provider'
                  : isEmbeddingEditor
                    ? '新增 Embedding Provider'
                    : '新增 LLM Provider'}
              </h3>
              <p className="provider-editor-description">
                这里编辑的是全屏配置工作区，不再依附于设置卡片。连接信息、模型参数、共享范围和高级请求头都在同一处完成。
              </p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setEditingProvider(null)}
            aria-label={t('settings.providers.关闭_Provider_弹窗')}
            title={t('settings.providers.关闭')}
          >
            ×
          </button>
        </div>

        <div className="provider-editor-layout">
          <section className="provider-editor-section">
            <div className="provider-editor-section-head">
              <div>
                <h4>基础信息</h4>
                <p>定义 Provider 名称、能力类型与可见范围。</p>
              </div>
              <div className="settings-provider-pill-group">
                <span className="settings-provider-pill">
                  {isEmbeddingEditor ? 'Embedding' : 'LLM'}
                </span>
                <span className="settings-provider-pill subtle">
                  {providerSourceLabel(editingProvider.source)}
                </span>
              </div>
            </div>
            <div className="provider-editor-grid">
              <div className="form-group">
                <label>{t('settings.providers.6dc7a7')}</label>
                <input
                  value={editingProvider.alias || ''}
                  onChange={(event) =>
                    setEditingProvider({
                      ...editingProvider,
                      alias: event.target.value,
                    })
                  }
                  placeholder={t('settings.providers.如_我的Claude')}
                />
              </div>
              <div className="form-group">
                <label>{t('settings.providers.89acdd')}</label>
                <NcSelect
                  value={(editingProvider.capability || 'llm') as 'llm' | 'embedding'}
                  onChange={(event) =>
                    setEditingProvider((prev) =>
                      prev
                        ? {
                            ...prev,
                            capability: event.target.value as 'llm' | 'embedding',
                            type:
                              event.target.value === 'embedding' ? 'openai' : 'claude',
                            dimensions:
                              event.target.value === 'embedding' ? 1536 : null,
                            is_default:
                              event.target.value === 'embedding'
                                ? 0
                                : prev.is_default,
                          }
                        : prev,
                    )
                  }
                  className="nc-select-full"
                  aria-label={t('settings.providers.Provider_能力')}
                >
                  <option value="llm">LLM</option>
                  <option value="embedding">Embedding</option>
                </NcSelect>
              </div>
              <div className="form-group">
                <label>{t('settings.providers.226b09')}</label>
                <NcSelect
                  value={
                    editingProvider.type || (isEmbeddingEditor ? 'openai' : 'claude')
                  }
                  onChange={(event) =>
                    setEditingProvider((prev) =>
                      prev
                        ? { ...prev, type: event.target.value }
                        : prev,
                    )
                  }
                  className="nc-select-full"
                  aria-label={t('settings.providers.Provider_类型')}
                >
                  {isEmbeddingEditor ? (
                    <>
                      <option value="openai">OpenAI</option>
                      <option value="zhipu">{t('settings.providers.8c979b')}</option>
                      <option value="ollama">Ollama Embedding</option>
                    </>
                  ) : (
                    <>
                      <option value="claude">Claude (Anthropic)</option>
                      <option value="codex">Codex (OpenAI)</option>
                      <option value="openai">OpenAI</option>
                      <option value="zhipu">{t('settings.providers.ce27ed')}</option>
                      <option value="gemini">Gemini (Google)</option>
                      <option value="cursor">Cursor API</option>
                      <option value="openai_compatible">
                        {t('settings.providers.1d8923')}
                      </option>
                    </>
                  )}
                </NcSelect>
              </div>
              {hasSystemSettings &&
              (!editingProvider.id || editingProvider.source === 'system') ? (
                <div className="form-group">
                  <label>{t('settings.providers.可见性')}</label>
                  <NcSelect
                    value={editingProvider.visibility || 'public'}
                    onChange={(event) =>
                      setEditingProvider((prev) =>
                        prev
                          ? {
                              ...prev,
                              visibility: event.target.value,
                              role_ids: undefined,
                              user_ids: undefined,
                            }
                          : prev,
                      )
                    }
                    className="nc-select-full"
                    aria-label={t('settings.providers.Provider_可见性')}
                  >
                    <option value="public">{t('settings.providers.92106d')}</option>
                    <option value="private">{t('settings.providers.54c71b')}</option>
                    <option value="restricted">
                      {t('settings.providers.0cd015')}
                    </option>
                  </NcSelect>
                  <p className="nc-hint">{t('settings.providers.775366')}</p>
                </div>
              ) : null}
            </div>
          </section>

          <section className="provider-editor-section">
            <div className="provider-editor-section-head">
              <div>
                <h4>连接与模型</h4>
                <p>填写密钥、基地址和模型信息，保存后再执行连接测试。</p>
              </div>
            </div>
            {!isEmbeddingEditor && editingProvider.type === 'cursor' ? (
              <p className="nc-hint provider-editor-inline-hint">
                {t('settings.providers.b738a4')} API Key。{t('settings.providers.f51b04')}{' '}
                {t('settings.providers.61d8ef')}
              </p>
            ) : null}
            <div className="provider-editor-grid">
              <div className="form-group provider-editor-grid-span">
                <label>API Key</label>
                {renderSensitiveInput(
                  'provider:api_key',
                  editingProvider.api_key || '',
                  (nextValue) =>
                    setEditingProvider({
                      ...editingProvider,
                      api_key: nextValue,
                    }),
                  'sk-...',
                )}
              </div>
              <div className="form-group">
                <label>Base URL</label>
                <input
                  value={editingProvider.base_url || ''}
                  onChange={(event) =>
                    setEditingProvider({
                      ...editingProvider,
                      base_url: event.target.value,
                    })
                  }
                  placeholder="https://api.anthropic.com"
                />
              </div>
              <div className="form-group">
                <label>
                  {isEmbeddingEditor
                    ? t('settings.providers.Embedding_模型')
                    : t('settings.providers.auto_8000f1')}
                </label>
                <input
                  value={editingProvider.model || ''}
                  onChange={(event) =>
                    setEditingProvider({
                      ...editingProvider,
                      model: event.target.value,
                    })
                  }
                  placeholder={
                    isEmbeddingEditor
                      ? 'qwen3-embedding:8b'
                      : 'claude-sonnet-4-20250514'
                  }
                />
              </div>
              {isEmbeddingEditor ? (
                <div className="form-group">
                  <label>{t('settings.providers.060e90')}</label>
                  <input
                    type="number"
                    min={1}
                    value={editingProvider.dimensions ?? ''}
                    onChange={(event) =>
                      setEditingProvider({
                        ...editingProvider,
                        dimensions: event.target.value
                          ? Number(event.target.value)
                          : null,
                      })
                    }
                    placeholder={t('settings.providers.例如_1024_/_1536_/_4096')}
                  />
                </div>
              ) : (
                <div className="form-group">
                  <label>User-Agent</label>
                  <input
                    value={editingProvider.user_agent || ''}
                    onChange={(event) =>
                      setEditingProvider({
                        ...editingProvider,
                        user_agent: event.target.value,
                      })
                    }
                    placeholder={t('settings.providers.可选_例如_NanoClaw/1_0')}
                  />
                </div>
              )}
            </div>
          </section>

          {!isEmbeddingEditor ? (
            <section className="provider-editor-section provider-editor-section-full">
              <div className="provider-editor-section-head">
                <div>
                  <h4>高级请求头</h4>
                  <p>仅在兼容模式或代理链路需要额外 Header 时使用。</p>
                </div>
              </div>
              <div className="form-group">
                <label>{t('settings.providers.553e99')}</label>
                <textarea
                  value={editingProvider.custom_headers_text || ''}
                  onChange={(event) =>
                    setEditingProvider({
                      ...editingProvider,
                      custom_headers_text: event.target.value,
                    })
                  }
                  placeholder={t(
                    'settings.providers.可选_填写_JSON_对象_例如\\n{\\n_X-Client_portable-',
                  )}
                  rows={7}
                  spellCheck={false}
                />
                <p className="nc-hint">{t('settings.providers.a1eb5b')}</p>
              </div>
            </section>
          ) : null}

          {hasSystemSettings &&
          editingProvider.visibility === 'restricted' &&
          rolesLoaded ? (
            <section className="provider-editor-section">
              <div className="provider-editor-section-head">
                <div>
                  <h4>角色访问范围</h4>
                  <p>限制只有选中的角色或用户可见当前 Provider。</p>
                </div>
              </div>
              <div className="form-group">
                <label>{t('settings.providers.da8f62')}</label>
                <div className="role-checkbox-list">
                  {allRoles.length === 0 ? (
                    <p className="nc-hint">{t('settings.providers.4834da')}</p>
                  ) : null}
                  {allRoles.map((role) => (
                    <label key={role.id} className="role-checkbox-item">
                      <input
                        type="checkbox"
                        checked={selectedRoleIds.includes(role.id)}
                        onChange={() => toggleRole(role.id)}
                      />
                      <span className="role-checkbox-name">{role.name}</span>
                      {role.description ? (
                        <span className="role-checkbox-desc">{role.description}</span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {hasSystemSettings &&
          editingProvider.visibility === 'restricted' &&
          usersLoaded ? (
            <section className="provider-editor-section">
              <div className="provider-editor-section-head">
                <div>
                  <h4>用户访问范围</h4>
                  <p>可按用户进一步细化允许列表，禁用用户会自动不可选。</p>
                </div>
              </div>
              <div className="form-group">
                <label>{t('settings.providers.5f07f1')}</label>
                <div className="role-checkbox-list">
                  {allUsers.length === 0 ? (
                    <p className="nc-hint">{t('settings.providers.48a713')}</p>
                  ) : null}
                  {allUsers.map((user) => (
                    <label key={user.id} className="role-checkbox-item">
                      <input
                        type="checkbox"
                        checked={selectedUserIds.includes(user.id)}
                        onChange={() => toggleUser(user.id)}
                        disabled={user.status === 'disabled'}
                      />
                      <span className="role-checkbox-name">
                        {user.displayName || user.username}
                      </span>
                      <span className="role-checkbox-desc">{user.username}</span>
                    </label>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {editingProvider.id && editingProvider.source === 'own' ? (
            <section className="provider-editor-section provider-editor-section-full">
              <div className="provider-editor-section-head">
                <div>
                  <h4>共享给其他用户</h4>
                  <p>个人 Provider 可以按用户共享，不影响系统级 Provider 的权限策略。</p>
                </div>
              </div>
              <div className="form-group">
                <label>{t('settings.providers.005883')}</label>
                <input
                  value={shareSearchQuery}
                  onChange={(event) => setShareSearchQuery(event.target.value)}
                  placeholder={t('settings.providers.搜索用户名或昵称')}
                />
                {shareSearchLoading ||
                shareCandidates.length > 0 ||
                shareSearchQuery.trim().length >= 2 ? (
                  <div className="provider-share-candidates">
                    {shareSearchLoading ? (
                      <div className="provider-share-candidate muted">
                        {t('settings.providers.c91155')}
                      </div>
                    ) : null}
                    {!shareSearchLoading && shareCandidates.length === 0 ? (
                      <div className="provider-share-candidate muted">
                        {t('settings.providers.c0e50c')}
                      </div>
                    ) : null}
                    {!shareSearchLoading
                      ? shareCandidates.map((user) => (
                          <button
                            key={user.id}
                            type="button"
                            className="provider-share-candidate"
                            onClick={() => shareProviderToUser(user.id)}
                            disabled={user.status === 'disabled'}
                          >
                            <span className="role-checkbox-name">
                              {user.displayName || user.username}
                            </span>
                            <span className="role-checkbox-desc">{user.username}</span>
                          </button>
                        ))
                      : null}
                  </div>
                ) : null}
                <div className="provider-share-row">
                  <input
                    value={shareTargetUserId}
                    onChange={(event) => setShareTargetUserId(event.target.value)}
                    placeholder={t('settings.providers.或直接输入目标用户_ID')}
                  />
                  <button
                    type="button"
                    className="btn-outline btn-sm"
                    onClick={shareProvider}
                    disabled={!shareTargetUserId.trim()}
                  >
                    {t('settings.providers.c31f48')}
                  </button>
                </div>
                <div className="role-checkbox-list">
                  {providerShares.length === 0 ? (
                    <p className="nc-hint">{t('settings.providers.636f0b')}</p>
                  ) : null}
                  {providerShares.map((share) => (
                    <div key={share.user_id} className="role-checkbox-item">
                      <span className="role-checkbox-name">
                        {share.display_name || share.username || share.user_id}
                      </span>
                      <span className="role-checkbox-desc">{share.user_id}</span>
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        onClick={() => revokeProviderShare(share.user_id)}
                      >
                        {t('settings.providers.bd9fcf')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {!isEmbeddingEditor ? (
            <section className="provider-editor-section provider-editor-section-full">
              {renderBooleanField(
                'provider:is_default',
                t('settings.providers.设为默认'),
                t('settings.providers.保存后将作为当前默认_AI_Provider'),
                !!editingProvider.is_default,
                (nextValue) =>
                  setEditingProvider({
                    ...editingProvider,
                    is_default: nextValue ? 1 : 0,
                  }),
              )}
            </section>
          ) : null}

          {hasSystemSettings &&
          !isEmbeddingEditor &&
          editingProvider.id &&
          editingProvider.source === 'system' ? (
            <section className="provider-editor-section provider-editor-section-full">
              <div className="provider-editor-section-head">
                <div>
                  <h4>系统默认</h4>
                  <p>这个入口只对管理员显示，用来设置新会话默认使用的系统模型。</p>
                </div>
              </div>
              <div className="provider-editor-admin-actions">
                {editingProvider.is_global_default ? (
                  <span className="settings-provider-pill is-accent">
                    当前系统默认
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => activateGlobalProvider(editingProvider.id as string)}
                  >
                    设为系统默认
                  </button>
                )}
              </div>
            </section>
          ) : null}
        </div>

        <div className="modal-actions provider-editor-actions">
          <button className="btn-outline" onClick={() => setEditingProvider(null)}>
            {t('settings.providers.625fb2')}
          </button>
          <button
            className="btn-primary"
            onClick={saveProvider}
            disabled={!editingProvider.alias || !editingProvider.type}
          >
            {editingProvider.id
              ? t('settings.subagent.保存修改')
              : t('settings.extensions.保存')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SettingsProvidersTab(props: SettingsProvidersTabProps) {
  const { t } = useTranslation('settings');
  const {
    apiBase,
    setEditingProvider,
    providers,
    testResults,
    testProvider,
    testingId,
    activateProvider,
    activateGlobalProvider,
    deleteProviderById,
    editingProvider,
    saveProvider,
    renderSensitiveInput,
    hasSystemSettings,
  } = props;

  const [allRoles, setAllRoles] = useState<RoleRecord[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [allUsers, setAllUsers] = useState<ProviderGrantUserRecord[]>([]);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [providerShares, setProviderShares] = useState<ProviderShareRecord[]>([]);
  const [shareTargetUserId, setShareTargetUserId] = useState('');
  const [shareSearchQuery, setShareSearchQuery] = useState('');
  const [shareCandidates, setShareCandidates] = useState<ProviderShareCandidate[]>(
    [],
  );
  const [shareSearchLoading, setShareSearchLoading] = useState(false);

  const loadRoles = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/roles`);
      if (res.ok) {
        const data = await res.json();
        setAllRoles(data.roles || []);
      }
    } catch {
      /* offline */
    }
    setRolesLoaded(true);
  }, [apiBase]);

  const loadUsers = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/users`);
      if (res.ok) {
        const data = await res.json();
        const users = Array.isArray(data.users)
          ? data.users
              .filter((entry: unknown): entry is Record<string, unknown> =>
                !!entry &&
                typeof entry === 'object' &&
                typeof (entry as { id?: unknown }).id === 'string' &&
                typeof (entry as { username?: unknown }).username === 'string',
              )
              .map((entry: Record<string, unknown>) => ({
                id: String(entry.id),
                username: String(entry.username),
                displayName:
                  typeof entry.display_name === 'string'
                    ? entry.display_name
                    : typeof entry.displayName === 'string'
                      ? entry.displayName
                      : null,
                status: typeof entry.status === 'string' ? entry.status : 'active',
              }))
          : [];
        setAllUsers(users);
      }
    } catch {
      /* offline */
    }
    setUsersLoaded(true);
  }, [apiBase]);

  const loadProviderRoles = useCallback(
    async (providerId: string) => {
      try {
        const res = await fetch(`${apiBase}/api/ai-providers/${providerId}/roles`);
        if (res.ok) {
          const list: Array<{ role_id: string }> = await res.json();
          setEditingProvider((prev) =>
            prev ? { ...prev, role_ids: list.map((role) => role.role_id) } : prev,
          );
        }
      } catch {
        /* offline */
      }
    },
    [apiBase, setEditingProvider],
  );

  const loadProviderUsers = useCallback(
    async (providerId: string) => {
      try {
        const res = await fetch(`${apiBase}/api/ai-providers/${providerId}/users`);
        if (res.ok) {
          const list: Array<{ user_id: string }> = await res.json();
          setEditingProvider((prev) =>
            prev ? { ...prev, user_ids: list.map((user) => user.user_id) } : prev,
          );
        }
      } catch {
        /* offline */
      }
    },
    [apiBase, setEditingProvider],
  );

  const loadProviderShares = useCallback(
    async (providerId: string) => {
      try {
        const res = await fetch(`${apiBase}/api/user/providers/${providerId}/shares`);
        if (res.ok) {
          setProviderShares((await res.json()) as ProviderShareRecord[]);
        }
      } catch {
        /* offline */
      }
    },
    [apiBase],
  );

  useEffect(() => {
    if (!editingProvider) {
      setRolesLoaded(false);
      setUsersLoaded(false);
      setProviderShares([]);
      setShareTargetUserId('');
      setShareSearchQuery('');
      setShareCandidates([]);
      return;
    }
    if (hasSystemSettings && !rolesLoaded) {
      void loadRoles();
    }
    if (hasSystemSettings && !usersLoaded) {
      void loadUsers();
    }
    if (
      editingProvider.id &&
      editingProvider.visibility === 'restricted' &&
      !editingProvider.role_ids
    ) {
      void loadProviderRoles(editingProvider.id);
    }
    if (
      editingProvider.id &&
      editingProvider.visibility === 'restricted' &&
      !editingProvider.user_ids
    ) {
      void loadProviderUsers(editingProvider.id);
    }
    if (editingProvider.id && editingProvider.source === 'own') {
      void loadProviderShares(editingProvider.id);
    }
  }, [
    editingProvider,
    hasSystemSettings,
    loadProviderRoles,
    loadProviderShares,
    loadProviderUsers,
    loadRoles,
    loadUsers,
    rolesLoaded,
    usersLoaded,
  ]);

  useEffect(() => {
    if (!editingProvider || typeof document === 'undefined') return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEditingProvider(null);
      }
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [editingProvider, setEditingProvider]);

  const selectedRoleIds = editingProvider?.role_ids ?? [];
  const selectedUserIds = editingProvider?.user_ids ?? [];

  const llmProviders = useMemo(
    () => providers.filter((provider) => (provider.capability || 'llm') === 'llm'),
    [providers],
  );
  const embeddingProviders = useMemo(
    () =>
      providers.filter(
        (provider) => (provider.capability || 'llm') === 'embedding',
      ),
    [providers],
  );
  const editingCapability = (editingProvider?.capability || 'llm') as
    | 'llm'
    | 'embedding';
  const isEmbeddingEditor = editingCapability === 'embedding';

  const toggleRole = useCallback(
    (roleId: string) => {
      setEditingProvider((prev) => {
        if (!prev) return prev;
        const current = prev.role_ids ?? [];
        const next = current.includes(roleId)
          ? current.filter((id) => id !== roleId)
          : [...current, roleId];
        return { ...prev, role_ids: next };
      });
    },
    [setEditingProvider],
  );

  const toggleUser = useCallback(
    (userId: string) => {
      setEditingProvider((prev) => {
        if (!prev) return prev;
        const current = prev.user_ids ?? [];
        const next = current.includes(userId)
          ? current.filter((id) => id !== userId)
          : [...current, userId];
        return { ...prev, user_ids: next };
      });
    },
    [setEditingProvider],
  );

  const openProviderEditor = useCallback(
    (provider: Partial<AiProvider>) => {
      setEditingProvider({
        ...provider,
        custom_headers_text:
          provider.custom_headers &&
          Object.keys(provider.custom_headers).length > 0
            ? JSON.stringify(provider.custom_headers, null, 2)
            : '',
      });
    },
    [setEditingProvider],
  );

  const openNewProviderEditor = useCallback(
    (capability: 'llm' | 'embedding') => {
      setEditingProvider({
        capability,
        type: capability === 'embedding' ? 'openai' : 'claude',
        alias: '',
        api_key: '',
        base_url: '',
        model: '',
        dimensions: capability === 'embedding' ? 1536 : null,
        user_agent: '',
        custom_headers: null,
        visibility: hasSystemSettings ? 'public' : 'private',
        source: hasSystemSettings ? 'system' : 'own',
      });
    },
    [hasSystemSettings, setEditingProvider],
  );

  const shareProvider = useCallback(async () => {
    const providerId = editingProvider?.id;
    const target = shareTargetUserId.trim();
    if (!providerId || !target) return;
    const res = await fetch(`${apiBase}/api/user/providers/${providerId}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: target }),
    });
    if (res.ok) {
      setShareTargetUserId('');
      setShareSearchQuery('');
      setShareCandidates([]);
      await loadProviderShares(providerId);
    }
  }, [apiBase, editingProvider?.id, loadProviderShares, shareTargetUserId]);

  const shareProviderToUser = useCallback(
    async (targetUserId: string) => {
      const providerId = editingProvider?.id;
      const target = targetUserId.trim();
      if (!providerId || !target) return;
      const res = await fetch(
        `${apiBase}/api/user/providers/${providerId}/shares`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: target }),
        },
      );
      if (res.ok) {
        setShareTargetUserId('');
        setShareSearchQuery('');
        setShareCandidates([]);
        await loadProviderShares(providerId);
      }
    },
    [apiBase, editingProvider?.id, loadProviderShares],
  );

  const revokeProviderShare = useCallback(
    async (targetUserId: string) => {
      const providerId = editingProvider?.id;
      if (!providerId) return;
      const res = await fetch(
        `${apiBase}/api/user/providers/${providerId}/shares/${targetUserId}`,
        {
          method: 'DELETE',
        },
      );
      if (res.ok) {
        await loadProviderShares(providerId);
      }
    },
    [apiBase, editingProvider?.id, loadProviderShares],
  );

  useEffect(() => {
    if (!editingProvider?.id || editingProvider.source !== 'own') return;
    const query = shareSearchQuery.trim();
    if (query.length < 2) {
      setShareCandidates([]);
      setShareSearchLoading(false);
      return;
    }
    let cancelled = false;
    setShareSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `${apiBase}/api/im/users/search?q=${encodeURIComponent(query)}&limit=8`,
        );
        if (!res.ok) {
          if (!cancelled) setShareCandidates([]);
          return;
        }
        const data = await res.json();
        const sharedIds = new Set(providerShares.map((share) => share.user_id));
        const users = Array.isArray(data.users)
          ? data.users
              .filter((entry: unknown): entry is Record<string, unknown> =>
                !!entry &&
                typeof entry === 'object' &&
                typeof (entry as { id?: unknown }).id === 'string' &&
                typeof (entry as { username?: unknown }).username === 'string',
              )
              .map((entry: Record<string, unknown>): ProviderShareCandidate => ({
                id: String(entry.id),
                username: String(entry.username),
                displayName:
                  typeof entry.display_name === 'string'
                    ? entry.display_name
                    : typeof entry.displayName === 'string'
                      ? entry.displayName
                      : null,
                email: typeof entry.email === 'string' ? entry.email : null,
                status: typeof entry.status === 'string' ? entry.status : 'active',
              }))
              .filter((entry: ProviderShareCandidate) => !sharedIds.has(entry.id))
          : [];
        if (!cancelled) setShareCandidates(users);
      } catch {
        if (!cancelled) setShareCandidates([]);
      } finally {
        if (!cancelled) setShareSearchLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    apiBase,
    editingProvider?.id,
    editingProvider?.source,
    providerShares,
    shareSearchQuery,
  ]);

  const renderProviderList = (
    title: string,
    groupProviders: AiProvider[],
    emptyText: string,
  ) => (
    <section className="settings-provider-group">
      <div className="settings-provider-group-head">
        <h4>{title}</h4>
      </div>
      <div className="settings-provider-grid">
        {groupProviders.length === 0 ? (
          <div className="provider-empty settings-provider-empty">{emptyText}</div>
        ) : null}
        {groupProviders.map((provider) => {
          const status = buildProviderStatus(
            provider,
            testResults[provider.id],
            testingId === provider.id,
          );
          return (
            <article key={provider.id} className="settings-provider-card-v2 nc-library-card">
              <button
                type="button"
                className={`settings-provider-card-hitarea${
                  provider.source === 'shared' ? ' is-readonly' : ''
                }`}
                onClick={() => {
                  if (provider.source !== 'shared') {
                    openProviderEditor(provider);
                  }
                }}
                disabled={provider.source === 'shared'}
              >
                <div className="settings-provider-card-head nc-library-card-header">
                  <span
                    className={`settings-provider-avatar tone-${getProviderTypeTone(
                      provider.type,
                    )}`}
                    aria-hidden="true"
                  >
                    {getProviderInitial(provider.alias, provider.type)}
                  </span>
                  <div className="settings-provider-card-titleblock">
                    <div className="settings-provider-row-titleline settings-provider-library-titleline">
                      <strong className="settings-provider-row-title">
                        {provider.alias || '未命名 Provider'}
                      </strong>
                      {provider.is_user_default ? (
                        <span className="settings-provider-pill is-accent">
                          默认
                        </span>
                      ) : null}
                    </div>
                    <div className="settings-provider-row-tagline">
                      <span
                        className={`settings-provider-status tone-${status.tone}`}
                      >
                        {status.label}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="repository-tags settings-provider-card-tags">
                  <span className="repository-tag">
                    {getProviderTypeLabel(provider.type)}
                  </span>
                  <span className="repository-tag">
                    {providerVisibilityBadgeLabel(provider.visibility)}
                  </span>
                  <span className="repository-tag">
                    {providerSourceLabel(provider.source)}
                  </span>
                  {provider.capability === 'embedding' && provider.dimensions ? (
                    <span className="repository-tag">{provider.dimensions}D</span>
                  ) : null}
                </div>

                <div className="settings-provider-card-content repository-field-grid">
                  <div className="settings-provider-fact repository-field settings-provider-fact--primary">
                    <span className="settings-provider-fact-label">模型</span>
                    <span className="settings-provider-fact-value">
                      {provider.model ||
                        (provider.capability === 'embedding'
                          ? '未配置向量模型'
                          : '未配置对话模型')}
                      </span>
                  </div>
                  <div className="settings-provider-fact repository-field">
                    <span className="settings-provider-fact-label">接入地址</span>
                    <span className="settings-provider-fact-value">
                      {provider.base_url || '默认接入地址'}
                    </span>
                  </div>
                </div>
              </button>

              {testResults[provider.id] ? (
                <div
                  className={`test-result ${
                    testResults[provider.id].ok ? 'success' : 'error'
                  } settings-provider-test-result`}
                >
                  {testResults[provider.id].ok ? '✓' : '✗'}{' '}
                  {testResults[provider.id].message}
                  {testResults[provider.id].latencyMs !== undefined
                    ? ` (${testResults[provider.id].latencyMs}ms)`
                    : ''}
                </div>
              ) : null}

              <div className="settings-provider-card-actions settings-provider-card-actions--library">
                <button
                  className="btn-outline btn-sm"
                  onClick={() => testProvider(provider.id)}
                  disabled={testingId === provider.id}
                >
                  {testingId === provider.id
                    ? t('settings.providers.698c06')
                    : t('settings.providers.18f00c')}
                </button>
                {provider.capability === 'llm' && provider.source !== 'shared' ? (
                  <button
                    className={`btn-sm settings-provider-action ${
                      provider.is_user_default
                        ? 'settings-provider-action--current'
                        : 'settings-provider-action--user'
                    }`}
                    onClick={() => {
                      if (!provider.is_user_default) activateProvider(provider.id);
                    }}
                    disabled={provider.is_user_default}
                  >
                    默认
                  </button>
                ) : null}
                {provider.source !== 'shared' ? (
                  <button
                    className="btn-danger btn-sm"
                    onClick={() => deleteProviderById(provider.id)}
                  >
                    {t('settings.extensions.2f4aad')}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );

  return (
    <div className="settings-providers-shell">
      <div className="settings-provider-toolbar settings-provider-toolbar--bare">
        <div className="settings-provider-toolbar-actions">
          <button
            className="btn-glass btn-sm"
            onClick={() => openNewProviderEditor('llm')}
          >
            + {t('settings.providers.efe931')}
          </button>
          <button
            className="btn-outline btn-sm"
            onClick={() => openNewProviderEditor('embedding')}
          >
            + {t('settings.providers.bfe80f')}
          </button>
        </div>
      </div>

      {renderProviderList(
        '对话模型',
        llmProviders,
        t('settings.providers.c11ae5'),
      )}
      {renderProviderList(
        'Embedding 模型',
        embeddingProviders,
        t('settings.providers.ccd3ee'),
      )}

      {editingProvider ? (
        <ProviderEditorModal
          t={t}
          editingProvider={editingProvider}
          setEditingProvider={setEditingProvider}
          saveProvider={saveProvider}
          activateGlobalProvider={activateGlobalProvider}
          renderSensitiveInput={renderSensitiveInput}
          hasSystemSettings={hasSystemSettings}
          isEmbeddingEditor={isEmbeddingEditor}
          selectedRoleIds={selectedRoleIds}
          selectedUserIds={selectedUserIds}
          rolesLoaded={rolesLoaded}
          usersLoaded={usersLoaded}
          allRoles={allRoles}
          allUsers={allUsers}
          toggleRole={toggleRole}
          toggleUser={toggleUser}
          shareSearchQuery={shareSearchQuery}
          setShareSearchQuery={setShareSearchQuery}
          shareSearchLoading={shareSearchLoading}
          shareCandidates={shareCandidates}
          shareProviderToUser={shareProviderToUser}
          shareTargetUserId={shareTargetUserId}
          setShareTargetUserId={setShareTargetUserId}
          shareProvider={shareProvider}
          providerShares={providerShares}
          revokeProviderShare={revokeProviderShare}
        />
      ) : null}
    </div>
  );
}
