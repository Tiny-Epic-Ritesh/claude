/**
 * A <Tabs> tab is identified by `key`.
 *
 * This exists because the same mistake was made twice in one week, in
 * Templates and in GroupsSetup, and neither the build nor any server test can
 * see it. Tabs reads `t.key`; a caller that writes `id` instead produces a
 * component that renders perfectly and is completely inert:
 *
 *   key={t.key}                    -> undefined, so React keys collide
 *   active === t.key               -> never matches, so no tab reads as chosen
 *   onChange(t.key)                -> sets the parent's state to undefined
 *
 * The visible result is a filter that empties the list it is filtering and a
 * "New" button that builds the wrong kind of thing, both silently. `id` is the
 * more natural word and that is exactly why it keeps being written, so the
 * check is here rather than in a comment nobody reads.
 *
 * Deliberately narrow: it only looks at `tabs={[ ... ]}` literals, which are
 * unambiguous. A tabs array built in a variable is not examined -- catching
 * the literal covers every case that has actually occurred.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, '..', '..', 'client', 'src');

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nTabs');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.jsx')) out.push(full);
  }
  return out;
}

/** The text between `tabs={[` and the bracket that closes it. */
function tabsLiterals(src) {
  const found = [];
  for (const m of src.matchAll(/tabs=\{\[/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      if ('[{('.includes(src[i])) depth += 1;
      else if (']})'.includes(src[i])) depth -= 1;
    }
    found.push(src.slice(m.index, i));
  }
  return found;
}

const files = walk(CLIENT);

test('there are tabs arrays to check, so this test means something', () => {
  const total = files.reduce((n, f) => n + tabsLiterals(readFileSync(f, 'utf8')).length, 0);
  assert(total >= 5, `only found ${total} tabs={[...]} literals — the scan is probably broken`);
});

test('every tab is identified by key, not id', () => {
  const problems = [];

  for (const file of files) {
    for (const literal of tabsLiterals(readFileSync(file, 'utf8'))) {
      if (/\bid:/.test(literal)) {
        problems.push(`${relative(CLIENT, file).replace(/\\/g, '/')} gives its tabs an "id". `
          + 'Tabs reads `key` — with "id" the tab strip renders and does nothing.');
      }
    }
  }

  assert.equal(problems.length, 0, problems.join('\n         '));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
