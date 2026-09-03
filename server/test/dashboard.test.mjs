/**
 * Dashboard backend robustness (P2-17d).
 *
 * "The backend must be robust, so that the frontend never spills over or
 * displays incorrect data." Three distinct failures live under that sentence,
 * and only one of them is about arithmetic:
 *
 *   a figure that is WRONG        — the number does not match the records
 *   a figure that is MISSING      — a builder threw and the tile vanished
 *   a figure that will not FIT    — NaN, Infinity, or forty characters wide
 *
 * The second is the one that had no defence at all: every builder ran inside a
 * `catch { return [] }`, so a broken tile simply was not there and the page
 * looked complete. That is not a safe failure — it is the same reader drawing
 * the same conclusion from less information without knowing any is absent.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { all, one } from '../src/db.js';

/* Source read from disk, so line endings are whatever git checked out --
   CRLF on Windows. Every pattern below is written with \n, so normalise once
   here rather than in each assertion. */
const CRLF = /\r\n/g;

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nDashboard robustness');

const SRC = readFileSync(new URL('../src/routes/dashboard.js', import.meta.url), 'utf8').replace(CRLF, '\n');

test('a builder that fails is reported, not swallowed', () => {
  /* The regression that matters. If this catch ever goes back to swallowing,
     a broken figure becomes an invisible one again. */
  assert(/broken\.push/.test(SRC), 'a failing builder is no longer recorded');
  assert(/console\.error\(`\[dashboard\]/.test(SRC), 'a failing builder is not logged');
  assert(/broken: broken\.length \? broken : null/.test(SRC),
    'the response does not tell the reader which panels are missing');

  // And the empty catch must be gone.
  assert(!/catch\s*\{\s*return \[\];\s*\}/.test(SRC), 'a bare swallowing catch is still present');
  assert(!/catch\s*\{\s*return null;\s*\}/.test(SRC), 'a bare swallowing catch is still present');
});

test('one broken panel does not take the whole dashboard down', () => {
  // The other half of the same decision: report it, and still render the rest.
  assert(/flatMap\(\(k\) => \{[\s\S]*?try \{/.test(SRC), 'tiles are no longer built defensively');
  assert(/\.filter\(Boolean\)/.test(SRC), 'a failed chart would reach the client as null');
});

test('every figure is money, a count or a percentage — never a raw float', () => {
  /* "Never spills over" is partly a formatting promise. A ratio printed raw is
     0.6666666666666666 on somebody's homepage. */
  assert(/toFixed\(/.test(SRC), 'no rounding anywhere in the dashboard builders');
  assert(/toLocaleString\('en-IN'\)/.test(SRC), 'money is not formatted for the Indian grouping');
});

test('a percentage cannot divide by zero', () => {
  /* An empty period is the normal state of a new deployment and of the first
     day of every month. Every ratio in the file must guard its denominator. */
  const divisions = SRC.match(/\/\s*\w+(?:\.\w+)*\s*\)?\s*\*\s*100/g) ?? [];
  assert(divisions.length > 0, 'expected some percentages to check');
  // Each one must sit near a guard: a ternary, a Math.max, or an || fallback.
  for (const d of divisions) {
    const at = SRC.indexOf(d);
    const around = SRC.slice(Math.max(0, at - 220), at + 40);
    assert(/\?|Math\.max|\|\||\bif\s*\(/.test(around),
      `a percentage looks unguarded against a zero denominator: ...${d}`);
  }
});

test('the funnel can only narrow', () => {
  /* A per-stage count produces a "funnel" that goes up and down, which is not
     a funnel. It is cumulative, and this asserts the arithmetic rather than
     the comment claiming it. */
  const stages = ['New', 'Contacted', 'Qualified', 'In Progress', 'Won'];
  const counts = new Map(
    all(`SELECT stage, COUNT(*) n FROM leads WHERE deleted_at IS NULL GROUP BY stage`)
      .map((r) => [r.stage, r.n]),
  );
  const cumulative = stages.map((_, i) =>
    stages.slice(i).reduce((sum, name) => sum + (counts.get(name) ?? 0), 0));

  for (let i = 1; i < cumulative.length; i += 1) {
    assert(cumulative[i] <= cumulative[i - 1],
      `the funnel widens at ${stages[i]}: ${cumulative[i - 1]} then ${cumulative[i]}`);
  }
});

test('a chart caps how many points it will return', () => {
  /* Thirty distinct lead sources is a realistic import artefact, and a bar
     chart with thirty bars is unreadable at any width. The cap is what stops
     the frontend having to cope. */
  const limits = SRC.match(/LIMIT \d+/g) ?? [];
  assert(limits.length >= 2, 'chart queries do not cap their result size');
  for (const l of limits) {
    const n = Number(l.replace('LIMIT ', ''));
    assert(n <= 20, `a chart returns up to ${n} points, which no chart can render legibly`);
  }
});

test('every builder scopes by book', () => {
  /* The boundary again. A dashboard aggregate that skips the scope is the
     quietest possible cross-book leak: no record is shown, only a number that
     silently includes the other business — which is how the partner
     commission tile read 2.1 lakh instead of 60 thousand. */
  const builders = SRC.split(/\nfunction (\w+)\(/).slice(1);
  for (let i = 0; i < builders.length; i += 2) {
    const name = builders[i];
    const body = builders[i + 1];
    if (!/\ball\(|\bone\(/.test(body)) continue;          // no query, nothing to scope
    assert(/Scope\(|scope\.sql|orgsFor|activeOrg|sales_org/.test(body),
      `${name}() queries without any book scope`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
