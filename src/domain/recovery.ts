import type { AppState, AutomationSession, HistoricalSession, PublishAttempt, QueueItem } from './models';

const interruptedStatuses = new Set(['OPENING', 'READY', 'PUBLISHING']);
const terminalStatuses = new Set(['PUBLISHED', 'PUBLISHED_UNVERIFIED', 'SKIPPED']);

function isTerminalItem(status: QueueItem['status']): boolean {
  return terminalStatuses.has(status);
}

function getNextPendingItem(queue: QueueItem[], excludedItemId?: string): QueueItem | undefined {
  return [...queue].filter((item) => item.id !== excludedItemId && item.status === 'PENDING').sort((left, right) => left.position - right.position)[0];
}

function recoverQueueItem(item: QueueItem, now: number): QueueItem {
  if (!interruptedStatuses.has(item.status)) return item;
  if (item.status === 'PUBLISHING') {
    return {
      ...item,
      status: 'PUBLISHED_UNVERIFIED',
      publishedAt: item.publishedAt ?? now,
      operationId: undefined,
      lastError: item.lastError ?? 'PUBLISH_OUTCOME_UNVERIFIED_AFTER_RESTART',
      updatedAt: now,
    };
  }
  return {
    ...item,
    status: 'PENDING',
    operationId: undefined,
    lastError: item.lastError ?? 'RECOVERED_AFTER_RESTART',
    updatedAt: now
  };
}

export function normalizeRecovery(state: AppState, now = Date.now()): AppState {
  if (!state.session) return state;
  const queue = state.queue.map((item) => recoverQueueItem(item, now));
  let session = { ...state.session, updatedAt: now };
  const current = session.currentItemId ? queue.find((item) => item.id === session.currentItemId) : undefined;
  const next = getNextPendingItem(queue, current?.id);

  if (session.status === 'RUNNING') {
    if (current?.status === 'PUBLISHED_UNVERIFIED') {
      session = { ...session, status: 'PAUSED', pausedAt: now, nextRunAt: undefined, currentItemId: current.id, currentIndex: current.position, lastAlarmError: 'PUBLISH_OUTCOME_UNVERIFIED_AFTER_RESTART' };
      return { ...state, queue, session };
    }
    const resumable = current && !isTerminalItem(current.status) ? current : next;
    session = resumable
      ? { ...session, status: 'PAUSED', pausedAt: now, nextRunAt: undefined, currentItemId: resumable.id, currentIndex: resumable.position }
      : { ...session, status: 'COMPLETED', completedAt: now, nextRunAt: undefined, currentItemId: undefined };
  } else if (session.status === 'WAITING' && (!session.nextRunAt || session.nextRunAt <= now)) {
    const resumable = current && !isTerminalItem(current.status) ? current : next;
    session = resumable
      ? { ...session, status: 'PAUSED', pausedAt: now, nextRunAt: undefined, currentItemId: resumable.id, currentIndex: resumable.position }
      : { ...session, status: 'COMPLETED', completedAt: now, nextRunAt: undefined, currentItemId: undefined };
  } else if (session.status === 'PAUSED' && (!current || isTerminalItem(current.status))) {
    session = next
      ? { ...session, currentItemId: next.id, currentIndex: next.position }
      : { ...session, status: 'COMPLETED', completedAt: now, nextRunAt: undefined, currentItemId: undefined };
  } else if (session.status === 'SCHEDULED' && session.scheduledStartAt && session.scheduledStartAt <= now) {
    const resumable = current && !isTerminalItem(current.status) ? current : next;
    session = resumable
      ? { ...session, status: 'PAUSED', pausedAt: now, scheduledStartAt: undefined, nextRunAt: undefined, currentItemId: resumable.id, currentIndex: resumable.position, lastAlarmError: 'SCHEDULED_START_MISSED_AFTER_RESTART' }
      : { ...session, status: 'COMPLETED', completedAt: now, scheduledStartAt: undefined, nextRunAt: undefined, currentItemId: undefined };
  }

  return { ...state, queue, session };
}

export function hasFutureRecoveryAlarm(state: AppState, now = Date.now()): boolean {
  return state.session?.status === 'WAITING' && Boolean(state.session.nextRunAt && state.session.nextRunAt > now);
}

/**
 * Grace window before a past-due SCHEDULED start is considered missed.
 * Chrome fires `when`-based alarms shortly after their time; the grace period
 * avoids racing an alarm that is about to fire while the browser is running.
 */
export const MISSED_SCHEDULE_GRACE_MS = 2 * 60 * 1000;

/**
 * Detects a SCHEDULED session whose start time passed beyond the grace window
 * while the service worker is alive (alarm lost or never delivered). This is a
 * pure, read-only check — it never mutates state and never starts publishing.
 * The user must explicitly choose an action (Start now / Reschedule / Cancel).
 */
export function detectMissedSchedule(session: Pick<AutomationSession, 'status' | 'scheduledStartAt'> | null | undefined, now: number, graceMs = MISSED_SCHEDULE_GRACE_MS): boolean {
  if (!session || session.status !== 'SCHEDULED') return false;
  if (!session.scheduledStartAt || !Number.isFinite(session.scheduledStartAt)) return false;
  return session.scheduledStartAt < now - graceMs;
}

const resettableStatuses = new Set<QueueItem['status']>(['FAILED', 'OPENING', 'READY']);

function clearPublishTracking(item: QueueItem, now: number): QueueItem {
  return {
    ...item,
    status: 'PENDING',
    attempts: 0,
    lastError: undefined,
    operationId: undefined,
    publishIntentId: undefined,
    publishStartedAt: undefined,
    publishSubmittedAt: undefined,
    startedAt: undefined,
    publishedAt: undefined,
    updatedAt: now,
  };
}

/**
 * Builds the queue for an explicit user-initiated Start Over.
 * Safety invariants (must never be violated):
 * - PUBLISHED, PUBLISHED_UNVERIFIED, and SKIPPED items are returned untouched.
 * - PUBLISHING is converted to PUBLISHED_UNVERIFIED (never re-pending) because
 *   the publish outcome is unknown.
 * - FAILED, OPENING, and READY items are reset to PENDING with a clean slate.
 * - Positions, content fingerprints, and duplicate metadata are preserved.
 */
export function buildStartOverQueue(queue: QueueItem[], now = Date.now()): QueueItem[] {
  return queue.map((item) => {
    if (resettableStatuses.has(item.status)) return clearPublishTracking(item, now);
    if (item.status === 'PUBLISHING') {
      return {
        ...item,
        status: 'PUBLISHED_UNVERIFIED',
        publishedAt: item.publishedAt ?? now,
        operationId: undefined,
        lastError: item.lastError ?? 'PUBLISH_OUTCOME_UNVERIFIED_AFTER_RESTART',
        updatedAt: now,
      };
    }
    return item;
  });
}

export function countStartOverResets(queue: QueueItem[]): number {
  return queue.filter((item) => resettableStatuses.has(item.status)).length;
}

/**
 * Repairs historical-session linkage for data written by versions where the
 * analytical record id diverged from the runtime session id.
 *
 * Background: attempt entries are keyed `sessionId = runtime session id`,
 * while the historical record used to receive a fresh UUID — and
 * `sessionFromRuntime` fabricates `historicalSessionId = runtime.sessionId`
 * after every storage round-trip. Result: every attempt row was orphaned
 * (no record shared its sessionId) and every record was empty while its
 * attempts existed right beside it. The data was never lost — only the link.
 *
 * Repair strategy (pure, conservative, idempotent — never deletes anything):
 * 1. Active-session rule — the LIVE session id is authoritative. If exactly
 *    one zero-attempt record sits in an active-ish status (RUNNING/WAITING/
 *    PAUSED), it is the shell created at start: re-link it by renaming it to
 *    the live session id.
 * 2. Window rule — an orphaned attempt group belongs to the unique
 *    zero-attempt terminal record whose [startedAt, completedAt] window
 *    contains the group's [first, last] attempt timestamps.
 * Ambiguous pairings (zero or multiple candidates) are left untouched —
 * honesty over guesswork. Record ids are renamed instead of mutating attempts
 * because nothing else references a record id, while attempt ids are pinned
 * in exports and the UI.
 */
export interface SessionHistoryRepairInput {
  sessions: Array<Pick<HistoricalSession, 'id' | 'status' | 'startedAt'> & Partial<Pick<HistoricalSession, 'completedAt'>>>;
  history: Array<Pick<PublishAttempt, 'sessionId' | 'timestamp'>>;
  activeSessionId?: string;
}

export interface SessionHistoryRepairResult {
  sessions: SessionHistoryRepairInput['sessions'];
  /** Record ids that were re-linked (renamed) to their attempt session ids. */
  repairedSessionIds: string[];
}

const ACTIVE_RECORD_STATUSES = new Set(['RUNNING', 'WAITING', 'PAUSED']);

export function repairSessionHistoryLinks(input: SessionHistoryRepairInput): SessionHistoryRepairResult {
  const sessions = input.sessions.map((session) => ({ ...session }));
  const repairedSessionIds: string[] = [];
  const recordIds = new Set(sessions.map((session) => session.id));

  // Attempts backing each record id (a record with backing data is healthy).
  const backingCount = new Map<string, number>();
  for (const attempt of input.history) {
    if (!attempt.sessionId) continue;
    backingCount.set(attempt.sessionId, (backingCount.get(attempt.sessionId) ?? 0) + 1);
  }

  // Group orphaned attempts: sessionId matches no record id.
  const orphanedGroups = new Map<string, number[]>();
  for (const attempt of input.history) {
    if (!attempt.sessionId || recordIds.has(attempt.sessionId)) continue;
    const timestamps = orphanedGroups.get(attempt.sessionId) ?? [];
    if (Number.isFinite(attempt.timestamp)) timestamps.push(attempt.timestamp);
    orphanedGroups.set(attempt.sessionId, timestamps);
  }

  // Rule 1 — adopt the active session's shell record.
  if (input.activeSessionId && orphanedGroups.has(input.activeSessionId) && !recordIds.has(input.activeSessionId)) {
    const shells = sessions.filter((session) => ACTIVE_RECORD_STATUSES.has(session.status) && !(backingCount.get(session.id) ?? 0));
    if (shells.length === 1) {
      const shell = shells[0];
      const renamed = sessions.map((session) => session === shell ? { ...session, id: input.activeSessionId! } : session);
      sessions.length = 0;
      sessions.push(...renamed);
      recordIds.delete(shell.id);
      recordIds.add(input.activeSessionId);
      orphanedGroups.delete(input.activeSessionId);
      repairedSessionIds.push(input.activeSessionId);
    }
  }

  // Rule 2 — pair orphaned groups to unique terminal zero-attempt records by time window.
  const availableShells = new Set(sessions.filter((session) => !ACTIVE_RECORD_STATUSES.has(session.status) && !(backingCount.get(session.id) ?? 0)).map((session) => session.id));
  for (const [sessionId, timestamps] of orphanedGroups) {
    if (!timestamps.length || recordIds.has(sessionId)) continue;
    const first = Math.min(...timestamps);
    const last = Math.max(...timestamps);
    const candidates = [...availableShells].map((id) => sessions.find((session) => session.id === id)!).filter((session) =>
      session.startedAt <= first && typeof session.completedAt === 'number' && last <= session.completedAt);
    if (candidates.length !== 1) continue;
    const shell = candidates[0];
    const renamed = sessions.map((session) => session === shell ? { ...session, id: sessionId } : session);
    sessions.length = 0;
    sessions.push(...renamed);
    availableShells.delete(shell.id);
    recordIds.add(sessionId);
    repairedSessionIds.push(sessionId);
  }

  return { sessions, repairedSessionIds };
}
