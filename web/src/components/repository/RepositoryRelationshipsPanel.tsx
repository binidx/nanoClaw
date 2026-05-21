import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RepositoryRelationships } from '../../app-types';
import { fetchRepositoryRelationships } from './api';

interface RepositoryRelationshipsPanelProps {
  repositoryId: string;
}

export function RepositoryRelationshipsPanel({
  repositoryId,
}: RepositoryRelationshipsPanelProps) {
  const { t } = useTranslation('repoReview');
  const [relationships, setRelationships] =
    useState<RepositoryRelationships | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void fetchRepositoryRelationships(repositoryId)
      .then((data) => {
        if (!cancelled) {
          setRelationships(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setRelationships(null);
          setError(err instanceof Error ? err.message : t('repo.loadRelationsFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [repositoryId, t]);

  return (
    <div className="repo-review-card">
      <div className="repo-review-card-header">
        <div>
          <h4>{t('repo.usageRelations')}</h4>
          <div className="settings-hint">
            {t('repo.usageHint')}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="repo-review-empty-hint">{t('common.loading')}</div>
      ) : error ? (
        <div className="repo-review-empty-hint">{error}</div>
      ) : (
        <div className="assistant-validation-list">
          <div className="assistant-validation-item">
            <div className="assistant-validation-item-copy">
              <strong>{t('repo.assistantBindings')}</strong>
              <p>
                {relationships?.assistantBindings.length
                  ? relationships.assistantBindings
                      .map((binding) =>
                        `${binding.assistantName || binding.assistantId}${
                          binding.branch ? ` · ${binding.branch}` : ''
                        }`,
                      )
                      .join('，')
                  : t('repo.noAssistantBindings')}
              </p>
            </div>
          </div>

          <div className="assistant-validation-item">
            <div className="assistant-validation-item-copy">
              <strong>{t('repo.workflowBindings')}</strong>
              <p>
                {relationships?.workflowBindings.length
                  ? relationships.workflowBindings
                      .map((binding) =>
                        `Workflow: ${binding.workflowName || binding.workflowId}${
                          binding.bindingKey ? ` · ${binding.bindingKey}` : ''
                        }${binding.branch ? ` · ${binding.branch}` : ''}`,
                      )
                      .join('，')
                  : t('repo.noWorkflowBindings')}
              </p>
            </div>
          </div>

          <div className="assistant-validation-item">
            <div className="assistant-validation-item-copy">
              <strong>Runner Profile</strong>
              <p>
                {relationships?.runnerProfile
                  ? `${relationships.runnerProfile.profileName} · ${relationships.runnerProfile.profileId}`
                  : t('repo.notBound')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
