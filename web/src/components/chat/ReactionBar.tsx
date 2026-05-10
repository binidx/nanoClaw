import React from 'react';

export interface ReactionGroup {
  emoji: string;
  count: number;
  users: string[];
  reacted?: boolean;
}

export interface ReactionBarProps {
  reactions: ReactionGroup[];
  onToggle: (emoji: string) => void;
}

export const ReactionBar: React.FC<ReactionBarProps> = ({
  reactions,
  onToggle,
}) => {
  if (reactions.length === 0) return null;

  return (
    <div className="chat-reaction-bar">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          className={`chat-reaction-chip${r.reacted ? ' reacted' : ''}`}
          onClick={() => onToggle(r.emoji)}
          title={r.users.join(', ')}
        >
          <span className="chat-reaction-emoji">{r.emoji}</span>
          <span className="chat-reaction-count">{r.count}</span>
        </button>
      ))}
    </div>
  );
};
