import React from 'react';

export type AppHeroHeaderVariant = 'library' | 'workspace';

export interface AppHeroHeaderProps
  extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  controls?: React.ReactNode;
  meta?: React.ReactNode;
  variant?: AppHeroHeaderVariant;
  onTitleClick?: () => void;
}

export function AppHeroHeader({
  title,
  subtitle,
  controls,
  meta,
  variant = 'library',
  onTitleClick,
  className = '',
  ...rest
}: AppHeroHeaderProps) {
  const titleInteractive = Boolean(onTitleClick);

  return (
    <header
      className={['nc-app-hero', `nc-app-hero-${variant}`, className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <div className="nc-app-hero-copy">
        <div
          className={`nc-app-hero-title-stack${titleInteractive ? ' is-clickable' : ''}`}
          onClick={onTitleClick}
          onKeyDown={
            onTitleClick
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onTitleClick();
                  }
                }
              : undefined
          }
          role={onTitleClick ? 'button' : undefined}
          tabIndex={onTitleClick ? 0 : undefined}
        >
          <h2>{title}</h2>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        {meta ? <div className="nc-app-hero-meta">{meta}</div> : null}
      </div>
      {controls ? <div className="nc-app-hero-controls">{controls}</div> : null}
    </header>
  );
}
