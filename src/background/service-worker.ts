import type { AppState, BankDiffResult, BankSnapshotItem, BulkActionResult, BulkQueueAction, ContentInspection, DiagnosticsCheck, DiagnosticsResult, DryRunItemResult, DryRunResult, PublishAttempt, QueueItem, RuntimeMessage, RuntimeStatus } from '../domain/models';
import { classifyBankDiff, mergeSelectedDiffItems } from '../domain/bank-diff';
import { defaultSettings } from '../domain/models';
import { buildBankExport, buildBanksExport, parseBankImport } from '../domain/bank-transfer';
import { buildSessionHistoryExport } from '../domain/session-export';
import { fingerprintTweet } from '../domain/content-fingerprint';
import { isTerminalItem } from '../domain/state-machine';
import { extractLinksFromValues } from '../extraction/bank-parser';
import { applyBulkStatus, reorderSelected } from '../domain/bulk-queue';
import { activateAutomationTab, broadcast, cancelScheduledStart, commitQueueMutation, getOrCreateAutomationTab, getPreviousActiveTabId, getState, getRuntimeStatus, inspectTab, pauseSession, performPreflight, recoverPersistedState, restoreActiveTab, resumeSession, scheduleSession, startOverSession, startScheduledNow, startSession, stopSession, updateRuntimeState, wait, waitForTabLoad, ALARM_NAME, SCHEDULE_ALARM_NAME } from './automation-engine';
import { addAttempt, archiveBank, cleanupRestoreStaging, clearWorkspaceProfile, createBank, createWorkspace, deleteBank, deleteWorkspace, exportBackup, getHistoricalSessions, getMeta, getSettings, getState as getActiveState, getWorkspaceState, importBanks, listBanks, listWorkspaces, releaseAutomationOwner, restoreBackup, restoreBank, saveSettings, setActiveWorkspace, updateBank, updateWorkspace, updateWorkspaceProfile, updateWorkspaceState, archiveWorkspace, restoreWorkspace, validateBackup } from '../storage/storage-repository';

const bankDiffs = new Map<string, BankDiffResult>();
const DRY_RUN_KEY = 'xPilotDryRunResult';
let dryRunStopRequested = false;

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
    case 'EXPORT_SESSION_HISTORY': {
      const workspaceId = message.workspaceId ?? (await getMeta()).activeWorkspaceId;
      const [sessions, workspaceState] = await Promise.all([getHistoricalSessions(workspaceId), getWorkspaceState(workspaceId)]);
      return buildSessionHistoryExport({ workspaceId, sessions, attempts: workspaceState.history as PublishAttempt[] });
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
      return exportBackup(message.includeUiPreferences === true);
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
    case 'CANCEL_SCHEDULE': return cancelScheduledStart();
    case 'START': return startSession(message.workspaceId ?? (await getMeta()).activeWorkspaceId);
    case 'PAUSE': return pauseSession();
    case 'RESUME': return resumeSession();
    case 'STOP': return stopSession();
    case 'RECOVERY_START_OVER': return startOverSession();
    case 'START_SCHEDULED_NOW': return startScheduledNow();
    case 'SKIP_CURRENT': return commitQueueMutation((state) => ({ ...state, queue: state.queue.map((item) => item.id === state.session?.currentItemId ? { ...item, status: 'SKIPPED', updatedAt: Date.now() } : item) }));
    case 'RETRY_ITEM': return commitQueueMutation((state) => ({ ...state, queue: state.queue.map((item) => item.id === message.itemId ? { ...item, status: 'PENDING', attempts: 0, lastError: undefined, publishedAt: undefined, publishIntentId: undefined, publishStartedAt: undefined, publishSubmittedAt: undefined, updatedAt: Date.now() } : item) }));
    case 'DELETE_ITEM': return commitQueueMutation((state) => ({ ...state, queue: state.queue.filter((item) => item.id !== message.itemId).map((item, index) => ({ ...item, position: index + 1 })) }));
    case 'CLEAR_COMPLETED': return commitQueueMutation((state) => ({ ...state, queue: state.queue.filter((item) => !isTerminalItem(item.status)).map((item, index) => ({ ...item, position: index + 1 })) }));
    case 'BULK_ACTION': return executeBulkAction(message.workspaceId ?? (await getMeta()).activeWorkspaceId, message.action, message.itemIds, message.confirmed, message.bankId);
    case 'REORDER': return commitQueueMutation((state) => { const index = state.queue.findIndex((item) => item.id === message.itemId); const target = message.direction === 'up' ? index - 1 : index + 1; if (index < 0 || target < 0 || target >= state.queue.length) return state; const queue = [...state.queue]; [queue[index], queue[target]] = [queue[target], queue[index]]; return { ...state, queue: queue.map((item, position) => ({ ...item, position: position + 1 })) }; });
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => { handleMessage(message).then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : 'UNKNOWN_ERROR' })); return true; });
chrome.runtime.onStartup.addListener(() => { void cleanupRestoreStaging().then(recoverPersistedState).catch((error) => console.error('X-Pilot startup recovery failed', error)); });
chrome.runtime.onInstalled.addListener(() => { void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); void cleanupRestoreStaging().then(recoverPersistedState).catch((error) => console.error('X-Pilot install recovery failed', error)); });
