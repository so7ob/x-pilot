import type { AppMetaState, AppMetadata, AppState, AutomationSession, AutomationSessionRecord, AutomationSessionRuntime, BackupEnvelope, BackupSummary, BackupValidation, GlobalSettings, HistoricalSession, LegacyPublishAttempt, PublishAttempt, QueueItem, Settings, TweetBank, Workspace, WorkspaceSettings, WorkspaceState } from '../domain/models';
import { CURRENT_SCHEMA_VERSION, getMigrationPath, validateMigrationRegistry } from './migrations.ts';
import { timedStorageOperation } from './storage-performance.ts';
import { normalizeWorkspaceState } from '../domain/data-integrity.ts';
import { UI_PREFERENCE_KEYS, collectUiPreferences, sanitizeUiPreferencesBundle, uiPreferenceWrites } from '../ui/services/ui-preferences-transfer.ts';

const defaultSettings: Settings = { intervalMinutes: 2, maxRetries: 2, failureBehavior: 'CONTINUE', confirmBeforeStart: true, keepAutomationTabOpen: true, closeTabOnComplete: false, duplicatePolicy: 'BLOCK', publishingWindows: [], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', notificationsEnabled: true, badgeMode: 'COUNT' };

validateMigrationRegistry(CURRENT_SCHEMA_VERSION);

export const LEGACY_STATE_KEY = 'xQueueState';
export const LEGACY_SETTINGS_KEY = 'xQueueSettings';
export const META_KEY = 'xPilotMeta';
export const WORKSPACE_KEY_PREFIX = 'xPilotWorkspace:';
export const V4_META_KEY = 'xPilot:meta';
export const V4_GLOBAL_SETTINGS_KEY = 'xPilot:settings:global';
export const V4_RUNTIME_KEY = 'xPilot:runtime:automation';
export const V4_WORKSPACE_PREFIX = 'xPilot:workspace:';
export const V4_WORKSPACE_SETTINGS_PREFIX = 'xPilot:workspace-settings:';
export const V4_BANK_PREFIX = 'xPilot:bank:';
export const V4_QUEUE_PREFIX = 'xPilot:queue:';
export const V4_SESSIONS_PREFIX = 'xPilot:sessions:';
export const V4_ATTEMPTS_PREFIX = 'xPilot:attempts:';
export const V4_SNAPSHOT_PREFIX = 'xPilot:bank-snapshot:';
export const START_LOCK_KEY = 'xPilot:lock:start';
export const RESTORE_STAGING_PREFIX = 'xPilot:restore:staging:';

interface PersistedStartLock { token: string; workspaceId: string; acquiredAt: number; expiresAt: number; }
let startLockTail: Promise<void> = Promise.resolve();

const emptyState = (workspaceId?: string): AppState => ({ workspaceId, queue: [], session: null, history: [] });
const workspaceKey = (workspaceId: string) => `${WORKSPACE_KEY_PREFIX}${workspaceId}`;
const v4WorkspaceKey = (workspaceId: string) => `${V4_WORKSPACE_PREFIX}${workspaceId}`;
const v4WorkspaceSettingsKey = (workspaceId: string) => `${V4_WORKSPACE_SETTINGS_PREFIX}${workspaceId}`;
const v4BankKey = (workspaceId: string) => `${V4_BANK_PREFIX}${workspaceId}`;
const v4QueueKey = (workspaceId: string) => `${V4_QUEUE_PREFIX}${workspaceId}`;
const v4SessionsKey = (workspaceId: string) => `${V4_SESSIONS_PREFIX}${workspaceId}`;
const v4AttemptsKey = (workspaceId: string) => `${V4_ATTEMPTS_PREFIX}${workspaceId}`;

function runtimeFromSession(session: AutomationSession | null, workspaceId: string): AutomationSessionRuntime | null {
  if (!session) return null;
  return { workspaceId, sessionId: session.id, bankId: session.bankId, bankUrl: session.bankUrl, status: session.status, currentItemId: session.currentItemId, currentIndex: session.currentIndex, total: session.total, startedAt: session.startedAt, scheduledStartAt: session.scheduledStartAt, pausedAt: session.pausedAt, completedAt: session.completedAt, nextRunAt: session.nextRunAt, automationTabId: session.automationTabId, operationId: undefined, alarmFailureCount: session.alarmFailureCount, lastAlarmError: session.lastAlarmError, updatedAt: session.updatedAt, version: session.version };
}

function sessionFromRuntime(runtime: AutomationSessionRuntime | null, settings: Settings): AutomationSession | null {
  if (!runtime) return null;
  return { id: runtime.sessionId, workspaceId: runtime.workspaceId, bankId: runtime.bankId, bankUrl: runtime.bankUrl ?? '', status: runtime.status, currentItemId: runtime.currentItemId, currentIndex: runtime.currentIndex, total: runtime.total, startedAt: runtime.startedAt, scheduledStartAt: runtime.scheduledStartAt, pausedAt: runtime.pausedAt, completedAt: runtime.completedAt, nextRunAt: runtime.nextRunAt, automationTabId: runtime.automationTabId, alarmFailureCount: runtime.alarmFailureCount, lastAlarmError: runtime.lastAlarmError, intervalMinutes: settings.intervalMinutes, maxRetries: settings.maxRetries, failureBehavior: settings.failureBehavior, confirmBeforeStart: settings.confirmBeforeStart, keepAutomationTabOpen: settings.keepAutomationTabOpen, closeTabOnComplete: settings.closeTabOnComplete, version: runtime.version, updatedAt: runtime.updatedAt, historicalSessionId: runtime.sessionId };
}

/**
 * Attempt results that may be persisted verbatim. PAUSED is a legitimate
 * analytical outcome (e.g. daily-limit stop) — coercing it to FAILED erased
 * the distinction in the session log.
 */
const PERSISTABLE_ATTEMPT_RESULTS = ['PUBLISHED', 'PUBLISHED_UNVERIFIED', 'PENDING', 'FAILED', 'SKIPPED', 'PAUSED'];

function toV4Attempt(attempt: LegacyPublishAttempt, workspaceId: string): PublishAttempt {
  const result = PERSISTABLE_ATTEMPT_RESULTS.includes(attempt.result) ? attempt.result as PublishAttempt['result'] : 'FAILED';
  return { id: attempt.id, workspaceId, sessionId: attempt.sessionId ?? '', queueItemId: attempt.queueItemId, targetUrl: attempt.link, link: attempt.link, sourceUrl: attempt.sourceUrl, publishedPostUrl: attempt.publishedPostUrl, timestamp: attempt.timestamp, attemptNumber: attempt.attemptNumber, action: attempt.action, result, error: attempt.error, errorMessage: attempt.error, tweetLabel: attempt.tweetLabel, bankId: attempt.bankId, bankName: attempt.bankName, itemPosition: attempt.itemPosition, durationMs: attempt.durationMs, adapter: attempt.adapter };
}

/** Exposed for tests: v4 persistence shape of an analytical attempt. */
export { toV4Attempt };

/** Restores the analytical LegacyPublishAttempt shape from persisted v4 storage. */
export function fromV4Attempt(attempt: PublishAttempt, workspaceId: string): LegacyPublishAttempt {
  return { id: attempt.id, workspaceId, sessionId: attempt.sessionId, queueItemId: attempt.queueItemId, link: attempt.targetUrl ?? attempt.link ?? '', sourceUrl: attempt.sourceUrl ?? attempt.targetUrl ?? attempt.link, publishedPostUrl: attempt.publishedPostUrl, timestamp: attempt.timestamp, attemptNumber: attempt.attemptNumber, action: attempt.action, result: attempt.result, error: attempt.errorMessage ?? attempt.error, tweetLabel: attempt.tweetLabel, bankId: attempt.bankId, bankName: attempt.bankName, itemPosition: attempt.itemPosition, durationMs: attempt.durationMs, adapter: attempt.adapter };
}

async function migrateSchema3To4(existing: AppMetaState): Promise<AppMetaState> {
  const keys = existing.workspaceOrder.map(workspaceKey);
  const stored = await chrome.storage.local.get(keys);
  const now = Date.now();
  const appVersion = chrome.runtime?.getManifest?.().version ?? '0.18.0';
  let v4Meta: AppMetadata = { schemaVersion: 4, appVersion, activeWorkspaceId: existing.activeWorkspaceId, automationWorkspaceId: existing.automationWorkspaceId, workspaceOrder: existing.workspaceOrder, createdAt: existing.createdAt ?? now, updatedAt: now };
  const writes: Record<string, unknown> = { [V4_META_KEY]: v4Meta, [V4_GLOBAL_SETTINGS_KEY]: { ...existing.globalSettings, updatedAt: now } as GlobalSettings };
  let runtime: AutomationSessionRuntime | null = null;
  for (const workspaceId of existing.workspaceOrder) {
    const legacy = stored[workspaceKey(workspaceId)] as WorkspaceState | undefined;
    if (!legacy) continue;
    const settings = { ...existing.globalSettings, ...(legacy.workspace.automationProfile ?? {}), updatedAt: now } as GlobalSettings;
    const workspaceSettings: WorkspaceSettings = { workspaceId, overrides: legacy.workspace.automationProfile ?? {}, createdAt: legacy.workspace.createdAt, updatedAt: now };
    writes[v4WorkspaceKey(workspaceId)] = legacy.workspace;
    writes[v4WorkspaceSettingsKey(workspaceId)] = workspaceSettings;
    writes[v4BankKey(workspaceId)] = legacy.banks ?? [];
    writes[v4QueueKey(workspaceId)] = legacy.queue ?? [];
    writes[v4SessionsKey(workspaceId)] = (legacy.historicalSessions ?? []).map((session) => ({ ...session, timezone: settings.timezone }));
    writes[v4AttemptsKey(workspaceId)] = (legacy.history ?? []).map((attempt) => toV4Attempt(attempt, workspaceId));
    if (legacy.session && legacy.session.status !== 'IDLE' && (!runtime || existing.automationWorkspaceId === workspaceId)) { runtime = runtimeFromSession(legacy.session, workspaceId); v4Meta = { ...v4Meta, automationWorkspaceId: workspaceId }; }
  }
  writes[V4_META_KEY] = v4Meta;
  if (runtime) writes[V4_RUNTIME_KEY] = runtime;
  await chrome.storage.local.set(writes);
  return { ...v4Meta, globalSettings: existing.globalSettings };
}

function createWorkspaceRecord(name: string, description = '', color?: string, icon?: string): Workspace {
  const now = Date.now();
  return { id: crypto.randomUUID(), name, description, color, icon, favorite: false, archived: false, createdAt: now, updatedAt: now, lastActivityAt: now };
}

function createWorkspaceState(workspace: Workspace, settings: Settings, seed: Partial<AppState> & { historicalSessions?: HistoricalSession[] } = {}, banks: TweetBank[] = []): WorkspaceState {
  const queue = (seed.queue ?? []).map((item) => ({ ...item, workspaceId: workspace.id }));
  const session = seed.session ? { ...seed.session, workspaceId: workspace.id } : null;
  const history = (seed.history ?? []).map((attempt) => ({ ...attempt, workspaceId: workspace.id }));
  return { workspaceId: workspace.id, workspace, banks, queue, session: session ? { ...session, ...settings } : null, history, historicalSessions: seed.historicalSessions ?? [] };
}

async function readMeta(): Promise<AppMetaState | undefined> {
  const result = await timedStorageOperation('get', 3, () => chrome.storage.local.get([META_KEY, V4_META_KEY, V4_GLOBAL_SETTINGS_KEY]));
  if (result[V4_META_KEY]) return { ...(result[V4_META_KEY] as AppMetadata), globalSettings: result[V4_GLOBAL_SETTINGS_KEY] as Settings } as AppMetaState;
  return result[META_KEY] as AppMetaState | undefined;
}

export async function cleanupRestoreStaging(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const stagingKeys = Object.keys(all).filter((key) => key.startsWith(RESTORE_STAGING_PREFIX));
  if (stagingKeys.length) await chrome.storage.local.remove(stagingKeys);
}

async function migrateIfNeeded(): Promise<AppMetaState> {
  const existing = await readMeta();
  if (existing?.schemaVersion === 4) return existing;
  if (existing?.schemaVersion === 3) {
    getMigrationPath(3, CURRENT_SCHEMA_VERSION);
    return migrateSchema3To4(existing);
  }

  if (existing?.schemaVersion === 2) {
    getMigrationPath(2, CURRENT_SCHEMA_VERSION);
    const keys = existing.workspaceOrder.map(workspaceKey);
    const stored = await chrome.storage.local.get(keys);
    const upgraded = { ...existing, schemaVersion: 3 as const };
    const updates: Record<string, WorkspaceState> = {};
    for (const id of existing.workspaceOrder) {
      const state = stored[workspaceKey(id)] as WorkspaceState | undefined;
      if (state) updates[workspaceKey(id)] = { ...state, banks: state.banks.map((bank) => ({ ...bank, favorite: bank.favorite ?? false, archived: bank.archived ?? false })), historicalSessions: state.historicalSessions ?? [] };
    }
    await chrome.storage.local.set({ ...updates, [META_KEY]: upgraded });
    return migrateSchema3To4(upgraded);
  }

  getMigrationPath(1, CURRENT_SCHEMA_VERSION);
  const legacy = await chrome.storage.local.get([LEGACY_STATE_KEY, LEGACY_SETTINGS_KEY]);
  const legacyState = legacy[LEGACY_STATE_KEY] as Partial<AppState> | undefined;
  const settings: Settings = { ...defaultSettings, ...(legacy[LEGACY_SETTINGS_KEY] as Partial<Settings> | undefined) };
  const workspace = createWorkspaceRecord('مساحة العمل الافتراضية', 'تم ترحيلها تلقائيًا من بيانات X-Pilot السابقة');
  const banks: TweetBank[] = [];
  if (legacyState?.session?.bankUrl) {
    const now = Date.now();
    banks.push({ id: crypto.randomUUID(), workspaceId: workspace.id, name: 'البنك المرحّل', url: legacyState.session.bankUrl, favorite: true, archived: false, createdAt: now, updatedAt: now });
  }
  const migrated = createWorkspaceState(workspace, settings, legacyState ?? {}, banks);
  const meta: AppMetaState = { schemaVersion: 3, activeWorkspaceId: workspace.id, workspaceOrder: [workspace.id], globalSettings: settings };
  await chrome.storage.local.set({ [workspaceKey(workspace.id)]: migrated, [META_KEY]: meta });
  return migrateSchema3To4(meta);
}

export async function getMeta(): Promise<AppMetaState> { return migrateIfNeeded(); }
export async function saveMeta(meta: AppMetaState): Promise<void> {
  if (meta.schemaVersion === 4) {
    const now = Date.now();
    const metadata: AppMetadata = { schemaVersion: 4, appVersion: meta.appVersion ?? chrome.runtime?.getManifest?.().version ?? '0.18.0', activeWorkspaceId: meta.activeWorkspaceId, automationWorkspaceId: meta.automationWorkspaceId, workspaceOrder: meta.workspaceOrder, createdAt: meta.createdAt ?? now, updatedAt: now };
    await chrome.storage.local.set({ [V4_META_KEY]: metadata, [V4_GLOBAL_SETTINGS_KEY]: { ...meta.globalSettings, updatedAt: now } });
    return;
  }
  await chrome.storage.local.set({ [META_KEY]: meta });
}

export async function getWorkspaceState(workspaceId: string): Promise<WorkspaceState> {
  const meta = await migrateIfNeeded();
  if (meta.schemaVersion === 4) {
    const result = await timedStorageOperation('get', 7, () => chrome.storage.local.get([v4WorkspaceKey(workspaceId), v4WorkspaceSettingsKey(workspaceId), v4BankKey(workspaceId), v4QueueKey(workspaceId), v4SessionsKey(workspaceId), v4AttemptsKey(workspaceId), V4_RUNTIME_KEY]));
    const workspace = result[v4WorkspaceKey(workspaceId)] as Workspace | undefined;
    if (workspace) {
      const local = result[v4WorkspaceSettingsKey(workspaceId)] as WorkspaceSettings | undefined;
      const effective = { ...meta.globalSettings, ...(local?.overrides ?? {}) };
      const runtime = result[V4_RUNTIME_KEY] as AutomationSessionRuntime | undefined;
      const attempts = (result[v4AttemptsKey(workspaceId)] as PublishAttempt[] | undefined) ?? [];
      return normalizeWorkspaceState({ workspace, banks: ((result[v4BankKey(workspaceId)] as TweetBank[] | undefined) ?? []).map((bank) => ({ ...bank, favorite: bank.favorite ?? false, archived: bank.archived ?? false })), queue: ((result[v4QueueKey(workspaceId)] as QueueItem[] | undefined) ?? []).map((item) => ({ ...item, workspaceId })), session: runtime?.workspaceId === workspaceId ? sessionFromRuntime(runtime, effective) : null, history: attempts.map((attempt) => fromV4Attempt(attempt, workspaceId)), historicalSessions: ((result[v4SessionsKey(workspaceId)] as AutomationSessionRecord[] | undefined) ?? []) }, workspaceId, workspace);
    }
  }
  const result = await chrome.storage.local.get(workspaceKey(workspaceId));
  const stored = result[workspaceKey(workspaceId)] as WorkspaceState | undefined;
  if (stored) {
    return normalizeWorkspaceState(stored, workspaceId, stored.workspace);
  }
  const workspace = createWorkspaceRecord('مساحة عمل جديدة');
  const fallback = createWorkspaceState({ ...workspace, id: workspaceId }, meta.globalSettings);
  await chrome.storage.local.set({ [workspaceKey(workspaceId)]: fallback });
  return fallback;
}

export async function getState(workspaceId?: string): Promise<AppState> {
  const meta = await migrateIfNeeded();
  const state = await getWorkspaceState(workspaceId ?? meta.activeWorkspaceId);
  return { workspaceId: state.workspaceId, queue: state.queue, session: state.session, history: state.history };
}

export async function saveWorkspaceState(state: WorkspaceState): Promise<void> {
  const meta = await migrateIfNeeded();
  if (meta.schemaVersion !== 4) { await chrome.storage.local.set({ [workspaceKey(state.workspaceId)]: state }); return; }
  const current = await chrome.storage.local.get(v4WorkspaceSettingsKey(state.workspaceId));
  const runtime = runtimeFromSession(state.session, state.workspaceId);
  const currentRuntime = await chrome.storage.local.get(V4_RUNTIME_KEY);
  const writes: Record<string, unknown> = { [v4WorkspaceKey(state.workspaceId)]: state.workspace, [v4BankKey(state.workspaceId)]: state.banks, [v4QueueKey(state.workspaceId)]: state.queue, [v4SessionsKey(state.workspaceId)]: state.historicalSessions ?? [], [v4AttemptsKey(state.workspaceId)]: state.history.map((attempt) => toV4Attempt(attempt, state.workspaceId)) };
  if (!current[v4WorkspaceSettingsKey(state.workspaceId)]) writes[v4WorkspaceSettingsKey(state.workspaceId)] = { workspaceId: state.workspaceId, overrides: {}, createdAt: state.workspace.createdAt, updatedAt: Date.now() } satisfies WorkspaceSettings;
  if (runtime && runtime.status !== 'IDLE') writes[V4_RUNTIME_KEY] = runtime;
  else if ((currentRuntime[V4_RUNTIME_KEY] as AutomationSessionRuntime | undefined)?.workspaceId === state.workspaceId) await chrome.storage.local.remove(V4_RUNTIME_KEY);
  await timedStorageOperation('set', Object.keys(writes).length, () => chrome.storage.local.set(writes));
}

export async function updateWorkspaceState(workspaceId: string, mutator: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState> {
  const next = mutator(await getWorkspaceState(workspaceId));
  await saveWorkspaceState(next);
  const meta = await getMeta();
  const updatedWorkspace = { ...next.workspace, lastActivityAt: Date.now(), updatedAt: Date.now() };
  await saveWorkspaceState({ ...next, workspace: updatedWorkspace });
  return { ...next, workspace: updatedWorkspace };
}

export async function updateState(mutator: (state: AppState) => AppState): Promise<AppState> {
  const meta = await getMeta();
  const current = await getWorkspaceState(meta.activeWorkspaceId);
  const next = mutator({ workspaceId: current.workspaceId, queue: current.queue, session: current.session, history: current.history });
  const saved = await updateWorkspaceState(meta.activeWorkspaceId, (state) => ({ ...state, ...next, workspaceId: state.workspaceId }));
  return { workspaceId: saved.workspaceId, queue: saved.queue, session: saved.session, history: saved.history };
}

export async function listWorkspaces(includeArchived = true): Promise<Workspace[]> {
  const meta = await getMeta();
  const states = await Promise.all(meta.workspaceOrder.map((id) => getWorkspaceState(id)));
  return states.map((state) => state.workspace).filter((workspace) => includeArchived || !workspace.archived).sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastActivityAt - a.lastActivityAt);
}

export async function createWorkspace(name: string, description = '', color?: string, icon?: string): Promise<WorkspaceState> {
  const meta = await getMeta();
  const workspace = createWorkspaceRecord(name, description, color, icon);
  const state = createWorkspaceState(workspace, meta.globalSettings);
  await saveWorkspaceState(state);
  await saveMeta({ ...meta, workspaceOrder: [...meta.workspaceOrder, workspace.id] });
  return state;
}

export async function updateWorkspace(workspaceId: string, patch: Partial<Pick<Workspace, 'name' | 'description' | 'color' | 'icon' | 'favorite'>>): Promise<Workspace> {
  const state = await getWorkspaceState(workspaceId);
  const workspace = { ...state.workspace, ...patch, updatedAt: Date.now(), lastActivityAt: Date.now() };
  await saveWorkspaceState({ ...state, workspace });
  return workspace;
}

export async function setActiveWorkspace(workspaceId: string): Promise<AppMetaState> {
  const meta = await getMeta();
  const state = await getWorkspaceState(workspaceId);
  if (state.workspace.archived) throw new Error('WORKSPACE_ARCHIVED');
  const next = { ...meta, activeWorkspaceId: workspaceId };
  await saveMeta(next);
  return next;
}

export async function listBanks(workspaceId: string, includeArchived = true): Promise<TweetBank[]> {
  const state = await getWorkspaceState(workspaceId);
  return state.banks.filter((bank) => includeArchived || !bank.archived).sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt);
}
export async function createBank(workspaceId: string, name: string, url: string, description = ''): Promise<TweetBank> {
  const now = Date.now();
  const bank: TweetBank = { id: crypto.randomUUID(), workspaceId, name: name.trim(), description: description.trim() || undefined, url: url.trim(), favorite: false, archived: false, createdAt: now, updatedAt: now };
  await updateWorkspaceState(workspaceId, (state) => ({ ...state, banks: [...state.banks, bank] }));
  return bank;
}
export async function importBanks(workspaceId: string, banks: TweetBank[]): Promise<TweetBank[]> {
  if (!banks.length) throw new Error('BANK_IMPORT_EMPTY');
  const prepared = banks.map((bank) => ({ ...bank, id: bank.id || crypto.randomUUID(), workspaceId, updatedAt: Date.now() }));
  await updateWorkspaceState(workspaceId, (state) => ({ ...state, banks: [...state.banks, ...prepared] }));
  return prepared;
}
export async function updateBank(workspaceId: string, bankId: string, patch: Partial<Pick<TweetBank, 'name' | 'description' | 'url' | 'favorite'>>): Promise<TweetBank> {
  const state = await getWorkspaceState(workspaceId);
  const existing = state.banks.find((bank) => bank.id === bankId);
  if (!existing) throw new Error('BANK_NOT_FOUND');
  const bank = { ...existing, ...patch, updatedAt: Date.now() };
  await updateWorkspaceState(workspaceId, (current) => ({ ...current, banks: current.banks.map((item) => item.id === bankId ? bank : item) }));
  return bank;
}
export async function archiveBank(workspaceId: string, bankId: string): Promise<void> {
  await updateWorkspaceState(workspaceId, (state) => ({ ...state, banks: state.banks.map((bank) => bank.id === bankId ? { ...bank, archived: true, favorite: false, updatedAt: Date.now() } : bank) }));
}
export async function restoreBank(workspaceId: string, bankId: string): Promise<void> {
  await updateWorkspaceState(workspaceId, (state) => ({ ...state, banks: state.banks.map((bank) => bank.id === bankId ? { ...bank, archived: false, updatedAt: Date.now() } : bank) }));
}
export async function deleteBank(workspaceId: string, bankId: string, confirmed: boolean): Promise<void> {
  if (!confirmed) throw new Error('BANK_DELETE_CONFIRMATION_REQUIRED');
  const state = await getWorkspaceState(workspaceId);
  if (state.session && ['RUNNING', 'WAITING', 'PAUSED'].includes(state.session.status) && (state.session.bankId === bankId || state.queue.some((item) => item.sourceBankId === bankId))) throw new Error('CANNOT_DELETE_RUNNING_BANK');
  if (!state.banks.some((bank) => bank.id === bankId)) throw new Error('BANK_NOT_FOUND');
  const referencedByQueue = state.queue.some((item) => item.sourceBankId === bankId);
  const referencedBySessionHistory = state.historicalSessions.some((session) => session.bankId === bankId);
  if (referencedByQueue || referencedBySessionHistory) {
    await archiveBank(workspaceId, bankId);
    return;
  }
  await updateWorkspaceState(workspaceId, (current) => ({ ...current, banks: current.banks.filter((bank) => bank.id !== bankId) }));
}

export async function archiveWorkspace(workspaceId: string): Promise<AppMetaState> {
  const meta = await getMeta();
  if (meta.workspaceOrder.length <= 1) throw new Error('CANNOT_ARCHIVE_LAST_WORKSPACE');
  const state = await getWorkspaceState(workspaceId);
  await saveWorkspaceState({ ...state, workspace: { ...state.workspace, archived: true, updatedAt: Date.now() } });
  if (meta.activeWorkspaceId === workspaceId) {
    const replacement = (await listWorkspaces(false)).find((workspace) => workspace.id !== workspaceId);
    if (replacement) return setActiveWorkspace(replacement.id);
  }
  return getMeta();
}

export async function restoreWorkspace(workspaceId: string): Promise<Workspace> {
  const state = await getWorkspaceState(workspaceId);
  const workspace = { ...state.workspace, archived: false, updatedAt: Date.now() };
  await saveWorkspaceState({ ...state, workspace });
  return workspace;
}

export async function deleteWorkspace(workspaceId: string, confirmed: boolean): Promise<AppMetaState> {
  if (!confirmed) throw new Error('WORKSPACE_DELETE_CONFIRMATION_REQUIRED');
  const meta = await getMeta();
  if (meta.workspaceOrder.length <= 1) throw new Error('CANNOT_DELETE_LAST_WORKSPACE');
  if (meta.automationWorkspaceId === workspaceId) throw new Error('CANNOT_DELETE_RUNNING_WORKSPACE');
  const state = await getWorkspaceState(workspaceId);
  // Deletion is a tombstone operation: Queue, Attempts, and Session Records remain recoverable.
  await saveWorkspaceState({ ...state, workspace: { ...state.workspace, archived: true, updatedAt: Date.now(), lastActivityAt: Date.now() } });
  const replacement = (await listWorkspaces(false)).find((workspace) => workspace.id !== workspaceId);
  const next = { ...meta, activeWorkspaceId: meta.activeWorkspaceId === workspaceId && replacement ? replacement.id : meta.activeWorkspaceId };
  await saveMeta(next);
  return next;
}

export async function getAutomationOwner(): Promise<string | undefined> { return (await getMeta()).automationWorkspaceId; }
export async function claimAutomationOwner(workspaceId: string): Promise<void> {
  const meta = await getMeta();
  if (meta.automationWorkspaceId && meta.automationWorkspaceId !== workspaceId) throw new Error('AUTOMATION_OWNED_BY_OTHER_WORKSPACE');
  await saveMeta({ ...meta, automationWorkspaceId: workspaceId });
}
export async function releaseAutomationOwner(workspaceId: string): Promise<void> {
  const meta = await getMeta();
  if (meta.automationWorkspaceId === workspaceId) await saveMeta({ ...meta, automationWorkspaceId: undefined });
}

export async function acquireStartLock(workspaceId: string, now = Date.now(), ttlMs = 15_000): Promise<string> {
  const previous = startLockTail;
  let releaseTail!: () => void;
  startLockTail = new Promise<void>((resolve) => { releaseTail = resolve; });
  await previous;
  try {
    const stored = await chrome.storage.local.get(START_LOCK_KEY);
    const existing = stored[START_LOCK_KEY] as PersistedStartLock | undefined;
    if (existing && existing.expiresAt > now) throw new Error('START_ALREADY_IN_FLIGHT');
    const token = crypto.randomUUID();
    const lock: PersistedStartLock = { token, workspaceId, acquiredAt: now, expiresAt: now + ttlMs };
    await chrome.storage.local.set({ [START_LOCK_KEY]: lock });
    const verified = await chrome.storage.local.get(START_LOCK_KEY);
    if ((verified[START_LOCK_KEY] as PersistedStartLock | undefined)?.token !== token) throw new Error('START_LOCK_LOST');
    return token;
  } finally {
    releaseTail();
  }
}

export async function releaseStartLock(token: string): Promise<void> {
  const stored = await chrome.storage.local.get(START_LOCK_KEY);
  if ((stored[START_LOCK_KEY] as PersistedStartLock | undefined)?.token === token) await chrome.storage.local.remove(START_LOCK_KEY);
}

export async function renewStartLock(token: string, now = Date.now(), ttlMs = 15_000): Promise<boolean> {
  const stored = await chrome.storage.local.get(START_LOCK_KEY);
  const existing = stored[START_LOCK_KEY] as PersistedStartLock | undefined;
  if (!existing || existing.token !== token) return false;
  const renewed: PersistedStartLock = { ...existing, expiresAt: now + ttlMs };
  await chrome.storage.local.set({ [START_LOCK_KEY]: renewed });
  const verified = await chrome.storage.local.get(START_LOCK_KEY);
  return (verified[START_LOCK_KEY] as PersistedStartLock | undefined)?.token === token;
}

export async function addAttempt(attempt: PublishAttempt | LegacyPublishAttempt): Promise<void> {
  const meta = await getMeta();
  const workspaceId = attempt.workspaceId ?? meta.automationWorkspaceId ?? meta.activeWorkspaceId;
  const sourceUrl = ('sourceUrl' in attempt ? attempt.sourceUrl : undefined) ?? ('targetUrl' in attempt ? attempt.targetUrl : attempt.link) ?? '';
  const legacy: LegacyPublishAttempt = { id: attempt.id, workspaceId, sessionId: attempt.sessionId, queueItemId: attempt.queueItemId, link: sourceUrl, sourceUrl, publishedPostUrl: 'publishedPostUrl' in attempt ? attempt.publishedPostUrl : undefined, timestamp: attempt.timestamp, attemptNumber: attempt.attemptNumber, action: attempt.action, result: attempt.result, error: 'errorMessage' in attempt ? attempt.errorMessage ?? attempt.error : attempt.error, tweetLabel: 'tweetLabel' in attempt ? attempt.tweetLabel : undefined, bankId: 'bankId' in attempt ? attempt.bankId : undefined, bankName: 'bankName' in attempt ? attempt.bankName : undefined, itemPosition: 'itemPosition' in attempt ? attempt.itemPosition : undefined, durationMs: 'durationMs' in attempt ? attempt.durationMs : undefined, adapter: 'adapter' in attempt ? attempt.adapter : undefined };
  await updateWorkspaceState(workspaceId, (state) => ({ ...state, history: [...state.history, legacy].slice(-2000) }));
}
export async function getHistoricalSessions(workspaceId: string): Promise<HistoricalSession[]> {
  return (await getWorkspaceState(workspaceId)).historicalSessions ?? [];
}
export async function saveHistoricalSession(workspaceId: string, session: HistoricalSession): Promise<void> {
  await updateWorkspaceState(workspaceId, (state) => ({ ...state, historicalSessions: [...(state.historicalSessions ?? []).filter((item) => item.id !== session.id), session].sort((a, b) => b.startedAt - a.startedAt).slice(0, 500) }));
}
export async function updateHistoricalSession(workspaceId: string, sessionId: string, patch: Partial<HistoricalSession>): Promise<void> {
  await updateWorkspaceState(workspaceId, (state) => ({ ...state, historicalSessions: (state.historicalSessions ?? []).map((session) => session.id === sessionId ? { ...session, ...patch, updatedAt: Date.now() } : session) }));
}
export async function getSettings(): Promise<Settings> { return { ...defaultSettings, ...(await getMeta()).globalSettings }; }
export async function saveSettings(settings: Settings): Promise<void> { const meta = await getMeta(); await saveMeta({ ...meta, globalSettings: settings }); }
export async function getWorkspaceSettings(workspaceId: string): Promise<Settings> {
  const global = await getSettings();
  const meta = await getMeta();
  if (meta.schemaVersion === 4) {
    const result = await chrome.storage.local.get(v4WorkspaceSettingsKey(workspaceId));
    const settings = result[v4WorkspaceSettingsKey(workspaceId)] as WorkspaceSettings | undefined;
    return { ...global, ...(settings?.overrides ?? {}) };
  }
  const workspace = (await getWorkspaceState(workspaceId)).workspace;
  return { ...global, ...(workspace.automationProfile ?? {}), publishingWindows: workspace.automationProfile?.publishingWindows ?? global.publishingWindows, timezone: workspace.automationProfile?.timezone ?? global.timezone };
}
export async function updateWorkspaceProfile(workspaceId: string, profile: Partial<Settings>): Promise<Workspace> {
  const state = await getWorkspaceState(workspaceId);
  const meta = await getMeta();
  if (meta.schemaVersion === 4) {
    const key = v4WorkspaceSettingsKey(workspaceId);
    const stored = await chrome.storage.local.get(key);
    const current = stored[key] as WorkspaceSettings | undefined;
    await chrome.storage.local.set({ [key]: { workspaceId, overrides: { ...(current?.overrides ?? {}), ...profile }, createdAt: current?.createdAt ?? state.workspace.createdAt, updatedAt: Date.now() } satisfies WorkspaceSettings });
    return state.workspace;
  }
  const automationProfile = { ...(state.workspace.automationProfile ?? {}), ...profile };
  const workspace = { ...state.workspace, automationProfile, updatedAt: Date.now(), lastActivityAt: Date.now() };
  await saveWorkspaceState({ ...state, workspace });
  return workspace;
}
export async function clearWorkspaceProfile(workspaceId: string): Promise<Workspace> {
  const state = await getWorkspaceState(workspaceId);
  const meta = await getMeta();
  if (meta.schemaVersion === 4) {
    await chrome.storage.local.set({ [v4WorkspaceSettingsKey(workspaceId)]: { workspaceId, overrides: {}, createdAt: state.workspace.createdAt, updatedAt: Date.now() } satisfies WorkspaceSettings });
    return state.workspace;
  }
  const { automationProfile: _removed, ...workspaceWithoutProfile } = state.workspace;
  await saveWorkspaceState({ ...state, workspace: { ...workspaceWithoutProfile, updatedAt: Date.now(), lastActivityAt: Date.now() } });
  return { ...workspaceWithoutProfile, updatedAt: Date.now(), lastActivityAt: Date.now() };
}
export async function saveSession(session: AutomationSession | null): Promise<void> { await updateState((state) => ({ ...state, session })); }
export async function saveQueue(queue: QueueItem[]): Promise<void> { await updateState((state) => ({ ...state, queue })); }

function backupSummary(backup: BackupEnvelope): BackupSummary {
  return {
    workspaceCount: backup.workspaces.length,
    bankCount: backup.workspaces.reduce((count, state) => count + state.banks.length, 0),
    queueCount: backup.workspaces.reduce((count, state) => count + state.queue.length, 0),
    historyCount: backup.workspaces.reduce((count, state) => count + state.history.length, 0),
    historicalSessionCount: backup.workspaces.reduce((count, state) => count + (state.historicalSessions?.length ?? 0), 0),
    createdAt: backup.createdAt,
    hasUiPreferences: sanitizeUiPreferencesBundle(backup.uiPreferences) !== null,
  };
}

export async function exportBackup(includeUiPreferences = false): Promise<BackupEnvelope> {
  const meta = await getMeta();
  const workspaces = await Promise.all(meta.workspaceOrder.map((id) => getWorkspaceState(id)));
  // UI preferences are included ONLY on explicit user consent; without it the
  // envelope stays formatVersion 2 and carries no uiPreferences field at all.
  const uiPreferences = includeUiPreferences ? await collectUiPreferences(chrome.storage.local) : null;
  const workspaceSettings = await Promise.all(meta.workspaceOrder.map(async (id) => {
    const result = await chrome.storage.local.get(v4WorkspaceSettingsKey(id));
    return (result[v4WorkspaceSettingsKey(id)] as WorkspaceSettings | undefined) ?? { workspaceId: id, overrides: {}, createdAt: Date.now(), updatedAt: Date.now() };
  }));
  const attempts = workspaces.flatMap((state) => state.history.map((attempt) => toV4Attempt(attempt, state.workspaceId)));
  const sessionRecords = workspaces.flatMap((state) => (state.historicalSessions ?? []).map((session) => ({ ...session, timezone: (meta.globalSettings.timezone ?? 'UTC') })));
  return {
    format: 'x-pilot-backup', formatVersion: uiPreferences ? 3 : 2, appVersion: chrome.runtime?.getManifest?.().version ?? '0.18.0', createdAt: Date.now(),
    meta: { ...meta, schemaVersion: 4, automationWorkspaceId: undefined }, globalSettings: meta.globalSettings, workspaceSettings, sessionRecords, attempts,
    ...(uiPreferences ? { uiPreferences } : {}),
    workspaces: workspaces.map((state) => ({
      ...state,
      session: null,
      history: [],
    })),
  };
}

export function validateBackup(input: unknown): BackupValidation {
  const errors: string[] = [];
  const backup = input as Partial<BackupEnvelope> | null;
  if (!backup || backup.format !== 'x-pilot-backup') errors.push('INVALID_BACKUP_FORMAT');
  if (backup?.formatVersion !== 1 && backup?.formatVersion !== 2 && backup?.formatVersion !== 3) errors.push('UNSUPPORTED_BACKUP_VERSION');
  if (backup?.uiPreferences != null && backup.formatVersion !== 3) errors.push('INVALID_UI_PREFERENCES');
  if (backup?.uiPreferences != null && backup.formatVersion === 3 && !sanitizeUiPreferencesBundle(backup.uiPreferences)) errors.push('INVALID_UI_PREFERENCES');
  if (!backup?.meta || ![3, 4].includes(backup.meta.schemaVersion) || !Array.isArray(backup.meta.workspaceOrder)) errors.push('INVALID_BACKUP_META');
  if (!Array.isArray(backup?.workspaces) || backup.workspaces.length === 0) errors.push('BACKUP_HAS_NO_WORKSPACES');
  const workspaces = Array.isArray(backup?.workspaces) ? backup.workspaces as WorkspaceState[] : [];
  const ids = new Set(workspaces.map((state) => state?.workspaceId));
  if (ids.size !== workspaces.length || workspaces.some((state) => !state?.workspace?.id || state.workspace.id !== state.workspaceId)) errors.push('INVALID_WORKSPACE_RECORD');
  if (workspaces.some((state) => state.workspace?.archived === undefined || !state.workspace?.name)) errors.push('MISSING_WORKSPACE_FIELDS');
  if (backup?.meta && (!ids.has(backup.meta.activeWorkspaceId) || backup.meta.workspaceOrder.some((id) => !ids.has(id)))) errors.push('WORKSPACE_ORDER_MISMATCH');
  for (const state of workspaces) {
    const bankIds = new Set((state.banks ?? []).map((bank) => bank.id));
    const queueIds = new Set((state.queue ?? []).map((item) => item.id));
    if (bankIds.size !== (state.banks ?? []).length) errors.push(`DUPLICATE_BANK_ID:${state.workspaceId}`);
    if (queueIds.size !== (state.queue ?? []).length) errors.push(`DUPLICATE_QUEUE_ID:${state.workspaceId}`);
    if ((state.banks ?? []).some((bank) => bank.workspaceId !== state.workspaceId)) errors.push(`BANK_WORKSPACE_MISMATCH:${state.workspaceId}`);
    if ((state.queue ?? []).some((item) => item.workspaceId !== state.workspaceId || (item.sourceBankId && !bankIds.has(item.sourceBankId)))) errors.push(`QUEUE_REFERENCE_MISMATCH:${state.workspaceId}`);
    if (state.session && state.session.workspaceId !== state.workspaceId) errors.push(`SESSION_WORKSPACE_MISMATCH:${state.workspaceId}`);
  }
  if (errors.length) return { valid: false, errors: [...new Set(errors)] };
  return { valid: true, summary: backupSummary(backup as BackupEnvelope), errors: [] };
}

export async function restoreBackup(input: unknown, confirmed: boolean): Promise<BackupSummary> {
  if (!confirmed) throw new Error('BACKUP_RESTORE_CONFIRMATION_REQUIRED');
  const validation = validateBackup(input);
  if (!validation.valid || !validation.summary) throw new Error(`INVALID_BACKUP:${validation.errors.join(',')}`);
  const backup = input as BackupEnvelope;
  const currentMeta = await getMeta();
  // UI preferences ride the SAME Stage → Verify → Commit → Rollback path as
  // every other key. When the envelope carries no (valid) preferences the
  // local preference keys are never read, written, or removed.
  const trustedPreferences = sanitizeUiPreferencesBundle(backup.uiPreferences);
  const preferenceKeys: readonly string[] = trustedPreferences ? UI_PREFERENCE_KEYS : [];
  const transactionId = crypto.randomUUID();
  const stagingPrefix = `${RESTORE_STAGING_PREFIX}${transactionId}:`;
  const cleanup = async () => {
    const all = await chrome.storage.local.get(null);
    const stagingKeys = Object.keys(all).filter((key) => key.startsWith(RESTORE_STAGING_PREFIX));
    if (stagingKeys.length) await chrome.storage.local.remove(stagingKeys);
  };
  if (backup.formatVersion === 2 || backup.meta.schemaVersion === 4) {
    const settingsByWorkspace = new Map((backup.workspaceSettings ?? []).map((settings) => [settings.workspaceId, settings]));
    const attemptsByWorkspace = new Map<string, PublishAttempt[]>();
    for (const attempt of backup.attempts ?? []) attemptsByWorkspace.set(attempt.workspaceId ?? '', [...(attemptsByWorkspace.get(attempt.workspaceId ?? '') ?? []), attempt]);
    const sessionsByWorkspace = new Map<string, AutomationSessionRecord[]>();
    for (const session of backup.sessionRecords ?? []) sessionsByWorkspace.set(session.workspaceId, [...(sessionsByWorkspace.get(session.workspaceId) ?? []), session]);
    const writes: Record<string, unknown> = { [V4_META_KEY]: { ...backup.meta, schemaVersion: 4, automationWorkspaceId: undefined, appVersion: chrome.runtime?.getManifest?.().version ?? '0.18.0', updatedAt: Date.now() }, [V4_GLOBAL_SETTINGS_KEY]: { ...(backup.globalSettings ?? backup.meta.globalSettings), updatedAt: Date.now() } };
    for (const state of backup.workspaces) {
      writes[v4WorkspaceKey(state.workspaceId)] = state.workspace;
      writes[v4WorkspaceSettingsKey(state.workspaceId)] = settingsByWorkspace.get(state.workspaceId) ?? { workspaceId: state.workspaceId, overrides: {}, createdAt: state.workspace.createdAt, updatedAt: Date.now() };
      writes[v4BankKey(state.workspaceId)] = state.banks;
      writes[v4QueueKey(state.workspaceId)] = state.queue;
      writes[v4SessionsKey(state.workspaceId)] = sessionsByWorkspace.get(state.workspaceId) ?? state.historicalSessions ?? [];
      writes[v4AttemptsKey(state.workspaceId)] = attemptsByWorkspace.get(state.workspaceId) ?? state.history.map((attempt) => toV4Attempt(attempt, state.workspaceId));
    }
    if (trustedPreferences) Object.assign(writes, uiPreferenceWrites(trustedPreferences));
    const previousKeys = [...currentMeta.workspaceOrder.flatMap((id) => [v4WorkspaceKey(id), v4WorkspaceSettingsKey(id), v4BankKey(id), v4QueueKey(id), v4SessionsKey(id), v4AttemptsKey(id)]), V4_META_KEY, V4_GLOBAL_SETTINGS_KEY, V4_RUNTIME_KEY, ...preferenceKeys];
    const previous = await chrome.storage.local.get(previousKeys);
    const staged = Object.fromEntries(Object.entries(writes).map(([key, value]) => [`${stagingPrefix}${key}`, value]));
    await chrome.storage.local.set({ [stagingPrefix + 'manifest']: { transactionId, keys: Object.keys(writes), createdAt: Date.now() }, ...staged });
    const stagedRead = await chrome.storage.local.get(Object.keys(staged));
    if (Object.keys(staged).some((key) => stagedRead[key] === undefined)) throw new Error('BACKUP_STAGE_VERIFY_FAILED');
    try {
      await chrome.storage.local.set(writes);
      const committed = await chrome.storage.local.get([V4_META_KEY, V4_GLOBAL_SETTINGS_KEY]);
      if ((committed[V4_META_KEY] as AppMetadata | undefined)?.activeWorkspaceId !== backup.meta.activeWorkspaceId) throw new Error('BACKUP_COMMIT_VERIFY_FAILED');
      await cleanup();
    } catch (error) {
      const rollback: Record<string, unknown> = {};
      for (const key of previousKeys) if (previous[key] !== undefined) rollback[key] = previous[key];
      await chrome.storage.local.set(rollback);
      throw error;
    }
    await chrome.storage.local.remove(previousKeys.filter((key) => !(key in writes)));
  } else {
    const currentKeys = currentMeta.workspaceOrder.map(workspaceKey);
    const nextStates = backup.workspaces.map((state) => ({ ...state, session: null }));
    const writes = { ...Object.fromEntries(nextStates.map((state) => [workspaceKey(state.workspaceId), state])), [META_KEY]: { ...backup.meta, automationWorkspaceId: undefined } };
    if (trustedPreferences) Object.assign(writes, uiPreferenceWrites(trustedPreferences));
    const previous = await chrome.storage.local.get([...currentKeys, META_KEY, ...preferenceKeys]);
    const staged = Object.fromEntries(Object.entries(writes).map(([key, value]) => [`${stagingPrefix}${key}`, value]));
    await chrome.storage.local.set({ [stagingPrefix + 'manifest']: { transactionId, keys: Object.keys(writes), createdAt: Date.now() }, ...staged });
    const stagedRead = await chrome.storage.local.get(Object.keys(staged));
    if (Object.keys(staged).some((key) => stagedRead[key] === undefined)) throw new Error('BACKUP_STAGE_VERIFY_FAILED');
    try {
      await chrome.storage.local.set(writes);
      const committed = await chrome.storage.local.get(META_KEY);
      if ((committed[META_KEY] as AppMetaState | undefined)?.activeWorkspaceId !== backup.meta.activeWorkspaceId) throw new Error('BACKUP_COMMIT_VERIFY_FAILED');
      await cleanup();
    } catch (error) {
      const rollback: Record<string, unknown> = {};
      for (const key of [...currentKeys, META_KEY, ...preferenceKeys]) if (previous[key] !== undefined) rollback[key] = previous[key];
      await chrome.storage.local.set(rollback);
      throw error;
    }
    await chrome.storage.local.remove([...currentKeys, META_KEY, ...preferenceKeys].filter((key) => !(key in writes)));
  }
  return validation.summary;
}
