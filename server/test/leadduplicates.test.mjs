/**
 * The duplicate-mobile refusal on lead create, and what it gives away.
 *
 * Found 11 Sep 2026 while building P3-21. POST /leads checked the mobile
 * against every lead in the firm, before it knew which book the new lead was
 * for, and refused with "Mobile already belongs to lead #412 (Rohan Gupta)".
 * A Bigul RM who typed a Bonanza client's number was told that client's name
 * and lead number; inside one book, any RM could turn a colleague's client's
 * number into a name.
 *
 * The rules now (Ritesh, 11 Sep):
 *   - the check is asked within the lead's own book, because the same person
 *     may be a Bonanza lead and a Bigul lead
 *   - within the book, the refusal may say that the lead exists and who holds
 *     it, and names the client only to somebody who could open the lead anyway
 *
 * The old bulk import (POST /leads/import) had the same firm-wide query. It
 * only ever echoed the caller's own row back, but it skipped a Bigul row for
 * being in Bonanza, which told the uploader so.
 */

import { strict as assert } from 'node:assert';
import { one, run } from '../src/db.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

/* ------------------------------------------------------------- fixtures */

/* Accounts of its own rather than the seeded ones: sign-in is limited per
   account, and the seeded RMs are signed into all through the suite. Three
   sales RMs, whose scope is their own leads -- so the asker cannot open the
   holder's lead, which is the case the refusal has to be careful with. */
const PEOPLE = {
  bigul: { email: 'dupe-probe-rm@bigul.test', name: 'Dupe Probe Bigul', org: 'BIGUL' },
  asker: { email: 'dupe-probe-asker@bonanza.test', name: 'Dupe Probe Asker', org: 'BONANZA' },
  holder: { email: 'dupe-probe-holder@bonanza.test', name: 'Dupe Probe Holder', org: 'BONANZA' },
};
const EMAILS = Object.values(PEOPLE).map((p) => p.email);
const MARKS = EMAILS.map(() => '?').join(',');

/* Borrow a known-good hash rather than reimplement the KDF, as bookscope does. */
const seeded = one("SELECT password FROM users WHERE email = 'admin@bonanza.test'");
assert(seeded, 'the seeded administrator is missing, so there is no password hash to borrow');

/** A mobile no lead holds, so the test collides with neither the seed nor itself. */
const freeMobile = () => {
  for (;;) {
    const m = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    if (!one('SELECT 1 FROM leads WHERE mobile = ?', [m])) return m;
  }
};

/* Leads first: they cascade to their cards and activities, and a lead left
   pointing at a deleted probe user would be debris the next run trips on. */
const clearProbes = () => {
  run(`DELETE FROM leads WHERE owner_id IN (SELECT id FROM users WHERE email IN (${MARKS}))`, EMAILS);
  run(`DELETE FROM users WHERE email IN (${MARKS})`, EMAILS);
};

clearProbes();
for (const p of Object.values(PEOPLE)) {
  p.id = Number(run(
    `INSERT INTO users (name, email, password, role, sales_org, active)
     VALUES (?, ?, ?, 'sales_rm', ?, 1)`,
    [p.name, p.email, seeded.password, p.org],
  ).lastInsertRowid);
}

const MOBILE = freeMobile();
const CLIENT = 'Ishaan Dupeprobe';
const bonanzaLead = Number(run(
  `INSERT INTO leads (sales_org, name, mobile, source, stage, owner_id)
   VALUES ('BONANZA', ?, ?, 'Manual', 'New', ?)`,
  [CLIENT, MOBILE, PEOPLE.holder.id],
).lastInsertRowid);

const login = async (email) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'bonanza' }),
  });
  if (!res.ok) throw new Error(`login ${email}: HTTP ${res.status}`);
  return (await res.json()).token;
};

const call = async (token, method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
};

/** Nothing from the Bonanza lead: not the client, not who holds it, not its number. */
const saysNothingOfBonanza = (text, where) => {
  assert(!text.includes(CLIENT), `${where} named the Bonanza client: ${text.slice(0, 200)}`);
  assert(!text.includes(PEOPLE.holder.name), `${where} named the Bonanza lead's owner: ${text.slice(0, 200)}`);
  assert(!text.includes(`#${bonanzaLead}`), `${where} gave the Bonanza lead number: ${text.slice(0, 200)}`);
};

/* ---------------------------------------------------------------- tests */

try {
  const token = {};
  for (const [key, p] of Object.entries(PEOPLE)) token[key] = await login(p.email);

  console.log('\nThe old bulk import asks within its own book');

  // A dry run, so nothing is written. Before the create below, while the
  // mobile exists only in Bonanza.
  await test('a Bigul import carrying a Bonanza mobile is not skipped as a duplicate', async () => {
    const { status, json, text } = await call(token.bigul, 'POST', '/api/leads/import', {
      rows: [{ name: 'Bigul Import Row', mobile: MOBILE }], commit: false,
    });
    assert.equal(status, 200, `import preview returned HTTP ${status}: ${text.slice(0, 200)}`);
    assert.equal(json.sales_org, 'BIGUL');
    assert.equal(json.duplicates.length, 0,
      'the row was reported as a duplicate of a lead in the other business -- which tells the uploader it exists');
    assert.equal(json.valid, 1);
  });

  await test('inside the book the same row is still a duplicate', async () => {
    const { json } = await call(token.asker, 'POST', '/api/leads/import', {
      rows: [{ name: 'Bonanza Import Row', mobile: MOBILE }], commit: false,
    });
    assert.equal(json.duplicates.length, 1, 'the guard stopped guarding the book it belongs to');
  });

  console.log('\nCreating a lead with a mobile the other book holds');

  let bigulLead = null;
  await test('a Bigul RM using a Bonanza lead\'s mobile gets no Bonanza name or id back', async () => {
    const { status, json, text } = await call(token.bigul, 'POST', '/api/leads', {
      name: 'Bigul Side Prospect', mobile: MOBILE, route: false,
    });
    saysNothingOfBonanza(text, 'the response');
    assert.equal(json?.duplicate_id, undefined, 'a duplicate id was returned across the boundary');
    assert.equal(json?.held_by, undefined, 'who holds the lead was returned across the boundary');
    assert.equal(status, 201,
      `the same person may be a lead in both books, but the create was refused with HTTP ${status}`);
    assert.notEqual(json.id, bonanzaLead);
    assert.equal(json.sales_org, 'BIGUL');
    bigulLead = json.id;

    const untouched = one('SELECT name, sales_org, owner_id FROM leads WHERE id = ?', [bonanzaLead]);
    assert.deepEqual({ ...untouched }, { name: CLIENT, sales_org: 'BONANZA', owner_id: PEOPLE.holder.id },
      'the Bonanza lead changed');
  });

  await test('a second try in Bigul is refused with the Bigul lead, never the Bonanza one', async () => {
    assert(bigulLead, 'the first create did not happen, so this proves nothing');
    const { status, json, text } = await call(token.bigul, 'POST', '/api/leads', {
      name: 'Bigul Side Again', mobile: MOBILE, route: false,
    });
    assert.equal(status, 409, `expected the Bigul duplicate to be refused, got HTTP ${status}`);
    assert.equal(json.duplicate_id, bigulLead);
    saysNothingOfBonanza(text, 'the refusal');
  });

  console.log('\nInside one book');

  await test('an RM who cannot open the lead learns who holds it, and not the client', async () => {
    // The premise, checked rather than assumed: were the asker able to open
    // this lead, naming the client would be fine and the test would be empty.
    const opened = await call(token.asker, 'GET', `/api/leads/${bonanzaLead}`);
    assert.equal(opened.status, 403, `the asker can open the holder's lead (HTTP ${opened.status}), so this proves nothing`);

    const { status, json, text } = await call(token.asker, 'POST', '/api/leads', {
      name: 'Asker Prospect', mobile: MOBILE, route: false,
    });
    assert.equal(status, 409, `a duplicate in the book was not refused: HTTP ${status}`);
    assert(!text.includes(CLIENT), `the refusal named another RM's client: ${json?.error}`);
    assert.equal(json.duplicate_id, undefined, 'the refusal gave the lead number of a lead the asker cannot open');
    assert(!/#\d/.test(json.error), `the refusal carries a lead number: ${json.error}`);
    assert(json.error.includes(PEOPLE.holder.name), `the refusal does not say who holds it: ${json.error}`);
    assert.equal(json.held_by?.name, PEOPLE.holder.name);
  });

  await test('an RM who can open the lead is still told which one it is', async () => {
    const { status, json } = await call(token.holder, 'POST', '/api/leads', {
      name: 'Holder Again', mobile: MOBILE, route: false,
    });
    assert.equal(status, 409);
    assert.equal(json.duplicate_id, bonanzaLead, 'the owner was not pointed at their own lead');
    assert(json.error.includes(CLIENT), `the owner was not told which lead: ${json.error}`);
  });
} finally {
  clearProbes();
}

console.log(`\n${passed} passed, ${failed} failed`);

// exitCode rather than process.exit(), for the same reason as bookscope: exit
// straight after live HTTP calls can die on a libuv assertion.
process.exitCode = failed ? 1 : 0;
