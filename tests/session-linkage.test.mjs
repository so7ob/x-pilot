/**
 * Session linkage — the invariant that makes the analytical session log real:
 * every publish-attempt entry (sessionId = runtime session id) must match its
 * historical session record, and every analytical field must survive the v4
 * storage round-trip (tweet label, bank, position, duration, published link,
 * adapter) — including PAUSED results, which are a legitimate outcome and must
 * not be coerced to FAILED.
 *
 * Also covers repairSessionHistoryLinks: re-links pre-1.13.1 records whose id
 * diverged from the runtime session id (conservative, idempotent, never
 * deletes, ambiguous pairings left untouched).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoricalSession } from '../src/domain/models.ts';
import { repairSessionHistoryLinks } from '../src/domain/recovery.ts';
import { fromV4Attempt, toV4Attempt } from '../src/storage/storage-repository.ts';

const baseSession = (overrides = {}) => ({
  id: 'session-1', workspaceId: 'ws-1', bankId: 'bank-1', bankUrl: 'https://x.com/bank', status: 'RUNNING',
  currentIndex: 0, total: 2, startedAt: 1_000, intervalMinutes: 2, maxRetries: 2, failureBehavior: 'CONTINUE',
  confirmBeforeStart: true, keepAutomationTabOpen: true, closeTabOnComplete: false, version: 1, updatedAt: 1_000,
  ...overrides,
});

const queueItem = (id, status = 'PENDING') => ({
  id, workspaceId: 'ws-1', sourceBankId: 'bank-1', sourceBankUrl: 'https://x.com/bank', targetUrl: `https://x.com/home/${id}`,
  position: 1, status, attempts: 0, createdAt: 900, updatedAt: 900,
});

test('createHistoricalSession defaults its id to the runtime session id', () => {
  const session = baseSession();
  const record = createHistoricalSession(session, [queueItem('q1')]);
  assert.equal(record.id, 'session-1');
  assert.equal(record.status, 'RUNNING');
  assert.equal(record.totalItems, 1);
});

test('createHistoricalSession still honours an explicit id override', () => {
  const record = createHistoricalSession(baseSession(), [queueItem('q1')], 'custom-id');
  assert.equal(record.id, 'custom-id');
});

const analyticalAttempt = {
  id: 'att-1', sessionId: 'session-1', queueItemId: 'q1', link: 'https://x.com/home/1', sourceUrl: 'https://x.com/home/1',
  publishedPostUrl: 'https://x.com/i/web/status/199', timestamp: 1_500, attemptNumber: 1, action: 'PUBLISH',
  result: 'PUBLISHED', tweetLabel: 'أهلاً بالعالم', bankId: 'bank-1', bankName: 'بنك الإطلاق', itemPosition: 3,
  durationMs: 9_400, adapter: 'x',
};

test('v4 round-trip preserves every analytical attempt field', () => {
  const persisted = toV4Attempt(analyticalAttempt, 'ws-1');
  assert.equal(persisted.publishedPostUrl, 'https://x.com/i/web/status/199');
  assert.equal(persisted.tweetLabel, 'أهلاً بالعالم');
  assert.equal(persisted.bankId, 'bank-1');
  assert.equal(persisted.bankName, 'بنك الإطلاق');
  assert.equal(persisted.itemPosition, 3);
  assert.equal(persisted.durationMs, 9_400);
  assert.equal(persisted.adapter, 'x');
  assert.equal(persisted.sourceUrl, 'https://x.com/home/1');

  const restored = fromV4Attempt(persisted, 'ws-1');
  assert.deepEqual(restored, { ...analyticalAttempt, workspaceId: 'ws-1', error: undefined });
});

test('v4 round-trip keeps PAUSED results instead of coercing them to FAILED', () => {
  const paused = { ...analyticalAttempt, result: 'PAUSED', publishedPostUrl: undefined };
  const persisted = toV4Attempt(paused, 'ws-1');
  assert.equal(persisted.result, 'PAUSED');
  assert.equal(fromV4Attempt(persisted, 'ws-1').result, 'PAUSED');
});

test('v4 round-trip still sanitizes truly unknown results to FAILED', () => {
  const weird = { ...analyticalAttempt, result: 'SOMETHING_ELSE' };
  assert.equal(toV4Attempt(weird, 'ws-1').result, 'FAILED');
});

test('v4 round-trip tolerates legacy rows without analytical fields', () => {
  const bare = { id: 'att-2', sessionId: 'session-1', queueItemId: 'q2', link: '', timestamp: 1_600, attemptNumber: 1, action: 'PUBLISH', result: 'FAILED', error: 'PUBLISH_FAILED' };
  const persisted = toV4Attempt(bare, 'ws-1');
  const restored = fromV4Attempt(persisted, 'ws-1');
  assert.equal(restored.result, 'FAILED');
  assert.equal(restored.tweetLabel, undefined);
  assert.equal(restored.publishedPostUrl, undefined);
  assert.equal(restored.link, '');
});

const record = (id, overrides = {}) => ({ id, status: 'COMPLETED', startedAt: 10_000, completedAt: 20_000, ...overrides });

test('repair adopts the unique zero-attempt active record for the live session', () => {
  // Pre-1.13.1 shape: record got a fresh UUID, attempts were keyed by the runtime session id.
  const result = repairSessionHistoryLinks({
    sessions: [record('record-H', { status: 'RUNNING', startedAt: 10_000, completedAt: undefined })],
    history: [
      { sessionId: 'session-S', timestamp: 10_500 },
      { sessionId: 'session-S', timestamp: 11_000 },
    ],
    activeSessionId: 'session-S',
  });
  assert.deepEqual(result.repairedSessionIds, ['session-S']);
  assert.equal(result.sessions[0].id, 'session-S');
  assert.equal(result.sessions[0].status, 'RUNNING');
});

test('repair leaves healthy records untouched', () => {
  const result = repairSessionHistoryLinks({
    sessions: [record('session-S', { status: 'RUNNING', completedAt: undefined })],
    history: [{ sessionId: 'session-S', timestamp: 10_500 }],
    activeSessionId: 'session-S',
  });
  assert.deepEqual(result.repairedSessionIds, []);
  assert.equal(result.sessions[0].id, 'session-S');
});

test('repair refuses the active rule when two active shells exist (ambiguous)', () => {
  const result = repairSessionHistoryLinks({
    sessions: [
      record('record-H1', { status: 'RUNNING', completedAt: undefined }),
      record('record-H2', { status: 'PAUSED', startedAt: 12_000, completedAt: undefined }),
    ],
    history: [{ sessionId: 'session-S', timestamp: 10_500 }],
    activeSessionId: 'session-S',
  });
  assert.deepEqual(result.repairedSessionIds, []);
});

test('repair pairs an orphaned group to the unique terminal record containing its window', () => {
  const result = repairSessionHistoryLinks({
    sessions: [
      record('record-A', { startedAt: 10_000, completedAt: 12_000 }),
      record('record-B', { startedAt: 20_000, completedAt: 22_000 }),
    ],
    history: [
      { sessionId: 'orphan-1', timestamp: 20_500 },
      { sessionId: 'orphan-1', timestamp: 21_500 },
    ],
  });
  assert.deepEqual(result.repairedSessionIds, ['orphan-1']);
  assert.equal(result.sessions.find((session) => session.id === 'orphan-1').startedAt, 20_000);
  assert.equal(result.sessions.find((session) => session.id === 'record-A').id, 'record-A');
});

test('repair skips ambiguous windows (two terminal records both contain the group)', () => {
  const result = repairSessionHistoryLinks({
    sessions: [
      record('record-A', { startedAt: 10_000, completedAt: 30_000 }),
      record('record-B', { startedAt: 11_000, completedAt: 31_000 }),
    ],
    history: [{ sessionId: 'orphan-1', timestamp: 15_000 }],
  });
  assert.deepEqual(result.repairedSessionIds, []);
});

test('repair skips groups without usable timestamps and unknown groups stay orphaned', () => {
  const result = repairSessionHistoryLinks({
    sessions: [record('record-A', { startedAt: 10_000, completedAt: 30_000 })],
    history: [{ sessionId: 'orphan-1', timestamp: Number.NaN }],
  });
  assert.deepEqual(result.repairedSessionIds, []);
});

test('repair never renames a record onto an id another record already holds', () => {
  const result = repairSessionHistoryLinks({
    sessions: [
      record('record-H', { status: 'RUNNING', completedAt: undefined }),
      record('session-S', { status: 'COMPLETED', startedAt: 1_000, completedAt: 2_000 }),
    ],
    history: [{ sessionId: 'session-S', timestamp: 1_500 }],
    activeSessionId: 'session-S',
  });
  // session-S record already exists (with backing attempts) — no adoption, no destruction.
  assert.deepEqual(result.repairedSessionIds, []);
  assert.equal(result.sessions.find((session) => session.id === 'session-S').status, 'COMPLETED');
  assert.equal(result.sessions.find((session) => session.id === 'record-H').id, 'record-H');
});

test('repair is idempotent: a second pass over repaired data changes nothing', () => {
  const input = {
    sessions: [record('record-H', { status: 'RUNNING', completedAt: undefined })],
    history: [{ sessionId: 'session-S', timestamp: 10_500 }],
    activeSessionId: 'session-S',
  };
  const first = repairSessionHistoryLinks(input);
  const second = repairSessionHistoryLinks({
    sessions: first.sessions,
    history: input.history,
    activeSessionId: input.activeSessionId,
  });
  assert.deepEqual(second.repairedSessionIds, []);
});

test('repair handles the full real-world shape: one live session + one completed session', () => {
  const result = repairSessionHistoryLinks({
    sessions: [
      record('record-LIVE', { status: 'RUNNING', startedAt: 100_000, completedAt: undefined }),
      record('record-DONE', { status: 'COMPLETED', startedAt: 50_000, completedAt: 90_000 }),
    ],
    history: [
      { sessionId: 'session-LIVE', timestamp: 100_500 },
      { sessionId: 'session-LIVE', timestamp: 101_000 },
      { sessionId: 'session-DONE', timestamp: 50_500 },
      { sessionId: 'session-DONE', timestamp: 89_000 },
    ],
    activeSessionId: 'session-LIVE',
  });
  assert.deepEqual(result.repairedSessionIds.sort(), ['session-DONE', 'session-LIVE']);
  const byId = new Map(result.sessions.map((session) => [session.id, session]));
  assert.equal(byId.get('session-LIVE').status, 'RUNNING');
  assert.equal(byId.get('session-DONE').status, 'COMPLETED');
});
