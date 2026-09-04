/**
 * A literal route must not be registered behind a route that would swallow it.
 *
 * Express matches in registration order. `GET /leads/:id` registered before
 * `GET /leads/export-columns` means the second is never reached: the first
 * takes "export-columns" as an id and answers "Lead not found".
 *
 * That happened, and the interesting part is how it presented. The column
 * picker asked the server what it could export, got a 404, and rendered
 * "0 of 0 fields" — which reads as a configuration that is empty rather than a
 * route that is unreachable. Nothing errored. The same shape of mistake sits
 * one line away from every `/:id` route in this codebase, and the check is
 * cheap, so it is written down rather than remembered.
 *
 * Static: it reads registration order out of the source. No server needed, and
 * it catches the mistake before anybody has to notice a screen behaving oddly.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(here, '..', 'src', 'routes');

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nRoute shadowing');

/** Every route in one file, in the order Express will try them. */
function routesIn(src) {
  const out = [];
  const re = /router\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;
  for (const m of src.matchAll(re)) {
    out.push({ method: m[1], path: m[2], index: m.index });
  }
  return out;
}

const segments = (p) => p.split('/').filter(Boolean);
const isParam = (s) => s.startsWith(':');
const hasParam = (p) => segments(p).some(isParam);

/** Would `pattern` match the literal path `target`? */
function swallows(pattern, target) {
  const a = segments(pattern);
  const b = segments(target);
  if (a.length !== b.length) return false;

  return a.every((seg, i) => {
    if (isParam(seg)) return true;             // :id eats anything
    if (seg.endsWith('*') || seg === '*') return true;
    return seg === b[i];
  });
}

test('no literal route is registered behind one that would swallow it', () => {
  const problems = [];

  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(ROUTES, file), 'utf8');
    const routes = routesIn(src);

    for (const [i, route] of routes.entries()) {
      // Only literal paths can be swallowed; a parameterised one is the eater.
      if (hasParam(route.path)) continue;

      for (const earlier of routes.slice(0, i)) {
        if (earlier.method !== route.method) continue;
        if (!hasParam(earlier.path)) continue;
        if (!swallows(earlier.path, route.path)) continue;

        const line = src.slice(0, route.index).split('\n').length;
        const earlierLine = src.slice(0, earlier.index).split('\n').length;
        problems.push(
          `${file}:${line} ${route.method.toUpperCase()} ${route.path} `
          + `is unreachable — ${earlier.method.toUpperCase()} ${earlier.path} at line ${earlierLine} matches it first`,
        );
      }
    }
  }

  assert.equal(problems.length, 0, `a route can never be reached:\n         ${problems.join('\n         ')}`);
});

test('the check would notice the bug it was written for', () => {
  /* A guard nobody has seen fail is a guard nobody knows works. This is the
     exact pair that went wrong: /leads/:id registered before
     /leads/export-columns. */
  assert(swallows('/leads/:id', '/leads/export-columns'),
    'the check does not see :id swallowing a literal segment');

  // And the cases it must not flag.
  assert(!swallows('/leads/:id', '/leads/import/sample'), 'different depths were treated as a clash');
  assert(!swallows('/leads/:id/call', '/leads/export-columns'), 'different depths were treated as a clash');
  assert(!swallows('/clients/:id', '/leads/export-columns'), 'a different prefix was treated as a clash');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
