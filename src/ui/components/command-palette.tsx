import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '../components';
import { buildHighlightSegments, filterCommands, groupCommands, type PaletteCommand, type PaletteGroup, type PaletteCommandKind } from '../services/command-palette';

export type CommandPaletteProps = {
  open: boolean;
  commands: PaletteCommand[];
  groupLabels: Record<PaletteCommandKind, string>;
  placeholder: string;
  emptyLabel: string;
  footerHints: { navigate: string; run: string; close: string };
  /** Shown as the leading group while the query is empty (pre-resolved by buildRecentCommands). */
  recent?: { commands: PaletteCommand[]; label: string };
  onRun: (command: PaletteCommand) => void;
  onClose: () => void;
};

const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Home', 'End']);

/** Modal command palette: type-to-filter launcher with full keyboard control. */
export function CommandPalette({ open, commands, groupLabels, placeholder, emptyLabel, footerHints, recent, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const groups = useMemo(
    () => groupCommands(filtered, groupLabels, query.trim() ? undefined : recent),
    [filtered, groupLabels, query, recent],
  );
  // Flat list in visual order (group after group) for index-based navigation.
  const flat = useMemo(() => groups.flatMap((group) => group.commands), [groups]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Focus after mount so the input selects cleanly on reopen.
      window.setTimeout(() => {
        const input = inputRef.current;
        if (input) {
          input.focus();
          input.select();
        }
      }, 0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector('[data-active="true"]');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, flat.length, open]);

  if (!open) return null;

  const moveActive = (delta: number) => {
    if (!flat.length) return;
    setActiveIndex((current) => (current + delta + flat.length) % flat.length);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Tab') {
      // Single-focusable dialog: keep focus on the palette input.
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      if (flat.length) setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      if (flat.length) setActiveIndex(flat.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const command = flat[activeIndex];
      if (command && !command.disabled) onRun(command);
    }
  };

  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label={placeholder} onKeyDown={onKeyDown}>
        <div className="command-palette-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="command-palette-list"
            aria-activedescendant={flat.length ? `command-palette-option-${activeIndex}` : undefined}
            aria-autocomplete="list"
            value={query}
            placeholder={placeholder}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="command-palette-esc" onClick={onClose} aria-label={footerHints.close}>esc</button>
        </div>
        <ul className="command-palette-list" id="command-palette-list" role="listbox" ref={listRef}>
          {groups.map((group) => <PaletteGroupView key={group.kind} group={group} activeIndex={activeIndex} setActiveIndex={setActiveIndex} onRun={onRun} flat={flat} query={query} />)}
          {!flat.length && <li className="command-palette-empty" role="option" aria-selected={false} aria-disabled="true">{emptyLabel}</li>}
        </ul>
        <footer className="command-palette-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> {footerHints.navigate}</span>
          <span><kbd>↵</kbd> {footerHints.run}</span>
          <span><kbd>esc</kbd> {footerHints.close}</span>
        </footer>
      </section>
    </div>
  );
}

type GroupViewProps = {
  group: PaletteGroup;
  activeIndex: number;
  flat: PaletteCommand[];
  setActiveIndex: (index: number) => void;
  onRun: (command: PaletteCommand) => void;
  /** Non-empty query turns matching label substrings into highlight segments. */
  query: string;
};

function PaletteGroupView({ group, activeIndex, flat, setActiveIndex, onRun, query }: GroupViewProps) {
  return (
    <>
      <li className={`command-palette-group-label${group.kind === 'recent' ? ' command-palette-group-recent' : ''}`} role="presentation">{group.kind === 'recent' && <Icon name="clock" size={11} />}{group.label}</li>
      {group.commands.map((command) => {
        const index = flat.indexOf(command);
        const active = index === activeIndex;
        return (
          <li
            key={command.id}
            id={`command-palette-option-${index}`}
            role="option"
            aria-selected={active}
            aria-disabled={command.disabled || undefined}
            className={`command-palette-item${command.disabled ? ' command-palette-item-disabled' : ''}`}
            data-active={active || undefined}
            onMouseEnter={() => setActiveIndex(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => !command.disabled && onRun(command)}
          >
            <span className="command-palette-item-icon" aria-hidden="true">{command.icon ? <Icon name={command.icon as IconName} size={15} /> : null}</span>
            <span className="command-palette-item-text">
              <span className="command-palette-item-label" dir="auto">
                {buildHighlightSegments(command.label, query).map((segment, segmentIndex) => segment.highlighted
                  ? <mark key={segmentIndex} className="command-palette-item-hl">{segment.text}</mark>
                  : <span key={segmentIndex}>{segment.text}</span>)}
              </span>
              {command.detail && <span className="command-palette-item-detail" dir="auto">{command.detail}</span>}
            </span>
            {command.hint && <kbd className="command-palette-item-hint">{command.hint}</kbd>}
          </li>
        );
      })}
    </>
  );
}
