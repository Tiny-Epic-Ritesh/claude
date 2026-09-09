/**
 * Handing over a book when somebody leaves (P3-19).
 *
 * This is the largest write the system does on one click: thousands of rows
 * across seven tables, decided by somebody under time pressure on a colleague's
 * last afternoon. So the things worth testing are not that it moves rows — it
 * plainly does — but that the preview is the move, that it cannot cross the
 * book boundary, and that undoing it does not quietly overwrite whatever the
 * new owner has done since.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import {
  OBJECTS, bookOf, planHandover, runHandover, undoHandover,
} from '../src/engine/handover.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

const PROBE = await probeAdmin('handover');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nHandover');

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* ---------------------------------------------------------- the cast */

const mkUser = (name, org = 'BONANZA') => {
  run('DELETE FROM users WHERE email = ?', [`${name}@handover.test`]);
  const seeded = one("SELECT password FROM users WHERE email = 'admin@bonanza.test'");
  const r = run(
    `INSERT INTO users (name, email, password, role, sales_org, active)
     VALUES (?,?,?,'sales_rm',?,1)`,
    [name, `${name}@handover.test`, seeded.password, org],
  );
  return Number(r.lastInsertRowid);
};

const LEAVER = mkUser('leaver');
const ALICE = mkUser('alice');
const BOB = mkUser('bob');
const BIGUL_RM = mkUser('bigulrm', 'BIGUL');

const mkLead = (stage, owner) => Number(run(
  `INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id)
   VALUES (?,?, 'Referral', ?, 'BONANZA', ?)`,
  [`Handover probe ${Math.random().toString(36).slice(2, 9)}`,
    `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, stage, owner],
).lastInsertRowid);

/* Six open and two closed, so a round-robin split is checkable and the closed
   bucket is separable from the open one. */
const OPEN = [1, 2, 3, 4, 5, 6].map(() => mkLead('New', LEAVER));
const CLOSED = [1, 2].map(() => mkLead('Won', LEAVER));

const clean = () => {
  for (const id of [...OPEN, ...CLOSED]) {
    run('DELETE FROM activities WHERE lead_id = ?', [id]);
    run('DELETE FROM leads WHERE id = ?', [id]);
  }
  run("DELETE FROM handover_move WHERE batch_id IN (SELECT id FROM handover_batch WHERE from_user_id IN (SELECT id FROM users WHERE email LIKE '%@handover.test'))");
  run("DELETE FROM handover_batch WHERE from_user_id IN (SELECT id FROM users WHERE email LIKE '%@handover.test')");
  run("UPDATE users SET manager_id = NULL WHERE email LIKE '%@handover.test'");
  run("DELETE FROM users WHERE email LIKE '%@handover.test'");
};

/* ------------------------------------------------------------ the book */

await test('the book is counted before anything moves', () => {
  /* Until now the only way to find out what somebody held was to deactivate
     them and read the refusal. */
  const book = bookOf(LEAVER);
  const open = book.objects.find((o) => o.key === 'leads_open');
  const closed = book.objects.find((o) => o.key === 'leads_closed');

  assert.equal(open.count, 6, `open leads counted ${open.count}`);
  assert.equal(closed.count, 2, `closed leads counted ${closed.count}`);
  assert(book.objects.some((o) => o.key === 'reports'), 'direct reports are not part of the book');
});

await test('won leads are part of the book, not left behind', () => {
  /* The old reassignment moved `stage NOT IN ('Won','Lost')` only, so a won
     lead kept an owner who could not sign in — a client with nobody to ring.
     Safe to move because credit comes from activities.user_id, not from who
     owns the row now. */
  assert(OBJECTS.some((o) => o.key === 'leads_closed'), 'closed leads cannot be handed over at all');
});

/* ----------------------------------------------------------- the plan */

await test('the preview is the move: same order, same split', () => {
  /* A preview computed differently from its own execution is worse than none,
     because it is believed. Planning twice must give the same answer. */
  const args = { from: LEAVER, targets: [ALICE, BOB], include: ['leads_open'], strategy: 'round_robin' };
  const a = planHandover(args);
  const b = planHandover(args);

  assert.deepEqual(a.moves, b.moves, 'two previews of the same handover disagreed');
  assert.equal(a.total, 6);

  const split = a.objects[0].split;
  assert.deepEqual(split.map((s) => s.n), [3, 3], `six leads split ${split.map((s) => s.n).join('/')}`);
});

await test('round-robin deals per object, not across the whole book', () => {
  /* Otherwise a two-way split of 6 leads and 2 closed leads gives one person
     every closed one because the open leads happened to end on an odd count. */
  const plan = planHandover({
    from: LEAVER, targets: [ALICE, BOB], include: ['leads_open', 'leads_closed'], strategy: 'round_robin',
  });
  const closed = plan.objects.find((o) => o.key === 'leads_closed');
  assert.deepEqual(closed.split.map((s) => s.n), [1, 1], `closed leads split ${JSON.stringify(closed.split)}`);
});

await test('a single-target handover ignores the other names', () => {
  const plan = planHandover({ from: LEAVER, targets: [ALICE, BOB], include: ['leads_open'], strategy: 'single' });
  assert.equal(plan.targets.length, 1);
  assert(plan.moves.every((m) => m.to_user_id === ALICE), 'a single handover split the book');
});

/* ------------------------------------------------------------- the run */

let batchId = null;

await test('the whole book moves, and each lead says why', () => {
  const plan = planHandover({
    from: LEAVER, targets: [ALICE, BOB], include: ['leads_open', 'leads_closed'], strategy: 'round_robin',
  });
  const out = runHandover(plan, { runBy: PROBE.id, reason: 'Left the firm', salesOrg: 'BONANZA' });
  batchId = out.batch_id;

  assert.equal(out.moved, 8, `moved ${out.moved}`);
  assert.equal(one('SELECT COUNT(*) AS n FROM leads WHERE owner_id = ?', [LEAVER]).n, 0,
    'the leaver still owns leads');

  const alice = one('SELECT COUNT(*) AS n FROM leads WHERE owner_id = ?', [ALICE]).n;
  const bob = one('SELECT COUNT(*) AS n FROM leads WHERE owner_id = ?', [BOB]).n;
  assert.equal(alice + bob, 8, `${alice} + ${bob} leads arrived`);

  /* Somebody arrives on Monday owning leads they have never seen; the only
     question they have is why, so the answer is on the record. */
  const note = one('SELECT subject, body FROM activities WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [OPEN[0]]);
  assert(/Reassigned from leaver/.test(note.subject), `note said "${note.subject}"`);
  assert(/Left the firm/.test(note.body), `note body said "${note.body}"`);
});

await test('every move is written down with where it came from', () => {
  const moves = all('SELECT * FROM handover_move WHERE batch_id = ?', [batchId]);
  assert.equal(moves.length, 8);
  assert(moves.every((m) => m.from_user_id === LEAVER), 'a move did not record its previous owner');
});

/* ------------------------------------------------------------ the undo */

await test('undo puts back only what nobody has touched since', () => {
  /* Undo is for the handover that went to the wrong person and is noticed
     within the hour. It is not a way to overwrite a fortnight of somebody
     else's work because the batch is still in the list. */
  const movedOn = OPEN[0];
  run('UPDATE leads SET owner_id = ? WHERE id = ?', [BOB, movedOn]);
  const ownerNow = one('SELECT owner_id FROM leads WHERE id = ?', [movedOn]).owner_id;

  const out = undoHandover(batchId, PROBE.id);

  assert.equal(out.skipped, ownerNow === BOB ? 1 : 0, `skipped ${out.skipped}`);
  assert.equal(out.restored, 8 - out.skipped, `restored ${out.restored}`);
  assert.equal(one('SELECT owner_id FROM leads WHERE id = ?', [movedOn]).owner_id, BOB,
    'undo overwrote a decision somebody made after the handover');
  assert.equal(one('SELECT owner_id FROM leads WHERE id = ?', [OPEN[1]]).owner_id, LEAVER,
    'an untouched lead did not go back');
});

await test('a handover cannot be undone twice', () => {
  const again = undoHandover(batchId, PROBE.id);
  assert(again.error, 'undoing twice was allowed, which would move rows a second time');
});

/* ------------------------------------------------------ the boundary */

await test('a book cannot be handed across the book boundary', async () => {
  /* The one thing this system is built not to do: a Bigul RM holding Bonanza's
     clients. */
  const res = await call('POST', `/setup/users/${LEAVER}/handover/preview`, {
    targets: [BIGUL_RM], include: ['leads_open'], strategy: 'single',
  });
  assert.equal(res.status, 400, `HTTP ${res.status}`);
  assert(/BIGUL/.test(res.body.error), res.body.error);
});

await test('a book cannot be handed to the person leaving it', async () => {
  const res = await call('POST', `/setup/users/${LEAVER}/handover`, {
    targets: [LEAVER], include: ['leads_open'],
  });
  assert.equal(res.status, 400, `HTTP ${res.status}`);
});

await test('a handover to nobody, or of nothing, is refused', async () => {
  assert.equal((await call('POST', `/setup/users/${LEAVER}/handover`, { include: ['leads_open'] })).status, 400);
  assert.equal((await call('POST', `/setup/users/${LEAVER}/handover`, { targets: [ALICE] })).status, 400);
});

await test('an inactive colleague cannot be handed a book', async () => {
  run('UPDATE users SET active = 0 WHERE id = ?', [BOB]);
  try {
    const res = await call('POST', `/setup/users/${LEAVER}/handover`, {
      targets: [BOB], include: ['leads_open'],
    });
    assert.equal(res.status, 400, `HTTP ${res.status}`);
  } finally {
    run('UPDATE users SET active = 1 WHERE id = ?', [BOB]);
  }
});

/* ------------------------------------------------------------ the routes */

await test('the book route offers only colleagues in the same book', async () => {
  const res = await call('GET', `/setup/users/${LEAVER}/book`);
  assert.equal(res.status, 200, `HTTP ${res.status}`);

  const ids = res.body.candidates.map((c) => c.id);
  assert(ids.includes(ALICE), 'a colleague in the same book was not offered');
  assert(!ids.includes(BIGUL_RM), 'a Bigul RM was offered a Bonanza book');
  assert(!ids.includes(LEAVER), 'the person leaving was offered their own book');
});

await test("another book's user has no readable book", async () => {
  /* The conformance suite probes this route as a Bigul RM, who is refused for
     lacking admin.users — so it proves the route is closed without proving
     which rule closed it. Here the caller holds admin.users and is refused on
     the book alone, which is the rule that matters. */
  const bigulAdmin = await probeAdmin('handover_bigul', { role: 'admin', sales_org: 'BIGUL' });
  try {
    const res = await fetch(`${BASE}/api/setup/users/${LEAVER}/book`, {
      headers: { Authorization: `Bearer ${bigulAdmin.token}` },
    });
    assert.equal(res.status, 403, `a Bigul administrator read a Bonanza book: HTTP ${res.status}`);
  } finally {
    bigulAdmin.cleanup();
  }
});

await test('the preview route says what would move without moving it', async () => {
  const before = one('SELECT COUNT(*) AS n FROM leads WHERE owner_id = ?', [LEAVER]).n;

  const res = await call('POST', `/setup/users/${LEAVER}/handover/preview`, {
    targets: [ALICE], include: ['leads_open'], strategy: 'single',
  });
  assert.equal(res.status, 200, `HTTP ${res.status}`);
  assert(res.body.total > 0, 'the preview moved nothing');
  assert.equal(res.body.moves, undefined, 'the preview shipped the whole move list to the browser');

  assert.equal(one('SELECT COUNT(*) AS n FROM leads WHERE owner_id = ?', [LEAVER]).n, before,
    'the preview moved the book');
});

await test('the run route records a batch that can be listed and undone', async () => {
  const made = await call('POST', `/setup/users/${LEAVER}/handover`, {
    targets: [ALICE], include: ['leads_open'], strategy: 'single', reason: 'Resigned',
  });
  assert.equal(made.status, 201, `HTTP ${made.status}: ${JSON.stringify(made.body)}`);

  const list = await call('GET', '/setup/handovers');
  assert(list.body.some((b) => b.id === made.body.batch_id), 'the handover is not listed');

  const undone = await call('POST', `/setup/handovers/${made.body.batch_id}/undo`);
  assert.equal(undone.status, 200, `HTTP ${undone.status}`);
  assert(undone.body.restored > 0, 'the undo restored nothing');
});

clean();
PROBE.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
