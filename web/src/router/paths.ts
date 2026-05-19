import type { NavPage } from '../app-types';

// reviews 不在主导航暴露，但保留为合法路径作为“高级审查管理”隐藏入口
const VALID_PAGES: ReadonlySet<string> = new Set<NavPage>([
  'chat', 'companion', 'im', 'tasks', 'stock-analysis', 'repos', 'reviews',
  'channels', 'terminal', 'assistants', 'settings', 'users',
  'apps', 'soul', 'tavern', 'knowledge', 'workteam',
]);

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
