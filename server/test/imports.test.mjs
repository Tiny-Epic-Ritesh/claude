/**
 * A helper used in a file must be imported into that file.
 *
 * This catches one specific mistake, and it is worth its own test because it
 * has been made repeatedly and it always fails the same way: a route calls
 * `activeOrg(req)` or `notify(...)` or `sendCsv(...)`, the module loads
 * perfectly, every other route in the file works, and the one path that touches
 * the missing name throws a ReferenceError the first time somebody uses it.
 *
 * Nothing else notices. `node --check` sees valid syntax. The import of the
 * module succeeds, because a bare identifier is only resolved when the line
 * runs. A test that exercises the route finds it; a test that does not, does
 * not — which means the failure lands on whoever clicks the button first.
 *
 * There is no linter in this project, and adding one to catch a single class of
 * mistake would be a large dependency for a small job. This is that job: it
 * knows the names the project's own modules export, and it asks whether a file
 * using one of them said where it came from.
 *
 * Deliberately narrow. It does not check globals, node builtins, or anything
 * from node_modules — only names this codebase exports to itself, which is
 * where the mistake actually happens.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nImports');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(SRC);

/** Strip comments and string literals, so their contents are never read as code. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

/* --------------------------------------- what this codebase exports to itself */

/**
 * Only the shared helper modules, and only distinctive names.
 *
 * The first version of this scanned every export in the codebase and reported
 * seven problems, all of them false: `start`, `mode`, `internal`, `db`,
 * `isLive`, `status`. Each is exported somewhere and each is also a perfectly
 * ordinary local variable, so the check was finding name collisions rather than
 * missing imports.
 *
 * A guard that is wrong seven times out of seven gets ignored, so it now
 * watches the three modules whose helpers actually travel between files, and
 * skips names short enough to be a local -- which is exactly the population the
 * mistake comes from.
 */
const SHARED = ['db.js', 'auth.js', join('engine', 'csv.js')];
const isShared = (file) => SHARED.some((s) => file.endsWith(s));

/** A name a local variable might plausibly also be called. */
const tooCommon = new Set(['run', 'all', 'one', 'can', 'db', 'log', 'get', 'set', 'has', 'to']);
const distinctive = (name) => name.length >= 4 && !tooCommon.has(name);

const exported = new Map();          // name -> the file that exports it
for (const file of files) {
  if (!isShared(file)) continue;
  const src = code(readFileSync(file, 'utf8'));
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    if (distinctive(m[1])) exported.set(m[1], file);
  }
  // `export { a, b as c }`
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name && distinctive(name)) exported.set(name, file);
    }
  }
}

test('the codebase exports enough names for this check to be meaningful', () => {
  assert(exported.size > 20, `only found ${exported.size} shared helper names — the scan is not working`);
  for (const name of ['activeOrg', 'notify', 'sendCsv', 'orgsFor', 'mayUseOrg']) {
    assert(exported.has(name), `"${name}" is exported somewhere but the scan missed it`);
  }
});

test('every project helper a file uses is imported into that file', () => {
  const problems = [];

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const src = code(raw);

    /* Names this file brings in, and names it declares for itself. A local
       `const run = ...` shadowing an exported name is legitimate and must not
       be reported. */
    const known = new Set();
    for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+/g)) {
      for (const part of m[1].replace(/[{}]/g, ' ').split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name && name !== '*') known.add(name);
      }
    }
    for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
    // Destructured locals and function parameters.
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/[:=]/).pop().trim();
        if (name) known.add(name);
      }
    }
    for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const part of m[1].replace(/[{}[\]]/g, ' ').split(',')) {
        const name = part.trim().split(/[:=]/)[0].trim();
        if (name) known.add(name);
      }
    }
    for (const m of src.matchAll(/function\s*[\w$]*\s*\(([^()]*)\)/g)) {
      for (const part of m[1].replace(/[{}[\]]/g, ' ').split(',')) {
        const name = part.trim().split(/[:=]/)[0].trim();
        if (name) known.add(name);
      }
    }

    for (const [name, from] of exported) {
      if (from === file || known.has(name)) continue;

      /* Used as a call, or as a bare value — but never as a property
         (`x.notify`) or an object key (`notify:`), which are different names
         that happen to look the same. */
      const used = new RegExp(`(^|[^.\\w$])${name}\\s*(\\(|[,);\\]}]|$)`, 'm');
      if (!used.test(src)) continue;

      problems.push(`${relative(SRC, file).replace(/\\/g, '/')} uses ${name}() and does not import it `
        + `(exported by ${relative(SRC, from).replace(/\\/g, '/')})`);
    }
  }

  assert.equal(problems.length, 0,
    `a helper is used without being imported — it will throw the first time that line runs:\n         ${problems.join('\n         ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
