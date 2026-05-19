import React from 'react';
import { CatalogCard } from './CatalogCard';

export interface LibraryCardRow {
  key?: React.Key;
  label: React.ReactNode;
  value: React.ReactNode;
}

export interface LibraryCardProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  heading: React.ReactNode;
  badge?: React.ReactNode;
  rows: LibraryCardRow[];
  bodyClassName?: string;
}

export function LibraryCard({
  heading,
  badge,
  rows,
  bodyClassName = '',
  className = '',
  type = 'button',
  ...rest
}: LibraryCardProps) {
  const visibleRows = rows.filter(
    (row) =>
      row.value !== null && row.value !== undefined && row.value !== false,
  );

  return (
    <CatalogCard
      type={type}
      title={heading}
      badge={badge}
      rows={visibleRows}
      bodyClassName={bodyClassName}
      className={['nc-library-card', className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
