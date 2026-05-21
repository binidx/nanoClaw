import type { NavPage } from '../app-types';

export type RepositoryDetailTab = 'overview' | 'profile' | 'runs' | 'config';
export type RepositoryRouteTab = RepositoryDetailTab | 'codemap';

// reviews 不在主导航暴露，但保留为合法路径作为“高级审查管理”隐藏入口
const VALID_PAGES: ReadonlySet<string> = new Set<NavPage>([
  'chat', 'companion', 'im', 'tasks', 'stock-analysis', 'repos', 'reviews',
  'channels', 'terminal', 'assistants', 'settings', 'users',
  'apps', 'soul', 'tavern', 'knowledge', 'workteam',
]);

const REPOSITORY_ROUTE_TABS: ReadonlySet<string> = new Set<RepositoryRouteTab>([
  'overview',
  'profile',
  'runs',
  'config',
  'codemap',
]);

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function pathToNavPage(pathname: string): NavPage {
  const segment = pathname.split('/')[1] || '';
  if (VALID_PAGES.has(segment)) return segment as NavPage;
  return 'chat';
}

export function navPageToPath(page: NavPage, sub?: string): string {
  const base = `/${page}`;
  return sub ? `${base}/${sub}` : base;
}

export function getUrlSubPath(pathname: string): string {
  return pathname.split('/')[2] || '';
}

export function getRepositoryRoute(pathname: string): {
  repositoryId: string;
  tab: RepositoryRouteTab;
} {
  const segments = pathname.split('/');
  const repositoryId = decodePathSegment(segments[2] || '');
  const tabSegment = segments[3] || '';
  const tab = REPOSITORY_ROUTE_TABS.has(tabSegment)
    ? (tabSegment as RepositoryRouteTab)
    : 'overview';
  return { repositoryId, tab };
}

export function repositoryRouteToPath(
  repositoryId: string | null | undefined,
  tab: RepositoryRouteTab = 'overview',
): string {
  if (!repositoryId) return navPageToPath('repos');
  const encodedRepositoryId = encodeURIComponent(repositoryId);
  return `${navPageToPath('repos', encodedRepositoryId)}/${tab}`;
}
