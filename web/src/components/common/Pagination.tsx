import { NcSelect } from './NcSelect';
import { useTranslation } from 'react-i18next';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50],
}: PaginationProps) {
  const { t } = useTranslation('common');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safeCurrentPage = Math.min(page, totalPages);

  const getVisiblePages = (): (number | 'ellipsis')[] => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: (number | 'ellipsis')[] = [1];
    const start = Math.max(2, safeCurrentPage - 1);
    const end = Math.min(totalPages - 1, safeCurrentPage + 1);
    if (start > 2) pages.push('ellipsis');
    for (let i = start; i <= end; i++) pages.push(i);
    if (end < totalPages - 1) pages.push('ellipsis');
    pages.push(totalPages);
    return pages;
  };

  if (total <= 0) return null;

  return (
    <div className="nc-pagination">
      <div className="nc-pagination-info">
        {t('common.pagination.total', { total })}
      </div>
      <div className="nc-pagination-controls">
        <button
          type="button"
          className="nc-pagination-btn"
          disabled={safeCurrentPage <= 1}
          onClick={() => onPageChange(safeCurrentPage - 1)}
          aria-label={t('common.pagination.prev')}
        >
          ‹
        </button>
        {getVisiblePages().map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`e${i}`} className="nc-pagination-ellipsis">…</span>
          ) : (
            <button
              key={p}
              type="button"
              className={`nc-pagination-btn${p === safeCurrentPage ? ' active' : ''}`}
              onClick={() => onPageChange(p)}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          className="nc-pagination-btn"
          disabled={safeCurrentPage >= totalPages}
          onClick={() => onPageChange(safeCurrentPage + 1)}
          aria-label={t('common.pagination.next')}
        >
          ›
        </button>
      </div>
      {onPageSizeChange && (
        <NcSelect
          className="nc-pagination-size"
          value={pageSize}
          onChange={e => onPageSizeChange(Number(e.target.value))}
        >
          {pageSizeOptions.map(s => (
            <option key={s} value={s}>{t('common.pagination.perPage', { size: s })}</option>
          ))}
        </NcSelect>
      )}
    </div>
  );
}
