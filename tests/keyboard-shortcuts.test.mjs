/**
 * Keyboard shortcut policy: "/" and Ctrl/Cmd+K focus the search input,
 * but never while the user is typing in an editable target. The helper
 * must stay pure (no chrome APIs, no DOM queries).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isEditableTarget, isSlashFocusShortcut, isSearchFocusShortcut, isSearchFocusEvent } from '../src/ui/services/keyboard.ts';

function event(patch = {}) {
  return { key: '', ctrlKey: false, metaKey: false, altKey: false, target: null, ...patch };
}
const bodyTarget = { tagName: 'BODY' };
const buttonTarget = { tagName: 'BUTTON' };
const inputTarget = { tagName: 'INPUT' };
const textareaTarget = { tagName: 'TEXTAREA', isContentEditable: false };
const contentEditable = { tagName: 'DIV', isContentEditable: true };

test('"/" focuses search only outside editable targets and without modifiers', () => {
  assert.equal(isSlashFocusShortcut(event({ key: '/', target: bodyTarget })), true);
  assert.equal(isSlashFocusShortcut(event({ key: '/', target: buttonTarget })), true);
  assert.equal(isSlashFocusShortcut(event({ key: '/', target: null })), true);
  assert.equal(isSlashFocusShortcut(event({ key: '/', target: inputTarget })), false, 'typing "/" inside an input must insert a slash, not steal focus');
  assert.equal(isSlashFocusShortcut(event({ key: '/', target: textareaTarget })), false);
  assert.equal(isSlashFocusShortcut(event({ key: '/', target: contentEditable })), false);
  assert.equal(isSlashFocusShortcut(event({ key: '/', target: bodyTarget, ctrlKey: true })), false);
  assert.equal(isSlashFocusShortcut(event({ key: '/', target: bodyTarget, metaKey: true })), false);
  assert.equal(isSlashFocusShortcut(event({ key: '/', target: bodyTarget, altKey: true })), false);
});

test('Ctrl/Cmd+K focuses search from non-editable targets, ignores Alt+K and editing', () => {
  assert.equal(isSearchFocusShortcut(event({ key: 'k', ctrlKey: true, target: bodyTarget })), true);
  assert.equal(isSearchFocusShortcut(event({ key: 'k', metaKey: true, target: buttonTarget })), true);
  assert.equal(isSearchFocusShortcut(event({ key: 'K', ctrlKey: true, target: bodyTarget })), true, 'Shift+Ctrl+K still counts');
  assert.equal(isSearchFocusShortcut(event({ key: 'k', ctrlKey: true, target: inputTarget })), false, 'browser-native editing shortcuts inside fields must win');
  assert.equal(isSearchFocusShortcut(event({ key: 'k', ctrlKey: true, target: contentEditable })), false);
  assert.equal(isSearchFocusShortcut(event({ key: 'k', altKey: true, target: bodyTarget })), false);
  assert.equal(isSearchFocusShortcut(event({ key: 'k', target: bodyTarget })), false, 'plain k does nothing');
});

test('isSearchFocusEvent is the union; other keys never match', () => {
  assert.equal(isSearchFocusEvent(event({ key: '/', target: bodyTarget })), true);
  assert.equal(isSearchFocusEvent(event({ key: 'k', ctrlKey: true, target: bodyTarget })), true);
  assert.equal(isSearchFocusEvent(event({ key: 'Escape', target: bodyTarget })), false);
  assert.equal(isSearchFocusEvent(event({ key: 'Enter', target: bodyTarget })), false);
  assert.equal(isSearchFocusEvent(event({ key: '?', target: bodyTarget })), false);
});

test('isEditableTarget covers inputs, textareas, selects, and contenteditable', () => {
  assert.equal(isEditableTarget(inputTarget), true);
  assert.equal(isEditableTarget(textareaTarget), true);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget(contentEditable), true);
  assert.equal(isEditableTarget(bodyTarget), false);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget(undefined), false);
});

test('keyboard helper is pure: no chrome namespace usage', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync('src/ui/services/keyboard.ts', 'utf8');
  assert.ok(!text.includes('chrome.'), 'keyboard.ts must not reference chrome APIs');
  assert.ok(!text.includes('document.'), 'keyboard.ts must stay DOM-query-free (policy only)');
  assert.ok(!text.includes('storage-repository'), 'keyboard.ts must not import storage');
});
