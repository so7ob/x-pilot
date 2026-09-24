import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANK_EXPORT_FORMAT,
  BANK_LIST_EXPORT_FORMAT,
  MAX_IMPORT_BANKS,
  MAX_IMPORT_SNAPSHOT_ITEMS,
  buildBankExport,
  buildBankExportPayload,
  buildBanksExport,
  parseBankImport,
} from '../src/domain/bank-transfer.ts';

const NOW = 1_700_000_000_000;
const options = { now: NOW };

function sampleBank(overrides = {}) {
  return {
    id: 'bank-1',
    workspaceId: 'workspace-1',
    name: '  بنك التغريدات الرئيسي  ',
    description: 'بنك تجريبي',
    url: 'https://x.com/bank/main',
    favorite: true,
    archived: true,
    createdAt: NOW - 5000,
    updatedAt: NOW - 1000,
    lastExtractedAt: NOW - 900,
    lastExtractedCount: 3,
    lastSnapshot: [
      { url: 'https://x.com/status/1', label: 'أول تغريدة', contentFingerprint: 'fp-1', normalizedContent: 'أول' },
      { url: 'https://x.com/status/2' },
    ],
    lastSnapshotAt: NOW - 800,
    ...overrides,
  };
}

test('bank export payload never carries workspace isolation identifiers', () => {
  const payload = buildBankExportPayload(sampleBank());
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('"id"'), false, 'export payload must not include bank id');
  assert.equal(serialized.includes('workspaceId'), false, 'export payload must not include workspaceId');
  assert.equal(serialized.includes('workspace-1'), false, 'export payload must not leak workspace identifiers');
  assert.equal(serialized.includes('"favorite"'), false);
  assert.equal(serialized.includes('"archived"'), false);
});

test('buildBankExport produces a versioned single-bank envelope with trimmed metadata', () => {
  const envelope = buildBankExport(sampleBank(), '1.2.0', NOW);
  assert.equal(envelope.format, BANK_EXPORT_FORMAT);
  assert.equal(envelope.formatVersion, 1);
  assert.equal(envelope.appVersion, '1.2.0');
  assert.equal(envelope.createdAt, NOW);
  assert.equal(envelope.bank.name, 'بنك التغريدات الرئيسي');
  assert.equal(envelope.bank.url, 'https://x.com/bank/main');
  assert.equal(envelope.bank.snapshot.length, 2);
  assert.equal(envelope.bank.snapshot[0].url, 'https://x.com/status/1');
});

test('buildBanksExport wraps multiple banks and rejects an empty list', () => {
  const envelope = buildBanksExport([sampleBank(), sampleBank({ id: 'bank-2', name: 'ثاني' })], '1.2.0', NOW);
  assert.equal(envelope.format, BANK_LIST_EXPORT_FORMAT);
  assert.equal(envelope.banks.length, 2);
  assert.throws(() => buildBanksExport([], '1.2.0', NOW), (error) => error.code === 'BANK_IMPORT_EMPTY');
});

test('parseBankImport accepts a single-bank envelope and assigns fresh isolation-safe records', () => {
  const envelope = buildBankExport(sampleBank(), '1.2.0', NOW);
  const imported = parseBankImport(JSON.parse(JSON.stringify(envelope)), options);
  assert.equal(imported.length, 1);
  const bank = imported[0];
  assert.equal(bank.id, '', 'parser must not fabricate ids; storage layer assigns fresh ones');
  assert.equal(bank.workspaceId, '', 'parser must not carry a stale workspaceId');
  assert.equal(bank.favorite, false, 'imported banks start unfavorited');
  assert.equal(bank.archived, false, 'imported banks start active');
  assert.equal(bank.name, 'بنك التغريدات الرئيسي');
  assert.equal(bank.createdAt, NOW - 5000, 'valid original timestamps are preserved');
  assert.equal(bank.updatedAt, NOW, 'updatedAt is refreshed to import time');
  assert.equal(bank.lastSnapshot.length, 2);
  assert.equal(bank.lastSnapshotAt, NOW - 800);
});

test('parseBankImport accepts a list envelope and a raw bank array', () => {
  const listEnvelope = buildBanksExport([sampleBank(), sampleBank({ id: 'bank-2', name: 'ثاني' })], '1.2.0', NOW);
  const fromEnvelope = parseBankImport(JSON.parse(JSON.stringify(listEnvelope)), options);
  assert.equal(fromEnvelope.length, 2);
  const raw = [sampleBank({ id: 'b3' }), sampleBank({ id: 'b4' })];
  const fromRaw = parseBankImport(JSON.parse(JSON.stringify(raw)), options);
  assert.equal(fromRaw.length, 2);
  assert.equal(fromRaw[1].name, 'بنك التغريدات الرئيسي');
});

test('parseBankImport rejects invalid envelopes, versions, and payloads', () => {
  assert.throws(() => parseBankImport(null, options), (error) => error.code === 'BANK_IMPORT_INVALID');
  assert.throws(() => parseBankImport('not-an-object', options), (error) => error.code === 'BANK_IMPORT_INVALID');
  assert.throws(() => parseBankImport({ format: 'other-tool-bank', formatVersion: 1, bank: {} }, options), (error) => error.code === 'BANK_IMPORT_INVALID');
  assert.throws(() => parseBankImport({ format: BANK_EXPORT_FORMAT, formatVersion: 99, bank: sampleBank() }, options), (error) => error.code === 'BANK_IMPORT_UNSUPPORTED_VERSION');
  assert.throws(() => parseBankImport({ format: BANK_LIST_EXPORT_FORMAT, formatVersion: 1, banks: [] }, options), (error) => error.code === 'BANK_IMPORT_EMPTY');
  assert.throws(() => parseBankImport([], options), (error) => error.code === 'BANK_IMPORT_EMPTY');
  assert.throws(() => parseBankImport({ format: BANK_EXPORT_FORMAT, formatVersion: 1 }, options), (error) => error.code === 'BANK_IMPORT_INVALID');
  assert.throws(() => parseBankImport([sampleBank(), sampleBank()], { ...options, maxBanks: 1 }), (error) => error.code === 'BANK_IMPORT_TOO_LARGE');
  assert.equal(MAX_IMPORT_BANKS >= 1, true);
});

test('parseBankImport rejects invalid names, urls, and snapshots', () => {
  assert.throws(() => parseBankImport([sampleBank({ name: '   ' })], options), (error) => error.code === 'BANK_IMPORT_INVALID');
  assert.throws(() => parseBankImport([sampleBank({ url: 'ftp://x.com/file' })], options), (error) => error.code === 'BANK_IMPORT_INVALID_URL');
  assert.throws(() => parseBankImport([sampleBank({ url: 'not-a-url' })], options), (error) => error.code === 'BANK_IMPORT_INVALID_URL');
  assert.throws(() => parseBankImport([sampleBank({ lastSnapshot: 'nope' })], options), (error) => error.code === 'BANK_IMPORT_INVALID_SNAPSHOT');
  assert.throws(() => parseBankImport([sampleBank({ lastSnapshot: [{ url: 'bad' }] })], options), (error) => error.code === 'BANK_IMPORT_INVALID_SNAPSHOT');
  assert.throws(() => parseBankImport([sampleBank({ lastSnapshot: Array.from({ length: 11 }, (_, index) => ({ url: `https://x.com/status/${index}` })) })], { ...options, maxSnapshotItems: 10 }), (error) => error.code === 'BANK_IMPORT_BANK_TOO_LARGE');
  assert.equal(MAX_IMPORT_SNAPSHOT_ITEMS >= 1, true);
});

test('parseBankImport normalizes invalid timestamps and keeps snapshot urls', () => {
  const imported = parseBankImport([{
    name: 'بنك',
    url: 'https://twitter.com/bank/legacy',
    createdAt: 'not-a-number',
    lastExtractedAt: Number.NaN,
    lastExtractedCount: -5,
    snapshot: [{ url: 'https://x.com/status/9', label: '  ' }],
  }], options);
  assert.equal(imported.length, 1);
  const bank = imported[0];
  assert.equal(bank.createdAt, NOW, 'invalid createdAt falls back to import time');
  assert.equal(bank.lastExtractedAt, undefined, 'invalid lastExtractedAt is dropped');
  assert.equal(bank.lastExtractedCount, undefined, 'negative counts are dropped');
  assert.equal(bank.url, 'https://twitter.com/bank/legacy', 'twitter.com bank urls stay valid');
  assert.equal(bank.lastSnapshot.length, 1);
  assert.equal(bank.lastSnapshot[0].label, undefined, 'blank labels are dropped');
});

test('export then import roundtrip preserves bank identity without runtime state', () => {
  const bank = sampleBank();
  const envelope = buildBankExport(bank, '1.2.0', NOW);
  const roundTripped = JSON.parse(JSON.stringify(envelope));
  const imported = parseBankImport(roundTripped, options)[0];
  assert.equal(imported.name, bank.name.trim(), 'roundtrip preserves the trimmed bank name');
  assert.equal(imported.url, bank.url);
  assert.equal(imported.description, bank.description);
  assert.deepEqual(imported.lastSnapshot.map((item) => item.url), bank.lastSnapshot.map((item) => item.url));
  assert.equal(imported.lastExtractedCount, bank.lastExtractedCount);
});
