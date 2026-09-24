import type { HistoricalSession, PublishAttempt } from './models';

/**
 * Read-only session-history report envelope.
 *
 * Like bank exports and full backups, this is a local JSON file for the user:
 * no credentials, no runtime state, no other workspace's data. The builder is
 * pure — the service worker only reads stores and delegates the shaping here.
 */
export const SESSION_EXPORT_FORMAT = 'x-pilot-session-history';
export const SESSION_EXPORT_FORMAT_VERSION = 1;

export interface SessionHistoryExportEnvelope {
  format: typeof SESSION_EXPORT_FORMAT;
  formatVersion: number;
  exportedAt: string;
  workspaceId: string;
  sessions: HistoricalSession[];
  attempts: PublishAttempt[];
}

export function buildSessionHistoryExport(input: {
  workspaceId: string;
  sessions: HistoricalSession[];
  attempts: PublishAttempt[];
  exportedAt?: number;
}): SessionHistoryExportEnvelope {
  const sessionIds = new Set(input.sessions.map((session) => session.id));
  return {
    format: SESSION_EXPORT_FORMAT,
    formatVersion: SESSION_EXPORT_FORMAT_VERSION,
    exportedAt: new Date(input.exportedAt ?? Date.now()).toISOString(),
    workspaceId: input.workspaceId,
    sessions: input.sessions,
    attempts: input.attempts.filter((attempt) => attempt.sessionId && sessionIds.has(attempt.sessionId)),
  };
}

export function isSessionHistoryExportEnvelope(value: unknown): value is SessionHistoryExportEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.format === SESSION_EXPORT_FORMAT
    && candidate.formatVersion === SESSION_EXPORT_FORMAT_VERSION
    && typeof candidate.exportedAt === 'string'
    && typeof candidate.workspaceId === 'string'
    && Array.isArray(candidate.sessions)
    && Array.isArray(candidate.attempts);
}
