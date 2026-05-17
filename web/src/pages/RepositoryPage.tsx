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
  return (
    <RepoReviewSettingsPanel
      apiBase={apiBase}
      pickNativeDirectory={pickNativeDirectory}
      conversations={conversations}
      embedded
    />
  );
}
