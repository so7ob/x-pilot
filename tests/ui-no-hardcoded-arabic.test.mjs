import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Arabic / Arabic-Extended / Arabic Presentation Forms ranges.
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function walk(dir, exts, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, output);
    else if (exts.some((ext) => entry.name.endsWith(ext))) output.push(full);
    // ignore
  }
  return output;
}

test('Side Panel view layer contains no hardcoded Arabic text (i18n only)', () => {
  const uiDir = path.join(root, 'src/ui');
  const files = walk(uiDir, ['.ts', '.tsx', '.css']);
  assert.ok(files.length > 0, 'expected UI files to scan');
  const offenders = [];
  const exempted = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!ARABIC.test(line)) return;
      const rel = `${path.relative(root, file)}:${index + 1}`;
      // Explicit escape hatch: lines carrying the i18n-exempt marker are internal-code
      // bridges (they MATCH raw background codes but only ever render t() output).
      if (line.includes('i18n-exempt')) exempted.push(rel);
      else offenders.push(rel);
    });
  }
  assert.deepEqual(offenders, [], `Hardcoded Arabic found in UI layer (use src/i18n dictionaries instead): ${offenders.join(', ')}`);
  // Guard against marker abuse: the bridge surface must stay tiny and deliberate.
  assert.ok(exempted.length <= 10, `Too many i18n-exempt lines (${exempted.length}) — the internal-code bridge surface must stay minimal: ${exempted.join(', ')}`);
});

test('English dictionary is free of Arabic characters', () => {
  const english = fs.readFileSync(path.join(root, 'src/i18n/en.ts'), 'utf8');
  const lines = english.split('\n');
  const offenders = [];
  lines.forEach((line, index) => {
    if (ARABIC.test(line)) offenders.push(`src/i18n/en.ts:${index + 1}`);
  });
  assert.deepEqual(offenders, [], `Arabic characters must not appear in the English dictionary: ${offenders.join(', ')}`);
});
