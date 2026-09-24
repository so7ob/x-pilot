/**
 * Command palette model: Arabic-aware filtering, command building, grouping,
 * and the purity contract (no chrome APIs, no DOM, no storage).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildPaletteCommands,
  buildHighlightSegments,
  filterCommands,
  groupCommands,
  matchCommand,
  matchLabel,
  normalizeForMatch,
  normalizeWithIndexMap,
  recordRecentCommand,
  sanitizeRecentCommandIds,
  SCORE_EXACT,
  SCORE_PREFIX,
  SCORE_WORD_START,
  SCORE_LABEL_INCLUDES,
  SCORE_KEYWORD_EXACT,
  SCORE_KEYWORD_PREFIX,
  SCORE_KEYWORD_INCLUDES,
  SCORE_SUBSEQUENCE_BASE,
  SUBSEQUENCE_MIN_QUERY,
  MAX_RECENT_COMMANDS,
} from '../src/ui/services/command-palette.ts';

const tab = (id, label) => ({ id: `tab:${id}`, kind: 'tab', label, value: id });
const command = (id, label, keywords = []) => ({ id, kind: 'action', label, keywords });

test('normalizeForMatch folds Arabic forms and Latin case', () => {
  assert.equal(normalizeForMatch('الأحداث'), normalizeForMatch('الاحداث'), 'alef with hamza/madda folds to plain alef');
  assert.equal(normalizeForMatch('إعدادات'), normalizeForMatch('اعدادات'));
  assert.equal(normalizeForMatch('مدرسة'), normalizeForMatch('مدرسه'), 'teh marbuta folds to heh');
  assert.equal(normalizeForMatch('على'), normalizeForMatch('علي'), 'alef maqsura folds to yeh');
  assert.equal(normalizeForMatch('مـَدرسة'), normalizeForMatch('مدرسه'), 'diacritics and tatweel are stripped');
  assert.equal(normalizeForMatch('Queue'), normalizeForMatch('queue'));
  assert.equal(normalizeForMatch('  CSV Export '), 'csv export');
  assert.equal(normalizeForMatch(''), '');
});

test('filterCommands matches labels and keywords, case- and Arabic-insensitively', () => {
  const commands = [
    tab('queue', 'Tweet Banks'),
    tab('sessions', 'الجلسات'),
    tab('settings', 'الإعدادات'),
    command('a:clear-filters', 'Clear view filters', ['مسح', 'تصفية']),
  ];

  assert.deepEqual(filterCommands(commands, '').map((item) => item.id), commands.map((item) => item.id), 'empty query returns everything');
  assert.deepEqual(filterCommands(commands, 'banks').map((item) => item.id), ['tab:queue']);
  assert.deepEqual(filterCommands(commands, 'BANKS').map((item) => item.id), ['tab:queue'], 'latin matching is case-insensitive');
  assert.deepEqual(filterCommands(commands, 'الاجلسات'), [], 'substring matching never reorders letters');
  assert.deepEqual(filterCommands(commands, 'الجلسات').map((item) => item.id), ['tab:sessions']);
  assert.deepEqual(filterCommands(commands, 'اعدادات').map((item) => item.id), ['tab:settings'], 'hamza-less query folds to match hamza label');
  assert.deepEqual(filterCommands(commands, 'الإعدادات').map((item) => item.id), ['tab:settings']);
  assert.deepEqual(filterCommands(commands, 'تصفيه').map((item) => item.id), ['a:clear-filters'], 'keyword match folds teh marbuta in the query');
  assert.deepEqual(filterCommands(commands, 'zzz'), []);
});

test('groupCommands keeps tab/action/workspace order and drops empty groups', () => {
  const commands = [
    command('a:x', 'Action X'),
    tab('operation', 'Operation'),
    { id: 'w:1', kind: 'workspace', label: 'Campaign B' },
    tab('tests', 'Startup Tests'),
  ];
  const groups = groupCommands(commands, { tab: 'Tabs', action: 'Actions', workspace: 'Switch workspace' });
  assert.deepEqual(groups.map((group) => group.kind), ['tab', 'action', 'workspace']);
  assert.deepEqual(groups[0].commands.map((item) => item.id), ['tab:operation', 'tab:tests']);
  assert.equal(groups[0].label, 'Tabs');
  assert.equal(groups[1].label, 'Actions');

  const tabsOnly = groupCommands([tab('operation', 'Operation')], { tab: 'Tabs', action: 'Actions', workspace: 'Switch workspace' });
  assert.deepEqual(tabsOnly.map((group) => group.kind), ['tab'], 'empty groups are dropped');
});

test('buildPaletteCommands builds tabs, disabled-safe actions, and hides the active workspace', () => {
  const commands = buildPaletteCommands({
    tabs: [
      { id: 'operation', label: 'Operation', icon: 'play' },
      { id: 'sessions', label: 'Sessions', icon: 'clock' },
    ],
    actions: [
      { id: 'refresh-data', label: 'Refresh all data' },
      { id: 'export-backup', label: 'Export full backup', disabled: true },
    ],
    workspaces: [
      { id: 'ws-main', name: 'Main Workspace', active: true },
      { id: 'ws-b', name: 'Campaign B', active: false },
    ],
    activeWorkspaceId: 'ws-main',
  });

  const ids = commands.map((item) => item.id);
  assert.deepEqual(ids, ['tab:operation', 'tab:sessions', 'action:refresh-data', 'workspace:ws-b'], 'order is tabs, actions, workspaces; active workspace and disabled actions are excluded');
  assert.equal(commands.find((item) => item.id === 'tab:operation')?.value, 'operation');
  assert.equal(commands.find((item) => item.id === 'workspace:ws-b')?.label, 'Campaign B');
  assert.ok(commands.find((item) => item.id === 'workspace:ws-b')?.keywords?.includes('switch'), 'workspace commands carry latin keywords');
});

test('i18n-sourced aliases let Arabic and English queries find tabs', () => {
  const commands = buildPaletteCommands({
    tabs: [
      { id: 'operation', label: 'التشغيل', icon: 'play' },
      { id: 'analytics', label: 'Analytics', icon: 'analytics' },
      { id: 'settings', label: 'الإعدادات', icon: 'settings' },
    ],
    aliases: {
      'tab:operation': ['لوحة', 'تشغيل'],
      'tab:analytics': ['إحصاء', 'تحليل'],
      'tab:settings': ['إعدادات', 'خيارات'],
    },
  });
  assert.ok(filterCommands(commands, 'dashboard').some((item) => item.id === 'tab:operation'), 'built-in latin alias reaches an arabic-labeled tab');
  assert.ok(filterCommands(commands, 'احصاء').some((item) => item.id === 'tab:analytics'), 'i18n arabic alias reaches an english-labeled tab');
  assert.ok(filterCommands(commands, 'إعدادات').some((item) => item.id === 'tab:settings'));
  assert.ok(filterCommands(commands, 'تشغيل').some((item) => item.id === 'tab:operation'), 'arabic alias folds hamza forms in queries');
});

test('palette model stays pure: no chrome APIs, no DOM, no storage access', () => {
  const source = fs.readFileSync(new URL('../src/ui/services/command-palette.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /chrome\.|document\.|window\.|localStorage|sessionStorage|setTimeout/);
});

test('recordRecentCommand is most-recent-first, dedupes and caps', () => {
  assert.deepEqual(recordRecentCommand([], 'action:refresh-data'), ['action:refresh-data']);
  assert.deepEqual(recordRecentCommand(['tab:operation'], 'tab:sessions'), ['tab:sessions', 'tab:operation'], 'newest first');
  assert.deepEqual(
    recordRecentCommand(['tab:operation', 'tab:sessions'], 'tab:operation'),
    ['tab:operation', 'tab:sessions'],
    're-running a command moves it to the front without duplicates',
  );
  let recent = [];
  for (let i = 0; i < MAX_RECENT_COMMANDS + 3; i++) recent = recordRecentCommand(recent, `action:x${i}`);
  assert.equal(recent.length, MAX_RECENT_COMMANDS, 'list is capped');
  assert.equal(recent[0], `action:x${MAX_RECENT_COMMANDS + 2}`);
});

test('sanitizeRecentCommandIds drops junk, dedupes and caps', () => {
  assert.deepEqual(sanitizeRecentCommandIds(['a', 5, null, '', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(sanitizeRecentCommandIds('nope'), []);
  assert.deepEqual(sanitizeRecentCommandIds({ 0: 'a' }), []);
  assert.deepEqual(sanitizeRecentCommandIds(Array.from({ length: 20 }, (_, i) => `id-${i}`)).length, MAX_RECENT_COMMANDS);
  assert.deepEqual(sanitizeRecentCommandIds(undefined), []);
});

test('groupCommands surfaces recents as the leading group without duplicating them', () => {
  const commands = [
    tab('operation', 'Operation'),
    tab('sessions', 'Sessions'),
    command('a:refresh-data', 'Refresh all data'),
    command('a:export-backup', 'Export backup'),
    { id: 'w:1', kind: 'workspace', label: 'Campaign B' },
  ];
  const labels = { tab: 'Tabs', action: 'Actions', workspace: 'Switch workspace' };
  const groups = groupCommands(commands, labels, { ids: ['a:refresh-data', 'tab:operation', 'ghost', 'a:refresh-data'], label: 'Recently used' });
  assert.deepEqual(groups.map((group) => group.kind), ['recent', 'tab', 'action', 'workspace'], 'recent group leads, other groups keep their order');
  assert.equal(groups[0].label, 'Recently used');
  assert.deepEqual(groups[0].commands.map((item) => item.id), ['a:refresh-data', 'tab:operation'], 'recency order, duplicates and unknown ids dropped');
  assert.deepEqual(groups[1].commands.map((item) => item.id), ['tab:sessions'], 'recent tabs are not repeated in their kind group');
  assert.deepEqual(groups[2].commands.map((item) => item.id), ['a:export-backup'], 'non-recent actions stay in the action group');
  const withoutRecents = groupCommands(commands, labels);
  assert.deepEqual(withoutRecents.map((group) => group.kind), ['tab', 'action', 'workspace'], 'no recents keeps the legacy shape');
  const emptyRecent = groupCommands(commands, labels, { ids: ['ghost'], label: 'Recently used' });
  assert.deepEqual(emptyRecent.map((group) => group.kind), ['tab', 'action', 'workspace'], 'an all-stale recent list yields no recent group');
});


// ---- fuzzy scoring + highlighting engine (Cycle B, v1.11.0) ----

const H = (label) => [...label].map((_, i) => i); // 0..n-1 positions

test('normalizeWithIndexMap tracks original positions through folds and stripped marks', () => {
  // 1:1 fold: every normalized char maps to its source index
  const folded = normalizeWithIndexMap('الإعدادات');
  assert.equal(folded.normalized, 'الاعدادات');
  assert.equal(folded.map.length, folded.normalized.length);
  assert.deepEqual(folded.map, [...folded.normalized].map((_, i) => i));
  // Marks are stripped and the map skips their positions
  const marked = normalizeWithIndexMap('عَلَيْهِ');
  assert.equal(marked.normalized, 'عليه');
  assert.deepEqual(marked.map, [0, 2, 4, 6]);
  // Leading whitespace trims with the map re-based
  const padded = normalizeWithIndexMap('  abc');
  assert.equal(padded.normalized, 'abc');
  assert.deepEqual(padded.map, [2, 3, 4]);
});

test('matchLabel walks the ladder: exact > prefix > word-start > includes > subsequence', () => {
  assert.equal(matchLabel('الجلسات', 'الجلسات').score, SCORE_EXACT);
  assert.equal(matchLabel('Refresh data', 'refresh').score, SCORE_PREFIX + 7);
  assert.equal(matchLabel('Clear view filters', 'view').score, SCORE_WORD_START + 4);
  assert.equal(matchLabel('Tweet Banks', 'anks').score, SCORE_LABEL_INCLUDES - 7);
  // Subsequence: letters in order with gaps, min length 2
  const sub = matchLabel('الجلسات', 'الجسات');
  assert.ok(sub.matched);
  // runs [0,1,2] and [4,5,6] = 4 consecutive bonuses; one skipped char (ل) = 1 gap unit
  assert.equal(sub.score, SCORE_SUBSEQUENCE_BASE + 4 * 15 - 1 * 2);
  assert.deepEqual(sub.ranges, [[0, 3], [4, 7]], 'skipped label chars stay unhighlighted');
  assert.equal(matchLabel('الجلسات', 'ا').score >= SCORE_PREFIX, true, '1-char query that IS a prefix still matches exactly');
  assert.equal(matchLabel('Refresh data', 'z').matched, false, '1-char query never goes fuzzy beyond substring ladder');
  assert.equal(matchLabel('الجلسات', 'سات').matched, true, '2-char query may subsequence-match');
  assert.equal(matchLabel('الجلسات', 'zzz').matched, false);
});

test('matchLabel reports highlight ranges in ORIGINAL coordinates', () => {
  // includes on a plain label
  assert.deepEqual(matchLabel('Tweet Banks', 'banks').ranges, [[6, 11]]);
  // hamza-less query hits the folded label but highlights the real glyphs
  const folded = matchLabel('الإعدادات', 'اعدادات');
  assert.deepEqual(folded.ranges, [[2, 9]]);
  // diacritics split the match into per-glyph ranges in ORIGINAL coordinates
  const marked = matchLabel('عَلَيْهِ', 'عليه');
  assert.deepEqual(marked.ranges, [[0, 1], [2, 3], [4, 5], [6, 7]]);
});

test('matchCommand prefers the label and never highlights keyword-only matches', () => {
  const command = { id: 'x', kind: 'action', label: 'Export data', keywords: ['تصدير'] };
  assert.deepEqual(matchCommand(command, 'تصدير'), { matched: true, score: SCORE_KEYWORD_EXACT, ranges: [] });
  assert.equal(matchCommand(command, 'تصدي').score, SCORE_KEYWORD_PREFIX);
  assert.equal(matchCommand(command, 'صدي').score, SCORE_KEYWORD_INCLUDES);
  assert.equal(matchCommand({ ...command, label: 'تصدير' }, 'تصدير').score, SCORE_EXACT, 'label beats keyword');
  assert.equal(matchCommand(command, 'zzz').matched, false);
});

test('filterCommands ranks survivors best-first and stays stable on ties', () => {
  const commands = [
    { id: 'weak', kind: 'action', label: 'Restore from backup', keywords: [] },
    { id: 'prefix', kind: 'action', label: 'Refresh data', keywords: [] },
    { id: 'keyword', kind: 'action', label: 'Download everything', keywords: ['refresh'] },
    { id: 'sub', kind: 'action', label: 'Reorder queue items', keywords: [] },
  ];
  assert.deepEqual(filterCommands(commands, 'refresh').map((c) => c.id), ['prefix', 'keyword'], 'no label hit and no keyword hit => not matched (subsequence is label-only)');
  // subsequence 'rordr' hits 'Reorder...' only
  assert.deepEqual(filterCommands(commands, 'rordr').map((c) => c.id), ['sub']);
  // empty query: everything, original order
  assert.deepEqual(filterCommands(commands, '').map((c) => c.id), commands.map((c) => c.id));
  // tie stability: identical scores keep builder order
  const ties = [
    { id: 'a', kind: 'action', label: 'Alpha one', keywords: [] },
    { id: 'b', kind: 'action', label: 'Alpha two', keywords: [] },
  ];
  assert.deepEqual(filterCommands(ties, 'alpha').map((c) => c.id), ['a', 'b']);
});

test('buildHighlightSegments splits only matched parts and handles Arabic + multi-range', () => {
  assert.deepEqual(buildHighlightSegments('Tweet Banks', ''), [{ text: 'Tweet Banks', highlighted: false }]);
  assert.deepEqual(buildHighlightSegments('Tweet Banks', 'banks'), [
    { text: 'Tweet ', highlighted: false },
    { text: 'Banks', highlighted: true },
  ]);
  // folded query highlights the real glyphs (skips ال)
  assert.deepEqual(buildHighlightSegments('الإعدادات', 'اعدادات'), [
    { text: 'ال', highlighted: false },
    { text: 'إعدادات', highlighted: true },
  ]);
  // subsequence produces multiple disjoint ranges (greedy earliest positions)
  const segments = buildHighlightSegments('Restore from backup', 'rsbk');
  assert.deepEqual(segments.filter((s) => s.highlighted).map((s) => s.text), ['R', 's', 'b', 'k']);
  // whitespace-only query degrades to no highlight
  assert.deepEqual(buildHighlightSegments('Label', '   '), [{ text: 'Label', highlighted: false }]);
});

test('SUBSEQUENCE_MIN_QUERY guards single-letter fuzzy noise', () => {
  assert.equal(SUBSEQUENCE_MIN_QUERY, 2);
  const commands = [{ id: 'a', kind: 'action', label: 'Clear view filters', keywords: [] }];
  assert.deepEqual(filterCommands(commands, 'z'), []);
});
