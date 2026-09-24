import type { AppState, AutomationSession, ContentInspection, LegacyPublishAttempt, QueueItem, RuntimeStatus } from '../domain/models';
import { createHistoricalSession } from '../domain/models';
import { buildStartOverQueue, countStartOverResets, hasFutureRecoveryAlarm, normalizeRecovery } from '../domain/recovery';
import { canStartItem, getNextPendingItem, getNextRunnableItem } from '../domain/state-machine';
import { runPreflight } from '../domain/preflight';
import { getNextAllowedPublishingTime } from '../domain/scheduling';
import { decideAlarmFailure } from '../domain/alarm-recovery';
import { shouldNeverRepublish } from '../domain/data-integrity.ts';
import { getStoredLocale, formatDateTimeForLocale, translateForLocale } from '../i18n/translate.ts';
import { acquireStartLock, claimAutomationOwner, getAutomationOwner, getMeta, getSettings, getState as getActiveState, getWorkspaceSettings, getWorkspaceState, listWorkspaces, releaseAutomationOwner, releaseStartLock, renewStartLock, saveHistoricalSession, updateHistoricalSession, updateState as updateActiveState, updateWorkspaceState } from '../storage/storage-repository';

/**
 * X-Pilot automation engine.
 *
 * Owns the ONLY code that can publish: the run loop (processCurrentItem /
 * advanceSession), engine state helpers, automation-tab lifecycle, scheduling,
 * alarms, and recovery. The service worker routes messages to the exported
 * control operations; it must never re-implement engine behavior here.
 *
 * Safety invariants enforced in this module (guarded by contracts):
 * - shouldNeverRepublish + canStartItem gate every publish attempt
 * - publish intent (publishIntentId) is persisted before the submit call
 * - uncertain outcomes become PUBLISHED_UNVERIFIED + PAUSED and never re-publish
 * - tab cleanup happens in finally; injection state is tracked per tab
 * - START holds a renewal lease (acquire/renew/release) and preflight gate
 */

export const ALARM_NAME = 'x-queue-next-item';
export const SCHEDULE_ALARM_NAME = 'x-queue-scheduled-start';
const AUTOMATION_TAB_KEY = 'automationTabId';
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Max characters of tweet content kept in the analytical attempt snapshot. */
export const ATTEMPT_TWEET_LABEL_MAX = 160;

export interface AttemptEntryInput {
  item: QueueItem;
  sessionId: string;
  workspaceId?: string;
  banks?: Array<{ id: string; name: string; url: string }>;
  timestamp: number;
  attemptNumber: number;
  result: string;
  error?: string;
  publishedPostUrl?: string;
  durationMs?: number;
  id?: string;
}

/**
 * Builds an analytical publish-attempt history entry.
 *
 * Captures the full tweet snapshot at attempt time — content/label, source
 * bank (id + name), queue position, elapsed duration, adapter — alongside the
 * classic fields and the published post link for successful publishes.
 * Pure aside from the optional generated id; guarded by contracts.
 */
export function buildAttemptEntry(input: AttemptEntryInput): LegacyPublishAttempt {
  const { item } = input;
  const bank = input.banks?.find((candidate) => candidate.id === item.sourceBankId)
    ?? (item.sourceBankUrl ? input.banks?.find((candidate) => candidate.url === item.sourceBankUrl) : undefined);
  const rawLabel = item.label?.trim() || item.normalizedContent?.trim() || '';
  return {
    id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    queueItemId: item.id,
    link: item.targetUrl,
    sourceUrl: item.targetUrl,
    publishedPostUrl: input.publishedPostUrl,
    timestamp: input.timestamp,
    attemptNumber: input.attemptNumber,
    action: 'PUBLISH',
    result: input.result,
    error: input.error,
    tweetLabel: rawLabel ? rawLabel.slice(0, ATTEMPT_TWEET_LABEL_MAX) : undefined,
    bankId: item.sourceBankId,
    bankName: bank?.name,
    itemPosition: item.position,
    durationMs: input.durationMs,
    adapter: 'x',
  };
}

/** Resolves the owning workspace's banks for analytical snapshots; never throws. */
async function loadWorkspaceBanks(workspaceId?: string): Promise<Array<{ id: string; name: string; url: string }>> {
  if (!workspaceId) return [];
  try {
    return (await getWorkspaceState(workspaceId)).banks ?? [];
  } catch {
    return [];
  }
}

const injectedContentTabs = new Set<number>();
const contentInjectionInFlight = new Map<number, Promise<void>>();

export async function getState(): Promise<AppState> {
  const owner = await getAutomationOwner();
  return owner ? getWorkspaceState(owner) : getActiveState();
}

export async function updateRuntimeState(mutator: (state: AppState) => AppState): Promise<AppState> {
  const owner = await getAutomationOwner();
  if (!owner) return updateActiveState(mutator);
  const saved = await updateWorkspaceState(owner, (state) => ({ ...state, ...mutator(state), workspaceId: owner }));
  return { workspaceId: saved.workspaceId, queue: saved.queue, session: saved.session, history: saved.history };
}

export async function commitQueueMutation(mutator: (state: AppState) => AppState): Promise<AppState> {
  const next = await updateRuntimeState(mutator);
  await broadcast(next);
  return next;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') injectedContentTabs.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedContentTabs.delete(tabId);
  contentInjectionInFlight.delete(tabId);
  void getState().then((state) => {
    if (state.session?.automationTabId !== tabId) return;
    void chrome.storage.local.remove(AUTOMATION_TAB_KEY);
    void updateRuntimeState((current) => current.session?.automationTabId === tabId
      ? { ...current, session: { ...current.session, automationTabId: undefined, updatedAt: Date.now() } }
      : current);
  }).catch(() => undefined);
});

export async function broadcast(state?: AppState) {
  const snapshot = state ?? await getState();
  await chrome.runtime.sendMessage({ type: 'STATE_UPDATED', state: snapshot }).catch(() => undefined);
  await updateBadge(snapshot);
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const automationWorkspaceId = await getAutomationOwner();
  const state = await getState();
  const session = state.session;
  const activeEngine = session?.status === 'RUNNING' || session?.status === 'WAITING' || session?.status === 'PAUSED';
  if (!activeEngine || !session?.automationTabId) {
    return { engineStatus: session?.status ?? 'IDLE', connection: 'NOT_REQUIRED', automationWorkspaceId, checkedAt: Date.now() };
  }
  try {
    await chrome.tabs.get(session.automationTabId);
    return { engineStatus: session.status, connection: 'CONNECTED', automationTabId: session.automationTabId, automationWorkspaceId, checkedAt: Date.now() };
  } catch {
    return { engineStatus: session.status, connection: 'DISCONNECTED', automationTabId: session.automationTabId, automationWorkspaceId, checkedAt: Date.now() };
  }
}

/**
 * Translates an engine notification into the user's locale.
 * Call sites are key-first: they pass a stable NOTIFICATION_EVENTS key and
 * optional interpolation parameters — never user-facing literals. The
 * registry maps each event to localized title/message keys, and dynamic
 * values (counts, timestamps) are formatted per locale here so call sites
 * stay locale-free. Every referenced i18n key must exist in BOTH the ar and
 * en dictionaries — enforced by the notification contract test.
 */
export type NotificationParams = Record<string, string | number>;

interface NotificationMessage {
  key: string;
  params?: NotificationParams;
}

interface NotificationSpec {
  titleKey: string;
  message: (params: NotificationParams | undefined, locale: import('../i18n/types.ts').Locale) => NotificationMessage;
}

const formatEventTime = (value: NotificationParams[string] | undefined, locale: import('../i18n/types.ts').Locale): string =>
  value === undefined ? '' : formatDateTimeForLocale(value as number, locale);

const defineEvent = (titleKey: string, message: NotificationSpec['message']): NotificationSpec => ({ titleKey, message });

export const NOTIFICATION_EVENTS = {
  SESSION_COMPLETED: defineEvent('notifications.sessionCompletedTitle', () => ({ key: 'notifications.sessionCompletedMessage' })),
  SESSION_PAUSED: defineEvent('notifications.paused', () => ({ key: 'notifications.pausedMessage' })),
  DAILY_LIMIT_STOP: defineEvent('notifications.dailyLimitTitle', () => ({ key: 'notifications.dailyLimit' })),
  LOGIN_REQUIRED: defineEvent('notifications.interventionTitle', () => ({ key: 'notifications.loginRequired' })),
  CONTROLS_NOT_READY: defineEvent('notifications.interventionTitle', () => ({ key: 'notifications.controlsMissing' })),
  UNVERIFIED_RESULT_STOP: defineEvent('notifications.interventionTitle', () => ({ key: 'notifications.unverifiedStop' })),
  CHALLENGE_STOP: defineEvent('notifications.challengeTitle', () => ({ key: 'notifications.challenge' })),
  ITEM_FAILED: defineEvent('notifications.failedItemTitle', (params) => ({ key: 'notifications.failedItemMessage', params: { position: params?.position ?? 0, reason: params?.reason ?? '' } })),
  PREFLIGHT_FAILED: defineEvent('notifications.preflightFailed', (params) => ({ key: String(params?.summaryKey ?? 'preflight.summaryKey'), params })),
  SCHEDULED_FOR: defineEvent('notifications.scheduledTitle', (params, locale) => ({ key: 'notifications.scheduledFor', params: { time: formatEventTime(params?.time, locale) } })),
  SCHEDULE_START_FAILED: defineEvent('notifications.scheduleStartFailedTitle', () => ({ key: 'notifications.noRunnableItems' })),
  SCHEDULED_STARTED: defineEvent('notifications.startedTitle', () => ({ key: 'notifications.startedMessage' })),
  ALARM_RETRY: defineEvent('notifications.alarmRetryTitle', (params) => ({ key: 'notifications.alarmRetryMessage', params: { count: params?.count ?? 0, max: params?.max ?? 0 } })),
  ALARM_GAVE_UP: defineEvent('notifications.alarmGaveUpTitle', () => ({ key: 'notifications.alarmGaveUp' })),
  SCHEDULE_CANCELLED: defineEvent('notifications.cancelledTitle', () => ({ key: 'notifications.cancelledMessage' })),
  OUTSIDE_WINDOW: defineEvent('notifications.outsideWindowTitle', (params, locale) => ({ key: 'notifications.resumeAt', params: { time: formatEventTime(params?.time, locale) } })),
};

export type NotificationEventKey = keyof typeof NOTIFICATION_EVENTS;

export async function notifyEvent(event: NotificationEventKey, params?: NotificationParams): Promise<void> {
  const settings = await getSettings();
  if (!settings.notificationsEnabled || !chrome.notifications) return;
  const locale = await getStoredLocale();
  const spec = NOTIFICATION_EVENTS[event];
  const { key, params: messageParams } = spec.message(params, locale);
  await chrome.notifications.create(`x-pilot-${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: translateForLocale(locale, spec.titleKey), message: translateForLocale(locale, key, messageParams ?? {}) });
}

export async function updateBadge(state?: AppState): Promise<void> {
  const settings = await getSettings();
  const snapshot = state ?? await getState();
  let text = '';
  if (settings.badgeMode === 'COUNT') text = String(snapshot.queue.filter((item) => item.status === 'PENDING' || item.status === 'FAILED').length || '');
  if (settings.badgeMode === 'STATUS') text = snapshot.session?.status === 'RUNNING' ? '▶' : snapshot.session?.status === 'PAUSED' ? 'Ⅱ' : snapshot.session?.status === 'FAILED' ? '!' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: snapshot.session?.status === 'FAILED' ? '#b42318' : '#175fbe' });
}

export async function recoverPersistedState(): Promise<AppState> {
  const current = await getState();
  const recovered = normalizeRecovery(current);
  const changed = JSON.stringify(recovered) !== JSON.stringify(current);
  const state = changed ? await updateRuntimeState(() => recovered) : current;
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  if (state.session?.status === 'SCHEDULED' && state.session.scheduledStartAt && state.session.scheduledStartAt > Date.now()) await chrome.alarms.create(SCHEDULE_ALARM_NAME, { when: state.session.scheduledStartAt, persistAcrossSessions: true });
  if (hasFutureRecoveryAlarm(state)) await chrome.alarms.create(ALARM_NAME, { when: state.session!.nextRunAt!, persistAcrossSessions: true });
  await updateBadge(state);
  await broadcast(state);
  return state;
}

export async function syncHistoricalSession(state: AppState, status?: 'RUNNING' | 'PAUSED' | 'WAITING' | 'COMPLETED' | 'STOPPED' | 'FAILED', failureReason?: string): Promise<void> {
  const session = state.session;
  if (!state.workspaceId || !session?.historicalSessionId) return;
  await updateHistoricalSession(state.workspaceId, session.historicalSessionId, {
    ...(status ? { status } : {}),
    ...(status === 'COMPLETED' || status === 'STOPPED' || status === 'FAILED' ? { completedAt: Date.now() } : {}),
    ...(failureReason ? { failureReason } : {}),
    totalItems: state.queue.length,
    publishedCount: state.queue.filter((item) => item.status === 'PUBLISHED' || item.status === 'PUBLISHED_UNVERIFIED').length,
    failedCount: state.queue.filter((item) => item.status === 'FAILED').length,
    skippedCount: state.queue.filter((item) => item.status === 'SKIPPED').length,
  });
}

export async function getOrCreateAutomationTab(session: AutomationSession): Promise<number> {
  if (session.automationTabId) {
    try {
      await chrome.tabs.get(session.automationTabId);
      return session.automationTabId;
    } catch { /* recreate below */ }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (!tab.id) throw new Error('AUTOMATION_TAB_CREATE_FAILED');
  await updateRuntimeState((state) => ({ ...state, session: state.session ? { ...state.session, automationTabId: tab.id, updatedAt: Date.now() } : null }));
  await chrome.storage.local.set({ [AUTOMATION_TAB_KEY]: tab.id });
  return tab.id;
}

export async function waitForTabLoad(tabId: number, timeoutMs = 20000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: number | undefined;
    let settled = false;
    const cleanup = () => { chrome.tabs.onUpdated.removeListener(listener); if (timer) clearTimeout(timer); };
    const finish = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') finish(); }).catch(() => undefined);
    timer = setTimeout(() => { cleanup(); reject(new Error('TAB_LOAD_TIMEOUT')); }, timeoutMs) as unknown as number;
  });
}

export async function getPreviousActiveTabId(tabId: number): Promise<number | undefined> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab?.id && activeTab.id !== tabId ? activeTab.id : undefined;
}

export async function activateAutomationTab(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
}

export async function restoreActiveTab(tabId: number | undefined): Promise<void> {
  if (tabId) await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
}

export async function closeAutomationTabIfConfigured(session: AutomationSession): Promise<AppState> {
  const tabId = session.automationTabId;
  const shouldClose = Boolean(tabId && (session.closeTabOnComplete || !session.keepAutomationTabOpen));
  if (!tabId || !shouldClose) return getState();
  await chrome.tabs.remove(tabId).catch(() => undefined);
  await chrome.storage.local.remove(AUTOMATION_TAB_KEY);
  return updateRuntimeState((state) => state.session?.automationTabId === tabId
    ? { ...state, session: { ...state.session, automationTabId: undefined, updatedAt: Date.now() } }
    : state);
}

export async function ensureContentScript(tabId: number): Promise<void> {
  if (injectedContentTabs.has(tabId)) return;
  const existing = contentInjectionInFlight.get(tabId);
  if (existing) return existing;
  const injection = chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    .then(() => { injectedContentTabs.add(tabId); })
    .finally(() => { contentInjectionInFlight.delete(tabId); });
  contentInjectionInFlight.set(tabId, injection);
  return injection;
}

export async function inspectTab(tabId: number): Promise<ContentInspection> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'X_INSPECT' });
  } catch {
    await ensureContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, { type: 'X_INSPECT' });
  }
}

export async function waitForPublishReady(tabId: number, timeoutMs = 25000, intervalMs = 500): Promise<ContentInspection> {
  const deadline = Date.now() + timeoutMs;
  let lastInspection: ContentInspection | undefined;
  while (Date.now() < deadline) {
    lastInspection = await inspectTab(tabId);
    if (lastInspection.ok) return lastInspection;
    if (lastInspection.pageKind === 'LOGIN' || lastInspection.pageKind === 'CHALLENGE' || lastInspection.pageKind === 'UNKNOWN' || lastInspection.reason === 'X_DAILY_POST_LIMIT_REACHED') {
      throw new Error(lastInspection.reason ?? 'PUBLISH_CONTROLS_NOT_READY');
    }
    await wait(intervalMs);
  }
  throw new Error(lastInspection?.reason ?? 'PUBLISH_CONTROLS_NOT_READY');
}

async function assertOperationActive(itemId: string, operationId: string): Promise<void> {
  const state = await getState();
  const item = state.queue.find((candidate) => candidate.id === itemId);
  if (state.session?.status !== 'RUNNING' || item?.operationId !== operationId) throw new Error('AUTOMATION_INTERRUPTED');
}

async function processCurrentItem(): Promise<void> {
  const state = await getState();
  const session = state.session;
  if (!session || session.status !== 'RUNNING' || !session.currentItemId) return;
  const item = state.queue.find((candidate) => candidate.id === session.currentItemId);
  if (!item || shouldNeverRepublish(item) || !canStartItem(item.status)) return;
  const banks = await loadWorkspaceBanks(state.workspaceId ?? session.workspaceId);
  const profile = await getWorkspaceSettings(state.workspaceId ?? session.workspaceId ?? (await getMeta()).activeWorkspaceId);
  const allowedAt = getNextAllowedPublishingTime(Date.now(), profile.timezone, profile.publishingWindows);
  if (allowedAt && allowedAt > Date.now() + 500) {
    const waiting = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'WAITING', nextRunAt: allowedAt, updatedAt: Date.now() } : null }));
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, { when: allowedAt, persistAcrossSessions: true });
    await notifyEvent('OUTSIDE_WINDOW', { time: allowedAt });
    await broadcast(waiting);
    return;
  }
  const operationId = crypto.randomUUID();
  const startedAt = Date.now();
  await updateRuntimeState((current) => ({
    ...current,
    queue: current.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'OPENING', attempts: candidate.attempts + 1, startedAt, operationId, updatedAt: startedAt } : candidate)
  }));
  let tabId: number | undefined;
  let previousActiveTabId: number | undefined;
  try {
    tabId = await getOrCreateAutomationTab(session);
    previousActiveTabId = await getPreviousActiveTabId(tabId);
    await chrome.tabs.update(tabId, { url: item.targetUrl, active: false });
    await waitForTabLoad(tabId);
    await activateAutomationTab(tabId);
    await wait(300);
    await waitForPublishReady(tabId);
    await assertOperationActive(item.id, operationId);
    await updateRuntimeState((current) => ({ ...current, queue: current.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'READY', updatedAt: Date.now() } : candidate) }));
    const lockedState = await getState();
    const lockedItem = lockedState.queue.find((candidate) => candidate.id === item.id);
    if (!lockedItem || lockedItem.operationId !== operationId || lockedItem.status !== 'READY') throw new Error('ITEM_LOCK_LOST');
    await assertOperationActive(item.id, operationId);
    await updateRuntimeState((current) => ({ ...current, queue: current.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'PUBLISHING', publishIntentId: operationId, publishStartedAt: Date.now(), updatedAt: Date.now() } : candidate) }));
    const result = await chrome.tabs.sendMessage(tabId, { type: 'X_PUBLISH' });
    await updateRuntimeState((current) => ({ ...current, queue: current.queue.map((candidate) => candidate.id === item.id && candidate.publishIntentId === operationId ? { ...candidate, publishSubmittedAt: Date.now(), updatedAt: Date.now() } : candidate) }));
    await wait(1800);
    const after = await inspectTab(tabId);
    const publishedUrlResult = await chrome.tabs.sendMessage(tabId, { type: 'X_GET_PUBLISHED_URL' }).catch(() => undefined) as { publishedPostUrl?: string } | undefined;
    const publishedPostUrl = publishedUrlResult?.publishedPostUrl;
    if (after.dailyPostLimitReached || after.reason === 'X_DAILY_POST_LIMIT_REACHED') throw new Error('X_DAILY_POST_LIMIT_REACHED');
    if (!result?.ok) throw new Error(result?.reason ?? 'PUBLISH_FAILED');
    const finalStatus = after.composerFound && after.contentPresent ? 'PUBLISHED_UNVERIFIED' : 'PUBLISHED';
    const finishedAt = Date.now();
    const nextItem = getNextPendingItem((await getState()).queue, item.id);
    const nextRunAt = nextItem ? getNextAllowedPublishingTime(finishedAt + profile.intervalMinutes * 60_000, profile.timezone, profile.publishingWindows) : undefined;
    const nextStatus = nextItem ? 'WAITING' : 'COMPLETED';
    const nextState = await updateRuntimeState((current) => ({
      ...current,
      queue: current.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: finalStatus, publishedAt: finishedAt, updatedAt: finishedAt, operationId: undefined, publishIntentId: undefined, publishStartedAt: undefined, publishSubmittedAt: undefined } : candidate),
      session: current.session ? { ...current.session, status: nextStatus, currentItemId: nextItem?.id, currentIndex: nextItem?.position ?? current.session.currentIndex, nextRunAt, completedAt: nextStatus === 'COMPLETED' ? finishedAt : current.session.completedAt, updatedAt: finishedAt } : null,
      history: [...current.history, buildAttemptEntry({ id: crypto.randomUUID(), item, sessionId: session.id, workspaceId: current.workspaceId, banks, timestamp: finishedAt, attemptNumber: item.attempts + 1, result: finalStatus, publishedPostUrl, durationMs: finishedAt - startedAt })]
    }));
    await syncHistoricalSession(nextState, nextStatus === 'COMPLETED' ? 'COMPLETED' : 'WAITING');
    await chrome.alarms.clear(ALARM_NAME);
    if (nextRunAt) await chrome.alarms.create(ALARM_NAME, { when: nextRunAt, persistAcrossSessions: true });
    await restoreActiveTab(previousActiveTabId);
    const visibleState = nextStatus === 'COMPLETED' && nextState.session
      ? await closeAutomationTabIfConfigured(nextState.session)
      : nextState;
    if (nextStatus === 'COMPLETED' && nextState.workspaceId) await releaseAutomationOwner(nextState.workspaceId);
    if (nextStatus === 'COMPLETED') await notifyEvent('SESSION_COMPLETED');
    await broadcast(visibleState);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    if (message === 'X_DAILY_POST_LIMIT_REACHED') {
      const pausedState = await updateRuntimeState((currentState) => ({
        ...currentState,
        queue: currentState.queue.map((candidate) => candidate.id === item.id && candidate.operationId === operationId
          ? { ...candidate, status: 'PENDING', attempts: item.attempts, lastError: message, operationId: undefined, updatedAt: Date.now() }
          : candidate),
        session: currentState.session ? { ...currentState.session, status: 'PAUSED', currentItemId: item.id, nextRunAt: undefined, updatedAt: Date.now() } : null,
        history: [...currentState.history, buildAttemptEntry({ id: crypto.randomUUID(), item, sessionId: session.id, workspaceId: currentState.workspaceId, banks, timestamp: Date.now(), attemptNumber: item.attempts, result: 'PAUSED', error: message, durationMs: Date.now() - startedAt })]
      }));
      await syncHistoricalSession(pausedState, 'PAUSED', message);
      await chrome.alarms.clear(ALARM_NAME);
      await restoreActiveTab(previousActiveTabId);
      await notifyEvent('DAILY_LIMIT_STOP');
      await broadcast(pausedState);
      return;
    }
    if (message.includes('LOGIN') || message.includes('PUBLISH_CONTROLS_NOT_READY')) await notifyEvent(message.includes('LOGIN') ? 'LOGIN_REQUIRED' : 'CONTROLS_NOT_READY');
    if (message.includes('CHALLENGE') || message.includes('CAPTCHA')) await notifyEvent('CHALLENGE_STOP');
    if (message === 'AUTOMATION_INTERRUPTED') {
      const interruptedState = await updateRuntimeState((current) => ({
        ...current,
        queue: current.queue.map((candidate) => candidate.id === item.id && candidate.operationId === operationId && candidate.status !== 'PUBLISHING' ? { ...candidate, status: 'PENDING', operationId: undefined, updatedAt: Date.now() } : candidate)
      }));
      await restoreActiveTab(previousActiveTabId);
      await broadcast(interruptedState);
      return;
    }
    const current = await getState();
    const latestItem = current.queue.find((candidate) => candidate.id === item.id);
    if (latestItem?.status === 'PUBLISHING' && latestItem.publishIntentId === operationId && message !== 'X_DAILY_POST_LIMIT_REACHED') {
      const uncertainAt = Date.now();
      const uncertain = await updateRuntimeState((currentState) => ({
        ...currentState,
        queue: currentState.queue.map((candidate) => candidate.id === item.id && candidate.publishIntentId === operationId
          ? { ...candidate, status: 'PUBLISHED_UNVERIFIED', publishedAt: candidate.publishedAt ?? uncertainAt, lastError: 'PUBLISH_OUTCOME_UNVERIFIED', operationId: undefined, updatedAt: uncertainAt }
          : candidate),
        session: currentState.session ? { ...currentState.session, status: 'PAUSED', currentItemId: item.id, nextRunAt: undefined, updatedAt: uncertainAt } : null,
        history: [...currentState.history, buildAttemptEntry({ id: crypto.randomUUID(), item, sessionId: session.id, workspaceId: currentState.workspaceId, banks, timestamp: uncertainAt, attemptNumber: item.attempts, result: 'PUBLISHED_UNVERIFIED', error: 'PUBLISH_OUTCOME_UNVERIFIED', durationMs: uncertainAt - startedAt })]
      }));
      await syncHistoricalSession(uncertain, 'PAUSED', 'PUBLISH_OUTCOME_UNVERIFIED');
      await chrome.alarms.clear(ALARM_NAME);
      await restoreActiveTab(previousActiveTabId);
      await notifyEvent('UNVERIFIED_RESULT_STOP');
      await broadcast(uncertain);
      return;
    }
    if (current.session?.status !== 'RUNNING' || latestItem?.operationId !== operationId) {
      await restoreActiveTab(previousActiveTabId);
      return;
    }
    const exhausted = !latestItem || latestItem.attempts >= session.maxRetries + 1;
    const failedStatus = exhausted ? 'FAILED' : 'PENDING';
    const nextItem = exhausted && session.failureBehavior === 'CONTINUE' ? getNextPendingItem(current.queue, item.id) : undefined;
    const nextRunAt = !exhausted || nextItem ? Date.now() + session.intervalMinutes * 60_000 : undefined;
    const nextStatus = exhausted && session.failureBehavior === 'PAUSE' ? 'PAUSED' : nextItem || !exhausted ? 'WAITING' : 'COMPLETED';
    const nextItemId = nextItem?.id ?? (!exhausted ? item.id : undefined);
    const nextItemIndex = nextItem?.position ?? (!exhausted ? item.position : current.session?.currentIndex);
    const failedState = await updateRuntimeState((currentState) => ({
      ...currentState,
      queue: currentState.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: failedStatus, lastError: message, operationId: undefined, updatedAt: Date.now() } : candidate),
      session: currentState.session ? { ...currentState.session, status: nextStatus, currentItemId: nextItemId, currentIndex: nextItemIndex ?? currentState.session.currentIndex, nextRunAt, completedAt: nextStatus === 'COMPLETED' ? Date.now() : currentState.session.completedAt, updatedAt: Date.now() } : null,
      history: [...currentState.history, buildAttemptEntry({ id: crypto.randomUUID(), item, sessionId: session.id, workspaceId: currentState.workspaceId, banks, timestamp: Date.now(), attemptNumber: item.attempts + 1, result: failedStatus, error: message, durationMs: Date.now() - startedAt })]
    }));
    await syncHistoricalSession(failedState, nextStatus === 'COMPLETED' ? 'COMPLETED' : nextStatus === 'PAUSED' ? 'PAUSED' : 'WAITING', message);
    await chrome.alarms.clear(ALARM_NAME);
    if (nextRunAt) await chrome.alarms.create(ALARM_NAME, { when: nextRunAt, persistAcrossSessions: true });
    await restoreActiveTab(previousActiveTabId);
    const visibleState = nextStatus === 'COMPLETED' && failedState.session
      ? await closeAutomationTabIfConfigured(failedState.session)
      : failedState;
    if (nextStatus === 'COMPLETED' && failedState.workspaceId) await releaseAutomationOwner(failedState.workspaceId);
    if (failedStatus === 'FAILED') await notifyEvent('ITEM_FAILED', { position: item.position, reason: message });
    await broadcast(visibleState);
  }
}

async function advanceSession(): Promise<void> {
  const state = await getState();
  if (!state.session || state.session.status !== 'WAITING') return;
  const next = getNextRunnableItem(state.queue, state.session.currentItemId);
    if (!next) {
      const completed = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'COMPLETED', completedAt: Date.now(), nextRunAt: undefined, updatedAt: Date.now() } : null }));
    await syncHistoricalSession(completed, 'COMPLETED');
    const visibleState = completed.session ? await closeAutomationTabIfConfigured(completed.session) : completed;
    if (completed.workspaceId) await releaseAutomationOwner(completed.workspaceId);
    await broadcast(visibleState);
    return;
  }
  const running = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'RUNNING', currentItemId: next.id, currentIndex: next.position, nextRunAt: undefined, updatedAt: Date.now() } : null }));
  await broadcast(running);
  await processCurrentItem();
}

export async function performPreflight(workspaceId: string) {
  const state = await getWorkspaceState(workspaceId);
  const meta = await getMeta();
  const workspace = (await listWorkspaces(true)).find((item) => item.id === workspaceId);
  const settings = await getSettings();
  const permissionsGranted = await chrome.permissions.contains({ origins: ['https://x.com/*', 'https://twitter.com/*'] }).catch(() => false);
  let xInspection: ContentInspection | null = null;
  let temporaryTabId: number | undefined;
  let previousActiveTabId: number | undefined;
  try {
    const firstItem = state.queue.find((item) => canStartItem(item.status) && !item.duplicateStatus?.includes('PUBLISHED'));
    const targetUrl = firstItem?.targetUrl?.trim() || 'https://x.com/home';
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(parsed.hostname)) throw new Error('PREFLIGHT_INVALID_X_ITEM_URL');
    const temporary = await chrome.tabs.create({ url: 'about:blank', active: false });
    if (!temporary.id) throw new Error('PREFLIGHT_X_TAB_CREATE_FAILED');
    temporaryTabId = temporary.id;
    previousActiveTabId = await getPreviousActiveTabId(temporary.id);
    await chrome.tabs.update(temporary.id, { url: targetUrl, active: false });
    await waitForTabLoad(temporary.id);
    await activateAutomationTab(temporary.id);
    await wait(300);
    xInspection = await inspectTab(temporary.id);
  } catch (error) {
    xInspection = { ok: false, pageKind: 'ERROR', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: error instanceof Error ? error.message : 'PREFLIGHT_X_INSPECTION_FAILED' };
  } finally {
    await restoreActiveTab(previousActiveTabId);
    if (temporaryTabId !== undefined) await chrome.tabs.remove(temporaryTabId).catch(() => undefined);
  }
  return runPreflight({ workspace, queue: state.queue, banks: state.banks, automationWorkspaceId: meta.automationWorkspaceId, alarmsAvailable: Boolean(chrome.alarms), permissionsGranted, settings, xInspection });
}

export async function scheduleSession(workspaceId: string, startAt: number): Promise<AppState> {
  if (!Number.isFinite(startAt) || startAt <= Date.now()) throw new Error('SCHEDULE_START_MUST_BE_IN_FUTURE');
  const preflight = await performPreflight(workspaceId);
  if (!preflight.ready) { await notifyEvent('PREFLIGHT_FAILED', { ...preflight.summaryParams, summaryKey: preflight.summaryKey }); throw new Error(`PREFLIGHT_FAILED:${preflight.summaryKey}`); }
  await claimAutomationOwner(workspaceId);
  const settings = await getWorkspaceSettings(workspaceId);
  const scheduled = await updateWorkspaceState(workspaceId, (current) => ({
    ...current,
    session: {
      ...(current.session ?? {
        id: crypto.randomUUID(), workspaceId, bankId: current.banks.find((bank) => !bank.archived)?.id, bankUrl: current.banks.find((bank) => !bank.archived)?.url ?? '', status: 'SCHEDULED' as const, currentIndex: current.queue.find((item) => item.status === 'PENDING')?.position ?? 0, total: current.queue.length, version: 1,
      }),
      ...settings,
      workspaceId,
      status: 'SCHEDULED',
      scheduledStartAt: startAt,
      nextRunAt: startAt,
      currentItemId: current.session?.currentItemId ?? current.queue.find((item) => item.status === 'PENDING')?.id,
      updatedAt: Date.now(),
    },
  }));
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  await chrome.alarms.create(SCHEDULE_ALARM_NAME, { when: startAt, persistAcrossSessions: true });
  const state: AppState = { workspaceId: scheduled.workspaceId, queue: scheduled.queue, session: scheduled.session, history: scheduled.history };
  await notifyEvent('SCHEDULED_FOR', { time: startAt });
  await broadcast(state);
  return state;
}

async function handleScheduledStart(): Promise<void> {
  const state = await getState();
  if (!state.session || state.session.status !== 'SCHEDULED') return;
  if ((state.session.scheduledStartAt ?? 0) > Date.now()) {
    await chrome.alarms.create(SCHEDULE_ALARM_NAME, { when: state.session.scheduledStartAt!, persistAcrossSessions: true });
    return;
  }
  const item = state.session.currentItemId ? state.queue.find((candidate) => candidate.id === state.session!.currentItemId) : undefined;
  if (!item || !canStartItem(item.status)) {
    await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
    const failed = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'FAILED', scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : null }));
    await notifyEvent('SCHEDULE_START_FAILED');
    await broadcast(failed);
    return;
  }
  const running = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'RUNNING', startedAt: Date.now(), scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : null }));
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  await notifyEvent('SCHEDULED_STARTED');
  let ready = running;
  if (running.workspaceId && running.session && !running.session.historicalSessionId) {
    const historical = createHistoricalSession(running.session, running.queue);
    await saveHistoricalSession(running.workspaceId, historical);
    ready = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, historicalSessionId: historical.id, updatedAt: Date.now() } : null }));
  }
  await broadcast(ready);
  await processCurrentItem();
}

async function handleAlarmFailure(alarmName: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : 'ALARM_HANDLER_FAILED';
  console.error('X-Pilot alarm handler failed', { alarmName, message });
  try {
    const state = await getState();
    const session = state.session;
    if (!session || !['RUNNING', 'WAITING', 'SCHEDULED'].includes(session.status)) return;
    const alarmStatus = session.status === 'SCHEDULED' ? 'SCHEDULED' : 'WAITING';
    const retryAt = alarmStatus === 'WAITING' ? session.nextRunAt : session.scheduledStartAt;
    const decision = decideAlarmFailure(alarmStatus, retryAt, session.alarmFailureCount ?? 0, Date.now());
    if (decision.action === 'RETRY') {
      await chrome.alarms.create(decision.alarmName, { when: decision.when, persistAcrossSessions: true });
      const retried = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: current.session.status === 'RUNNING' ? 'WAITING' : current.session.status, nextRunAt: current.session.status === 'RUNNING' ? decision.when : current.session.nextRunAt, alarmFailureCount: decision.failureCount, lastAlarmError: message, updatedAt: Date.now() } : null }));
      await notifyEvent('ALARM_RETRY', { count: decision.failureCount, max: 3 });
      await broadcast(retried);
      return;
    }
    const failed = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'FAILED', nextRunAt: undefined, scheduledStartAt: undefined, alarmFailureCount: decision.failureCount, lastAlarmError: message, updatedAt: Date.now() } : null }));
    await chrome.alarms.clear(alarmName);
    if (failed.workspaceId) await releaseAutomationOwner(failed.workspaceId);
    await notifyEvent('ALARM_GAVE_UP');
    await broadcast(failed);
  } catch (fallbackError) {
    console.error('X-Pilot alarm failure recovery failed', fallbackError);
  }
}

async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  const state = await getState();
  const session = state.session;
  if (alarm.name === ALARM_NAME && session?.status === 'WAITING') {
    if (session.nextRunAt && session.nextRunAt > Date.now()) return;
    await advanceSession();
  }
  if (alarm.name === SCHEDULE_ALARM_NAME && session?.status === 'SCHEDULED') {
    if (session.scheduledStartAt && session.scheduledStartAt > Date.now()) return;
    await handleScheduledStart();
  }
}

chrome.alarms.onAlarm.addListener

chrome.alarms.onAlarm.addListener((alarm) => { void handleAlarm(alarm).catch((error) => handleAlarmFailure(alarm.name, error)); });

export async function startSession(messageWorkspaceId?: string): Promise<unknown> {
  const workspaceId = messageWorkspaceId ?? (await getMeta()).activeWorkspaceId;
  const startToken = await acquireStartLock(workspaceId);
  const leaseHeartbeat = setInterval(() => { void renewStartLock(startToken).then((healthy) => { if (!healthy) console.error('X-Pilot START lease lost', { workspaceId }); }).catch((error) => console.error('X-Pilot START lease renewal failed', error)); }, 5_000);
  try {
    const existing = await getWorkspaceState(workspaceId);
    if (existing.session && ['RUNNING', 'WAITING', 'PAUSED', 'SCHEDULED'].includes(existing.session.status)) throw new Error('START_ALREADY_ACTIVE');
    const preflight = await performPreflight(workspaceId);
    if (!preflight.ready) { await notifyEvent('PREFLIGHT_FAILED', { ...preflight.summaryParams, summaryKey: preflight.summaryKey }); throw new Error(`PREFLIGHT_FAILED:${preflight.summaryKey}`); }
    await claimAutomationOwner(workspaceId);
    const settings = await getWorkspaceSettings(workspaceId);
    const state = await updateRuntimeState((current) => {
      const firstItem = current.queue.find((item) => canStartItem(item.status) && !item.duplicateStatus?.includes('PUBLISHED'));
      const currentItem = current.session?.currentItemId && current.queue.some((item) => item.id === current.session?.currentItemId && canStartItem(item.status))
        ? current.session.currentItemId
        : firstItem?.id;
      const session: AutomationSession = current.session ?? {
        id: crypto.randomUUID(), workspaceId, bankUrl: '', ...settings,
        status: 'RUNNING' as const, currentIndex: firstItem?.position ?? 0, total: current.queue.length, version: 1, updatedAt: Date.now(),
      };
      return { ...current, session: { ...session, ...settings, workspaceId, status: 'RUNNING', startedAt: session.startedAt ?? Date.now(), currentItemId: currentItem, currentIndex: current.queue.find((item) => item.id === currentItem)?.position ?? session.currentIndex, total: current.queue.length, updatedAt: Date.now() } };
    });
    if (state.workspaceId && state.session && !state.session.historicalSessionId) {
      const historical = createHistoricalSession(state.session, state.queue);
      await saveHistoricalSession(state.workspaceId, historical);
      const linked = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, historicalSessionId: historical.id, updatedAt: Date.now() } : null }));
      await broadcast(linked); await processCurrentItem(); return getState();
    }
    await broadcast(state); await processCurrentItem(); return getState();
  } finally {
    clearInterval(leaseHeartbeat);
    await releaseStartLock(startToken);
  }

}

/**
 * Starts an existing SCHEDULED session immediately after its scheduled start
 * time was missed (alarm lost or never delivered). Explicit user action only —
 * never invoked automatically. Safety parity with startSession:
 * - start-lock lease held for the whole operation;
 * - preflight must be ready before any publishing proceeds;
 * - the schedule alarm is cleared so the missed start cannot double-fire;
 * - publish intents are already persisted for the queue — no new intent.
 */
export async function startScheduledNow(): Promise<unknown> {
  const workspaceId = (await getMeta()).activeWorkspaceId;
  const startToken = await acquireStartLock(workspaceId);
  const leaseHeartbeat = setInterval(() => { void renewStartLock(startToken).then((healthy) => { if (!healthy) console.error('X-Pilot START lease lost', { workspaceId }); }).catch((error) => console.error('X-Pilot START lease renewal failed', error)); }, 5_000);
  try {
    const state = await getWorkspaceState(workspaceId);
    if (!state.session || state.session.status !== 'SCHEDULED') throw new Error('START_NOT_SCHEDULED');
    const preflight = await performPreflight(workspaceId);
    if (!preflight.ready) { await notifyEvent('PREFLIGHT_FAILED', { ...preflight.summaryParams, summaryKey: preflight.summaryKey }); throw new Error(`PREFLIGHT_FAILED:${preflight.summaryKey}`); }
    await claimAutomationOwner(workspaceId);
    const running = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'RUNNING', startedAt: Date.now(), scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : null }));
    await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
    await broadcast(running);
    await processCurrentItem();
    return getState();
  } finally {
    clearInterval(leaseHeartbeat);
    await releaseStartLock(startToken);
  }

}

export async function pauseSession(): Promise<AppState> {
  await chrome.alarms.clear(ALARM_NAME);
  const paused = await updateRuntimeState((state) => ({
    ...state,
    queue: state.queue.map((item) => item.id === state.session?.currentItemId && (item.status === 'OPENING' || item.status === 'READY') ? { ...item, status: 'PENDING', operationId: undefined, updatedAt: Date.now() } : item),
    session: state.session ? { ...state.session, status: 'PAUSED', pausedAt: Date.now(), nextRunAt: state.session.status === 'WAITING' ? state.session.nextRunAt : undefined, updatedAt: Date.now() } : null
  }));
  await syncHistoricalSession(paused, 'PAUSED');
  await notifyEvent('SESSION_PAUSED');
  await broadcast(paused);
  return paused;

}

export async function resumeSession(): Promise<AppState> {
  const current = await getState();
  if (!current.session || current.session.status !== 'PAUSED') return current;
  const nextRunAt = current.session.nextRunAt;
  const hasFutureAlarm = Boolean(nextRunAt && nextRunAt > Date.now());
  if (hasFutureAlarm && nextRunAt) {
    await chrome.alarms.create(ALARM_NAME, { when: nextRunAt, persistAcrossSessions: true });
    const waiting = await updateRuntimeState((state) => ({ ...state, session: state.session ? { ...state.session, status: 'WAITING', pausedAt: undefined, updatedAt: Date.now() } : null }));
    await broadcast(waiting);
    return waiting;
  }
  const currentItem = current.queue.find((item) => item.id === current.session?.currentItemId && canStartItem(item.status));
  const next = currentItem ?? getNextPendingItem(current.queue);
  const running = await updateRuntimeState((state) => ({ ...state, session: state.session ? { ...state.session, status: 'RUNNING', pausedAt: undefined, nextRunAt: undefined, currentItemId: next?.id, currentIndex: next?.position ?? state.session.currentIndex, updatedAt: Date.now() } : null }));
  await broadcast(running);
  if (next) await processCurrentItem();
  return running;

}

export async function stopSession(): Promise<AppState> {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  const stopped = await updateRuntimeState((state) => ({
    ...state,
    queue: state.queue.map((item) => item.id === state.session?.currentItemId && (item.status === 'OPENING' || item.status === 'READY') ? { ...item, status: 'PENDING', operationId: undefined, updatedAt: Date.now() } : item),
    session: state.session ? { ...state.session, status: 'STOPPED', scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : null
  }));
  await syncHistoricalSession(stopped, 'STOPPED');
  const result = stopped.session ? await closeAutomationTabIfConfigured(stopped.session) : stopped;
  if (result.workspaceId) await releaseAutomationOwner(result.workspaceId);
  return result;

}

export async function startOverSession(): Promise<AppState & { resetCount: number }> {
  const now = Date.now();
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  let resetCount = 0;
  const restarted = await updateRuntimeState((state) => {
    resetCount = countStartOverResets(state.queue);
    const queue = buildStartOverQueue(state.queue, now);
    return { ...state, queue, session: state.session ? { ...state.session, status: 'STOPPED' as const, scheduledStartAt: undefined, nextRunAt: undefined, currentItemId: undefined, currentIndex: 0, total: queue.length, updatedAt: now } : null };
  });
  if (restarted.session) await syncHistoricalSession(restarted, 'STOPPED');
  const closed = restarted.session ? await closeAutomationTabIfConfigured(restarted.session) : restarted;
  if (closed.workspaceId) await releaseAutomationOwner(closed.workspaceId);
  const next: AppState = { workspaceId: closed.workspaceId, queue: closed.queue, session: closed.session, history: closed.history };
  await broadcast(next);
  return { ...next, resetCount };

}

export async function cancelScheduledStart(): Promise<AppState> {
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  const cancelled = await updateRuntimeState((current) => ({ ...current, session: current.session?.status === 'SCHEDULED' ? { ...current.session, status: 'STOPPED', scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : current.session }));
  await releaseAutomationOwner(cancelled.workspaceId ?? (await getMeta()).activeWorkspaceId);
  await notifyEvent('SCHEDULE_CANCELLED');
  await broadcast(cancelled);
  return cancelled;

}
