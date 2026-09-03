/**
 * Every async route handler must be registered through wrap().
 *
 * Express 4 hands a synchronous throw to its error middleware but knows nothing
 * about a rejected promise: an async handler that rejects reaches nobody, and
 * Node's answer to an unhandled rejection is to end the process. That is how a
 * sign-in with no email in the body — one unauthenticated request — stopped the
 * server for everybody.
 *
 * Wrapping the twenty-seven handlers that existed on the day fixes those
 * twenty-seven. This is what stops the twenty-eighth from reintroducing it,
 * because the next person to add an async handler will not have read any of the
 * above.
 *
 * Read from source rather than from a running app on purpose: importing
 * index.js binds a port, and a test that needs the server running to check the
 * server's wiring is a test that gets skipped.
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const jsFiles = (dir) => readdirSync(dir).flatMap((entry) => {
  const full = join(dir, entry);
  if (statSync(full).isDirectory()) return jsFiles(full);
  return full.endsWith('.js') ? [full] : [];
});

/** Every line that registers a route handler, with its file and line number. */
const registrations = [];
for (const file of jsFiles(SRC)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/(?:router|app|internal|publicIndices)\.(?:get|post|patch|put|delete|use)\(/.test(line)) {
      registrations.push({ file: relative(SRC, file), line: i + 1, text: line });
    }
  });
}

console.log('\nAsync route handlers — none may escape wrap()');

test('the scan finds the routes it is supposed to be checking', () => {
  // Guards the guard: a regex that quietly matches nothing would make every
  // assertion below vacuous, which is the failure mode of this kind of test.
  assert(registrations.length > 100,
    `only ${registrations.length} route registrations found — the scan is not seeing the routes`);
});

test('every async handler is wrapped', () => {
  const bare = registrations.filter((r) => /async \(req, res/.test(r.text) && !/wrap\(async \(req, res/.test(r.text));
  assert.equal(bare.length, 0,
    `unwrapped async handler(s):\n${bare.map((r) => `         ${r.file}:${r.line}`).join('\n')}`);
});

test('and there are as many wrapped handlers as the codebase has async ones', () => {
  const wrapped = registrations.filter((r) => /wrap\(async \(req, res/.test(r.text));
  assert(wrapped.length >= 27, `only ${wrapped.length} wrapped handlers found`);
});

test('every file that wraps also imports wrap', () => {
  const missing = [];
  for (const file of jsFiles(SRC)) {
    const body = readFileSync(file, 'utf8');
    if (body.includes('wrap(async (req, res') && !/import \{[^}]*\bwrap\b[^}]*\} from '.*asyncroute\.js'/.test(body)) {
      missing.push(relative(SRC, file));
    }
  }
  assert.equal(missing.length, 0, `uses wrap without importing it: ${missing.join(', ')}`);
});

test('wrap itself is not async, which is what makes it detectable', () => {
  // If wrap returned an async function the check above could not tell a wrapped
  // handler from a bare one.
  const body = readFileSync(join(SRC, 'asyncroute.js'), 'utf8');
  assert(!/export const wrap = async/.test(body), 'wrap must not be async');
  assert(/\.catch\(next\)/.test(body), 'wrap must send the rejection to next()');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
