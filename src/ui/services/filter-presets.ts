import type { SearchFilters } from '../../domain/search-filters.ts';
import { emptySearchFilters } from '../../domain/search-filters.ts';
import type { SavedFilterView } from './saved-filters.ts';

/**
 * Named filter presets: the user can save the current filter combination of a
 * view under a name, re-apply it with one click, and delete it. This is UI
 * preference state ONLY: it lives under its own chrome.storage.local key,
 * never touches the entity stores (workspaces, banks, queue, sessions,
 * attempts, settings), and never leaves the device.
 */
const FILTER_PRESETS_KEY = 'xPilotFilterPresets';

export const MAX_FILTER_PRESETS_PER_VIEW = 20;
export const MAX_FILTER_PRESET_NAME_LENGTH = 60;

export type FilterPresetView = SavedFilterView;

export interface FilterPreset {
  id: string;
  name: string;
  view: FilterPresetView;
  filters: SearchFilters;
  createdAt: number;
}

export type FilterPresetStore = Partial<Record<FilterPresetView, FilterPreset[]>>;

export type SavePresetOutcome =
  | { ok: true; preset: FilterPreset }
  | { ok: false; reason: 'empty-name' | 'name-too-long' | 'empty-filters' | 'view-full' | 'storage-failure' };

export type DeletePresetOutcome = { ok: boolean; reason?: 'storage-failure' };

export type RenamePresetOutcome =
  | { ok: true; preset: FilterPreset }
  | { ok: false; reason: 'empty-name' | 'name-too-long' | 'not-found' | 'storage-failure' };

export type MovePresetDirection = 'up' | 'down';

export type MovePresetOutcome =
  | { ok: true; presets: FilterPreset[] }
  | { ok: false; reason: 'not-found' | 'storage-failure' };

const VIEWS: FilterPresetView[] = ['queue', 'banks', 'sessions', 'history'];

export function isFilterPresetView(value: unknown): value is FilterPresetView {
  return typeof value === 'string' && (VIEWS as string[]).includes(value);
}

export function normalizePresetName(name: string): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim();
}

function makePresetId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isSearchFiltersShape(value: unknown): value is SearchFilters {
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

function isFilterPresetShape(value: unknown): value is FilterPreset {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && candidate.id.length > 0
    && typeof candidate.name === 'string'
    && candidate.name.length > 0
    && isFilterPresetView(candidate.view)
    && isSearchFiltersShape(candidate.filters)
    && typeof candidate.createdAt === 'number'
    && Number.isFinite(candidate.createdAt);
}

/** Drops malformed entries; never throws on corrupt storage data. */
export function sanitizePresetStore(stored: unknown): FilterPresetStore {
  if (!stored || typeof stored !== 'object') return {};
  const source = stored as Record<string, unknown>;
  const output: FilterPresetStore = {};
  for (const view of VIEWS) {
    const list = source[view];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    const presets: FilterPreset[] = [];
    for (const entry of list) {
      if (!isFilterPresetShape(entry)) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      presets.push({ ...entry, name: normalizePresetName(entry.name) || entry.name, filters: { ...entry.filters } });
    }
    if (presets.length) output[view] = presets.slice(0, MAX_FILTER_PRESETS_PER_VIEW);
  }
  return output;
}

/**
 * Single source of truth for "nothing worth saving": a preset must carry a
 * real selection. The workspace scope alone does not count — it is
 * auto-initialized to the active workspace on every view, so a preset that
 * only pins the workspace would be a no-op.
 */
function isEmptyFilters(filters: SearchFilters): boolean {
  return !hasFilterSelection(filters);
}

/**
 * UI gating helper: true when the user selected something worth saving.
 * The workspace scope alone does NOT count — it is auto-initialized to the
 * active workspace on every view, so counting it would make the save
 * affordance permanently enabled and presets meaningless.
 */
export function hasFilterSelection(filters: SearchFilters): boolean {
  return filters.query !== emptySearchFilters.query
    || filters.status !== emptySearchFilters.status
    || Boolean(filters.bankId)
    || Boolean(filters.sessionId)
    || Boolean(filters.dateFrom)
    || Boolean(filters.dateTo);
}

/**
 * Exact equality across every SearchFilters field (workspace scope included).
 * Used to highlight the preset chip whose filters match the live view — after
 * applying a preset, its chip is the active one; any manual filter change
 * clears the highlight.
 */
export function filtersEqual(a: SearchFilters, b: SearchFilters): boolean {
  const keys = Object.keys(emptySearchFilters) as (keyof SearchFilters)[];
  return keys.every((key) => a[key] === b[key]);
}

async function readStore(): Promise<FilterPresetStore> {
  try {
    const stored = await globalThis.chrome?.storage?.local?.get(FILTER_PRESETS_KEY) as Record<string, unknown> | undefined;
    return sanitizePresetStore(stored?.[FILTER_PRESETS_KEY]);
  } catch {
    return {};
  }
}

async function writeStore(store: FilterPresetStore): Promise<boolean> {
  try {
    await globalThis.chrome?.storage?.local?.set({ [FILTER_PRESETS_KEY]: store });
    return true;
  } catch {
    return false;
  }
}

export async function loadFilterPresets(): Promise<FilterPresetStore> {
  return readStore();
}

export function presetsForView(store: FilterPresetStore, view: FilterPresetView): FilterPreset[] {
  return store[view] ?? [];
}

/**
 * Saves a named preset for a view. Serial validation: trims/collapses the
 * name, rejects empty names, empty filters, and exceeding the per-view cap.
 * Storage failures surface as `{ ok: false, reason: 'storage-failure' }`
 * instead of throwing so the UI can show a localized notice.
 */
export async function saveFilterPreset(view: FilterPresetView, rawName: string, filters: SearchFilters): Promise<SavePresetOutcome> {
  const name = normalizePresetName(rawName);
  if (!name) return { ok: false, reason: 'empty-name' };
  if (name.length > MAX_FILTER_PRESET_NAME_LENGTH) return { ok: false, reason: 'name-too-long' };
  if (isEmptyFilters(filters)) return { ok: false, reason: 'empty-filters' };

  return queuePresetMutation(async () => {
    const store = await readStore();
    const existing = store[view] ?? [];
    if (existing.length >= MAX_FILTER_PRESETS_PER_VIEW) return { ok: false, reason: 'view-full' };

    const preset: FilterPreset = { id: makePresetId(), name, view, filters: { ...filters }, createdAt: Date.now() };
    const ok = await writeStore({ ...store, [view]: [...existing, preset] });
    return ok ? { ok: true, preset } : { ok: false, reason: 'storage-failure' };
  });
}

/**
 * Renames a saved preset in place. Validation mirrors saveFilterPreset
 * (trim + collapse whitespace, non-empty, max length). Order, filters and
 * createdAt of the preset are untouched — only the name changes.
 */
export async function renameFilterPreset(view: FilterPresetView, presetId: string, rawName: string): Promise<RenamePresetOutcome> {
  const name = normalizePresetName(rawName);
  if (!name) return { ok: false, reason: 'empty-name' };
  if (name.length > MAX_FILTER_PRESET_NAME_LENGTH) return { ok: false, reason: 'name-too-long' };

  return queuePresetMutation(async () => {
    const store = await readStore();
    const existing = store[view] ?? [];
    const index = existing.findIndex((preset) => preset.id === presetId);
    if (index === -1) return { ok: false, reason: 'not-found' };

    const renamed: FilterPreset = { ...existing[index], name };
    const next = existing.map((preset, i) => (i === index ? renamed : preset));
    const ok = await writeStore({ ...store, [view]: next });
    return ok ? { ok: true, preset: renamed } : { ok: false, reason: 'storage-failure' };
  });
}

/**
 * Moves a preset one position up (earlier) or down (later) within its view.
 * Moving past either end is a no-op success; unknown ids surface as
 * 'not-found' so the UI can resync instead of silently assuming success.
 */
export async function moveFilterPreset(view: FilterPresetView, presetId: string, direction: MovePresetDirection): Promise<MovePresetOutcome> {
  return queuePresetMutation(async () => {
    const store = await readStore();
    const existing = store[view] ?? [];
    const index = existing.findIndex((preset) => preset.id === presetId);
    if (index === -1) return { ok: false, reason: 'not-found' };

    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= existing.length) {
      return { ok: true, presets: existing };
    }
    const next = [...existing];
    const [moved] = next.splice(index, 1);
    next.splice(targetIndex, 0, moved);
    const ok = await writeStore({ ...store, [view]: next });
    return ok ? { ok: true, presets: next } : { ok: false, reason: 'storage-failure' };
  });
}

export async function deleteFilterPreset(view: FilterPresetView, presetId: string): Promise<DeletePresetOutcome> {
  return queuePresetMutation(async () => {
    const store = await readStore();
    const existing = store[view] ?? [];
    const next = existing.filter((preset) => preset.id !== presetId);
    if (next.length === existing.length) return { ok: true };
    const updated: FilterPresetStore = { ...store };
    if (next.length) updated[view] = next;
    else delete updated[view];
    return { ok: await writeStore(updated) };
  });
}

/**
 * Every mutation is a read-merge-write. The UI can trigger saves and deletes
 * across the four views in quick succession, so concurrent mutations would
 * clobber each other (last writer wins). Serializing every mutation through
 * one queue makes each read-merge-write atomic relative to the others — the
 * same race-proofing pattern as saved-filters.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function queuePresetMutation<T>(mutate: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(mutate, mutate);
  mutationQueue = run.catch(() => undefined);
  return run;
}
