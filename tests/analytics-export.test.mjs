/**
 * Analytics CSV export: pure RFC 4180 writer + analytics report builder.
 * The domain modules must stay pure (no chrome APIs, no storage access) —
 * the caller owns downloading the returned string.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { csvField, csvRow, buildCsv } from '../src/domain/csv.ts';
import { buildAnalyticsCsv } from '../src/domain/analytics-export.ts';

test('csvField escapes commas, quotes, CR, and LF per RFC 4180', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line1\nline2'), '"line1\nline2"');
  assert.equal(csvField('cr\rlf'), '"cr\r lf"'.replaceAll(' ', ''));
  assert.equal(csvField(''), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(null), '');
  assert.equal(csvField(42), '42');
  assert.equal(csvField('العربية، بفاصلة عربية'), 'العربية، بفاصلة عربية', 'Arabic comma U+060C needs no quoting');
  assert.equal(csvField('قيمة,عربية'), '"قيمة,عربية"', 'ASCII comma inside Arabic text is quoted');
});

test('csvRow joins fields and buildCsv emits BOM + CRLF + blank-line sections', () => {
  assert.equal(csvRow(['a', 1, undefined]), 'a,1,');
  const csv = buildCsv([
    { title: 'T1', header: ['h1', 'h2'], rows: [['v1', 'v2']] },
    { title: 'T2', rows: [[1, 2]] },
  ]);
  assert.ok(csv.startsWith('\uFEFF'), 'BOM present by default');
  assert.ok(csv.includes('T1\r\nh1,h2\r\nv1,v2\r\n\r\nT2\r\n1,2\r\n'), 'sections separated by blank line, CRLF endings');
  const noBom = buildCsv([{ title: 'x' }], { bom: false });
  assert.ok(!noBom.startsWith('\uFEFF'));
  assert.ok(noBom.endsWith('\r\n'), 'file ends with CRLF');
});

function workspaceAnalytics(patch = {}) {
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Main Workspace',
    totalSessions: 4,
    totalPosts: 10,
    published: 8,
    failed: 1,
    skipped: 1,
    successRate: 80,
    averageAttempts: 1.25,
    averageSessionDurationMs: 95000,
    mostActiveBank: { bankId: 'b1', name: 'Launch, Week 1', activity: 6 },
    lastActivityAt: Date.UTC(2026, 0, 15, 12, 30),
    ...patch,
  };
}

const globalAnalytics = {
  totalWorkspaces: 2,
  totalPublished: 15,
  totalFailures: 2,
  sessionsOverTime: [
    { date: '2026-01-14', sessions: 3 },
    { date: '2026-01-15', sessions: 1 },
  ],
};

test('buildAnalyticsCsv produces report, summary, workspaces, and time-series sections', () => {
  const csv = buildAnalyticsCsv({
    exportedAt: Date.UTC(2026, 0, 15, 18, 0),
    scopeWorkspaceId: '*',
    global: globalAnalytics,
    workspaceRows: [workspaceAnalytics(), workspaceAnalytics({ workspaceId: 'ws-2', workspaceName: 'Campaign B' })],
    sessionsOverTime: globalAnalytics.sessionsOverTime,
  });
  assert.ok(csv.startsWith('\uFEFF'));
  const text = csv.slice(1);
  const blocks = text.split('\r\n\r\n');
  assert.equal(blocks.length, 4, 'report header + summary + workspaces + time series');
  assert.ok(blocks[0].includes('X-Pilot Analytics Export'));
  assert.ok(blocks[0].includes('Exported at,2026-01-15T18:00:00.000Z'));
  assert.ok(blocks[0].includes('Scope,All workspaces'));
  assert.ok(blocks[1].startsWith('Summary\r\n'), 'summary section keeps its title row');
  assert.ok(blocks[1].includes('Total published,15'));
  assert.ok(blocks[2].includes('Workspace,Total sessions,Total posts,Published,Failed,Skipped,Success rate %,Average attempts,Average session duration (s),Most active bank,Last activity'));
  assert.ok(blocks[2].includes('Main Workspace,4,10,8,1,1,80,1.25,95,"Launch, Week 1",2026-01-15T12:30:00.000Z'), 'bank name with comma is quoted; duration in seconds');
  assert.ok(blocks[3].includes('Date,Sessions'));
  assert.ok(blocks[3].includes('2026-01-14,3'));
});

test('single-workspace scope drops the time series and limits workspace rows', () => {
  const csv = buildAnalyticsCsv({
    exportedAt: Date.UTC(2026, 0, 15, 18, 0),
    scopeWorkspaceId: 'ws-2',
    scopeWorkspaceName: 'Campaign B',
    global: globalAnalytics,
    workspaceRows: [workspaceAnalytics({ workspaceId: 'ws-2', workspaceName: 'Campaign B' })],
  });
  const text = csv.slice(1);
  assert.ok(!text.includes('Sessions over time'), 'time series omitted outside global scope');
  assert.ok(text.includes('Scope,Campaign B'));
  assert.ok(text.includes('Campaign B,4,10,8,1,1,80'));
  assert.ok(!text.includes('Main Workspace'), 'other workspaces excluded');
});

test('localized labels flow through the report', () => {
  const csv = buildAnalyticsCsv({
    exportedAt: Date.UTC(2026, 0, 15, 18, 0),
    scopeWorkspaceId: '*',
    global: globalAnalytics,
    workspaceRows: [workspaceAnalytics()],
    sessionsOverTime: [],
    labels: {
      reportTitle: 'تقرير X-Pilot',
      summary: 'الملخص',
      workspaces: 'مساحات العمل',
      sessionsOverTime: 'الجلسات عبر الزمن',
      date: 'التاريخ',
      sessions: 'الجلسات',
      scopeAll: 'كل مساحات العمل',
    },
  });
  const text = csv.slice(1);
  assert.ok(text.includes('تقرير X-Pilot'));
  assert.ok(text.includes('Scope,كل مساحات العمل'));
  assert.ok(text.includes('الملخص\r\n'));
  assert.ok(text.includes('التاريخ,الجلسات'));
});

test('empty analytics data still yields a valid, header-only report', () => {
  const csv = buildAnalyticsCsv({
    exportedAt: Date.UTC(2026, 0, 15, 18, 0),
    scopeWorkspaceId: '*',
    global: { totalWorkspaces: 0, totalPublished: 0, totalFailures: 0, sessionsOverTime: [] },
    workspaceRows: [],
    sessionsOverTime: [],
  });
  const text = csv.slice(1);
  assert.ok(text.includes('Total published,0'));
  assert.ok(text.includes('Workspace,Total sessions'));
  assert.ok(text.includes('Date,Sessions'));
  assert.ok(!text.includes('undefined'));
  assert.ok(!text.includes('NaN'));
});

test('empty optional fields render as blank cells, not the string "undefined"', () => {
  const analytics = workspaceAnalytics({ mostActiveBank: undefined, lastActivityAt: undefined });
  const csv = buildAnalyticsCsv({
    exportedAt: Date.UTC(2026, 0, 15, 18, 0),
    scopeWorkspaceId: '*',
    global: globalAnalytics,
    workspaceRows: [analytics],
    sessionsOverTime: undefined,
  });
  const row = csv.slice(1).split('\r\n').find((line) => line.startsWith('Main Workspace,')) ?? '';
  const fields = row.split(',');
  assert.equal(fields[9], '', 'missing bank is an empty cell');
  assert.equal(fields[10], '', 'missing activity is an empty cell');
});

test('export modules are pure: no chrome namespace usage', async () => {
  const fs = await import('node:fs');
  for (const file of ['src/domain/csv.ts', 'src/domain/analytics-export.ts']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('globalThis.chrome'), `${file} must not touch chrome APIs`);
    assert.ok(!text.includes('chrome.'), `${file} must not reference chrome.`);
    assert.ok(!text.includes('storage-repository'), `${file} must not import storage`);
  }
});
