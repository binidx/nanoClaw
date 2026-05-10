import type { Request } from 'express';

export interface PaginationQuery {
  page: number;
  pageSize: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

export function parsePaginationQuery(req: Request): PaginationQuery {
  const rawPage = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : 1;
  const rawSize = typeof req.query.pageSize === 'string' ? parseInt(req.query.pageSize, 10) : DEFAULT_PAGE_SIZE;
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, isNaN(rawSize) ? DEFAULT_PAGE_SIZE : rawSize));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
  const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : undefined;
  const sortOrder =
    typeof req.query.sortOrder === 'string' && req.query.sortOrder === 'asc' ? 'asc' : 'desc';

  return { page, pageSize, search, sortBy, sortOrder };
}

/**
 * Apply in-memory pagination to a pre-fetched array.
 * Useful when the full list is small enough to load at once
 * but the frontend wants paginated views.
 */
export function paginateArray<T>(
  items: T[],
  pq: PaginationQuery,
): PaginatedResponse<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pq.pageSize));
  const safePage = Math.min(pq.page, totalPages);
  const offset = (safePage - 1) * pq.pageSize;
  const data = items.slice(offset, offset + pq.pageSize);
  return {
    data,
    pagination: { page: safePage, pageSize: pq.pageSize, total, totalPages },
  };
}

export function buildPaginatedResponse<T>(
  data: T[],
  total: number,
  pq: PaginationQuery,
): PaginatedResponse<T> {
  const totalPages = Math.max(1, Math.ceil(total / pq.pageSize));
  return {
    data,
    pagination: { page: pq.page, pageSize: pq.pageSize, total, totalPages },
  };
}
