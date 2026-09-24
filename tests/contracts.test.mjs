import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.json'), 'utf8'));
const serviceWorker = fs.readFileSync(path.join(root, 'src/background/service-worker.ts'), 'utf8');
const engineSource = fs.readFileSync(path.join(root, 'src/background/automation-engine.ts'), 'utf8');
const contentEntry = fs.readFileSync(path.join(root, 'src/content/content-entry.ts'), 'utf8');
const contentAdapter = fs.readFileSync(path.join(root, 'src/content/providers/x-provider-adapter.ts'), 'utf8');
const content = `${contentEntry}\n${contentAdapter}`;
const uiSource = [
  'src/ui/main.tsx',
  'src/ui/types/navigation.ts',
  'src/ui/services/runtime-client.ts',
  'src/ui/components/operation-cards.tsx',
  'src/ui/tabs/OperationTab.tsx',
  'src/ui/tabs/StartupTestsTab.tsx',
  'src/ui/tabs/AnalyticsTab.tsx',
  'src/ui/tabs/DiagnosticsTab.tsx',
].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const models = fs.readFileSync(path.join(root, 'src/domain/models.ts'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'src/storage/storage-repository.ts'), 'utf8');
const pagination = fs.readFileSync(path.join(root, 'src/domain/pagination.ts'), 'utf8');
const errorMessages = fs.readFileSync(path.join(root, 'src/ui/services/error-messages.ts'), 'utf8');
const bankTransfer = fs.readFileSync(path.join(root, 'src/domain/bank-transfer.ts'), 'utf8');
const recoverySource = fs.readFileSync(path.join(root, 'src/domain/recovery.ts'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/ui/styles.css'), 'utf8');

 test('package and manifest versions stay synchronized', () => {
  assert.equal(packageJson.version, manifest.version);
});

test('manifest does not request credential or cookie access', () => {
  const permissions = [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])];
  assert.equal(permissions.includes('cookies'), false);
  assert.equal(permissions.includes('webRequest'), false);
  assert.equal(permissions.includes('debugger'), false);
});

test('manifest declares the persistent workflow APIs', () => {
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('alarms'));
  assert.ok(manifest.background?.service_worker);
  assert.ok(manifest.side_panel?.default_path);
});

test('daily X posting limit pauses the session without advancing the Queue', () => {
  assert.match(models, /dailyPostLimitReached\?: boolean/);
  assert.match(engineSource, /X_DAILY_POST_LIMIT_REACHED/);
  assert.match(engineSource, /status: 'PAUSED', currentItemId: item\.id, nextRunAt: undefined/);
  assert.match(engineSource, /status: 'PENDING', attempts: item\.attempts/);
  assert.match(engineSource, /chrome\.alarms\.clear\(ALARM_NAME\)/);
});

test('manifest declares official X-Pilot icon assets', () => {
  assert.equal(manifest.icons['16'], 'icons/icon16.png');
  assert.equal(manifest.icons['32'], 'icons/icon32.png');
  assert.equal(manifest.icons['48'], 'icons/icon48.png');
  assert.equal(manifest.icons['128'], 'icons/icon128.png');
  assert.equal(manifest.action.default_icon['16'], 'icons/icon16.png');
  for (const file of ['icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png', 'icons/icon256.png', 'branding/x-pilot-logo.png']) {
    assert.equal(fs.existsSync(path.join(root, 'public', file)), true, `missing ${file}`);
  }
});

test('UI and README use the official X-Pilot branding asset', () => {
  assert.match(uiSource, /branding\/x-pilot-logo\.png/);
  assert.match(uiSource, /common\.xPilotSettings/);
  assert.match(uiSource, /X-PILOT/);
  assert.match(readme, /public\/branding\/x-pilot-logo\.png/);
  assert.match(readme, /public\/icons/);
});

test('Side Panel exposes operation, startup-tests, tweet-bank, unified sessions, analytics, and settings tabs', () => {
  assert.match(uiSource, /type TabId = 'operation' \| 'tests' \| 'queue' \| 'sessions' \| 'analytics' \| 'diagnostics' \| 'workspaces' \| 'settings'/);
  assert.match(uiSource, /aria-label=\{t\('nav\.operation'\)\}/);
  assert.match(uiSource, /label=\{t\('nav\.operation'\)\}/);
  assert.match(uiSource, /label=\{t\('nav\.banks'\)\}/);
  assert.match(uiSource, /label=\{t\('nav\.settings'\)\}/);
  assert.match(uiSource, /useState<TabId>\('operation'\)/);
  assert.match(uiSource, /label=\{t\('nav\.startupTests'\)\}/);
  assert.match(uiSource, /label=\{t\('nav\.analytics'\)\}/);
  assert.match(uiSource, /session-summary/);
  assert.match(uiSource, /session-attempts/);
});

test('Unified activity records preserve source and published post links', () => {
  assert.match(models, /publishedPostUrl\?: string/);
  assert.match(models, /sourceUrl\?: string/);
  assert.match(content, /X_GET_PUBLISHED_URL/);
  assert.match(contentAdapter, /getPublishedPostUrl/);
  assert.match(engineSource, /publishedPostUrl/);
  assert.match(uiSource, /sessions\.publishedLink/);
  assert.match(uiSource, /sessions\.sourceLink/);
});

test('operation tab includes current-tweet information and existing controls', () => {
  assert.match(uiSource, /export function CurrentTweetCard/);
  assert.match(uiSource, /CurrentTweetCard/);
  assert.match(uiSource, /getTweetPreview\(item\.targetUrl, item\.label \|\| t\('common\.unlabeledPost'\), 180\)/);
  assert.match(uiSource, /aria-label=\{t\('nav\.operation'\)\}/);
  assert.match(uiSource, /onClick=\{start\}/);
  assert.match(uiSource, /type: 'PAUSE'/);
  assert.match(uiSource, /type: 'RESUME'/);
  assert.match(uiSource, /type: 'STOP'/);
});

test('Service Worker exposes live engine and automation-tab connectivity status', () => {
  assert.match(engineSource, /async function getRuntimeStatus\(\): Promise<RuntimeStatus>/);
  assert.match(serviceWorker, /case 'GET_RUNTIME_STATUS': return getRuntimeStatus\(\)/);
  assert.match(engineSource, /connection: 'NOT_REQUIRED'/);
  assert.match(engineSource, /connection: 'CONNECTED'/);
  assert.match(engineSource, /connection: 'DISCONNECTED'/);
  assert.match(engineSource, /await chrome\.tabs\.get\(session\.automationTabId\)/);
});

test('X adapter keeps DOM coupling isolated and covered by drift-guard fixtures', () => {
  // jsdom is a test-only dependency: it must never ship in the extension bundle.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.devDependencies?.jsdom, 'jsdom must stay a devDependency for DOM fixtures');
  assert.equal(pkg.dependencies?.jsdom, undefined, 'jsdom must never become a runtime dependency');
  // The adapter is the only DOM-coupled publish component and must stay free of extension APIs.
  assert.doesNotMatch(contentAdapter, /from\s+'chrome/, 'adapter must not import chrome APIs');
  assert.doesNotMatch(contentAdapter, /chrome\.(storage|alarms|runtime|notifications)/, 'adapter must stay a pure DOM module');
  // The DOM fixture suite must keep covering every selector family the adapter depends on.
  const domFixtures = fs.readFileSync(path.join(root, 'tests/x-provider-dom.test.mjs'), 'utf8');
  assert.match(domFixtures, /tweetTextarea_0/, 'fixtures must cover the modern composer testid');
  assert.match(domFixtures, /contenteditable/, 'fixtures must cover the contenteditable composer');
  assert.match(domFixtures, /textarea aria-label/, 'fixtures must cover the legacy textarea composer');
  assert.match(domFixtures, /tweetButtonInline/, 'fixtures must cover the inline publish button testid');
  assert.match(domFixtures, /aria-label="نشر"/, 'fixtures must cover the Arabic publish button');
  assert.match(domFixtures, /NOT_LOGGED_IN/, 'fixtures must cover login classification');
  assert.match(domFixtures, /CAPTCHA_OR_SECURITY_CHALLENGE/, 'fixtures must cover challenge classification');
  assert.match(domFixtures, /X_DAILY_POST_LIMIT_REACHED/, 'fixtures must cover daily-limit classification');
  assert.match(domFixtures, /WRONG_HOST/, 'fixtures must cover host gating');
  assert.match(domFixtures, /getPublishedPostUrl/, 'fixtures must cover published-post URL extraction');
  // The adapter's defensive fallback must stay in place for future markup variants.
  assert.match(contentAdapter, /data-testid\^="tweetTextarea"/, 'composer prefix fallback selector must be kept');
});

test('Dry Run exposes both modes and does not use the publish action', () => {
  assert.match(models, /DryRunItemStatus/);
  assert.match(models, /DRY_RUN_FIRST/);
  assert.match(models, /DRY_RUN_QUEUE/);
  assert.match(uiSource, /runDryRunFirst/);
  assert.match(uiSource, /runDryRunQueue/);
  const runner = serviceWorker.slice(serviceWorker.indexOf('async function runDryRun'), serviceWorker.indexOf('async function waitForPublishReady'));
  assert.doesNotMatch(runner, /X_PUBLISH/);
  assert.doesNotMatch(runner, /addAttempt/);
});

test('Full Backup / Restore validates before replacing local data', () => {
  assert.match(models, /interface BackupEnvelope/);
  assert.match(models, /EXPORT_BACKUP/);
  assert.match(models, /VALIDATE_BACKUP/);
  assert.match(models, /RESTORE_BACKUP/);
  assert.match(storage, /export async function exportBackup/);
  assert.match(storage, /export function validateBackup/);
  assert.match(storage, /export async function restoreBackup/);
  assert.match(serviceWorker, /BACKUP_RESTORE_WHILE_AUTOMATION_ACTIVE/);
  assert.match(uiSource, /backup\.export/);
  assert.match(uiSource, /backup\.restore/);
});

test('Phase 2 exposes persistent scheduling, profiles, notifications, and Badge controls', () => {
  assert.match(models, /SCHEDULED/);
  assert.match(models, /SCHEDULE/);
  assert.match(models, /RESCHEDULE/);
  assert.match(models, /CANCEL_SCHEDULE/);
  assert.match(models, /publishingWindows/);
  assert.match(models, /badgeMode/);
  assert.match(engineSource, /SCHEDULE_ALARM_NAME/);
  assert.match(engineSource, /chrome\.alarms\.create\(SCHEDULE_ALARM_NAME/);
  assert.match(engineSource, /getNextAllowedPublishingTime/);
  assert.match(engineSource, /chrome\.notifications\.create/);
  assert.match(engineSource, /ITEM_FAILED: defineEvent\('notifications\.failedItemTitle'/);
  assert.match(engineSource, /chrome\.action\.setBadgeText/);
  assert.match(uiSource, /ui\.schedule/);
  assert.match(uiSource, /ui\.reschedule/);
  assert.match(uiSource, /PublishingWindowsEditor/);
  assert.match(fs.readFileSync(path.join(root, 'src/ui/components/publishing-windows-editor.tsx'), 'utf8'), /type="time"/);
  assert.match(fs.readFileSync(path.join(root, 'src/ui/components/publishing-windows-editor.tsx'), 'utf8'), /publishingWindows\.add/);
});

test('Dry Run results show item number and preview without exposing target URLs', () => {
  assert.match(models, /DryRunItemResult \{ queueItemId: string; position: number/);
  assert.match(serviceWorker, /position: item\.position/);
  assert.match(uiSource, /tests\.itemNumber/);
  assert.match(uiSource, /getDryRunPreview\(item\.targetUrl,/);
  assert.doesNotMatch(uiSource.slice(uiSource.indexOf('export function DryRunCard'), uiSource.indexOf('export function CurrentTweetCard')), /item\.targetUrl\}\/span>/);
});

test('Scheduled Alarm creates a session when Queue has no prior session and reports empty Queue', () => {
  assert.match(engineSource, /current\.session \?\? \{/);
  assert.match(engineSource, /status: 'SCHEDULED'/);
  assert.match(engineSource, /SCHEDULE_START_FAILED: defineEvent\('notifications\.scheduleStartFailedTitle'/);
  assert.match(engineSource, /handleScheduledStart/);
});

test('Preflight automatically opens X and inspects readiness without publishing', () => {
  assert.match(engineSource, /async function performPreflight/);
  assert.match(engineSource, /state\.queue\.find\(\(item\) => canStartItem\(item\.status\)/);
  assert.match(engineSource, /chrome\.tabs\.create\(\{ url: 'about:blank', active: false \}\)/);
  assert.match(engineSource, /chrome\.tabs\.update\(temporary\.id, \{ url: targetUrl, active: false \}\)/);
  assert.match(engineSource, /await waitForTabLoad\(temporary\.id\)/);
  assert.match(engineSource, /xInspection = await inspectTab\(temporary\.id\)/);
  assert.match(serviceWorker, /finally \{\s*if \(temporaryTabId !== undefined\) await chrome\.tabs\.remove/);
  assert.match(uiSource, /preflight\.pressCheck/);
  assert.match(uiSource, /className="preflight-icon"/);
});

test('Feature 13 exposes shared advanced search filters across all entity views', () => {
  assert.match(uiSource, /SearchToolbar/);
  assert.match(uiSource, /nav\.sessions/);
  assert.match(uiSource, /history\.title/);
  assert.match(uiSource, /filterQueue/);
  assert.match(uiSource, /filterBanks/);
  assert.match(uiSource, /filterSessions/);
  assert.match(uiSource, /filterHistory/);
  assert.match(uiSource, /filters\.status/);
  assert.match(uiSource, /filters\.allBanks/);
  assert.match(uiSource, /filters\.allSessions/);
  assert.match(uiSource, /filters\.allWorkspaces/);
  assert.match(uiSource, /filters\.from/);
  assert.match(uiSource, /filters\.to/);
  assert.match(models, /sessionId\?: string/);
});

test('Feature 14 exposes all Bulk Queue actions with active-item protection', () => {
  assert.match(models, /BulkQueueAction/);
  for (const action of ['BULK_ACTION', 'DELETE', 'SKIP', 'RETRY', 'RESET_PENDING', 'MOVE_TOP', 'MOVE_BOTTOM', 'ASSIGN_BANK', 'EXPORT']) assert.match(models, new RegExp(action));
  assert.match(serviceWorker, /executeBulkAction/);
  assert.match(serviceWorker, /BULK_ACTIVE_ITEM_CONFIRMATION_REQUIRED/);
  assert.match(serviceWorker, /BULK_ACTIVE_ITEM_BUSY/);
  assert.match(serviceWorker, /BULK_BANK_NOT_FOUND_OR_ARCHIVED/);
  assert.match(uiSource, /queue\.selectPage/);
  assert.match(uiSource, /common\.resetPending/);
  assert.match(uiSource, /common\.moveTop/);
  assert.match(uiSource, /common\.moveBottom/);
  assert.match(uiSource, /common\.assignBank/);
  assert.match(uiSource, /common\.exportSelected/);
});

test('Individual Queue mutations persist, broadcast, and clear stale selection after deletion', () => {
  assert.match(engineSource, /async function commitQueueMutation/);
  assert.match(serviceWorker, /case 'DELETE_ITEM': return commitQueueMutation/);
  assert.match(serviceWorker, /case 'REORDER': return commitQueueMutation/);
  assert.match(engineSource, /await broadcast\(next\)/);
  assert.match(uiSource, /const queueAction = async/);
  assert.match(uiSource, /message\.type === 'DELETE_ITEM'/);
  assert.match(uiSource, /onAction=\{queueAction\}/);
});

test('Start creates a session when missing and automation-tab failure cannot leave an item stuck', () => {
  assert.match(serviceWorker, /case 'START':/);
  assert.match(engineSource, /const firstItem = current\.queue\.find\(\(item\) => canStartItem\(item\.status\)/);
  assert.match(engineSource, /const session(?:: AutomationSession)? = current\.session \?\? \{/);
  assert.match(serviceWorker, /let tabId: number \| undefined/);
  assert.match(engineSource, /tabId = await getOrCreateAutomationTab\(session\)/);
  assert.match(engineSource, /const failedStatus = exhausted \? 'FAILED' : 'PENDING'/);
});

test('Feature 15 exposes derived Workspace and global Analytics Dashboard metrics', () => {
  assert.match(uiSource, /AnalyticsTab/);
  assert.match(uiSource, /analytics\.totalSessions/);
  assert.match(uiSource, /analytics\.successRate/);
  assert.match(uiSource, /analytics\.duration/);
  assert.match(uiSource, /analytics\.mostActiveBank/);
  assert.match(uiSource, /analytics\.totalWorkspaces/);
  assert.match(uiSource, /analytics\.sessionsOverTime/);
  assert.match(uiSource, /analytics\.derivedHint/);
  assert.match(uiSource, /calculateGlobalAnalytics/);
  assert.match(uiSource, /calculateWorkspaceAnalytics/);
});

test('Feature 16 exposes a read-only Diagnostics Center with no publish path', () => {
  assert.match(models, /DiagnosticsCheckStatus/);
  assert.match(models, /RUN_DIAGNOSTICS/);
  assert.match(serviceWorker, /async function runDiagnostics/);
  assert.match(engineSource, /X_INSPECT/);
  assert.match(serviceWorker, /finally/);
  assert.match(serviceWorker, /DIAGNOSTICS_INSPECTION_FAILED/);
  assert.doesNotMatch(serviceWorker.slice(serviceWorker.indexOf('async function runDiagnostics'), serviceWorker.indexOf('function classifyDryRunInspection')), /X_PUBLISH|processCurrentItem|START/);
  assert.match(uiSource, /type TabId = 'operation' \| 'tests' \| 'queue' \| 'sessions' \| 'analytics' \| 'diagnostics'/);
  assert.match(uiSource, /label=\{t\('nav\.diagnostics'\)\}/);
  assert.match(uiSource, /diagnostics\.run/);
  assert.match(uiSource, /diagnostics\.readOnly/);
});

test('tab bar renders accessible live connection and engine indicators', () => {
  assert.match(uiSource, /GET_RUNTIME_STATUS/);
  assert.match(uiSource, /window\.setInterval\(\(\) => void refreshRuntimeStatus\(\), 1500\)/);
  assert.match(uiSource, /function StatusIndicator/);
  assert.match(uiSource, /statuses\.\$\{runtimeStatus\.connection\}/);
  assert.match(uiSource, /statuses\.\$\{runtimeStatus\.engineStatus\}/);
  assert.match(uiSource, /aria-live="polite"/);
  assert.match(uiSource, /runtime-warning/);
});

test('failed Continue path schedules the next item and its countdown alarm', () => {
  assert.match(engineSource, /const nextRunAt = !exhausted \|\| nextItem \?/);
  assert.match(engineSource, /nextItem \? 'WAITING'/);
  assert.match(engineSource, /if \(nextRunAt\) await chrome\.alarms\.create/);
});

test('Pause clears the active alarm and Resume recreates a waiting alarm', () => {
  assert.match(engineSource, /export async function pauseSession[\s\S]*?chrome\.alarms\.clear\(ALARM_NAME\)/);
  assert.match(engineSource, /const nextRunAt = current\.session\.nextRunAt/);
  assert.match(engineSource, /const hasFutureAlarm = Boolean\(nextRunAt/);
  assert.match(engineSource, /if \(hasFutureAlarm && nextRunAt\) \{[\s\S]*?chrome\.alarms\.create\(ALARM_NAME/);
});

test('startup and install listeners both invoke persisted-state recovery', () => {
  assert.match(serviceWorker, /chrome\.runtime\.onStartup\.addListener\(\(\) => \{ void cleanupRestoreStaging\(\)\.then\(recoverPersistedState\)/);
  assert.match(serviceWorker, /chrome\.runtime\.onInstalled\.addListener\(\(\) => \{[\s\S]*void cleanupRestoreStaging\(\)\.then\(recoverPersistedState\)/);
  assert.match(serviceWorker, /startup recovery failed/);
  assert.match(engineSource, /await chrome\.alarms\.clear\(ALARM_NAME\)/);
});

test('v1.0 retains START exclusivity through lease renewal and explicit Workspace scopes', () => {
  assert.match(storage, /export async function renewStartLock/);
  assert.match(engineSource, /renewStartLock\(startToken\)/);
  assert.match(engineSource, /setInterval\(\(\) =>/);
  assert.doesNotMatch(uiSource, /workspaceScopeMode|@active|filters\.activeWorkspace/);
  assert.match(uiSource, /value=\{filters\.workspaceId\}/);
  assert.match(uiSource, /setQueueFilters\(\{ \.\.\.emptySearchFilters, workspaceId \}\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/domain/search-filters.ts'), 'utf8'), /WorkspaceScopeMode|workspaceScopeMode/);
  assert.match(fs.readFileSync(path.join(root, 'src/ui/state/workspace-state-store.ts'), 'utf8'), /reconcileWorkspaceState/);
});

test('successful publish persists the next item before scheduling the wait', () => {
  assert.match(engineSource, /const nextItem = getNextPendingItem\(\(await getState\(\)\)\.queue, item\.id\)/);
  assert.match(engineSource, /currentItemId: nextItem\?\.id/);
  assert.match(engineSource, /const nextStatus = nextItem \? 'WAITING' : 'COMPLETED'/);
  assert.match(engineSource, /await chrome\.alarms\.clear\(ALARM_NAME\);\n    if \(nextRunAt\)/);
});

test('non-exhausted failures schedule a retry instead of recursively retrying', () => {
  assert.match(engineSource, /const nextRunAt = !exhausted \|\| nextItem \?/);
  assert.match(engineSource, /const nextStatus = exhausted && session\.failureBehavior === 'PAUSE' \? 'PAUSED' : nextItem \|\| !exhausted \? 'WAITING' : 'COMPLETED'/);
  assert.match(engineSource, /const nextItemId = nextItem\?\.id \?\? \(!exhausted \? item\.id : undefined\)/);
  assert.doesNotMatch(serviceWorker, /if \(nextStatus === 'RUNNING'\) await processCurrentItem\(\)/);
});

test('automation activates X before readiness polling and restores the previous tab', () => {
  assert.match(engineSource, /chrome\.tabs\.query\(\{ active: true, lastFocusedWindow: true \}\)/);
  assert.match(engineSource, /await chrome\.tabs\.update\(tabId, \{ url: item\.targetUrl, active: false \}\)/);
  assert.match(engineSource, /await waitForTabLoad\(tabId\);\n    await activateAutomationTab\(tabId\)/);
  assert.match(engineSource, /export async function activateAutomationTab\(tabId: number\): Promise<void>/);
  assert.match(engineSource, /await restoreActiveTab\(previousActiveTabId\)/);
  assert.match(engineSource, /if \(tab\.status === 'complete'\) finish\(\)/);
});

test('content injection is guarded per tab and cleaned on tab lifecycle events', () => {
  assert.match(engineSource, /const injectedContentTabs = new Set<number>\(\)/);
  assert.match(engineSource, /const contentInjectionInFlight = new Map<number, Promise<void>>\(\)/);
  assert.match(engineSource, /chrome\.tabs\.onUpdated\.addListener\(\(tabId, changeInfo\) => \{[\s\S]*injectedContentTabs\.delete\(tabId\)/);
  assert.match(engineSource, /chrome\.tabs\.onRemoved\.addListener\(\(tabId\) => \{[\s\S]*contentInjectionInFlight\.delete\(tabId\)/);
  assert.match(engineSource, /export async function ensureContentScript\(tabId: number\)/);
  assert.match(engineSource, /if \(existing\) return existing/);
  assert.match(engineSource, /await ensureContentScript\(tabId\)/);
});

test('content-entry installs only one runtime message listener per page', () => {
  assert.match(contentEntry, /__xPilotContentListenerInstalled/);
  assert.match(contentEntry, /if \(!contentGlobal\[listenerKey\]\)/);
});

test('bank extraction always removes its temporary tab in finally', () => {
  assert.match(serviceWorker, /async function extractBank\(bankUrl: string, workspaceId: string, mode: 'REPLACE' \| 'APPEND'/);
  assert.match(serviceWorker, /let bankTabId: number \| undefined/);
  assert.match(serviceWorker, /finally \{[\s\S]*if \(bankTabId\) await chrome\.tabs\.remove\(bankTabId\)\.catch/);
});

test('automation tab cleanup respects settings and clears persisted references', () => {
  assert.match(engineSource, /async function closeAutomationTabIfConfigured\(session: AutomationSession\)/);
  assert.match(engineSource, /session\.closeTabOnComplete \|\| !session\.keepAutomationTabOpen/);
  assert.match(serviceWorker, /await chrome\.tabs\.remove\(tabId\)\.catch/);
  assert.match(engineSource, /await chrome\.storage\.local\.remove\(AUTOMATION_TAB_KEY\)/);
  assert.match(engineSource, /automationTabId: undefined/);
});

test('manual automation-tab removal clears only the matching session reference', () => {
  assert.match(engineSource, /chrome\.tabs\.onRemoved\.addListener\(\(tabId\) => \{/);
  assert.match(engineSource, /state\.session\?\.automationTabId !== tabId/);
  assert.match(engineSource, /current\.session\?\.automationTabId === tabId/);
});

test('stop and completion paths clean the configured automation tab', () => {
  assert.match(engineSource, /export async function stopSession[\s\S]*?closeAutomationTabIfConfigured/);
  assert.match(engineSource, /const visibleState = nextStatus === 'COMPLETED' && nextState\.session/);
  assert.match(engineSource, /const visibleState = completed\.session \? await closeAutomationTabIfConfigured/);
  assert.match(engineSource, /if \(current\.session\?\.status !== 'RUNNING' \|\| latestItem\?\.operationId !== operationId\)/);
});

test('Workspace domain model includes independent entities and ownership metadata', () => {
  assert.match(models, /export interface Workspace \{/);
  assert.match(models, /export interface TweetBank \{/);
  assert.match(models, /export interface WorkspaceState extends AppState/);
  assert.match(models, /export interface AppMetaState \{/);
  assert.match(models, /automationWorkspaceId\?: string/);
  assert.match(models, /workspaceId\?: string/);
});

test('storage migration preserves legacy data and creates an idempotent default Workspace', () => {
  assert.match(storage, /LEGACY_STATE_KEY = 'xQueueState'/);
  assert.match(storage, /LEGACY_SETTINGS_KEY = 'xQueueSettings'/);
  assert.match(storage, /META_KEY = 'xPilotMeta'/);
  assert.match(storage, /schemaVersion: 3/);
  assert.match(storage, /مساحة العمل الافتراضية/);
  assert.match(storage, /await chrome\.storage\.local\.set\(\{ \[workspaceKey\(workspace\.id\)\]: migrated, \[META_KEY\]: meta \}\)/);
  assert.match(storage, /if \(existing\?\.schemaVersion === 2\)/);
});

test('Workspace runtime operations expose explicit ownership and management APIs', () => {
  assert.match(storage, /export async function claimAutomationOwner/);
  assert.match(storage, /AUTOMATION_OWNED_BY_OTHER_WORKSPACE/);
  assert.match(storage, /export async function releaseAutomationOwner/);
  assert.match(engineSource, /await claimAutomationOwner\(workspaceId\)/);
  assert.match(serviceWorker, /GET_WORKSPACES/);
  assert.match(serviceWorker, /SET_ACTIVE_WORKSPACE/);
  assert.match(uiSource, /type TabId = 'operation' \| 'tests' \| 'queue' \| 'sessions' \| 'analytics' \| 'diagnostics' \| 'workspaces' \| 'settings'/);
  assert.match(uiSource, /function WorkspaceCard/);
});

test('Workspace extraction does not silently overwrite Queue data', () => {
  assert.match(serviceWorker, /QUEUE_REPLACE_WHILE_ACTIVE/);
  assert.match(serviceWorker, /QUEUE_REPLACE_HAS_EXECUTED_ITEMS/);
  assert.match(serviceWorker, /existingUrls/);
  assert.match(uiSource, /banks\.append/);
  assert.match(uiSource, /t\('confirm\.replacePublished'\)/);
  assert.match(uiSource, /onRestore/);
});

test('Multiple Tweet Banks remain explicit and Workspace-scoped', () => {
  assert.match(models, /sourceBankId\?: string/);
  assert.match(models, /description\?: string; url: string; favorite: boolean; archived: boolean/);
  assert.match(models, /CREATE_BANK/);
  assert.match(models, /UPDATE_BANK/);
  assert.match(models, /ARCHIVE_BANK/);
  assert.match(models, /DELETE_BANK/);
  assert.match(storage, /export async function listBanks\(workspaceId: string/);
  assert.match(storage, /export async function createBank\(workspaceId: string/);
  assert.match(storage, /CANNOT_DELETE_RUNNING_BANK/);
  assert.match(serviceWorker, /case 'GET_BANKS'/);
  assert.match(serviceWorker, /sourceBankId: bankId/);
  assert.match(uiSource, /className=\{`bank-card/);
  assert.match(uiSource, /banks\.add/);
});

test('Refresh Diff is non-destructive and supports selective Queue merge', () => {
  assert.match(models, /BankDiffResult/);
  assert.match(models, /REFRESH_BANK/);
  assert.match(models, /ADD_DIFF_ITEMS/);
  assert.match(models, /DISCARD_BANK_DIFF/);
  assert.match(serviceWorker, /async function refreshBank\(workspaceId: string, bankId: string\)/);
  assert.match(serviceWorker, /classifyBankDiff\(workspaceId, bank, snapshot, state.queue,/);
  assert.match(serviceWorker, /mergeSelectedDiffItems\(workspaceState.queue, diff, bank, message.itemIds,/);
  assert.match(uiSource, /ui\.refreshDiff/);
  assert.match(uiSource, /diff\.addSelected/);
  assert.match(uiSource, /diff\.title/);
});

test('Refresh Diff requests optional host permission before reading a first-time bank', () => {
  assert.match(uiSource, /const refreshSelectedBank = async \(bank: TweetBank\)/);
  assert.match(uiSource, /chrome\.permissions\.request\(\{ origins: \[originPattern\] \}\)/);
  assert.match(uiSource, /if \(!granted\) return setNotice\(t\('banks\.permissionRequired'\)\)/);
  assert.match(uiSource, /Cannot access contents of url/);
  assert.match(uiSource, /t\('banks\.permissionRequired'\)/);
  assert.match(JSON.stringify(manifest), /optional_host_permissions/);
});

test('Duplicate Protection exposes SHA-256 fingerprints and policy controls', () => {
  assert.match(models, /contentFingerprint/);
  assert.match(models, /DuplicatePolicy/);
  assert.match(models, /duplicatePolicy: DuplicatePolicy/);
  assert.match(serviceWorker, /fingerprintTweet/);
  assert.match(serviceWorker, /fingerprintIndex/);
  assert.match(uiSource, /settings\.duplicatePolicy/);
  assert.match(uiSource, /diff\.previouslyPublishedContent/);
  assert.match(uiSource, /diff\.duplicateContent/);
});

test('Preflight Check exposes structured checks and guards Start', () => {
  assert.match(models, /PREFLIGHT_CHECK/);
  assert.match(serviceWorker, /performPreflight/);
  assert.match(engineSource, /PREFLIGHT_FAILED/);
  assert.match(uiSource, /tests\.preflight/);
  assert.match(uiSource, /tests\.runPreflight/);
});

test('Queue exposes selectable page sizes and previous/next pagination', () => {
  assert.match(pagination, /export type PageSize = 10 \| 50 \| 100 \| 'ALL'/);
  assert.match(uiSource, /queue\.selectPage/);
  assert.match(uiSource, /value="10"/);
  assert.match(uiSource, /value="50"/);
  assert.match(uiSource, /value="100"/);
  assert.match(uiSource, /value="ALL"/);
  assert.match(uiSource, /pagination-controls/);
  assert.match(uiSource, /setQueuePage\(\(current\) => Math\.max\(1, current - 1\)\)/);
  assert.match(uiSource, /setQueuePage\(\(current\) => Math\.min\(queuePageCount, current \+ 1\)\)/);
});

test('Settings and Backup cards use the shared card radius and aligned action layout', () => {
  assert.match(uiSource, /settings-card/);
  assert.match(uiSource, /profile-actions/);
  assert.match(uiSource, /backup-actions/);
  assert.match(styles, /\.settings-card \{ display: grid; gap: 14px; \}/);
  assert.match(styles, /\.settings-card \.publishing-windows-editor, \.settings-card \.profile-actions, \.settings-card \.backup-actions/);
  assert.match(styles, /\.settings-card \.profile-actions \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(styles, /\.settings-card \.backup-actions \.controls-row \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)/);
});

test('Badge mode changes persist and apply immediately without browser restart', () => {
  assert.match(serviceWorker, /case 'UPDATE_SETTINGS'/);
  assert.match(serviceWorker, /await saveSettings\(message\.settings\)/);
  assert.match(serviceWorker, /await broadcast\(updated\)/);
  assert.match(engineSource, /await updateBadge\(snapshot\)/);
  assert.match(engineSource, /settings\.badgeMode === 'COUNT'/);
  assert.match(engineSource, /settings\.badgeMode === 'STATUS'/);
});

test('daily-limit internal code is translated only at the UI presentation boundary', () => {
  assert.match(errorMessages, /X_DAILY_POST_LIMIT_REACHED/);
  assert.match(errorMessages, /errors\.dailyPostLimitReached/);
  assert.match(uiSource, /getUserFacingMessage/);
});

test('bank import validation is delegated to the domain layer, not the service worker', () => {
  assert.match(serviceWorker, /import \{ buildBankExport, buildBanksExport, parseBankImport \} from '\.\.\/domain\/bank-transfer'/);
  assert.match(serviceWorker, /case 'EXPORT_BANKS'/);
  assert.match(serviceWorker, /case 'IMPORT_BANKS'/);
  assert.match(serviceWorker, /const imported = parseBankImport\(message\.payload\)/);
  assert.match(storage, /export async function importBanks\(workspaceId: string, banks: TweetBank\[\]\)/);
  const importBanksBody = storage.match(/export async function importBanks\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(importBanksBody, /queue|session/i, 'importBanks must only write banks and never touch queue or sessions');
});

test('bank export envelope never embeds workspace isolation identifiers', () => {
  assert.match(bankTransfer, /export function buildBankExport\(/);
  assert.match(bankTransfer, /export function buildBanksExport\(/);
  const payloadBuilder = bankTransfer.match(/export function buildBankExportPayload\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(payloadBuilder, /workspaceId/);
  assert.doesNotMatch(payloadBuilder, /\bid:/);
  assert.match(bankTransfer, /SUPPORTED_BANK_EXPORT_FORMAT_VERSION = 1/);
});

test('tweet bank export and import are exposed through localized UI actions', () => {
  assert.match(uiSource, /type: 'EXPORT_BANKS'/);
  assert.match(uiSource, /type: 'IMPORT_BANKS'/);
  assert.match(uiSource, /t\('banks\.export'\)/);
  assert.match(uiSource, /t\('banks\.exportAll'\)/);
  assert.match(uiSource, /t\('banks\.import'\)/);
  assert.match(errorMessages, /BANK_IMPORT_INVALID/);
  assert.match(errorMessages, /errors\.bankImportInvalid/);
});

test('Start Over recovery is delegated to the domain and never auto-publishes', () => {
  assert.match(models, /type: 'RECOVERY_START_OVER'/);
  assert.match(serviceWorker, /case 'RECOVERY_START_OVER'/);
  assert.match(engineSource, /buildStartOverQueue\(state\.queue/);
  const startOverFn = engineSource.match(/export async function startOverSession\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(startOverFn, /processCurrentItem/, 'Start Over must never trigger publishing');
  assert.match(startOverFn, /releaseAutomationOwner/);
  assert.match(startOverFn, /chrome\.alarms\.clear\(ALARM_NAME\)/);
  const recoveryDomain = fs.readFileSync(path.join(root, 'src/domain/recovery.ts'), 'utf8');
  const startOverBuilder = recoveryDomain.match(/export function buildStartOverQueue\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(startOverBuilder, /status: 'PENDING'[\s\S]{0,80}PUBLISHING/, 'PUBLISHING must never become PENDING');
  assert.match(recoveryDomain, /PUBLISHED_UNVERIFIED/);
});

test('Recovery card exposes three localized actions including Start Over and Cancel', () => {
  assert.match(uiSource, /failedCount/);
  assert.match(uiSource, /onStartOver/);
  assert.match(uiSource, /onCancel/);
  assert.match(uiSource, /t\('recovery\.startOver'\)/);
  assert.match(uiSource, /t\('recovery\.cancelSession'\)/);
  assert.match(uiSource, /t\('recovery\.confirmStartOver'/);
  const styles2 = fs.readFileSync(path.join(root, 'src/ui/styles.css'), 'utf8');
  assert.match(styles2, /\.recovery-actions \{ display: grid/);
});

test('Automation engine is an isolated module; the service worker only routes', () => {
  // The engine owns the publish core.
  assert.match(engineSource, /async function processCurrentItem/);
  assert.match(engineSource, /async function advanceSession/);
  assert.match(engineSource, /export async function startSession/);
  assert.match(engineSource, /export async function pauseSession/);
  assert.match(engineSource, /export async function resumeSession/);
  assert.match(engineSource, /export async function stopSession/);
  assert.match(engineSource, /export async function startOverSession/);
  assert.match(engineSource, /export async function scheduleSession/);
  // The service worker must not re-implement engine behavior.
  assert.doesNotMatch(serviceWorker, /async function processCurrentItem/);
  assert.doesNotMatch(serviceWorker, /async function advanceSession/);
  assert.doesNotMatch(serviceWorker, /async function handleAlarm/);
  assert.doesNotMatch(serviceWorker, /async function performPreflight/);
  // Engine control cases delegate to the engine module.
  assert.match(serviceWorker, /case 'START': return startSession/);
  assert.match(serviceWorker, /case 'PAUSE': return pauseSession\(\)/);
  assert.match(serviceWorker, /case 'RESUME': return resumeSession\(\)/);
  assert.match(serviceWorker, /case 'STOP': return stopSession\(\)/);
  assert.match(serviceWorker, /case 'RECOVERY_START_OVER': return startOverSession\(\)/);
  assert.match(serviceWorker, /case 'START_SCHEDULED_NOW': return startScheduledNow\(\)/);
  assert.match(serviceWorker, /case 'CANCEL_SCHEDULE': return cancelScheduledStart\(\)/);
  assert.match(serviceWorker, /case 'SCHEDULE': return scheduleSession/);
  assert.match(serviceWorker, /case 'PREFLIGHT_CHECK': \{\s*const workspaceId[\s\S]*?return performPreflight/);
});

test('Automation engine has no import path back into the service worker or UI', () => {
  assert.doesNotMatch(engineSource, /service-worker/);
  assert.doesNotMatch(engineSource, /from '\.\.\/ui\//);
  assert.doesNotMatch(engineSource, /runtime\.onMessage/);
});

test('Engine module preserves the publish safety invariants', () => {
  assert.match(engineSource, /shouldNeverRepublish\(item\)/);
  assert.match(engineSource, /canStartItem\(item\.status\)/);
  assert.match(engineSource, /publishIntentId: operationId/); // intent persisted before submit
  assert.match(engineSource, /PUBLISHED_UNVERIFIED/); // uncertain outcome never auto-republished
  assert.match(engineSource, /AUTOMATION_INTERRUPTED/); // stale-operation guard
  assert.match(engineSource, /acquireStartLock/);
  assert.match(engineSource, /renewStartLock/);
  assert.match(engineSource, /performPreflight\(/); // preflight gates start/schedule
  assert.match(engineSource, /persistAcrossSessions: true/); // alarms survive restarts
});

test('Missed-schedule recovery stays user-driven and engine-owned', () => {
  // Pure detection lives in the recovery domain with an explicit grace window.
  assert.match(recoverySource, /MISSED_SCHEDULE_GRACE_MS/);
  assert.match(recoverySource, /export function detectMissedSchedule/);
  // The engine op requires a SCHEDULED session and never starts blindly.
  assert.match(engineSource, /export async function startScheduledNow/);
  const opBody = engineSource.slice(engineSource.indexOf('export async function startScheduledNow'), engineSource.indexOf('export async function pauseSession'));
  assert.match(opBody, /status !== 'SCHEDULED'/); // only missed scheduled sessions
  assert.match(opBody, /performPreflight\(workspaceId\)/); // readiness gate before publishing
  assert.match(opBody, /acquireStartLock/); // start lease held
  assert.match(opBody, /chrome\.alarms\.clear\(SCHEDULE_ALARM_NAME\)/); // missed alarm cannot double-fire
  assert.doesNotMatch(opBody, /setTimeout/); // scheduling stays on chrome.alarms
  // The card only appears for missed SCHEDULED sessions and is fully localized.
  const operationTab = fs.readFileSync(path.join(root, 'src/ui/tabs/OperationTab.tsx'), 'utf8');
  assert.match(operationTab, /detectMissedSchedule\(session, nowMs\)/);
  assert.match(operationTab, /type: 'START_SCHEDULED_NOW'/);
  assert.match(operationTab, /type: 'CANCEL_SCHEDULE'/);
  const cards = fs.readFileSync(path.join(root, 'src/ui/components/operation-cards.tsx'), 'utf8');
  assert.match(cards, /export function MissedScheduleCard/);
  assert.match(cards, /recovery\.missedTitle/);
  assert.match(cards, /recovery\.missedDescription/);
  assert.match(cards, /recovery\.startNow/);
  assert.doesNotMatch(cards, /startScheduledNow|chrome\.alarms/); // UI never schedules or publishes directly
  // i18n parity for the new keys.
  for (const file of ['src/i18n/ar.ts', 'src/i18n/en.ts']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const key of ['missedTitle', 'missedBadge', 'missedDescription', 'missedHint', 'startNow', 'startedNow']) {
      assert.match(source, new RegExp(key + ':'), file + ' missing ' + key);
    }
  }
});

test('Every engine notification is translatable through the key-first notifyEvent bridge', () => {
  const bridge = engineSource.slice(engineSource.indexOf('export const NOTIFICATION_EVENTS'), engineSource.indexOf('export async function updateBadge'));
  // The bridge must be key-first: a typed registry + (key, params) signature.
  assert.match(bridge, /export type NotificationEventKey = keyof typeof NOTIFICATION_EVENTS/);
  assert.match(engineSource, /export async function notifyEvent\(event: NotificationEventKey, params\?: NotificationParams\)/);
  // Registry size floor: one entry per engine notification event.
  const registryKeys = [...bridge.matchAll(/^  ([A-Z][A-Z0-9_]+): defineEvent\('/gm)].map((m) => m[1]);
  assert.ok(registryKeys.length >= 16, `notification registry must keep covering all events (found ${registryKeys.length})`);
  // Walk every call site: keys only — no user-facing literals may leak back in.
  const callSites = [...engineSource.matchAll(/notifyEvent\('([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(callSites.length >= 15, 'engine notification call sites must stay covered');
  for (const key of callSites) assert.ok(registryKeys.includes(key), `call site uses unregistered notification event: ${key}`);
  // No Arabic (or any string-literal) messages at call sites — key-first only.
  const literalCallSites = [...engineSource.matchAll(/notifyEvent\('([X-X]?[^'][A-Za-z][^']*)'/g)].filter((m) => !registryKeys.includes(m[1]) && m[1].length > 2);
  assert.equal(literalCallSites.length, 0, `notifyEvent call sites must only pass registry keys, found: ${literalCallSites.map((m) => m[1]).join(', ')}`);
  // Every referenced i18n key (titles + messages + dynamic summary keys) must exist in ar AND en.
  const ar = fs.readFileSync(path.join(root, 'src/i18n/ar.ts'), 'utf8');
  const en = fs.readFileSync(path.join(root, 'src/i18n/en.ts'), 'utf8');
  const referencedKeys = [...bridge.matchAll(/'(notifications\.[A-Za-z0-9]+)'/g)].map((m) => m[1]);
  const summaryKeys = [...engineSource.matchAll(/summaryKey: preflight\.summaryKey/g)];
  assert.ok(referencedKeys.length >= 20, 'registry must reference its title and message i18n keys');
  assert.ok(summaryKeys.length >= 3, 'preflight failure call sites must forward the summary key');
  for (const key of referencedKeys) {
    const short = key.replace('notifications.', '');
    assert.match(ar, new RegExp(`${short}:`), `ar.ts missing ${key}`);
    assert.match(en, new RegExp(`${short}:`), `en.ts missing ${key}`);
  }
  // The known regression: the controls-missing branch must be a registered event, not a ternary literal.
  assert.match(engineSource, /CONTROLS_NOT_READY/);
  assert.doesNotMatch(engineSource, /تعذر العثور على عناصر النشر/, 'call sites must not embed Arabic notification literals');
});

test('Header renders the session status exactly once and pagination has no dead code', () => {
  const headerStart = uiSource.indexOf('<div className="header-status">');
  const headerEnd = uiSource.indexOf('</header>', headerStart);
  const header = uiSource.slice(headerStart, headerEnd);
  assert.match(header, /header-live-dot/);
  assert.match(header, /<StatusBadge/);
  assert.equal((header.match(/t\(\\?`statuses\./g) ?? []).length, 1, 'header must render exactly one localized status label');
  assert.doesNotMatch(pagination, /pageSizeLabel/);
  assert.doesNotMatch(uiSource, /pageSizeLabel/);
});
