import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { IconMoon, IconSun } from './AppIcons';
import type { NavPage } from '../app-types';

const PAGE_TITLE_KEYS: Record<NavPage, string> = {
  chat: 'mobile.聊天',
  companion: 'mobile.对话',
  im: 'mobile.消息',
  tasks: 'mobile.任务',
  'stock-analysis': 'mobile.股票',
  repos: 'mobile.仓库',
  reviews: 'mobile.代码审查',
  channels: 'mobile.渠道',
  terminal: 'mobile.终端',
  assistants: 'mobile.助手',
  settings: 'mobile.配置',
  users: 'mobile.用户',
  apps: 'mobile.应用',
  soul: 'mobile.AI 灵魂',
  tavern: 'mobile.酒馆',
  knowledge: 'mobile.知识库',
  workteam: 'mobile.Workflow',
};

const OVERFLOW_PAGES: NavPage[] = [
  'companion',
  'repos',
  'workteam',
  'assistants',
  'soul',
  'tavern',
  'knowledge',
  'stock-analysis',
  'terminal',
  'channels',
  'settings',
  'users',
];

interface PageScopedOpenState {
  page: NavPage;
  open: boolean;
}

function IconChat() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconIm() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function IconTasks() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  );
}

function IconApps() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 5h16" />
      <path d="M4 12h16" />
      <path d="M4 19h16" />
    </svg>
  );
}

function IconHamburger() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </svg>
  );
}

function IconAccount() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 21a8 8 0 0 0-16 0" />
      <circle cx="12" cy="8" r="4" />
    </svg>
  );
}

function IconLogout() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

type ThemeMode = 'light' | 'dark';

export interface MobileLayoutProps {
  page: NavPage;
  setPage: (page: NavPage) => void;
  children: ReactNode;
  conversationDrawerOpen: boolean;
  onToggleConversationDrawer: () => void;
  conversationSidebar: ReactNode;
  canAccessPage: (page: NavPage) => boolean;
  online: boolean;
  loginEnabled: boolean;
  loginDisplayName: string;
  theme: ThemeMode;
  toggleTheme: () => void;
  onLogout: () => void;
  stockAnalysisEnabled?: boolean;
  terminalEnabled?: boolean;
  /** When set on the chat page, shown in the top bar instead of the default page label. */
  chatTitle?: string;
}

export function MobileLayout({
  page,
  setPage,
  children,
  conversationDrawerOpen,
  onToggleConversationDrawer,
  conversationSidebar,
  canAccessPage,
  online,
  loginEnabled,
  loginDisplayName,
  theme,
  toggleTheme,
  onLogout,
  stockAnalysisEnabled = true,
  terminalEnabled = true,
  chatTitle,
}: MobileLayoutProps) {
  const { t } = useTranslation('common');
  const [moreOpenState, setMoreOpenState] = useState<PageScopedOpenState>(
    () => ({ page, open: false }),
  );
  const [accountOpenState, setAccountOpenState] = useState<PageScopedOpenState>(
    () => ({ page, open: false }),
  );
  const accountTriggerRef = useRef<HTMLButtonElement | null>(null);
  const firstAccountActionRef = useRef<HTMLButtonElement | null>(null);
  const accountWasOpenRef = useRef(false);
  const isChinese = !i18n.language?.toLowerCase().startsWith('en');
  const moreOpen = moreOpenState.page === page && moreOpenState.open;
  const accountOpen = accountOpenState.page === page && accountOpenState.open;

  const setMoreOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) => {
      setMoreOpenState((current) => {
        const currentOpen = current.page === page && current.open;
        return {
          page,
          open: typeof next === 'function' ? next(currentOpen) : next,
        };
      });
    },
    [page],
  );
  const setAccountOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) => {
      setAccountOpenState((current) => {
        const currentOpen = current.page === page && current.open;
        return {
          page,
          open: typeof next === 'function' ? next(currentOpen) : next,
        };
      });
    },
    [page],
  );

  const overflowPages = useMemo(
    () =>
      OVERFLOW_PAGES.filter((p) => {
        if (!canAccessPage(p)) return false;
        if (p === 'stock-analysis' && !stockAnalysisEnabled) return false;
        if (p === 'terminal' && !terminalEnabled) return false;
        return true;
      }),
    [canAccessPage, stockAnalysisEnabled, terminalEnabled],
  );

  const primaryTabs = useMemo(() => {
    const tabs: { page: NavPage; labelKey: string; icon: ReactNode }[] = [];
    if (canAccessPage('chat')) tabs.push({ page: 'chat', labelKey: 'mobile.聊天', icon: <IconChat /> });
    if (canAccessPage('im')) tabs.push({ page: 'im', labelKey: 'mobile.消息', icon: <IconIm /> });
    if (canAccessPage('tasks')) tabs.push({ page: 'tasks', labelKey: 'mobile.任务', icon: <IconTasks /> });
    if (canAccessPage('apps')) tabs.push({ page: 'apps', labelKey: 'mobile.应用', icon: <IconApps /> });
    return tabs;
  }, [canAccessPage]);

  const showMoreTab = overflowPages.length > 0;

  const moreTabActive =
    showMoreTab &&
    !primaryTabs.some((t) => t.page === page) &&
    overflowPages.includes(page);

  const goPage = useCallback(
    (next: NavPage) => {
      setPage(next);
      setMoreOpen(false);
    },
    [setMoreOpen, setPage],
  );

  useEffect(() => {
    if (!moreOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [moreOpen, setMoreOpen]);

  useEffect(() => {
    if (!accountOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccountOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [accountOpen, setAccountOpen]);

  useEffect(() => {
    if (accountOpen) {
      firstAccountActionRef.current?.focus();
    } else if (accountWasOpenRef.current) {
      accountTriggerRef.current?.focus();
    }
    accountWasOpenRef.current = accountOpen;
  }, [accountOpen]);

  const title =
    page === 'chat' && chatTitle ? chatTitle : t(PAGE_TITLE_KEYS[page] ?? page);

  const toggleLanguage = useCallback(() => {
    void i18n.changeLanguage(isChinese ? 'en' : 'zh');
    setAccountOpen(false);
  }, [isChinese, setAccountOpen]);

  return (
    <div className="mobile-layout-root">
      <header className="mobile-top-bar">
        <div className="mobile-top-bar-left">
          {page === 'chat' ? (
            <button
              type="button"
              className="mobile-icon-btn"
              onClick={onToggleConversationDrawer}
              aria-label={conversationDrawerOpen ? t('mobile.关闭对话列表') : t('mobile.打开对话列表')}
            >
              <IconHamburger />
            </button>
          ) : (
            <span aria-hidden />
          )}
        </div>
        <div className="mobile-top-bar-title">{title}</div>
        <div className="mobile-top-bar-right">
          <button
            ref={accountTriggerRef}
            type="button"
            className={`mobile-icon-btn mobile-account-btn${accountOpen ? ' active' : ''}`}
            onClick={() => {
              setMoreOpen(false);
              setAccountOpen((open) => !open);
            }}
            aria-expanded={accountOpen}
            aria-haspopup="dialog"
            aria-label={t('mobile.打开账户与显示设置')}
          >
            <IconAccount />
            <span
              className={`mobile-status-dot mobile-status-dot-badge${online ? ' online' : ''}`}
              title={online ? t('mobile.运行中') : t('mobile.离线')}
              aria-hidden="true"
            />
          </button>
        </div>
      </header>

      <div className="mobile-content">{children}</div>

      <nav className="mobile-bottom-tabs" aria-label={t('mobile.主导航')}>
        {primaryTabs.map((tab) => (
          <button
            key={tab.page}
            type="button"
            className={`mobile-tab-item${page === tab.page ? ' active' : ''}`}
            onClick={() => goPage(tab.page)}
          >
            {tab.icon}
            <span>{t(tab.labelKey)}</span>
          </button>
        ))}
        {showMoreTab ? (
          <button
            type="button"
            className={`mobile-tab-item${moreTabActive ? ' active' : ''}`}
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            aria-label={t('mobile.更多页面')}
          >
            <IconMore />
            <span>{t('mobile.更多')}</span>
          </button>
        ) : null}
      </nav>

      {page === 'chat' && conversationDrawerOpen && conversationSidebar ? (
        <>
          <button
            type="button"
            className="mobile-drawer-overlay"
            aria-label={t('mobile.关闭对话列表')}
            onClick={onToggleConversationDrawer}
          />
          <div
            className="mobile-drawer-panel"
            role="dialog"
            aria-modal="true"
            aria-label={t('mobile.对话列表')}
          >
            {conversationSidebar}
          </div>
        </>
      ) : null}

      {accountOpen ? (
        <>
          <button
            type="button"
            className="mobile-account-overlay"
            aria-label={t('mobile.关闭账户菜单')}
            onClick={() => setAccountOpen(false)}
          />
          <div
            className="mobile-account-popup"
            role="dialog"
            aria-modal="true"
            aria-label={t('mobile.账户与显示设置')}
          >
            <div className="mobile-account-summary">
              <div className="mobile-account-summary-name">
                {loginEnabled ? loginDisplayName : t('mobile.免登录模式')}
              </div>
              <div className="mobile-account-summary-meta">
                {online ? t('mobile.运行中') : t('mobile.离线')}
              </div>
            </div>
            <button
              ref={firstAccountActionRef}
              type="button"
              className="mobile-account-item"
              onClick={() => {
                toggleTheme();
                setAccountOpen(false);
              }}
            >
              {theme === 'dark' ? <IconSun /> : <IconMoon />}
              <span>{theme === 'dark' ? t('mobile.切换到浅色模式') : t('mobile.切换到夜间模式')}</span>
            </button>
            <button
              type="button"
              className="mobile-account-item"
              onClick={toggleLanguage}
            >
              <span className="mobile-account-item-badge" aria-hidden="true">
                {isChinese ? 'EN' : '中'}
              </span>
              <span>{isChinese ? t('mobile.切换到英文') : t('mobile.切换到中文')}</span>
            </button>
            {loginEnabled ? (
              <button
                type="button"
                className="mobile-account-item mobile-account-item-danger"
                onClick={() => {
                  setAccountOpen(false);
                  void onLogout();
                }}
              >
                <IconLogout />
                <span>{t('mobile.退出登录')}</span>
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {moreOpen ? (
        <>
          <button type="button" className="mobile-more-overlay" aria-label={t('mobile.关闭菜单')} onClick={() => setMoreOpen(false)} />
          <div className="mobile-more-popup" role="menu">
            {overflowPages.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitem"
                className={`mobile-more-item${page === p ? ' active' : ''}`}
                onClick={() => goPage(p)}
              >
                {t(PAGE_TITLE_KEYS[p] ?? p)}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
