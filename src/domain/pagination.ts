export type PageSize = 10 | 50 | 100 | 'ALL';

export function getPageCount(totalItems: number, pageSize: PageSize): number {
  if (totalItems <= 0 || pageSize === 'ALL') return 1;
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

export function paginate<T>(items: T[], page: number, pageSize: PageSize): T[] {
  if (pageSize === 'ALL') return items;
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function pageRange(totalItems: number, page: number, pageSize: PageSize): { from: number; to: number } {
  if (totalItems <= 0) return { from: 0, to: 0 };
  if (pageSize === 'ALL') return { from: 1, to: totalItems };
  const from = Math.min((Math.max(1, page) - 1) * pageSize + 1, totalItems);
  return { from, to: Math.min(from + pageSize - 1, totalItems) };
}

export const pageSizes: PageSize[] = [10, 50, 100, 'ALL'];
