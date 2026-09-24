export type QueueItemStatus = 'PENDING' | 'OPENING' | 'READY' | 'PUBLISHING' | 'PUBLISHED' | 'PUBLISHED_UNVERIFIED' | 'FAILED' | 'SKIPPED';
export type SessionStatus = 'IDLE' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'WAITING' | 'COMPLETED' | 'FAILED';
export type FailureBehavior = 'CONTINUE' | 'PAUSE';
export type DuplicatePolicy = 'BLOCK' | 'WARN' | 'ALLOW';
export type HistoricalSessionStatus = 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'WAITING' | 'COMPLETED' | 'STOPPED' | 'FAILED';

export interface QueueItem {
  id: string; workspaceId?: string; sourceBankId?: string; sourceBankUrl: string; targetUrl: string; label?: string; position: number;
  status: QueueItemStatus; attempts: number; createdAt: number; updatedAt: number; startedAt?: number;
  publishedAt?: number; lastError?: string; operationId?: string; publishIntentId?: string; publishStartedAt?: number; publishSubmittedAt?: number; contentFingerprint?: string; normalizedContent?: string; duplicateStatus?: 'UNIQUE' | 'DUPLICATE' | 'PUBLISHED_DUPLICATE'; duplicateOfItemId?: string;
}
export interface AutomationSession {
  id: string; workspaceId?: string; bankId?: string; bankUrl: string; status: SessionStatus; currentItemId?: string; currentIndex: number; total: number;
  startedAt?: number; scheduledStartAt?: number; pausedAt?: number; completedAt?: number; nextRunAt?: number; automationTabId?: number; timezone?: string;
  intervalMinutes: number; maxRetries: number; failureBehavior: FailureBehavior; confirmBeforeStart: boolean; alarmFailureCount?: number; lastAlarmError?: string;
  keepAutomationTabOpen: boolean; closeTabOnComplete: boolean; version: number; updatedAt: number; historicalSessionId?: string;
}
export interface LegacyPublishAttempt {
  id: string; workspaceId?: string; sessionId?: string; queueItemId: string; link: string; sourceUrl?: string; publishedPostUrl?: string; timestamp: number;
  attemptNumber: number; action: string; result: string; error?: string;
}
export interface HistoricalSession {
  id: string; workspaceId: string; bankId?: string; startedAt: number; pausedAt?: number; completedAt?: number;
  status: HistoricalSessionStatus; totalItems: number; publishedCount: number; failedCount: number; skippedCount: number;
  intervalMinutes: number; maxRetries: number; failureBehavior: FailureBehavior; createdAt: number; updatedAt: number; failureReason?: string;
}
export interface AppState { workspaceId?: string; queue: QueueItem[]; session: AutomationSession | null; history: LegacyPublishAttempt[]; }
export interface Workspace { id: string; name: string; description: string; color?: string; icon?: string; favorite: boolean; archived: boolean; automationProfile?: Partial<import('./scheduling').WorkspaceAutomationProfile>; createdAt: number; updatedAt: number; lastActivityAt: number; }
export interface TweetBank { id: string; workspaceId: string; name: string; description?: string; url: string; favorite: boolean; archived: boolean; createdAt: number; updatedAt: number; lastExtractedAt?: number; lastExtractedCount?: number; lastSnapshot?: BankSnapshotItem[]; lastSnapshotAt?: number; }
export interface BankSnapshotItem { url: string; label?: string; contentFingerprint?: string; normalizedContent?: string; }
export type BankDiffCategory = 'NEW' | 'EXISTING' | 'PREVIOUSLY_PUBLISHED' | 'REMOVED' | 'INVALID';
export interface BankDiffItem extends BankSnapshotItem { id: string; category: BankDiffCategory; existingQueueItemId?: string; duplicateStatus?: 'UNIQUE' | 'DUPLICATE' | 'PUBLISHED_DUPLICATE'; duplicateOfWorkspaceId?: string; reason?: string; }
export interface BankDiffResult { workspaceId: string; bankId: string; refreshedAt: number; items: BankDiffItem[]; selectedNewIds: string[]; }
export interface WorkspaceState extends AppState { workspaceId: string; workspace: Workspace; banks: TweetBank[]; historicalSessions: HistoricalSession[]; }
export interface Settings { intervalMinutes: number; maxRetries: number; failureBehavior: FailureBehavior; confirmBeforeStart: boolean; keepAutomationTabOpen: boolean; closeTabOnComplete: boolean; duplicatePolicy: DuplicatePolicy; publishingWindows: import('./scheduling').PublishingWindow[]; timezone: string; notificationsEnabled: boolean; badgeMode: import('./scheduling').BadgeMode; }
export interface AppMetaState { schemaVersion: 2 | 3 | 4; activeWorkspaceId: string; automationWorkspaceId?: string; workspaceOrder: string[]; globalSettings: Settings; appVersion?: string; createdAt?: number; updatedAt?: number; }
export interface AppMetadata { schemaVersion: 4; appVersion: string; activeWorkspaceId: string; automationWorkspaceId?: string; workspaceOrder: string[]; createdAt: number; updatedAt: number; }
export interface GlobalSettings extends Settings { updatedAt: number; }
export interface WorkspaceSettings { workspaceId: string; overrides: Partial<Omit<Settings, 'updatedAt'>>; createdAt: number; updatedAt: number; }
export interface AutomationSessionRuntime { workspaceId: string; sessionId: string; bankId?: string; bankUrl?: string; status: SessionStatus; currentItemId?: string; currentIndex: number; total: number; startedAt?: number; scheduledStartAt?: number; pausedAt?: number; completedAt?: number; nextRunAt?: number; automationTabId?: number; alarmName?: string; operationId?: string; alarmFailureCount?: number; lastAlarmError?: string; updatedAt: number; version: number; }
export interface AutomationSessionRecord extends HistoricalSession { scheduledStartAt?: number; timezone: string; }
export interface BankSnapshot { id: string; bankId: string; workspaceId: string; capturedAt: number; items: BankSnapshotItem[]; }
export interface PublishAttempt extends Omit<LegacyPublishAttempt, 'link' | 'action' | 'result' | 'error'> { targetUrl?: string; link?: string; sourceUrl?: string; publishedPostUrl?: string; action: string; result: string; error?: string; errorCode?: string; errorMessage?: string; durationMs?: number; adapter?: string; }
export interface LegacyPublishAttempt { id: string; workspaceId?: string; sessionId?: string; queueItemId: string; link: string; sourceUrl?: string; publishedPostUrl?: string; timestamp: number; attemptNumber: number; action: string; result: string; error?: string; }
export const defaultSettings: Settings = { intervalMinutes: 2, maxRetries: 2, failureBehavior: 'CONTINUE', confirmBeforeStart: true, keepAutomationTabOpen: true, closeTabOnComplete: false, duplicatePolicy: 'BLOCK', publishingWindows: [], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', notificationsEnabled: true, badgeMode: 'COUNT' };
export type AutomationConnection = 'CONNECTED' | 'DISCONNECTED' | 'NOT_REQUIRED';
export interface RuntimeStatus { engineStatus: SessionStatus; connection: AutomationConnection; automationTabId?: number; automationWorkspaceId?: string; checkedAt: number; }
export interface PreflightResult { ready: boolean; checkedAt: number; workspaceId: string; summaryKey: string; summaryParams: Record<string, string | number>; checks: Array<{ id: string; status: 'PASS' | 'WARN' | 'FAIL'; messageKey: string; detailsKey?: string; params?: Record<string, string | number>; blocking: boolean }>; counts: { total: number; ready: number; published: number; failed: number; skipped: number; duplicates: number; publishedDuplicates: number; invalid: number }; }
export type DryRunItemStatus = 'READY' | 'LOGIN_REQUIRED' | 'CONTENT_MISSING' | 'POST_BUTTON_NOT_FOUND' | 'INVALID_URL' | 'CHALLENGE_DETECTED' | 'ERROR';
export type DryRunMode = 'FIRST_ITEM' | 'ENTIRE_QUEUE';
export type DryRunSessionStatus = 'RUNNING' | 'COMPLETED' | 'STOPPED' | 'FAILED';
export interface DryRunItemResult { queueItemId: string; position: number; targetUrl: string; status: DryRunItemStatus; checkedAt: number; durationMs: number; pageKind: ContentInspection['pageKind']; composerFound: boolean; contentPresent: boolean; postButtonFound: boolean; postButtonEnabled: boolean; reason?: string; error?: string; }
export interface DryRunResult { id: string; workspaceId?: string; mode: DryRunMode; status: DryRunSessionStatus; startedAt: number; completedAt?: number; currentItemId?: string; total: number; checked: number; ready: number; failed: number; items: DryRunItemResult[]; error?: string; }
export interface BackupEnvelope { format: 'x-pilot-backup'; formatVersion: 1 | 2; appVersion: string; createdAt: number; meta: AppMetaState; globalSettings?: Settings; workspaceSettings?: WorkspaceSettings[]; workspaces: WorkspaceState[]; sessionRecords?: AutomationSessionRecord[]; attempts?: PublishAttempt[]; }
export interface BackupSummary { workspaceCount: number; bankCount: number; queueCount: number; historyCount: number; historicalSessionCount: number; createdAt: number; }
export interface BackupValidation { valid: boolean; summary?: BackupSummary; errors: string[]; }
export type BulkQueueAction = 'DELETE' | 'SKIP' | 'RETRY' | 'RESET_PENDING' | 'MOVE_TOP' | 'MOVE_BOTTOM' | 'ASSIGN_BANK' | 'EXPORT';
export interface BulkActionResult { action: BulkQueueAction; requestedIds: string[]; affectedIds: string[]; rejectedIds: string[]; activeItemId?: string; exportedItems?: QueueItem[]; }
export type DiagnosticsCheckStatus = 'OK' | 'WARN' | 'FAIL' | 'NOT_CHECKED';
export interface DiagnosticsCheck { id: string; label: string; labelKey?: string; status: DiagnosticsCheckStatus; message: string; details?: string; detailsKey?: string; }
export interface DiagnosticsResult { checkedAt: number; extensionVersion: string; schemaVersion: AppMetaState['schemaVersion'] | 'UNKNOWN'; activeWorkspaceId?: string; automationWorkspaceId?: string; runningSession?: { id: string; status: SessionStatus; currentItemId?: string }; alarm?: { name: string; scheduledTime?: number; periodInMinutes?: number }; automationTabId?: number; checks: DiagnosticsCheck[]; safe: boolean; }
export interface BankImportOutcome { workspaceId: string; importedCount: number; importedNames: string[]; }
export interface StartOverResult extends AppState { resetCount: number; }
export type RuntimeMessage =
  | { type: 'GET_STATE' } | { type: 'GET_WORKSPACES' } | { type: 'GET_WORKSPACE_STATE'; workspaceId?: string } | { type: 'GET_SESSION_HISTORY'; workspaceId?: string } | { type: 'PREFLIGHT_CHECK'; workspaceId?: string } | { type: 'RUN_DIAGNOSTICS' }
  | { type: 'CREATE_WORKSPACE'; name: string; description?: string; color?: string; icon?: string } | { type: 'UPDATE_WORKSPACE_PROFILE'; workspaceId: string; profile: Partial<Settings> } | { type: 'CLEAR_WORKSPACE_PROFILE'; workspaceId: string }
  | { type: 'UPDATE_WORKSPACE'; workspaceId: string; patch: Partial<Pick<Workspace, 'name' | 'description' | 'color' | 'icon' | 'favorite'>> }
  | { type: 'ARCHIVE_WORKSPACE'; workspaceId: string } | { type: 'RESTORE_WORKSPACE'; workspaceId: string } | { type: 'DELETE_WORKSPACE'; workspaceId: string; confirmed: boolean }
  | { type: 'SET_ACTIVE_WORKSPACE'; workspaceId: string } | { type: 'GET_RUNTIME_STATUS' } | { type: 'GET_BANKS'; workspaceId?: string }
  | { type: 'CREATE_BANK'; workspaceId?: string; name: string; url: string; description?: string } | { type: 'UPDATE_BANK'; workspaceId?: string; bankId: string; patch: Partial<Pick<TweetBank, 'name' | 'description' | 'url' | 'favorite'>> }
  | { type: 'ARCHIVE_BANK'; workspaceId?: string; bankId: string } | { type: 'RESTORE_BANK'; workspaceId?: string; bankId: string } | { type: 'DELETE_BANK'; workspaceId?: string; bankId: string; confirmed: boolean }
  | { type: 'EXTRACT_BANK'; bankId?: string; bankUrl: string; workspaceId?: string; mode?: 'REPLACE' | 'APPEND' } | { type: 'REFRESH_BANK'; workspaceId?: string; bankId: string } | { type: 'GET_BANK_DIFF'; workspaceId?: string; bankId: string } | { type: 'ADD_DIFF_ITEMS'; workspaceId?: string; bankId: string; itemIds: string[] } | { type: 'DISCARD_BANK_DIFF'; workspaceId?: string; bankId: string }
  | { type: 'EXPORT_BANKS'; workspaceId?: string; bankIds: string[] } | { type: 'IMPORT_BANKS'; workspaceId?: string; payload: unknown }
  | { type: 'START'; confirmed?: boolean; workspaceId?: string } | { type: 'RECOVERY_START_OVER' } | { type: 'SCHEDULE'; startAt: number; workspaceId?: string } | { type: 'RESCHEDULE'; startAt: number; workspaceId?: string } | { type: 'CANCEL_SCHEDULE'; workspaceId?: string } | { type: 'PAUSE'; workspaceId?: string } | { type: 'RESUME'; workspaceId?: string } | { type: 'STOP'; workspaceId?: string } | { type: 'DRY_RUN_FIRST'; workspaceId?: string } | { type: 'DRY_RUN_QUEUE'; workspaceId?: string } | { type: 'DRY_RUN_STOP' } | { type: 'GET_DRY_RUN' }
  | { type: 'EXPORT_BACKUP' } | { type: 'VALIDATE_BACKUP'; backup: unknown } | { type: 'RESTORE_BACKUP'; backup: unknown; confirmed: boolean }
  | { type: 'SKIP_CURRENT' } | { type: 'RETRY_ITEM'; itemId: string } | { type: 'REORDER'; itemId: string; direction: 'up' | 'down' } | { type: 'DELETE_ITEM'; itemId: string } | { type: 'CLEAR_COMPLETED' } | { type: 'BULK_ACTION'; action: BulkQueueAction; itemIds: string[]; workspaceId?: string; bankId?: string; confirmed?: boolean } | { type: 'UPDATE_SETTINGS'; settings: Settings; workspaceId?: string };
export type ContentMessage = { type: 'X_INSPECT' } | { type: 'X_PUBLISH' } | { type: 'X_GET_PUBLISHED_URL' };
export interface ContentInspection { ok: boolean; pageKind: 'X' | 'LOGIN' | 'CHALLENGE' | 'ERROR' | 'UNKNOWN'; composerFound: boolean; contentPresent: boolean; postButtonFound: boolean; postButtonEnabled: boolean; reason?: string; dailyPostLimitReached?: boolean; }

export function historicalStatus(status: SessionStatus): HistoricalSessionStatus | undefined {
  return status === 'IDLE' ? undefined : status;
}
export function queueCounters(queue: QueueItem[]) {
  return {
    publishedCount: queue.filter((item) => item.status === 'PUBLISHED' || item.status === 'PUBLISHED_UNVERIFIED').length,
    failedCount: queue.filter((item) => item.status === 'FAILED').length,
    skippedCount: queue.filter((item) => item.status === 'SKIPPED').length,
  };
}
export function createHistoricalSession(session: AutomationSession, queue: QueueItem[], id = crypto.randomUUID()): HistoricalSession {
  const now = Date.now();
  return {
    id, workspaceId: session.workspaceId ?? '', startedAt: session.startedAt ?? now, status: historicalStatus(session.status) ?? 'RUNNING',
    totalItems: queue.length, ...queueCounters(queue), intervalMinutes: session.intervalMinutes, maxRetries: session.maxRetries,
    failureBehavior: session.failureBehavior, createdAt: now, updatedAt: now,
  };
}
