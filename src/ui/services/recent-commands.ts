import { MAX_RECENT_COMMANDS, sanitizeRecentCommandIds } from './command-palette.ts';

/**
 * Recent-commands persistence for the command palette. UI preference state
 * ONLY: a dedicated chrome.storage.local key holding at most
 * MAX_RECENT_COMMANDS command ids. Never touches the entity stores, the
 * saved-filters/presets keys, and never leaves the device. All mutations go
 * through a serialized queue so rapid command runs cannot clobber each other
 * (same race-proofing pattern as saved-filters and filter-presets).
 */
const RECENT_COMMANDS_KEY = 'xPilotRecentCommands';

export async function loadRecentCommands(): Promise<string[]> {
  try {
    const stored = await globalThis.chrome?.storage?.local?.get(RECENT_COMMANDS_KEY) as Record<string, unknown> | undefined;
    return sanitizeRecentCommandIds(stored?.[RECENT_COMMANDS_KEY]);
  } catch {
    return [];
  }
}

async function writeRecentCommands(ids: string[]): Promise<boolean> {
  try {
    await globalThis.chrome?.storage?.local?.set({ [RECENT_COMMANDS_KEY]: ids });
    return true;
  } catch {
    return false;
  }
}

let mutationQueue: Promise<unknown> = Promise.resolve();

function queueRecentMutation<T>(mutate: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(mutate, mutate);
  mutationQueue = run.catch(() => undefined);
  return run;
}

/**
 * Persists a new recent-commands list (already shaped by
 * recordRecentCommand). Storage failures surface as `false` so the UI can
 * keep the in-memory list without blocking the command that just ran.
 */
export async function saveRecentCommands(ids: string[]): Promise<boolean> {
  const capped = sanitizeRecentCommandIds(ids);
  return queueRecentMutation(() => writeRecentCommands(capped));
}
