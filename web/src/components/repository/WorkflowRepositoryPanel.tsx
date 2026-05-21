import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ResourceBindingInfo, RepositoryInfo } from '../../app-types';
import {
  createResourceBinding,
  deleteResourceBinding,
  fetchRepositories,
  fetchResourceBindings,
} from './api';
import {
  buildWorkflowMainRepositoryBindingInput,
  getWorkflowMainRepositoryBinding,
} from './workflow-repository-panel-helpers';

interface RunnerProfileSummary {
  id: string;
  name: string;
  description?: string;
  required_tools?: string[];
}

interface WorkflowRepositoryPanelProps {
  apiBase: string;
  workflowId: string;
  canManage?: boolean;
  boundAssistantNames?: string[];
}

async function requireOk<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    let message = fallback;
    try {
      const data = (await response.json()) as { error?: string };
      if (typeof data.error === 'string' && data.error.trim()) {
        message = data.error;
      }
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return response.json();
}

export function WorkflowRepositoryPanel({
  apiBase,
  workflowId,
  canManage = false,
  boundAssistantNames = [],
}: WorkflowRepositoryPanelProps) {
  const { t } = useTranslation('repoReview');
  const [bindings, setBindings] = useState<ResourceBindingInfo[]>([]);
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);
  const [runnerProfiles, setRunnerProfiles] = useState<RunnerProfileSummary[]>(
    [],
  );
  const [currentProfileId, setCurrentProfileId] = useState<string | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [branchInput, setBranchInput] = useState('');
  const [profileDraft, setProfileDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingBinding, setSavingBinding] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextBindings, nextRepos, nextProfiles] = await Promise.all([
        fetchResourceBindings('workflow', workflowId),
        fetchRepositories(),
        fetch(`${apiBase}/api/workflows/runner-profiles`).then((response) =>
          requireOk<RunnerProfileSummary[]>(response, t('workflow.loadRunnerProfileFailed')),
        ),
      ]);

      const mainBinding = getWorkflowMainRepositoryBinding(nextBindings);
      const nextProfileId = mainBinding
        ? await fetch(
            `${apiBase}/api/workflows/repositories/${encodeURIComponent(
              mainBinding.resourceId,
            )}/runner-profile`,
          ).then((response) =>
            requireOk<{ profile_id: string | null }>(
              response,
              t('workflow.loadRepoRunnerProfileFailed'),
            ),
          )
        : { profile_id: null };

      setBindings(nextBindings);
      setRepositories(nextRepos);
      setRunnerProfiles(nextProfiles);
      setCurrentProfileId(nextProfileId.profile_id);
      setProfileDraft(nextProfileId.profile_id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('workflow.loadRepoSettingsFailed'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t, workflowId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mainBinding = useMemo(
    () => getWorkflowMainRepositoryBinding(bindings),
    [bindings],
  );
  const availableRepos = useMemo(
    () =>
      repositories.filter((repo) => repo.id !== mainBinding?.resourceId),
    [mainBinding?.resourceId, repositories],
  );
  const selectedProfile = useMemo(
    () =>
      currentProfileId
        ? runnerProfiles.find((profile) => profile.id === currentProfileId) ||
          null
        : null,
    [currentProfileId, runnerProfiles],
  );

  const handleSaveBinding = useCallback(async () => {
    if (!selectedRepoId) return;
    setSavingBinding(true);
    setMessage('');
    setError('');
    try {
      const created = await createResourceBinding(
        buildWorkflowMainRepositoryBindingInput({
          ownerId: workflowId,
          repositoryId: selectedRepoId,
          branch: branchInput,
        }),
      );

      if (mainBinding && mainBinding.id !== created.id) {
        await deleteResourceBinding(mainBinding.id);
      }

      setSelectedRepoId('');
      setBranchInput('');
      setMessage(t('workflow.mainRepoUpdated'));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('workflow.saveMainRepoFailed'));
    } finally {
      setSavingBinding(false);
    }
  }, [branchInput, mainBinding, refresh, selectedRepoId, t, workflowId]);

  const handleRemoveBinding = useCallback(async () => {
    if (!mainBinding) return;
    setSavingBinding(true);
    setMessage('');
    setError('');
    try {
      await deleteResourceBinding(mainBinding.id);
      setCurrentProfileId(null);
      setProfileDraft('');
      setMessage(t('workflow.mainRepoUnbound'));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('workflow.unbindFailed'));
    } finally {
      setSavingBinding(false);
    }
  }, [mainBinding, refresh, t]);

  const handleSaveProfile = useCallback(async () => {
    if (!mainBinding) return;
    setSavingProfile(true);
    setMessage('');
    setError('');
    try {
      const repositoryId = encodeURIComponent(mainBinding.resourceId);
      const path = `${apiBase}/api/workflows/repositories/${repositoryId}/runner-profile`;
      if (!profileDraft) {
        await fetch(path, { method: 'DELETE' }).then((response) =>
          requireOk(response, t('workflow.clearRunnerProfileFailed')),
        );
      } else {
        await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile_id: profileDraft }),
        }).then((response) =>
          requireOk(response, t('workflow.saveRunnerProfileFailed')),
        );
      }
      setMessage(t('workflow.runnerProfileUpdated'));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('workflow.saveRunnerProfileFailed'));
    } finally {
      setSavingProfile(false);
    }
  }, [apiBase, mainBinding, profileDraft, refresh, t]);

  return (
    <div className="workteam-section">
      <h3>{t('workflow.mainRepo')}</h3>
      <p className="settings-hint">
        {t('workflow.mainRepoHint')}
      </p>

      {message ? <div className="settings-hint">{message}</div> : null}
      {error ? <div className="workteam-error">{error}</div> : null}

      {loading ? (
        <div className="settings-hint">{t('common.loading')}</div>
      ) : (
        <>
          <div className="assistant-validation-list" style={{ marginBottom: 12 }}>
            <div className="assistant-validation-item">
              <div className="assistant-validation-item-copy">
                <strong>{t('workflow.currentMainRepo')}</strong>
                <p>
                  {mainBinding
                    ? `${mainBinding.repositoryName || mainBinding.resourceId} · ${
                        mainBinding.branch || t('workflow.defaultBranch')
                      }`
                    : t('workflow.notSet')}
                </p>
              </div>
              {mainBinding && canManage ? (
                <div className="assistant-stage-actions">
                  <button
                    type="button"
                    className="btn-outline btn-sm"
                    disabled={savingBinding}
                    onClick={() => void handleRemoveBinding()}
                  >
                    {t('workflow.unbind')}
                  </button>
                </div>
              ) : null}
            </div>

            <div className="assistant-validation-item">
              <div className="assistant-validation-item-copy">
                <strong>{t('workflow.currentRunnerProfile')}</strong>
                <p>
                  {selectedProfile
                    ? `${selectedProfile.name}${
                        selectedProfile.required_tools?.length
                          ? ` · ${selectedProfile.required_tools.join(', ')}`
                          : ''
                      }`
                    : t('workflow.defaultEnv')}
                </p>
              </div>
            </div>

            <div className="assistant-validation-item">
              <div className="assistant-validation-item-copy">
                <strong>{t('workflow.boundAssistants')}</strong>
                <p>
                  {boundAssistantNames.length
                    ? boundAssistantNames.join('，')
                    : t('workflow.noBoundAssistants')}
                </p>
              </div>
            </div>
          </div>

          {canManage ? (
            <>
              <div className="workteam-form-grid" style={{ marginBottom: 12 }}>
                <label>
                  {t('workflow.repo')}
                  <select
                    value={selectedRepoId}
                    onChange={(event) => setSelectedRepoId(event.target.value)}
                  >
                    <option value="">{t('workflow.selectRepo')}</option>
                    {availableRepos.map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('workflow.branch')}
                  <input
                    value={branchInput}
                    onChange={(event) => setBranchInput(event.target.value)}
                    placeholder="main"
                  />
                </label>
              </div>
              <div className="workteam-form-actions" style={{ marginBottom: 16 }}>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={savingBinding || !selectedRepoId}
                  onClick={() => void handleSaveBinding()}
                >
                  {t('workflow.saveMainRepo')}
                </button>
              </div>

              {mainBinding ? (
                <>
                  <div className="workteam-form-grid">
                    <label>
                      Runner Profile
                      <select
                        value={profileDraft}
                        onChange={(event) => setProfileDraft(event.target.value)}
                      >
                        <option value="">{t('workflow.defaultEnvOption')}</option>
                        {runnerProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="workteam-form-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={savingProfile}
                      onClick={() => void handleSaveProfile()}
                    >
                      {t('workflow.saveRunnerProfile')}
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
