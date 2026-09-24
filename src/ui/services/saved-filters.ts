import type { SearchFilters } from '../../domain/search-filters.ts';
import { emptySearchFilters } from '../../domain/search-filters.ts';

/**
 * Persists the last-used search filters per view so the panel restores them
 * on reopen. This is UI preference state ONLY: it lives under its own
 * chrome.storage.local key, never touches the entity stores (workspaces,
 * banks, queue, sessions, attempts, settings), and never leaves the device.
 */
const SAVED_FILTERS_KEY = 'xPilotSavedFilters';

export type SavedFilterView = 'queue' | 'banks' | 'sessions' | 'history';
export type SavedFilters = Partial<Record<SavedFilterView, SearchFilters>>;

function isSearchFiltersShape(value: unknown): value is SearchFilters {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.query === 'string'
    && typeof candidate.status === 'string'
    && typeof candidate.bankId === 'string'
    && typeof candidate.sessionId === 'string'
    && typeof candidate.workspaceId === 'string'
    && typeof candidate.dateFrom === 'string'
    && typeof candidate.dateTo === 'string';
}

export function sanitizeSavedFilters(saved: unknown): SavedFilters {
  if (!saved || typeof saved !== 'object') return {};
  const views: SavedFilterView[] = ['queue', 'banks', 'sessions', 'history'];
  const source = saved as Record<string, unknown>;
  const output: SavedFilters = {};
  for (const view of views) {
    if (isSearchFiltersShape(source[view])) output[view] = source[view];
  }
  return output;
}

export async function loadSavedFilters(): Promise<SavedFilters> {
  try {
    const stored = await globalThis.chrome?.storage?.local?.get(SAVED_FILTERS_KEY) as Record<string, unknown> | undefined;
    return sanitizeSavedFilters(stored?.[SAVED_FILTERS_KEY]);
  } catch {
    return {};
  }
}

export async function saveSavedFilter(view: SavedFilterView, filters: SearchFilters): Promise<void> {
  try {
    const current = await loadSavedFilters();
    // Drop empty filters entirely so clearing a view also clears its entry.
    const next = { ...current, [view]: filters.query || filters.status !== emptySearchFilters.status || filters.bankId || filters.sessionId || filters.workspaceId || filters.dateFrom || filters.dateTo ? filters : undefined };
    await globalThis.chrome?.storage?.local?.set({ [SAVED_FILTERS_KEY]: next });
  } catch {
    /* preference persistence is best-effort */
  }
}

/**
 * All four views persist on every filter change, so concurrent saves would
 * race (read-merge-write per call, last writer clobbering the others).
 * Serializing through a single queue makes every read-merge-write atomic
 * relative to the other views' saves.
 */
let saveQueue: Promise<void> = Promise.resolve();

export function queueSavedFilterSave(view: SavedFilterView, filters: SearchFilters): Promise<void> {
  const run = saveQueue.then(() => saveSavedFilter(view, filters));
  saveQueue = run.catch(() => undefined);
  return run;
}
