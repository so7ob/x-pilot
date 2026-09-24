import type { HistoricalSession, PublishAttempt } from './models';

/**
 * Analytical digest for one historical publishing session.
 *
 * Pure derivation over the session record and its publish attempts — no
 * storage, no chrome, no clock. Attempts written by recent engines carry the
 * analytical snapshot (tweet label, bank, position, duration); legacy rows
 * simply contribute fewer fields and the digest degrades honestly.
 */
export interface SessionAnalytics {
  attemptsCount: number;
  distinctTweets: number;
  publishedCount: number;
  failedCount: number;
  skippedCount: number;
  pausedCount: number;
  otherCount: number;
  /** Published share of terminal attempts (published vs failed), 0–100. */
  successRate: number;
  /** Published attempts that captured the post-publish link. */
  publishedWithLinkCount: number;
  /** Published attempts without a captured link (honest gap count). */
  missingLinkCount: number;
  /** Mean wall-clock duration over attempts that recorded one. */
  avgAttemptMs?: number;
  /** Sum of recorded attempt durations. */
  totalAttemptMs?: number;
  firstAttemptAt?: number;
  lastAttemptAt?: number;
  /** Raw result → count map (every result string seen in this session). */
  resultBreakdown: Record<string, number>;
}

const PUBLISHED_RESULTS = new Set(['PUBLISHED', 'PUBLISHED_UNVERIFIED']);

export function buildSessionAnalytics(input: {
  session: Pick<HistoricalSession, 'publishedCount' | 'failedCount'>;
  attempts: Array<Pick<PublishAttempt, 'queueItemId' | 'result' | 'publishedPostUrl' | 'timestamp' | 'durationMs'>>;
}): SessionAnalytics {
  const attempts = input.attempts;
  const resultBreakdown: Record<string, number> = {};
  let published = 0;
  let failed = 0;
  let skipped = 0;
  let paused = 0;
  let publishedWithLink = 0;
  let durationSum = 0;
  let durationSamples = 0;
  let firstAttemptAt: number | undefined;
  let lastAttemptAt: number | undefined;
  const tweetIds = new Set<string>();
  for (const attempt of attempts) {
    tweetIds.add(attempt.queueItemId);
    resultBreakdown[attempt.result] = (resultBreakdown[attempt.result] ?? 0) + 1;
    if (PUBLISHED_RESULTS.has(attempt.result)) {
      published += 1;
      if (attempt.publishedPostUrl) publishedWithLink += 1;
    } else if (attempt.result === 'FAILED') {
      failed += 1;
    } else if (attempt.result === 'SKIPPED') {
      skipped += 1;
    } else if (attempt.result === 'PAUSED') {
      paused += 1;
    }
    if (typeof attempt.durationMs === 'number' && Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0) {
      durationSum += attempt.durationMs;
      durationSamples += 1;
    }
    if (typeof attempt.timestamp === 'number' && Number.isFinite(attempt.timestamp)) {
      firstAttemptAt = firstAttemptAt === undefined ? attempt.timestamp : Math.min(firstAttemptAt, attempt.timestamp);
      lastAttemptAt = lastAttemptAt === undefined ? attempt.timestamp : Math.max(lastAttemptAt, attempt.timestamp);
    }
  }
  const terminalBase = published + failed;
  // Attempt-based success rate when attempts exist; falls back to the session
  // record's own counters for sessions whose attempts were pruned.
  const fallbackBase = input.session.publishedCount + input.session.failedCount;
  const rateBase = terminalBase > 0 ? { published, failed: terminalBase }
    : fallbackBase > 0 ? { published: input.session.publishedCount, failed: fallbackBase } : null;
  const successRate = rateBase ? Math.round((rateBase.published / rateBase.failed) * 100) : 0;
  return {
    attemptsCount: attempts.length,
    distinctTweets: tweetIds.size,
    publishedCount: published,
    failedCount: failed,
    skippedCount: skipped,
    pausedCount: paused,
    otherCount: attempts.length - published - failed - skipped - paused,
    successRate,
    publishedWithLinkCount: publishedWithLink,
    missingLinkCount: published - publishedWithLink,
    avgAttemptMs: durationSamples > 0 ? Math.round(durationSum / durationSamples) : undefined,
    totalAttemptMs: durationSamples > 0 ? durationSum : undefined,
    firstAttemptAt,
    lastAttemptAt,
    resultBreakdown,
  };
}
