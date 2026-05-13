import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { NavPage } from '../app-types';
import { navPageToPath } from '../router/paths';
import {
  IconCalendar,
  IconCandlestick,
  IconChannel,
  IconChat,
  IconMoon,
  IconPuzzle,
  IconSettings,
  IconStar,
  IconBook,
  IconSun,
  IconTerminal,
  IconUsers,
  IconWand,
} from './AppIcons';

type ThemeMode = 'light' | 'dark';

interface NavSidebarProps {
  stockAnalysisEnabled: boolean;
  terminalEnabled: boolean;
  online: boolean;
  loginEnabled: boolean;
  loginDisplayName: string;
  theme: ThemeMode;
  toggleTheme: () => void;
  onLogout: () => void;
  canAccessPage: (page: NavPage) => boolean;
}

function navItemClass({ isActive }: { isActive: boolean }): string {
  return `nav-item${isActive ? ' active' : ''}`;
}

export function NavSidebar({
  stockAnalysisEnabled,
  terminalEnabled,
  online,
  loginEnabled,
  loginDisplayName,
  theme,
  toggleTheme,
  onLogout,
  canAccessPage,
}: NavSidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const { t, i18n } = useTranslation('nav');

  const toggleLanguage = () => {
    const newLang = i18n.language === 'zh' ? 'en' : 'zh';
    i18n.changeLanguage(newLang);
  };
  const userInitial =
    (loginDisplayName || 'N').trim().charAt(0).toUpperCase() || 'N';

  return (
    <nav className={`nav-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="nav-logo">
        <button
          type="button"
          className="logo-icon"
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-label={isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        >
          N
        </button>
        <div className="logo-copy">
          <span className="logo-text">NanoClaw</span>
          <span className="logo-subtext">AI Workspace</span>
        </div>
      </div>

      <div className="nav-section">
        <div className="nav-section-title">{t('section.chat')}</div>
        {canAccessPage('chat') && (
          <NavLink
            to={navPageToPath('chat')}
            className={navItemClass}
            title={isCollapsed ? t('page.chat') : undefined}
          >
            <IconChat /> <span>{t('page.chat')}</span>
          </NavLink>
        )}
        {canAccessPage('im') && (
          <NavLink
            to={navPageToPath('im')}
            className={navItemClass}
            title={isCollapsed ? t('page.messages') : undefined}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>{' '}
            <span>{t('page.messages')}</span>
          </NavLink>
        )}
        {canAccessPage('companion') && (
          <NavLink
            to={navPageToPath('companion')}
            className={navItemClass}
            title={isCollapsed ? t('page.companion') : undefined}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
            </svg>{' '}
            <span>{t('page.companion')}</span>
          </NavLink>
        )}
      </div>

      <div className="nav-section">
        <div className="nav-section-title">{t('section.projects')}</div>
        {canAccessPage('tasks') && (
          <NavLink
            to={navPageToPath('tasks')}
            className={navItemClass}
            title={isCollapsed ? t('page.tasks') : undefined}
          >
            <IconCalendar /> <span>{t('page.tasks')}</span>
          </NavLink>
        )}
        {canAccessPage('repos') && (
          <NavLink
            to={navPageToPath('repos')}
            className={navItemClass}
            title={isCollapsed ? t('page.repos') : undefined}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>{' '}
            <span>{t('page.repos')}</span>
          </NavLink>
        )}
        {canAccessPage('workteam') && (
          <NavLink
            to={navPageToPath('workteam')}
            className={navItemClass}
            title={isCollapsed ? t('page.workflow') : undefined}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="5" r="3" />
              <path d="M12 8v4" />
              <circle cx="6" cy="17" r="3" />
              <circle cx="18" cy="17" r="3" />
              <path d="M12 12l-6 5" />
              <path d="M12 12l6 5" />
            </svg>{' '}
            <span>{t('page.workflow')}</span>
          </NavLink>
        )}
      </div>

      <div className="nav-section">
        <div className="nav-section-title">{t('section.aiCapabilities')}</div>
        {canAccessPage('assistants') && (
          <NavLink
            to={navPageToPath('assistants')}
            className={navItemClass}
            title={isCollapsed ? t('page.assistants') : undefined}
          >
            <IconWand /> <span>{t('page.assistants')}</span>
          </NavLink>
        )}
        {canAccessPage('soul') && (
          <NavLink
            to={navPageToPath('soul')}
            className={navItemClass}
            title={isCollapsed ? t('page.soul') : undefined}
          >
            <IconStar /> <span>{t('page.soul')}</span>
          </NavLink>
        )}
        {canAccessPage('knowledge') && (
          <NavLink
            to={navPageToPath('knowledge')}
            className={navItemClass}
            title={isCollapsed ? t('page.knowledge') : undefined}
          >
            <IconBook /> <span>{t('page.knowledge')}</span>
          </NavLink>
        )}
      </div>

      <div className="nav-section">
        <div className="nav-section-title">{t('section.tools')}</div>
        {canAccessPage('apps') && (
          <NavLink
            to={navPageToPath('apps')}
            className={navItemClass}
            title={isCollapsed ? t('page.apps') : undefined}
          >
            <IconPuzzle /> <span>{t('page.apps')}</span>
          </NavLink>
        )}
        {stockAnalysisEnabled && canAccessPage('stock-analysis') && (
          <NavLink
            to={navPageToPath('stock-analysis')}
            className={navItemClass}
            title={isCollapsed ? t('page.stockAnalysis') : undefined}
          >
            <IconCandlestick /> <span>{t('page.stockAnalysis')}</span>
          </NavLink>
        )}
        {terminalEnabled && canAccessPage('terminal') && (
          <NavLink
            to={navPageToPath('terminal')}
            className={navItemClass}
            title={isCollapsed ? t('page.terminal') : undefined}
          >
            <IconTerminal /> <span>{t('page.terminal')}</span>
          </NavLink>
        )}
      </div>

      <div className="nav-section">
        <div className="nav-section-title">{t('section.system')}</div>
        {canAccessPage('channels') && (
          <NavLink
            to={navPageToPath('channels')}
            className={navItemClass}
            title={isCollapsed ? t('page.channels') : undefined}
          >
            <IconChannel /> <span>{t('page.channels')}</span>
          </NavLink>
        )}
        {canAccessPage('settings') && (
          <NavLink
            to={navPageToPath('settings')}
            className={navItemClass}
            title={isCollapsed ? t('page.settings') : undefined}
          >
            <IconSettings /> <span>{t('page.settings')}</span>
          </NavLink>
        )}
        {canAccessPage('users') && (
          <NavLink
            to={navPageToPath('users')}
            className={navItemClass}
            title={isCollapsed ? t('page.users') : undefined}
          >
            <IconUsers /> <span>{t('page.users')}</span>
          </NavLink>
        )}
      </div>

      <div className="nav-bottom">
        <div className="nav-profile">
          <div className="nav-avatar" aria-hidden="true">
            {loginEnabled ? userInitial : 'N'}
          </div>
          <div className="nav-profile-copy">
            <div className="nav-user">
              {loginEnabled
                ? t('user.loggedIn', { name: loginDisplayName })
                : t('user.guest')}
            </div>
            <div
              className="nav-status"
              title={
                isCollapsed
                  ? online
                    ? t('status.online')
                    : t('status.offline')
                  : undefined
              }
            >
              <span
                className={`status-dot ${online ? 'online' : ''}`}
                aria-hidden="true"
              />
              <span>{online ? t('status.online') : t('status.offline')}</span>
            </div>
          </div>
        </div>
        <div className="nav-actions">
          <button
            type="button"
            className="nav-theme-btn"
            onClick={toggleTheme}
            title={
              isCollapsed
                ? theme === 'dark'
                  ? t('theme.light')
                  : t('theme.dark')
                : undefined
            }
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
            <span>{theme === 'dark' ? t('theme.light') : t('theme.dark')}</span>
          </button>
          <button
            type="button"
            className="nav-lang-btn"
            onClick={toggleLanguage}
            title={t('lang.switch')}
          >
            <span>{i18n.language === 'zh' ? 'EN' : '中'}</span>
          </button>
        </div>
        {loginEnabled && (
          <button type="button" className="nav-logout-btn" onClick={onLogout}>
            {t('logout')}
          </button>
        )}
      </div>
    </nav>
  );
}
