import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import i18n from '../../i18n/index.ts';
import { AppSelect } from '../AppSelect';
import { NcToggle } from '../common';
import type {
  RepoReviewBranchSummary,
  RepoReviewProfile,
} from '../../app-types';
import type { ProfileDraft } from './draft-types';

function formatProfileBranchSummary(
  profile: RepoReviewProfile,
  activeBranchWindowDays: number,
): string {
  if (!profile.targetBranches.length) {
    return i18n.t('profile.activeBranches', {
      days: activeBranchWindowDays,
      ns: 'repoReview',
    });
  }
  if (profile.targetBranches.length <= 2) {
    return profile.targetBranches.join('、');
  }
  return `${profile.targetBranches.slice(0, 2).join('、')}${i18n.t('profile.branchCount', { count: profile.targetBranches.length, ns: 'repoReview' })}`;
}

type RepoReviewProfileSectionProps = {
  selectedRepositoryId: string;
  profileDraft: ProfileDraft;
  setProfileDraft: Dispatch<SetStateAction<ProfileDraft>>;
  profiles: RepoReviewProfile[];
  autoCreatedProfileNotice: string;
  availableProfileBranches: RepoReviewBranchSummary[];
  filteredProfileBranches: RepoReviewBranchSummary[];
  loadingRemoteBranches: boolean;
  savingProfile: boolean;
  deletingProfile: boolean;
  activeBranchWindowDays: number;
  onOpenEditor: (create?: boolean) => void;
  onSelectProfile: (profile: RepoReviewProfile) => void;
  onRefreshBranches: () => void;
  onToggleTargetBranch: (branch: string) => void;
  onSave: () => void;
  onDelete: () => void;
};

export function RepoReviewProfileSection({
  selectedRepositoryId,
  profileDraft,
  setProfileDraft,
  profiles,
  autoCreatedProfileNotice,
  availableProfileBranches,
  filteredProfileBranches,
  loadingRemoteBranches,
  savingProfile,
  deletingProfile,
  activeBranchWindowDays,
  onOpenEditor,
  onSelectProfile,
  onRefreshBranches,
  onToggleTargetBranch,
  onSave,
  onDelete,
}: RepoReviewProfileSectionProps) {
  const { t } = useTranslation('repoReview');

  const [branchSelectValue, setBranchSelectValue] = useState('');
  const branchSelectOptions = filteredProfileBranches
    .slice(0, 200)
    .map((branch) => ({
      value: branch.name,
      label: branch.defaultBranch
        ? `${branch.name}${t('profile.baseline')}`
        : branch.name,
    }));

  return (
    <div className="repo-review-card repo-review-profile-card">
      <div className="repo-review-profile-header">
        <div className="repo-review-overview-copy">
          <h4>{t('profile.title')}</h4>
          <div className="settings-hint">
            {selectedRepositoryId
              ? `${t('profile.count', { count: profiles.length })}${profileDraft.id ? ` · ${t('profile.current', { name: profileDraft.name || profileDraft.id })}` : ''}`
              : t('profile.selectRepoFirst')}
          </div>
        </div>
      </div>
      <div className="repo-review-profile-body">
        {!selectedRepositoryId ? (
          <div className="settings-hint">{t('profile.selectRepoHint')}</div>
        ) : (
          <>
            <div className="modal-actions">
              <button
                className="btn-outline btn-sm"
                onClick={() => onOpenEditor(true)}
              >
                {t('profile.create')}
              </button>
            </div>
            {autoCreatedProfileNotice ? (
              <div className="test-result success">
                {autoCreatedProfileNotice}
              </div>
            ) : null}
            {profiles.length > 0 ? (
              <div className="repo-review-chip-row">
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    className={`repo-review-chip ${
                      profileDraft.id === profile.id ? 'active' : ''
                    }`}
                    onClick={() => onSelectProfile(profile)}
                  >
                    {profile.name} · {profile.stage} ·{' '}
                    {formatProfileBranchSummary(
                      profile,
                      activeBranchWindowDays,
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="settings-hint">{t('profile.noProfiles')}</div>
            )}

            <div className="repo-review-form-grid">
              <div className="form-group">
                <label>{t('profile.name')}</label>
                <input
                  value={profileDraft.name}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder={t('profile.namePlaceholder')}
                />
              </div>
              <div className="form-group">
                <label>{t('profile.stage')}</label>
                <AppSelect
                  value={profileDraft.stage}
                  onChange={(value) =>
                    setProfileDraft((current) => ({
                      ...current,
                      stage: value as ProfileDraft['stage'],
                      passDecisionMode:
                        value === 'push' ? current.passDecisionMode : 'ai',
                    }))
                  }
                  ariaLabel={t('profile.selectStage')}
                  options={[
                    { value: 'commit', label: 'commit' },
                    { value: 'push', label: 'push / PR / MR' },
                  ]}
                />
              </div>
              <div className="form-group">
                <label>{t('profile.source')}</label>
                <AppSelect
                  value={profileDraft.sourceMode}
                  onChange={(value) =>
                    setProfileDraft((current) => ({
                      ...current,
                      sourceMode: value as ProfileDraft['sourceMode'],
                    }))
                  }
                  ariaLabel={t('profile.selectSource')}
                  options={[
                    { value: 'local', label: t('profile.sourceLocal') },
                    { value: 'remote', label: t('profile.sourceRemote') },
                    { value: 'both', label: t('profile.sourceBoth') },
                  ]}
                />
              </div>
              <div className="form-group">
                <label>{t('profile.blockingMode')}</label>
                <AppSelect
                  value={profileDraft.blockingMode}
                  onChange={(value) =>
                    setProfileDraft((current) => ({
                      ...current,
                      blockingMode: value as ProfileDraft['blockingMode'],
                    }))
                  }
                  ariaLabel={t('profile.selectBlocking')}
                  options={[
                    { value: 'hard_fail', label: 'hard fail' },
                    { value: 'soft_fail', label: 'soft fail' },
                  ]}
                />
                <div className="settings-hint">{t('profile.blockingHint')}</div>
              </div>
              <div className="form-group">
                <label>{t('profile.passDecision')}</label>
                <AppSelect
                  value={
                    profileDraft.stage === 'push'
                      ? profileDraft.passDecisionMode
                      : 'ai'
                  }
                  onChange={(value) =>
                    setProfileDraft((current) => ({
                      ...current,
                      passDecisionMode:
                        value as ProfileDraft['passDecisionMode'],
                    }))
                  }
                  ariaLabel={t('profile.selectPassDecision')}
                  disabled={profileDraft.stage !== 'push'}
                  options={[
                    { value: 'ai', label: t('profile.passDecisionAi') },
                    { value: 'human', label: t('profile.passDecisionHuman') },
                  ]}
                />
                <div className="settings-hint">
                  {t('profile.passDecisionHint')}
                </div>
              </div>
              <div className="form-group">
                <label>{t('profile.reviewScope')}</label>
                <AppSelect
                  value={profileDraft.reviewScope}
                  onChange={(value) =>
                    setProfileDraft((current) => ({
                      ...current,
                      reviewScope: value as ProfileDraft['reviewScope'],
                    }))
                  }
                  ariaLabel={t('profile.selectScope')}
                  options={[
                    { value: 'commit_range', label: 'commit_range' },
                    { value: 'staged_diff', label: 'staged_diff' },
                    { value: 'pr_compare', label: 'pr_compare' },
                    { value: 'compare', label: 'compare' },
                    { value: 'auto', label: 'auto' },
                  ]}
                />
              </div>
              <div className="form-group">
                <label>{t('profile.maxFiles')}</label>
                <input
                  type="number"
                  value={profileDraft.maxFiles}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      maxFiles: Number(event.target.value || 0),
                    }))
                  }
                />
              </div>
              <div className="form-group">
                <label>{t('profile.diffThreshold')}</label>
                <input
                  type="number"
                  value={profileDraft.diffSubagentThreshold}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      diffSubagentThreshold: Number(event.target.value || 0),
                    }))
                  }
                />
                <div className="settings-hint">
                  {t('profile.diffThresholdHint')}
                </div>
              </div>
              <div className="form-group">
                <label>{t('profile.subagentTimeoutSeconds')}</label>
                <input
                  type="number"
                  value={profileDraft.subagentTimeoutSeconds}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      subagentTimeoutSeconds: Number(event.target.value || 0),
                    }))
                  }
                />
                <div className="settings-hint">
                  {t('profile.subagentTimeoutHint')}
                </div>
              </div>
              <div className="form-group">
                <label>{t('profile.fullFileReview')}</label>
                <div className="settings-boolean-row">
                  <div className="settings-boolean-copy">
                    <span>{t('profile.enableFullFile')}</span>
                  </div>
                  <div className="channel-boolean-control">
                    <NcToggle
                      checked={profileDraft.includeFullFileContext}
                      onChange={(checked) =>
                        setProfileDraft((current) => ({
                          ...current,
                          includeFullFileContext: checked,
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="settings-hint">{t('profile.fullFileHint')}</div>
              </div>
              <div className="form-group">
                <label>{t('profile.maxDiffBytes')}</label>
                <input
                  type="number"
                  value={profileDraft.maxDiffBytes}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      maxDiffBytes: Number(event.target.value || 0),
                    }))
                  }
                />
              </div>
              <div className="form-group repo-review-textarea">
                <label>{t('profile.targetBranches')}</label>
                <div className="repo-review-branch-box">
                  <div className="settings-hint">
                    {t('profile.targetBranchesHint', {
                      days: activeBranchWindowDays,
                    })}
                  </div>
                  <div className="repo-review-inline-actions">
                    <div className="form-group repo-review-branch-select-group">
                      <label>{t('profile.addBranch')}</label>
                      <AppSelect
                        value={branchSelectValue}
                        onChange={(value) => {
                          setBranchSelectValue('');
                          if (!value) return;
                          onToggleTargetBranch(value);
                        }}
                        ariaLabel={t('profile.selectBranch')}
                        options={[
                          { value: '', label: t('profile.selectRemoteBranch') },
                          ...branchSelectOptions,
                        ]}
                      />
                    </div>
                    <button
                      className="btn-outline btn-sm"
                      onClick={onRefreshBranches}
                      disabled={loadingRemoteBranches}
                    >
                      {loadingRemoteBranches
                        ? t('profile.refreshing')
                        : t('profile.refreshBranches')}
                    </button>
                  </div>
                  <div className="settings-hint">
                    {availableProfileBranches.length > 0
                      ? t('profile.branchesFound', {
                          count: availableProfileBranches.length,
                        })
                      : t('profile.noBranches')}
                  </div>
                  <div className="settings-hint">
                    {t('profile.defaultBranchHint')}
                  </div>
                  {profileDraft.targetBranches.length > 0 ? (
                    <div className="repo-review-branch-list">
                      {profileDraft.targetBranches.map((branch) => (
                        <button
                          key={branch}
                          className="repo-review-branch-pill active"
                          onClick={() => onToggleTargetBranch(branch)}
                        >
                          {branch} ×
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="settings-hint">
                      {t('profile.activeBranchMode')}
                    </div>
                  )}
                  {profileDraft.targetBranches.length > 0 ? (
                    <div className="settings-hint">
                      {t('profile.selectedBranches', {
                        count: profileDraft.targetBranches.length,
                      })}
                    </div>
                  ) : (
                    <div className="settings-hint">
                      {t('profile.defaultBranchScope')}
                    </div>
                  )}
                </div>
              </div>
              <div className="form-group repo-review-textarea">
                <label>{t('profile.customPrompt')}</label>
                <textarea
                  rows={6}
                  value={profileDraft.promptTemplate}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      promptTemplate: event.target.value,
                    }))
                  }
                  placeholder={t('profile.promptPlaceholder')}
                />
              </div>
              <div className="form-group repo-review-textarea">
                <label>Include Globs</label>
                <textarea
                  rows={4}
                  value={profileDraft.includeGlobsText}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      includeGlobsText: event.target.value,
                    }))
                  }
                  placeholder={t('profile.includeGlobsPlaceholder')}
                />
              </div>
              <div className="form-group repo-review-textarea">
                <label>Exclude Globs</label>
                <textarea
                  rows={4}
                  value={profileDraft.excludeGlobsText}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      excludeGlobsText: event.target.value,
                    }))
                  }
                  placeholder={t('profile.excludeGlobsPlaceholder')}
                />
              </div>
            </div>

            <div className="form-group">
              <label>{t('profile.outputMode')}</label>
              <AppSelect
                value={profileDraft.reviewOutputMode}
                onChange={(value) =>
                  setProfileDraft((current) => ({
                    ...current,
                    reviewOutputMode: value as 'message' | 'share_link',
                  }))
                }
                ariaLabel={t('profile.selectOutputMode')}
                options={[
                  { value: 'message', label: t('profile.outputMessage') },
                  { value: 'share_link', label: t('profile.outputShareLink') },
                ]}
              />
              <div className="settings-hint">
                {profileDraft.reviewOutputMode === 'message' &&
                  t('profile.outputMessageHint')}
                {profileDraft.reviewOutputMode === 'share_link' &&
                  t('profile.outputShareLinkHint')}
              </div>
            </div>

            <div className="repo-review-toggle-grid">
              <label className="settings-toggle-row">
                <input
                  type="checkbox"
                  checked={profileDraft.writeToChat}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      writeToChat: event.target.checked,
                    }))
                  }
                />
                <span>{t('profile.writeToChat')}</span>
              </label>
              <label className="settings-toggle-row">
                <input
                  type="checkbox"
                  checked={profileDraft.writeToPlatform}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      writeToPlatform: event.target.checked,
                    }))
                  }
                />
                <span>{t('profile.writeToPlatform')}</span>
              </label>
              <label className="settings-toggle-row">
                <input
                  type="checkbox"
                  checked={profileDraft.enabled}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
                <span>{t('profile.enableProfile')}</span>
              </label>
            </div>

            <div className="modal-actions">
              <button
                className="btn-primary"
                onClick={onSave}
                disabled={savingProfile}
              >
                {savingProfile ? t('profile.saving') : t('profile.save')}
              </button>
              <button
                className="btn-danger"
                onClick={onDelete}
                disabled={!profileDraft.id || deletingProfile}
              >
                {deletingProfile ? t('profile.deleting') : t('profile.delete')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
