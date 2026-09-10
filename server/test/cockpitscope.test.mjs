/**
 * The homepage numbers respect the book boundary. Q8a.
 *
 * WHY THIS FILE EXISTS
 *
 * `bookscope.test.mjs` exempts `/api/cockpit` with a stated reason: "Aggregate
 * figures for the viewer, each already scoped where it is computed." That was
 * an assumption, and for the Sales Supervisor cockpit it was false. Four of its
 * six numbers counted every row in the database, and the team scorecard listed
 * every sales person in both businesses — by name, with each one's lead count,
 * calls today and conversion rate.
 *
 * A Bigul supervisor saw nine warm cards where three were theirs, and eleven of
 * Bonanza's staff on their own team scorecard.
 *
 * An aggregate leaks more quietly than a record does. Opening somebody else's
 * lead is a 403 you notice; a count that is too large is a number you act on.
 * So the exemption stays — the cockpit really does scope at the point of
 * computation — but it is now checked rather than asserted.
 *
 * WHAT IT CHECKS
 *
 * Every count on the cockpit, against the same figure computed independently
 * for that book alone. Not "is it scoped" but "is it right", because the way
 * this broke was a query that simply forgot the join, and only the number
 * shows that.
 */

import { strict as assert } from 'node:assert';
import { all, one } from '../src/db.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nCockpit book scope');

/* Once, at the top. Signing in per test tripped the login rate limiter, which
   was the limiter working correctly -- a burst of sign-ins against one account
   is precisely what it watches for. The session does not change between these
   tests, so there was never a reason to ask for seven of them. */
const SUPERVISOR = 'supervisor@bigul.test';
const TOKEN = await (async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: SUPERVISOR, password: 'bonanza' }),
  });
  if (!res.ok) throw new Error(`${SUPERVISOR} could not sign in: HTTP ${res.status}`);
  return (await res.json()).token;
})();

const auth = { Authorization: `Bearer ${TOKEN}` };

/* One fetch, reused. The cockpit is a read and does not change under the tests. */
const COCKPIT = await (async () => {
  const res = await fetch(`${BASE}/api/cockpit`, { headers: auth });
  assert.equal(res.status, 200, `cockpit refused for ${SUPERVISOR}: HTTP ${res.status}`);
  return res.json();
})();

const cockpitFor = async () => COCKPIT;

const valueOf = (cockpit, label) => cockpit.metrics.find((m) => m.label === label)?.value;

/* The truth, computed for one book only and independently of the route. */
const trueCards = (org, state) => one(
  `SELECT COUNT(*) n FROM product_cards pc JOIN leads l ON l.id = pc.lead_id
    WHERE pc.state = ? AND l.deleted_at IS NULL AND l.sales_org = ?`,
  [state, org],
).n;

/** Both books, which is what the broken version counted. */
const allCards = (state) => one('SELECT COUNT(*) n FROM product_cards WHERE state = ?', [state]).n;

/**
 * The property, rather than an equality that would only hold by coincidence.
 *
 * A supervisor's tile is not the whole book: `leadScope` narrows them to the
 * leads they can see, which is their team. So the figure may legitimately be
 * smaller than the book's total. What it may never be is larger than the
 * book's, or equal to both books' — and the second is exactly what shipped.
 */
const withinTheBook = (cockpit, label, state) => {
  const shown = valueOf(cockpit, label);
  const book = trueCards('BIGUL', state);
  const both = allCards(state);
  assert(typeof shown === 'number', `"${label}" is not on the cockpit`);
  assert(shown <= book, `"${label}" shows ${shown}; Bigul holds ${book}, so it is reaching past the book`);
  assert(both > book, `the fixture holds ${both} ${state} cards in total and ${book} in Bigul — it cannot show a leak`);
  assert(shown < both, `"${label}" shows ${shown}, which is every ${state} card in both books`);
};

await test("a supervisor's warm cards stay inside their book", async () => {
  /* The number that was wrong: nine across both books where three were Bigul's. */
  withinTheBook(await cockpitFor(), 'Warm cards', 'WARM');
});

await test("a supervisor's active cards stay inside their book", async () => {
  withinTheBook(await cockpitFor(), 'Cards Active', 'ACTIVE');
});

await test("a supervisor's team scorecard holds nobody from the other business", async () => {
  /* The worst of the five, because a scorecard names individuals and reports
     each one's performance. */
  const cockpit = await cockpitFor();
  const rows = cockpit.worklist?.rows ?? [];
  assert(rows.length > 0, 'the scorecard is empty, so this proves nothing');

  const theirs = new Set(
    all("SELECT id FROM users WHERE sales_org = 'BIGUL'").map((u) => u.id),
  );
  const strangers = rows.filter((r) => !theirs.has(r.id));
  assert.equal(strangers.length, 0,
    `${strangers.length} of ${rows.length} people on a Bigul scorecard are not Bigul's: `
    + strangers.slice(0, 4).map((r) => r.name).join(', '));
});

await test('team calls today are counted in one book', async () => {
  const cockpit = await cockpitFor();
  const truth = one(
    `SELECT COUNT(*) n FROM activities a JOIN leads l ON l.id = a.lead_id
      WHERE a.type = 'Call' AND date(a.created_at) = date('now') AND l.sales_org = 'BIGUL'`,
  ).n;
  assert.equal(valueOf(cockpit, 'Team calls today'), truth);
});

await test("the supervisor's chase tiles are the ones a supervisor needs", async () => {
  /* Q8a. Not the RM's three with bigger numbers: a supervisor's unit is people,
     and "leads with no owner" is work only they can see and only they clear. */
  const cockpit = await cockpitFor();
  for (const label of ['RMs behind', 'Unattended over 48h', 'Leads with no owner', 'Approvals waiting on you']) {
    assert(cockpit.metrics.some((m) => m.label === label), `the supervisor cockpit has no "${label}" tile`);
  }
});

await test('every chase tile opens a screen that counts the same set', async () => {
  /* A tile that counts one set and opens another is worse than no tile:
     somebody acts on the larger number and finds the smaller one. */
  const cockpit = await cockpitFor();

  const unowned = cockpit.metrics.find((m) => m.label === 'Leads with no owner');
  assert(unowned?.to, 'the unowned tile opens nothing');

  const res = await fetch(`${BASE}/api/leads?unowned=true&limit=200`, {
    headers: auth,
  });
  assert.equal(res.status, 200, `the screen behind the tile refused: HTTP ${res.status}`);
  const listed = (await res.json()).rows ?? [];
  assert.equal(listed.length, unowned.value,
    `the tile says ${unowned.value} and the screen behind it lists ${listed.length}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
