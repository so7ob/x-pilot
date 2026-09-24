import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ui = [
  '../src/ui/main.tsx',
  '../src/ui/types/navigation.ts',
  '../src/ui/services/runtime-client.ts',
  '../src/ui/components/operation-cards.tsx',
  '../src/ui/tabs/OperationTab.tsx',
  '../src/ui/tabs/StartupTestsTab.tsx',
  '../src/ui/tabs/AnalyticsTab.tsx',
  '../src/ui/tabs/DiagnosticsTab.tsx',
].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
const operation = fs.readFileSync(new URL('../src/ui/tabs/OperationTab.tsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
const components = fs.readFileSync(new URL('../src/ui/components.tsx', import.meta.url), 'utf8');
const plan = fs.readFileSync(new URL('../docs/ui-redesign-plan.md', import.meta.url), 'utf8');

test('premium UI uses semantic design tokens and shared primitives', () => {
  for (const token of ['--color-bg', '--color-surface', '--color-primary', '--color-success', '--color-warning', '--color-danger', '--radius-md', '--space-4', '--shadow-md', '--transition-fast']) assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(components, /export function Icon/);
  assert.match(components, /export function Button/);
  assert.match(components, /export function StatusBadge/);
  assert.match(components, /export function ProgressBar/);
  assert.match(components, /<path d=\{paths\[name\]\} \/>/);
  assert.doesNotMatch(components, /paths\[name\]\.split/);
});

test('navigation remains feature-complete while using grouped information architecture', () => {
  for (const key of ['operation', 'startupTests', 'banks', 'sessions', 'analytics', 'diagnostics', 'workspaces', 'settings']) assert.match(ui, new RegExp(`nav\\.${key}`));
  assert.match(ui, /history\.title/);
  for (const key of ['control', 'content', 'activity', 'insights', 'manage']) assert.match(ui, new RegExp(`common\.${key}`));
  assert.match(ui, /aria-current=/);
});

test('premium UI retains no-post and existing runtime safety contracts', () => {
  assert.match(ui, /DRY_RUN_FIRST/);
  assert.match(ui, /RUN_DIAGNOSTICS/);
  assert.match(ui, /type: 'START'/);
  assert.match(ui, /type: 'PAUSE'/);
  assert.match(ui, /type: 'RESUME'/);
  assert.match(ui, /type: 'STOP'/);
  assert.match(ui, /target="_blank"/);
});

test('responsive and reduced-motion rules cover the Side Panel range', () => {
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /@media \(max-width: 360px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(plan, /Do not modify service-worker or domain logic/);
});

test('operation view keeps the dashboard compact and reveals navigation on hover or focus', () => {
  assert.match(ui, /shell-\$\{activeTab\}/);
  assert.match(css, /\.shell-operation \.tabs-bar:hover \.tabs/);
  assert.match(css, /\.shell-operation \.tabs-bar:focus-within \.tabs/);
  assert.match(css, /@media \(max-height: 700px\)/);
  assert.match(css, /\.shell-operation \.countdown/);
});

test('operation dashboard owns the scheduled and waiting timer display', () => {
  const heroStart = operation.indexOf('className="card operation-hero"');
  const heroEnd = operation.indexOf('</section>', heroStart);
  const hero = operation.slice(heroStart, heroEnd);
  const controlsStart = operation.indexOf('className="card controls"');
  const controlsEnd = operation.indexOf('</section>', controlsStart);
  const controls = operation.slice(controlsStart, controlsEnd);
  assert.match(hero, /dashboard-countdown/);
  assert.match(hero, /formatCountdown\(countdownSeconds\)/);
  assert.doesNotMatch(controls, /dashboard-countdown|formatCountdown\(countdownSeconds\)/);
});

test('all tabs share the same header and the Workspace switcher stays compact', () => {
  assert.match(ui, /<header className="app-header">/);
  assert.match(ui, /<span className="eyebrow">\{t\('ui\.workspaceActive'\)\}<\/span>\{activeWorkspace\?\.color && <span className="workspace-color-dot"[^>]*\/>\}<strong dir="auto">/);
  assert.match(ui, /workspace-manage-button/);
  assert.doesNotMatch(ui, /className="workspace-avatar"/);
  assert.doesNotMatch(ui, /عنصر متبقٍ/);
  assert.doesNotMatch(ui, /activeWorkspace\?\.icon \?\? '◈'/);
  assert.doesNotMatch(css, /\.shell-operation \.app-header|\.shell-operation \.premium-switcher/);
});

test('informational notices auto-dismiss while errors remain readable', () => {
  assert.match(ui, /useEffect\(\(\) => \{ if \(!notice \|\| noticeKind === 'error'\)/);
  assert.match(ui, /window\.setTimeout\(\(\) => setNoticeState\(''\), 3500\)/);
  assert.match(ui, /notice-\$\{noticeKind\}/);
  assert.match(ui, /notice-dismiss/);
  assert.doesNotMatch(ui, /لا تُخزن بيانات الدخول/);
});
