/**
 * Saved search filters (UI preferences only).
 * The helper must keep its persistence isolated from all entity stores and
 * survive corrupt/foreign data without throwing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSavedFilters, saveSavedFilter } from '../src/ui/services/saved-filters.ts';
import { emptySearchFilters } from '../src/domain/search-filters.ts';

const KEY = 'xPilotSavedFilters';
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

test('saved filters round-trip per view without touching other views', async () => {
  installMockStorage();
  store.clear();
  await saveSavedFilter('sessions', { ...emptySearchFilters, query: 'launch', status: 'FAILED' });
  await saveSavedFilter('banks', { ...emptySearchFilters, query: 'x.com/search' });
  const saved = await loadSavedFilters();
  assert.equal(saved.sessions?.query, 'launch');
  assert.equal(saved.sessions?.status, 'FAILED');
  assert.equal(saved.banks?.query, 'x.com/search');
  assert.equal(saved.queue, undefined, 'views without saved filters stay undefined');
  assert.equal(saved.history, undefined);
});

test('clearing a view removes its persisted entry entirely', async () => {
  installMockStorage();
  store.clear();
  await saveSavedFilter('queue', { ...emptySearchFilters, query: 'temp' });
  await saveSavedFilter('queue', { ...emptySearchFilters });
  const saved = await loadSavedFilters();
  assert.equal(saved.queue, undefined, 'empty filters must not persist');
});

test('corrupt or foreign stored data is sanitized without throwing', async () => {
  installMockStorage();
  store.clear();
  store.set(KEY, { sessions: { query: 5 }, banks: 'nope', history: { query: 'ok', status: 'ALL', bankId: '', sessionId: '', workspaceId: '', dateFrom: '', dateTo: '' }, queue: null });
  const saved = await loadSavedFilters();
  assert.deepEqual(saved.sessions, undefined, 'wrong-shape entries are dropped');
  assert.equal(saved.history?.query, 'ok');
  assert.equal(saved.banks, undefined);
});

test('storage failures degrade to empty preferences instead of crashing', async () => {
  globalThis.chrome = { storage: { local: { get: async () => { throw new Error('storage unavailable'); }, set: async () => { throw new Error('storage unavailable'); } } } };
  assert.deepEqual(await loadSavedFilters(), {});
  await assert.doesNotReject(() => saveSavedFilter('sessions', { ...emptySearchFilters, query: 'x' }));
});

test('concurrent saves for all views never clobber each other', async () => {
  installMockStorage();
  store.clear();
  const { queueSavedFilterSave } = await import('../src/ui/services/saved-filters.ts');
  await Promise.all([
    queueSavedFilterSave('queue', { ...emptySearchFilters, query: 'q1' }),
    queueSavedFilterSave('banks', { ...emptySearchFilters, query: 'b1' }),
    queueSavedFilterSave('sessions', { ...emptySearchFilters, query: 's1' }),
    queueSavedFilterSave('history', { ...emptySearchFilters, query: 'h1' }),
  ]);
  const saved = await loadSavedFilters();
  assert.equal(saved.queue?.query, 'q1');
  assert.equal(saved.banks?.query, 'b1');
  assert.equal(saved.sessions?.query, 's1');
  assert.equal(saved.history?.query, 'h1');
});
