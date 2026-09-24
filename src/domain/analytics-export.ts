import type { GlobalAnalytics, WorkspaceAnalytics } from './analytics.ts';
import { buildCsv, type CsvSection } from './csv.ts';

/**
 * Analytics CSV export (pure, read-only by construction): turns the analytics
 * numbers the side panel already holds into a spreadsheet-friendly report.
 * No storage access, no messaging, no side effects — the caller downloads the
 * returned string.
 */

export interface AnalyticsCsvLabels {
  reportTitle: string;
  exportedAt: string;
  scope: string;
  scopeAll: string;
  summary: string;
  summaryTotalWorkspaces: string;
  summaryTotalPublished: string;
  summaryTotalFailures: string;
  workspaces: string;
  workspaceName: string;
  totalSessions: string;
  totalPosts: string;
  published: string;
  failed: string;
  skipped: string;
  successRate: string;
  averageAttempts: string;
  duration: string;
  mostActiveBank: string;
  lastActivity: string;
  sessionsOverTime: string;
  date: string;
  sessions: string;
}

const englishLabels: AnalyticsCsvLabels = {
  reportTitle: 'X-Pilot Analytics Export',
  exportedAt: 'Exported at',
  scope: 'Scope',
  scopeAll: 'All workspaces',
  summary: 'Summary',
  summaryTotalWorkspaces: 'Total workspaces',
  summaryTotalPublished: 'Total published',
  summaryTotalFailures: 'Total failures',
  workspaces: 'Workspaces',
  workspaceName: 'Workspace',
  totalSessions: 'Total sessions',
  totalPosts: 'Total posts',
  published: 'Published',
  failed: 'Failed',
  skipped: 'Skipped',
  successRate: 'Success rate %',
  averageAttempts: 'Average attempts',
  duration: 'Average session duration (s)',
  mostActiveBank: 'Most active bank',
  lastActivity: 'Last activity',
  sessionsOverTime: 'Sessions over time',
  date: 'Date',
  sessions: 'Sessions',
};

function iso(value: number | undefined): string {
  return value ? new Date(value).toISOString() : '';
}

function durationSeconds(ms: number): string {
  return Math.round(ms / 1000).toString();
}

function workspaceRow(analytics: WorkspaceAnalytics): (string | number)[] {
  return [
    analytics.workspaceName,
    analytics.totalSessions,
    analytics.totalPosts,
    analytics.published,
    analytics.failed,
    analytics.skipped,
    analytics.successRate,
    analytics.averageAttempts,
    durationSeconds(analytics.averageSessionDurationMs),
    analytics.mostActiveBank?.name ?? '',
    iso(analytics.lastActivityAt),
  ];
}

export interface AnalyticsCsvInput {
  exportedAt: number;
  /** '*' = whole X-Pilot install; otherwise a workspace id. */
  scopeWorkspaceId: string;
  /** Display name for a single-workspace scope. */
  scopeWorkspaceName?: string;
  global: GlobalAnalytics;
  /** Rows to include: all workspaces, or just the selected one. */
  workspaceRows: WorkspaceAnalytics[];
  /** Omit the sessions-over-time section when undefined. */
  sessionsOverTime?: GlobalAnalytics['sessionsOverTime'];
  labels?: Partial<AnalyticsCsvLabels>;
}

export function buildAnalyticsCsv(input: AnalyticsCsvInput): string {
  const labels: AnalyticsCsvLabels = { ...englishLabels, ...input.labels };
  const scopeLabel = input.scopeWorkspaceId === '*' ? labels.scopeAll : input.scopeWorkspaceName ?? input.scopeWorkspaceId;

  const summary: CsvSection = {
    title: labels.summary,
    rows: [
      [labels.summaryTotalWorkspaces, input.global.totalWorkspaces],
      [labels.summaryTotalPublished, input.global.totalPublished],
      [labels.summaryTotalFailures, input.global.totalFailures],
    ],
  };

  const workspaces: CsvSection = {
    title: labels.workspaces,
    header: [
      labels.workspaceName,
      labels.totalSessions,
      labels.totalPosts,
      labels.published,
      labels.failed,
      labels.skipped,
      labels.successRate,
      labels.averageAttempts,
      labels.duration,
      labels.mostActiveBank,
      labels.lastActivity,
    ],
    rows: input.workspaceRows.map((analytics) => workspaceRow(analytics)),
  };

  const sections: CsvSection[] = [
    {
      title: labels.reportTitle,
      rows: [
        [labels.exportedAt, new Date(input.exportedAt).toISOString()],
        [labels.scope, scopeLabel],
      ],
    },
    summary,
    workspaces,
  ];

  if (input.sessionsOverTime) {
    sections.push({
      title: labels.sessionsOverTime,
      header: [labels.date, labels.sessions],
      rows: input.sessionsOverTime.map((point) => [point.date, point.sessions]),
    });
  }

  return buildCsv(sections);
}
