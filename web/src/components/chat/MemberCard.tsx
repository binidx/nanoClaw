import React from 'react';
import { useTranslation } from 'react-i18next';

export interface MemberCardProps {
  userId: string;
  displayName: string;
  role?: 'owner' | 'admin' | 'member';
  isOnline?: boolean;
  onAction?: (userId: string, action: 'kick' | 'setAdmin' | 'setMember') => void;
  showActions?: boolean;
}

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

export const MemberCard: React.FC<MemberCardProps> = ({
  userId,
  displayName,
  role = 'member',
  isOnline,
  onAction,
  showActions = false,
}) => {
  const { t } = useTranslation('chat');
  const roleLabel = role === 'owner' ? t('member.role.owner') : role === 'admin' ? t('member.role.admin') : '';
  return (
    <div className="chat-member-card">
      <div className="chat-member-avatar-wrap">
        <div className="chat-member-avatar">{getInitial(displayName)}</div>
        {isOnline !== undefined && (
          <span
            className={`chat-member-status ${isOnline ? 'online' : 'offline'}`}
          />
        )}
      </div>
      <div className="chat-member-info">
        <span className="chat-member-name">{displayName}</span>
        {roleLabel && (
          <span className={`chat-member-role ${role}`}>
            {roleLabel}
          </span>
        )}
      </div>
      {showActions && onAction && role !== 'owner' && (
        <div className="chat-member-actions">
          <button
            className="chat-member-action-btn"
            onClick={() =>
              onAction(userId, role === 'admin' ? 'setMember' : 'setAdmin')
            }
            title={role === 'admin' ? t('member.action.removeAdmin') : t('member.action.setAdmin')}
          >
            {role === 'admin' ? '↓' : '↑'}
          </button>
          <button
            className="chat-member-action-btn danger"
            onClick={() => onAction(userId, 'kick')}
            title={t('member.action.remove')}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
};
