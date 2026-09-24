/**
 * Session-history export envelope — read-only report builder in the domain.
 * Guarantees: versioned envelope shape, workspace stamping, attempts linked
 * only to the exported sessions, and no foreign fields leaking in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionHistoryExport, isSessionHistoryExportEnvelope, SESSION_EXPORT_FORMAT, SESSION_EXPORT_FORMAT_VERSION } from '../src/domain/session-export.ts';

const session = (overrides = {}) => ({
  id: 'hs-1', workspaceId: 'ws-1', startedAt: 1000, completedAt: 2000, status: 'COMPLETED',
  totalItems: 5, publishedCount: 4, failedCount: 1, skippedCount: 0,
  intervalMinutes: 2, maxRetries: 2, failureBehavior: 'CONTINUE', createdAt: 900, updatedAt: 2100,
  ...overrides,
});

const attempt = (overrides = {}) => ({
  id: 'a-1', sessionId: 'hs-1', workspaceId: 'ws-1', queueItemId: 'q-1', position: 1,
  timestamp: 1500, attemptNumber: 1, action: 'PUBLISH', result: 'PUBLISHED',
  publishedPostUrl: 'https://x.com/user/status/123',
  ...overrides,
});

test('envelope carries version, format, workspace stamp, and ISO timestamp', () => {
  const envelope = buildSessionHistoryExport({ workspaceId: 'ws-1', sessions: [session()], attempts: [attempt()], exportedAt: 1700000000000 });
  assert.equal(envelope.format, SESSION_EXPORT_FORMAT);
  assert.equal(envelope.formatVersion, SESSION_EXPORT_FORMAT_VERSION);
  assert.equal(envelope.workspaceId, 'ws-1');
  assert.equal(envelope.exportedAt, new Date(1700000000000).toISOString());
  assert.equal(envelope.sessions.length, 1);
  assert.equal(envelope.attempts.length, 1);
  assert.ok(isSessionHistoryExportEnvelope(envelope));
});

test('only attempts linked to the exported sessions are included', () => {
  const linked = attempt({ id: 'a-linked', sessionId: 'hs-1' });
  const foreignSession = attempt({ id: 'a-other', sessionId: 'hs-other' });
  const unlinked = attempt({ id: 'a-unlinked', sessionId: '' });
  const envelope = buildSessionHistoryExport({ workspaceId: 'ws-1', sessions: [session()], attempts: [linked, foreignSession, unlinked] });
  assert.deepEqual(envelope.attempts.map((a) => a.id), ['a-linked']);
});

test('guard rejects malformed envelopes and foreign shapes', () => {
  assert.equal(isSessionHistoryExportEnvelope(null), false);
  assert.equal(isSessionHistoryExportEnvelope({ format: 'x-pilot-tweet-bank' }), false);
  assert.equal(isSessionHistoryExportEnvelope({ format: SESSION_EXPORT_FORMAT, formatVersion: 99 }), false);
  const ok = buildSessionHistoryExport({ workspaceId: 'ws-2', sessions: [], attempts: [] });
  assert.equal(isSessionHistoryExportEnvelope(ok), true);
  assert.equal(ok.sessions.length, 0);
  assert.equal(ok.attempts.length, 0);
});

test('export preserves workspace isolation by only containing the requested input', () => {
  const own = session();
  const other = session({ id: 'hs-2', workspaceId: 'ws-2' });
  const envelope = buildSessionHistoryExport({
    workspaceId: 'ws-1',
    sessions: [own],
    attempts: [attempt({ workspaceId: 'ws-1', sessionId: 'hs-1' }), attempt({ workspaceId: 'ws-2', sessionId: 'hs-1' })],
  });
  assert.equal(envelope.workspaceId, 'ws-1');
  assert.deepEqual(envelope.sessions.map((s) => s.id), ['hs-1']);
  assert.ok(envelope.sessions.every((s) => s.workspaceId === 'ws-1'), 'caller passes only its own sessions; envelope must not add any');
  assert.ok(envelope.attempts.every((a) => a.sessionId === 'hs-1'));
  assert.ok('workspaces' in envelope === false && 'queue' in envelope === false, 'no queue or workspace registry may leak into the envelope');
});
