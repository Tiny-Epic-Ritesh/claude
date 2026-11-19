/**
 * A4 (QA-10; ruled 19 Nov, OPS-74): every call saves the same way.
 *
 * A call drafted by the AI used to be saved by /ai/disposition/confirm as an
 * "AI Call Summary": an activity no call count, scorecard or last-contacted
 * date reads, with an outcome from the AI's own list of seven rather than one
 * of Setup's. It also moved product cards with a bare UPDATE, wrote a task
 * outside the follow-up rules, and set the lead's callback time itself.
 *
 * Now the draft names one of Setup's call outcomes; the call is saved through
 * POST /activities like any other; and the confirm only marks that call as
 * drafted, moves the cards the person kept through the card panel's own move,
 * and opens a compliance case when one is flagged.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const RM = await probeAdmin('callsave-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const call = async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: RM.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const stamp = String(Date.now()).slice(-7);
const MARK = `Callsave ${stamp}`;
const lead = Number(run(
  "INSERT INTO leads (sales_org, name, mobile, source, stage, owner_id) VALUES ('BONANZA', ?, ?, 'Website', 'Contacted', ?)",
  [MARK, `97${stamp}2`.slice(0, 10), RM.id],
).lastInsertRowid);
const productId = one("SELECT id FROM product_types WHERE code = 'MF' AND sales_org = 'BONANZA'").id;
const card = Number(run(
  "INSERT INTO product_cards (lead_id, product_type_id, state, last_state_at) VALUES (?,?, 'INACTIVE', datetime('now', '-2 days'))",
  [lead, productId],
).lastInsertRowid);
const counts = () => ({
  calls: one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND type = 'Call'", [lead]).n,
  summaries: one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND type = 'AI Call Summary'", [lead]).n,
  tasks: one('SELECT COUNT(*) n FROM tasks WHERE lead_id = ?', [lead]).n,
  callback: one('SELECT callback_at FROM leads WHERE id = ?', [lead]).callback_at,
  state: one('SELECT state FROM product_cards WHERE id = ?', [card]).state,
});

console.log('\nA4: every call saves the same way (OPS-74)');

try {
  let draft;

  await test('the AI drafts one of Setup\'s call outcomes, with the date it needs', async () => {
    const res = await call('POST', '/ai/disposition', {
      lead_id: lead, duration_s: 180,
      transcript: 'She wants a mutual fund SIP of 5000 a month. Call me back tomorrow, she said, after 11.',
    });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    draft = res.body;
    const d = one('SELECT * FROM dispositions WHERE code = ? AND active = 1', [draft.disposition ?? '']);
    assert.ok(d, `the draft's outcome "${draft.disposition}" is not one of Setup's (it said "${draft.outcome}")`);
    assert.equal(d.activity_type, 'Call');
    if (d.requires_datetime) assert.match(String(draft.follow_up_at ?? draft.meeting_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d$/, 'no date for an outcome that needs one');
    const change = (draft.card_changes ?? []).find((c) => c.product_code === 'MF');
    assert.equal(change?.card_id, card, 'a proposed product change does not name its card');
  });

  await test('a draft cannot be confirmed without its call, and nothing is written', async () => {
    const before = counts();
    const res = await call('POST', '/ai/disposition/confirm', {
      lead_id: lead, outcome: draft.outcome, summary: draft.summary, next_action: 'Callback', next_action_due_hours: 4,
      follow_up_task: `${MARK} task`, card_changes: draft.card_changes, compliance_flag: 'None',
    });
    assert.equal(res.status, 400, `confirmed with no call saved (HTTP ${res.status})`);
    assert.deepEqual(counts(), before, 'something was written anyway');
  });

  await test('the call is saved as a Call with Setup\'s outcome, and the confirm marks it drafted', async () => {
    const saved = await call('POST', '/activities', {
      lead_id: lead, type: 'Call', disposition: draft.disposition, body: draft.summary, duration_s: 180, card_id: card,
      ...(draft.follow_up_at ? { follow_up_at: draft.follow_up_at.replace('T', ' ') } : {}),
      ...(draft.meeting_at ? { meeting_at: draft.meeting_at.replace('T', ' '), meeting_mode: 'Phone' } : {}),
    });
    assert.equal(saved.status, 201, `the call answered ${saved.status}: ${saved.body?.error}`);
    const before = counts();
    const res = await call('POST', '/ai/disposition/confirm', {
      lead_id: lead, activity_id: saved.body.activity.id, summary: draft.summary,
      card_changes: (draft.card_changes ?? []).filter((c) => c.card_id === card),
      next_action: 'Callback', next_action_due_hours: 4, follow_up_task: `${MARK} task`, compliance_flag: 'None',
    });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    assert.equal(one('SELECT ai_generated FROM activities WHERE id = ?', [saved.body.activity.id]).ai_generated, 1, 'the call is not marked as drafted by the AI');
    const after = counts();
    assert.equal(after.summaries, 0, 'an "AI Call Summary" was written');
    assert.equal(after.calls, before.calls, 'the confirm logged a call of its own');
    assert.equal(after.tasks, before.tasks, 'the confirm wrote a task outside the follow-up rules');
    assert.equal(after.callback, before.callback, 'the confirm set the lead\'s callback time itself');
    assert.equal(one('SELECT COUNT(*) n FROM tasks WHERE lead_id = ? AND title = ?', [lead, `${MARK} task`]).n, 0);
  });

  await test('a product the draft moves is moved by the card panel\'s own move, and says so', async () => {
    const res = await call('POST', '/ai/disposition/confirm', {
      lead_id: lead,
      activity_id: one("SELECT id FROM activities WHERE lead_id = ? AND type = 'Call' ORDER BY id DESC LIMIT 1", [lead]).id,
      card_changes: [{ card_id: card, product_code: 'MF', to_state: 'WARM', evidence: `${MARK} go-ahead` }],
      compliance_flag: 'None',
    });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    assert.equal(counts().state, 'WARM');
    const moved = res.body.cards_updated?.[0];
    assert.ok(moved?.effects?.some((e) => /moved from .* to Warm/.test(e)), `no account of the move: ${JSON.stringify(moved)}`);
    assert.ok(one("SELECT id FROM activities WHERE lead_id = ? AND card_id = ? AND type = 'Note' AND subject LIKE ?", [lead, card, '%→ WARM']),
      'the move left nothing on the timeline, as the card panel\'s does');
  });
} finally {
  const cards = all('SELECT id FROM product_cards WHERE lead_id = ?', [lead]).map((r) => r.id);
  for (const id of cards) run("DELETE FROM field_history WHERE entity = 'product_interest' AND record_id = ?", [id]);
  run("DELETE FROM field_history WHERE entity = 'lead' AND record_id = ?", [lead]);
  run('DELETE FROM leads WHERE id = ?', [lead]);
  RM.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
