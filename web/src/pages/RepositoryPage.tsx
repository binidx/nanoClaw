import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { Conversation } from '../app-types';
import { RepoReviewSettingsPanel } from '../components/RepoReviewSettingsPanel';
import { getUrlSubPath, navPageToPath } from '../router/paths';

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
  const location = useLocation();
  const navigate = useNavigate();
  const routeRepositoryId = getUrlSubPath(location.pathname);

  const handleRepositoryRouteChange = useCallback(
    (repositoryId: string | null) => {
      navigate(
        repositoryId
          ? navPageToPath('repos', repositoryId)
          : navPageToPath('repos'),
      );
    },
    [navigate],
  );

  return (
    <RepoReviewSettingsPanel
      apiBase={apiBase}
      pickNativeDirectory={pickNativeDirectory}
      conversations={conversations}
      initialRepositoryId={routeRepositoryId}
      onRepositoryRouteChange={handleRepositoryRouteChange}
      embedded
    />
  );
}
