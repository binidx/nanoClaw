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
  const { t } = useTranslation('repoReview');

  return (
    <div className="page-view settings-view">
      <div className="page-header">
        <div className="page-header-copy">
          <h2>{t('auto.c270fc6f')}</h2>
          <p>{t('auto.c83b1969')}</p>
        </div>
      </div>
      <div className="page-body">
        <RepoReviewSettingsPanel
          apiBase={apiBase}
          pickNativeDirectory={pickNativeDirectory}
          conversations={conversations}
        />
      </div>
    </div>
  );
}
