/**
 * Keyboard shortcut policy for the side panel (pure, no chrome APIs).
 *
 * Shortcuts:
 * - `/` focuses the visible view's search input.
 * - Ctrl/Cmd+K opens the command palette from anywhere — INCLUDING while
 *   typing in a search field ("the palette lives above the search field").
 * - Escape inside the search input clears the query text (component side).
 *
 * The helpers never let `/` fire while the user is typing in an editable
 * target: pressing `/` inside a text field must insert a slash, not move focus.
 */

export type ShortcutEventLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
};

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true;
}

/** `/` — plain key press outside editable targets (no modifier interference). */
export function isSlashFocusShortcut(event: ShortcutEventLike): boolean {
  if (event.key !== '/') return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return !isEditableTarget(event.target);
}

/** Ctrl+K / Cmd+K — palette shortcut, allowed from ANY target (even editable). */
export function isPaletteShortcut(event: ShortcutEventLike): boolean {
  if (event.key !== 'k' && event.key !== 'K') return false;
  if (event.altKey) return false;
  return event.ctrlKey || event.metaKey;
}

/** Ctrl+K / Cmd+K — allowed from non-editable targets. */
export function isSearchFocusShortcut(event: ShortcutEventLike): boolean {
  if (event.key !== 'k' && event.key !== 'K') return false;
  if (event.altKey) return false;
  const primary = event.ctrlKey || event.metaKey;
  return primary && !isEditableTarget(event.target);
}

export function isSearchFocusEvent(event: ShortcutEventLike): boolean {
  return isSlashFocusShortcut(event) || isSearchFocusShortcut(event);
}
