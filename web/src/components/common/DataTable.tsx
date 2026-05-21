import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pagination } from './Pagination';

export interface DataTableColumn<T> {
  key: string;
  title: string;
  width?: number | string;
  render?: (row: T, index: number) => React.ReactNode;
  sortable?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  rowKey: (row: T, index: number) => string;
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  emptyText?: string;
  onSort?: (key: string, order: 'asc' | 'desc') => void;
  sortKey?: string;
  sortOrder?: 'asc' | 'desc';
  loading?: boolean;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  emptyText,
  onSort,
  sortKey,
  sortOrder,
  loading,
}: DataTableProps<T>) {
  const { t } = useTranslation('common');
  const handleSort = (col: DataTableColumn<T>) => {
    if (!col.sortable || !onSort) return;
    const nextOrder = sortKey === col.key && sortOrder === 'asc' ? 'desc' : 'asc';
    onSort(col.key, nextOrder);
  };
  const handleSortKeyDown = (
    event: React.KeyboardEvent<HTMLTableCellElement>,
    col: DataTableColumn<T>,
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleSort(col);
  };
  const getAriaSort = (
    col: DataTableColumn<T>,
  ): React.AriaAttributes['aria-sort'] => {
    if (!col.sortable) return undefined;
    if (sortKey !== col.key) return 'none';
    return sortOrder === 'desc' ? 'descending' : 'ascending';
  };

  return (
    <div className="nc-data-table-wrapper">
      <div className="nc-data-table-scroll">
        <table className="nc-data-table">
          <thead>
            <tr>
              {columns.map(col => {
                const sortable = Boolean(col.sortable && onSort);
                return (
                  <th
                    key={col.key}
                    style={col.width ? { width: typeof col.width === 'number' ? `${col.width}px` : col.width } : undefined}
                    className={col.sortable ? 'nc-sortable' : undefined}
                    onClick={sortable ? () => handleSort(col) : undefined}
                    onKeyDown={sortable ? e => handleSortKeyDown(e, col) : undefined}
                    tabIndex={sortable ? 0 : undefined}
                    aria-sort={getAriaSort(col)}
                  >
                    <span>{col.title}</span>
                    {col.sortable && sortKey === col.key && (
                      <span className="nc-sort-arrow">{sortOrder === 'asc' ? ' ↑' : ' ↓'}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={columns.length} className="nc-table-loading">{t('common.dataTable.loading')}</td></tr>
            ) : data.length === 0 ? (
              <tr><td colSpan={columns.length} className="nc-table-empty">{emptyText ?? t('common.dataTable.noData')}</td></tr>
            ) : (
              data.map((row, idx) => (
                <tr key={rowKey(row, idx)}>
                  {columns.map(col => (
                    <td key={col.key}>
                      {col.render ? col.render(row, idx) : (row as Record<string, unknown>)[col.key] as React.ReactNode}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {page !== undefined && pageSize !== undefined && total !== undefined && onPageChange && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      )}
    </div>
  );
}
