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
  /** Extra search terms (both languages when available). */
  keywords?: string[];
  icon?: string;
  /** Optional payload (tab id, workspace id, action id). */
  value?: string;
  /** Optional keyboard hint shown as a kbd chip (e.g. "/" for focus search). */
  hint?: string;
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

function commandMatches(command: PaletteCommand, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const haystacks = [command.label, ...(command.keywords ?? [])].map(normalizeForMatch);
  return haystacks.some((term) => term.includes(normalizedQuery));
}

/** Filters commands by a user query (empty query returns everything). */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const normalizedQuery = normalizeForMatch(query);
  return commands.filter((command) => commandMatches(command, normalizedQuery));
}

/**
 * Groups a flat command list, preserving kind order and dropping empty groups.
 * When `recent.ids` resolves against the command list, a leading "recent"
 * group (in recency order, most recent first) is inserted and those commands
 * are removed from their kind groups to avoid duplication. Unknown ids and
 * duplicates are ignored, so stale/corrupt recent lists degrade gracefully.
 */
export function groupCommands(
  commands: PaletteCommand[],
  labels: Record<PaletteCommandKind, string>,
  recent?: { ids: string[]; label: string },
): PaletteGroup[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const seen = new Set<string>();
  const recentCommands: PaletteCommand[] = [];
  if (recent) {
    for (const id of recent.ids) {
      if (seen.has(id)) continue;
      const command = byId.get(id);
      if (!command) continue;
      seen.add(id);
      recentCommands.push(command);
    }
  }
  const rest = commands.filter((command) => !seen.has(command.id));
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
