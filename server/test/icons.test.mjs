/**
 * The icon font is subsetted, so the subset has to keep up with the UI.
 *
 * client/public/fonts/material-symbols-rounded.woff2 carries only the glyphs
 * listed in client/icon-subset.txt — 262 KB instead of the 5.2 MB full variable
 * font. The failure mode when a name is missing is quiet and ugly: Material
 * Symbols renders by ligature, so an absent glyph shows the raw name, and the
 * login page reads "candlestick_chart" where an icon should be.
 *
 * Nothing about that throws, logs, or fails a request, which is exactly why it
 * needs a test. Adding an icon to a screen and forgetting the subset should
 * break the build, not the screen.
 *
 * How a name is recognised: every lowercase snake_case string literal in the
 * source is checked against Google's published Material Symbols vocabulary
 * (client/material-symbols-names.txt, 4,275 names). Anything in both lists is
 * an icon the product can ask for. Matching on `<Icon name="…">` alone is not
 * enough — the first version of this test did that and missed the login page,
 * where the names sit in the third slot of a plain array.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const CLIENT = join(repo, 'client', 'src');
const SERVER = join(repo, 'server', 'src');
const SUBSET = join(repo, 'client', 'icon-subset.txt');
const VOCAB = join(repo, 'client', 'material-symbols-names.txt');
const FONT = join(repo, 'client', 'public', 'fonts', 'material-symbols-rounded.woff2');
const INDEX = join(repo, 'client', 'index.html');

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const lines = (file) => readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

/* ------------------------------------------------------------ gathering */

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (/\.(jsx?|mjs)$/.test(entry)) out.push(full);
  }
  return out;
};

/** Every icon name the product can actually ask for, and where it was found. */
function usedIcons(vocabulary) {
  const found = new Map();
  const rel = (f) => f.slice(repo.length + 1).replace(/\\/g, '/');

  // The client renders icons, so every string literal there is a candidate.
  // A false positive costs a few KB of glyph and nothing else.
  for (const file of walk(CLIENT)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(['"`])([a-z][a-z0-9_]{2,30})\1/g)) {
      const name = m[2];
      if (vocabulary.has(name) && !found.has(name)) found.set(name, rel(file));
    }
  }

  // The server names an icon exactly one way. Scanning its every literal
  // instead sweeps up ordinary domain words — "sip", "queue", "score" and
  // "south" are all real icon names, and none of them are icons here.
  for (const file of walk(SERVER)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bicon:\s*(['"`])([a-z][a-z0-9_]{2,30})\1/g)) {
      const name = m[2];
      if (vocabulary.has(name) && !found.has(name)) found.set(name, rel(file));
    }
  }
  return found;
}

/* --------------------------------------------------------------- tests */

console.log('\nIcon subset');

test('the font, its list and the vocabulary are all present', () => {
  for (const [what, path] of [['font', FONT], ['subset list', SUBSET], ['vocabulary', VOCAB]]) {
    assert(existsSync(path), `the ${what} is missing: ${path}`);
  }
  const kb = statSync(FONT).size / 1024;
  assert(kb > 20, `the font is only ${Math.round(kb)} KB — that is not a real font file`);
  // If this trips, someone has put the full variable font back and the first
  // page load just got five megabytes heavier.
  assert(kb < 1024, `the font is ${Math.round(kb)} KB — the subset has stopped being a subset`);
});

test('the font is served from our own box, not a CDN', () => {
  const html = readFileSync(INDEX, 'utf8');
  // Matches a live reference, not the comment above it explaining why there
  // is no live reference.
  assert(!/(?:href|src)=['"][^'"]*fonts\.(?:googleapis|gstatic)\.com/.test(html),
    'index.html still links a stylesheet or font from Google');
  assert(!/url\([^)]*fonts\.gstatic\.com/.test(html),
    'a CSS rule in index.html still fetches from Google');
  assert(html.includes('fonts/material-symbols-rounded.woff2'),
    'index.html does not reference the local font');
});

test('the bundled font is the variable one the UI asks for', () => {
  // Icon renders with font-variation-settings for FILL and wght. A static
  // per-weight font would load, look almost right, and ignore both.
  const html = readFileSync(INDEX, 'utf8');
  assert(/font-weight:\s*100\s+700/.test(html),
    'the @font-face does not declare a variable weight range');
  assert(/format\(['"]woff2['"]\)/.test(html), 'the font is not served as woff2');
});

test('every icon the UI can ask for is in the subset', () => {
  const vocabulary = new Set(lines(VOCAB));
  assert(vocabulary.size > 3000, `the vocabulary holds only ${vocabulary.size} names — it looks truncated`);

  const subset = new Set(lines(SUBSET));
  assert(subset.size > 100, `the subset list holds only ${subset.size} names — it looks truncated`);

  const used = usedIcons(vocabulary);
  assert(used.size > 100, `only found ${used.size} icon names in the source — the scan is broken`);

  const missing = [...used].filter(([name]) => !subset.has(name));
  assert.equal(
    missing.length, 0,
    'these icons would render as raw text:\n'
      + missing.map(([name, where]) => `         ${name}  (${where})`).join('\n')
      + '\n       Add them to client/icon-subset.txt and regenerate the font'
      + ' (instructions are at the top of that file).',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
