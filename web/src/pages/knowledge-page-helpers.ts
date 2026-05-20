export type KnowledgeWorkbenchTab =
  | 'overview'
  | 'content'
  | 'graph'
  | 'settings'
  | 'search';

export type KnowledgeContentView = 'docs' | 'tree' | 'wiki';

const VALID_WORKBENCH_TABS: ReadonlySet<string> = new Set([
  'overview',
  'content',
  'graph',
  'settings',
  'search',
]);

const VALID_CONTENT_VIEWS: ReadonlySet<string> = new Set([
  'docs',
  'tree',
  'wiki',
]);

export function resolveKnowledgeDetailTab({
  creatingKb,
  hasSelectedKb,
  urlTab,
  urlView,
}: {
  creatingKb: boolean;
  hasSelectedKb: boolean;
  urlTab: string | null;
  urlView: string | null;
}): KnowledgeWorkbenchTab {
  if (creatingKb) return 'settings';
  if (!hasSelectedKb && urlView === 'search') return 'search';
  if (!hasSelectedKb) return 'overview';

  const fromUrl = urlTab ?? 'overview';
  if (fromUrl === 'docs' || fromUrl === 'tree' || fromUrl === 'wiki') {
    return 'content';
  }
  if (fromUrl === 'relations') return 'graph';
  if (fromUrl === 'config') return 'settings';
  if (VALID_WORKBENCH_TABS.has(fromUrl)) {
    return fromUrl as KnowledgeWorkbenchTab;
  }
  return 'overview';
}

export function resolveKnowledgeContentView({
  urlContent,
  urlTab,
}: {
  urlContent: string | null;
  urlTab: string | null;
}): KnowledgeContentView {
  if (urlContent && VALID_CONTENT_VIEWS.has(urlContent)) {
    return urlContent as KnowledgeContentView;
  }
  if (urlTab === 'tree') return 'tree';
  if (urlTab === 'wiki') return 'wiki';
  return 'docs';
}

export function resolveKnowledgeDrawerTab({
  creatingKb,
  hasSelectedKb,
  urlView,
  detailTab,
  contentView,
}: {
  creatingKb: boolean;
  hasSelectedKb: boolean;
  urlView: string | null;
  detailTab: KnowledgeWorkbenchTab;
  contentView: KnowledgeContentView;
}): 'overview' | 'docs' | 'search' | 'config' | 'tree' | 'relations' | 'wiki' {
  if (creatingKb) return 'config';
  if (!hasSelectedKb && urlView === 'search') return 'search';
  if (detailTab === 'content') return contentView;
  if (detailTab === 'graph') return 'relations';
  if (detailTab === 'settings') return 'config';
  return detailTab;
}
