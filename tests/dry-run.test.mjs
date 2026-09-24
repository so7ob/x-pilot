import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const worker = fs.readFileSync(path.join(root, 'src/background/service-worker.ts'), 'utf8');
const models = fs.readFileSync(path.join(root, 'src/domain/models.ts'), 'utf8');
const ui = [
  'src/ui/main.tsx',
  'src/ui/tabs/StartupTestsTab.tsx',
  'src/ui/components/operation-cards.tsx',
].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

test('Dry Run models enumerate every required inspection outcome', () => {
  assert.match(models, /DryRunItemStatus = 'READY' \| 'LOGIN_REQUIRED' \| 'CONTENT_MISSING' \| 'POST_BUTTON_NOT_FOUND' \| 'INVALID_URL' \| 'CHALLENGE_DETECTED' \| 'ERROR'/);
  assert.match(models, /DryRunMode = 'FIRST_ITEM' \| 'ENTIRE_QUEUE'/);
  assert.match(models, /interface DryRunResult/);
});

test('Dry Run uses one sequential automation tab and restores the previous tab', () => {
  assert.match(worker, /async function runDryRun\(mode: 'FIRST_ITEM' \| 'ENTIRE_QUEUE'/);
  assert.match(worker, /for \(const item of selected\)/);
  assert.match(worker, /await getOrCreateAutomationTab\(state\.session\)/);
  assert.match(worker, /finally \{\s*await restoreActiveTab\(previousActiveTabId\);/);
  assert.match(worker, /DRY_RUN_TAB_CREATE_FAILED/);
  assert.match(worker, /temporaryTab/);
});

test('Dry Run has a hard no-publish boundary', () => {
  const runner = worker.slice(worker.indexOf('async function runDryRun'), worker.indexOf('async function extractBank'));
  assert.doesNotMatch(runner, /X_PUBLISH/);
  assert.doesNotMatch(runner, /attempts:/);
  assert.doesNotMatch(runner, /addAttempt/);
  assert.match(runner, /inspectTab\(tabId\)/);
});

test('UI exposes both Dry Run modes and stop control', () => {
  assert.match(ui, /DRY_RUN_FIRST/);
  assert.match(ui, /DRY_RUN_QUEUE/);
  assert.match(ui, /DRY_RUN_STOP/);
  assert.match(ui, /tests\.testFirst/);
  assert.match(ui, /tests\.testQueue/);
  assert.match(ui, /tests\.startFailed/);
});
