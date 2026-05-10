import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import i18n from '../../i18n/index.ts';
import { AppSelect, type AppSelectOption } from '../AppSelect';
import type { RepoReviewChatMember } from '../../app-types';
import type {
  ActorMentionDraftRow,
  ActorMentionParseIssue,
  ReviewIdentityCandidate,
} from './draft-types';

function formatReviewChatMemberSource(source: string): string {
  if (source === 'feishu_api') return i18n.t('actorMention.source.api', { ns: 'repoReview' });
  if (source === 'feishu_message') return i18n.t('actorMention.source.message', { ns: 'repoReview' });
  if (source === 'saved_mapping') return i18n.t('actorMention.source.savedMapping', { ns: 'repoReview' });
  return source || i18n.t('actorMention.source.unknown', { ns: 'repoReview' });
}

function getReviewChatMemberSourceTone(source: string): string {
  if (source === 'feishu_api') return 'success';
  if (source === 'feishu_message') return 'warning';
  if (source === 'saved_mapping') return 'neutral';
  return 'neutral';
}

type RepoReviewActorMentionEditorProps = {
  isFeishuReviewChat: boolean;
  pauseOverviewRefresh: boolean;
  selectedMentionMemberId: string;
  setSelectedMentionMemberId: Dispatch<SetStateAction<string>>;
  reviewChatMemberOptions: AppSelectOption[];
  loadingReviewChatMembers: boolean;
  availableReviewChatMembers: RepoReviewChatMember[];
  selectedMentionMember: RepoReviewChatMember | null;
  reviewIdentityCandidates: ReviewIdentityCandidate[];
  reviewChatMemberSourceStats: {
    api: number;
    message: number;
    saved: number;
  };
  reviewChatMembersError: string;
  actorMentionDraftRows: ActorMentionDraftRow[];
  actorMentionMappingsText: string;
  actorMentionIssues: ActorMentionParseIssue[];
  actorMentionEntryCount: number;
  advancedMappingsOpen: boolean;
  setAdvancedMappingsOpen: Dispatch<SetStateAction<boolean>>;
  onRefreshMembers: () => void;
  onAppendMentionDraftRow: () => void;
  onApplyIdentityCandidate: (actor: string) => void;
  onUpdateMentionDraftRow: (
    rowKey: string,
    updates: Partial<Pick<ActorMentionDraftRow, 'actor' | 'memberId'>>,
  ) => void;
  onRemoveMentionDraftRow: (rowKey: string) => void;
  onActorMentionMappingsTextChange: (value: string) => void;
};

export function RepoReviewActorMentionEditor({
  isFeishuReviewChat,
  pauseOverviewRefresh,
  selectedMentionMemberId,
  setSelectedMentionMemberId,
  reviewChatMemberOptions,
  loadingReviewChatMembers,
  availableReviewChatMembers,
  selectedMentionMember,
  reviewIdentityCandidates,
  reviewChatMemberSourceStats,
  reviewChatMembersError,
  actorMentionDraftRows,
  actorMentionMappingsText,
  actorMentionIssues,
  actorMentionEntryCount,
  advancedMappingsOpen,
  setAdvancedMappingsOpen,
  onRefreshMembers,
  onAppendMentionDraftRow,
  onApplyIdentityCandidate,
  onUpdateMentionDraftRow,
  onRemoveMentionDraftRow,
  onActorMentionMappingsTextChange,
}: RepoReviewActorMentionEditorProps) {
  const { t } = useTranslation('repoReview');
  return (
    <div className="form-group repo-review-textarea">
      <label>{t('actorMention.title')}</label>
      <div className="settings-hint">
        {t('actorMention.hint1')}
      </div>
      <div className="settings-hint">
        {t('actorMention.hint2')}
      </div>
      {pauseOverviewRefresh ? (
        <div className="settings-hint">
          {t('actorMention.editPause')}
        </div>
      ) : null}
      {isFeishuReviewChat ? (
        <>
          <div className="repo-review-inline-actions">
            <AppSelect
              value={selectedMentionMemberId}
              onChange={setSelectedMentionMemberId}
              options={reviewChatMemberOptions}
              placeholder={
                loadingReviewChatMembers
                  ? t('actorMention.loading')
                  : t('actorMention.selectFirst')
              }
              disabled={
                loadingReviewChatMembers || reviewChatMemberOptions.length === 0
              }
              ariaLabel={t('actorMention.selectMemberLabel')}
            />
            <button
              className="btn-outline btn-sm"
              onClick={onRefreshMembers}
              disabled={loadingReviewChatMembers}
            >
              {loadingReviewChatMembers ? t('actorMention.refreshing') : t('actorMention.refreshMembers')}
            </button>
            <button
              className="btn-outline btn-sm"
              onClick={onAppendMentionDraftRow}
            >
              {t('actorMention.addRow')}
            </button>
          </div>
          <div className="settings-hint">
            {t('actorMention.membersFound', { count: availableReviewChatMembers.length })}
          </div>
          {selectedMentionMember ? (
            <div className="settings-hint">
              {t('actorMention.currentTarget', { name: selectedMentionMember.name || selectedMentionMember.id })}
            </div>
          ) : null}
          {reviewIdentityCandidates.length > 0 ? (
            <div className="repo-review-empty-hint">
              <strong>{t('actorMention.candidatesTitle')}</strong>
              <div className="settings-hint">
                {selectedMentionMemberId
                  ? t('actorMention.candidatesHint')
                  : t('actorMention.candidatesHint2')}
              </div>
              <div className="repo-review-candidate-list">
                {reviewIdentityCandidates.slice(0, 12).map((candidate) => (
                  <div
                    key={candidate.actor}
                    className="repo-review-candidate-item"
                  >
                    <div className="repo-review-candidate-main">
                      <strong>{candidate.actor}</strong>
                      <span className="settings-hint">
                        {t('actorMention.source', { sources: candidate.sources.join('、') })}
                      </span>
                      {candidate.mappedMemberName ? (
                        <span className="settings-hint">
                          {t('actorMention.currentlyBound', { name: candidate.mappedMemberName })}
                        </span>
                      ) : (
                        <span className="settings-hint">{t('actorMention.currentlyUnbound')}</span>
                      )}
                    </div>
                    <button
                      className="btn-outline btn-sm"
                      onClick={() => onApplyIdentityCandidate(candidate.actor)}
                    >
                      {selectedMentionMemberId ? t('actorMention.candidates.bindToCurrent') : t('actorMention.addRow')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="repo-review-source-summary">
            <span className="repo-review-source-pill tone-success">
              {t('actorMention.sourceApi', { count: reviewChatMemberSourceStats.api })}
            </span>
            <span className="repo-review-source-pill tone-warning">
              {t('actorMention.sourceMessage', { count: reviewChatMemberSourceStats.message })}
            </span>
            {reviewChatMemberSourceStats.saved > 0 ? (
              <span className="repo-review-source-pill tone-neutral">
                {t('actorMention.sourceSaved', { count: reviewChatMemberSourceStats.saved })}
              </span>
            ) : null}
          </div>
          {reviewChatMembersError ? (
            <div className="test-result error">{reviewChatMembersError}</div>
          ) : null}
          {availableReviewChatMembers.length > 0 ? (
            <div className="repo-review-member-grid">
              {availableReviewChatMembers.slice(0, 12).map((member) => (
                <button
                  type="button"
                  key={`${member.id}-${member.source}`}
                  className={`repo-review-member-card ${selectedMentionMemberId === member.id ? 'selected' : ''}`}
                  onClick={() =>
                    setSelectedMentionMemberId((current) =>
                      current === member.id ? '' : member.id,
                    )
                  }
                >
                  <div className="repo-review-member-card-topline">
                    <strong>{member.name || member.id}</strong>
                    <span
                      className={`repo-review-source-pill tone-${getReviewChatMemberSourceTone(member.source)}`}
                    >
                      {formatReviewChatMemberSource(member.source)}
                    </span>
                  </div>
                  <div className="settings-hint repo-review-ellipsis">
                    {member.id}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
          {actorMentionDraftRows.length > 0 ? (
            <div className="repo-review-mapping-editor">
              {actorMentionDraftRows.map((row) => (
                <div key={row.key} className="repo-review-mapping-row">
                  <input
                    value={row.actor}
                    onChange={(event) =>
                      onUpdateMentionDraftRow(row.key, {
                        actor: event.target.value,
                      })
                    }
                    placeholder={t('actorMention.mappingPlaceholder')}
                  />
                  <AppSelect
                    value={row.memberId}
                    onChange={(value) =>
                      onUpdateMentionDraftRow(row.key, { memberId: value })
                    }
                    options={reviewChatMemberOptions}
                    placeholder={t('actorMention.selectFeishuMember')}
                    disabled={
                      loadingReviewChatMembers ||
                      reviewChatMemberOptions.length === 0
                    }
                    ariaLabel={t('actorMention.selectBoundMember')}
                  />
                  {selectedMentionMemberId &&
                  row.memberId !== selectedMentionMemberId ? (
                    <button
                      className="btn-outline btn-sm"
                      onClick={() =>
                        onUpdateMentionDraftRow(row.key, {
                          memberId: selectedMentionMemberId,
                        })
                      }
                    >
                      {t('button.applyMember')}
                    </button>
                  ) : null}
                  <button
                    className="btn-outline btn-sm"
                    onClick={() => onRemoveMentionDraftRow(row.key)}
                  >
                    {t('button.remove')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="repo-review-empty-hint">
              <strong>{t('actorMention.noMappings')}</strong>
              <div className="settings-hint">
                {t('actorMention.noMappingsHint')}
              </div>
            </div>
          )}
          {availableReviewChatMembers.length === 0 &&
          !loadingReviewChatMembers ? (
            <div className="repo-review-empty-hint">
              <strong>{t('actorMention.noMembers')}</strong>
              <div className="settings-hint">
                {t('actorMention.troubleshootHint')}
              </div>
              <div className="settings-hint">
                {t('actorMention.troubleshoot1')}
              </div>
              <div className="settings-hint">
                {t('actorMention.troubleshoot2')}
              </div>
              <div className="settings-hint">
                {t('actorMention.troubleshoot3')}
              </div>
              <div className="settings-hint">
                {t('actorMention.troubleshoot4')}
              </div>
            </div>
          ) : null}
          {availableReviewChatMembers.length > 12 ? (
            <div className="settings-hint">
              {t('actorMention.membersOmitted', { count: availableReviewChatMembers.length - 12 })}
            </div>
          ) : null}
          <div className="repo-review-advanced-toggle">
            <button
              type="button"
              className="btn-outline btn-sm"
              onClick={() => setAdvancedMappingsOpen((current) => !current)}
            >
              {advancedMappingsOpen
                ? t('actorMention.advanced.collapse')
                : t('actorMention.advanced.expand')}
            </button>
            {advancedMappingsOpen ? (
              <textarea
                rows={4}
                value={actorMentionMappingsText}
                onChange={(event) =>
                  onActorMentionMappingsTextChange(event.target.value)
                }
                placeholder={t('actorMention.advancedPlaceholder')}
              />
            ) : null}
          </div>
        </>
      ) : (
        <textarea
          rows={4}
          value={actorMentionMappingsText}
          onChange={(event) =>
            onActorMentionMappingsTextChange(event.target.value)
          }
          placeholder={t('actorMention.nonFeishuPlaceholder')}
        />
      )}
      <div className="settings-hint">
        {t('actorMention.parsed', { count: actorMentionEntryCount })}
      </div>
      {actorMentionIssues.length > 0 ? (
        <div className="repo-review-issues">
          {actorMentionIssues.map((issue) => (
            <div
              key={`${issue.level}-${issue.line}-${issue.message}`}
              className={`repo-review-issue repo-review-issue-${issue.level}`}
            >
              {t('actorMention.issueLine', { line: issue.line, message: issue.message })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
