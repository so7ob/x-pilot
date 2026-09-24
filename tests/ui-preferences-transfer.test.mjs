/**
 * UI preferences transfer (backup consent feature).
 * The transfer module must be PURE (storage injected), sanitize every field
 * through the same runtime sanitizers, return null for an empty device,
 * reject malformed envelopes, produce write-ready maps covering ALL THREE
 * keys, and never import or touch entity stores.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  UI_PREFERENCES_FORMAT,
  UI_PREFERENCES_FORMAT_VERSION,
  UI_PREFERENCE_KEYS,
  SAVED_FILTERS_PREFERENCE_KEY,
  FILTER_PRESETS_PREFERENCE_KEY,
  RECENT_COMMANDS_PREFERENCE_KEY,
  collectUiPreferences,
  isUiPreferencesEnvelopeShape,
  sanitizeUiPreferencesBundle,
  uiPreferenceWrites,
  applyUiPreferences,
} from '../src/ui/services/ui-preferences-transfer.ts';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const transfer = fs.readFileSync(path.join(root, 'src/ui/services/ui-preferences-transfer.ts'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'src/storage/storage-repository.ts'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'src/background/service-worker.ts'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'src/ui/main.tsx'), 'utf8');
const savedFiltersService = fs.readFileSync(path.join(root, 'src/ui/services/saved-filters.ts'), 'utf8');
const models = fs.readFileSync(path.join(root, 'src/domain/models.ts'), 'utf8');

function mapStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  let failNextSet = false;
  return {
    storage: {
      async get(keys) {
        const out = {};
        for (const key of keys) if (map.has(key)) out[key] = map.get(key);
        return out;
      },
      async set(items) {
        if (failNextSet) throw new Error('quota');
        for (const [key, value] of Object.entries(items)) map.set(key, value);
      },
    },
    map,
    failNext: () => { failNextSet = true; },
  };
}

const PRESET = {
  id: 'preset-1', name: 'Campaign', view: 'queue',
  filters: { query: 'x', status: '', bankId: '', sessionId: '', workspaceId: '', dateFrom: '', dateTo: '' },
  createdAt: 100,
};

test('collectUiPreferences returns null when the device has no preference state', async () => {
  const { storage } = mapStore();
  assert.equal(await collectUiPreferences(storage), null);
  // Keys present but empty/invalid -> still nothing worth transferring
  const { storage: storage2 } = mapStore({ [SAVED_FILTERS_PREFERENCE_KEY]: { garbage: true }, [RECENT_COMMANDS_PREFERENCE_KEY]: ['', 5, null] });
  assert.equal(await collectUiPreferences(storage2), null);
});

test('collectUiPreferences sanitizes all three keys and stamps the envelope', async () => {
  const { storage } = mapStore({
    [SAVED_FILTERS_PREFERENCE_KEY]: { queue: { query: 'hello', status: '', bankId: '', sessionId: '', workspaceId: '', dateFrom: '', dateTo: '' }, evil: { query: 5 } },
    [FILTER_PRESETS_PREFERENCE_KEY]: { queue: [PRESET, { id: 'preset-1', name: 'dupe', view: 'queue', filters: PRESET.filters, createdAt: 1 }], banks: 'nope' },
    [RECENT_COMMANDS_PREFERENCE_KEY]: ['cmd-b', 'cmd-a', 'cmd-b', 42],
  });
  const bundle = await collectUiPreferences(storage);
  assert.ok(bundle);
  assert.equal(bundle.format, 'x-pilot-ui-preferences');
  assert.equal(bundle.formatVersion, 1);
  assert.equal(typeof bundle.collectedAt, 'number');
  assert.deepEqual(Object.keys(bundle.savedFilters), ['queue']);
  assert.equal(bundle.filterPresets.queue.length, 1); // duplicate id dropped
  assert.equal(bundle.filterPresets.banks, undefined); // non-array view dropped
  assert.deepEqual(bundle.recentCommands, ['cmd-b', 'cmd-a']); // deduped, capped
});

test('collectUiPreferences covers exactly the runtime saved-filters key (no drift)', () => {
  // The transfer module must quote the SAME key string the runtime service uses.
  assert.match(savedFiltersService, /const SAVED_FILTERS_KEY = 'xPilotSavedFilters';/);
  assert.equal(SAVED_FILTERS_PREFERENCE_KEY, 'xPilotSavedFilters');
  assert.deepEqual([...UI_PREFERENCE_KEYS], ['xPilotSavedFilters', 'xPilotFilterPresets', 'xPilotRecentCommands']);
});

test('envelope shape check rejects malformed/foreign payloads and accepts valid ones', () => {
  assert.equal(isUiPreferencesEnvelopeShape(null), false);
  assert.equal(isUiPreferencesEnvelopeShape('x-pilot-ui-preferences'), false);
  assert.equal(isUiPreferencesEnvelopeShape({ format: 'x-pilot-ui-preferences' }), false);
  assert.equal(isUiPreferencesEnvelopeShape({ format: 'x-pilot-ui-preferences', formatVersion: 1, collectedAt: 1, savedFilters: {}, filterPresets: {}, recentCommands: [] }), true);
  assert.equal(isUiPreferencesEnvelopeShape({ format: 'x-pilot-ui-preferences', formatVersion: 2, collectedAt: 1, savedFilters: {}, filterPresets: {}, recentCommands: [] }), false);
  assert.equal(isUiPreferencesEnvelopeShape({ format: 'x-pilot-ui-preferences', formatVersion: 1, collectedAt: 'now', savedFilters: {}, filterPresets: {}, recentCommands: [] }), false);
  assert.equal(isUiPreferencesEnvelopeShape({ format: 'x-pilot-ui-preferences', formatVersion: 1, collectedAt: 1, savedFilters: [], filterPresets: {}, recentCommands: [] }), false);
});

test('sanitizeUiPreferencesBundle sanitizes fields and returns null on bad shape', () => {
  const malicious = {
    format: 'x-pilot-ui-preferences', formatVersion: 1, collectedAt: 7,
    savedFilters: { queue: { query: { $ne: null }, status: '', bankId: '', sessionId: '', workspaceId: '', dateFrom: '', dateTo: '' }, nope: {} },
    filterPresets: { queue: [PRESET, null, { id: 'p2' }], history: [PRESET] },
    recentCommands: ['a', 'a', 9, 'b'],
    extra: 'dropped-at-shape-level? no — extra keys ignored',
  };
  const clean = sanitizeUiPreferencesBundle(malicious);
  assert.ok(clean);
  assert.deepEqual(Object.keys(clean.savedFilters), []);
  assert.deepEqual(clean.filterPresets.queue.map((p) => p.id), ['preset-1']);
  assert.deepEqual(Object.keys(clean.filterPresets), ['queue', 'history']);
  assert.deepEqual(clean.recentCommands, ['a', 'b']);
  assert.equal(sanitizeUiPreferencesBundle({ format: 'wrong' }), null);
  assert.equal(sanitizeUiPreferencesBundle(undefined), null);
});

test('uiPreferenceWrites covers ALL THREE keys so a restore fully defines the surface', () => {
  const bundle = sanitizeUiPreferencesBundle({ format: UI_PREFERENCES_FORMAT, formatVersion: UI_PREFERENCES_FORMAT_VERSION, collectedAt: 1, savedFilters: {}, filterPresets: {}, recentCommands: [] });
  const writes = uiPreferenceWrites(bundle);
  assert.deepEqual(Object.keys(writes).sort(), ['xPilotFilterPresets', 'xPilotRecentCommands', 'xPilotSavedFilters']);
  assert.deepEqual(writes[RECENT_COMMANDS_PREFERENCE_KEY], []); // empty stays empty, no stale leftovers
});

test('applyUiPreferences writes through injected storage and reports honest counts', async () => {
  const { storage, map, failNext } = mapStore({ [SAVED_FILTERS_PREFERENCE_KEY]: { legacy: true } });
  const bundle = sanitizeUiPreferencesBundle({
    format: 'x-pilot-ui-preferences', formatVersion: 1, collectedAt: 1,
    savedFilters: { queue: { query: 'q', status: '', bankId: '', sessionId: '', workspaceId: '', dateFrom: '', dateTo: '' } },
    filterPresets: { banks: [PRESET] },
    recentCommands: ['r1', 'r2'],
  });
  const result = await applyUiPreferences(bundle, storage);
  assert.deepEqual(result, { savedFilterViews: 1, presetCount: 1, recentCommands: 2 });
  assert.equal(map.has('legacy-injected'), false);
  assert.ok(map.get(SAVED_FILTERS_PREFERENCE_KEY));
  failNext();
  await assert.rejects(() => applyUiPreferences(bundle, storage), /quota/);
});

test('storage layer: consent-gated export, v3 validation, prefs ride Stage→Commit→Rollback', () => {
  // export is consent-gated and only bumps the format when prefs land
  assert.match(storage, /export async function exportBackup\(includeUiPreferences = false\)/);
  assert.match(storage, /const uiPreferences = includeUiPreferences \? await collectUiPreferences\(chrome\.storage\.local\) : null;/);
  assert.match(storage, /formatVersion: uiPreferences \? 3 : 2/);
  assert.match(storage, /\.\.\.\(uiPreferences \? \{ uiPreferences \} : \{\}\),/);
  // validation: v3 accepted; prefs present on wrong version or malformed shape -> INVALID_UI_PREFERENCES
  assert.match(storage, /backup\?\.formatVersion !== 1 && backup\?\.formatVersion !== 2 && backup\?\.formatVersion !== 3/);
  assert.match(storage, /INVALID_UI_PREFERENCES/);
  assert.match(storage, /hasUiPreferences: sanitizeUiPreferencesBundle\(backup\.uiPreferences\) !== null/);
  // restore: same keys staged + rolled back; absent prefs never touch the keys
  assert.match(storage, /const trustedPreferences = sanitizeUiPreferencesBundle\(backup\.uiPreferences\);/);
  assert.match(storage, /const preferenceKeys: readonly string\[\] = trustedPreferences \? UI_PREFERENCE_KEYS : \[\];/);
  assert.match(storage, /if \(trustedPreferences\) Object\.assign\(writes, uiPreferenceWrites\(trustedPreferences\)\);/);
  assert.match(storage, /V4_RUNTIME_KEY, \.\.\.preferenceKeys\]/);
  assert.match(storage, /\[\.\.\.currentKeys, META_KEY, \.\.\.preferenceKeys\]\.filter\(\(key\) => !\(key in writes\)\)/);
});

test('message + UI consent contract: flag flows from the checkbox to the worker', () => {
  assert.match(models, /uiPreferences\?: UiPreferencesBundle \| null;/);
  assert.match(models, /hasUiPreferences\?: boolean;/);
  assert.match(models, /\{ type: 'EXPORT_BACKUP'; includeUiPreferences\?: boolean \}/);
  assert.match(worker, /return exportBackup\(message\.includeUiPreferences === true\);/);
  // explicit consent UI on export AND restore
  assert.match(ui, /backup\.includePreferences/);
  assert.match(ui, /backup\.includePreferencesHint/);
  assert.match(ui, /includeUiPreferences: includeUiPrefs/);
  assert.match(ui, /confirm\.restoreBackupWithPreferences/);
  assert.match(ui, /backup\.restoredWithPreferences/);
});

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('transfer module is pure: no chrome API access and no entity-store imports', () => {
  const code = stripComments(transfer);
  assert.doesNotMatch(code, /globalThis\.chrome|chrome\./);
  assert.doesNotMatch(code, /storage-repository|domain\/models|service-worker/);
  // and the three keys it moves are UI preference keys only
  for (const forbidden of ['workspaceKey', 'v4BankKey', 'v4QueueKey', 'v4SessionsKey', 'v4AttemptsKey']) {
    assert.doesNotMatch(code, new RegExp(forbidden));
  }
});
