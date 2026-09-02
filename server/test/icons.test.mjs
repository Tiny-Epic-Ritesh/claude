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
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const CLIENT = join(repo, 'client', 'src');
const SERVER = join(repo, 'server', 'src');
const SUBSET = join(repo, 'client', 'icon-subset.txt');
const VOCAB = join(repo, 'client', 'material-symbols-names.txt');
const FONT = join(repo, 'client', 'src', 'assets', 'fonts', 'material-symbols-rounded.woff2');
const INDEX = join(repo, 'client', 'index.html');
const CSS = join(repo, 'client', 'src', 'styles.css');
const LOCK = join(repo, 'client', 'icon-subset.lock');

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

  /* The client renders icons two ways and this scan has to cover both.
   *
   *   <Icon name="add" />                                a string literal
   *   <span className="material-symbols-rounded">add</span>   JSX children
   *
   * Only the first was scanned, for as long as this test existed. The second is
   * how ObjectManager, the record headers and the login page draw every one of
   * their icons, so the check passed while `arrow_upward` rendered as the word
   * ARROW_UPWARD on screen — the exact failure this file was written to catch.
   *
   * Comments are stripped first. The literal pattern treats a backtick as a
   * quote, so a word in prose — `draft`, in a JSDoc block — was being reported
   * as a missing icon. A false positive here is not free: it sends someone to
   * add a glyph that nothing renders. */
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    /* Search keywords are prose, not icon names, and the two vocabularies
       overlap heavily — "workflow", "history", "storage", "privacy" and
       "schema" are all real Material Symbols, and none of them is an icon in
       the Setup registry. This is the same hazard the server scan further down
       is already narrowed for, arriving on the client through a data file.
       Blanking the array beats adding sixteen glyphs nothing renders. */
    .replace(/keywords:\s*\[[^\]]*\]/g, ' ')
    /* `key:` and `group:` are structural identifiers — a section's slug and the
       group it sits in. "automation" is both a Setup group and a real Material
       Symbol, and it is not an icon here. An icon is always declared as `icon:`
       or passed as `name=`, so nothing real is hidden by ignoring these two. */
    .replace(/\b(?:key|group):\s*(['"`])[a-z0-9_]+\1/g, ' ')
    /* A className is never an icon reference. Icons arrive three ways and none
       of them is a class attribute: `<Icon name="x">`, `icon: 'x'`, or as the
       text child of a material-symbols span — which is matched separately below
       and deliberately still scanned. Class names overlap the icon vocabulary
       constantly ("skeleton", "search", "input", "menu"), and every one of
       those is a false positive sending somebody to add a glyph nothing
       renders. */
    .replace(/className=(['"`])[^'"`]*\1/g, ' ')
    /* A key passed to .set/.get/.append/.setItem is a parameter name, not an
       icon. `query.set('sort', sort)` sent somebody off to add a `sort` glyph
       that nothing renders — the same false positive as the two strips above,
       arriving from a third direction. Only the quoted first argument is
       blanked, so an icon name sitting in a later one is still scanned. */
    .replace(/\.(?:set|get|append|setItem|getItem|has|delete)\((['"`])[a-z][a-z0-9_]*\1/g, '.x(0');

  for (const file of walk(CLIENT)) {
    const src = strip(readFileSync(file, 'utf8'));
    const add = (name) => {
      if (vocabulary.has(name) && !found.has(name)) found.set(name, rel(file));
    };
    // A string literal — <Icon name="add" />, and the array-slot cases.
    for (const m of src.matchAll(/(['"`])([a-z][a-z0-9_]{2,30})\1/g)) add(m[2]);
    // JSX children of a Material Symbols span.
    for (const m of src.matchAll(/material-symbols-rounded[^>]*>\s*([a-z][a-z0-9_]{2,30})\s*</g)) add(m[1]);
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
  for (const [what, file] of [['index.html', INDEX], ['styles.css', CSS]]) {
    const src = readFileSync(file, 'utf8');
    // Matches a live reference, not a comment explaining why there is none.
    assert(!/(?:href|src)=['"][^'"]*fonts\.(?:googleapis|gstatic)\.com/.test(src),
      `${what} still links a stylesheet or font from Google`);
    assert(!/url\([^)]*fonts\.gstatic\.com/.test(src),
      `${what} still fetches a font from Google`);
  }
});

test('the font is declared in CSS, so the build fingerprints it', () => {
  /*
   * The bug this exists to prevent, which cost half a day:
   *
   * The @font-face lived inline in index.html pointing at a fixed path under
   * public/. Vite copies public/ verbatim, so the filename never changed --
   * and index.js serves it with `immutable, max-age=31536000`. Regenerating
   * the subset therefore reached nobody who had already loaded the app, and
   * would not have for a year. Fifty-two icons rendered as their own names in
   * words while the file on disk was perfectly correct.
   *
   * Declared in styles.css the url() goes through the build, which emits
   * material-symbols-rounded-<hash>.woff2. New font, new URL, no stale cache.
   */
  const css = readFileSync(CSS, 'utf8');
  const html = readFileSync(INDEX, 'utf8');

  assert(/@font-face/.test(css), 'styles.css does not declare the icon font');
  assert(/url\(['"]?\.\/assets\/fonts\/material-symbols-rounded\.woff2/.test(css),
    'the @font-face does not point at the font through a build-processed relative url()');

  assert(!/@font-face/.test(html),
    'index.html declares a font face again — an inline url() is not fingerprinted');
  assert(!/fonts\/material-symbols-rounded\.woff2/.test(html),
    'index.html references the font on a fixed path; served immutable, that path can never be busted');

  // Icon renders with font-variation-settings for FILL and wght. A static
  // per-weight font would load, look almost right, and ignore both.
  assert(/font-weight:\s*100\s+700/.test(css),
    'the @font-face does not declare a variable weight range');
  assert(/format\(['"]woff2['"]\)/.test(css), 'the font is not declared as woff2');
});

test('the font was generated from the list that is checked in', () => {
  /*
   * The lock records the exact names the bundled font was built from. Without
   * it, "the name is in icon-subset.txt" proves only that somebody typed it --
   * not that the font in the repo contains the glyph. Adding a name and
   * forgetting to regenerate produces an icon that renders as its own name,
   * and nothing else notices.
   */
  const list = lines(SUBSET).sort();
  const lock = lines(LOCK).sort();

  const added = list.filter((n) => !lock.includes(n));
  const removed = lock.filter((n) => !list.includes(n));

  assert.equal(
    added.length + removed.length, 0,
    'icon-subset.txt no longer matches the font that was generated from it.\n'
      + (added.length ? `         added, not yet in the font: ${added.join(', ')}\n` : '')
      + (removed.length ? `         removed, still in the font: ${removed.join(', ')}\n` : '')
      + '       Regenerate the font (instructions at the top of icon-subset.txt),'
      + ' then copy the list to icon-subset.lock.',
  );

  /* And the font on disk is the one the lock describes. A hash rather than a
   * timestamp: mtime is whatever the last checkout or file move happened to
   * set, so a timestamp check fails for reasons that have nothing to do with
   * the font and teaches people to ignore it. */
  const declared = readFileSync(LOCK, 'utf8').match(/# font-sha256 ([0-9a-f]{64})/)?.[1];
  assert(declared, 'the lock does not record the font hash');
  const actual = createHash('sha256').update(readFileSync(FONT)).digest('hex');
  assert.equal(actual, declared,
    'the bundled font is not the one this list generated — regenerate it, or update the lock');
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
