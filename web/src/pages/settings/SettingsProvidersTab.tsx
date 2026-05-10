
import { useCallback, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
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
    clearDefaultProvider,
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
  const [shareCandidates, setShareCandidates] = useState<ProviderShareCandidate[]>([]);
  const [shareSearchLoading, setShareSearchLoading] = useState(false);

  const loadRoles = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/roles`);
      if (res.ok) {
        const data = await res.json();
        setAllRoles(data.roles || []);
      }
    } catch { /* offline */ }
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
    } catch { /* offline */ }
    setUsersLoaded(true);
  }, [apiBase]);

  const loadProviderRoles = useCallback(async (providerId: string) => {
    try {
      const res = await fetch(`${apiBase}/api/ai-providers/${providerId}/roles`);
      if (res.ok) {
        const list: Array<{ role_id: string }> = await res.json();
        setEditingProvider((prev) =>
          prev ? { ...prev, role_ids: list.map((r) => r.role_id) } : prev,
        );
      }
    } catch { /* offline */ }
  }, [apiBase, setEditingProvider]);

  const loadProviderUsers = useCallback(async (providerId: string) => {
    try {
      const res = await fetch(`${apiBase}/api/ai-providers/${providerId}/users`);
      if (res.ok) {
        const list: Array<{ user_id: string }> = await res.json();
        setEditingProvider((prev) =>
          prev ? { ...prev, user_ids: list.map((u) => u.user_id) } : prev,
        );
      }
    } catch { /* offline */ }
  }, [apiBase, setEditingProvider]);

  const loadProviderShares = useCallback(async (providerId: string) => {
    try {
      const res = await fetch(`${apiBase}/api/user/providers/${providerId}/shares`);
      if (res.ok) {
        setProviderShares(await res.json() as ProviderShareRecord[]);
      }
    } catch { /* offline */ }
  }, [apiBase]);

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
    if (editingProvider.id && editingProvider.visibility === 'restricted' && !editingProvider.role_ids) {
      void loadProviderRoles(editingProvider.id);
    }
    if (editingProvider.id && editingProvider.visibility === 'restricted' && !editingProvider.user_ids) {
      void loadProviderUsers(editingProvider.id);
    }
    if (editingProvider.id && editingProvider.source === 'own') {
      void loadProviderShares(editingProvider.id);
    }
  }, [
    editingProvider,
    hasSystemSettings,
    rolesLoaded,
    usersLoaded,
    loadRoles,
    loadUsers,
    loadProviderRoles,
    loadProviderUsers,
    loadProviderShares,
  ]);

  const selectedRoleIds = editingProvider?.role_ids ?? [];
  const selectedUserIds = editingProvider?.user_ids ?? [];
  const llmProviders = providers.filter((provider) => (provider.capability || 'llm') === 'llm');
  const embeddingProviders = providers.filter((provider) => (provider.capability || 'llm') === 'embedding');
  const editingCapability = (editingProvider?.capability || 'llm') as 'llm' | 'embedding';
  const isEmbeddingEditor = editingCapability === 'embedding';
  const toggleRole = useCallback((roleId: string) => {
    setEditingProvider((prev) => {
      if (!prev) return prev;
      const current = prev.role_ids ?? [];
      const next = current.includes(roleId)
        ? current.filter((id) => id !== roleId)
        : [...current, roleId];
      return { ...prev, role_ids: next };
    });
  }, [setEditingProvider]);

  const toggleUser = useCallback((userId: string) => {
    setEditingProvider((prev) => {
      if (!prev) return prev;
      const current = prev.user_ids ?? [];
      const next = current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId];
      return { ...prev, user_ids: next };
    });
  }, [setEditingProvider]);

  const openProviderEditor = useCallback((provider: Partial<AiProvider>) => {
    setEditingProvider({
      ...provider,
      custom_headers_text:
        provider.custom_headers && Object.keys(provider.custom_headers).length > 0
          ? JSON.stringify(provider.custom_headers, null, 2)
          : '',
    });
  }, [setEditingProvider]);

  const openNewProviderEditor = useCallback((capability: 'llm' | 'embedding') => {
    openProviderEditor({
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
  }, [hasSystemSettings, openProviderEditor]);

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

  const shareProviderToUser = useCallback(async (targetUserId: string) => {
    const providerId = editingProvider?.id;
    const target = targetUserId.trim();
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
  }, [apiBase, editingProvider?.id, loadProviderShares]);

  const revokeProviderShare = useCallback(async (targetUserId: string) => {
    const providerId = editingProvider?.id;
    if (!providerId) return;
    const res = await fetch(`${apiBase}/api/user/providers/${providerId}/shares/${targetUserId}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      await loadProviderShares(providerId);
    }
  }, [apiBase, editingProvider?.id, loadProviderShares]);

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

  return (
  <div className="settings-section">
    <div className="section-header">
      <h3>{t('settings.providers.1a10d1')}</h3>
      <div className="settings-save-row">
        <button
          className="btn-primary btn-sm"
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

    <div className="settings-subsection">
      <h4>LLM Provider</h4>
      <div className="provider-cards">
      {llmProviders.map((provider) => (
        <div
          key={provider.id}
          className={`provider-card ${provider.is_user_default || provider.is_default ? 'default' : ''}`}
        >
          <div className="provider-card-header">
            <span className="provider-alias">{provider.alias}</span>
            <span
              className={`provider-visibility-tag visibility-${provider.visibility || 'public'}`}
              title={t('settings.providers.可见性')}
            >
              {providerVisibilityBadgeLabel(provider.visibility)}
            </span>
            <span className={`provider-type-tag ${provider.type}`}>
              {provider.type}
            </span>
            {provider.source === 'shared' ? (
              <span className="provider-type-tag">{t('settings.providers.c31f48')}</span>
            ) : null}
            {provider.is_user_default || provider.is_default ? (
              <span className="default-tag">{t('settings.providers.18c634')}</span>
            ) : null}
          </div>
          <div className="provider-card-body">
            <div className="provider-field">
              <span className="field-label">{t('settings.providers.auto_8000f1')}</span>{' '}
              <span className="field-value">
                {provider.model || '-'}
              </span>
            </div>
            <div className="provider-field">
              <span className="field-label">Base URL</span>{' '}
              <span className="field-value">
                {provider.base_url || '-'}
              </span>
            </div>
            <div className="provider-field">
              <span className="field-label">API Key</span>{' '}
              <span className="field-value mono">
                {provider.api_key || '-'}
              </span>
            </div>
          </div>
          {testResults[provider.id] && (
            <div
              className={`test-result ${testResults[provider.id].ok ? 'success' : 'error'}`}
            >
              {testResults[provider.id].ok ? '✓' : '✗'}{' '}
              {testResults[provider.id].message}
              {testResults[provider.id].latencyMs !== undefined &&
                ` (${testResults[provider.id].latencyMs}ms)`}
            </div>
          )}
          <div className="provider-card-actions">
            <button
              className="btn-outline btn-sm"
              onClick={() => testProvider(provider.id)}
              disabled={testingId === provider.id}
            >
              {testingId === provider.id ? t('settings.providers.698c06') : t('settings.providers.18f00c')}
            </button>
            {!provider.is_user_default && (
              <button
                className="btn-outline btn-sm"
                onClick={() => activateProvider(provider.id)}
              >
                {t('settings.providers.55ab49')}
              </button>
            )}
            {provider.is_user_default && (
              <button
                className="btn-outline btn-sm"
                onClick={() => clearDefaultProvider()}
              >
                {t('settings.providers.951d75')}
              </button>
            )}
            {hasSystemSettings &&
              provider.source === 'system' &&
              !provider.is_global_default && (
                <button
                  className="btn-outline btn-sm"
                  onClick={() => activateGlobalProvider(provider.id)}
                >
                  {t('settings.providers.a58bf0')}
                </button>
              )}
            {provider.source !== 'shared' && (
              <button
                className="btn-outline btn-sm"
                onClick={() => openProviderEditor(provider)}
              >
                {t('settings.providers.95b351')}
              </button>
            )}
            {provider.source !== 'shared' && (
              <button
                className="btn-danger btn-sm"
                onClick={() => deleteProviderById(provider.id)}
              >
                {t('settings.extensions.2f4aad')}
              </button>
            )}
          </div>
        </div>
      ))}
      {llmProviders.length === 0 && (
        <div className="provider-empty">
          {t('settings.providers.c11ae5')}
        </div>
      )}
      </div>
    </div>

    <div className="settings-subsection">
      <h4>Embedding Provider</h4>
      <div className="provider-cards">
      {embeddingProviders.map((provider) => (
        <div
          key={provider.id}
          className="provider-card"
        >
          <div className="provider-card-header">
            <span className="provider-alias">{provider.alias}</span>
            <span
              className={`provider-visibility-tag visibility-${provider.visibility || 'public'}`}
              title={t('settings.providers.可见性')}
            >
              {providerVisibilityBadgeLabel(provider.visibility)}
            </span>
            <span className={`provider-type-tag ${provider.type}`}>
              {provider.type}
            </span>
            <span className="provider-type-tag">embedding</span>
            {provider.source === 'shared' ? (
              <span className="provider-type-tag">{t('settings.providers.c31f48')}</span>
            ) : null}
          </div>
          <div className="provider-card-body">
            <div className="provider-field">
              <span className="field-label">{t('settings.providers.auto_8000f1')}</span>{' '}
              <span className="field-value">
                {provider.model || '-'}
              </span>
            </div>
            <div className="provider-field">
              <span className="field-label">{t('settings.providers.f29c54')}</span>{' '}
              <span className="field-value">
                {provider.dimensions ?? '-'}
              </span>
            </div>
            <div className="provider-field">
              <span className="field-label">Base URL</span>{' '}
              <span className="field-value">
                {provider.base_url || '-'}
              </span>
            </div>
            <div className="provider-field">
              <span className="field-label">API Key</span>{' '}
              <span className="field-value mono">
                {provider.api_key || '-'}
              </span>
            </div>
          </div>
          {testResults[provider.id] && (
            <div
              className={`test-result ${testResults[provider.id].ok ? 'success' : 'error'}`}
            >
              {testResults[provider.id].ok ? '✓' : '✗'}{' '}
              {testResults[provider.id].message}
              {testResults[provider.id].latencyMs !== undefined &&
                ` (${testResults[provider.id].latencyMs}ms)`}
            </div>
          )}
          <div className="provider-card-actions">
            <button
              className="btn-outline btn-sm"
              onClick={() => testProvider(provider.id)}
              disabled={testingId === provider.id}
            >
              {testingId === provider.id ? t('settings.providers.698c06') : t('settings.providers.18f00c')}
            </button>
            {provider.source !== 'shared' && (
              <button
                className="btn-outline btn-sm"
                onClick={() => openProviderEditor(provider)}
              >
                {t('settings.providers.95b351')}
              </button>
            )}
            {provider.source !== 'shared' && (
              <button
                className="btn-danger btn-sm"
                onClick={() => deleteProviderById(provider.id)}
              >
                {t('settings.extensions.2f4aad')}
              </button>
            )}
          </div>
        </div>
      ))}
      {embeddingProviders.length === 0 && (
        <div className="provider-empty">
          {t('settings.providers.ccd3ee')}
        </div>
      )}
      </div>
    </div>

    {editingProvider && (
      <div className="modal-overlay modal-overlay-static">
        <div
          className="modal"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="modal-header">
            <h3>
              {editingProvider.id
                ? t('settings.providers.编辑${isEmbeddingEditor_Embedding_}_Provid', { param0: isEmbeddingEditor ? ' Embedding' : '' })
                : t('settings.providers.新增${isEmbeddingEditor_Embedding_}_Provid', { param0: isEmbeddingEditor ? ' Embedding' : '' })}
            </h3>
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
              value={editingCapability}
              onChange={(e) =>
                setEditingProvider((prev) =>
                  prev
                    ? {
                        ...prev,
                        capability: e.target.value as 'llm' | 'embedding',
                        type: e.target.value === 'embedding' ? 'openai' : 'claude',
                        dimensions: e.target.value === 'embedding' ? 1536 : null,
                        is_default: e.target.value === 'embedding' ? 0 : prev.is_default,
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
              value={editingProvider.type || (isEmbeddingEditor ? 'openai' : 'claude')}
              onChange={(e) =>
                setEditingProvider((prev) =>
                  prev
                    ? { ...prev, type: e.target.value }
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
          {!isEmbeddingEditor && editingProvider.type === 'cursor' && (
            <p className="nc-hint">
              {t('settings.providers.b738a4')}{' '}
              API Key。{t('settings.providers.f51b04')}{' '}
              {t('settings.providers.61d8ef')}
            </p>
          )}
          {hasSystemSettings &&
            (!editingProvider.id || editingProvider.source === 'system') && (
              <div className="form-group">
                <label>{t('settings.providers.可见性')}</label>
                <NcSelect
                  value={editingProvider.visibility || 'public'}
                  onChange={(e) =>
                    setEditingProvider((prev) =>
                      prev
                        ? {
                            ...prev,
                            visibility: e.target.value,
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
                <p className="nc-hint">
                  {t('settings.providers.775366')}
                </p>
              </div>
            )}
          {hasSystemSettings &&
            editingProvider.visibility === 'restricted' &&
            rolesLoaded && (
              <div className="form-group">
                <label>{t('settings.providers.da8f62')}</label>
                <div className="role-checkbox-list">
                  {allRoles.length === 0 && (
                    <p className="nc-hint">{t('settings.providers.4834da')}</p>
                  )}
                  {allRoles.map((role) => (
                    <label key={role.id} className="role-checkbox-item">
                      <input
                        type="checkbox"
                        checked={selectedRoleIds.includes(role.id)}
                        onChange={() => toggleRole(role.id)}
                      />
                      <span className="role-checkbox-name">{role.name}</span>
                      {role.description && (
                        <span className="role-checkbox-desc">{role.description}</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}
          {hasSystemSettings &&
            editingProvider.visibility === 'restricted' &&
            usersLoaded && (
              <div className="form-group">
                <label>{t('settings.providers.5f07f1')}</label>
                <div className="role-checkbox-list">
                  {allUsers.length === 0 && (
                    <p className="nc-hint">{t('settings.providers.48a713')}</p>
                  )}
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
            )}
          <div className="form-group">
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
            <label>{isEmbeddingEditor ? t('settings.providers.Embedding_模型') : t('settings.providers.auto_8000f1')}</label>
            <input
              value={editingProvider.model || ''}
              onChange={(event) =>
                setEditingProvider({
                  ...editingProvider,
                  model: event.target.value,
                })
              }
              placeholder={isEmbeddingEditor ? 'qwen3-embedding:8b' : 'claude-sonnet-4-20250514'}
            />
          </div>
          {isEmbeddingEditor && (
            <div className="form-group">
              <label>{t('settings.providers.060e90')}</label>
              <input
                type="number"
                min={1}
                value={editingProvider.dimensions ?? ''}
                onChange={(event) =>
                  setEditingProvider({
                    ...editingProvider,
                    dimensions: event.target.value ? Number(event.target.value) : null,
                  })
                }
                placeholder={t('settings.providers.例如_1024_/_1536_/_4096')}
              />
            </div>
          )}
          {!isEmbeddingEditor && (
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
          {!isEmbeddingEditor && (
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
                placeholder={t('settings.providers.可选_填写_JSON_对象_例如\\n{\\n_X-Client_portable-')}
                rows={7}
                spellCheck={false}
              />
              <p className="nc-hint">
                {t('settings.providers.a1eb5b')}
              </p>
            </div>
          )}
          {editingProvider.id && editingProvider.source === 'own' && (
            <div className="form-group">
              <label>{t('settings.providers.005883')}</label>
              <input
                value={shareSearchQuery}
                onChange={(event) => setShareSearchQuery(event.target.value)}
                placeholder={t('settings.providers.搜索用户名或昵称')}
              />
              {(shareSearchLoading || shareCandidates.length > 0 || shareSearchQuery.trim().length >= 2) && (
                <div className="provider-share-candidates">
                  {shareSearchLoading && (
                    <div className="provider-share-candidate muted">{t('settings.providers.c91155')}</div>
                  )}
                  {!shareSearchLoading && shareCandidates.length === 0 && (
                    <div className="provider-share-candidate muted">{t('settings.providers.c0e50c')}</div>
                  )}
                  {!shareSearchLoading && shareCandidates.map((user) => (
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
                      <span className="role-checkbox-desc">
                        {user.username}
                      </span>
                    </button>
                  ))}
                </div>
              )}
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
                {providerShares.length === 0 && (
                  <p className="nc-hint">{t('settings.providers.636f0b')}</p>
                )}
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
          )}
          {!isEmbeddingEditor &&
            renderBooleanField(
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
          <div className="modal-actions">
            <button
              className="btn-outline"
              onClick={() => setEditingProvider(null)}
            >
              {t('settings.providers.625fb2')}
            </button>
            <button
              className="btn-primary"
              onClick={saveProvider}
              disabled={!editingProvider.alias || !editingProvider.type}
            >
              {editingProvider.id ? t('settings.subagent.保存修改') : t('settings.extensions.保存')}
            </button>
          </div>
        </div>
      </div>
    )}
  </div>

  );
}
