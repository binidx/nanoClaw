import { useTranslation } from 'react-i18next';

import type { Conversation } from '../app-types';
import { RepoReviewSettingsPanel } from '../components/RepoReviewSettingsPanel';

interface RepositoryPageProps {
  apiBase: string;
  pickNativeDirectory: () => Promise<string | null>;
  conversations: Conversation[];
}

export default function RepositoryPage({
  apiBase,
  pickNativeDirectory,
  conversations,
}: RepositoryPageProps) {
  useTranslation('repoReview');

  return (
    <div className="page-view settings-view repository-review-page">
      <div className="page-body repository-review-page-body">
        <RepoReviewSettingsPanel
          apiBase={apiBase}
          pickNativeDirectory={pickNativeDirectory}
          conversations={conversations}
          embedded
        />
      </div>
    </div>
  );
}
