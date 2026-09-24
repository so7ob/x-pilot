/**
 * Command palette model for the side panel (pure, no chrome APIs, no DOM, no storage).
 *
 * The palette is a keyboard-first launcher on top of the v1.8.0 shortcuts:
 * - jump to any tab,
 * - switch the active workspace,
 * - run common SAFE actions (focus search, clear filters, refresh data,
 *   export backup, analytics CSV). Publishing actions are intentionally
 *   never part of the palette.
 *
 * All matching is Arabic-aware: alef/hamza forms collapse, teh marbuta and
 * alef maqsura fold, diacritics and tatweel are stripped, and Latin text is
 * matched case-insensitively.
 */

export type PaletteCommandKind = 'tab' | 'workspace' | 'action';

export type PaletteCommand = {
  id: string;
  kind: PaletteCommandKind;
  /** Already-localized display label. */
  label: string;
  /** Optional secondary line shown under the label (recents context). */
  detail?: string;
  /** Optional search terms (both languages when available). */
  keywords?: string[];
  icon?: string;
  /** Optional payload (tab id, workspace id, action id). */
  value?: string;
  /** Optional keyboard hint shown as a kbd chip (e.g. "/" for focus search). */
  hint?: string;
  /** Disabled rows stay visible (honest state) but cannot run. */
  disabled?: boolean;
};

export type PaletteGroupKind = PaletteCommandKind | 'recent';

export type PaletteGroup = {
  kind: PaletteGroupKind;
  label: string;
  commands: PaletteCommand[];
};

/** Cap for the recent-commands list shown when the palette opens empty. */
export const MAX_RECENT_COMMANDS = 5;

/** Characters removed entirely before matching (harakat + tatweel). */
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/** Normalizes a term for matching: Arabic folding + Latin lowercase. */
export function normalizeForMatch(term: string): string {
  return term
    .toLowerCase()
    .replace(ARABIC_MARKS, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627') // alef variants -> plain alef
    .replace(/\u0629/g, '\u0647') // teh marbuta -> heh
    .replace(/\u0649/g, '\u064A') // alef maqsura -> yeh
    .trim();
}

/**
 * Normalizes a term for matching while remembering where every normalized
 * character came from in the ORIGINAL string, so match positions can be
 * highlighted without re-running lossy string surgery on the label.
 * 1:1 folds (alef variants, teh marbuta, alef maqsura, Latin lowercase)
 * keep one map entry per output char; marks/tatweel are dropped entirely.
 */
export function normalizeWithIndexMap(term: string): { normalized: string; map: number[] } {
  const lowered = term.toLowerCase();
  let normalized = '';
  const map: number[] = [];
  for (let i = 0; i < lowered.length; i++) {
    const ch = lowered[i];
    // Per-char membership check — a /g regex would carry stateful lastIndex.
    const isMark = ch >= '\u064B' && ch <= '\u065F' || ch === '\u0670' || (ch >= '\u06D6' && ch <= '\u06ED') || ch === '\u0640';
    if (isMark) continue;
    let folded = ch;
    if (ch === '\u0623' || ch === '\u0625' || ch === '\u0622' || ch === '\u0671') folded = '\u0627';
    else if (ch === '\u0629') folded = '\u0647';
    else if (ch === '\u0649') folded = '\u064A';
    normalized += folded;
    map.push(i);
  }
  // Trim leading/trailing whitespace from the OUTPUT, remapping accordingly.
  const start = normalized.search(/\S/);
  if (start === -1) return { normalized: '', map: [] };
  let end = normalized.length;
  while (end > start && /\s/.test(normalized[end - 1])) end--;
  return { normalized: normalized.slice(start, end), map: map.slice(start, end) };
}

export type MatchRanges = Array<[number, number]>;

export type CommandMatch = {
  matched: boolean;
  /** Higher is better; 0 for the empty query (everything matches equally). */
  score: number;
  /** Highlight ranges in ORIGINAL label coordinates (empty for keyword matches). */
  ranges: MatchRanges;
};

export const SCORE_EXACT = 1000;
export const SCORE_PREFIX = 900;
export const SCORE_WORD_START = 800;
export const SCORE_LABEL_INCLUDES = 700;
export const SCORE_KEYWORD_EXACT = 600;
export const SCORE_KEYWORD_PREFIX = 550;
export const SCORE_KEYWORD_INCLUDES = 500;
export const SCORE_SUBSEQUENCE_BASE = 300;
/** Minimum query length for loose subsequence matching (1-char queries stay exact). */
export const SUBSEQUENCE_MIN_QUERY = 2;
/** Bonus per extra consecutive matched char beyond the first. */
export const SUBSEQUENCE_CONSECUTIVE_BONUS = 15;
/** Penalty per skipped label char while walking the subsequence. */
export const SUBSEQUENCE_GAP_PENALTY = 2;
/** Floor for the subsequence score so gaps cannot sink below keyword matches. */
export const SCORE_SUBSEQUENCE_FLOOR = 150;

/** Characters that start a "word" for word-start matching. */
const WORD_SEPARATORS = /[\s\-_:\u00b7|\u060c,]/;

function mergeConsecutive(positions: number[]): MatchRanges {
  const ranges: MatchRanges = [];
  for (const position of positions) {
    const last = ranges[ranges.length - 1];
    if (last && position === last[1]) last[1] = position + 1;
    else ranges.push([position, position + 1]);
  }
  return ranges;
}

/** Greedy in-order subsequence: returns normalized positions or null. */
function subsequencePositions(normalizedLabel: string, query: string): number[] | null {
  const positions: number[] = [];
  let cursor = 0;
  for (const ch of query) {
    const found = normalizedLabel.indexOf(ch, cursor);
    if (found === -1) return null;
    positions.push(found);
    cursor = found + 1;
  }
  return positions;
}

/**
 * Label-only matching ladder: exact > prefix > word-start > includes >
 * subsequence. Ranges are reported in ORIGINAL label coordinates through
 * the index map. This is the single source of truth shared by command
 * ranking and UI highlighting.
 */
export function matchLabel(label: string, normalizedQuery: string): { matched: boolean; score: number; ranges: MatchRanges } {
  if (!normalizedQuery) return { matched: true, score: 0, ranges: [] };
  const { normalized, map } = normalizeWithIndexMap(label);
  const queryLength = [...normalizedQuery].length;
  const toOriginal = (position: number): number => map[position] ?? position;
  const mapRanges = (positions: number[]): MatchRanges => mergeConsecutive(positions.map(toOriginal));

  if (normalized === normalizedQuery) return { matched: true, score: SCORE_EXACT, ranges: mapRanges(normalized.split('').map((_, i) => i)) };

  if (normalized.startsWith(normalizedQuery)) {
    const positions = [...normalizedQuery].map((_, i) => i);
    return { matched: true, score: SCORE_PREFIX + Math.min(queryLength, 10), ranges: mapRanges(positions) };
  }

  const wordStart = [...normalized].findIndex((_, i) => i > 0 && WORD_SEPARATORS.test(normalized[i - 1]) && normalized.startsWith(normalizedQuery, i));
  if (wordStart > 0) {
    const positions = Array.from({ length: queryLength }, (_, i) => wordStart + i);
    return { matched: true, score: SCORE_WORD_START + Math.min(queryLength, 10), ranges: mapRanges(positions) };
  }

  const includesAt = normalized.indexOf(normalizedQuery);
  if (includesAt !== -1) {
    const positions = Array.from({ length: queryLength }, (_, i) => includesAt + i);
    return { matched: true, score: SCORE_LABEL_INCLUDES - Math.min(includesAt, 100), ranges: mapRanges(positions) };
  }

  if (queryLength >= SUBSEQUENCE_MIN_QUERY) {
    const positions = subsequencePositions(normalized, normalizedQuery);
    if (positions) {
      let consecutiveBonus = 0;
      let gapPenalty = 0;
      for (let i = 1; i < positions.length; i++) {
        if (positions[i] === positions[i - 1] + 1) consecutiveBonus += SUBSEQUENCE_CONSECUTIVE_BONUS;
        else gapPenalty += (positions[i] - positions[i - 1] - 1) * SUBSEQUENCE_GAP_PENALTY;
      }
      const score = Math.max(SCORE_SUBSEQUENCE_FLOOR, SCORE_SUBSEQUENCE_BASE + consecutiveBonus - gapPenalty);
      return { matched: true, score, ranges: mapRanges(positions) };
    }
  }

  return { matched: false, score: 0, ranges: [] };
}

/** Scores one command against the query (keyword matches carry no label ranges). */
export function matchCommand(command: PaletteCommand, query: string): CommandMatch {
  const rawQuery = query.trim();
  const normalizedQuery = normalizeForMatch(rawQuery);
  if (!normalizedQuery) return { matched: true, score: 0, ranges: [] };
  const labelMatch = matchLabel(command.label, normalizedQuery);
  if (labelMatch.matched) return labelMatch;
  // Keywords: exact > prefix > includes. No ranges — the label did not match,
  // so highlighting it would be dishonest.
  for (const keyword of command.keywords ?? []) {
    const normalizedKeyword = normalizeForMatch(keyword);
    if (!normalizedKeyword) continue;
    if (normalizedKeyword === normalizedQuery) return { matched: true, score: SCORE_KEYWORD_EXACT, ranges: [] };
    if (normalizedKeyword.startsWith(normalizedQuery)) return { matched: true, score: SCORE_KEYWORD_PREFIX, ranges: [] };
    if (normalizedKeyword.includes(normalizedQuery)) return { matched: true, score: SCORE_KEYWORD_INCLUDES, ranges: [] };
  }
  return { matched: false, score: 0, ranges: [] };
}

/**
 * Filters commands by a user query and RANKS the survivors best-first
 * (stable sort keeps the builder order for equal scores). Empty query
 * returns everything in the original order.
 */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const scored = commands
    .map((command) => ({ command, match: matchCommand(command, query) }))
    .filter((entry) => entry.match.matched);
  scored.sort((a, b) => b.match.score - a.match.score);
  return scored.map((entry) => entry.command);
}

export type HighlightSegment = { text: string; highlighted: boolean };

/** Splits a label into non-overlapping render segments for the UI. */
export function buildHighlightSegments(label: string, query: string): HighlightSegment[] {
  const rawQuery = query.trim();
  if (!rawQuery) return [{ text: label, highlighted: false }];
  const normalizedQuery = normalizeForMatch(rawQuery);
  if (!normalizedQuery) return [{ text: label, highlighted: false }];
  const { ranges } = matchLabel(label, normalizedQuery);
  if (!ranges.length) return [{ text: label, highlighted: false }];
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) segments.push({ text: label.slice(cursor, start), highlighted: false });
    segments.push({ text: label.slice(start, end), highlighted: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < label.length) segments.push({ text: label.slice(cursor), highlighted: false });
  return segments.filter((segment) => segment.text.length > 0);
}

/**
 * Groups a flat command list, preserving kind order and dropping empty groups.
 * When `recent` is supplied (already resolved by `buildRecentCommands`, in
 * recency order), a leading "recent" group is inserted and those command ids
 * are removed from their kind groups to avoid duplication. Duplicates inside
 * the recent list are dropped defensively; an empty list yields no group.
 */
export function groupCommands(
  commands: PaletteCommand[],
  labels: Record<PaletteCommandKind, string>,
  recent?: { commands: PaletteCommand[]; label: string },
): PaletteGroup[] {
  const recentIds = new Set<string>();
  const recentCommands: PaletteCommand[] = [];
  if (recent) {
    for (const command of recent.commands) {
      if (!command || recentIds.has(command.id)) continue;
      recentIds.add(command.id);
      recentCommands.push(command);
    }
  }
  const rest = commands.filter((command) => !recentIds.has(command.id));
  const order: PaletteCommandKind[] = ['tab', 'action', 'workspace'];
  const groups: PaletteGroup[] = [];
  if (recent && recentCommands.length > 0) {
    groups.push({ kind: 'recent', label: recent.label, commands: recentCommands });
  }
  for (const kind of order) {
    const kindCommands = rest.filter((command) => command.kind === kind);
    if (kindCommands.length > 0) groups.push({ kind, label: labels[kind], commands: kindCommands });
  }
  return groups;
}

/**
 * Records a command execution in the recent list: most-recent first, no
 * duplicates, capped at MAX_RECENT_COMMANDS. Pure — persistence is the
 * host's job (recent-commands service).
 */
export function recordRecentCommand(recent: string[], id: string): string[] {
  const next = [id, ...recent.filter((existing) => existing !== id)];
  return next.slice(0, MAX_RECENT_COMMANDS);
}

/** Drops non-string/empty ids, deduplicates and caps a stored recent list. */
export function sanitizeRecentCommandIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    seen.add(entry);
  }
  return [...seen].slice(0, MAX_RECENT_COMMANDS);
}

/** Live state of one workspace, used to resolve recents entries honestly. */
export type WorkspaceDirectoryEntry = { name: string; archived: boolean; active: boolean };

export type RecentLabels = {
  /** Detail line for resolvable workspace-switch entries (e.g. "Switch workspace"). */
  switch?: string;
  /** Detail line for the now-active workspace (e.g. "Current workspace"). */
  current?: string;
  /** Detail line for an archived workspace (e.g. "Archived"). */
  archived?: string;
};

export type BuildRecentCommandsInput = {
  ids: string[];
  /** Live command list (the same list the palette renders). */
  commands: PaletteCommand[];
  /** Current name/state of every known workspace, keyed by workspace id. */
  workspaceDirectory: Record<string, WorkspaceDirectoryEntry>;
  labels?: RecentLabels;
};

export type RecentCommandsResult = {
  /** Recents group entries in recency order (stale entries skipped). */
  commands: PaletteCommand[];
  /** `workspace:<id>` ids whose workspace no longer exists — safe to prune. */
  staleWorkspaceIds: string[];
};

/**
 * Resolves raw recent-command ids against the live command list AND the
 * workspace directory, so recents entries stay honest as state changes.
 * Workspace ids ALWAYS resolve name/state from the directory (the live
 * command list is only a shape fallback):
 * - inactive workspace: live name + "switch" detail, runnable;
 * - now-active workspace: live name + "current" detail (running it is an
 *   idempotent re-select);
 * - archived workspace: live name + "archived" detail, disabled (the backend
 *   refuses activating archived workspaces);
 * - deleted workspace (or a directory entry without a name): dropped, id
 *   reported as stale for pruning.
 * Non-workspace ids that do not resolve right now (context-dependent action
 * availability) are hidden but NOT reported stale — they may come back.
 */
export function buildRecentCommands(input: BuildRecentCommandsInput): RecentCommandsResult {
  const byId = new Map(input.commands.map((command) => [command.id, command]));
  const commands: PaletteCommand[] = [];
  const staleWorkspaceIds: string[] = [];
  const seen = new Set<string>();
  for (const id of input.ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    if (id.startsWith('workspace:')) {
      const workspaceId = id.slice('workspace:'.length);
      const entry = input.workspaceDirectory[workspaceId];
      if (!entry || !entry.name) {
        staleWorkspaceIds.push(id);
        continue;
      }
      commands.push({
        ...(byId.get(id) ?? { id, kind: 'workspace' as const, icon: 'workspace', value: workspaceId }),
        label: entry.name,
        detail: entry.archived ? input.labels?.archived : entry.active ? input.labels?.current : input.labels?.switch,
        disabled: entry.archived || undefined,
      });
      continue;
    }
    const live = byId.get(id);
    if (live) commands.push(live);
    // tab:/action: ids that miss are context-dependent — hide silently.
  }
  return { commands, staleWorkspaceIds };
}

export type PaletteTabEntry = { id: string; label: string; icon?: string };

export type PaletteWorkspaceEntry = { id: string; name: string; active: boolean };

/** Actions the host may expose; each maps to an execution callback in the UI layer. */
export type PaletteActionId = 'focus-search' | 'clear-filters' | 'refresh-data' | 'export-backup' | 'export-analytics-csv' | 'new-workspace';

export type PaletteActionEntry = {
  id: PaletteActionId;
  label: string;
  keywords?: string[];
  icon?: string;
  hint?: string;
  disabled?: boolean;
};

export type BuildPaletteCommandsOptions = {
  tabs: PaletteTabEntry[];
  workspaces?: PaletteWorkspaceEntry[];
  actions?: PaletteActionEntry[];
  /** Active workspace is hidden from the switch list (already active). */
  activeWorkspaceId?: string;
  /**
   * Extra search aliases keyed by command id prefix: `tab:<id>`,
   * `action:<actionId>`, or the `workspace` wildcard for every workspace
   * command. Usually sourced from the i18n dictionaries by the host.
   */
  aliases?: Record<string, string[]>;
};

/**
 * Built-in LATIN search aliases. Locale aliases (Arabic etc.) are supplied by
 * the host from the i18n dictionaries via `aliases` — this module must stay
 * free of hardcoded Arabic (UI-layer i18n contract).
 */
const TAB_KEYWORDS: Record<string, string[]> = {
  operation: ['dashboard', 'publish', 'run'],
  tests: ['preflight', 'dry run', 'check'],
  queue: ['bank', 'links'],
  sessions: ['history', 'runs'],
  analytics: ['stats', 'csv', 'export'],
  diagnostics: ['checks', 'health'],
  workspaces: ['switch', 'projects'],
  settings: ['options', 'preferences'],
};

const ACTION_KEYWORDS: Record<PaletteActionId, string[]> = {
  'focus-search': ['find', 'search'],
  'clear-filters': ['reset search', 'show all'],
  'refresh-data': ['reload', 'sync'],
  'export-backup': ['download backup', 'json'],
  'export-analytics-csv': ['download csv', 'excel'],
  'new-workspace': ['create workspace', 'add workspace'],
};

/** Builds the flat command list (tabs + actions + workspace switches). */
export function buildPaletteCommands(options: BuildPaletteCommandsOptions): PaletteCommand[] {
  const tabCommands: PaletteCommand[] = options.tabs.map((tab) => ({
    id: `tab:${tab.id}`,
    kind: 'tab',
    label: tab.label,
    icon: tab.icon,
    value: tab.id,
    keywords: [...(options.aliases?.[`tab:${tab.id}`] ?? []), ...(TAB_KEYWORDS[tab.id] ?? [])],
  }));

  const actionCommands: PaletteCommand[] = (options.actions ?? [])
    .filter((action) => !action.disabled)
    .map((action) => ({
      id: `action:${action.id}`,
      kind: 'action',
      label: action.label,
      icon: action.icon,
      value: action.id,
      keywords: [...(options.aliases?.[`action:${action.id}`] ?? []), ...(ACTION_KEYWORDS[action.id] ?? []), ...(action.keywords ?? [])],
      hint: action.hint,
    }));

  const workspaceCommands: PaletteCommand[] = (options.workspaces ?? [])
    .filter((workspace) => !workspace.active && workspace.id !== options.activeWorkspaceId)
    .map((workspace) => ({
      id: `workspace:${workspace.id}`,
      kind: 'workspace',
      label: workspace.name,
      icon: 'workspace',
      value: workspace.id,
      keywords: [...(options.aliases?.['workspace'] ?? []), 'switch', 'workspace'],
    }));

  return [...tabCommands, ...actionCommands, ...workspaceCommands];
}
