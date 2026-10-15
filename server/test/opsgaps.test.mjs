/**
 * The gaps found beside Round 4 and recorded open -- OPS-32 to OPS-41 and
 * OPS-43 -- fixed on Ritesh's word of 15 Oct: "Fix all 11 now".
 *
 * Most are the business boundary again: a route that took an id, or listed a
 * table, without asking whose it was. The rest are the record of a case reply
 * taken from the request (OPS-38), a card showing notes its timeline hides
 * (OPS-39), the businesses' details reset at every boot (OPS-33) and
 * attendance counted on the UTC day (OPS-34).
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { runAction, leadFacts } from '../src/engine/rules.js';
import { dayFor, report } from '../src/engine/attendance.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nGaps found beside Round 4 (OPS-32 to OPS-41, OPS-43)');

const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-6);
const MARK = `OG probe ${RUN}`;

const SUPER = await probeAdmin('og-super', { role: 'superadmin' });
const ADMIN = await probeAdmin('og-admin', { role: 'admin', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('og-bigul', { role: 'admin', sales_org: 'BIGUL' });
const BIGUL_RM = await probeAdmin('og-bigul-rm', { role: 'sales_rm', sales_org: 'BIGUL' });
const RM = await probeAdmin('og-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const PSUP = await probeAdmin('og-psup', { role: 'product_supervisor', sales_org: 'BONANZA' });

const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const made = { leads: [], templates: [], campaigns: [], lists: [], tickets: [], content: [], sessions: [], cards: [] };
let seq = 0;
const makeLead = (org, extra = {}) => {
  seq += 1;
  const id = Number(run(
    "INSERT INTO leads (sales_org, name, source, stage, owner_id, mobile, deleted_at) VALUES (?, ?, 'Website', 'New', ?, ?, ?)",
    [org, `${MARK} lead ${seq}`, extra.owner ?? null, `9${DIGITS}${String(seq).padStart(3, '0')}`, extra.deleted ? "2026-10-01 10:00:00" : null],
  ).lastInsertRowid);
  made.leads.push(id);
  return id;
};
const makeTemplate = (org, approved = 1, channel = 'whatsapp') => {
  const id = Number(run(
    'INSERT INTO templates (name, channel, body, approved, sales_org) VALUES (?, ?, ?, ?, ?)',
    [`${MARK} template ${made.templates.length}`, channel, 'Hello {{name}}', approved, org],
  ).lastInsertRowid);
  made.templates.push(id);
  return id;
};
const makeList = (org) => {
  const id = Number(run("INSERT INTO lead_lists (name, kind, sales_org, snapshot_reason) VALUES (?, 'static', ?, 'test')", [`${MARK} list ${made.lists.length}`, org]).lastInsertRowid);
  made.lists.push(id);
  return id;
};

try {
  /* ------------------------------------------------------------ OPS-35 */

  await test('OPS-35: the recycle bin lists only the reader\'s business', async () => {
    const bigulGone = makeLead('BIGUL', { deleted: true });
    const bonanzaGone = makeLead('BONANZA', { deleted: true });
    const ids = (await as(ADMIN)('GET', '/recycle-bin')).body.map((l) => l.id);
    assert(ids.includes(bonanzaGone), 'the Bonanza Admin does not see Bonanza\'s deleted lead');
    assert(!ids.includes(bigulGone), 'the Bonanza Admin was listed a deleted Bigul lead');
  });

  /* ------------------------------------------------------------ OPS-36 */

  await test('OPS-36: a lead is sent only an approved template of its own business and channel', async () => {
    const lead = makeLead('BONANZA', { owner: RM.id });
    const send = (templateId) => as(ADMIN)('POST', `/leads/${lead}/message`, { channel: 'whatsapp', template_id: templateId, intent: 'service' });
    assert.equal((await send(makeTemplate('BONANZA', 0))).status, 409, 'an unapproved template was sent');
    assert.equal((await send(makeTemplate('BIGUL', 1))).status, 409, 'a Bigul template went to a Bonanza lead');
    assert.equal((await send(makeTemplate('BONANZA', 1, 'sms'))).status, 409, 'an SMS template went out as WhatsApp');
    const ok = await send(makeTemplate('BONANZA', 1));
    assert.equal(ok.status, 201, `an approved Bonanza template was refused: ${ok.body?.error}`);
  });

  await test('OPS-36: an automation card skips an unapproved or other-business template, and says why', async () => {
    const lead = makeLead('BONANZA', { owner: RM.id });
    const facts = leadFacts(lead);
    const card = (templateId) => runAction({ type: 'whatsapp', params: { template_id: templateId, intent: 'service' } }, facts, { dryRun: false });
    assert.match(String(card(makeTemplate('BONANZA', 0)).skipped), /not approved/, 'a rule sent an unapproved template');
    assert.match(String(card(makeTemplate('BIGUL', 1)).skipped), /other business/, 'a rule sent the other business\'s template');
    assert.equal(card(makeTemplate('BONANZA', 1)).skipped, undefined, 'a rule skipped an approved template');
  });

  /* ------------------------------------------------------------ OPS-37 */

  await test('OPS-37: every campaign route by id asks the campaign\'s business', async () => {
    const list = makeList('BONANZA');
    const template = makeTemplate('BONANZA', 1);
    const id = Number(run(
      "INSERT INTO campaigns (name, channel, template_id, list_id, status, created_by, sales_org, scheduled_at) VALUES (?, 'whatsapp', ?, ?, 'Scheduled', ?, 'BONANZA', '2027-01-01 10:00:00')",
      [`${MARK} campaign`, template, list, ADMIN.id],
    ).lastInsertRowid);
    made.campaigns.push(id);
    const bigul = as(BIGUL);
    for (const [method, url, body] of [
      ['GET', `/admin/campaigns/${id}/audience`],
      ['PATCH', `/admin/campaigns/${id}`, { name: 'renamed by the other business' }],
      ['POST', `/admin/campaigns/${id}/pause`, {}],
      ['POST', `/admin/campaigns/${id}/resume`, {}],
      ['POST', `/admin/campaigns/${id}/test`, {}],
      ['POST', `/admin/campaigns/${id}/send`, {}],
      ['POST', `/admin/campaigns/${id}/duplicate`, {}],
      ['DELETE', `/admin/campaigns/${id}`],
    ]) {
      const r = await bigul(method, url, body);
      assert.equal(r.status, 403, `a Bigul Admin's ${method} ${url} answered ${r.status}`);
    }
    assert.equal(one('SELECT name FROM campaigns WHERE id = ?', [id]).name, `${MARK} campaign`, 'the campaign was renamed');

    const repoint = await as(ADMIN)('PATCH', `/admin/campaigns/${id}`, { list_id: makeList('BIGUL') });
    assert.equal(repoint.status, 403, 'a Bonanza campaign was pointed at a Bigul list');

    run("UPDATE campaigns SET status = 'Archived' WHERE id = ?", [id]);
    const archived = (await bigul('GET', '/admin/campaigns/archived')).body.map((c) => c.id);
    assert(!archived.includes(id), 'Bonanza\'s archived campaign was listed to Bigul');
    assert((await as(ADMIN)('GET', '/admin/campaigns/archived')).body.some((c) => c.id === id), 'Bonanza cannot see its own archived campaign');
  });

  /* ------------------------------------------------------------ OPS-38 */

  await test('OPS-38: a reply from the CRM is the agent\'s, whatever the request says', async () => {
    const lead = makeLead('BONANZA', { owner: RM.id });
    const ticket = Number(run(
      `INSERT INTO tickets (ref, subject, description, priority, status, lead_id, assignee_id, sales_org)
       VALUES (?, ?, 'Where is my refund', 'Medium', 'Open', ?, ?, 'BONANZA')`,
      [`OG-${RUN}`, `${MARK} case`, lead, ADMIN.id],
    ).lastInsertRowid);
    made.tickets.push(ticket);
    const r = await as(ADMIN)('POST', `/tickets/${ticket}/replies`, { body: 'Refund leaves on Friday', author_type: 'client' });
    assert.equal(r.status, 201, r.body?.error);
    assert.equal(one('SELECT author_type FROM ticket_replies WHERE ticket_id = ? ORDER BY id DESC LIMIT 1', [ticket]).author_type, 'agent',
      'the reply was recorded as the client\'s');
  });

  /* ------------------------------------------------------------ OPS-39 */

  await test('OPS-39: a card hides the notes its lead\'s timeline hides', async () => {
    const lead = makeLead('BONANZA', { owner: RM.id });
    const product = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 ORDER BY id LIMIT 1");
    const cardId = Number(run("INSERT INTO product_cards (lead_id, product_type_id, state) VALUES (?, ?, 'EXPLORING')", [lead, product.id]).lastInsertRowid);
    made.cards.push(cardId);
    const act = Number(run(
      "INSERT INTO activities (lead_id, card_id, type, direction, body, user_id) VALUES (?, ?, 'Call', 'outbound', 'Client mentioned a family matter', ?)",
      [lead, cardId, RM.id],
    ).lastInsertRowid);
    const timeline = (await as(ADMIN)('GET', `/leads/${lead}`)).body.activities.find((a) => a.id === act);
    const onCard = (await as(ADMIN)('GET', `/cards/${cardId}/detail`)).body.activities.find((a) => a.id === act);
    assert(timeline && onCard, 'the activity is missing from the timeline or the card');
    assert.deepEqual(onCard._restricted ?? [], timeline._restricted ?? [], 'the card and the timeline disagree on what is hidden');
    assert.equal(onCard.body, timeline.body, 'the card shows notes the timeline hides');
  });

  /* ------------------------------------------------------------ OPS-40 */

  await test('OPS-40: content is listed and written within the reader\'s business', async () => {
    const listed = (await as(BIGUL_RM)('GET', '/admin/content')).body;
    assert(!listed.some((c) => c.sales_org === 'BONANZA'), 'a Bigul RM was listed Bonanza content');

    const mine = await as(ADMIN)('POST', '/admin/content', { name: `${MARK} brochure`, type: 'PDF', url: 'https://example.test/b.pdf' });
    assert.equal(mine.status, 201, mine.body?.error);
    made.content.push(mine.body.id);
    assert.equal(one('SELECT sales_org FROM content_items WHERE id = ?', [mine.body.id]).sales_org, 'BONANZA');

    const bonanzaProduct = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1");
    const across = await as(BIGUL)('POST', '/admin/content', { name: `${MARK} across`, product_type_id: bonanzaProduct.id });
    assert.equal(across.status, 400, 'Bigul filed content against a Bonanza product');
    const other = await as(BIGUL)('POST', '/admin/content', { name: `${MARK} into bonanza`, sales_org: 'BONANZA' });
    assert.equal(other.status, 403, 'Bigul wrote content into Bonanza');
  });

  /* ------------------------------------------------------------ OPS-41 */

  await test('OPS-41: KYC journeys are listed and changed within the product\'s business', async () => {
    const listing = (await as(BIGUL)('GET', '/admin/kyc/journeys')).body;
    assert(listing.journeys.length > 0, 'Bigul is listed none of its own journeys');
    assert(listing.journeys.every((j) => j.product.sales_org === 'BIGUL'), 'a Bigul Admin was listed Bonanza\'s KYC products');
    const bonanza = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND requires_kyc = 1 AND active = 1 ORDER BY id LIMIT 1");
    const steps = all('SELECT step_code FROM kyc_journey_steps WHERE product_type_id = ? ORDER BY sort_order', [bonanza.id]);
    const changed = await as(BIGUL)('POST', `/admin/kyc/journeys/${bonanza.id}`, { steps: steps.slice(1), reason: 'From the other business' });
    assert.equal(changed.status, 403, `a Bigul Admin changed a Bonanza journey: ${changed.status}`);
  });

  /* ------------------------------------------------------------ OPS-43 */

  await test('OPS-43: an Admin changes their own business\'s switches; a Superadmin the shared ones', async () => {
    const KEY = 'nomination_reminders.BONANZA';
    const SHARED = 'lead_won_requires_account';
    const before = all('SELECT * FROM business_policy WHERE key IN (?, ?)', [KEY, SHARED]);
    try {
      const bigulSees = (await as(BIGUL)('GET', '/setup/policies')).body.policies;
      assert(!bigulSees.some((p) => p.key.endsWith('.BONANZA')), 'a Bigul Admin was listed Bonanza\'s switches');
      assert.equal((await as(BIGUL)('PUT', `/setup/policies/${KEY}`, { value: true })).status, 403, 'a Bigul Admin switched Bonanza\'s reminders');
      assert.equal((await as(ADMIN)('PUT', `/setup/policies/${KEY}`, { value: false })).status, 200, 'a Bonanza Admin could not change Bonanza\'s own switch');

      const shared = bigulSees.find((p) => p.key === SHARED);
      assert.equal(shared?.may_change, false, 'an Admin is offered a policy covering both businesses');
      assert.equal((await as(ADMIN)('PUT', `/setup/policies/${SHARED}`, { value: false })).status, 403, 'an Admin changed a policy covering both businesses');
      assert.equal((await as(SUPER)('PUT', `/setup/policies/${SHARED}`, { value: false })).status, 200, 'a Superadmin could not change it');
    } finally {
      run('DELETE FROM business_policy WHERE key IN (?, ?)', [KEY, SHARED]);
      for (const r of before) run('INSERT INTO business_policy (key, value, updated_by, updated_at) VALUES (?,?,?,?)', [r.key, r.value, r.updated_by, r.updated_at]);
    }
  });

  /* ------------------------------------------------------------ OPS-32 */

  await test('OPS-32: the Product Supervisor\'s cockpit counts its own business', async () => {
    const cockpit = (await as(PSUP)('GET', '/cockpit')).body;
    const value = (label) => cockpit.metrics.find((m) => m.label === label)?.value;
    const count = (where) => one(
      `SELECT COUNT(*) n FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id WHERE pt.sales_org = 'BONANZA' AND ${where}`,
    ).n;
    assert.equal(value('Cards total'), count('1=1'), 'Cards total counted the other business');
    assert.equal(value('Cards closed Active'), count("pc.state = 'ACTIVE'"), 'Cards closed Active counted the other business');
    const bigulRms = new Set(all("SELECT id FROM users WHERE role = 'product_rm' AND sales_org = 'BIGUL'").map((u) => u.id));
    const scorecard = cockpit.worklist.secondary.rows;
    assert(!scorecard.some((r) => bigulRms.has(r.id)), 'the scorecard lists Bigul\'s Product RMs');
  });

  /* ------------------------------------------------------------ OPS-33 */

  await test('OPS-33: a Superadmin\'s change to a business survives a restart', async () => {
    const before = one("SELECT tagline FROM sales_orgs WHERE code = 'BIGUL'").tagline;
    const changed = `${MARK} tagline`;
    try {
      const r = await as(SUPER)('PATCH', '/orgs/BIGUL', { tagline: changed });
      assert.equal(r.status, 200, r.body?.error);
      // A boot: the schema and seed module run in a process of their own.
      execFileSync(process.execPath, ['-e', "await import('./src/db.js')"], { cwd: SERVER, env: process.env, stdio: 'ignore' });
      assert.equal(one("SELECT tagline FROM sales_orgs WHERE code = 'BIGUL'").tagline, changed, 'the restart put the seed\'s tagline back');
    } finally {
      run("UPDATE sales_orgs SET tagline = ? WHERE code = 'BIGUL'", [before]);
    }
  });

  /* ------------------------------------------------------------ OPS-34 */

  await test('OPS-34: attendance counts the India day', () => {
    // 01:00 IST on 15 Oct is 19:30 UTC on 14 Oct.
    const id = Number(run(
      "INSERT INTO attendance_session (user_id, sales_org, checked_in_at, checked_out_at, source) VALUES (?, 'BONANZA', '2026-10-14 19:30:00', '2026-10-14 21:30:00', 'web')",
      [RM.id],
    ).lastInsertRowid);
    made.sessions.push(id);
    assert(dayFor(RM.id, '2026-10-15').intervals.some((i) => i.id === id), 'a 01:00 IST check-in is not on its India day');
    assert(!dayFor(RM.id, '2026-10-14').intervals.some((i) => i.id === id), 'a 01:00 IST check-in counted on the day before');
    const rows = report({ reach: 'u.id = ?', params: [RM.id], from: '2026-10-15', to: '2026-10-15' });
    assert.equal(rows.length, 1, 'the report does not put it on 15 Oct');
    assert.equal(rows[0].day, '2026-10-15');
  });
} finally {
  run('DELETE FROM attendance_session WHERE user_id = ?', [RM.id]);
  for (const id of made.content) run('DELETE FROM content_items WHERE id = ?', [id]);
  run('DELETE FROM content_items WHERE name LIKE ?', [`${MARK}%`]);
  for (const id of made.tickets) { run('DELETE FROM ticket_replies WHERE ticket_id = ?', [id]); run('DELETE FROM tickets WHERE id = ?', [id]); }
  for (const id of made.campaigns) run('DELETE FROM campaigns WHERE id = ?', [id]);
  run('DELETE FROM campaigns WHERE name LIKE ?', [`${MARK}%`]);
  for (const id of made.lists) run('DELETE FROM lead_lists WHERE id = ?', [id]);
  for (const id of made.leads) {
    run('DELETE FROM activities WHERE lead_id = ?', [id]);
    run('DELETE FROM product_cards WHERE lead_id = ?', [id]);
    run('DELETE FROM leads WHERE id = ?', [id]);
  }
  for (const id of made.templates) run('DELETE FROM templates WHERE id = ?', [id]);
  for (const p of [SUPER, ADMIN, BIGUL, BIGUL_RM, RM, PSUP]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
