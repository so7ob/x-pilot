import type { AppState, AutomationSession, BankDiffResult, BankSnapshotItem, BulkActionResult, BulkQueueAction, ContentInspection, DiagnosticsCheck, DiagnosticsResult, DryRunItemResult, DryRunResult, QueueItem, RuntimeMessage, RuntimeStatus, Settings } from '../domain/models';
import { createHistoricalSession, defaultSettings } from '../domain/models';
import { classifyBankDiff, mergeSelectedDiffItems } from '../domain/bank-diff';
import { buildBankExport, buildBanksExport, parseBankImport } from '../domain/bank-transfer';
import { fingerprintTweet } from '../domain/content-fingerprint';
import { runPreflight } from '../domain/preflight';
import { hasFutureRecoveryAlarm, normalizeRecovery } from '../domain/recovery';
import { canStartItem, getNextPendingItem, getNextRunnableItem, isTerminalItem } from '../domain/state-machine';
import { extractLinksFromValues } from '../extraction/bank-parser';
import { getNextAllowedPublishingTime } from '../domain/scheduling';
import { decideAlarmFailure } from '../domain/alarm-recovery';
import { applyBulkStatus, reorderSelected } from '../domain/bulk-queue';
import { shouldNeverRepublish } from '../domain/data-integrity.ts';
import { getStoredLocale, formatDateTimeForLocale, translateForLocale } from '../i18n/translate.ts';
import { acquireStartLock, addAttempt, archiveBank, claimAutomationOwner, cleanupRestoreStaging, clearWorkspaceProfile, createBank, createWorkspace, deleteBank, deleteWorkspace, exportBackup, getAutomationOwner, getHistoricalSessions, getMeta, getSettings, getState as getActiveState, getWorkspaceSettings, getWorkspaceState, importBanks, listBanks, listWorkspaces, releaseAutomationOwner, releaseStartLock, renewStartLock, restoreBank, restoreBackup, saveHistoricalSession, saveQueue, saveSession, saveSettings, setActiveWorkspace, updateBank, updateHistoricalSession, updateState as updateActiveState, updateWorkspace, updateWorkspaceProfile, updateWorkspaceState, archiveWorkspace, restoreWorkspace, validateBackup } from '../storage/storage-repository';

const ALARM_NAME = 'x-queue-next-item';
const SCHEDULE_ALARM_NAME = 'x-queue-scheduled-start';
const bankDiffs = new Map<string, BankDiffResult>();
const AUTOMATION_TAB_KEY = 'automationTabId';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const injectedContentTabs = new Set<number>();
const contentInjectionInFlight = new Map<number, Promise<void>>();
const DRY_RUN_KEY = 'xPilotDryRunResult';
let dryRunStopRequested = false;

async function getState(): Promise<AppState> {
  const owner = await getAutomationOwner();
  return owner ? getWorkspaceState(owner) : getActiveState();
}

async function updateRuntimeState(mutator: (state: AppState) => AppState): Promise<AppState> {
  const owner = await getAutomationOwner();
  if (!owner) return updateActiveState(mutator);
  const saved = await updateWorkspaceState(owner, (state) => ({ ...state, ...mutator(state), workspaceId: owner }));
  return { workspaceId: saved.workspaceId, queue: saved.queue, session: saved.session, history: saved.history };
}

async function commitQueueMutation(mutator: (state: AppState) => AppState): Promise<AppState> {
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

async function broadcast(state?: AppState) {
  const snapshot = state ?? await getState();
  await chrome.runtime.sendMessage({ type: 'STATE_UPDATED', state: snapshot }).catch(() => undefined);
  await updateBadge(snapshot);
}

async function getRuntimeStatus(): Promise<RuntimeStatus> {
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

async function notifyEvent(title: string, message: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.notificationsEnabled || !chrome.notifications) return;
  const locale = await getStoredLocale();
  const titleKeys: Record<string, string> = {
    'X-Pilot: اكتملت الجلسة': 'notifications.sessionCompletedTitle',
    'X-Pilot: مطلوب تدخل': 'notifications.interventionTitle',
    'X-Pilot: فشل عنصر': 'notifications.failedItemTitle',
    'X-Pilot: جلسة مجدولة': 'notifications.scheduledTitle',
    'X-Pilot: بدأت الجلسة': 'notifications.startedTitle',
    'X-Pilot: تحدٍ أمني': 'notifications.challenge',
    'X-Pilot: خارج نافذة النشر': 'notifications.outsideWindow',
    'X-Pilot: فشل فحص الجاهزية': 'notifications.preflightFailed',
    'X-Pilot: توقفت Queue مؤقتًا': 'notifications.paused',
  };
  const messageKeys: Record<string, string> = {
    'اكتملت جميع عناصر Queue.': 'notifications.sessionCompletedMessage',
    'تسجيل الدخول إلى X مطلوب.': 'notifications.loginRequired',
    'تم اكتشاف CAPTCHA أو Challenge وتوقفت الجلسة.': 'notifications.challenge',
  };
  const translatedTitle = titleKeys[title] ? translateForLocale(locale, titleKeys[title]) : title;
  let translatedMessage = messageKeys[message] ? translateForLocale(locale, messageKeys[message]) : message;
  translatedMessage = translatedMessage.replace(/سيستأنف النشر في (.+)$/u, (_, value) => `${translateForLocale(locale, 'notifications.outsideWindow')}: ${formatDateTimeForLocale(value, locale)}`);
  await chrome.notifications.create(`x-pilot-${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: translatedTitle, message: translatedMessage });
}

async function updateBadge(state?: AppState): Promise<void> {
  const settings = await getSettings();
  const snapshot = state ?? await getState();
  let text = '';
  if (settings.badgeMode === 'COUNT') text = String(snapshot.queue.filter((item) => item.status === 'PENDING' || item.status === 'FAILED').length || '');
  if (settings.badgeMode === 'STATUS') text = snapshot.session?.status === 'RUNNING' ? '▶' : snapshot.session?.status === 'PAUSED' ? 'Ⅱ' : snapshot.session?.status === 'FAILED' ? '!' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: snapshot.session?.status === 'FAILED' ? '#b42318' : '#175fbe' });
}

async function recoverPersistedState(): Promise<AppState> {
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

async function syncHistoricalSession(state: AppState, status?: 'RUNNING' | 'PAUSED' | 'WAITING' | 'COMPLETED' | 'STOPPED' | 'FAILED', failureReason?: string): Promise<void> {
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

async function getOrCreateAutomationTab(session: AutomationSession): Promise<number> {
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

async function waitForTabLoad(tabId: number, timeoutMs = 20000): Promise<void> {
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

async function getPreviousActiveTabId(tabId: number): Promise<number | undefined> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab?.id && activeTab.id !== tabId ? activeTab.id : undefined;
}

async function activateAutomationTab(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
}

async function restoreActiveTab(tabId: number | undefined): Promise<void> {
  if (tabId) await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
}

async function closeAutomationTabIfConfigured(session: AutomationSession): Promise<AppState> {
  const tabId = session.automationTabId;
  const shouldClose = Boolean(tabId && (session.closeTabOnComplete || !session.keepAutomationTabOpen));
  if (!tabId || !shouldClose) return getState();
  await chrome.tabs.remove(tabId).catch(() => undefined);
  await chrome.storage.local.remove(AUTOMATION_TAB_KEY);
  return updateRuntimeState((state) => state.session?.automationTabId === tabId
    ? { ...state, session: { ...state.session, automationTabId: undefined, updatedAt: Date.now() } }
    : state);
}

async function ensureContentScript(tabId: number): Promise<void> {
  if (injectedContentTabs.has(tabId)) return;
  const existing = contentInjectionInFlight.get(tabId);
  if (existing) return existing;
  const injection = chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    .then(() => { injectedContentTabs.add(tabId); })
    .finally(() => { contentInjectionInFlight.delete(tabId); });
  contentInjectionInFlight.set(tabId, injection);
  return injection;
}

async function inspectTab(tabId: number): Promise<ContentInspection> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'X_INSPECT' });
  } catch {
    await ensureContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, { type: 'X_INSPECT' });
  }
}

async function runDiagnostics(): Promise<DiagnosticsResult> {
  const checks: DiagnosticsCheck[] = [];
  const manifest = chrome.runtime.getManifest();
  const result: DiagnosticsResult = { checkedAt: Date.now(), extensionVersion: manifest.version, schemaVersion: 'UNKNOWN', checks, safe: true };
  let state: AppState | undefined;
  try {
    const meta = await getMeta();
    state = await getState();
    result.schemaVersion = meta.schemaVersion;
    result.activeWorkspaceId = meta.activeWorkspaceId;
    result.automationWorkspaceId = meta.automationWorkspaceId;
    if (state.session) result.runningSession = { id: state.session.id, status: state.session.status, currentItemId: state.session.currentItemId };
    checks.push({ id: 'storage', label: 'Storage', status: 'OK', message: 'Storage: OK', details: `schemaVersion ${meta.schemaVersion}` });
    checks.push({ id: 'active-workspace', label: 'Active Workspace', status: meta.activeWorkspaceId ? 'OK' : 'FAIL', message: meta.activeWorkspaceId ? 'Active Workspace: OK' : 'Active Workspace: FAIL', details: meta.activeWorkspaceId || 'لا توجد Workspace نشطة' });
    checks.push({ id: 'automation-workspace', label: 'Automation Workspace', status: meta.automationWorkspaceId ? 'OK' : 'WARN', message: meta.automationWorkspaceId ? 'Automation Workspace: OK' : 'Automation Workspace: غير مستخدمة', details: meta.automationWorkspaceId });
    checks.push({ id: 'running-session', label: 'Running Session', status: state.session && ['RUNNING', 'WAITING', 'PAUSED', 'SCHEDULED'].includes(state.session.status) ? 'OK' : 'WARN', message: state.session ? `Running Session: ${state.session.status}` : 'Running Session: لا توجد جلسة نشطة', details: state.session?.id });
  } catch (error) {
    checks.push({ id: 'storage', label: 'Storage', status: 'FAIL', message: 'Storage: FAIL', details: error instanceof Error ? error.message : 'STORAGE_READ_FAILED' });
  }
  try {
    const alarms = await chrome.alarms.getAll();
    const expected = state?.session?.status === 'SCHEDULED' ? SCHEDULE_ALARM_NAME : ALARM_NAME;
    const alarm = alarms.find((candidate) => candidate.name === expected);
    if (alarm) { result.alarm = { name: alarm.name, scheduledTime: alarm.scheduledTime, periodInMinutes: alarm.periodInMinutes }; checks.push({ id: 'alarm', label: 'Alarm', status: 'OK', message: 'Alarm: OK', details: alarm.name }); }
    else checks.push({ id: 'alarm', label: 'Alarm', status: state?.session && ['RUNNING', 'WAITING', 'SCHEDULED'].includes(state.session.status) ? 'WARN' : 'OK', message: state?.session && ['RUNNING', 'WAITING', 'SCHEDULED'].includes(state.session.status) ? 'Alarm: WARN' : 'Alarm: OK', details: 'لا يوجد Alarm مطلوب حاليًا' });
  } catch (error) { checks.push({ id: 'alarm', label: 'Alarm', status: 'FAIL', message: 'Alarm: FAIL', details: error instanceof Error ? error.message : 'ALARM_READ_FAILED' }); }
  let temporaryTabId: number | undefined;
  try {
    let tabId = state?.session?.automationTabId;
    if (tabId) { try { await chrome.tabs.get(tabId); } catch { tabId = undefined; } }
    if (!tabId) {
      const xTabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
      tabId = xTabs[0]?.id;
    }
    if (!tabId) {
      const temporary = await chrome.tabs.create({ url: 'https://x.com/home', active: false });
      if (!temporary.id) throw new Error('DIAGNOSTICS_TAB_CREATE_FAILED');
      temporaryTabId = temporary.id; tabId = temporary.id;
      await waitForTabLoad(tabId);
    }
    result.automationTabId = state?.session?.automationTabId;
    const inspected = await inspectTab(tabId);
    checks.push({ id: 'x-session', label: 'X Login', status: inspected.pageKind === 'X' ? 'OK' : inspected.pageKind === 'LOGIN' ? 'FAIL' : 'WARN', message: inspected.pageKind === 'X' ? 'X Session: OK' : `X Session: ${inspected.pageKind}`, details: inspected.reason });
    checks.push({ id: 'adapter', label: 'Adapter status', status: inspected.ok ? 'OK' : 'WARN', message: inspected.ok ? 'Adapter status: OK' : 'Adapter status: WARN', details: inspected.reason });
    checks.push({ id: 'composer', label: 'Composer detection', status: inspected.composerFound ? 'OK' : 'WARN', message: inspected.composerFound ? 'Composer detection: OK' : 'Composer detection: WARN' });
    checks.push({ id: 'post-button', label: 'Post Button detection', status: inspected.postButtonFound && inspected.postButtonEnabled ? 'OK' : 'WARN', message: inspected.postButtonFound && inspected.postButtonEnabled ? 'Post Button detection: OK' : 'Post Button detection: WARN' });
  } catch (error) {
    for (const [id, label] of [['x-session', 'X Login'], ['adapter', 'Adapter status'], ['composer', 'Composer detection'], ['post-button', 'Post Button detection']] as const) checks.push({ id, label, status: 'NOT_CHECKED', message: `${label}: NOT_CHECKED`, details: error instanceof Error ? error.message : 'DIAGNOSTICS_INSPECTION_FAILED' });
  } finally {
    if (temporaryTabId !== undefined) await chrome.tabs.remove(temporaryTabId).catch(() => undefined);
  }
  try {
    const permissions = await chrome.permissions.getAll();
    const hasXOrigin = permissions.origins?.some((origin) => origin === 'https://x.com/*' || origin === 'https://twitter.com/*') || false;
    const hasCore = ['storage', 'alarms', 'tabs', 'scripting'].every((permission) => permissions.permissions?.includes(permission as chrome.runtime.ManifestPermission));
    checks.push({ id: 'permissions', label: 'Permissions', status: hasCore && hasXOrigin ? 'OK' : 'WARN', message: hasCore && hasXOrigin ? 'Permissions: OK' : 'Permissions: WARN', details: `core=${hasCore} x=${hasXOrigin}` });
  } catch (error) { checks.push({ id: 'permissions', label: 'Permissions', status: 'FAIL', message: 'Permissions: FAIL', details: error instanceof Error ? error.message : 'PERMISSIONS_READ_FAILED' }); }
  const automationTabId = state?.session?.automationTabId;
  if (automationTabId) {
    try { await chrome.tabs.get(automationTabId); checks.push({ id: 'automation-tab', label: 'Automation Tab', status: 'OK', message: 'Automation Tab: OK', details: String(automationTabId) }); }
    catch { checks.push({ id: 'automation-tab', label: 'Automation Tab', status: 'WARN', message: 'Automation Tab: WARN', details: 'التبويب المسجل غير موجود' }); }
  } else checks.push({ id: 'automation-tab', label: 'Automation Tab', status: 'WARN', message: 'Automation Tab: غير موجود', details: 'لا توجد جلسة أتمتة نشطة' });
  return result;
}

function classifyDryRunInspection(inspection: ContentInspection): DryRunItemResult['status'] {
  if (inspection.pageKind === 'LOGIN') return 'LOGIN_REQUIRED';
  if (inspection.pageKind === 'CHALLENGE') return 'CHALLENGE_DETECTED';
  if (!inspection.contentPresent) return 'CONTENT_MISSING';
  if (!inspection.composerFound || !inspection.postButtonFound || !inspection.postButtonEnabled) return 'POST_BUTTON_NOT_FOUND';
  return 'READY';
}

async function saveDryRun(result: DryRunResult): Promise<DryRunResult> {
  await chrome.storage.local.set({ [DRY_RUN_KEY]: result });
  await broadcast();
  return result;
}

async function runDryRun(mode: 'FIRST_ITEM' | 'ENTIRE_QUEUE', workspaceId?: string): Promise<DryRunResult> {
  const state = await (workspaceId ? getWorkspaceState(workspaceId) : getState());
  const selected = state.queue.filter((item) => item.status === 'PENDING' || item.status === 'FAILED').slice(0, mode === 'FIRST_ITEM' ? 1 : undefined);
  const result: DryRunResult = { id: crypto.randomUUID(), workspaceId: state.workspaceId, mode, status: 'RUNNING', startedAt: Date.now(), total: selected.length, checked: 0, ready: 0, failed: 0, items: [] };
  dryRunStopRequested = false;
  await saveDryRun(result);
  let tabId: number | undefined;
  let previousActiveTabId: number | undefined;
  let temporaryTab = false;
  try {
    if (!selected.length) return saveDryRun({ ...result, status: 'COMPLETED', completedAt: Date.now() });
    if (state.session) {
      tabId = await getOrCreateAutomationTab(state.session);
    } else {
      const temporary = await chrome.tabs.create({ url: 'about:blank', active: false });
      if (!temporary.id) throw new Error('DRY_RUN_TAB_CREATE_FAILED');
      tabId = temporary.id;
      temporaryTab = true;
    }
    previousActiveTabId = await getPreviousActiveTabId(tabId);
    for (const item of selected) {
      if (dryRunStopRequested) break;
      const started = Date.now();
      let itemResult: DryRunItemResult;
      try {
        const parsed = new URL(item.targetUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || !/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(parsed.hostname)) throw new Error('INVALID_URL');
        await chrome.tabs.update(tabId, { url: item.targetUrl, active: false });
        await waitForTabLoad(tabId);
        await activateAutomationTab(tabId);
        await wait(300);
        const inspection = await inspectTab(tabId);
        itemResult = { queueItemId: item.id, position: item.position, targetUrl: item.targetUrl, status: classifyDryRunInspection(inspection), checkedAt: Date.now(), durationMs: Date.now() - started, pageKind: inspection.pageKind, composerFound: inspection.composerFound, contentPresent: inspection.contentPresent, postButtonFound: inspection.postButtonFound, postButtonEnabled: inspection.postButtonEnabled, reason: inspection.reason };
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
        itemResult = { queueItemId: item.id, position: item.position, targetUrl: item.targetUrl, status: reason === 'INVALID_URL' ? 'INVALID_URL' : 'ERROR', checkedAt: Date.now(), durationMs: Date.now() - started, pageKind: 'ERROR', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason, error: reason };
      }
      result.items.push(itemResult);
      result.checked = result.items.length;
      result.ready = result.items.filter((entry) => entry.status === 'READY').length;
      result.failed = result.checked - result.ready;
      result.currentItemId = item.id;
      await saveDryRun({ ...result });
    }
    return saveDryRun({ ...result, status: dryRunStopRequested ? 'STOPPED' : 'COMPLETED', completedAt: Date.now(), currentItemId: undefined });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'DRY_RUN_FAILED';
    return saveDryRun({ ...result, status: 'FAILED', error: reason, completedAt: Date.now(), currentItemId: undefined });
  } finally {
    await restoreActiveTab(previousActiveTabId);
    if (temporaryTab && tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

async function waitForPublishReady(tabId: number, timeoutMs = 25000, intervalMs = 500): Promise<ContentInspection> {
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
  const profile = await getWorkspaceSettings(state.workspaceId ?? session.workspaceId ?? (await getMeta()).activeWorkspaceId);
  const allowedAt = getNextAllowedPublishingTime(Date.now(), profile.timezone, profile.publishingWindows);
  if (allowedAt && allowedAt > Date.now() + 500) {
    const waiting = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'WAITING', nextRunAt: allowedAt, updatedAt: Date.now() } : null }));
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, { when: allowedAt, persistAcrossSessions: true });
    await notifyEvent('X-Pilot: خارج نافذة النشر', `سيستأنف النشر في ${new Date(allowedAt).toLocaleString()}`);
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
      history: [...current.history, { id: crypto.randomUUID(), workspaceId: current.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, publishedPostUrl, timestamp: finishedAt, attemptNumber: item.attempts + 1, action: 'PUBLISH', result: finalStatus }]
    }));
    await syncHistoricalSession(nextState, nextStatus === 'COMPLETED' ? 'COMPLETED' : 'WAITING');
    await chrome.alarms.clear(ALARM_NAME);
    if (nextRunAt) await chrome.alarms.create(ALARM_NAME, { when: nextRunAt, persistAcrossSessions: true });
    await restoreActiveTab(previousActiveTabId);
    const visibleState = nextStatus === 'COMPLETED' && nextState.session
      ? await closeAutomationTabIfConfigured(nextState.session)
      : nextState;
    if (nextStatus === 'COMPLETED' && nextState.workspaceId) await releaseAutomationOwner(nextState.workspaceId);
    if (nextStatus === 'COMPLETED') await notifyEvent('X-Pilot: اكتملت الجلسة', 'اكتملت جميع عناصر Queue.');
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
        history: [...currentState.history, { id: crypto.randomUUID(), workspaceId: currentState.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, timestamp: Date.now(), attemptNumber: item.attempts, action: 'PUBLISH', result: 'PAUSED', error: message }]
      }));
      await syncHistoricalSession(pausedState, 'PAUSED', message);
      await chrome.alarms.clear(ALARM_NAME);
      await restoreActiveTab(previousActiveTabId);
      await notifyEvent('X-Pilot: تم إيقاف النشر', 'وصل حساب X إلى الحد الأقصى للمنشورات اليومية. لم يتم الانتقال إلى العنصر التالي.');
      await broadcast(pausedState);
      return;
    }
    if (message.includes('LOGIN') || message.includes('PUBLISH_CONTROLS_NOT_READY')) await notifyEvent('X-Pilot: مطلوب تدخل', message.includes('LOGIN') ? 'تسجيل الدخول إلى X مطلوب.' : 'تعذر العثور على عناصر النشر.');
    if (message.includes('CHALLENGE') || message.includes('CAPTCHA')) await notifyEvent('X-Pilot: تحدٍ أمني', 'تم اكتشاف CAPTCHA أو Challenge وتوقفت الجلسة.');
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
        history: [...currentState.history, { id: crypto.randomUUID(), workspaceId: currentState.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, timestamp: uncertainAt, attemptNumber: item.attempts, action: 'PUBLISH', result: 'PUBLISHED_UNVERIFIED', error: 'PUBLISH_OUTCOME_UNVERIFIED' }]
      }));
      await syncHistoricalSession(uncertain, 'PAUSED', 'PUBLISH_OUTCOME_UNVERIFIED');
      await chrome.alarms.clear(ALARM_NAME);
      await restoreActiveTab(previousActiveTabId);
      await notifyEvent('X-Pilot: مطلوب تدخل', 'نتيجة النشر غير مؤكدة. تم إيقاف الجلسة لمنع إعادة النشر.');
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
      history: [...currentState.history, { id: crypto.randomUUID(), workspaceId: currentState.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, timestamp: Date.now(), attemptNumber: item.attempts + 1, action: 'PUBLISH', result: failedStatus, error: message }]
    }));
    await syncHistoricalSession(failedState, nextStatus === 'COMPLETED' ? 'COMPLETED' : nextStatus === 'PAUSED' ? 'PAUSED' : 'WAITING', message);
    await chrome.alarms.clear(ALARM_NAME);
    if (nextRunAt) await chrome.alarms.create(ALARM_NAME, { when: nextRunAt, persistAcrossSessions: true });
    await restoreActiveTab(previousActiveTabId);
    const visibleState = nextStatus === 'COMPLETED' && failedState.session
      ? await closeAutomationTabIfConfigured(failedState.session)
      : failedState;
    if (nextStatus === 'COMPLETED' && failedState.workspaceId) await releaseAutomationOwner(failedState.workspaceId);
    if (failedStatus === 'FAILED') await notifyEvent('X-Pilot: فشل عنصر', `فشل Item #${item.position}: ${message}`);
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

async function extractBank(bankUrl: string, workspaceId: string, mode: 'REPLACE' | 'APPEND' = 'REPLACE', bankId?: string): Promise<AppState> {
  let bankTabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: bankUrl, active: false });
    bankTabId = tab.id;
    if (!bankTabId) throw new Error('BANK_TAB_CREATE_FAILED');
    await waitForTabLoad(bankTabId);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: bankTabId }, func: () => ({
      anchors: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((a) => ({ raw: a.href, label: a.textContent?.trim() || undefined })),
      markup: document.documentElement.outerHTML
    }) });
    const extraction = extractLinksFromValues([
      ...((result as { anchors?: Array<{ raw: string; label?: string }> } | undefined)?.anchors ?? []),
      { raw: (result as { markup?: string } | undefined)?.markup ?? '' }
    ]);
    const extractedQueue: QueueItem[] = [];
    for (const extracted of extraction.links) {
      extractedQueue.push({ id: crypto.randomUUID(), workspaceId, sourceBankId: bankId, sourceBankUrl: bankUrl, targetUrl: extracted.url, label: extracted.label, position: extractedQueue.length + 1, status: 'PENDING', attempts: 0, createdAt: Date.now(), updatedAt: Date.now() });
    }
    const next = await updateWorkspaceState(workspaceId, (state) => {
      if (mode === 'REPLACE' && state.session && ['RUNNING', 'WAITING', 'PAUSED'].includes(state.session.status)) throw new Error('QUEUE_REPLACE_WHILE_ACTIVE');
      if (mode === 'REPLACE' && state.queue.some((item) => ['PUBLISHED', 'PUBLISHED_UNVERIFIED'].includes(item.status))) throw new Error('QUEUE_REPLACE_HAS_EXECUTED_ITEMS');
      const existingUrls = new Set(state.queue.map((item) => item.targetUrl));
      const queue = mode === 'APPEND'
        ? [...state.queue, ...extractedQueue.filter((item) => !existingUrls.has(item.targetUrl))].map((item, index) => ({ ...item, position: index + 1 }))
        : extractedQueue;
      const now = Date.now();
      const oldBank = state.banks.find((candidate) => candidate.id === bankId) ?? state.banks.find((candidate) => candidate.url === bankUrl);
      const bank = { id: oldBank?.id ?? bankId ?? crypto.randomUUID(), workspaceId, name: oldBank?.name ?? new URL(bankUrl).hostname, description: oldBank?.description, url: bankUrl, favorite: oldBank?.favorite ?? false, archived: oldBank?.archived ?? false, createdAt: oldBank?.createdAt ?? now, updatedAt: now, lastExtractedAt: now, lastExtractedCount: extractedQueue.length };
      const banks = [...state.banks.filter((candidate) => candidate.id !== bank.id && candidate.url !== bankUrl), bank];
      const session = mode === 'APPEND' && state.session
        ? { ...state.session, total: queue.length, updatedAt: now }
        : { ...(state.session ?? {}), workspaceId, bankId: bank.id, id: crypto.randomUUID(), bankUrl, status: 'IDLE' as const, currentIndex: 0, total: queue.length, intervalMinutes: defaultSettings.intervalMinutes, maxRetries: defaultSettings.maxRetries, failureBehavior: defaultSettings.failureBehavior, confirmBeforeStart: defaultSettings.confirmBeforeStart, keepAutomationTabOpen: defaultSettings.keepAutomationTabOpen, closeTabOnComplete: defaultSettings.closeTabOnComplete, version: 1, updatedAt: now };
      return { ...state, queue, banks, session };
    });
    const nextState: AppState = { workspaceId: next.workspaceId, queue: next.queue, session: next.session, history: next.history };
    await broadcast(nextState);
    console.info('Extracted bank', { total: next.queue.length, duplicateCount: extraction.duplicateCount, invalidCount: extraction.invalidCount, mode });
    return nextState;
  } finally {
    if (bankTabId) await chrome.tabs.remove(bankTabId).catch(() => undefined);
  }
}

async function refreshBank(workspaceId: string, bankId: string): Promise<BankDiffResult> {
  const state = await getWorkspaceState(workspaceId);
  const bank = state.banks.find((candidate) => candidate.id === bankId);
  if (!bank || bank.archived) throw new Error('BANK_NOT_FOUND_OR_ARCHIVED');
  let bankTabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: bank.url, active: false });
    bankTabId = tab.id;
    if (!bankTabId) throw new Error('BANK_TAB_CREATE_FAILED');
    await waitForTabLoad(bankTabId);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: bankTabId }, func: () => ({
      anchors: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((a) => ({ raw: a.href, label: a.textContent?.trim() || undefined })),
      markup: document.documentElement.outerHTML,
    }) });
    const extraction = extractLinksFromValues([
      ...((result as { anchors?: Array<{ raw: string; label?: string }> } | undefined)?.anchors ?? []),
      { raw: (result as { markup?: string } | undefined)?.markup ?? '' },
    ]);
    const snapshot: BankSnapshotItem[] = [];
    for (const item of [...extraction.links, ...extraction.invalidLinks]) {
      const fingerprint = await fingerprintTweet(item.url, item.label);
      snapshot.push({ url: item.url, label: item.label, contentFingerprint: fingerprint?.fingerprint, normalizedContent: fingerprint?.content });
    }
    const fingerprintIndex = new Map<string, { item: QueueItem; workspaceId: string }>();
    for (const workspace of await listWorkspaces(true)) {
      const candidateState = await getWorkspaceState(workspace.id);
      for (const item of candidateState.queue) {
        const fingerprint = item.contentFingerprint ? { fingerprint: item.contentFingerprint } : await fingerprintTweet(item.targetUrl, item.label);
        if (fingerprint) fingerprintIndex.set(fingerprint.fingerprint, { item, workspaceId: workspace.id });
      }
    }
    const settings = await getSettings();
    const diff = classifyBankDiff(workspaceId, bank, snapshot, state.queue, Date.now(), fingerprintIndex, settings.duplicatePolicy);
    bankDiffs.set(`${workspaceId}:${bankId}`, diff);
    await updateWorkspaceState(workspaceId, (current) => ({ ...current, banks: current.banks.map((item) => item.id === bankId ? { ...item, lastSnapshot: snapshot, lastSnapshotAt: diff.refreshedAt, lastExtractedAt: diff.refreshedAt, lastExtractedCount: snapshot.length, updatedAt: diff.refreshedAt } : item) }));
    return diff;
  } finally {
    if (bankTabId) await chrome.tabs.remove(bankTabId).catch(() => undefined);
  }
}

async function performPreflight(workspaceId: string) {
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

async function scheduleSession(workspaceId: string, startAt: number): Promise<AppState> {
  if (!Number.isFinite(startAt) || startAt <= Date.now()) throw new Error('SCHEDULE_START_MUST_BE_IN_FUTURE');
  const preflight = await performPreflight(workspaceId);
  if (!preflight.ready) { await notifyEvent('X-Pilot: فشل فحص الجاهزية', preflight.summaryKey); throw new Error(`PREFLIGHT_FAILED:${preflight.summaryKey}`); }
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
  await notifyEvent('X-Pilot: جلسة مجدولة', `ستبدأ الجلسة في ${new Date(startAt).toLocaleString()}`);
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
    await notifyEvent('X-Pilot: فشل بدء الجدولة', 'لا يوجد عنصر Queue قابل للتشغيل عند موعد الجدولة.');
    await broadcast(failed);
    return;
  }
  const running = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'RUNNING', startedAt: Date.now(), scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : null }));
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  await notifyEvent('X-Pilot: بدأت الجلسة', 'بدأت جلسة النشر المجدولة.');
  let ready = running;
  if (running.workspaceId && running.session && !running.session.historicalSessionId) {
    const historical = createHistoricalSession(running.session, running.queue);
    await saveHistoricalSession(running.workspaceId, historical);
    ready = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, historicalSessionId: historical.id, updatedAt: Date.now() } : null }));
  }
  await broadcast(ready);
  await processCurrentItem();
}

async function executeBulkAction(workspaceId: string, action: BulkQueueAction, itemIds: string[], confirmed = false, bankId?: string): Promise<BulkActionResult & { state?: AppState }> {
  const state = await getWorkspaceState(workspaceId);
  const requestedIds = [...new Set(itemIds)];
  const selected = state.queue.filter((item) => requestedIds.includes(item.id));
  const activeItemId = state.session && ['RUNNING', 'WAITING', 'PAUSED'].includes(state.session.status) ? state.session.currentItemId : undefined;
  if (activeItemId && requestedIds.includes(activeItemId) && !confirmed) throw new Error(`BULK_ACTIVE_ITEM_CONFIRMATION_REQUIRED:${activeItemId}`);
  const active = selected.find((item) => item.id === activeItemId);
  if (active?.status === 'PUBLISHING') throw new Error('BULK_ACTIVE_ITEM_BUSY');
  if (action === 'ASSIGN_BANK') {
    const bank = state.banks.find((candidate) => candidate.id === bankId && !candidate.archived);
    if (!bank) throw new Error('BULK_BANK_NOT_FOUND_OR_ARCHIVED');
  }
  if (action === 'EXPORT') return { action, requestedIds, affectedIds: selected.map((item) => item.id), rejectedIds: requestedIds.filter((id) => !selected.some((item) => item.id === id)), exportedItems: selected };
  const selectedIds = selected.map((item) => item.id);
  let nextQueue: QueueItem[];
  if (action === 'DELETE') nextQueue = state.queue.filter((item) => !selectedIds.includes(item.id));
  else if (action === 'MOVE_TOP') nextQueue = reorderSelected(state.queue, selectedIds, 'TOP');
  else if (action === 'MOVE_BOTTOM') nextQueue = reorderSelected(state.queue, selectedIds, 'BOTTOM');
  else if (action === 'ASSIGN_BANK') {
    const bank = state.banks.find((candidate) => candidate.id === bankId)!;
    nextQueue = state.queue.map((item) => selectedIds.includes(item.id) ? { ...item, sourceBankId: bank.id, sourceBankUrl: bank.url, updatedAt: Date.now() } : item);
  } else nextQueue = applyBulkStatus(state.queue, selectedIds, action);
  nextQueue = nextQueue.map((item, index) => ({ ...item, position: index + 1 }));
  const saved = await updateWorkspaceState(workspaceId, (current) => ({ ...current, queue: nextQueue, session: current.session ? { ...current.session, total: nextQueue.length, currentIndex: nextQueue.find((item) => item.id === current.session?.currentItemId)?.position ?? current.session.currentIndex, updatedAt: Date.now() } : current.session }));
  const result: BulkActionResult & { state?: AppState } = { action, requestedIds, affectedIds: selectedIds, rejectedIds: requestedIds.filter((id) => !selectedIds.includes(id)), activeItemId, state: { workspaceId: saved.workspaceId, queue: saved.queue, session: saved.session, history: saved.history } };
  await broadcast(result.state);
  return result;
}

async function handleMessage(message: RuntimeMessage): Promise<unknown> {
  switch (message.type) {
    case 'GET_STATE': return getActiveState();
    case 'GET_WORKSPACES': return { workspaces: await listWorkspaces(true), meta: await getMeta() };
    case 'GET_WORKSPACE_STATE': return getWorkspaceState(message.workspaceId ?? (await getMeta()).activeWorkspaceId);
    case 'GET_BANKS': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      return { workspaceId, banks: await listBanks(workspaceId, true) };
    }
    case 'GET_BANK_DIFF': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      return bankDiffs.get(`${workspaceId}:${message.bankId}`) ?? null;
    }
    case 'CREATE_BANK': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      await createBank(workspaceId, message.name, message.url, message.description); return getWorkspaceState(workspaceId);
    }
    case 'UPDATE_BANK': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      await updateBank(workspaceId, message.bankId, message.patch); return getWorkspaceState(workspaceId);
    }
    case 'ARCHIVE_BANK': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      await archiveBank(workspaceId, message.bankId); return getWorkspaceState(workspaceId);
    }
    case 'RESTORE_BANK': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      await restoreBank(workspaceId, message.bankId); return getWorkspaceState(workspaceId);
    }
    case 'DELETE_BANK': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      await deleteBank(workspaceId, message.bankId, message.confirmed); return getWorkspaceState(workspaceId);
    }
    case 'EXPORT_BANKS': {
      const meta = await getMeta();
      const workspaceId = message.workspaceId ?? meta.activeWorkspaceId;
      const state = await getWorkspaceState(workspaceId);
      const requestedIds = [...new Set(message.bankIds)];
      const banks = state.banks.filter((bank) => requestedIds.includes(bank.id));
      if (!banks.length) throw new Error('BANK_EXPORT_NOT_FOUND');
      const appVersion = chrome.runtime?.getManifest?.().version ?? '0.0.0';
      return banks.length === 1 ? buildBankExport(banks[0], appVersion) : buildBanksExport(banks, appVersion);
    }
    case 'IMPORT_BANKS': {
      const meta = await getMeta();
      const workspaceId = message.workspaceId ?? meta.activeWorkspaceId;
      const imported = parseBankImport(message.payload);
      const saved = await importBanks(workspaceId, imported);
      const refreshed = await getWorkspaceState(workspaceId);
      await broadcast({ workspaceId: refreshed.workspaceId, queue: refreshed.queue, session: refreshed.session, history: refreshed.history });
      return { workspaceId, importedCount: saved.length, importedNames: saved.map((bank) => bank.name) };
    }
    case 'GET_SESSION_HISTORY': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      return { workspaceId, sessions: await getHistoricalSessions(workspaceId) };
    }
    case 'PREFLIGHT_CHECK': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      return performPreflight(workspaceId);
    }
    case 'RUN_DIAGNOSTICS': return runDiagnostics();
    case 'GET_DRY_RUN': {
      const stored = await chrome.storage.local.get(DRY_RUN_KEY);
      return stored[DRY_RUN_KEY] ?? null;
    }
    case 'EXPORT_BACKUP':
      return exportBackup();
    case 'VALIDATE_BACKUP':
      return validateBackup(message.backup);
    case 'RESTORE_BACKUP': {
      const current = await getState();
      if (current.session && ['RUNNING', 'WAITING', 'PAUSED'].includes(current.session.status)) throw new Error('BACKUP_RESTORE_WHILE_AUTOMATION_ACTIVE');
      const summary = await restoreBackup(message.backup, message.confirmed);
      const restored = await getState();
      await broadcast(restored);
      return { ...restored, backupSummary: summary };
    }
    case 'DRY_RUN_STOP':
      dryRunStopRequested = true;
      return chrome.storage.local.get(DRY_RUN_KEY).then((stored) => stored[DRY_RUN_KEY] ?? null);
    case 'DRY_RUN_FIRST':
      return runDryRun('FIRST_ITEM', message.workspaceId ?? (await getMeta()).activeWorkspaceId);
    case 'DRY_RUN_QUEUE':
      return runDryRun('ENTIRE_QUEUE', message.workspaceId ?? (await getMeta()).activeWorkspaceId);
    case 'CREATE_WORKSPACE': return createWorkspace(message.name, message.description, message.color, message.icon);
    case 'UPDATE_WORKSPACE_PROFILE': return updateWorkspaceProfile(message.workspaceId, message.profile);
    case 'CLEAR_WORKSPACE_PROFILE': return clearWorkspaceProfile(message.workspaceId);
    case 'UPDATE_WORKSPACE': return updateWorkspace(message.workspaceId, message.patch);
    case 'ARCHIVE_WORKSPACE': return archiveWorkspace(message.workspaceId);
    case 'RESTORE_WORKSPACE': return restoreWorkspace(message.workspaceId);
    case 'DELETE_WORKSPACE': return deleteWorkspace(message.workspaceId, message.confirmed);
    case 'SET_ACTIVE_WORKSPACE': return setActiveWorkspace(message.workspaceId);
    case 'GET_RUNTIME_STATUS': return getRuntimeStatus();
    case 'EXTRACT_BANK': {
      const meta = await getMeta();
      const workspaceId = message.workspaceId ?? meta.activeWorkspaceId;
      if (meta.automationWorkspaceId && meta.automationWorkspaceId !== workspaceId) throw new Error('AUTOMATION_OWNED_BY_OTHER_WORKSPACE');
      const bank = message.bankId ? (await getWorkspaceState(workspaceId)).banks.find((candidate) => candidate.id === message.bankId) : undefined;
      if (message.bankId && (!bank || bank.archived)) throw new Error('BANK_NOT_FOUND_OR_ARCHIVED');
      return extractBank(bank?.url ?? message.bankUrl, workspaceId, message.mode ?? 'REPLACE', message.bankId);
    }
    case 'REFRESH_BANK': {
      const meta = await getMeta();
      const workspaceId = message.workspaceId ?? meta.activeWorkspaceId;
      if (meta.automationWorkspaceId && meta.automationWorkspaceId !== workspaceId) throw new Error('AUTOMATION_OWNED_BY_OTHER_WORKSPACE');
      return refreshBank(workspaceId, message.bankId);
    }
    case 'ADD_DIFF_ITEMS': {
      const meta = await getMeta();
      const workspaceId = message.workspaceId ?? meta.activeWorkspaceId;
      const diff = bankDiffs.get(`${workspaceId}:${message.bankId}`);
      if (!diff) throw new Error('BANK_DIFF_NOT_FOUND');
      const workspaceState = await getWorkspaceState(workspaceId);
      const bank = workspaceState.banks.find((candidate) => candidate.id === message.bankId);
      if (!bank) throw new Error('BANK_NOT_FOUND');
      const queue = mergeSelectedDiffItems(workspaceState.queue, diff, bank, message.itemIds, Date.now(), (await getSettings()).duplicatePolicy);
      const saved = await updateWorkspaceState(workspaceId, (current) => ({ ...current, queue, session: current.session ? { ...current.session, total: queue.length, updatedAt: Date.now() } : current.session }));
      bankDiffs.delete(`${workspaceId}:${message.bankId}`);
      const nextState: AppState = { workspaceId: saved.workspaceId, queue: saved.queue, session: saved.session, history: saved.history };
      await broadcast(nextState);
      return nextState;
    }
    case 'DISCARD_BANK_DIFF': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      bankDiffs.delete(`${workspaceId}:${message.bankId}`);
      return { discarded: true };
    }
    case 'UPDATE_SETTINGS': {
      await saveSettings(message.settings);
      const updated = await updateRuntimeState((state) => ({ ...state, session: state.session ? { ...state.session, ...message.settings, updatedAt: Date.now() } : state.session }));
      await broadcast(updated);
      return updated;
    }
    case 'SCHEDULE': return scheduleSession(message.workspaceId ?? (await getMeta()).activeWorkspaceId, message.startAt);
    case 'RESCHEDULE': return scheduleSession(message.workspaceId ?? (await getMeta()).activeWorkspaceId, message.startAt);
    case 'CANCEL_SCHEDULE': {
      await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
      const cancelled = await updateRuntimeState((current) => ({ ...current, session: current.session?.status === 'SCHEDULED' ? { ...current.session, status: 'STOPPED', scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : current.session }));
      await releaseAutomationOwner(cancelled.workspaceId ?? (await getMeta()).activeWorkspaceId);
      await notifyEvent('X-Pilot: أُلغيت الجدولة', 'تم إلغاء جلسة النشر المجدولة.');
      await broadcast(cancelled);
      return cancelled;
    }
    case 'START': {
      const meta = await getMeta();
      const workspaceId = message.workspaceId ?? meta.activeWorkspaceId;
      const startToken = await acquireStartLock(workspaceId);
      const leaseHeartbeat = setInterval(() => { void renewStartLock(startToken).then((healthy) => { if (!healthy) console.error('X-Pilot START lease lost', { workspaceId }); }).catch((error) => console.error('X-Pilot START lease renewal failed', error)); }, 5_000);
      try {
        const existing = await getWorkspaceState(workspaceId);
        if (existing.session && ['RUNNING', 'WAITING', 'PAUSED', 'SCHEDULED'].includes(existing.session.status)) throw new Error('START_ALREADY_ACTIVE');
        const preflight = await performPreflight(workspaceId);
        if (!preflight.ready) { await notifyEvent('X-Pilot: فشل فحص الجاهزية', preflight.summaryKey); throw new Error(`PREFLIGHT_FAILED:${preflight.summaryKey}`); }
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
    case 'PAUSE': {
      await chrome.alarms.clear(ALARM_NAME);
      const paused = await updateRuntimeState((state) => ({
        ...state,
        queue: state.queue.map((item) => item.id === state.session?.currentItemId && (item.status === 'OPENING' || item.status === 'READY') ? { ...item, status: 'PENDING', operationId: undefined, updatedAt: Date.now() } : item),
        session: state.session ? { ...state.session, status: 'PAUSED', pausedAt: Date.now(), nextRunAt: state.session.status === 'WAITING' ? state.session.nextRunAt : undefined, updatedAt: Date.now() } : null
      }));
      await syncHistoricalSession(paused, 'PAUSED');
      await notifyEvent('X-Pilot: توقفت Queue مؤقتًا', 'تم إيقاف Queue مؤقتًا.');
      await broadcast(paused);
      return paused;
    }
    case 'RESUME': {
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
    case 'STOP': {
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
    case 'SKIP_CURRENT': return commitQueueMutation((state) => ({ ...state, queue: state.queue.map((item) => item.id === state.session?.currentItemId ? { ...item, status: 'SKIPPED', updatedAt: Date.now() } : item) }));
    case 'RETRY_ITEM': return commitQueueMutation((state) => ({ ...state, queue: state.queue.map((item) => item.id === message.itemId ? { ...item, status: 'PENDING', attempts: 0, lastError: undefined, publishedAt: undefined, publishIntentId: undefined, publishStartedAt: undefined, publishSubmittedAt: undefined, updatedAt: Date.now() } : item) }));
    case 'DELETE_ITEM': return commitQueueMutation((state) => ({ ...state, queue: state.queue.filter((item) => item.id !== message.itemId).map((item, index) => ({ ...item, position: index + 1 })) }));
    case 'CLEAR_COMPLETED': return commitQueueMutation((state) => ({ ...state, queue: state.queue.filter((item) => !isTerminalItem(item.status)).map((item, index) => ({ ...item, position: index + 1 })) }));
    case 'BULK_ACTION': return executeBulkAction(message.workspaceId ?? (await getMeta()).activeWorkspaceId, message.action, message.itemIds, message.confirmed, message.bankId);
    case 'REORDER': return commitQueueMutation((state) => { const index = state.queue.findIndex((item) => item.id === message.itemId); const target = message.direction === 'up' ? index - 1 : index + 1; if (index < 0 || target < 0 || target >= state.queue.length) return state; const queue = [...state.queue]; [queue[index], queue[target]] = [queue[target], queue[index]]; return { ...state, queue: queue.map((item, position) => ({ ...item, position: position + 1 })) }; });
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => { handleMessage(message).then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : 'UNKNOWN_ERROR' })); return true; });
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
      await notifyEvent('X-Pilot: فشل مؤقت', `فشل Alarm وسيُعاد المحاولة (${decision.failureCount}/3).`);
      await broadcast(retried);
      return;
    }
    const failed = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'FAILED', nextRunAt: undefined, scheduledStartAt: undefined, alarmFailureCount: decision.failureCount, lastAlarmError: message, updatedAt: Date.now() } : null }));
    await chrome.alarms.clear(alarmName);
    if (failed.workspaceId) await releaseAutomationOwner(failed.workspaceId);
    await notifyEvent('X-Pilot: فشل الجدولة', 'تعذر تنفيذ Alarm بعد محاولات محدودة. راجع الجلسة ثم أعد التشغيل يدويًا.');
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

chrome.alarms.onAlarm.addListener((alarm) => { void handleAlarm(alarm).catch((error) => handleAlarmFailure(alarm.name, error)); });
chrome.runtime.onStartup.addListener(() => { void cleanupRestoreStaging().then(recoverPersistedState).catch((error) => console.error('X-Pilot startup recovery failed', error)); });
chrome.runtime.onInstalled.addListener(() => { void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); void cleanupRestoreStaging().then(recoverPersistedState).catch((error) => console.error('X-Pilot install recovery failed', error)); });
