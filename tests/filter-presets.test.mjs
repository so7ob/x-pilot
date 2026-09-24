/**
 * Named filter presets (UI preferences only).
 * The helper must keep its persistence isolated from all entity stores and
 * the saved-filters key, survive corrupt/foreign data without throwing,
 * reject invalid presets, and stay race-free under concurrent mutations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFilterPresets,
  saveFilterPreset,
  deleteFilterPreset,
  presetsForView,
  hasFilterSelection,
  normalizePresetName,
  sanitizePresetStore,
  MAX_FILTER_PRESETS_PER_VIEW,
  MAX_FILTER_PRESET_NAME_LENGTH,
} from '../src/ui/services/filter-presets.ts';
import { emptySearchFilters } from '../src/domain/search-filters.ts';

const KEY = 'xPilotFilterPresets';
const SAVED_FILTERS_KEY = 'xPilotSavedFilters';
const store = new Map();

function installMockStorage() {
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (entries) => { for (const [k, v] of Object.entries(entries)) store.set(k, v); },
      },
    },
  };
}

function filtersWith(patch = {}) {
  return { ...emptySearchFilters, ...patch };
}

test('preset round-trip: save, load, apply filters', async () => {
  installMockStorage();
  store.clear();
  const outcome = await saveFilterPreset('sessions', 'Launch week', filtersWith({ query: 'launch', status: 'FAILED' }));
  assert.equal(outcome.ok, true);
  const loaded = await loadFilterPresets();
  const presets = presetsForView(loaded, 'sessions');
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, 'Launch week');
  assert.equal(presets[0].filters.query, 'launch');
  assert.equal(presets[0].filters.status, 'FAILED');
  assert.equal(presets[0].filters.workspaceId, '');
  assert.equal(typeof presets[0].createdAt, 'number');
  assert.ok(presets[0].id.length > 0);
});

test('presets are isolated per view', async () => {
  installMockStorage();
  store.clear();
  await saveFilterPreset('banks', 'Bank filter', filtersWith({ query: 'x.com/search' }));
  await saveFilterPreset('queue', 'Queue filter', filtersWith({ status: 'PENDING' }));
  const loaded = await loadFilterPresets();
  assert.equal(presetsForView(loaded, 'banks')[0].name, 'Bank filter');
  assert.equal(presetsForView(loaded, 'queue')[0].name, 'Queue filter');
  assert.equal(presetsForView(loaded, 'sessions').length, 0);
  assert.equal(presetsForView(loaded, 'history').length, 0);
});

test('delete removes only the targeted preset', async () => {
  installMockStorage();
  store.clear();
  const first = await saveFilterPreset('banks', 'One', filtersWith({ query: 'a' }));
  const second = await saveFilterPreset('banks', 'Two', filtersWith({ query: 'b' }));
  assert.ok(first.ok && second.ok);
  const deleted = await deleteFilterPreset('banks', first.preset.id);
  assert.equal(deleted.ok, true);
  const loaded = await loadFilterPresets();
  const presets = presetsForView(loaded, 'banks');
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, 'Two');
  const missing = await deleteFilterPreset('banks', 'does-not-exist');
  assert.equal(missing.ok, true, 'deleting an unknown id is a no-op success');
});

test('name normalization: trim + collapse whitespace; rejects empty and over-long names', async () => {
  installMockStorage();
  store.clear();
  assert.equal(normalizePresetName('  launch   week '), 'launch week');
  const empty = await saveFilterPreset('banks', '   ', filtersWith({ query: 'x' }));
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty-name');
  const tooLong = await saveFilterPreset('banks', 'x'.repeat(MAX_FILTER_PRESET_NAME_LENGTH + 1), filtersWith({ query: 'x' }));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, 'name-too-long');
  const boundary = await saveFilterPreset('banks', 'x'.repeat(MAX_FILTER_PRESET_NAME_LENGTH), filtersWith({ query: 'x' }));
  assert.equal(boundary.ok, true);
});

test('saving with nothing but the auto workspace scope is rejected', async () => {
  installMockStorage();
  store.clear();
  const workspaceOnly = await saveFilterPreset('queue', 'ws only', filtersWith({ workspaceId: 'ws-1' }));
  assert.equal(workspaceOnly.ok, false);
  assert.equal(workspaceOnly.reason, 'empty-filters');
  const pristine = await saveFilterPreset('queue', 'pristine', { ...emptySearchFilters });
  assert.equal(pristine.ok, false);
  assert.equal(pristine.reason, 'empty-filters');
});

test('hasFilterSelection ignores the auto workspace scope but honors real filters', () => {
  assert.equal(hasFilterSelection({ ...emptySearchFilters, workspaceId: 'ws-1' }), false);
  assert.equal(hasFilterSelection({ ...emptySearchFilters, query: 'x' }), true);
  assert.equal(hasFilterSelection({ ...emptySearchFilters, status: 'FAILED' }), true);
  assert.equal(hasFilterSelection({ ...emptySearchFilters, bankId: 'b1' }), true);
  assert.equal(hasFilterSelection({ ...emptySearchFilters, dateFrom: '2026-01-01' }), true);
});

test('per-view cap is enforced without touching other views', async () => {
  installMockStorage();
  store.clear();
  for (let i = 0; i < MAX_FILTER_PRESETS_PER_VIEW; i++) {
    const outcome = await saveFilterPreset('history', `preset ${i}`, filtersWith({ query: `q${i}` }));
    assert.equal(outcome.ok, true, `preset ${i} should save`);
  }
  const overflow = await saveFilterPreset('history', 'one too many', filtersWith({ query: 'q-max' }));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'view-full');
  const otherView = await saveFilterPreset('sessions', 'still allowed', filtersWith({ query: 'ok' }));
  assert.equal(otherView.ok, true, 'other views keep their own budget');
  const loaded = await loadFilterPresets();
  assert.equal(presetsForView(loaded, 'history').length, MAX_FILTER_PRESETS_PER_VIEW);
});

test('corrupt or foreign stored data is sanitized without throwing', () => {
  const sanitized = sanitizePresetStore({
    banks: [
      { id: 'p1', name: 'ok', view: 'banks', filters: filtersWith({ query: 'a' }), createdAt: 1 },
      { id: '', name: 'no id', view: 'banks', filters: filtersWith({ query: 'a' }), createdAt: 1 },
      { id: 'p3', name: 'bad filters', view: 'banks', filters: { query: 5 }, createdAt: 1 },
      { id: 'p4', name: 'bad view', view: 'settings', filters: filtersWith({ query: 'a' }), createdAt: 1 },
      'garbage',
      { id: 'p6', name: '   ', view: 'banks', filters: filtersWith({ query: 'c' }), createdAt: 1 },
    ],
    queue: 'not-an-array',
    sessions: null,
    history: 42,
  });
  assert.equal(sanitized.banks.length, 2, 'valid entries survive, junk is dropped');
  assert.equal(sanitized.banks[0].id, 'p1');
  assert.equal(sanitized.banks[1].id, 'p6');
  assert.equal(sanitized.queue, undefined);
  assert.equal(sanitized.sessions, undefined);
  assert.equal(sanitized.history, undefined);
  assert.deepEqual(sanitizePresetStore(null), {});
  assert.deepEqual(sanitizePresetStore('nope'), {});
});

test('duplicate ids in stored data are deduplicated', () => {
  const entry = { id: 'dup', name: 'same', view: 'queue', filters: filtersWith({ query: 'x' }), createdAt: 1 };
  const sanitized = sanitizePresetStore({ queue: [entry, { ...entry }] });
  assert.equal(sanitized.queue.length, 1);
});

test('storage failures surface as outcome failures instead of throwing', async () => {
  globalThis.chrome = { storage: { local: { get: async () => { throw new Error('storage unavailable'); }, set: async () => { throw new Error('storage unavailable'); } } } };
  assert.deepEqual(await loadFilterPresets(), {});
  const outcome = await saveFilterPreset('banks', 'nope', filtersWith({ query: 'x' }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'storage-failure');
  await assert.doesNotReject(() => deleteFilterPreset('banks', 'whatever'));
});

test('concurrent mutations across views never clobber each other', async () => {
  installMockStorage();
  store.clear();
  const views = ['queue', 'banks', 'sessions', 'history'];
  const results = await Promise.all(views.map((view) => saveFilterPreset(view, `${view} preset`, filtersWith({ query: view }))));
  assert.ok(results.every((outcome) => outcome.ok), 'every concurrent save succeeds');
  const loaded = await loadFilterPresets();
  for (const view of views) {
    const presets = presetsForView(loaded, view);
    assert.equal(presets.length, 1, `${view} keeps its own preset`);
    assert.equal(presets[0].name, `${view} preset`);
  }
  // Concurrent save + delete on the same view must also stay consistent.
  store.clear();
  const seed = await saveFilterPreset('banks', 'seed', filtersWith({ query: 'seed' }));
  assert.ok(seed.ok);
  const [saved, deleted] = await Promise.all([
    saveFilterPreset('banks', 'racer', filtersWith({ query: 'racer' })),
    deleteFilterPreset('banks', seed.preset.id),
  ]);
  assert.equal(saved.ok, true);
  assert.equal(deleted.ok, true);
  const final = presetsForView(await loadFilterPresets(), 'banks');
  assert.equal(final.length, 1);
  assert.equal(final[0].name, 'racer');
});

test('presets live under a dedicated key and never touch saved-filters state', async () => {
  installMockStorage();
  store.clear();
  store.set(SAVED_FILTERS_KEY, { sessions: filtersWith({ query: 'remembered' }) });
  await saveFilterPreset('sessions', 'preset', filtersWith({ query: 'preset' }));
  assert.ok(store.has(KEY), 'presets use their own key');
  const savedRaw = store.get(SAVED_FILTERS_KEY);
  assert.equal(savedRaw.sessions.query, 'remembered', 'saved-filters state is untouched');
});
