import type { BankSnapshotItem, TweetBank } from './models.ts';

export const BANK_EXPORT_FORMAT = 'x-pilot-tweet-bank';
export const BANK_LIST_EXPORT_FORMAT = 'x-pilot-tweet-banks';
export const SUPPORTED_BANK_EXPORT_FORMAT_VERSION = 1;
export const MAX_IMPORT_BANKS = 100;
export const MAX_IMPORT_SNAPSHOT_ITEMS = 5000;

export interface BankExportBankPayload {
  name: string;
  description?: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  lastExtractedAt?: number;
  lastExtractedCount?: number;
  snapshot?: BankSnapshotItem[];
  snapshotAt?: number;
}

export interface BankExportEnvelope {
  format: typeof BANK_EXPORT_FORMAT;
  formatVersion: number;
  appVersion: string;
  createdAt: number;
  bank: BankExportBankPayload;
}

export interface BankListExportEnvelope {
  format: typeof BANK_LIST_EXPORT_FORMAT;
  formatVersion: number;
  appVersion: string;
  createdAt: number;
  banks: BankExportBankPayload[];
}

export type BankImportErrorCode =
  | 'BANK_IMPORT_INVALID'
  | 'BANK_IMPORT_UNSUPPORTED_VERSION'
  | 'BANK_IMPORT_EMPTY'
  | 'BANK_IMPORT_TOO_LARGE'
  | 'BANK_IMPORT_BANK_TOO_LARGE'
  | 'BANK_IMPORT_INVALID_URL'
  | 'BANK_IMPORT_INVALID_SNAPSHOT';

export class BankImportError extends Error {
  readonly code: BankImportErrorCode;
  constructor(code: BankImportErrorCode) {
    super(code);
    this.name = 'BankImportError';
    this.code = code;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeSnapshotItems(value: unknown, errorCode: BankImportErrorCode): BankSnapshotItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BankImportError(errorCode);
  const items: BankSnapshotItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BankImportError(errorCode);
    const candidate = raw as Partial<BankSnapshotItem>;
    if (!isValidHttpUrl(candidate.url)) throw new BankImportError(errorCode);
    items.push({
      url: candidate.url.trim(),
      ...(typeof candidate.label === 'string' && candidate.label.trim() ? { label: candidate.label.trim() } : {}),
      ...(typeof candidate.contentFingerprint === 'string' && candidate.contentFingerprint.trim() ? { contentFingerprint: candidate.contentFingerprint.trim() } : {}),
      ...(typeof candidate.normalizedContent === 'string' && candidate.normalizedContent.trim() ? { normalizedContent: candidate.normalizedContent.trim() } : {}),
    });
  }
  return items;
}

export function buildBankExportPayload(bank: TweetBank): BankExportBankPayload {
  const payload: BankExportBankPayload = {
    name: bank.name.trim(),
    url: bank.url.trim(),
    createdAt: bank.createdAt,
    updatedAt: bank.updatedAt,
    ...(bank.description ? { description: bank.description } : {}),
    ...(bank.lastExtractedAt ? { lastExtractedAt: bank.lastExtractedAt } : {}),
    ...(bank.lastExtractedCount ? { lastExtractedCount: bank.lastExtractedCount } : {}),
    ...(bank.lastSnapshot?.length ? { snapshot: bank.lastSnapshot.map((item) => ({ ...item })) } : {}),
    ...(bank.lastSnapshotAt ? { snapshotAt: bank.lastSnapshotAt } : {}),
  };
  return payload;
}

export function buildBankExport(bank: TweetBank, appVersion: string, now = Date.now()): BankExportEnvelope {
  return { format: BANK_EXPORT_FORMAT, formatVersion: SUPPORTED_BANK_EXPORT_FORMAT_VERSION, appVersion, createdAt: now, bank: buildBankExportPayload(bank) };
}

export function buildBanksExport(banks: TweetBank[], appVersion: string, now = Date.now()): BankListExportEnvelope {
  if (!banks.length) throw new BankImportError('BANK_IMPORT_EMPTY');
  return { format: BANK_LIST_EXPORT_FORMAT, formatVersion: SUPPORTED_BANK_EXPORT_FORMAT_VERSION, appVersion, createdAt: now, banks: banks.map(buildBankExportPayload) };
}

function parseBankPayload(raw: unknown, now: number, maxSnapshotItems: number): TweetBank {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BankImportError('BANK_IMPORT_INVALID');
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) throw new BankImportError('BANK_IMPORT_INVALID');
  if (!isValidHttpUrl(candidate.url)) throw new BankImportError('BANK_IMPORT_INVALID_URL');
  const snapshot = normalizeSnapshotItems(candidate.snapshot ?? candidate.lastSnapshot, 'BANK_IMPORT_INVALID_SNAPSHOT');
  if (snapshot.length > maxSnapshotItems) throw new BankImportError('BANK_IMPORT_BANK_TOO_LARGE');
  const lastExtractedCount = isFiniteNumber(candidate.lastExtractedCount) && candidate.lastExtractedCount >= 0 ? candidate.lastExtractedCount : undefined;
  const snapshotAt = candidate.snapshotAt ?? candidate.lastSnapshotAt;
  return {
    id: '',
    workspaceId: '',
    name: candidate.name.trim(),
    ...(typeof candidate.description === 'string' && candidate.description.trim() ? { description: candidate.description.trim() } : {}),
    url: candidate.url.trim(),
    favorite: false,
    archived: false,
    createdAt: isFiniteNumber(candidate.createdAt) ? candidate.createdAt : now,
    updatedAt: now,
    ...(isFiniteNumber(candidate.lastExtractedAt) ? { lastExtractedAt: candidate.lastExtractedAt } : {}),
    ...(lastExtractedCount !== undefined ? { lastExtractedCount } : {}),
    ...(snapshot.length ? { lastSnapshot: snapshot, lastSnapshotAt: isFiniteNumber(snapshotAt) ? snapshotAt : isFiniteNumber(candidate.lastExtractedAt) ? candidate.lastExtractedAt : now } : {}),
  };
}

function parseEnvelopeVersion(value: unknown): void {
  if (value !== SUPPORTED_BANK_EXPORT_FORMAT_VERSION) throw new BankImportError('BANK_IMPORT_UNSUPPORTED_VERSION');
}

export function parseBankImport(payload: unknown, options: { now?: number; maxBanks?: number; maxSnapshotItems?: number } = {}): TweetBank[] {
  const now = options.now ?? Date.now();
  const maxBanks = options.maxBanks ?? MAX_IMPORT_BANKS;
  const maxSnapshotItems = options.maxSnapshotItems ?? MAX_IMPORT_SNAPSHOT_ITEMS;
  if (!payload || typeof payload !== 'object') throw new BankImportError('BANK_IMPORT_INVALID');
  if (Array.isArray(payload)) {
    if (!payload.length) throw new BankImportError('BANK_IMPORT_EMPTY');
    if (payload.length > maxBanks) throw new BankImportError('BANK_IMPORT_TOO_LARGE');
    return payload.map((bank) => parseBankPayload(bank, now, maxSnapshotItems));
  }
  const envelope = payload as Record<string, unknown>;
  if (typeof envelope.format === 'string') {
    if (envelope.format !== BANK_EXPORT_FORMAT && envelope.format !== BANK_LIST_EXPORT_FORMAT) throw new BankImportError('BANK_IMPORT_INVALID');
    parseEnvelopeVersion(envelope.formatVersion);
    if (envelope.format === BANK_EXPORT_FORMAT) {
      if (!envelope.bank || typeof envelope.bank !== 'object') throw new BankImportError('BANK_IMPORT_INVALID');
      return [parseBankPayload(envelope.bank, now, maxSnapshotItems)];
    }
    if (!Array.isArray(envelope.banks)) throw new BankImportError('BANK_IMPORT_INVALID');
    if (!envelope.banks.length) throw new BankImportError('BANK_IMPORT_EMPTY');
    if (envelope.banks.length > maxBanks) throw new BankImportError('BANK_IMPORT_TOO_LARGE');
    return envelope.banks.map((bank) => parseBankPayload(bank, now, maxSnapshotItems));
  }
  throw new BankImportError('BANK_IMPORT_INVALID');
}
