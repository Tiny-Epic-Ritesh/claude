/**
 * Round 4 — the second batch: findings traced to a line after the first eight.
 *
 *   QA-04  a Home tile's date window was dropped on the way to the list
 *   QA-05  the Open cases tile opened on "Assigned to me"
 *   QA-11  offered merge fields went out literally; masked ones were mergeable
 *   QA-12  the API screen told integrators to send secrets over http://
 *   QA-19  "Create list" was still marked as not built
 *   QA-20  "Tasks (2)" over three rows
 *   QA-21  the Product RM handoff said nothing about who now had it
 *   QA-23  every egress row said "Sent", including calls answered locally
 *   QA-25  Copilot's breach answer did not say whose tickets it counted
 *   QA-27  a successful delete left the reader on "Lead not found"
 *   QA-31  a product minimum had to be a multiple of 1,000, and 0 became null
 *   QA-38  the menu blocked a service message the header allowed
 *   QA-39  a person's message was signed "system"
 *   QA-40  the log tabs said 0 over thousands of rows
 *   QA-41  a refused screen spun forever — fourteen screens, and QA-43's KYC detail
 *
 * Server findings are tested through the shipped routes. The client ones are
 * checks of the source, which is the best available without a browser and is
 * said so in each test's name.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import { resolveActions } from '../src/routes/cockpit.js';
import { withResidency, routeFor } from '../src/ai/residency.js';
import { copilotSnapshot } from '../src/ai/index.js';
import { copilot } from '../src/ai/mock.js';
import { maskedFieldsFor } from '../src/engine/masking.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', '..', 'client', 'src');
const source = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nRound 4 — the second batch');

const RUN = Date.now().toString(36);
const MARK = `R4b probe ${RUN}`;
const mobile = (n) => `9${String(Date.now()).slice(-8)}${n}`;

const sweep = () => {
  run("DELETE FROM leads WHERE name LIKE 'R4b probe %'");
  run("DELETE FROM lead_lists WHERE name LIKE 'R4b probe %'");
  run("DELETE FROM campaigns WHERE name LIKE 'R4b probe %'");
  run("DELETE FROM templates WHERE name LIKE 'R4b probe %'");
  for (const p of all("SELECT id FROM product_types WHERE name LIKE 'R4b probe %'")) {
    run('DELETE FROM product_cards WHERE product_type_id = ?', [p.id]);
    run('DELETE FROM product_types WHERE id = ?', [p.id]);
  }
};
sweep();

const SUPER = await probeAdmin('round4b-super', { role: 'superadmin' });
const ADMIN = await probeAdmin('round4b-admin', { role: 'admin', sales_org: 'BONANZA' });
const CALLER = await probeAdmin('round4b-caller', { role: 'caller', sales_org: 'BONANZA' });

const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const superCall = as(SUPER);
const adminCall = as(ADMIN);
const callerCall = as(CALLER);

const owner = one("SELECT id, name FROM users WHERE role = 'sales_rm' AND sales_org = 'BONANZA' AND active = 1 ORDER BY id LIMIT 1");
const seedLead = (suffix, extra = {}) => Number(run(
  `INSERT INTO leads (sales_org, name, source, stage, mobile, email, city, owner_id)
   VALUES ('BONANZA', ?, 'Import', 'New', ?, ?, ?, ?)`,
  [`${MARK} ${suffix}`, extra.mobile ?? null, extra.email ?? null, extra.city ?? null, extra.owner_id ?? owner.id],
).lastInsertRowid);

try {
  /* ============================================================ QA-40 */

  await test('QA-40 every log tab counts what its table holds', async () => {
    const meta = await superCall('GET', '/setup/logs');
    assert.equal(meta.status, 200);
    let nonZero = 0;
    for (const k of meta.body.kinds) {
      const page = await superCall('GET', `/setup/logs/${k.kind}?limit=1`);
      const said = meta.body.counts[k.kind];
      /* Not exact: the API access log records every request, these included,
         so its table can grow by a few between the two reads. */
      assert.equal(typeof said, 'number', `the ${k.kind} tab has no count at all (${said})`);
      assert(said <= page.body.total && page.body.total - said <= 50,
        `the ${k.kind} tab says ${said} over a table of ${page.body.total}`);
      if (page.body.total > 0) nonZero += 1;
      if (page.body.total > 50) assert(said > 0, `the ${k.kind} tab says 0 over ${page.body.total} rows`);
    }
    assert(nonZero > 0, 'every log is empty, so this proves nothing');
  });

  /* ============================================================ QA-12 */

  await test('QA-12 the API base URL is configured, never guessed from the request', async () => {
    const res = await superCall('GET', '/setup/api-credentials');
    assert.equal(res.status, 200);
    assert.equal(res.body.base_url, process.env.CRM_PUBLIC_URL || null,
      `the server offered ${res.body.base_url}`);
  });

  await test('QA-12 the screen falls back to the address it is using (source check)', async () => {
    assert(/data\.base_url \?\? window\.location\.origin/.test(source('crm/ApiAccess.jsx')));
  });

  /* ============================================================ QA-19 */

  await test('QA-19 Create list goes to Lead Lists for whoever may create one', async () => {
    const [made] = resolveActions(['Create list'], new Set(['list.create']));
    assert(made, 'the shortcut was dropped for a role holding list.create');
    assert.equal(made.kind, 'go', `the shortcut is "${made.kind}"`);
    assert.equal(made.to, '/lists');
    assert.equal(resolveActions(['Create list'], new Set()).length, 0, 'offered to a role that may not create a list');
  });

  /* ============================================================ QA-39 */

  await test('QA-39 a message a person sends is signed by that person', async () => {
    const lead = seedLead('message', { mobile: mobile(1) });
    const res = await adminCall('POST', `/leads/${lead}/message`, { channel: 'sms', body: `${MARK} hello`, intent: 'service' });
    assert.equal(res.status, 201, `the send answered ${res.status}: ${res.body?.error}`);
    const rows = all('SELECT user_id FROM activities WHERE lead_id = ? AND type = ?', [lead, 'SMS']);
    assert(rows.length, 'no timeline entry was written');
    for (const r of rows) assert.equal(r.user_id, ADMIN.id, `an entry is signed ${r.user_id ?? 'system'}`);
  });

  await test('QA-39 a list bulk send is signed by its sender', async () => {
    const lead = seedLead('bulk', { mobile: mobile(2) });
    const list = Number(run(
      "INSERT INTO lead_lists (name, kind, owner_id, sales_org) VALUES (?, 'static', ?, 'BONANZA')",
      [`${MARK} list`, ADMIN.id],
    ).lastInsertRowid);
    run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [list, lead]);
    const res = await adminCall('POST', `/lists/${list}/bulk/message`, { channel: 'sms', body: `${MARK} bulk`, intent: 'service' });
    assert.equal(res.status, 200, `the bulk send answered ${res.status}: ${res.body?.error}`);
    const rows = all('SELECT user_id FROM activities WHERE lead_id = ? AND type = ?', [lead, 'SMS']);
    assert(rows.length, 'no timeline entry was written');
    for (const r of rows) assert.equal(r.user_id, ADMIN.id, `an entry is signed ${r.user_id ?? 'system'}`);
  });

  /* ============================================================ QA-11 */

  await test('QA-11 every token the picker offers is filled in a composed email', async () => {
    const lead = seedLead('Aarav Composer', { email: 'probe@example.invalid', city: 'Pune' });
    const res = await adminCall('POST', '/email/send', {
      lead_id: lead, subject: 'R4b {{full_name}}', intent: 'service',
      body: '<p>Lead={{full_name}}; Owner={{owner}}; City={{city}}; Email={{email}}</p>',
    });
    assert([200, 201].includes(res.status), `the send answered ${res.status}: ${res.body?.error}`);
    const act = one("SELECT body FROM activities WHERE lead_id = ? AND type = 'Email' ORDER BY id DESC LIMIT 1", [lead]);
    assert(act, 'no email on the timeline');
    assert(!/\{\{/.test(act.body), `left unfilled: ${act.body}`);
    assert(act.body.includes('City=Pune'), `city: ${act.body}`);
    assert(act.body.includes(`Owner=${owner.name}`), `owner: ${act.body}`);
    assert(act.body.includes('Email=probe@example.invalid'), `email: ${act.body}`);
  });

  await test('QA-11 a field masked for the sender is refused, not merged', async () => {
    if (!maskedFieldsFor('caller').has('mobile')) {
      console.log('  --   a caller sees mobiles unmasked in this configuration, so there is nothing to refuse');
      return;
    }
    const lead = seedLead('masked', { email: 'probe2@example.invalid', mobile: mobile(3), owner_id: CALLER.id });
    const res = await callerCall('POST', '/email/send', {
      lead_id: lead, subject: 'R4b', intent: 'service', body: '<p>Your number is {{mobile}}</p>',
    });
    assert.equal(res.status, 400, `a caller merged a masked mobile: ${res.status}`);
    assert.equal(res.body.field, 'mobile');
    assert.equal(one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND type = 'Email'", [lead]).n, 0,
      'the refused email reached the timeline anyway');
  });

  await test('QA-11 a campaign fills every offered token, and {{name}} is the first name', async () => {
    const lead = seedLead('Ravi Campaign', { mobile: mobile(4), city: 'Pune' });
    const template = Number(run(
      "INSERT INTO templates (name, channel, body, approved, sales_org) VALUES (?, 'sms', 'Hi {{name}} from {{city}}', 1, 'BONANZA')",
      [`${MARK} template`],
    ).lastInsertRowid);
    const list = Number(run(
      "INSERT INTO lead_lists (name, kind, owner_id, sales_org) VALUES (?, 'static', ?, 'BONANZA')",
      [`${MARK} campaign list`, ADMIN.id],
    ).lastInsertRowid);
    run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [list, lead]);

    const made = await adminCall('POST', '/admin/campaigns', { name: `${MARK} campaign`, channel: 'sms', list_id: list, template_id: template });
    assert.equal(made.status, 201, `create answered ${made.status}: ${made.body?.error}`);
    const sent = await adminCall('POST', `/admin/campaigns/${made.body.id}/send`, {});
    assert.equal(sent.status, 200, `send answered ${sent.status}: ${sent.body?.error}`);

    const act = one("SELECT body FROM activities WHERE lead_id = ? AND type = 'SMS' ORDER BY id DESC LIMIT 1", [lead]);
    assert(act, 'the campaign left nothing on the timeline');
    assert.equal(act.body, `Hi ${MARK.split(' ')[0]} from Pune`, `the message read: ${act.body}`);
  });

  /* ============================================================ QA-21 */

  await test('QA-21 the Product RM handoff names who now has it', async () => {
    const lead = seedLead('handoff');
    run("INSERT OR IGNORE INTO product_cards (lead_id, product_type_id, state) SELECT ?, id, 'INACTIVE' FROM product_types WHERE sales_org = 'BONANZA' AND active = 1", [lead]);
    const card = one(
      `SELECT pc.id, pt.name FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
        WHERE pc.lead_id = ? AND EXISTS (SELECT 1 FROM users u WHERE u.role = 'product_rm' AND u.active = 1 AND u.product_type_id = pt.id)
        ORDER BY pc.id LIMIT 1`,
      [lead],
    );
    assert(card, 'no product with a Product RM to hand to');
    const rms = all("SELECT name FROM users WHERE role = 'product_rm' AND active = 1 AND product_type_id = (SELECT product_type_id FROM product_cards WHERE id = ?)", [card.id]).map((r) => r.name);

    const res = await superCall('POST', `/cards/${card.id}/request-product-rm`, { reason: `${MARK} handoff` });
    assert.equal(res.status, 200, `the handoff answered ${res.status}: ${res.body?.error}`);
    assert.deepEqual([...res.body.product_rms].sort(), [...rms].sort(), `named ${JSON.stringify(res.body.product_rms)}`);
    assert.equal(res.body.product, card.name);
  });

  await test('QA-21 the panel shows that answer (source check)', async () => {
    const panel = source('crm/ProductPanel.jsx');
    assert(/product_rms/.test(panel) && /onDone\?\.\(typeof said === 'string'/.test(panel));
  });

  /* ============================================================ QA-23 */

  await test('QA-23 an egress row records what actually answered', async () => {
    if (routeFor('ticketSummary').provider !== 'frontier') {
      console.log(`  --   ticketSummary routes to ${routeFor('ticketSummary').provider} here, so no egress row is written`);
      return;
    }
    const before = one("SELECT COALESCE(MAX(id), 0) id FROM audit_log WHERE action = 'ai_egress'").id;
    await withResidency('ticketSummary', {
      payload: { subject: 'A question about a charge' }, context: {},
      call: async () => ({ summary: 'ok' }), servedBy: 'mock', live: false,
    });
    const row = one("SELECT detail FROM audit_log WHERE action = 'ai_egress' AND id > ? ORDER BY id DESC LIMIT 1", [before]);
    assert(row, 'no egress row was written');
    const meta = JSON.parse(row.detail);
    assert.equal(meta.live, false, 'the row does not say the call stayed local');
    assert.equal(meta.served_by, 'mock');
  });

  await test('QA-23 the evidence table tells local from abroad (source check)', async () => {
    const screen = source('crm/admin/Residency.jsx');
    assert(/Served locally/.test(screen) && /Sent abroad/.test(screen) && /e\.meta\?\.live === true/.test(screen));
  });

  /* ============================================================ QA-25 */

  await test("QA-25 Copilot's breach answer says whose tickets it counted", async () => {
    const care = one("SELECT * FROM users WHERE role = 'customer_care' AND sales_org = 'BONANZA' AND active = 1 ORDER BY id LIMIT 1");
    assert(care, 'no Customer Care user');
    const snap = copilotSnapshot(care);
    assert.equal(snap.ticket_scope, 'assigned to you');
    const answer = copilot({ question: 'any SLA breaches?', snapshot: { ...snap, tickets: [{ breached: 1, ref: 'BNZ-0', priority: 'High', subject: 'x' }] } });
    assert(/assigned to you/.test(answer.reply), `the answer reads: ${answer.reply}`);
  });

  /* ============================================================ QA-31 */

  await test('QA-31 a product minimum of ₹500 is accepted and stored', async () => {
    const res = await adminCall('POST', '/admin/products', { name: `${MARK} five hundred`, min_investment: 500 });
    assert.equal(res.status, 201, `answered ${res.status}: ${res.body?.error}`);
    assert.equal(one('SELECT min_investment v FROM product_types WHERE id = ?', [res.body.id]).v, 500);
  });

  await test('QA-31 a minimum of zero is zero, not "not set"', async () => {
    const res = await adminCall('POST', '/admin/products', { name: `${MARK} zero`, min_investment: 0 });
    assert.equal(res.status, 201, `answered ${res.status}: ${res.body?.error}`);
    assert.equal(one('SELECT min_investment v FROM product_types WHERE id = ?', [res.body.id]).v, 0);
  });

  await test('QA-31 a negative minimum is refused, on create and on edit', async () => {
    const made = await adminCall('POST', '/admin/products', { name: `${MARK} negative`, min_investment: -1 });
    assert.equal(made.status, 400, `create answered ${made.status}`);
    const product = one("SELECT id FROM product_types WHERE name = ?", [`${MARK} five hundred`]);
    const edit = await adminCall('PATCH', `/admin/products/${product.id}`, { min_investment: -5 });
    assert.equal(edit.status, 400, `edit answered ${edit.status}`);
    const ok = await adminCall('PATCH', `/admin/products/${product.id}`, { min_investment: 2999 });
    assert.equal(ok.status, 200, `a valid edit answered ${ok.status}: ${ok.body?.error}`);
  });

  await test('QA-31 the form takes any whole rupee (source check)', async () => {
    assert(/type="number" min="0" step="1"/.test(source('crm/ProductsSetup.jsx')));
  });

  /* ============================================================ client */

  await test('QA-04 the Leads page reads the date window a tile sends (source check)', async () => {
    const leads = source('crm/Leads.jsx');
    assert.equal((leads.match(/created_from: search\.get\('created_from'\)/g) ?? []).length, 2, 'not read on load and on change');
    assert.equal((leads.match(/created_to: search\.get\('created_to'\)/g) ?? []).length, 2);
    assert(/Clear the date window/.test(leads), 'an active window is not shown');
    /* The source chart's drill-through, the same defect a third time. */
    assert.equal((leads.match(/source: search\.get\('source'\)/g) ?? []).length, 2, 'the source a chart sends is dropped');
    assert(/Clear the source/.test(leads), 'an active source filter is not shown');
  });

  await test('QA-04 the route honours the window the page now sends', async () => {
    const res = await superCall('GET', '/leads?created_from=2099-01-01&created_to=2099-01-31&limit=5');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0, 'a window with no leads in it returned leads');
  });

  await test('QA-05 the Cases page opens on the view its link names (source check)', async () => {
    const page = source('crm/Tickets.jsx');
    assert(/linked\.get\('view'\)/.test(page) && /linked\.get\('open'\) === 'true'/.test(page));
  });

  await test('QA-20 the Tasks and Tickets tabs count what they list (source check)', async () => {
    const detail = source('crm/LeadDetail.jsx');
    assert(/key: 'tasks', label: 'Tasks', count: lead\.tasks\.length/.test(detail));
    assert(/key: 'tickets', label: 'Tickets', count: lead\.tickets\.length/.test(detail));
  });

  await test('QA-27 a delete returns to the list with a recycle-bin link (source check)', async () => {
    assert(/onDone\(\{ deleted: true, name: lead\.name \}\)/.test(source('crm/ActionModals.jsx')), 'the dialog does not say it deleted');
    assert(/result\?\.deleted[\s\S]{0,120}navigate\('\/leads'/.test(source('crm/LeadDetail.jsx')), 'the lead page reloads the deleted lead');
    assert(/location\.state\?\.notice/.test(source('crm/Leads.jsx')), 'the list does not show what happened');
    assert(/\/data\?tab=recycle/.test(source('crm/Leads.jsx')) && /params\.get\('tab'\)/.test(source('crm/DataTools.jsx')),
      'the recycle bin cannot be linked to');
  });

  await test('QA-38 the message openers ask whether any purpose is open (source check)', async () => {
    const menu = source('components/ActionMenu.jsx');
    for (const key of ['whatsapp', 'sms', 'email']) {
      assert(new RegExp(`key: '${key}'[^\\n]*intent: 'any'`).test(menu), `${key} still gates on marketing`);
    }
    assert(/a\.intent === 'any' \? \(gate\.service \|\| gate\.marketing\)/.test(menu));
  });

  await test('QA-41 no screen shows a spinner ahead of its error (source check)', async () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.jsx') ? [path.join(dir, e.name)] : []
    ));
    const offenders = [];
    for (const file of walk(CLIENT)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.trim() !== 'if (loading || !data) return <Loading />;') return;
        let j = i - 1;
        while (j >= 0 && !lines[j].trim()) j -= 1;
        if (!/^if \((loadError|error)\) return <ErrorBanner/.test(lines[j]?.trim() ?? '')) {
          offenders.push(`${path.relative(CLIENT, file)}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `a refusal would spin forever at: ${offenders.join(', ')}`);
  });

  await test('QA-43 the KYC journey detail shows a refusal (source check)', async () => {
    assert(/loadError \? <ErrorBanner error=\{loadError\} \/> : !full \? <Loading \/>/.test(source('crm/KycConsole.jsx')));
  });
} finally {
  sweep();
  for (const p of [SUPER, ADMIN, CALLER]) {
    try { p.cleanup(); } catch { /* swept by the next seed */ }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
