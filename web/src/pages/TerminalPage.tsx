import type { RefCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { IconTerminal } from '../components/AppIcons';

interface TerminalPageProps {
  terminalEnabled: boolean;
  activeJid: string | null;
  activeConversationTitle: string | null;
  terminalRef: RefCallback<HTMLDivElement>;
  openSettings: () => void;
  goBackToChat: () => void;
}

export function TerminalPage({
  terminalEnabled,
  activeJid,
  activeConversationTitle,
  terminalRef,
  openSettings,
  goBackToChat,
}: TerminalPageProps) {
  const { t } = useTranslation('terminal');
  if (!terminalEnabled) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <IconTerminal />
        </div>
        <h2>{t('auto.40de7a8a')}</h2>
        <p>{t('auto.e27cb1fd')}</p>
        <button className="empty-btn" onClick={openSettings}>
          {t('auto.757f1ab3')}
        </button>
      </div>
    );
  }

  if (!activeJid) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <IconTerminal />
        </div>
        <h2>{t('auto.adceefa3')}</h2>
        <p>{t('auto.6df7dc2d')}</p>
        <button className="empty-btn" onClick={goBackToChat}>
          {t('auto.136d477e')}
        </button>
      </div>
    );
  }

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-header-copy">
          <h2>{t('auto.4722bc0c')}</h2>
          <p>{t('auto.f9f9686d')}</p>
        </div>
      </div>
      <div className="page-body terminal-page-body">
        <div className="terminal-page-panel">
          <div className="terminal-header">
            <span>
              {t('auto.352485ff')}
              {activeConversationTitle ? ` · ${activeConversationTitle}` : ''}
            </span>
            <button className="terminal-close" onClick={goBackToChat}>
              {t('auto.136d477e')}
            </button>
          </div>
          <div
            className="terminal-body terminal-page-terminal"
            ref={terminalRef}
          />
        </div>
      </div>
    </div>
  );
}
