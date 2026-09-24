import type { AppState, AutomationSession, QueueItem } from './models';

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
