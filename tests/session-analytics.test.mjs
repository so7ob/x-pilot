/**
 * Session analytics — pure analytical digest for the Sessions log.
 * Guarantees: attempt-based counting (published/failed/skipped/paused/other),
 * success rate over terminal attempts with session-counter fallback, honest
 * published-link accounting (with/without link), timing aggregates over
 * recorded durations only, distinct tweet count, and a raw result breakdown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionAnalytics } from '../src/domain/session-analytics.ts';

const session = (overrides = {}) => ({
  id: 'hs-1', workspaceId: 'ws-1', startedAt: 1000, completedAt: 9000, status: 'COMPLETED',
  totalItems: 5, publishedCount: 4, failedCount: 1, skippedCount: 0,
  intervalMinutes: 2, maxRetries: 2, failureBehavior: 'CONTINUE', createdAt: 900, updatedAt: 9100,
  ...overrides,
});

const attempt = (overrides = {}) => ({
  id: `a-${Math.random()}`, sessionId: 'hs-1', queueItemId: 'q-1', timestamp: 2000,
  attemptNumber: 1, action: 'PUBLISH', result: 'PUBLISHED',
  ...overrides,
});

test('empty attempts fall back to the session record counters', () => {
  const result = buildSessionAnalytics({ session: session({ publishedCount: 3, failedCount: 1 }), attempts: [] });
  assert.equal(result.attemptsCount, 0);
  assert.equal(result.distinctTweets, 0);
  assert.equal(result.successRate, 75);
  assert.equal(result.publishedWithLinkCount, 0);
  assert.equal(result.missingLinkCount, 0);
  assert.equal(result.avgAttemptMs, undefined);
  assert.deepEqual(result.resultBreakdown, {});
});

test('all-empty session yields a zero success rate without dividing', () => {
  const result = buildSessionAnalytics({ session: session({ publishedCount: 0, failedCount: 0 }), attempts: [] });
  assert.equal(result.successRate, 0);
  assert.equal(result.attemptsCount, 0);
});

test('counts results by kind and dedupes distinct tweets', () => {
  const attempts = [
    attempt({ id: '1', queueItemId: 'q-1', result: 'PUBLISHED', publishedPostUrl: 'https://x.com/u/status/1', durationMs: 5000 }),
    attempt({ id: '2', queueItemId: 'q-1', result: 'FAILED', durationMs: 3000 }),
    attempt({ id: '3', queueItemId: 'q-2', result: 'PUBLISHED_UNVERIFIED', durationMs: 7000 }),
    attempt({ id: '4', queueItemId: 'q-3', result: 'SKIPPED' }),
    attempt({ id: '5', queueItemId: 'q-3', result: 'PAUSED' }),
  ];
  const result = buildSessionAnalytics({ session: session(), attempts });
  assert.equal(result.attemptsCount, 5);
  assert.equal(result.distinctTweets, 3);
  assert.equal(result.publishedCount, 2); // PUBLISHED + PUBLISHED_UNVERIFIED
  assert.equal(result.failedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.pausedCount, 1);
  assert.equal(result.otherCount, 0);
  assert.equal(result.successRate, 67); // 2 published / 3 terminal, rounded
  assert.equal(result.publishedWithLinkCount, 1);
  assert.equal(result.missingLinkCount, 1);
  assert.equal(result.avgAttemptMs, 5000); // (5000+3000+7000)/3
  assert.equal(result.totalAttemptMs, 15000);
  assert.equal(result.firstAttemptAt, 2000);
  assert.equal(result.lastAttemptAt, 2000);
  assert.deepEqual(result.resultBreakdown, { PUBLISHED: 1, FAILED: 1, PUBLISHED_UNVERIFIED: 1, SKIPPED: 1, PAUSED: 1 });
});

test('timing aggregates skip attempts without a recorded duration', () => {
  const attempts = [
    attempt({ id: '1', durationMs: undefined }),
    attempt({ id: '2', durationMs: 4000 }),
    attempt({ id: '3', durationMs: 0 }),
    attempt({ id: '4', durationMs: Number.NaN }),
  ];
  const result = buildSessionAnalytics({ session: session(), attempts });
  assert.equal(result.avgAttemptMs, 2000); // (4000 + 0) / 2 — NaN and missing excluded
  assert.equal(result.totalAttemptMs, 4000);
});

test('negative durations are excluded from timing aggregates', () => {
  const result = buildSessionAnalytics({ session: session(), attempts: [attempt({ durationMs: -5 })] });
  assert.equal(result.avgAttemptMs, undefined);
  assert.equal(result.totalAttemptMs, undefined);
});

test('unrounded-success-rate uses terminal attempts only (skips do not dilute)', () => {
  const attempts = [
    attempt({ id: '1', result: 'PUBLISHED' }),
    attempt({ id: '2', result: 'PUBLISHED' }),
    attempt({ id: '3', result: 'PUBLISHED' }),
    attempt({ id: '4', result: 'FAILED' }),
    attempt({ id: '5', result: 'SKIPPED' }),
    attempt({ id: '6', result: 'PAUSED' }),
  ];
  const result = buildSessionAnalytics({ session: session(), attempts });
  assert.equal(result.successRate, 75); // 3 / (3 + 1), skips and pauses excluded
});

test('unknown result strings land in otherCount and the breakdown', () => {
  // Zero session counters → no fallback base → success rate stays 0.
  const result = buildSessionAnalytics({ session: session({ publishedCount: 0, failedCount: 0 }), attempts: [attempt({ id: '1', result: 'WEIRD' })] });
  assert.equal(result.otherCount, 1);
  assert.deepEqual(result.resultBreakdown, { WEIRD: 1 });
  assert.equal(result.successRate, 0);
});

test('first/last attempt timestamps span the observed window', () => {
  const attempts = [
    attempt({ id: '1', timestamp: 5000 }),
    attempt({ id: '2', timestamp: 1000 }),
    attempt({ id: '3', timestamp: 9000 }),
  ];
  const result = buildSessionAnalytics({ session: session(), attempts });
  assert.equal(result.firstAttemptAt, 1000);
  assert.equal(result.lastAttemptAt, 9000);
});
