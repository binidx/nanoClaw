import React, { useState } from 'react';

export interface InfoPanelSectionProps {
  title: string;
  badge?: string | number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export const InfoPanelSection: React.FC<InfoPanelSectionProps> = ({
  title,
  badge,
  defaultOpen = false,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`chat-info-section${open ? ' open' : ''}`}>
      <button
        className="chat-info-section-header"
        onClick={() => setOpen(!open)}
      >
        <span className="chat-info-section-arrow">{open ? '▼' : '▶'}</span>
        <span className="chat-info-section-title">{title}</span>
        {badge !== undefined && (
          <span className="chat-info-section-badge">{badge}</span>
        )}
      </button>
      {open && <div className="chat-info-section-body">{children}</div>}
    </div>
  );
};
