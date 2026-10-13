/**
 * The defects found beside the Round 4 fixes, OPS-18 to OPS-24.
 *
 *   OPS-18  the AI disposition confirm wrote to a lead in either business
 *   OPS-19  a new lead could be handed to someone else without lead.reassign
 *   OPS-20  product create dropped the brochure and apply links
 *   OPS-21  a campaign could send the other business's template
 *   OPS-22  a campaign's copy was filed in Bonanza's book whatever it was
 *   OPS-23  a list bulk send wrote two timeline entries per lead
 *   OPS-24  day windows started at 05:30 IST, because stored times are UTC
 *
 * The OPS-24 tests are built from IST today and bite whatever the hour: two
 * records are planted, one at 00:30 IST today and one at 22:30 IST yesterday.
 * Read as UTC days, either both land on the same day or neither does; read as
 * IST days, exactly the first is today's.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { resolveRange, inRange } from '../src/engine/daterange.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nRound 4 adjacent defects (OPS-18 to OPS-24)');

const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-6);
const MARK = `R4A probe ${RUN}`;

const sweep = () => {
  run("DELETE FROM leads WHERE name LIKE 'R4A probe %'");
  run("DELETE FROM tickets WHERE subject LIKE 'R4A probe %'");
  run("DELETE FROM campaigns WHERE name LIKE 'R4A probe %'");
  run("DELETE FROM templates WHERE name LIKE 'R4A probe %'");
  run("DELETE FROM lead_lists WHERE name LIKE 'R4A probe %'");
  for (const p of all("SELECT id FROM product_types WHERE name LIKE 'R4A probe %'")) {
    run('DELETE FROM product_cards WHERE product_type_id = ?', [p.id]);
    run('DELETE FROM product_types WHERE id = ?', [p.id]);
  }
};
sweep();

const SUPER = await probeAdmin('r4adj-super', { role: 'superadmin' });
const ADMIN = await probeAdmin('r4adj-admin', { role: 'admin', sales_org: 'BONANZA' });
const RM = await probeAdmin('r4adj-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const RM2 = await probeAdmin('r4adj-rm2', { role: 'sales_rm', sales_org: 'BONANZA' });

const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const superCall = as(SUPER);
const adminCall = as(ADMIN);
const rmCall = as(RM);

let seq = 0;
const mobile = () => { seq += 1; return `8${DIGITS}${String(seq).padStart(3, '0')}`; };
const seedLead = (org, suffix, extra = {}) => Number(run(
  `INSERT INTO leads (sales_org, name, source, stage, mobile, created_at)
   VALUES (?, ?, 'Import', 'New', ?, COALESCE(?, datetime('now')))`,
  [org, `${MARK} ${suffix}`, extra.mobile ?? mobile(), extra.created_at ?? null],
).lastInsertRowid);
const seedTemplate = (org, suffix) => Number(run(
  "INSERT INTO templates (name, channel, body, approved, sales_org) VALUES (?, 'whatsapp', 'Hi {{name}}', 1, ?)",
  [`${MARK} ${suffix}`, org],
).lastInsertRowid);
const seedList = (org, suffix, owner) => Number(run(
  "INSERT INTO lead_lists (name, kind, owner_id, sales_org) VALUES (?, 'static', ?, ?)",
  [`${MARK} ${suffix}`, owner, org],
).lastInsertRowid);

/* IST today, and the two instants either side of where a UTC reading puts the
   day's start: 00:30 IST today and 22:30 IST yesterday, both written as the
   database writes timestamps. */
const IST_TODAY = one("SELECT date('now', '+330 minutes') d").d;
const EARLY_TODAY = one("SELECT datetime(date('now', '+330 minutes'), '-1 day', '+19 hours') t").t;
const LATE_YESTERDAY = one("SELECT datetime(date('now', '+330 minutes'), '-1 day', '+17 hours') t").t;

try {
  /* ============================================================ OPS-18 */

  await test('OPS-18 a disposition cannot be confirmed on the other business\'s lead', async () => {
    const lead = seedLead('BIGUL', 'bigul disposition');
    const res = await adminCall('POST', '/ai/disposition/confirm', {
      lead_id: lead, outcome: 'Connected', summary: `${MARK} summary`, score_signal: 5,
      compliance_flag: 'Complaint', compliance_note: `${MARK} complaint`,
    });
    assert.equal(res.status, 403, `a Bonanza admin dispositioned a Bigul lead (${res.status})`);
    assert.equal(one('SELECT COUNT(*) n FROM activities WHERE lead_id = ?', [lead]).n, 0, 'an activity was written anyway');
    assert.equal(one('SELECT COUNT(*) n FROM tickets WHERE lead_id = ?', [lead]).n, 0, 'a case was raised anyway');
  });

  await test('OPS-18 a disposition on a lead in the caller\'s own business still saves', async () => {
    const lead = seedLead('BONANZA', 'own disposition');
    const res = await adminCall('POST', '/ai/disposition/confirm', { lead_id: lead, outcome: 'Connected', summary: `${MARK} summary` });
    assert.equal(res.status, 200, `answered ${res.status}: ${res.body?.error}`);
    assert.equal(one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND type = 'AI Call Summary'", [lead]).n, 1);
  });

  /* ============================================================ OPS-19 */

  await test('OPS-19 a Sales RM cannot create a lead owned by someone else', async () => {
    const res = await rmCall('POST', '/leads', { name: `${MARK} for rm2`, mobile: mobile(), source: 'Website', owner_id: RM2.id, route: false });
    assert.equal(res.status, 403, `the lead was created for a colleague (${res.status})`);
    assert.equal(res.body.required, 'lead.reassign');
    assert.equal(one('SELECT COUNT(*) n FROM leads WHERE name = ?', [`${MARK} for rm2`]).n, 0);
  });

  await test('OPS-19 naming yourself, or being able to reassign, still creates the lead', async () => {
    const mine = await rmCall('POST', '/leads', { name: `${MARK} for me`, mobile: mobile(), source: 'Website', owner_id: RM.id, route: false });
    assert.equal(mine.status, 201, `answered ${mine.status}: ${mine.body?.error}`);
    assert.equal(mine.body.owner_id, RM.id);
    const given = await adminCall('POST', '/leads', { name: `${MARK} by admin`, mobile: mobile(), source: 'Website', owner_id: RM2.id, route: false });
    assert.equal(given.status, 201, `answered ${given.status}: ${given.body?.error}`);
    assert.equal(given.body.owner_id, RM2.id);
  });

  await test('OPS-19 the New lead form offers other owners only to those who may reassign (source check)', async () => {
    const src = fs.readFileSync(path.join(HERE, '..', '..', 'client', 'src', 'crm', 'Leads.jsx'), 'utf8');
    assert(/mayReassign=\{session\.permissions\.includes\('lead\.reassign'\)\}/.test(src), 'the form is not told whether it may reassign');
    assert(/\{mayReassign && \(meta\?\.users/.test(src), 'the owner list is offered to everyone');
  });

  /* ============================================================ OPS-20 */

  await test('OPS-20 a product is created with its brochure and apply links', async () => {
    const res = await adminCall('POST', '/admin/products', {
      name: `${MARK} fund`, category: 'QA Synthetic',
      brochure_url: 'https://example.invalid/brochure.pdf', apply_url: 'https://example.invalid/apply',
    });
    assert.equal(res.status, 201, `answered ${res.status}: ${res.body?.error}`);
    const row = one('SELECT brochure_url, apply_url FROM product_types WHERE id = ?', [res.body.id]);
    assert.equal(row.brochure_url, 'https://example.invalid/brochure.pdf');
    assert.equal(row.apply_url, 'https://example.invalid/apply');
  });

  /* ============================================================ OPS-21 */

  const bonanzaList = seedList('BONANZA', 'bonanza list', ADMIN.id);
  const bigulList = seedList('BIGUL', 'bigul list', SUPER.id);
  const bonanzaTemplate = seedTemplate('BONANZA', 'bonanza template');
  const bigulTemplate = seedTemplate('BIGUL', 'bigul template');

  await test('OPS-21 a Bonanza campaign cannot be made with a Bigul template', async () => {
    const res = await adminCall('POST', '/admin/campaigns', {
      name: `${MARK} cross`, channel: 'whatsapp', list_id: bonanzaList, template_id: bigulTemplate,
    });
    assert.equal(res.status, 400, `answered ${res.status}`);
    assert.match(res.body.error, /Bigul template/);
    const ok = await adminCall('POST', '/admin/campaigns', {
      name: `${MARK} same`, channel: 'whatsapp', list_id: bonanzaList, template_id: bonanzaTemplate,
    });
    assert.equal(ok.status, 201, `its own template was refused: ${ok.body?.error}`);
  });

  await test('OPS-21 an edit cannot swap in the other business\'s template, and a send asks again', async () => {
    const id = one('SELECT id FROM campaigns WHERE name = ?', [`${MARK} same`]).id;
    const swapped = await adminCall('PATCH', `/admin/campaigns/${id}`, { template_id: bigulTemplate });
    assert.equal(swapped.status, 400, `the edit took the Bigul template (${swapped.status})`);

    // A campaign stored before this fix, carrying the other business's template.
    const stale = Number(run(
      "INSERT INTO campaigns (name, channel, template_id, list_id, status, created_by, sales_org) VALUES (?, 'whatsapp', ?, ?, 'Draft', ?, 'BONANZA')",
      [`${MARK} stale`, bigulTemplate, bonanzaList, ADMIN.id],
    ).lastInsertRowid);
    const tested = await adminCall('POST', `/admin/campaigns/${stale}/test`, {});
    assert.equal(tested.status, 400, `the test send went out with the Bigul template (${tested.status})`);
    const sent = await adminCall('POST', `/admin/campaigns/${stale}/send`, {});
    assert.equal(sent.status, 400, `the send went out with the Bigul template (${sent.status})`);
  });

  await test('OPS-21 the seeded Bigul campaign sends Bigul content', async () => {
    const row = one(
      "SELECT t.sales_org FROM campaigns c JOIN templates t ON t.id = c.template_id WHERE c.name = 'Bigul onboarding nudge'",
    );
    assert(row, 'the seeded Bigul campaign is missing');
    assert.equal(row.sales_org, 'BIGUL');
  });

  /* ============================================================ OPS-22 */

  await test('OPS-22 a Bigul campaign\'s copy is Bigul\'s', async () => {
    const original = Number(run(
      "INSERT INTO campaigns (name, channel, template_id, list_id, status, created_by, sales_org) VALUES (?, 'whatsapp', ?, ?, 'Draft', ?, 'BIGUL')",
      [`${MARK} bigul original`, bigulTemplate, bigulList, SUPER.id],
    ).lastInsertRowid);
    const copy = await superCall('POST', `/admin/campaigns/${original}/duplicate`, {});
    assert.equal(copy.status, 201, `answered ${copy.status}: ${copy.body?.error}`);
    assert.equal(copy.body.sales_org, 'BIGUL', `the copy was filed as ${copy.body.sales_org}`);

    const across = await adminCall('POST', `/admin/campaigns/${original}/duplicate`, {});
    assert.equal(across.status, 403, `a Bonanza admin copied a Bigul campaign (${across.status})`);
  });

  /* ============================================================ OPS-23 */

  await test('OPS-23 a list bulk send writes one timeline entry per lead', async () => {
    const lead = seedLead('BONANZA', 'bulk');
    const list = seedList('BONANZA', 'bulk list', ADMIN.id);
    run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [list, lead]);
    const res = await adminCall('POST', `/lists/${list}/bulk/message`, { channel: 'sms', body: `${MARK} bulk`, intent: 'service' });
    assert.equal(res.status, 200, `answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.sent, 1, 'the lead was not sent to, so this proves nothing');
    const rows = all('SELECT subject, user_id FROM activities WHERE lead_id = ?', [lead]);
    assert.equal(rows.length, 1, `${rows.length} timeline entries for one message`);
    assert.equal(rows[0].subject, `Bulk send from "${MARK} bulk list"`);
    assert.equal(rows[0].user_id, ADMIN.id);
  });

  /* ============================================================ OPS-24 */

  const early = seedLead('BONANZA', 'early today', { created_at: EARLY_TODAY });
  const late = seedLead('BONANZA', 'late yesterday', { created_at: LATE_YESTERDAY });

  await test('OPS-24 a dashboard day starts at midnight IST', async () => {
    const range = resolveRange('custom', { from: IST_TODAY, to: IST_TODAY });
    const r = inRange('created_at', range);
    const found = all(`SELECT id FROM leads WHERE id IN (?, ?) AND ${r.sql}`, [early, late, ...r.params]).map((x) => x.id);
    assert.deepEqual(found, [early], `today's range held ${found.length ? found.join(', ') : 'neither'} of ${early} (00:30 IST today) and ${late} (22:30 IST yesterday)`);
  });

  await test('OPS-24 the leads list a tile opens counts the same IST day', async () => {
    const res = await adminCall('GET', `/leads?q=${encodeURIComponent(MARK)}&created_from=${IST_TODAY}&created_to=${IST_TODAY}&limit=500`);
    assert.equal(res.status, 200);
    const rows = Array.isArray(res.body) ? res.body : res.body.rows ?? res.body.leads ?? [];
    const ids = rows.map((l) => l.id);
    assert(ids.includes(early), 'the lead made at 00:30 IST today is not on today\'s list');
    assert(!ids.includes(late), 'the lead made at 22:30 IST yesterday is on today\'s list');
  });

  await test('OPS-24 "resolved today" counts IST today', async () => {
    const before = (await adminCall('GET', '/tickets/reports/summary')).body.totals.resolved_today;
    for (const [suffix, at] of [['early', EARLY_TODAY], ['late', LATE_YESTERDAY]]) {
      run(
        "INSERT INTO tickets (subject, status, priority, sales_org, resolved_at) VALUES (?, 'Resolved', 'Low', 'BONANZA', ?)",
        [`${MARK} ${suffix}`, at],
      );
    }
    const after = (await adminCall('GET', '/tickets/reports/summary')).body.totals.resolved_today;
    assert.equal(after - before, 1, `the two cases moved "resolved today" by ${after - before}, not 1`);
  });
} finally {
  sweep();
  for (const p of [SUPER, ADMIN, RM, RM2]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
