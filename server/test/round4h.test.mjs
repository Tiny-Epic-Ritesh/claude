/**
 * Ritesh's Part 4, items 7 and 8 (16 Oct 2026).
 *
 *   7    a salesperson's new lead is theirs: their name shown, no other owner
 *        offered, and none given -- by the form or the router
 *   8.1  a product card shows where it is on the road and every move from
 *        there, with what each means and sets off
 *   8.2  Request Product RM says who is asked and how, and carries a handover
 *        both sides see, with a way to talk
 *   8.3  what the request set off is said back
 *   8.4  a move says what it did
 *   N-12 the request is held to the reader's book and scope (ruled 16 Oct)
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...rel) => fs.readFileSync(path.join(HERE, '..', '..', 'client', 'src', ...rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nPart 4, items 7 and 8: lead ownership, product moves, the Product RM handover');

const RUN = Date.now().toString(36);
const MARK = `R4H probe ${RUN}`;
const call = async (who, method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json', ...(who?.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const RM = await probeAdmin('r4h-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const OTHER_RM = await probeAdmin('r4h-rm2', { role: 'sales_rm', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('r4h-bigul', { role: 'admin', sales_org: 'BIGUL' });
const PRM = await probeAdmin('r4h-prm', { role: 'product_rm', sales_org: 'BONANZA' });
const probes = [RM, OTHER_RM, BIGUL, PRM];
const leads = [];

/* A lead of the RM's own, with a Warm card on a product that has a Product RM. */
const mobile = () => `9${String(Date.now() + leads.length).slice(-9)}`;
async function ownLead() {
  const made = await call(RM, 'POST', '/leads', { name: `${MARK} ${leads.length}`, mobile: mobile(), source: 'Manual', route: false });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  leads.push(made.body.id);
  const card = one(
    `SELECT pc.id, pc.product_type_id, pt.name FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
      WHERE pc.lead_id = ? AND EXISTS (SELECT 1 FROM users u WHERE u.role = 'product_rm' AND u.active = 1
        AND u.product_type_id = pt.id AND u.sales_org = 'BONANZA' AND u.id != ?)
      ORDER BY pc.id LIMIT 1`,
    [made.body.id, PRM.id],
  );
  assert(card, 'no product with a Product RM');
  run("UPDATE product_cards SET state = 'WARM' WHERE id = ?", [card.id]);
  return { lead: made.body.id, card };
}

try {
  await test('Item 7: what the New lead form sends leaves the lead with the Sales RM, and no other owner is accepted', async () => {
    /* The form's own call: no owner (the person themselves) and route: false.
       An inbound lead arriving through the API with no owner is still routed,
       as QA-01 recorded (round4.test.mjs). */
    const form = read('crm', 'Leads.jsx');
    const sent = form.slice(form.indexOf('function NewLead(')).match(/api\.post\('\/leads',[^\n]*\)/)?.[0] ?? '';
    assert(/owner_id: form\.owner_id \|\| undefined/.test(sent) && /route:\s*false/.test(sent), `the form sends ${sent || 'nothing found'}`);
    const r = await call(RM, 'POST', '/leads', { name: `${MARK} mine`, mobile: mobile(), source: 'Website', route: false });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    leads.push(r.body.id);
    assert.equal(one('SELECT owner_id FROM leads WHERE id = ?', [r.body.id]).owner_id, RM.id, 'the lead went to somebody else');
    const other = await call(RM, 'POST', '/leads', { name: `${MARK} given`, mobile: mobile(), owner_id: OTHER_RM.id, route: false });
    assert.equal(other.status, 403, 'a Sales RM created a lead for somebody else');
  });

  await test('Item 7: the form shows the person\'s own name and offers nobody else (source check)', async () => {
    const leadsJsx = read('crm', 'Leads.jsx');
    assert(/<option value="">\{me \? `\$\{me\} \(you\)` : 'Assign to me'\}<\/option>/.test(leadsJsx), 'the owner field does not name the person');
    assert(/me=\{session\.name\}/.test(leadsJsx), 'the form is not given the person\'s name');
    assert(/function NewLead\(\{ meta, me,/.test(leadsJsx), 'the form does not take the name it is given');
    assert(/disabled=\{!mayReassign\}/.test(leadsJsx), 'the owner field is not locked');
  });

  await test('Item 8.1: the card says where it is on the road, and what every move means', async () => {
    const { card } = await ownLead();
    const { status, body } = await call(RM, 'GET', `/cards/${card.id}/detail`);
    assert.equal(status, 200);
    assert.deepEqual(body.next.path?.map((p) => p.code), ['EXPLORING', 'WARM', 'PRODUCT_RM_ENGAGED', 'KYC_IN_PROGRESS', 'ACTIVE'], 'no road');
    assert.deepEqual(body.next.alternatives.map((a) => a.to), ['PRODUCT_RM_ENGAGED', 'KYC_IN_PROGRESS', 'ON_HOLD', 'LOST'], 'the moves are not the state machine\'s');
    const silent = body.next.alternatives.filter((a) => !a.means);
    assert.deepEqual(silent.map((a) => a.to), [], 'moves that do not say what they mean');
  });

  await test('Items 8.1 and 8.4: a move says what it did', async () => {
    const { card } = await ownLead();
    run("UPDATE product_cards SET state = 'EXPLORING' WHERE id = ?", [card.id]);
    const { status, body } = await call(RM, 'POST', `/cards/${card.id}/state`, { state: 'WARM', note: 'probe' });
    assert.equal(status, 200);
    const said = (body.effects ?? []).join(' | ');
    assert.match(said, /moved from Exploring to Warm/, said || 'nothing said');
    assert.match(said, /Told, for awareness only: |nobody was told/, said);
  });

  await test('Item 8.2: the request says who is asked and how, and drafts the handover', async () => {
    const { card } = await ownLead();
    const rms = all("SELECT name FROM users WHERE role = 'product_rm' AND active = 1 AND product_type_id = ? AND sales_org = 'BONANZA' ORDER BY name", [card.product_type_id]).map((r) => r.name);
    const before = one('SELECT COUNT(*) n FROM tasks WHERE card_id = ?', [card.id]).n;
    const { status, body } = await call(RM, 'GET', `/cards/${card.id}/product-rm-request`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.asked.map((a) => a.name), rms);
    assert.match(body.how, /Every active Product RM for/);
    assert(body.each_gets.some((e) => /High-priority task/.test(e)), 'does not say a task is created');
    assert.match(body.draft.status_summary, /Warm/);
    assert(typeof body.draft.conversations === 'string');
    assert.equal(one('SELECT COUNT(*) n FROM tasks WHERE card_id = ?', [card.id]).n, before, 'opening the dialog created a task');
  });

  await test('Items 8.2 and 8.3: the handover goes into each task and stays on the product; the answer says what was set off', async () => {
    const { card } = await ownLead();
    const needs = `${MARK}: wants a SIP of 10,000 a month, worried about lock-in`;
    const missing = await call(RM, 'POST', `/cards/${card.id}/request-product-rm`, { handover: { needs_to_know: ' ' } });
    assert.equal(missing.status, 400, 'a request with nothing for the Product RM was sent');
    const r = await call(RM, 'POST', `/cards/${card.id}/request-product-rm`, {
      handover: { needs_to_know: needs, status_summary: 'Warm for 2 days', conversations: 'Called twice' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert(r.body.task_due_at, 'does not say when the task is due');
    assert(r.body.product_rms.length >= 1);
    const tasks = all('SELECT assignee_id, description FROM tasks WHERE card_id = ? AND created_by = ?', [card.id, RM.id]);
    assert.equal(tasks.length, r.body.product_rms.length, 'not one task each');
    assert(tasks.every((t) => t.description?.includes(needs)), 'a task without the handover');
    const detail = await call(RM, 'GET', `/cards/${card.id}/detail`);
    assert.equal(detail.body.rm_requests?.[0]?.needs_to_know, needs, 'the handover is not on the product');
    assert.equal(detail.body.rm_requests[0].requested_by, RM.id);
    assert.equal(one("SELECT COUNT(*) n FROM activities WHERE lead_id = (SELECT lead_id FROM product_cards WHERE id = ?) AND body LIKE ?", [card.id, `%${MARK}: wants%`]).n, 0,
      'the handover was written onto the client\'s timeline');
  });

  await test('N-12: the other business, and a colleague without sight of the lead, cannot ask', async () => {
    const { card } = await ownLead();
    const before = one('SELECT COUNT(*) n FROM tasks WHERE card_id = ?', [card.id]).n;
    const notes = one('SELECT COUNT(*) n FROM notifications').n;
    for (const who of [BIGUL, OTHER_RM]) {
      // eslint-disable-next-line no-await-in-loop
      const asked = await call(who, 'POST', `/cards/${card.id}/request-product-rm`, { reason: 'probe across the boundary' });
      assert([403, 404].includes(asked.status), `${who === BIGUL ? 'a Bigul Admin' : 'another Sales RM'} asked: ${asked.status} ${JSON.stringify(asked.body)}`);
      assert(!asked.body?.product_rms, 'and was told who the Product RMs are');
      // eslint-disable-next-line no-await-in-loop
      const peek = await call(who, 'GET', `/cards/${card.id}/product-rm-request`);
      assert([403, 404].includes(peek.status), 'and could read who would be asked');
    }
    assert.equal(one('SELECT COUNT(*) n FROM tasks WHERE card_id = ?', [card.id]).n, before, 'a task was created');
    assert.equal(one('SELECT COUNT(*) n FROM notifications').n, notes, 'somebody was notified');
  });

  await test('Item 8.2: a Product RM who takes a card on becomes its Product RM', async () => {
    const { card } = await ownLead();
    run('UPDATE users SET product_type_id = ? WHERE id = ?', [card.product_type_id, PRM.id]);
    const r = await call(PRM, 'POST', `/cards/${card.id}/state`, { state: 'PRODUCT_RM_ENGAGED' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(one('SELECT product_rm_id FROM product_cards WHERE id = ?', [card.id]).product_rm_id, PRM.id, 'the card has no Product RM');
  });

  await test('Item 8 on the page: the road, every move, the handover dialog, from the panel and the lead header (source check)', async () => {
    const panel = read('crm', 'ProductPanel.jsx');
    assert(/className="stage-track"/.test(panel), 'no road');
    assert(/Every move from/.test(panel) && !/showMoves/.test(panel), 'the moves are still behind a button');
    assert(/case 'rm': return setAsking\(true\);/.test(panel), 'Request Product RM still asks at once');
    assert(/Message \{p\.name\}/.test(panel), 'no way to message the people on a handover');
    assert(/<Outcome /.test(panel), 'a move does not say what it did');
    const actions = read('crm', 'leadActions.jsx');
    const fn = actions.slice(actions.indexOf('async function nextStep'));
    assert(!/request-product-rm`, \{\}\)/.test(fn) && /kind: 'product_rm'/.test(fn), 'the lead header still asks with no handover');
  });
} finally {
  for (const id of leads) run('DELETE FROM leads WHERE id = ?', [id]);
  run('DELETE FROM leads WHERE name LIKE ?', [`${MARK}%`]);
  for (const p of probes) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
