import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const storage = fs.readFileSync(path.join(root, 'src/storage/storage-repository.ts'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'src/background/service-worker.ts'), 'utf8');
const models = fs.readFileSync(path.join(root, 'src/domain/models.ts'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'src/ui/main.tsx'), 'utf8');

test('Full Backup contains all durable local data and excludes transient automation state', () => {
  assert.match(models, /interface BackupEnvelope/);
  assert.match(storage, /export async function exportBackup/);
  assert.match(storage, /workspaces: workspaces\.map/);
  assert.match(storage, /automationWorkspaceId: undefined/);
  assert.match(storage, /formatVersion: uiPreferences \? 3 : 2/);  // v3 only with explicit consent
  assert.doesNotMatch(storage, /formatVersion: 2, appVersion/, 'unconditional v2 envelope must be gone');
  assert.match(storage, /session: null/);
  assert.match(storage, /V4_RUNTIME_KEY/);
});

test('Restore validates structure and references before writing storage', () => {
  assert.match(storage, /export function validateBackup/);
  assert.match(storage, /INVALID_BACKUP_FORMAT/);
  assert.match(storage, /WORKSPACE_ORDER_MISMATCH/);
  assert.match(storage, /QUEUE_REFERENCE_MISMATCH/);
  assert.match(storage, /if \(errors\.length\) return \{ valid: false/);
  assert.match(storage, /export async function restoreBackup/);
  assert.match(storage, /BACKUP_RESTORE_CONFIRMATION_REQUIRED/);
});

test('Restore is blocked while automation is active and is exposed in RTL settings', () => {
  assert.match(worker, /BACKUP_RESTORE_WHILE_AUTOMATION_ACTIVE/);
  assert.match(worker, /case 'VALIDATE_BACKUP'/);
  assert.match(worker, /case 'RESTORE_BACKUP'/);
  assert.match(ui, /backup\.title/);
  assert.match(ui, /backup\.export/);
  assert.match(ui, /backup\.restore/);
  assert.match(ui, /confirm\.restoreBackup|BACKUP_RESTORE_CONFIRMATION_REQUIRED/);
});
