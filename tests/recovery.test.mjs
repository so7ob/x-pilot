import test from 'node:test';
import assert from 'node:assert/strict';
import { hasFutureRecoveryAlarm, normalizeRecovery, buildStartOverQueue, countStartOverResets, detectMissedSchedule, MISSED_SCHEDULE_GRACE_MS } from '../src/domain/recovery.ts';

const item = (id, position, status) => ({
  id,
  position,
  status,
  sourceBankUrl: 'https://bank.example',
  targetUrl: `https://x.com/intent/post?text=${id}`,
  attempts: 1,
  createdAt: 1,
  updatedAt: 1,
  operationId: status === 'OPENING' ? 'stale-operation' : undefined
});

const session = (status, currentItemId, nextRunAt) => ({
  id: 'session',
  bankUrl: 'https://bank.example',
  status,
  currentItemId,
  currentIndex: 1,
  total: 3,
  nextRunAt,
  intervalMinutes: 2,
  maxRetries: 2,
  failureBehavior: 'CONTINUE',
  confirmBeforeStart: true,
  keepAutomationTabOpen: true,
  closeTabOnComplete: false,
  version: 1,
  updatedAt: 1
});

test('normalizes interrupted items to pending and pauses a running session', () => {
  const state = { queue: [item('one', 1, 'OPENING'), item('two', 2, 'PENDING')], session: session('RUNNING', 'one'), history: [] };
  const recovered = normalizeRecovery(state, 100);
  assert.equal(recovered.queue[0].status, 'PENDING');
  assert.equal(recovered.queue[0].operationId, undefined);
  assert.equal(recovered.queue[0].lastError, 'RECOVERED_AFTER_RESTART');
  assert.equal(recovered.session.status, 'PAUSED');
  assert.equal(recovered.session.currentItemId, 'one');
});

test('keeps a future waiting session waiting and exposes one recoverable alarm', () => {
  const state = { queue: [item('one', 1, 'PUBLISHED'), item('two', 2, 'PENDING')], session: session('WAITING', 'two', 2_000), history: [] };
  const recovered = normalizeRecovery(state, 1_000);
  assert.equal(recovered.session.status, 'WAITING');
  assert.equal(hasFutureRecoveryAlarm(recovered, 1_000), true);
});

test('expired waiting state becomes paused instead of auto-publishing', () => {
  const state = { queue: [item('one', 1, 'PENDING')], session: session('WAITING', 'one', 900), history: [] };
  const recovered = normalizeRecovery(state, 1_000);
  assert.equal(recovered.session.status, 'PAUSED');
  assert.equal(recovered.session.nextRunAt, undefined);
});

test('published items are never re-queued during recovery', () => {
  const state = { queue: [item('published', 1, 'PUBLISHED')], session: session('PAUSED', 'published'), history: [] };
  const recovered = normalizeRecovery(state, 100);
  assert.equal(recovered.queue[0].status, 'PUBLISHED');
  assert.equal(recovered.session.status, 'COMPLETED');
});

test('start over resets failed and interrupted items to a clean pending state', () => {
  const now = 5_000;
  const failed = { ...item('failed', 1, 'FAILED'), attempts: 3, lastError: 'SOME_ERROR', publishIntentId: 'intent-1', publishStartedAt: 10, publishSubmittedAt: 11, publishedAt: 12 };
  const opening = { ...item('opening', 2, 'OPENING'), operationId: 'stale-operation' };
  const ready = item('ready', 3, 'READY');
  const queue = buildStartOverQueue([failed, opening, ready], now);
  for (const reset of queue) {
    assert.equal(reset.status, 'PENDING');
    assert.equal(reset.attempts, 0);
    assert.equal(reset.lastError, undefined);
    assert.equal(reset.operationId, undefined);
    assert.equal(reset.publishIntentId, undefined);
    assert.equal(reset.updatedAt, now);
  }
  assert.equal(countStartOverResets([failed, opening, ready]), 3);
});

test('start over never re-queues published, unverified, or skipped items', () => {
  const now = 5_000;
  const published = item('published', 1, 'PUBLISHED');
  const unverified = { ...item('unverified', 2, 'PUBLISHED_UNVERIFIED'), publishedAt: 4_000 };
  const skipped = item('skipped', 3, 'SKIPPED');
  const publishing = item('publishing', 4, 'PUBLISHING');
  const queue = buildStartOverQueue([published, unverified, skipped, publishing], now);
  assert.equal(queue[0].status, 'PUBLISHED');
  assert.equal(queue[1].status, 'PUBLISHED_UNVERIFIED');
  assert.equal(queue[1].publishedAt, 4_000, 'existing unverified publish time is preserved');
  assert.equal(queue[2].status, 'SKIPPED');
  assert.equal(queue[3].status, 'PUBLISHED_UNVERIFIED', 'PUBLISHING is converted to PUBLISHED_UNVERIFIED, never PENDING');
  assert.equal(queue[3].lastError, 'PUBLISH_OUTCOME_UNVERIFIED_AFTER_RESTART');
  assert.equal(countStartOverResets([published, unverified, skipped, publishing]), 0);
});

test('start over preserves positions, fingerprints, and duplicate metadata', () => {
  const now = 5_000;
  const source = { ...item('keep', 7, 'FAILED'), contentFingerprint: 'fp-7', normalizedContent: 'محتوى', duplicateStatus: 'UNIQUE' };
  const [reset] = buildStartOverQueue([source], now);
  assert.equal(reset.position, 7);
  assert.equal(reset.contentFingerprint, 'fp-7');
  assert.equal(reset.normalizedContent, 'محتوى');
  assert.equal(reset.duplicateStatus, 'UNIQUE');
  assert.equal(reset.targetUrl, source.targetUrl);
});

test('detectMissedSchedule ignores future scheduled starts', () => {
  const now = 10_000_000;
  assert.equal(detectMissedSchedule({ status: 'SCHEDULED', scheduledStartAt: now + 60_000 }, now), false);
});

test('detectMissedSchedule stays quiet within the grace window (alarm may still fire)', () => {
  const now = 10_000_000;
  assert.equal(detectMissedSchedule({ status: 'SCHEDULED', scheduledStartAt: now - 30_000 }, now), false);
  assert.equal(detectMissedSchedule({ status: 'SCHEDULED', scheduledStartAt: now - MISSED_SCHEDULE_GRACE_MS }, now), false);
});

test('detectMissedSchedule flags past-due starts beyond the grace window', () => {
  const now = 10_000_000;
  assert.equal(detectMissedSchedule({ status: 'SCHEDULED', scheduledStartAt: now - MISSED_SCHEDULE_GRACE_MS - 1 }, now), true);
  assert.equal(detectMissedSchedule({ status: 'SCHEDULED', scheduledStartAt: now - 3 * 60 * 60 * 1000 }, now), true);
});

test('detectMissedSchedule only ever applies to SCHEDULED sessions with a valid timestamp', () => {
  const now = 10_000_000;
  const past = now - MISSED_SCHEDULE_GRACE_MS - 5_000;
  assert.equal(detectMissedSchedule({ status: 'PAUSED', scheduledStartAt: past }, now), false);
  assert.equal(detectMissedSchedule({ status: 'RUNNING', scheduledStartAt: undefined }, now), false);
  assert.equal(detectMissedSchedule({ status: 'WAITING', scheduledStartAt: past }, now), false);
  assert.equal(detectMissedSchedule({ status: 'SCHEDULED', scheduledStartAt: undefined }, now), false);
  assert.equal(detectMissedSchedule({ status: 'SCHEDULED', scheduledStartAt: Number.NaN }, now), false);
  assert.equal(detectMissedSchedule(null, now), false);
  assert.equal(detectMissedSchedule(undefined, now), false);
});
