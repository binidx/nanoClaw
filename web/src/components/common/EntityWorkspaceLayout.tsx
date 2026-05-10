import React from 'react';

export interface EntityWorkspaceLayoutProps {
  list: React.ReactNode;
  detail: React.ReactNode;
  aside?: React.ReactNode;
  selected?: boolean;
  emptyState?: React.ReactNode;
  className?: string;
}

export function EntityWorkspaceLayout({
  list,
  detail,
  aside,
  selected = true,
  emptyState,
  className = '',
}: EntityWorkspaceLayoutProps) {
  return (
    <div
      className={`nc-entity-workspace${aside ? ' nc-entity-workspace--with-aside' : ''} ${className}`.trim()}
    >
      <aside className="nc-entity-workspace-list">{list}</aside>
      <main className="nc-entity-workspace-detail">
        {selected ? detail : emptyState}
      </main>
      {aside ? <aside className="nc-entity-workspace-aside">{aside}</aside> : null}
    </div>
  );
}
