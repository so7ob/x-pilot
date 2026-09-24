/**
 * Recent-commands persistence (UI preferences only).
 * The service must keep its storage under a dedicated key isolated from all
 * entity stores and the saved-filters/presets keys, sanitize corrupt data,
 * cap the list, and stay race-free under concurrent saves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRecentCommands, saveRecentCommands } from '../src/ui/services/recent-commands.ts';
import { MAX_RECENT_COMMANDS, sanitizeRecentCommandIds } from '../src/ui/services/command-palette.ts';

const KEY = 'xPilotRecentCommands';
const FOREIGN_KEYS = ['xPilotSavedFilters', 'xPilotFilterPresets', 'xPilotWorkspaces'];
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

test('recent commands round-trip through a dedicated key', async () => {
  installMockStorage();
  store.clear();
  const ok = await saveRecentCommands(['action:refresh-data', 'tab:sessions']);
  assert.equal(ok, true);
  assert.ok(store.has(KEY), 'recents use their own key');
  const loaded = await loadRecentCommands();
  assert.deepEqual(loaded, ['action:refresh-data', 'tab:sessions']);
});

test('recents never touch saved-filters, presets, or workspace state', async () => {
  installMockStorage();
  store.clear();
  store.set('xPilotSavedFilters', { sessions: { query: 'keep' } });
  store.set('xPilotFilterPresets', { banks: [] });
  store.set('xPilotWorkspaces', { byId: {} });
  await saveRecentCommands(['tab:analytics']);
  assert.equal(store.get('xPilotSavedFilters').sessions.query, 'keep');
  assert.deepEqual(store.get('xPilotFilterPresets'), { banks: [] });
  assert.deepEqual(store.get('xPilotWorkspaces'), { byId: {} });
  for (const foreign of FOREIGN_KEYS) assert.notEqual(foreign, KEY);
});

test('corrupt stored data is sanitized without throwing', async () => {
  installMockStorage();
  store.clear();
  store.set(KEY, { junk: 1 });
  assert.deepEqual(await loadRecentCommands(), []);
  store.set(KEY, ['tab:queue', 42, '', 'tab:queue', 'tab:operation']);
  assert.deepEqual(await loadRecentCommands(), ['tab:queue', 'tab:operation']);
  store.set(KEY, 'garbage');
  assert.deepEqual(await loadRecentCommands(), []);
});

test('saves are capped at MAX_RECENT_COMMANDS', async () => {
  installMockStorage();
  store.clear();
  const ids = Array.from({ length: 20 }, (_, i) => `action:x${i}`);
  await saveRecentCommands(ids);
  const loaded = await loadRecentCommands();
  assert.equal(loaded.length, MAX_RECENT_COMMANDS);
});

test('storage failures surface as false instead of throwing', async () => {
  globalThis.chrome = { storage: { local: { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } } } };
  await assert.doesNotReject(() => loadRecentCommands());
  assert.deepEqual(await loadRecentCommands(), []);
  const ok = await saveRecentCommands(['tab:queue']);
  assert.equal(ok, false);
});

test('missing chrome APIs degrade to empty lists and silent no-op saves', async () => {
  globalThis.chrome = undefined;
  assert.deepEqual(await loadRecentCommands(), []);
  await assert.doesNotReject(() => saveRecentCommands(['tab:queue']), 'missing storage substrate is a silent no-op, matching the filter-presets pattern');
});

test('rapid concurrent saves never clobber each other', async () => {
  installMockStorage();
  store.clear();
  await Promise.all([
    saveRecentCommands(['action:a']),
    saveRecentCommands(['action:b', 'action:a']),
    saveRecentCommands(['action:c', 'action:b', 'action:a']),
  ]);
  const loaded = await loadRecentCommands();
  assert.deepEqual(loaded, ['action:c', 'action:b', 'action:a'], 'the last queued write wins atomically');
});

test('sanitizeRecentCommandIds matches the service sanitizer', () => {
  assert.deepEqual(sanitizeRecentCommandIds(['a', 'b']), ['a', 'b']);
});
