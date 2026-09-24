import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppMetaState, AppState, BankDiffItem, BankDiffResult, BackupEnvelope, BankImportOutcome, BulkQueueAction, DiagnosticsResult, DryRunResult, HistoricalSession, PreflightResult, PublishAttempt, QueueItem, RuntimeMessage, RuntimeStatus, Settings, TweetBank, Workspace, WorkspaceState } from '../domain/models';
import type { BankExportEnvelope, BankListExportEnvelope } from '../domain/bank-transfer';
import { defaultSettings } from '../domain/models';
import { getTweetPreview } from '../extraction/tweet-preview';
import { emptySearchFilters, filterBanks, filterHistory, filterQueue, filterSessions, type SearchFilters, workspaceStatesToSearchData } from '../domain/search-filters';
import { reconcileWorkspaceState } from './state/workspace-state-store';
import { calculateGlobalAnalytics, calculateWorkspaceAnalytics } from '../domain/analytics';
import { Icon, StatusBadge, type IconName } from './components';
import { sendRuntime as send } from './services/runtime-client';
import { getUserFacingMessage } from './services/error-messages';
import { OperationTab } from './tabs/OperationTab';
import { AnalyticsTab } from './tabs/AnalyticsTab';
import { DiagnosticsTab } from './tabs/DiagnosticsTab';
import { StartupTestsTab } from './tabs/StartupTestsTab';
import { PublishingWindowsEditor } from './components/publishing-windows-editor';
import type { TabId } from './types/navigation';
import { CurrentTweetCard, RecoveryCard, PreflightCard, DryRunCard } from './components/operation-cards';
import { getPageCount, pageRange, paginate, type PageSize } from '../domain/pagination';
import { loadSavedFilters, queueSavedFilterSave, type SavedFilterView } from './services/saved-filters';
import { loadFilterPresets, saveFilterPreset, deleteFilterPreset, presetsForView, hasFilterSelection, normalizePresetName, MAX_FILTER_PRESET_NAME_LENGTH, type FilterPreset, type FilterPresetView } from './services/filter-presets';
import { isSessionHistoryExportEnvelope } from '../domain/session-export.ts';
import { buildAnalyticsCsv } from '../domain/analytics-export';
import { formatDateTime, useI18n } from '../i18n';
import './styles.css';

const initialState: AppState = { queue: [], session: null, history: [] };
const initialRuntimeStatus: RuntimeStatus = { engineStatus: 'IDLE', connection: 'NOT_REQUIRED', checkedAt: 0 };

function App() {
  const { t, language, setLanguage } = useI18n();
  const [state, setState] = useState<AppState>(initialState);
  const [bankUrl, setBankUrl] = useState('');
  const [extractMode, setExtractMode] = useState<'REPLACE' | 'APPEND'>('REPLACE');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [notice, setNoticeState] = useState('');
  const [noticeKind, setNoticeKind] = useState<'info' | 'error'>('info');
  const [nowMs, setNowMs] = useState(Date.now());
  const [activeTab, setActiveTab] = useState<TabId>('operation');
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(initialRuntimeStatus);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [meta, setMeta] = useState<AppMetaState | null>(null);
  const [sessionHistory, setSessionHistory] = useState<HistoricalSession[]>([]);
  const [banks, setBanks] = useState<TweetBank[]>([]);
  const [workspaceStates, setWorkspaceStates] = useState<WorkspaceState[]>([]);
  const latestRequestId = useRef(0);
  const filtersInitializedFor = useRef('');
  const [selectedBankId, setSelectedBankId] = useState('');
  const [bankDiff, setBankDiff] = useState<BankDiffResult | null>(null);
  const [selectedDiffIds, setSelectedDiffIds] = useState<string[]>([]);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [queueFilters, setQueueFilters] = useState<SearchFilters>(emptySearchFilters);
  const [bankFilters, setBankFilters] = useState<SearchFilters>(emptySearchFilters);
  const [sessionFilters, setSessionFilters] = useState<SearchFilters>(emptySearchFilters);
  const [historyFilters, setHistoryFilters] = useState<SearchFilters>(emptySearchFilters);
  const [selectedQueueIds, setSelectedQueueIds] = useState<string[]>([]);
  const [queuePageSize, setQueuePageSize] = useState<PageSize>(10);
  const [queuePage, setQueuePage] = useState(1);
  const [analyticsWorkspaceId, setAnalyticsWorkspaceId] = useState('*');
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const setNotice = (message: string) => { const visibleMessage = getUserFacingMessage(message); setNoticeState(visibleMessage); setNoticeKind(isErrorNotice(message) ? 'error' : 'info'); };
  const copyText = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(t('common.copied')); } catch { setNotice(t('common.copyFailed')); }
  };
  const copySessionSummary = (record: HistoricalSession, attemptsCount: number, durationMs?: number) => {
    const lines = [
      `${t('sessions.title')} — ${formatDateTime(record.startedAt)}`,
      `${t('common.status')}: ${t('statuses.' + record.status)}`,
      `${t('analytics.published')}: ${record.publishedCount}`,
      `${t('analytics.failed')}: ${record.failedCount}`,
      `${t('analytics.skipped')}: ${record.skippedCount}`,
      `${t('common.attempts')}: ${attemptsCount}`,
      durationMs !== undefined ? `${t('sessions.duration')}: ${Math.round(durationMs / 1000)} ${t('units.seconds')}` : ''
    ].filter(Boolean);
    return copyText(lines.join('\n'));
  };
  const exportSessionHistory = async () => {
    const result = await send({ type: 'EXPORT_SESSION_HISTORY', workspaceId: meta?.activeWorkspaceId });
    if (!result || result.error || !isSessionHistoryExportEnvelope(result)) return setNotice(t('sessions.exportFailed'));
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `x-pilot-sessions-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(t('sessions.exported', { count: result.sessions.length }));
  };
  const exportAnalyticsCsv = () => {
    try {
      const scopeRows = analyticsWorkspaceId === '*'
        ? allWorkspaceAnalytics
        : allWorkspaceAnalytics.filter((row) => row.workspaceId === analyticsWorkspaceId);
      const csv = buildAnalyticsCsv({
        exportedAt: Date.now(),
        scopeWorkspaceId: analyticsWorkspaceId,
        scopeWorkspaceName: workspaces.find((workspace) => workspace.id === analyticsWorkspaceId)?.name,
        global: globalAnalytics,
        workspaceRows: scopeRows,
        sessionsOverTime: analyticsWorkspaceId === '*' ? globalAnalytics.sessionsOverTime : undefined,
        labels: {
          reportTitle: t('analytics.title'),
          exportedAt: t('analytics.exportedAt'),
          scope: t('analytics.workspaceScope'),
          scopeAll: t('analytics.allXpilot'),
          summary: t('analytics.summarySection'),
          summaryTotalWorkspaces: t('analytics.totalWorkspaces'),
          summaryTotalPublished: t('analytics.totalPublished'),
          summaryTotalFailures: t('analytics.totalFailures'),
          workspaces: t('analytics.workspaceComparison'),
          workspaceName: t('workspaces.title'),
          totalSessions: t('analytics.totalSessions'),
          totalPosts: t('analytics.totalPosts'),
          published: t('analytics.published'),
          failed: t('analytics.failed'),
          skipped: t('analytics.skipped'),
          successRate: t('analytics.successRate'),
          averageAttempts: t('analytics.averageAttempts'),
          duration: t('analytics.duration'),
          mostActiveBank: t('analytics.mostActiveBank'),
          lastActivity: t('analytics.lastActivity'),
          sessionsOverTime: t('analytics.sessionsOverTime'),
          date: t('analytics.dateColumn'),
          sessions: t('analytics.sessionsColumn'),
        },
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `x-pilot-analytics-${Date.now()}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(t('analytics.exportedCsv', { count: scopeRows.length }));
    } catch {
      setNotice(t('analytics.exportFailedCsv'));
    }
  };
  const session = state.session;
  const published = useMemo(() => state.queue.filter((item) => item.status === 'PUBLISHED' || item.status === 'PUBLISHED_UNVERIFIED').length, [state.queue]);
  const failed = useMemo(() => state.queue.filter((item) => item.status === 'FAILED').length, [state.queue]);
  const remaining = state.queue.length - published - failed;
  const currentItem = session?.currentItemId ? state.queue.find((item) => item.id === session.currentItemId) : undefined;
  const countdownSeconds = session?.status === 'WAITING' && session.nextRunAt ? Math.max(0, Math.ceil((session.nextRunAt - nowMs) / 1000)) : 0;
  const canPause = session?.status === 'RUNNING' || session?.status === 'WAITING';
  const canResume = session?.status === 'PAUSED';
  const logoUrl = chrome.runtime.getURL('branding/x-pilot-logo.png');
  const activeWorkspace = workspaces.find((workspace) => workspace.id === meta?.activeWorkspaceId);
  const runningWorkspace = workspaces.find((workspace) => workspace.id === runtimeStatus.automationWorkspaceId);

  const refresh = async () => { const next = await send({ type: 'GET_STATE' }); if (next && !next.error) setState(next); };
  const refreshWorkspaces = async () => { const requestId = ++latestRequestId.current; const next = await send({ type: 'GET_WORKSPACES' }); if (requestId !== latestRequestId.current) return; if (next?.workspaces) { setWorkspaces(next.workspaces); setMeta(next.meta); const states = await Promise.all(next.workspaces.map((workspace: Workspace) => send({ type: 'GET_WORKSPACE_STATE', workspaceId: workspace.id }))); if (requestId !== latestRequestId.current) return; setWorkspaceStates(states.filter((state: WorkspaceState) => state?.workspaceId)); } };
  const refreshBanks = async () => { const next = await send({ type: 'GET_BANKS', workspaceId: meta?.activeWorkspaceId }); if (next?.banks) { setBanks(next.banks); if (!selectedBankId && next.banks.find((bank: TweetBank) => !bank.archived)) setSelectedBankId(next.banks.find((bank: TweetBank) => !bank.archived).id); } };
  const refreshRuntimeStatus = async () => { const next = await send({ type: 'GET_RUNTIME_STATUS' }); if (next && !next.error) setRuntimeStatus(next); };
  const refreshHistory = async () => { const next = await send({ type: 'GET_SESSION_HISTORY', workspaceId: meta?.activeWorkspaceId }); if (next?.sessions) setSessionHistory(next.sessions); };
  const refreshDryRun = async () => { const next = await send({ type: 'GET_DRY_RUN' }); if (next && !next.error) setDryRun(next); };
  useEffect(() => { void refresh(); void refreshWorkspaces(); void refreshBanks(); void refreshRuntimeStatus(); void refreshDryRun(); const listener = (message: any) => { if (message.type === 'STATE_UPDATED') { setState(message.state); void refreshWorkspaces(); void refreshBanks(); void refreshRuntimeStatus(); void refreshHistory(); void refreshDryRun(); } }; chrome.runtime.onMessage.addListener(listener); return () => chrome.runtime.onMessage.removeListener(listener); }, []);
  useEffect(() => { if (meta?.activeWorkspaceId) void refreshHistory(); }, [meta?.activeWorkspaceId]);
  useEffect(() => { const workspaceId = meta?.activeWorkspaceId; if (!workspaceId || filtersInitializedFor.current === workspaceId) return; filtersInitializedFor.current = workspaceId; const initialize = (current: SearchFilters) => ({ ...emptySearchFilters, ...current, workspaceId }); setQueueFilters(initialize); setBankFilters(initialize); setSessionFilters(initialize); setHistoryFilters(initialize); }, [meta?.activeWorkspaceId]);
  useEffect(() => { if (meta?.activeWorkspaceId) void refreshBanks(); }, [meta?.activeWorkspaceId]);
  useEffect(() => { setQueuePage(1); }, [queueFilters]);
  // Restore the last-used filters once per panel session (UI preferences only).
  const filtersRestoredRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void loadSavedFilters().then((saved) => {
      if (cancelled) return;
      const activeId = filtersInitializedFor.current;
      const apply = (view: SavedFilterView) => { const restored = saved[view]; return restored ? { ...emptySearchFilters, ...restored, workspaceId: restored.workspaceId || activeId } : undefined; };
      const restoredQueue = apply('queue'); if (restoredQueue) setQueueFilters(restoredQueue);
      const restoredBanks = apply('banks'); if (restoredBanks) setBankFilters(restoredBanks);
      const restoredSessions = apply('sessions'); if (restoredSessions) setSessionFilters(restoredSessions);
      const restoredHistory = apply('history'); if (restoredHistory) setHistoryFilters(restoredHistory);
      filtersRestoredRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);
  // Persist the latest filters per view (debounced, best-effort, init-only guard).
  useEffect(() => {
    if (!filtersRestoredRef.current) return;
    const timer = window.setTimeout(() => {
      void queueSavedFilterSave('queue', queueFilters);
      void queueSavedFilterSave('banks', bankFilters);
      void queueSavedFilterSave('sessions', sessionFilters);
      void queueSavedFilterSave('history', historyFilters);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [queueFilters, bankFilters, sessionFilters, historyFilters]);
  useEffect(() => { const timer = window.setInterval(() => void refreshRuntimeStatus(), 1500); return () => window.clearInterval(timer); }, []);
  useEffect(() => { const timer = window.setInterval(() => setNowMs(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (!notice || noticeKind === 'error') return; const timer = window.setTimeout(() => setNoticeState(''), 3500); return () => window.clearTimeout(timer); }, [notice, noticeKind]);
  const act = async (message: RuntimeMessage, success?: string) => { const result = await send(message); if (result?.error) setNotice(result.error); else { if (result?.workspaceId && result?.workspace && Array.isArray(result?.queue)) { setWorkspaceStates((current) => { const next = reconcileWorkspaceState({ byId: Object.fromEntries(current.map((item) => [item.workspaceId, item])), revision: 0, activeWorkspaceId: meta?.activeWorkspaceId ?? '' }, result as WorkspaceState); return Object.values(next.byId); }); setState(result); } else if (result?.queue) setState(result); else await refresh(); setPreflight(null); if (success) setNotice(success); } };
  const queueAction = async (message: RuntimeMessage, success?: string) => {
    await act(message, success);
    if (message.type === 'DELETE_ITEM') setSelectedQueueIds((current) => current.filter((id) => id !== message.itemId));
  };
  const extract = async () => {
    const selectedBank = banks.find((bank) => bank.id === selectedBankId && !bank.archived);
    const extractionUrl = selectedBank?.url ?? bankUrl.trim();
    if (!extractionUrl) return setNotice(t('banks.chooseFirst'));
    let parsed: URL;
    try { parsed = new URL(extractionUrl); } catch { return setNotice(t('banks.invalidUrl')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return setNotice(t('banks.httpRequired'));
    const originPattern = `${parsed.protocol}//${parsed.host}/*`;
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) return setNotice(t('banks.permissionRequired'));
    if (extractMode === 'REPLACE' && state.queue.some((item) => item.status === 'PUBLISHED' || item.status === 'PUBLISHED_UNVERIFIED') && !window.confirm(t('confirm.replacePublished'))) return;
    const result = await send({ type: 'EXTRACT_BANK', bankId: selectedBank?.id, bankUrl: extractionUrl, workspaceId: meta?.activeWorkspaceId, mode: extractMode });
    if (result?.error) return setNotice(`${t('banks.extractionFailed')}: ${result.error}`);
    if (result?.queue) setState(result);
    setPreflight(null);
    await refreshBanks();
    setNotice(t('banks.extracted', { count: result?.queue?.length ?? 0 }));
  };
  const start = async () => { if (settings.confirmBeforeStart && !window.confirm(t('confirm.startPublishing', { count: remaining }))) return; await act({ type: 'START', confirmed: true, workspaceId: meta?.activeWorkspaceId }, t('notifications.startedTitle')); };
  const stop = async () => { if (session?.status === 'SCHEDULED') await act({ type: 'CANCEL_SCHEDULE', workspaceId: meta?.activeWorkspaceId }, t('notifications.cancelled')); else await act({ type: 'STOP', workspaceId: meta?.activeWorkspaceId }, t('notifications.stopped')); };
  const schedule = async (reschedule = false) => { const startAt = new Date(scheduleAt).getTime(); if (!Number.isFinite(startAt)) return setNotice(t('schedule.invalidDate')); await act({ type: reschedule ? 'RESCHEDULE' : 'SCHEDULE', startAt, workspaceId: meta?.activeWorkspaceId }, reschedule ? t('notifications.rescheduled') : t('notifications.scheduled')); };
  const runPreflightCheck = async () => { const result = await send({ type: 'PREFLIGHT_CHECK', workspaceId: meta?.activeWorkspaceId }); if (result?.error) return setNotice(result.error); setPreflight(result); setNotice(t(result.summaryKey, result.summaryParams)); };
  const runDryRun = async (mode: 'DRY_RUN_FIRST' | 'DRY_RUN_QUEUE') => { setNotice(t('tests.started')); const result = await send({ type: mode, workspaceId: meta?.activeWorkspaceId }); if (result?.error) return setNotice(result.error); setDryRun(result); setNotice(result.status === 'COMPLETED' ? t('tests.completed') : t('tests.status', { status: t(`statuses.${result.status}`) })); };
  const runDiagnostics = async () => { setNotice(t('diagnostics.started')); const result = await send({ type: 'RUN_DIAGNOSTICS' }); if (result?.error) return setNotice(result.error); setDiagnostics(result); setNotice(t('diagnostics.completed')); };
  const updateSettings = async (next: Settings) => { setSettings(next); await act({ type: 'UPDATE_SETTINGS', settings: next }); };
  const saveWorkspaceProfile = async () => { const result = await send({ type: 'UPDATE_WORKSPACE_PROFILE', workspaceId: meta?.activeWorkspaceId ?? '', profile: settings }); if (result?.error) return setNotice(result.error); await refreshWorkspaces(); setNotice(t('settings.overrideSaved')); };
  const clearWorkspaceProfile = async () => { const result = await send({ type: 'CLEAR_WORKSPACE_PROFILE', workspaceId: meta?.activeWorkspaceId ?? '' }); if (result?.error) return setNotice(result.error); await refreshWorkspaces(); setNotice(t('settings.defaultsRestored')); };
  const exportFullBackup = async () => { const backup = await send({ type: 'EXPORT_BACKUP' }) as BackupEnvelope; if (!backup?.workspaces) return setNotice(t('backup.exportFailed')); const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `x-pilot-backup-${new Date(backup.createdAt).toISOString().replace(/[:.]/g, '-')}.json`; anchor.click(); URL.revokeObjectURL(url); setNotice(t('backup.exported')); };
  const restoreFullBackup = async (event: any) => { const file = event.target.files?.[0] as File | undefined; if (!file) return; try { const backup = JSON.parse(await file.text()) as unknown; const validation = await send({ type: 'VALIDATE_BACKUP', backup }); if (!validation?.valid) return setNotice(`${t('backup.invalid')}: ${(validation?.errors ?? []).join(', ')}`); const summary = validation.summary; if (!window.confirm(t('confirm.restoreBackup', { workspaces: summary.workspaceCount, queue: summary.queueCount, banks: summary.bankCount }))) return; const result = await send({ type: 'RESTORE_BACKUP', backup, confirmed: true }); if (result?.error) return setNotice(result.error); setState(result); await refreshWorkspaces(); await refreshBanks(); await refreshHistory(); setNotice(t('backup.restored')); } catch (error) { setNotice(`${t('backup.readFailed')}: ${error instanceof Error ? error.message : 'INVALID_JSON'}`); } finally { event.target.value = ''; } };
  const switchWorkspace = async (workspaceId: string) => { const result = await send({ type: 'SET_ACTIVE_WORKSPACE', workspaceId }); if (result?.error) return setNotice(result.error); setWorkspaceStates((current) => current); setMeta((current) => current ? { ...current, activeWorkspaceId: workspaceId } : current); filtersInitializedFor.current = workspaceId; setQueueFilters({ ...emptySearchFilters, workspaceId }); setBankFilters({ ...emptySearchFilters, workspaceId }); setSessionFilters({ ...emptySearchFilters, workspaceId }); setHistoryFilters({ ...emptySearchFilters, workspaceId }); await refreshWorkspaces(); await refresh(); setActiveTab('operation'); };
  const createNewWorkspace = async () => { const name = window.prompt(t('prompts.workspaceName')); if (!name?.trim()) return; const result = await send({ type: 'CREATE_WORKSPACE', name: name.trim() }); if (result?.error) return setNotice(result.error); await refreshWorkspaces(); };
  const archive = async (workspaceId: string) => { const result = await send({ type: 'ARCHIVE_WORKSPACE', workspaceId }); if (result?.error) return setNotice(result.error); await refreshWorkspaces(); await refresh(); };
  const restore = async (workspaceId: string) => { const result = await send({ type: 'RESTORE_WORKSPACE', workspaceId }); if (result?.error) return setNotice(result.error); await refreshWorkspaces(); };
  const remove = async (workspace: Workspace) => { if (!window.confirm(t('confirm.deleteWorkspace', { name: workspace.name }))) return; const result = await send({ type: 'DELETE_WORKSPACE', workspaceId: workspace.id, confirmed: true }); if (result?.error) return setNotice(result.error); await refreshWorkspaces(); await refresh(); };
  const createNewBank = async () => { const name = window.prompt(t('prompts.bankName')); if (!name?.trim()) return; const url = window.prompt(t('prompts.bankUrl')); if (!url?.trim()) return; const result = await send({ type: 'CREATE_BANK', workspaceId: meta?.activeWorkspaceId, name: name.trim(), url: url.trim() }); if (result?.error) return setNotice(result.error); setSelectedBankId(result.id); await refreshBanks(); };
  const archiveSelectedBank = async (bank: TweetBank) => { const result = await send({ type: bank.archived ? 'RESTORE_BANK' : 'ARCHIVE_BANK', workspaceId: meta?.activeWorkspaceId, bankId: bank.id }); if (result?.error) return setNotice(result.error); await refreshBanks(); };
  const exportBanks = async (bankIds: string[]) => { if (!bankIds.length) return setNotice(t('banks.exportFailed')); try { const envelope = await send({ type: 'EXPORT_BANKS', workspaceId: meta?.activeWorkspaceId, bankIds }) as (BankExportEnvelope | BankListExportEnvelope) & { error?: string }; if (!envelope || envelope.error || !envelope.format) return setNotice(`${t('banks.exportFailed')}: ${envelope?.error ?? ''}`); const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `x-pilot-banks-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; anchor.click(); URL.revokeObjectURL(url); setNotice(t('banks.exported', { count: bankIds.length })); } catch (error) { setNotice(`${t('banks.exportFailed')}: ${getUserFacingMessage(error instanceof Error ? error.message : String(error))}`); } };
  const importBanksFile = async (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { const payload: unknown = JSON.parse(await file.text()); const result = await send({ type: 'IMPORT_BANKS', workspaceId: meta?.activeWorkspaceId, payload }) as (BankImportOutcome & { error?: string }) | undefined; if (!result || result.error) return setNotice(`${t('banks.importFailed')}: ${getUserFacingMessage(result?.error ?? '')}`); setNotice(t('banks.imported', { count: result.importedCount })); await refreshBanks(); } catch (error) { setNotice(`${t('banks.importFailed')}: ${getUserFacingMessage(error instanceof Error ? error.message : String(error))}`); } };
  const deleteSelectedBank = async (bank: TweetBank) => { if (!window.confirm(t('confirm.deleteBank', { name: bank.name }))) return; const result = await send({ type: 'DELETE_BANK', workspaceId: meta?.activeWorkspaceId, bankId: bank.id, confirmed: true }); if (result?.error) return setNotice(result.error); if (selectedBankId === bank.id) setSelectedBankId(''); await refreshBanks(); };
  const refreshSelectedBank = async (bank: TweetBank) => { setSelectedBankId(bank.id); let originPattern: string; try { const parsed = new URL(bank.url); originPattern = `${parsed.protocol}//${parsed.host}/*`; } catch { return setNotice(t('banks.invalidUrl')); } const granted = await chrome.permissions.request({ origins: [originPattern] }); if (!granted) return setNotice(t('banks.permissionRequired')); const result = await send({ type: 'REFRESH_BANK', workspaceId: meta?.activeWorkspaceId, bankId: bank.id }); if (result?.error) { if (result.error.includes('Cannot access contents of url') || result.error.includes('must request permission')) return setNotice(t('banks.permissionRequired')); return setNotice(`${t('banks.refreshFailed')}: ${result.error}`); } setBankDiff(result); setSelectedDiffIds(result.selectedNewIds ?? []); setNotice(t('banks.diffComplete', { count: result.items.filter((item: BankDiffItem) => item.category === 'NEW').length })); await refreshBanks(); };
  const addSelectedDiff = async () => { if (!bankDiff || !selectedDiffIds.length) return setNotice(t('diff.selectNew')); const result = await send({ type: 'ADD_DIFF_ITEMS', workspaceId: meta?.activeWorkspaceId, bankId: bankDiff.bankId, itemIds: selectedDiffIds }); if (result?.error) return setNotice(result.error); if (result?.queue) setState(result); setPreflight(null); setBankDiff(null); setSelectedDiffIds([]); setNotice(t('bulk.added')); };
  const discardDiff = async () => { if (bankDiff) await send({ type: 'DISCARD_BANK_DIFF', workspaceId: meta?.activeWorkspaceId, bankId: bankDiff.bankId }); setBankDiff(null); setSelectedDiffIds([]); };
  const toggleQueueItem = (itemId: string) => setSelectedQueueIds((current) => current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]);
  const toggleVisibleQueue = () => setSelectedQueueIds((current) => pagedQueue.every((item) => current.includes(item.id)) ? current.filter((id) => !pagedQueue.some((item) => item.id === id)) : [...new Set([...current, ...pagedQueue.map((item) => item.id)])]);
  const runBulkAction = async (action: BulkQueueAction, bankId?: string) => {
    if (!selectedQueueIds.length) return setNotice(t('bulk.selectFirst'));
    if (action === 'DELETE' && !window.confirm(t('confirm.deleteSelected', { count: selectedQueueIds.length }))) return;
    const request = { type: 'BULK_ACTION' as const, action, itemIds: selectedQueueIds, workspaceId: meta?.activeWorkspaceId, bankId };
    let result = await send(request);
    if (result?.error === 'BULK_ACTIVE_ITEM_BUSY') return setNotice(t('bulk.activeBusy'));
    if (result?.error?.startsWith('BULK_ACTIVE_ITEM_CONFIRMATION_REQUIRED:')) {
      const activeId = result.error.split(':')[1];
      if (!window.confirm(t('confirm.activeItem', { position: state.queue.find((item) => item.id === activeId)?.position ?? activeId }))) return;
      result = await send({ ...request, confirmed: true });
    }
    if (result?.error) return setNotice(result.error);
    if (action === 'EXPORT' && result.exportedItems) { const blob = new Blob([JSON.stringify(result.exportedItems, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `x-pilot-selected-queue-${Date.now()}.json`; anchor.click(); URL.revokeObjectURL(url); setNotice(t('bulk.exported', { count: result.exportedItems.length })); return; }
    if (result.state) setState(result.state); else await refresh();
    setSelectedQueueIds([]);
    setPreflight(null);
    setNotice(t('bulk.completed', { count: result.affectedIds?.length ?? 0 }));
  };
  const searchData = workspaceStatesToSearchData(workspaceStates);
  const currentWorkspaceId = meta?.activeWorkspaceId ?? '';
  const visibleQueue = filterQueue(searchData.queue.length ? searchData.queue : state.queue.map((item) => ({ ...item, workspaceId: item.workspaceId ?? currentWorkspaceId })), queueFilters, searchData.banks.length ? searchData.banks : banks, currentWorkspaceId);
  const queuePageCount = getPageCount(visibleQueue.length, queuePageSize);
  const safeQueuePage = Math.min(queuePage, queuePageCount);
  const pagedQueue = paginate(visibleQueue, safeQueuePage, queuePageSize);
  const queueRange = pageRange(visibleQueue.length, safeQueuePage, queuePageSize);
  useEffect(() => { setQueuePage((current) => Math.min(current, getPageCount(visibleQueue.length, queuePageSize))); }, [visibleQueue.length, queuePageSize]);
  const visibleBanks = filterBanks(searchData.banks.length ? searchData.banks : banks, bankFilters, currentWorkspaceId);
  const visibleSessions = filterSessions(searchData.sessions.length ? searchData.sessions : sessionHistory, sessionFilters, currentWorkspaceId);
  const visibleHistory = filterHistory(searchData.history, historyFilters, currentWorkspaceId);
  const globalAnalytics = calculateGlobalAnalytics(workspaceStates);
  const selectedAnalytics = analyticsWorkspaceId === '*' ? undefined : workspaceStates.find((workspaceState) => workspaceState.workspaceId === analyticsWorkspaceId);
  const workspaceAnalytics = selectedAnalytics ? calculateWorkspaceAnalytics(selectedAnalytics) : undefined;
  const allWorkspaceAnalytics = workspaceStates.map(calculateWorkspaceAnalytics);

  const progress = state.queue.length ? (published / state.queue.length) * 100 : 0;
  return <main className={`shell shell-${activeTab}`}>
    <header className="app-header"><div className="brand-lockup"><img className="brand-logo" src={logoUrl} alt="X-Pilot" /><div><span className="eyebrow">{t('common.localFirst')} · MV3</span><h1>X-PILOT</h1><p>{t('operation.publishingCenter')}</p></div></div><div className="header-status"><span className="header-live-dot" aria-hidden="true" /><StatusBadge status={session?.status ?? 'IDLE'}>{t(`statuses.${session?.status ?? 'IDLE'}`)}</StatusBadge></div></header>
    <div className="workspace-switcher premium-switcher"><div className="workspace-switcher-copy"><span className="eyebrow">{t('ui.workspaceActive')}</span>{activeWorkspace?.color && <span className="workspace-color-dot" style={{ background: activeWorkspace.color }} aria-hidden="true" />}<strong dir="auto">{activeWorkspace?.name ?? t('ui.chooseWorkspace')}</strong></div><select value={meta?.activeWorkspaceId ?? ''} onChange={(event) => void switchWorkspace(event.target.value)} aria-label={t('ui.activeWorkspace')}>{workspaces.filter((workspace) => !workspace.archived).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.favorite ? '★ ' : ''}{workspace.name}</option>)}</select><button className="icon-button workspace-manage-button" onClick={() => setActiveTab('workspaces')} aria-label={t('ui.manageWorkspaces')} title={t('ui.manageWorkspaces')}><Icon name="workspace" /></button></div>
    <nav className="tabs-bar" aria-label={t('nav.operation')} data-scroll-hint={t('ui.scrollTabsHint')}><div className="tabs" role="tablist">
      <div className="nav-group"><span>{t('common.control')}</span><TabButton id="operation" activeTab={activeTab} onSelect={setActiveTab} icon="play" label={t('nav.operation')} /><TabButton id="tests" activeTab={activeTab} onSelect={setActiveTab} icon="check" label={t('nav.startupTests')} /></div>
      <div className="nav-group"><span>{t('common.content')}</span><TabButton id="queue" activeTab={activeTab} onSelect={setActiveTab} icon="bank" label={t('nav.banks')} /></div>
      <div className="nav-group"><span>{t('common.activity')}</span><TabButton id="sessions" activeTab={activeTab} onSelect={setActiveTab} icon="clock" label={t('nav.sessions')} /></div>
      <div className="nav-group"><span>{t('common.insights')}</span><TabButton id="analytics" activeTab={activeTab} onSelect={setActiveTab} icon="analytics" label={t('nav.analytics')} /><TabButton id="diagnostics" activeTab={activeTab} onSelect={setActiveTab} icon="diagnostics" label={t('nav.diagnostics')} /></div>
      <div className="nav-group"><span>{t('common.manage')}</span><TabButton id="workspaces" activeTab={activeTab} onSelect={setActiveTab} icon="workspace" label={t('nav.workspaces')} /><TabButton id="settings" activeTab={activeTab} onSelect={setActiveTab} icon="settings" label={t('nav.settings')} /></div>
    </div><div className="runtime-indicators" aria-live="polite"><StatusIndicator kind="connection" value={runtimeStatus.connection} label={t(`statuses.${runtimeStatus.connection}`)} /><StatusIndicator kind="engine" value={runtimeStatus.engineStatus} label={t(`statuses.${runtimeStatus.engineStatus}`)} /></div></nav>
    {runtimeStatus.connection === 'DISCONNECTED' && <div className="runtime-warning" role="status">{t('ui.automationTabDisconnected')}</div>}
    {runningWorkspace && runningWorkspace.id !== meta?.activeWorkspaceId && <button className="running-workspace" onClick={() => void switchWorkspace(runningWorkspace.id)}>● {t('ui.runningNow')}: <span dir="auto">{runningWorkspace.name}</span> — {t('workspaces.openRunning')}</button>}
    {notice && <div className={`notice notice-${noticeKind}`} role={noticeKind === 'error' ? 'alert' : 'status'} aria-live="polite"><span>{notice}</span><button type="button" className="notice-dismiss" onClick={() => setNoticeState('')} aria-label={t('ui.closeMessage')}>×</button></div>}

    {activeTab === 'operation' && <OperationTab state={state} session={session} currentItem={currentItem} logoUrl={logoUrl} activeWorkspaceName={activeWorkspace?.name} published={published} failed={failed} remaining={remaining} progress={progress} countdownSeconds={countdownSeconds} nowMs={nowMs} canPause={canPause} canResume={canResume} preflight={preflight} settings={settings} scheduleAt={scheduleAt} setScheduleAt={setScheduleAt} start={() => void start()} stop={() => void stop()} schedule={(reschedule) => void schedule(reschedule)} act={(message, success) => void act(message, success)} />}

    {activeTab === 'tests' && <StartupTestsTab preflight={preflight} dryRun={dryRun} runPreflightCheck={() => void runPreflightCheck()} runDryRunFirst={() => void runDryRun('DRY_RUN_FIRST')} runDryRunQueue={() => void runDryRun('DRY_RUN_QUEUE')} stopDryRun={() => void send({ type: 'DRY_RUN_STOP' })} />}

    {activeTab === 'queue' && <section className="tab-panel" role="tabpanel" aria-label={t('ui.tweetBanksQueue')}>
      <section className="card"><div className="section-heading"><h2>{t('banks.title')}</h2><div className="section-heading-actions"><label className="button-like">{t('banks.import')}<input type="file" accept="application/json,.json" onChange={(event) => void importBanksFile(event)} /></label><button onClick={() => void exportBanks(banks.filter((bank) => !bank.archived).map((bank) => bank.id))} disabled={!banks.some((bank) => !bank.archived)}>{t('banks.exportAll')}</button><button className="primary" onClick={() => void createNewBank()}>+ {t('banks.add')}</button></div></div><SearchToolbar filters={bankFilters} onChange={setBankFilters} workspaces={workspaces} banks={searchData.banks} view="banks" onNotice={setNotice} /><div className="search-count">{t('banks.count', { visible: visibleBanks.length, total: searchData.banks.length || banks.length })}</div><div className="bank-cards">{visibleBanks.map((bank) => { const bankItems = state.queue.filter((item) => item.sourceBankId === bank.id || (!item.sourceBankId && item.sourceBankUrl === bank.url)); const bankPublished = bankItems.filter((item) => item.status === 'PUBLISHED' || item.status === 'PUBLISHED_UNVERIFIED').length; return <article className={`bank-card ${selectedBankId === bank.id ? 'selected' : ''} ${bank.archived ? 'archived' : ''}`} key={bank.id} onClick={() => !bank.archived && setSelectedBankId(bank.id)}><div className="bank-card-heading"><strong>{bank.favorite ? '★ ' : ''}{bank.name}</strong><span>{bank.archived ? t('ui.archived') : t('ui.active')}</span></div><small dir="ltr">{bank.url}</small><div className="bank-card-meta"><span>{bank.lastExtractedCount ?? 0} {t('ui.links')}</span><span>{bankItems.length - bankPublished} {t('ui.remaining')}</span><span>{bankPublished} {t('operation.published')}</span>{bank.lastSnapshotAt && <span>{t('workspaces.lastUpdated')}: {formatDateTime(bank.lastSnapshotAt)}</span>}</div><div className="bank-card-actions"><button onClick={(event) => { event.stopPropagation(); void extract(); }} disabled={bank.archived}>{t('banks.extract')}</button><button onClick={(event) => { event.stopPropagation(); void refreshSelectedBank(bank); }} disabled={bank.archived}>{t('ui.refreshDiff')}</button><button onClick={(event) => { event.stopPropagation(); void exportBanks([bank.id]); }}>{t('banks.export')}</button><button onClick={(event) => { event.stopPropagation(); void archiveSelectedBank(bank); }}>{bank.archived ? t('ui.restore') : t('ui.archive')}</button><button className="danger" onClick={(event) => { event.stopPropagation(); void deleteSelectedBank(bank); }}>{t('common.delete')}</button></div></article>; })}{!visibleBanks.length && <p className="muted">{t('banks.noMatch')}</p>}</div>{bankDiff && <DiffReview diff={bankDiff} selectedIds={selectedDiffIds} onToggle={(id) => setSelectedDiffIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} onAdd={() => void addSelectedDiff()} onDiscard={() => void discardDiff()} /> }<div className="row bank-row"><input value={bankUrl} onChange={(event) => setBankUrl(event.target.value)} placeholder={t('banks.temporaryUrl')} dir="ltr" /><button onClick={() => void extract()}>{t('banks.extract')}</button></div><div className="extract-options"><label><input type="radio" checked={extractMode === 'REPLACE'} onChange={() => setExtractMode('REPLACE')} /> {t('banks.replace')}</label><label><input type="radio" checked={extractMode === 'APPEND'} onChange={() => setExtractMode('APPEND')} /> {t('banks.append')}</label></div><p className="muted">{t('banks.hint')}</p></section>
      <section className="card"><div className="section-heading"><h2>{t('common.queue')}</h2><span className="session-progress">{t('queue.count', { visible: visibleQueue.length, total: state.queue.length })}</span><button onClick={() => void act({ type: 'CLEAR_COMPLETED' })}>{t('queue.clearCompleted')}</button></div><SearchToolbar filters={queueFilters} onChange={setQueueFilters} workspaces={workspaces} banks={searchData.banks} showStatus activeWorkspaceId={currentWorkspaceId} view="queue" onNotice={setNotice} /><div className="queue-toolbar"><label>{t('queue.pageSize')}<select value={queuePageSize} onChange={(event) => { const value = event.target.value; setQueuePageSize(value === 'ALL' ? 'ALL' : Number(value) as PageSize); setQueuePage(1); }} aria-label={t('queue.selectPage')}><option value="10">10</option><option value="50">50</option><option value="100">100</option><option value="ALL">{t('common.all')}</option></select></label><span className="search-count">{t('queue.range', { from: queueRange.from, to: queueRange.to, total: visibleQueue.length })}</span></div><div className="bulk-select-row"><label className="check"><input type="checkbox" checked={pagedQueue.length > 0 && pagedQueue.every((item) => selectedQueueIds.includes(item.id))} onChange={toggleVisibleQueue} /> {t('queue.selectPage')}</label><span>{t('queue.selectedCount', { count: selectedQueueIds.length })}</span></div>{selectedQueueIds.length > 0 && <BulkActionsBar selectedCount={selectedQueueIds.length} banks={banks} onAction={(action, bankId) => void runBulkAction(action, bankId)} />}</section>
      <section className="card"><div className="queue">{pagedQueue.map((item) => <QueueRow key={item.id} item={item} selected={selectedQueueIds.includes(item.id)} onToggle={() => toggleQueueItem(item.id)} onAction={queueAction} />)}{!visibleQueue.length && <p className="muted">{t('queue.empty')}</p>}</div>{visibleQueue.length > 0 && <div className="pagination-controls" aria-label={t('queue.pagination')}><button onClick={() => setQueuePage((current) => Math.max(1, current - 1))} disabled={safeQueuePage <= 1}>{t('actions.previous')}</button><span>{t('queue.pageOf', { page: safeQueuePage, pages: queuePageCount })}</span><button onClick={() => setQueuePage((current) => Math.min(queuePageCount, current + 1))} disabled={safeQueuePage >= queuePageCount}>{t('actions.next')}</button></div>}</section>
    </section>}

    {activeTab === 'sessions' && <section className="tab-panel activity-panel" role="tabpanel" aria-label={t('nav.sessions')}>
      <section className="card"><div className="section-heading"><div><span className="eyebrow">{t('sessions.eyebrow')}</span><h2>{t('sessions.title')}</h2></div><button onClick={() => void exportSessionHistory()}>{t('sessions.export')}</button><button onClick={() => void refreshHistory()}>{t('actions.refresh')}</button></div><SearchToolbar filters={sessionFilters} onChange={setSessionFilters} workspaces={workspaces} showStatus sessionOptions={visibleSessions} activeWorkspaceId={currentWorkspaceId} view="sessions" onNotice={setNotice} /><div className="search-count">{t('sessions.count', { visible: visibleSessions.length, total: searchData.sessions.length || sessionHistory.length })}</div></section>
      <section className="card activity-list">{visibleSessions.map((record) => { const attempts = filterHistory(searchData.history, sessionFilters, currentWorkspaceId).filter((attempt) => attempt.sessionId === record.id); const duration = record.completedAt && record.startedAt ? Math.max(0, record.completedAt - record.startedAt) : undefined; return <article className="session-summary" key={record.id}><div className="session-summary-header"><div><strong>{formatDateTime(record.startedAt)}</strong><small>{t('statuses.' + record.status)} · {record.totalItems} {t('units.items')}</small><small dir="ltr">Session: {record.id}</small></div><div className="history-counts"><span>✓ {record.publishedCount}</span><span>! {record.failedCount}</span><span>↷ {record.skippedCount}</span></div><button className="link-action" onClick={() => copySessionSummary(record, attempts.length, duration)}>{t('sessions.copySummary')}</button></div><div className="session-summary-meta"><span>{t('sessions.started')}: {formatDateTime(record.startedAt)}</span><span>{t('sessions.ended')}: {record.completedAt ? formatDateTime(record.completedAt) : t('sessions.notEnded')}</span><span>{t('sessions.duration')}: {duration === undefined ? '—' : String(Math.round(duration / 1000)) + ' ' + t('units.seconds')}</span><span>{t('common.attempts')}: {attempts.length}</span></div><div className="session-attempts"><h3>{t('history.title')}</h3>{attempts.map((attempt) => <div className="history-row" key={attempt.id}><div><strong>{formatDateTime(attempt.timestamp)}</strong><small>{t('statuses.' + attempt.result)} · {attempt.action} · {t('ui.currentItem')} {attempt.queueItemId}</small><small>{t('common.attempts')}: {attempt.attemptNumber}</small>{(attempt.sourceUrl ?? attempt.link) && <a className="secondary-link" href={attempt.sourceUrl ?? attempt.link} target="_blank" rel="noreferrer">{t('sessions.sourceLink')}</a>}{attempt.publishedPostUrl ? <a className="primary-link" href={attempt.publishedPostUrl} target="_blank" rel="noreferrer">{t('sessions.publishedLink')}</a> : attempt.result === 'PUBLISHED' || attempt.result === 'PUBLISHED_UNVERIFIED' ? <small className="muted">{t('sessions.publishedLinkUnavailable')}</small> : null}{attempt.publishedPostUrl && <button className="link-action" onClick={() => void copyText(attempt.publishedPostUrl!)}>{t('history.copyLink')}</button>}{attempt.error && <small className="error-text">{getUserFacingMessage(attempt.error)}</small>}</div></div>)}{!attempts.length && <p className="muted">{t('history.noMatch')}</p>}</div></article>; })}{!visibleSessions.length && <p className="muted">{t('sessions.noMatch')}</p>}</section>
    </section>}

    {activeTab === 'analytics' && <AnalyticsTab global={globalAnalytics} workspace={workspaceAnalytics} workspaceRows={allWorkspaceAnalytics} workspaces={workspaces} selectedWorkspaceId={analyticsWorkspaceId} onWorkspaceChange={setAnalyticsWorkspaceId} onExportCsv={exportAnalyticsCsv} />}

    {activeTab === 'diagnostics' && <DiagnosticsTab result={diagnostics} onRun={() => void runDiagnostics()} />}

    {activeTab === 'workspaces' && <section className="tab-panel" role="tabpanel" aria-label={t('nav.workspaces')}>
      <section className="card"><div className="section-heading"><div><span className="eyebrow">{t('common.projects')}</span><h2>{t('workspaces.title')}</h2></div><button className="primary" onClick={() => void createNewWorkspace()}>+ {t('workspaces.new')}</button></div><p className="muted">{t('workspaces.activeSummary', { name: activeWorkspace?.name ?? t('workspaces.undefined'), running: meta?.automationWorkspaceId ? ` · ${t('workspaces.runningSummary', { name: workspaces.find((workspace) => workspace.id === meta.automationWorkspaceId)?.name ?? t('workspaces.other') })}` : '' })}</p></section>
      <div className="workspace-list">{workspaces.map((workspace) => <WorkspaceCard key={workspace.id} workspace={workspace} active={workspace.id === meta?.activeWorkspaceId} running={workspace.id === meta?.automationWorkspaceId} onOpen={() => void switchWorkspace(workspace.id)} onArchive={() => void archive(workspace.id)} onRestore={() => void restore(workspace.id)} onDelete={() => void remove(workspace)} />)}</div>
    </section>}

    {activeTab === 'settings' && <section className="tab-panel" role="tabpanel" aria-label={t('nav.settings')}>
      <section className="card settings-card"><div className="settings-heading"><img src={logoUrl} alt="" /><div><span className="eyebrow">{t('common.xPilotSettings')}</span><h2>{t('settings.title')}</h2></div></div><label>{t('settings.language')}<select value={language} onChange={(event) => void setLanguage(event.target.value as 'AUTO' | 'AR' | 'EN')}><option value="AUTO">{t('common.automatic')}</option><option value="AR">{t('common.arabic')}</option><option value="EN">{t('common.english')}</option></select></label><label>{t('settings.interval')}<input type="number" min="0.5" step="0.5" value={settings.intervalMinutes} onChange={(event) => void updateSettings({ ...settings, intervalMinutes: Number(event.target.value) })} /></label><label>{t('settings.maxRetries')}<input type="number" min="0" max="10" value={settings.maxRetries} onChange={(event) => void updateSettings({ ...settings, maxRetries: Number(event.target.value) })} /></label><label>{t('settings.timezone')}<input value={settings.timezone} onChange={(event) => void updateSettings({ ...settings, timezone: event.target.value })} placeholder="Asia/Aden" dir="ltr" /></label><PublishingWindowsEditor windows={settings.publishingWindows} onSave={(publishingWindows) => void updateSettings({ ...settings, publishingWindows })} /><label>{t('settings.duplicatePolicy')}<select value={settings.duplicatePolicy} onChange={(event) => void updateSettings({ ...settings, duplicatePolicy: event.target.value as Settings['duplicatePolicy'] })}><option value="BLOCK">{t('duplicatePolicy.BLOCK')}</option><option value="WARN">{t('duplicatePolicy.WARN')}</option><option value="ALLOW">{t('duplicatePolicy.ALLOW')}</option></select></label><label>{t('settings.badge')}<select value={settings.badgeMode} onChange={(event) => void updateSettings({ ...settings, badgeMode: event.target.value as Settings['badgeMode'] })}><option value="COUNT">{t('badges.remaining')}</option><option value="STATUS">{t('common.status')}</option><option value="NONE">{t('common.none')}</option></select></label><label className="check"><input type="checkbox" checked={settings.notificationsEnabled} onChange={(event) => void updateSettings({ ...settings, notificationsEnabled: event.target.checked })} /> {t('settings.notifications')}</label><label className="check"><input type="checkbox" checked={settings.confirmBeforeStart} onChange={(event) => void updateSettings({ ...settings, confirmBeforeStart: event.target.checked })} /> {t('settings.confirmBeforeStart')}</label><label className="check"><input type="checkbox" checked={settings.keepAutomationTabOpen} onChange={(event) => void updateSettings({ ...settings, keepAutomationTabOpen: event.target.checked })} /> {t('settings.keepAutomationTabOpen')}</label><label className="check"><input type="checkbox" checked={settings.closeTabOnComplete} onChange={(event) => void updateSettings({ ...settings, closeTabOnComplete: event.target.checked })} /> {t('settings.closeTabOnComplete')}</label><div className="profile-actions"><h3>{t('settings.profileTitle')}</h3><p className="muted">{t('settings.profileHint')}</p><button onClick={() => void saveWorkspaceProfile()}>{t('settings.workspaceOverride')}</button><button onClick={() => void clearWorkspaceProfile()}>{t('settings.clearOverride')}</button></div><div className="backup-actions"><h3>{t('backup.title')}</h3><p className="muted">{t('backup.hint')}</p><div className="row controls-row"><button className="primary" onClick={() => void exportFullBackup()}>{t('backup.export')}</button><label className="button-like">{t('backup.restore')}<input type="file" accept="application/json,.json" onChange={(event) => void restoreFullBackup(event)} /></label></div></div></section>
    </section>}
  </main>;
}

function isErrorNotice(message: string): boolean {
  return /^(فشل|خطأ|INVALID|ERROR|BULK_|PUBLISH_|LOGIN_|لم يتم|يجب أن|حدد |اختر |العنصر الجاري|ملف النسخة غير صالح)/i.test(message.trim()); /* i18n-exempt: internal-code bridge — classifies raw background codes, never rendered */
}

function WorkspaceCard({ workspace, active, running, onOpen, onArchive, onRestore, onDelete }: { workspace: Workspace; active: boolean; running: boolean; onOpen: () => void; onArchive: () => void; onRestore: () => void; onDelete: () => void }) {
  const { t } = useI18n();
  return <article className={`workspace-card ${active ? 'active' : ''} ${workspace.archived ? 'archived' : ''}`}><div className="workspace-card-heading"><span className="workspace-icon" style={{ background: workspace.color ?? '#1d9bf0' }}>{workspace.icon ?? '◈'}</span><div><h3>{workspace.favorite ? '★ ' : ''}{workspace.name}</h3><p>{workspace.description || t('workspaces.noDescription')}</p></div></div><div className="workspace-card-stats"><span>{running ? t('workspaces.running') : workspace.archived ? t('ui.archived') : active ? t('ui.active') : t('workspaces.ready')}</span><span>{t('workspaces.lastActivity')}: {new Date(workspace.lastActivityAt).toLocaleDateString()}</span></div><div className="workspace-card-actions"><button onClick={onOpen} disabled={workspace.archived}>{t('actions.open')}</button>{workspace.archived ? <button onClick={onRestore}>{t('actions.restore')}</button> : <button onClick={onArchive} disabled={active}>{t('actions.archive')}</button>}<button className="danger" onClick={onDelete} disabled={running}>{t('common.delete')}</button></div></article>;
}

function TabButton({ id, activeTab, onSelect, icon, label }: { id: TabId; activeTab: TabId; onSelect: (id: TabId) => void; icon: IconName; label: string }) { return <button className={`tab-button ${activeTab === id ? 'active' : ''}`} role="tab" aria-selected={activeTab === id} aria-current={activeTab === id ? 'page' : undefined} onClick={() => onSelect(id)}><Icon name={icon} size={17} /><span>{label}</span></button>; }

function SearchToolbar({ filters, onChange, workspaces, banks = [], sessionOptions = [], showStatus = false, activeWorkspaceId = '', view, onNotice }: { filters: SearchFilters; onChange: (filters: SearchFilters) => void; workspaces: Workspace[]; banks?: TweetBank[]; sessionOptions?: HistoricalSession[]; showStatus?: boolean; activeWorkspaceId?: string; view: FilterPresetView; onNotice: (message: string) => void }) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [saveFormOpen, setSaveFormOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  useEffect(() => {
    let cancelled = false;
    void loadFilterPresets().then((store) => { if (!cancelled) setPresets(presetsForView(store, view)); });
    return () => { cancelled = true; };
  }, [view]);
  const update = (patch: Partial<SearchFilters>) => onChange({ ...filters, ...patch });
  const closeSaveForm = () => { setSaveFormOpen(false); setPresetName(''); };
  const handleSavePreset = async () => {
    const outcome = await saveFilterPreset(view, presetName, filters);
    if (outcome.ok) {
      setPresets((current) => [...current, outcome.preset]);
      closeSaveForm();
      onNotice(t('presets.saved', { name: outcome.preset.name }));
      return;
    }
    const errorKey = outcome.reason === 'empty-name' ? 'presets.errorEmptyName'
      : outcome.reason === 'name-too-long' ? 'presets.errorNameTooLong'
      : outcome.reason === 'view-full' ? 'presets.errorViewFull'
      : 'presets.errorStorage';
    onNotice(t(errorKey, { max: MAX_FILTER_PRESET_NAME_LENGTH }));
  };
  const handleDeletePreset = async (presetId: string) => {
    const outcome = await deleteFilterPreset(view, presetId);
    if (outcome.ok) setPresets((current) => current.filter((preset) => preset.id !== presetId));
    else onNotice(t('presets.deleteFailed'));
  };
  const applyPreset = (preset: FilterPreset) => onChange({ ...preset.filters });
  return <div className="search-toolbar"><input className="search-input" value={filters.query} onChange={(event) => update({ query: event.target.value })} placeholder={t('search.placeholder')} aria-label={t('search.button')} /><div className="search-filters">{showStatus && <select value={filters.status} onChange={(event) => update({ status: event.target.value as SearchFilters['status'] })} aria-label={t('filters.status')}><option value="ALL">{t('filters.allStatuses')}</option><option value="PENDING">{t('statuses.PENDING')}</option><option value="PUBLISHED">{t('statuses.PUBLISHED')}</option><option value="FAILED">{t('statuses.FAILED')}</option><option value="SKIPPED">{t('statuses.SKIPPED')}</option></select>}{banks.length > 0 && <select value={filters.bankId} onChange={(event) => update({ bankId: event.target.value })} aria-label={t('filters.allBanks')}><option value="">{t('filters.allBanks')}</option>{banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}</option>)}</select>}{sessionOptions.length > 0 && <select value={filters.sessionId} onChange={(event) => update({ sessionId: event.target.value })} aria-label={t('filters.allSessions')}><option value="">{t('filters.allSessions')}</option>{sessionOptions.map((session) => <option key={session.id} value={session.id}>{session.id.slice(0, 8)} · {t(`statuses.${session.status}`)}</option>)}</select>}<select value={filters.workspaceId} onChange={(event) => update({ workspaceId: event.target.value })} aria-label={t('filters.allWorkspaces')}><option value="*">{t('filters.allWorkspaces')}</option>{workspaces.filter((workspace) => !workspace.archived).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><input type="date" value={filters.dateFrom} onChange={(event) => update({ dateFrom: event.target.value })} aria-label={t('filters.from')} /><input type="date" value={filters.dateTo} onChange={(event) => update({ dateTo: event.target.value })} aria-label={t('filters.to')} /><button onClick={() => onChange({ ...emptySearchFilters, workspaceId: activeWorkspaceId })}>{t('filters.clear')}</button></div><div className="preset-row" role="toolbar" aria-label={t('presets.label')}>{presets.map((preset) => <span className="filter-preset-chip" key={preset.id}><button type="button" className="preset-apply" onClick={() => applyPreset(preset)} title={preset.name} aria-label={t('presets.apply', { name: preset.name })}>{preset.name}</button><button type="button" className="preset-remove" onClick={() => void handleDeletePreset(preset.id)} aria-label={t('presets.delete', { name: preset.name })}>×</button></span>)}{saveFormOpen ? <span className="preset-save-form"><input className="preset-name-input" value={presetName} onChange={(event) => setPresetName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void handleSavePreset(); } else if (event.key === 'Escape') { event.preventDefault(); closeSaveForm(); } }} placeholder={t('presets.namePlaceholder')} maxLength={MAX_FILTER_PRESET_NAME_LENGTH + 10} aria-label={t('presets.namePlaceholder')} dir="auto" /><button type="button" className="primary" onClick={() => void handleSavePreset()} disabled={!normalizePresetName(presetName)}>{t('actions.save')}</button><button type="button" onClick={closeSaveForm}>{t('actions.cancel')}</button></span> : <button type="button" className="preset-save-toggle" onClick={() => setSaveFormOpen(true)} disabled={!hasFilterSelection(filters)} title={t('presets.save')}>{t('presets.save')}</button>}</div></div>;
}

function StatusIndicator({ kind, value, label }: { kind: 'connection' | 'engine'; value: string; label: string }) { return <span className={`live-indicator ${kind}-indicator ${kind}-${value}`}><span className="live-dot" aria-hidden="true" />{label}</span>; }
function DiffReview({ diff, selectedIds, onToggle, onAdd, onDiscard }: { diff: BankDiffResult; selectedIds: string[]; onToggle: (id: string) => void; onAdd: () => void; onDiscard: () => void }) {
  const { t } = useI18n();
  const counts = diff.items.reduce<Record<string, number>>((result, item) => { result[item.category] = (result[item.category] ?? 0) + 1; return result; }, {});
  return <section className="diff-review"><div className="section-heading"><div><span className="eyebrow">{t('ui.refreshDiff')}</span><h3>{t('diff.title')}</h3></div><button onClick={onDiscard}>{t('diff.close')}</button></div><div className="diff-counts"><span>{t('diff.NEW')}: {counts.NEW ?? 0}</span><span>{t('diff.EXISTING')}: {counts.EXISTING ?? 0}</span><span>{t('diff.PREVIOUSLY_PUBLISHED')}: {counts.PREVIOUSLY_PUBLISHED ?? 0}</span><span>{t('diff.DUPLICATE')}: {diff.items.filter((item) => item.duplicateStatus === 'DUPLICATE').length}</span><span>{t('diff.PUBLISHED_DUPLICATE')}: {diff.items.filter((item) => item.duplicateStatus === 'PUBLISHED_DUPLICATE').length}</span><span>{t('diff.REMOVED')}: {counts.REMOVED ?? 0}</span><span>{t('diff.INVALID')}: {counts.INVALID ?? 0}</span></div><div className="diff-items">{diff.items.map((item) => item.category === 'NEW' ? <label className={`diff-item ${item.duplicateStatus === 'PUBLISHED_DUPLICATE' ? 'diff-published-duplicate' : item.duplicateStatus === 'DUPLICATE' ? 'diff-duplicate' : ''}`} key={item.id}><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => onToggle(item.id)} /><span><strong>{item.duplicateStatus === 'PUBLISHED_DUPLICATE' ? t('diff.previouslyPublishedContent') : item.duplicateStatus === 'DUPLICATE' ? t('diff.duplicateContent') : t('diff.NEW')}</strong><span dir="auto">{getTweetPreview(item.url, item.label || t('common.unlabeledPost'), 120)}</span><small dir="ltr">{item.url}</small>{item.duplicateOfWorkspaceId && <small>{t('diff.workspaceMatch')}: {item.duplicateOfWorkspaceId}</small>}</span></label> : <div className={`diff-item diff-${item.category.toLowerCase()}`} key={item.id}><span><strong>{t(`diff.${item.category}`)}</strong><span dir="auto">{getTweetPreview(item.url, item.label || t('common.unlabeledPost'), 120)}</span><small dir="ltr">{item.url}</small></span></div>)}{!diff.items.length && <p className="muted">{t('diff.unchanged')}</p>}</div><div className="diff-actions"><button className="primary" onClick={onAdd} disabled={!selectedIds.length}>{t('diff.addSelected')}</button><button onClick={onDiscard}>{t('diff.discard')}</button></div></section>;
}

function diffCategoryLabel(category: BankDiffItem['category']): string { return category; }

function BulkActionsBar({ selectedCount, banks, onAction }: { selectedCount: number; banks: TweetBank[]; onAction: (action: BulkQueueAction, bankId?: string) => void }) { const { t } = useI18n(); return <div className="bulk-actions"><strong>{t('bulk.selected', { count: selectedCount })}</strong><div className="bulk-buttons"><button onClick={() => onAction('SKIP')}>{t('common.skip')}</button><button onClick={() => onAction('RETRY')}>{t('common.retry')}</button><button onClick={() => onAction('RESET_PENDING')}>{t('common.resetPending')}</button><button onClick={() => onAction('MOVE_TOP')}>{t('common.moveTop')}</button><button onClick={() => onAction('MOVE_BOTTOM')}>{t('common.moveBottom')}</button><select defaultValue="" onChange={(event) => { if (event.target.value) onAction('ASSIGN_BANK', event.target.value); event.currentTarget.value = ''; }} aria-label={t('common.assignBank')}><option value="">{t('common.assignBank')}</option>{banks.filter((bank) => !bank.archived).map((bank) => <option key={bank.id} value={bank.id}>{bank.name}</option>)}</select><button onClick={() => onAction('EXPORT')}>{t('common.exportSelected')}</button><button className="danger" onClick={() => onAction('DELETE')}>{t('common.delete')}</button></div></div>; }

function QueueRow({ item, selected, onToggle, onAction }: { item: QueueItem; selected: boolean; onToggle: () => void; onAction: (message: RuntimeMessage, success?: string) => Promise<void> }) { const { t } = useI18n(); return <div className={`queue-row ${selected ? 'queue-row-selected' : ''}`}><input className="queue-select" type="checkbox" checked={selected} onChange={onToggle} aria-label={t('queue.selectItem', { position: item.position })} /><span className="position">{item.position}</span><div className="item-main"><div className="preview" dir="auto">{getTweetPreview(item.targetUrl, item.label || t('common.unlabeledPost'))}</div><a className="source-link" href={item.targetUrl} target="_blank" rel="noreferrer">{t('common.openLink')}</a><small>{t(`statuses.${item.status}`)} · {t('common.attempts')}: {item.attempts}{item.lastError ? ` · ${item.lastError}` : ''}</small></div><div className="item-actions"><button aria-label={t('common.moveUp')} onClick={() => void onAction({ type: 'REORDER', itemId: item.id, direction: 'up' })}>↑</button><button aria-label={t('common.moveDown')} onClick={() => void onAction({ type: 'REORDER', itemId: item.id, direction: 'down' })}>↓</button><button aria-label={t('common.retry')} onClick={() => void onAction({ type: 'RETRY_ITEM', itemId: item.id })}>↻</button><button aria-label={t('common.delete')} onClick={() => void onAction({ type: 'DELETE_ITEM', itemId: item.id })}>×</button></div></div>; }

createRoot(document.getElementById('root')!).render(<App />);
