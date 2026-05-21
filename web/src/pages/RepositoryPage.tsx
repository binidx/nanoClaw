import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { Conversation } from '../app-types';
import { RepoReviewSettingsPanel } from '../components/RepoReviewSettingsPanel';
import { CodeMapPage } from './CodeMapPage';
import {
  getRepositoryRoute,
  repositoryRouteToPath,
  type RepositoryRouteTab,
} from '../router/paths';

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
  const { repositoryId: routeRepositoryId, tab: routeTab } =
    getRepositoryRoute(location.pathname);

  const handleRepositoryRouteChange = useCallback(
    (repositoryId: string | null, tab: RepositoryRouteTab = 'overview') => {
      navigate(repositoryRouteToPath(repositoryId, tab));
    },
    [navigate],
  );

  if (routeRepositoryId && routeTab === 'codemap') {
    return (
      <CodeMapPage
        apiBase={apiBase}
        repositoryIdProp={routeRepositoryId}
        onNavigateBack={() =>
          navigate(repositoryRouteToPath(routeRepositoryId, 'overview'))
        }
      />
    );
  }

  return (
    <RepoReviewSettingsPanel
      apiBase={apiBase}
      pickNativeDirectory={pickNativeDirectory}
      conversations={conversations}
      initialRepositoryId={routeRepositoryId}
      initialDetailTab={routeTab}
      onRepositoryRouteChange={handleRepositoryRouteChange}
      embedded
    />
  );
}
