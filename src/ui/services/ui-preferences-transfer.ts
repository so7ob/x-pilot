import type { SavedFilters } from './saved-filters.ts';
import { sanitizeSavedFilters } from './saved-filters.ts';
import type { FilterPresetStore } from './filter-presets.ts';
import { sanitizePresetStore } from './filter-presets.ts';
import { sanitizeRecentCommandIds } from './command-palette.ts';

/**
 * Versioned transfer envelope for UI PREFERENCE state: the saved search
 * filters, the named filter presets, and the recent command-palette ids.
 *
 * This state is deliberately kept OUT of the entity backup unless the user
 * explicitly opts in (consent checkbox on export + an explicit mention in
 * the restore confirmation). It lives under its own chrome.storage.local
 * keys, never overlaps the entity stores (workspaces, banks, queue,
 * sessions, attempts, settings), and never leaves the device.
 *
 * Pure module: storage is injected as a minimal { get, set } shape so the
 * whole collect/sanitize/apply pipeline is contract-testable without a
 * chrome runtime. Importers (storage-repository) decide WHEN to call it;
 * this module only knows HOW to move the three keys safely.
 */

export const UI_PREFERENCES_FORMAT = 'x-pilot-ui-preferences';
export const UI_PREFERENCES_FORMAT_VERSION = 1;

export const SAVED_FILTERS_PREFERENCE_KEY = 'xPilotSavedFilters';
export const FILTER_PRESETS_PREFERENCE_KEY = 'xPilotFilterPresets';
export const RECENT_COMMANDS_PREFERENCE_KEY = 'xPilotRecentCommands';

/** The exact chrome.storage.local keys covered by the bundle, in write order. */
export const UI_PREFERENCE_KEYS: readonly string[] = [
  SAVED_FILTERS_PREFERENCE_KEY,
  FILTER_PRESETS_PREFERENCE_KEY,
  RECENT_COMMANDS_PREFERENCE_KEY,
];

export interface UiPreferencesBundle {
  format: typeof UI_PREFERENCES_FORMAT;
  formatVersion: typeof UI_PREFERENCES_FORMAT_VERSION;
  collectedAt: number;
  savedFilters: SavedFilters;
  filterPresets: FilterPresetStore;
  recentCommands: string[];
}

/** Minimal storage surface used here (structural subset of chrome.storage.local). */
export interface UiPreferencesStorage {
  get: (keys: readonly string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function presetCount(store: FilterPresetStore): number {
  return Object.values(store).reduce((count, list) => count + (list?.length ?? 0), 0);
}

/**
 * Reads the three preference keys through the injected storage and
 * sanitizes every field. Returns null when the user has nothing stored —
 * an empty bundle would only add noise to the envelope and the consent UI.
 */
export async function collectUiPreferences(reader: UiPreferencesStorage): Promise<UiPreferencesBundle | null> {
  const stored = await reader.get(UI_PREFERENCE_KEYS);
  const savedFilters = sanitizeSavedFilters(stored[SAVED_FILTERS_PREFERENCE_KEY]);
  const filterPresets = sanitizePresetStore(stored[FILTER_PRESETS_PREFERENCE_KEY]);
  const recentCommands = sanitizeRecentCommandIds(stored[RECENT_COMMANDS_PREFERENCE_KEY]);
  const empty =
    Object.keys(savedFilters).length === 0
    && presetCount(filterPresets) === 0
    && recentCommands.length === 0;
  if (empty) return null;
  return {
    format: UI_PREFERENCES_FORMAT,
    formatVersion: UI_PREFERENCES_FORMAT_VERSION,
    collectedAt: Date.now(),
    savedFilters,
    filterPresets,
    recentCommands,
  };
}

/**
 * Structural check for envelopes read back from a backup file. Format and
 * version must match exactly; field sanitization happens afterwards via
 * sanitizeUiPreferencesBundle (defense in depth — never trust file input).
 */
export function isUiPreferencesEnvelopeShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.format !== UI_PREFERENCES_FORMAT) return false;
  if (value.formatVersion !== UI_PREFERENCES_FORMAT_VERSION) return false;
  if (typeof value.collectedAt !== 'number' || !Number.isFinite(value.collectedAt)) return false;
  if (!isRecord(value.savedFilters) || !isRecord(value.filterPresets)) return false;
  if (!Array.isArray(value.recentCommands)) return false;
  return true;
}

/**
 * Sanitizes an untrusted bundle (file input) into a safe write-ready
 * bundle, or null when the shape itself is invalid. Every field passes the
 * same sanitizers used at runtime, so a malicious file can at worst write
 * empty/clean preference data — never entity state.
 */
export function sanitizeUiPreferencesBundle(value: unknown): UiPreferencesBundle | null {
  if (!isUiPreferencesEnvelopeShape(value)) return null;
  const candidate = value as UiPreferencesBundle;
  return {
    format: UI_PREFERENCES_FORMAT,
    formatVersion: UI_PREFERENCES_FORMAT_VERSION,
    collectedAt: candidate.collectedAt,
    savedFilters: sanitizeSavedFilters(candidate.savedFilters),
    filterPresets: sanitizePresetStore(candidate.filterPresets),
    recentCommands: sanitizeRecentCommandIds(candidate.recentCommands),
  };
}

/**
 * Write-ready chrome.storage.local map covering ALL THREE keys. Empty
 * preference state writes empty values too — a restore must fully define
 * the preference surface it consented to overwrite (no stale leftovers).
 */
export function uiPreferenceWrites(bundle: UiPreferencesBundle): Record<string, unknown> {
  return {
    [SAVED_FILTERS_PREFERENCE_KEY]: bundle.savedFilters,
    [FILTER_PRESETS_PREFERENCE_KEY]: bundle.filterPresets,
    [RECENT_COMMANDS_PREFERENCE_KEY]: bundle.recentCommands,
  };
}

/**
 * Applies a (trusted, already sanitized) bundle through the injected
 * storage. Returns the counts that landed so the UI can show an honest,
 * localized confirmation.
 */
export async function applyUiPreferences(bundle: UiPreferencesBundle, storage: UiPreferencesStorage): Promise<{ savedFilterViews: number; presetCount: number; recentCommands: number }> {
  await storage.set(uiPreferenceWrites(bundle));
  return {
    savedFilterViews: Object.keys(bundle.savedFilters).length,
    presetCount: presetCount(bundle.filterPresets),
    recentCommands: bundle.recentCommands.length,
  };
}
