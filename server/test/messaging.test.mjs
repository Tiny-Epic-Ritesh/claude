/**
 * Internal messaging. P3-21, phase 1.
 *
 * WHAT THIS HAS TO PROVE
 *
 * Messaging is the first feature in this CRM whose whole purpose is to move
 * information between people, which makes it the easiest place to move it
 * somewhere it should not go. So most of what follows is about absence: the
 * outsider who cannot read, the reply the grid has just closed, the lead a
 * colleague is shown only as "a lead you cannot open", the refusal that gives
 * away nothing about whether a lead exists, the reviewer who cannot open the
 * other business's conversations, and the timeline a transfer does not touch.
 *
 * The decisions behind each one are Ritesh's, from 11 September, and are
 * recorded in docs/feedback/P3-21-internal-comms-design.md.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { CAPABILITY_CATALOGUE } from '../src/engine/access.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nInternal messaging');

/* ------------------------------------------------------------- fixtures */

const SLUGS = ['msg-a', 'msg-b', 'msg-c', 'msg-big', 'msg-mon'];
const SUP_EMAIL = 'probe-msg-sup@bonanza.test';

/* Everything this file makes, in the order the foreign keys need. Messages
   before conversations (a conversation holding messages cannot be deleted,
   which the last test below asserts), conversations while the people are
   still there to find them by, and the supervisor only once nobody points at
   them as a manager. */
const clean = () => {
  const emails = [...SLUGS.map((s) => `probe-${s}@bonanza.test`), SUP_EMAIL];
  const ids = all(`SELECT id FROM users WHERE email IN (${emails.map(() => '?').join(',')})`, emails)
    .map((r) => r.id);
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const convos = all(
      `SELECT DISTINCT conversation_id AS id FROM conversation_member WHERE user_id IN (${marks})`, ids,
    ).map((r) => r.id);
    if (convos.length) {
      const cm = convos.map(() => '?').join(',');
      run(`DELETE FROM message WHERE conversation_id IN (${cm})`, convos);
      run(`DELETE FROM conversation_member WHERE conversation_id IN (${cm})`, convos);
      run(`DELETE FROM conversation WHERE id IN (${cm})`, convos);
    }
    run(`DELETE FROM messaging_suspension WHERE user_id IN (${marks})`, ids);
  }

  const leads = all("SELECT id FROM leads WHERE name LIKE 'Msg probe%'").map((r) => r.id);
  if (leads.length) {
    const lm = leads.map(() => '?').join(',');
    run(`DELETE FROM message WHERE lead_id IN (${lm})`, leads);
    run(`DELETE FROM approvals WHERE entity = 'lead' AND entity_id IN (${lm})`, leads);
    run(`DELETE FROM field_history WHERE entity = 'lead' AND record_id IN (${lm})`, leads);
    run(`DELETE FROM activities WHERE lead_id IN (${lm})`, leads);
    run(`DELETE FROM leads WHERE id IN (${lm})`, leads);
  }

  run("DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE name LIKE 'probe_msg%')");
  run("DELETE FROM teams WHERE name LIKE 'probe_msg%'");
  run('UPDATE users SET manager_id = NULL WHERE manager_id IN (SELECT id FROM users WHERE email = ?)', [SUP_EMAIL]);
  run('DELETE FROM users WHERE email = ?', [SUP_EMAIL]);
};
clean();

/* The one grid cell these tests move, captured so it goes back exactly. */
const CELL = "from_role = 'sales_rm' AND to_role = 'sales_rm'";
const CELL_BEFORE = one(`SELECT * FROM messaging_policy WHERE ${CELL}`);
const restoreCell = () => {
  run(`DELETE FROM messaging_policy WHERE ${CELL}`);
  if (CELL_BEFORE) {
    run(
      'INSERT INTO messaging_policy (from_role, to_role, reach, updated_by, updated_at) VALUES (?,?,?,?,?)',
      [CELL_BEFORE.from_role, CELL_BEFORE.to_role, CELL_BEFORE.reach, CELL_BEFORE.updated_by, CELL_BEFORE.updated_at],
    );
  }
};

/* Four RMs and a reviewer, each signing in once. */
const A = await probeAdmin('msg-a', { role: 'sales_rm', sales_org: 'BONANZA' });
const B = await probeAdmin('msg-b', { role: 'sales_rm', sales_org: 'BONANZA' });
const C = await probeAdmin('msg-c', { role: 'sales_rm', sales_org: 'BONANZA' });
const BIG = await probeAdmin('msg-big', { role: 'sales_rm', sales_org: 'BIGUL' });
const MON = await probeAdmin('msg-mon', { role: 'admin', sales_org: 'BONANZA' });

/* B's supervisor on the org chart. Never signs in -- only has to be told. */
const SUP = Number(run(
  `INSERT INTO users (name, email, password, role, sales_org, active) VALUES (?,?,?,?,?,1)`,
  ['Msg probe supervisor', SUP_EMAIL, one("SELECT password FROM users WHERE email = 'admin@bonanza.test'").password,
    'sales_supervisor', 'BONANZA'],
).lastInsertRowid);
run('UPDATE users SET manager_id = ? WHERE id = ?', [SUP, B.id]);

/* A manages a sales group B sits on, so A can open B's leads (N-7a) -- which
   is what lets A ask for one. Under the private floor an RM sees only their
   own book; somebody has to be able to see a lead to ask for it. */
const DESK = Number(run(
  "INSERT INTO teams (name, manager_id, parent_id, sales_org, active) VALUES ('probe_msg desk', ?, NULL, 'BONANZA', 1)",
  [A.id],
).lastInsertRowid);
run('INSERT INTO team_members (team_id, user_id) VALUES (?,?)', [DESK, B.id]);

/* Each with its own mobile, because the lookup below matches on it. */
const makeLead = (slug, ownerId, mobile, org = 'BONANZA') => Number(run(
  `INSERT INTO leads (name, mobile, email, source, stage, sales_org, owner_id)
   VALUES (?, ?, ?, 'Referral', 'New', ?, ?)`,
  [`Msg probe ${slug}`, mobile, `msg-${slug}@lead.test`, org, ownerId],
).lastInsertRowid);

const L_A = makeLead('a-own', A.id, '9800000051');
const L_B = makeLead('b-one', B.id, '9800000052');
const L_B2 = makeLead('b-two', B.id, '9800000053');
const L_B3 = makeLead('b-three', B.id, '9800000054');
makeLead('bigul-side', BIG.id, '9800000055', 'BIGUL');

const call = async (probe, method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: probe.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
};

const setCell = (reach) => call(MON, 'PUT', '/messages/policy', { from_role: 'sales_rm', to_role: 'sales_rm', reach });
const thread = async (probe, id) => (await call(probe, 'GET', `/messages/conversations/${id}/messages`)).body.messages;

let AB; // the conversation between A and B, used throughout

/* ------------------------------------------------------------ talking */

await test('two colleagues in the same book can talk, and read state is per person', async () => {
  const opened = await call(A, 'POST', '/messages/conversations', { user_id: B.id });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  AB = opened.body.id;

  const again = await call(A, 'POST', '/messages/conversations', { user_id: B.id });
  assert.equal(again.body.id, AB, 'a second conversation was opened with the same person');

  const sent = await call(A, 'POST', `/messages/conversations/${AB}/messages`, { body: 'Are you covering the Pune walk-ins?' });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));

  assert.equal((await call(B, 'GET', '/messages/unread')).body.messages, 1, 'the recipient has no unread message');
  assert.equal((await call(A, 'GET', '/messages/unread')).body.messages, 0, 'the sender counts their own message as unread');

  const read = await thread(B, AB);
  assert.equal(read.at(-1).body, 'Are you covering the Pune walk-ins?');

  await call(B, 'POST', `/messages/conversations/${AB}/read`, { last_id: sent.body.id });
  assert.equal((await call(B, 'GET', '/messages/unread')).body.messages, 0, 'marking it read did not clear the count');
});

await test('the conversation list carries the monitoring notice', async () => {
  /* Disclosed, as a standing notice -- Ritesh, 11 September. From the server,
     so no screen can forget to say it. */
  const list = await call(B, 'GET', '/messages/conversations');
  assert.equal(list.body.notice, 'Messages here can be reviewed by compliance.');
  assert(list.body.conversations.some((c) => c.id === AB), 'the conversation is not in the list');
});

await test('somebody outside a conversation can neither read it nor post into it', async () => {
  const read = await call(C, 'GET', `/messages/conversations/${AB}/messages`);
  const post = await call(C, 'POST', `/messages/conversations/${AB}/messages`, { body: 'hello' });
  assert.equal(read.status, 404, `an outsider read it: HTTP ${read.status}`);
  assert.equal(post.status, 404, `an outsider posted into it: HTTP ${post.status}`);
});

/* ------------------------------------------------------------ the grid */

await test('the other business is closed until the grid opens it', async () => {
  assert(!CELL_BEFORE || CELL_BEFORE.reach !== 'any_book',
    'setup: the grid already opens RM to RM across the books, so this proves nothing');
  const res = await call(A, 'POST', '/messages/conversations', { user_id: BIG.id });
  assert.equal(res.status, 403, `a Bonanza RM opened a conversation with a Bigul RM: HTTP ${res.status}`);
  assert(/other business/.test(res.body.error), res.body.error);
});

await test('the grid can open the other business, and closing it again closes replies too', async () => {
  const opened = await setCell('any_book');
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const audited = one("SELECT * FROM config_audit WHERE area = 'messaging_policy' ORDER BY id DESC LIMIT 1");
  assert(audited && JSON.parse(audited.after_json).reach === 'any_book', 'the change is not in the configuration audit');

  const convo = await call(A, 'POST', '/messages/conversations', { user_id: BIG.id });
  const sent = convo.body?.id
    ? await call(A, 'POST', `/messages/conversations/${convo.body.id}/messages`, { body: 'Sending you the Nagpur list' })
    : null;

  /* Closed again BEFORE asserting, so a failure here cannot leave the books
     open for every test and every person after it. */
  await setCell('same_book');
  const reply = convo.body?.id
    ? await call(BIG, 'POST', `/messages/conversations/${convo.body.id}/messages`, { body: 'Thanks' })
    : null;

  assert.equal(convo.status, 201, JSON.stringify(convo.body));
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(reply.status, 403, `a reply crossed a boundary the grid had just closed: HTTP ${reply.status}`);
});

await test('a blocked pair is blocked for new conversations and for replies', async () => {
  await setCell('blocked');
  const reply = await call(B, 'POST', `/messages/conversations/${AB}/messages`, { body: 'Yes' });
  const fresh = await call(A, 'POST', '/messages/conversations', { user_id: C.id });
  await setCell('same_book');

  assert.equal(reply.status, 403, `a reply went through a blocked pair: HTTP ${reply.status}`);
  assert(/switched off/.test(reply.body.error), reply.body.error);
  assert.equal(fresh.status, 403, `a conversation was opened across a blocked pair: HTTP ${fresh.status}`);
});

await test('only an administrator can change who may message whom', async () => {
  const res = await call(A, 'PUT', '/messages/policy', { from_role: 'sales_rm', to_role: 'sales_rm', reach: 'any_book' });
  assert.equal(res.status, 403);
  assert.equal(res.body.required, 'admin.roles');
  assert.equal(one(`SELECT reach FROM messaging_policy WHERE ${CELL}`)?.reach ?? 'same_book', 'same_book',
    'the refused change was applied anyway');
});

/* ------------------------------------------------------------ the lead */

await test('a lead in a message is drawn for each reader, never copied into it', async () => {
  const sent = await call(A, 'POST', `/messages/conversations/${AB}/messages`, { body: 'This one called twice', lead_id: L_A });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));

  const mine = (await thread(A, AB)).find((m) => m.id === sent.body.id);
  const theirs = (await thread(B, AB)).find((m) => m.id === sent.body.id);
  assert.equal(mine.lead?.id, L_A, `the sender is not shown their own lead: ${JSON.stringify(mine.lead)}`);
  assert.deepEqual(theirs.lead, { hidden: true },
    `a colleague who cannot open the lead was shown ${JSON.stringify(theirs.lead)}`);

  const stored = one('SELECT body FROM message WHERE id = ?', [sent.body.id]).body;
  assert(!stored.includes('Msg probe'), 'the lead was copied into the message text');
});

await test('nobody can attach a lead they cannot open, and the refusal gives nothing away', async () => {
  const real = await call(B, 'POST', `/messages/conversations/${AB}/messages`, { body: 'look', lead_id: L_A });
  const fake = await call(B, 'POST', `/messages/conversations/${AB}/messages`, { body: 'look', lead_id: 99999999 });
  assert.equal(real.status, 404, `attached a lead they cannot open: HTTP ${real.status}`);
  assert.deepEqual(real.body, fake.body,
    'a lead that exists is refused differently from one that does not, which tells the sender it exists');
});

/* ------------------------------------------------------------ reviewing */

await test('a frozen conversation takes no messages, and both people are told why', async () => {
  const byRm = await call(A, 'POST', `/messages/conversations/${AB}/freeze`, { reason: 'x' });
  assert.equal(byRm.status, 403, 'an RM froze a conversation');
  assert.equal((await call(MON, 'POST', `/messages/conversations/${AB}/freeze`, {})).status, 400, 'frozen with no reason');

  const frozen = await call(MON, 'POST', `/messages/conversations/${AB}/freeze`, { reason: 'Client details shared in chat' });
  assert.equal(frozen.status, 200, JSON.stringify(frozen.body));
  const blocked = await call(A, 'POST', `/messages/conversations/${AB}/messages`, { body: 'still there?' });
  const last = (await thread(B, AB)).at(-1);
  const thawed = await call(MON, 'POST', `/messages/conversations/${AB}/unfreeze`, {});

  assert.equal(blocked.status, 409, `a frozen conversation took a message: HTTP ${blocked.status}`);
  assert.equal(last.kind, 'system');
  assert(/Client details shared in chat/.test(last.body), last.body);
  for (const p of [A, B]) {
    assert(one("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'A conversation was frozen'", [p.id]),
      `${p.email} was not told the conversation was frozen`);
  }
  assert.equal(thawed.status, 200, JSON.stringify(thawed.body));
  assert.equal((await call(A, 'POST', `/messages/conversations/${AB}/messages`, { body: 'back' })).status, 201,
    'unfreezing did not reopen it');
});

await test('a suspended person cannot send, and can still read', async () => {
  const s = await call(MON, 'POST', '/messages/suspensions', { user_id: A.id, reason: 'Pending review' });
  const sendTry = await call(A, 'POST', `/messages/conversations/${AB}/messages`, { body: 'hello?' });
  const readTry = await call(A, 'GET', `/messages/conversations/${AB}/messages`);
  const list = await call(A, 'GET', '/messages/conversations');
  const lifted = await call(MON, 'DELETE', `/messages/suspensions/${A.id}`);

  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(sendTry.status, 403, `a suspended person sent a message: HTTP ${sendTry.status}`);
  assert(/suspended/.test(sendTry.body.error), sendTry.body.error);
  assert.equal(readTry.status, 200, 'suspension took away reading as well as sending');
  assert.equal(list.body.suspended, 'Pending review', 'the person suspended is not told why');
  assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
});

await test("a reviewer's read is itself on the record", async () => {
  const count = () => one(
    "SELECT COUNT(*) n FROM audit_log WHERE action = 'conversation_reviewed' AND entity_id = ? AND user_id = ?",
    [AB, MON.id],
  ).n;
  const before = count();
  const res = await call(MON, 'GET', `/messages/monitor/${AB}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(count(), before + 1, 'reading a conversation as a reviewer left no trace');
});

await test('only a reviewer can review', async () => {
  for (const path of [`/messages/monitor/${AB}`, '/messages/monitor', '/messages/suspensions']) {
    const res = await call(B, 'GET', path);
    assert.equal(res.status, 403, `${path}: HTTP ${res.status}`);
  }
});

await test('a reviewer cannot open a conversation held wholly in the other business', async () => {
  const mate = one(
    `SELECT id FROM users WHERE sales_org = 'BIGUL' AND active = 1 AND role != 'superadmin'
       AND (org_access IS NULL OR org_access = '') AND id != ? ORDER BY id LIMIT 1`,
    [BIG.id],
  );
  assert(mate, 'setup: no second Bigul-only user to hold the conversation with');
  const id = Number(run("INSERT INTO conversation (kind, created_by) VALUES ('direct', ?)", [BIG.id]).lastInsertRowid);
  run('INSERT INTO conversation_member (conversation_id, user_id) VALUES (?,?), (?,?)', [id, BIG.id, id, mate.id]);

  const res = await call(MON, 'GET', `/messages/monitor/${id}`);
  const listed = (await call(MON, 'GET', '/messages/monitor')).body.conversations.some((c) => c.id === id);
  assert.equal(res.status, 403, `a Bonanza reviewer opened a Bigul conversation: HTTP ${res.status}`);
  assert(!listed, 'a Bigul conversation is listed to a Bonanza reviewer');
});

await test('a withdrawn message is gone for the other person and kept for the reviewer', async () => {
  const sent = await call(A, 'POST', `/messages/conversations/${AB}/messages`, { body: 'Wrong thread, ignore' });
  const byOther = await call(B, 'POST', `/messages/message/${sent.body.id}/withdraw`);
  assert.equal(byOther.status, 403, 'somebody withdrew a message they did not send');

  const w = await call(A, 'POST', `/messages/message/${sent.body.id}/withdraw`);
  assert.equal(w.status, 200, JSON.stringify(w.body));

  const theirs = (await thread(B, AB)).find((m) => m.id === sent.body.id);
  assert.equal(theirs.body, null, 'the other person can still read a withdrawn message');
  assert.equal(theirs.withdrawn, true);

  const reviewed = (await call(MON, 'GET', `/messages/monitor/${AB}`)).body.messages.find((m) => m.id === sent.body.id);
  assert.equal(reviewed.body, 'Wrong thread, ignore', 'withdrawing a message removed it from the record');
});

await test('a message can only be withdrawn for fifteen minutes', async () => {
  const sent = await call(A, 'POST', `/messages/conversations/${AB}/messages`, { body: 'old news' });
  run("UPDATE message SET created_at = datetime('now', '-20 minutes') WHERE id = ?", [sent.body.id]);
  const w = await call(A, 'POST', `/messages/message/${sent.body.id}/withdraw`);
  assert.equal(w.status, 409, `withdrawn after twenty minutes: HTTP ${w.status}`);
  assert(/15 minutes/.test(w.body.error), w.body.error);
});

/* ------------------------------------------------------------ transfers */

await test('an RM asks the owner for a lead, the owner hands it over, and the supervisor is told', async () => {
  const timelineBefore = one('SELECT COUNT(*) n FROM activities WHERE lead_id = ?', [L_B]).n;

  const asked = await call(A, 'POST', '/messages/transfer', {
    lead_id: L_B, to_user_id: B.id, reason: 'The client rang me directly and wants to stay with me',
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const id = asked.body.approval.id;
  assert.equal(asked.body.conversation_id, AB, 'the request did not land in the conversation the two already have');

  const bQueue = (await call(B, 'GET', '/approvals')).body.waiting_on_me.find((r) => r.id === id);
  assert(bQueue?.can_decide, 'the owner cannot decide a request put to them');
  const cSees = (await call(C, 'GET', '/approvals')).body.waiting_on_me.some((r) => r.id === id);
  assert(!cSees, 'a colleague who was not asked is shown the request');
  /* The case that matters. C holds no approver capability, so C would not be
     shown it anyway; an administrator holding lead.reassign would, if targeted
     requests were queued by capability like every other scope. */
  const monSees = (await call(MON, 'GET', '/approvals')).body.waiting_on_me.some((r) => r.id === id);
  assert(!monSees, 'somebody holding lead.reassign is shown a request that was put to a colleague');

  const byC = await call(C, 'POST', `/approvals/${id}/decide`, { approve: true });
  assert.equal(byC.status, 409, 'decided by somebody not asked, not the owner, and unable to reassign');

  const yes = await call(B, 'POST', `/approvals/${id}/decide`, { approve: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));

  const lead = one('SELECT owner_id, owner_queue_id FROM leads WHERE id = ?', [L_B]);
  assert.equal(lead.owner_id, A.id, 'the lead did not move');

  const h = one(
    "SELECT * FROM field_history WHERE entity = 'lead' AND record_id = ? AND field = 'owner_id' ORDER BY id DESC LIMIT 1",
    [L_B],
  );
  assert(h && Number(h.old_value) === B.id && Number(h.new_value) === A.id && h.actor_id === B.id && h.source === 'approval',
    `the lead's history does not record the move: ${JSON.stringify(h)}`);
  assert.equal(one('SELECT COUNT(*) n FROM activities WHERE lead_id = ?', [L_B]).n, timelineBefore,
    'the transfer was written to the timeline, which Ritesh ruled is for history only');

  assert(one("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Approved: Lead transfer'", [A.id]),
    'the requester was not told');
  assert(one("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Lead handed over:%'", [SUP]),
    'the owner handed it over and their supervisor was not told');

  const card = (await thread(A, AB)).find((m) => m.transfer?.approval_id === id);
  assert.equal(card?.transfer.status, 'Approved', 'the card in the conversation does not show the outcome');
});

await test('the person asked has to be able to say yes', async () => {
  const res = await call(A, 'POST', '/messages/transfer', { lead_id: L_B2, to_user_id: C.id, reason: 'Covering for B' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert(!one("SELECT 1 FROM approvals WHERE entity = 'lead' AND entity_id = ? AND status = 'Pending'", [L_B2]),
    'a request nobody asked could grant was raised anyway');
});

await test('a decline needs a reason, and the requester is told either way', async () => {
  const asked = await call(A, 'POST', '/messages/transfer', { lead_id: L_B2, to_user_id: B.id, reason: 'Same family as my client' });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const id = asked.body.approval.id;

  assert.equal((await call(B, 'POST', `/approvals/${id}/decide`, { approve: false })).status, 409, 'declined without a reason');
  const no = await call(B, 'POST', `/approvals/${id}/decide`, { approve: false, reason: 'Mid-way through KYC with me' });
  assert.equal(no.status, 200, JSON.stringify(no.body));

  assert.equal(one('SELECT owner_id FROM leads WHERE id = ?', [L_B2]).owner_id, B.id, 'a declined transfer moved the lead');
  assert(one(
    "SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Rejected: Lead transfer' AND body = 'Mid-way through KYC with me'",
    [A.id],
  ), 'the requester was not told it was declined, or why');
});

await test('somebody who can reassign may decide it too, and then the owner is told', async () => {
  const asked = await call(A, 'POST', '/messages/transfer', { lead_id: L_B2, to_user_id: B.id, reason: 'Asking again after KYC' });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const res = await call(MON, 'POST', `/approvals/${asked.body.approval.id}/decide`, { approve: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(one('SELECT owner_id FROM leads WHERE id = ?', [L_B2]).owner_id, A.id);
  assert(one("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Lead transferred:%'", [B.id]),
    'the owner lost a lead and was not told');
});

await test('a lead you cannot open cannot be asked for, and the refusal gives nothing away', async () => {
  const real = await call(C, 'POST', '/messages/transfer', { lead_id: L_A, to_user_id: A.id, reason: 'x' });
  const fake = await call(C, 'POST', '/messages/transfer', { lead_id: 99999999, to_user_id: A.id, reason: 'x' });
  assert.equal(real.status, 404, `asked for a lead they cannot open: HTTP ${real.status}`);
  assert.deepEqual(real.body, fake.body, 'a lead that exists is refused differently from one that does not');
});

/* ------------------------------------------ naming a lead you cannot open */

/* Ritesh, 11 September: an RM may name any lead in their book. These hold the
   narrow reading of that -- exact matches, one book, nothing from the record,
   and a request only on a lookup of your own. C can open none of B's leads. */
const lookup = (probe, body) => call(probe, 'POST', '/messages/lookup', body);

await test('an RM can look up a lead by its exact mobile, and learns only who has it', async () => {
  const res = await lookup(C, { mobile: '+91 98000 00054' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.matches.length, 1, `found ${res.body.matches.length}`);

  const m = res.body.matches[0];
  assert.equal(m.lead_id, L_B3);
  assert.equal(m.can_open, false, 'setup: C should not be able to open this lead');
  assert.equal(m.owner?.id, B.id, 'the owner is not named');
  assert(m.grantors.some((g) => g.id === B.id && g.is_owner), 'the owner is not offered as somebody to ask');

  /* The absence that matters: nothing from the client record comes back. */
  assert.deepEqual(Object.keys(m).sort(), ['can_open', 'grantors', 'in_queue', 'lead_id', 'mine', 'owner'],
    `the lookup returned more than who has it: ${Object.keys(m).join(', ')}`);
  /* The lead's own name and email carry "b-three". Not "Msg probe", which the
     supervisor offered as somebody to ask is also called. */
  assert(!JSON.stringify(res.body).includes('b-three'), "a mobile lookup handed back the client's name or email");

  assert(one("SELECT 1 FROM audit_log WHERE user_id = ? AND action = 'lead_lookup' AND entity_id = ?", [C.id, L_B3]),
    'the lookup left no trace');
});

/* Two tests, not one: with both checks in one, the first to fail hides the
   second, and a mutation of the book filter could pass unseen. */
await test('a lookup matches whole names only', async () => {
  const partial = await lookup(C, { name: 'Msg probe b' });
  const whole = await lookup(C, { name: '  msg PROBE   b-three ' });
  assert.equal(partial.body.matches.length, 0, 'part of a name found a lead, which makes this a way to browse');
  assert.equal(whole.body.matches.length, 1, 'the full name, typed loosely, found nothing');
});

await test('a lookup never reaches the other business', async () => {
  const otherBook = await lookup(C, { mobile: '9800000055' });
  assert.equal(otherBook.status, 200, JSON.stringify(otherBook.body));
  assert.equal(otherBook.body.matches.length, 0, 'a Bonanza RM found a Bigul lead');
});

await test('having looked it up, an RM can ask the owner, and the owner can hand it over', async () => {
  const asked = await call(C, 'POST', '/messages/transfer', {
    lead_id: L_B3, to_user_id: B.id, reason: 'She rang me this morning',
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const yes = await call(B, 'POST', `/approvals/${asked.body.approval.id}/decide`, { approve: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  assert.equal(one('SELECT owner_id FROM leads WHERE id = ?', [L_B3]).owner_id, C.id, 'the lead did not move');
});

await test('a lookup lets you ask for a day, not for ever', async () => {
  const found = await lookup(C, { mobile: '9800000051' });
  assert.equal(found.body.matches[0]?.lead_id, L_A, JSON.stringify(found.body));
  run(
    "UPDATE audit_log SET created_at = datetime('now', '-25 hours') WHERE user_id = ? AND action = 'lead_lookup' AND entity_id = ?",
    [C.id, L_A],
  );
  const late = await call(C, 'POST', '/messages/transfer', { lead_id: L_A, to_user_id: A.id, reason: 'x' });
  assert.equal(late.status, 404, `asked on a lookup more than a day old: HTTP ${late.status}`);
});

await test('a transfer cannot be raised through the general approvals route', async () => {
  const res = await call(A, 'POST', '/approvals', {
    scope: 'lead_transfer', entity_id: L_A, payload: { to_user_id: A.id }, reason: 'x',
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

/* ------------------------------------------------------------ plumbing */

await test('reviewing is on the roles screen, and of the shipped roles only admin and superadmin hold it', () => {
  assert(CAPABILITY_CATALOGUE.some((c) => c[0] === 'comms.monitor'), 'comms.monitor cannot be granted on the roles screen');
  /* Shipped roles only. A role an administrator builds may be given it, and
     the end-to-end suite builds one by copying admin -- run this file on its
     own after that suite and the copy is still there. */
  const holders = all(
    `SELECT rc.role_code FROM role_capabilities rc JOIN roles r ON r.code = rc.role_code
      WHERE rc.capability = 'comms.monitor' AND r.is_system = 1 ORDER BY rc.role_code`,
  ).map((r) => r.role_code);
  assert.deepEqual(holders, ['admin', 'superadmin'], `held by: ${holders.join(', ')}`);
});

await test('a conversation that holds messages cannot be deleted', () => {
  /* Rule 3, held by the schema rather than by remembering not to write a
     delete route. */
  assert.throws(() => run('DELETE FROM conversation WHERE id = ?', [AB]), /FOREIGN KEY/i,
    'a conversation was deleted along with its messages');
});

/* Everything this file made, including the accounts it signed in with. The
   seed runs before the unit chain, not after, so anything left here is still
   there when the end-to-end suite runs. */
clean();
restoreCell();
for (const p of [A, B, C, BIG, MON]) p.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
