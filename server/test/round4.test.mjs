/**
 * Round 4 — the eight surgical fixes from the independent QA audit.
 *
 * docs/feedback/ROUND-4-TRIAGE.md traces each of these to a line. Run against
 * the unfixed code (b0920fd, 13 Oct), 20 of these 28 tests fail and every
 * finding has at least one that does:
 *
 *   QA-01  a hand-entered lead was routed off the Sales RM who claimed it
 *   QA-03  a Bonanza partner's ticket went to a Bigul agent, uncategorised
 *   QA-08  a task could be linked to nothing
 *   QA-26  blanking a lead's name reached the database
 *   QA-28  an AI compliance case had no book, no category and no deadlines
 *   QA-30  a campaign could be made and sent with no approved content
 *   QA-32  no product could be created, because the code was never issued
 *   QA-33  a Superadmin could activate a partner at 0 of 8 onboarding steps
 *
 * The other eight pass on the unfixed code too, and should: they guard what
 * has to keep working -- a rename still saves, a task linked to a lead is
 * still made, approved content still makes a campaign. QA-01 is the one to
 * read closely. Its API tests pass on the old code because the server was
 * always right; the bug was the form never sending `route: false`, so the
 * test that bites is a check of the form's source, which is weaker than a
 * behavioural test and is the best available without a browser.
 *
 * The book rule used for case assignment is restated here rather than
 * imported: a test that asks the implementation whether the implementation is
 * right cannot disagree with it.
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
const CLIENT = path.join(HERE, '..', '..', 'client', 'src', 'crm');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nRound 4 — the eight surgical fixes');

const RUN = Date.now().toString(36);
const MARK = `R4 probe ${RUN}`;
const STEM = 'ROUND4-PROBE';

/* ------------------------------------------------------------- fixtures */

const sweep = () => {
  /* Leads first: everything a lead owns cascades with it, and a case or a
     partner cannot go while a lead still points at it. */
  run("DELETE FROM leads WHERE name LIKE 'R4 probe %'");
  run("DELETE FROM tickets WHERE subject LIKE 'R4 probe %' OR (subject LIKE 'Compliance flag: %' AND description LIKE '%R4 probe %')");
  run("DELETE FROM tasks WHERE title LIKE 'R4 probe %'");
  run("DELETE FROM campaigns WHERE name LIKE 'R4 probe %'");
  run("DELETE FROM templates WHERE name LIKE 'R4 probe %'");
  for (const p of all("SELECT id FROM partners WHERE name LIKE 'R4 probe %'")) {
    run('DELETE FROM tickets WHERE partner_id = ?', [p.id]);
    run('DELETE FROM partner_steps WHERE partner_id = ?', [p.id]);
    run('DELETE FROM partner_lms WHERE partner_id = ?', [p.id]);
    run('DELETE FROM activities WHERE partner_id = ?', [p.id]);
    run('DELETE FROM partners WHERE id = ?', [p.id]);
  }
  for (const p of all("SELECT id FROM product_types WHERE code LIKE 'ROUND4-PROBE%' OR code LIKE 'BG-ROUND4-PROBE%'")) {
    run('DELETE FROM product_cards WHERE product_type_id = ?', [p.id]);
    run('DELETE FROM product_types WHERE id = ?', [p.id]);
  }
};
sweep();

const SUPER = await probeAdmin('round4-super', { role: 'superadmin' });
const ADMIN = await probeAdmin('round4-admin', { role: 'admin', sales_org: 'BONANZA' });
const BIGUL_ADMIN = await probeAdmin('round4-bigul-admin', { role: 'admin', sales_org: 'BIGUL' });
const RM = await probeAdmin('round4-rm', { role: 'sales_rm', sales_org: 'BONANZA' });

const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const superCall = as(SUPER);
const adminCall = as(ADMIN);
const rmCall = as(RM);

const seedLead = (org, suffix) => Number(run(
  "INSERT INTO leads (sales_org, name, source, stage) VALUES (?,?,'Import','New')",
  [org, `${MARK} ${suffix}`],
).lastInsertRowid);

/** Which books a user holds -- the rule in auth.js `orgsFor`, restated. */
const booksOf = (u) => {
  let access = null;
  try { access = u.org_access ? JSON.parse(u.org_access) : null; } catch { access = null; }
  if (Array.isArray(access) && access.length) return access;
  return u.sales_org ? [u.sales_org] : [];
};

/** Who should be given the next case in this role and book, asked before it lands. */
const expectedAgent = (role, org) => all(
  `SELECT u.id, u.sales_org, u.org_access,
          (SELECT COUNT(*) FROM tickets t
            WHERE t.assignee_id = u.id AND t.status NOT IN ('Resolved','Closed')) AS open_load
     FROM users u
    WHERE u.role = ? AND u.active = 1
    ORDER BY open_load, u.id`,
  [role],
).find((u) => booksOf(u).includes(org))?.id ?? null;

const caseRow = (id) => one(
  `SELECT t.*, c.name AS category_name FROM tickets t
     LEFT JOIN ticket_categories c ON c.id = t.category_id
    WHERE t.id = ?`,
  [id],
);

const source = (file) => fs.readFileSync(path.join(CLIENT, file), 'utf8');

try {
  /* ============================================================ QA-01 */

  await test('QA-01 a hand-entered Website lead stays with the Sales RM who claimed it', async () => {
    const res = await rmCall('POST', '/leads', { name: `${MARK} kept`, source: 'Website', route: false });
    assert.equal(res.status, 201, `create answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.owner_id, RM.id, `the lead went to user ${res.body.owner_id}, not its creator`);

    const opened = await rmCall('GET', `/leads/${res.body.id}`);
    assert.equal(opened.status, 200, `the creator cannot open the lead they just made: ${opened.body?.error}`);
  });

  await test('QA-01 without the switch the same lead is routed away — why the form must send it', async () => {
    /* The server's rule is right and is kept: a lead that arrives with no
       owner and an inbound source is routed. This is the auditor's lead #42,
       reproduced, and it is why the form's "Assign to me" must say so. */
    const res = await rmCall('POST', '/leads', { name: `${MARK} routed`, source: 'Website' });
    assert.equal(res.status, 201, `create answered ${res.status}: ${res.body?.error}`);
    assert.notEqual(res.body.owner_id, RM.id, 'nothing routed, so this probe cannot reproduce QA-01');

    const opened = await rmCall('GET', `/leads/${res.body.id}`);
    assert.notEqual(opened.status, 200, 'the routed lead is visible to its creator, so the probe proves nothing');
  });

  await test('QA-01 the New lead form sends the switch', async () => {
    const leads = source('Leads.jsx');
    const form = leads.slice(leads.indexOf('function NewLead('));
    const call = form.match(/api\.post\('\/leads',[^\n]*\)/)?.[0] ?? '';
    assert(/route:\s*false/.test(call), `the form's create call does not say it is a hand entry: ${call || '(not found)'}`);
  });

  /* ============================================================ QA-26 */

  const NAMED = seedLead('BONANZA', 'named');

  await test('QA-26 an edit that blanks the name is refused before the database', async () => {
    for (const blank of ['', '   ']) {
      const res = await adminCall('PATCH', `/leads/${NAMED}`, { name: blank });
      assert.equal(res.status, 400, `"${blank}" answered ${res.status}: ${res.body?.error}`);
      assert(!/constraint|NOT NULL|SQLITE/i.test(res.body?.error ?? ''), `the database answered: ${res.body?.error}`);
      assert(/name/i.test(res.body?.error ?? ''), `the refusal does not say which field: ${res.body?.error}`);
    }
    assert.equal(one('SELECT name FROM leads WHERE id = ?', [NAMED]).name, `${MARK} named`, 'the stored name changed');
  });

  await test('QA-26 an edit that does not mention the name is not made to', async () => {
    const res = await adminCall('PATCH', `/leads/${NAMED}`, { city: 'Pune' });
    assert.equal(res.status, 200, `a city-only edit answered ${res.status}: ${res.body?.error}`);
  });

  await test('QA-26 a real rename still saves', async () => {
    const res = await adminCall('PATCH', `/leads/${NAMED}`, { name: `${MARK} renamed` });
    assert.equal(res.status, 200, `the rename answered ${res.status}: ${res.body?.error}`);
    assert.equal(one('SELECT name FROM leads WHERE id = ?', [NAMED]).name, `${MARK} renamed`);
  });

  /* ============================================================ QA-08 */

  const due = '2030-01-01 09:00:00';

  await test('QA-08 a task linked to nothing is refused', async () => {
    const res = await adminCall('POST', '/tasks', { title: `${MARK} unlinked`, due_at: due });
    assert.equal(res.status, 400, `an unlinked task answered ${res.status}`);
    assert(/link/i.test(res.body?.error ?? ''), `the refusal does not say what is missing: ${res.body?.error}`);
    assert.equal(one("SELECT COUNT(*) n FROM tasks WHERE title = ?", [`${MARK} unlinked`]).n, 0, 'the task was stored anyway');
  });

  await test('QA-08 a task linked to a lead is created', async () => {
    const res = await adminCall('POST', '/tasks', { title: `${MARK} linked`, due_at: due, lead_id: NAMED });
    assert.equal(res.status, 201, `a linked task answered ${res.status}: ${res.body?.error}`);
  });

  await test('QA-08 a link to a record that does not exist is not a link', async () => {
    const res = await adminCall('POST', '/tasks', { title: `${MARK} dangling`, due_at: due, lead_id: 999999999 });
    assert.equal(res.status, 404, `a link to nothing answered ${res.status}`);
  });

  await test('QA-08 a link into the other book is refused, for a partner as for a lead', async () => {
    /* Only the lead id was ever checked. A partner, case or card id in the body
       went straight in, and is now the way to satisfy the link rule -- so it
       has to be checked like the lead. */
    const theirs = one("SELECT id FROM partners WHERE sales_org = 'BIGUL' ORDER BY id LIMIT 1");
    assert(theirs, 'no Bigul partner to link across the book');
    const res = await adminCall('POST', '/tasks', { title: `${MARK} across`, due_at: due, partner_id: theirs.id });
    assert.equal(res.status, 403, `a Bonanza admin linked a task to a Bigul partner: ${res.status}`);
  });

  await test('QA-08 the Tasks page sends the lead it is linked to', async () => {
    const tasks = source('Tasks.jsx');
    assert(/api\.post\('\/tasks',\s*\{[\s\S]{0,200}?lead_id:\s*linked\.id/.test(tasks),
      'the Tasks page does not send a lead with the task');
    assert(/disabled=\{[^}]*!linked[^}]*\}/.test(tasks), 'Add task is offered before anything is linked');
  });

  /* ============================================================ QA-33 */

  await test('QA-33 a Superadmin cannot activate a partner whose onboarding is not done', async () => {
    const made = await superCall('POST', '/partners', {
      name: `${MARK} partner`, business_name: `${MARK} Securities`, partner_model: 'Remisier', city: 'Pune', commission_pct: 30,
    });
    assert.equal(made.status, 201, `create answered ${made.status}: ${made.body?.error}`);
    const id = made.body.id;
    const steps = one('SELECT COUNT(*) n FROM partner_steps WHERE partner_id = ?', [id]).n;
    assert(steps > 0, 'no onboarding steps were created, so this proves nothing');
    const before = one('SELECT state_code, partner_code, portal_password FROM partners WHERE id = ?', [id]);

    const res = await superCall('POST', `/partners/${id}/elevate`, {});
    assert.equal(res.status, 400, `elevation at 0 of ${steps} answered ${res.status}`);
    assert.equal(res.body.pending, steps, `the refusal counts ${res.body.pending} outstanding, not ${steps}`);

    const after = one('SELECT state_code, partner_code, portal_password FROM partners WHERE id = ?', [id]);
    assert.deepEqual(after, before, 'the refused elevation still changed the partner — code, state or portal login');

    /* And the same route works once the steps are done, so the gate is a
       gate rather than a wall. */
    for (const s of all('SELECT code FROM partner_steps WHERE partner_id = ? ORDER BY sort_order', [id])) {
      const done = await superCall('POST', `/partners/${id}/steps/${s.code}`, {});
      assert.equal(done.status, 200, `step ${s.code} answered ${done.status}`);
    }
    const ok = await superCall('POST', `/partners/${id}/elevate`, {});
    assert.equal(ok.status, 200, `elevation after onboarding answered ${ok.status}: ${ok.body?.error}`);
    assert.equal(ok.body.elevated, true);
  });

  /* ============================================================ QA-32 */

  await test('QA-32 a product is created from a name alone and issued its code', async () => {
    const res = await adminCall('POST', '/admin/products', { name: 'Round4 probe', category: 'QA Synthetic', min_investment: 1000 });
    assert.equal(res.status, 201, `create answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.code, STEM, `issued ${res.body.code}`);
    assert.equal(res.body.sales_org, 'BONANZA');
    assert.equal(one('SELECT code FROM product_types WHERE id = ?', [res.body.id]).code, STEM);
  });

  await test('QA-32 the cards it puts on existing leads stay in its own business', async () => {
    const product = one('SELECT id FROM product_types WHERE code = ?', [STEM]);
    assert(product, 'the product from the previous test is missing');
    const across = one(
      `SELECT COUNT(*) n FROM product_cards pc JOIN leads l ON l.id = pc.lead_id
        WHERE pc.product_type_id = ? AND l.sales_org != 'BONANZA'`,
      [product.id],
    ).n;
    assert.equal(across, 0, `a Bonanza product put ${across} card(s) on the other business's leads`);
    const own = one("SELECT COUNT(*) n FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL").n;
    const cards = one('SELECT COUNT(*) n FROM product_cards WHERE product_type_id = ?', [product.id]).n;
    assert.equal(cards, own, `${cards} cards for ${own} live Bonanza leads`);
  });

  await test('QA-32 a second product of the same name gets a code of its own', async () => {
    const res = await adminCall('POST', '/admin/products', { name: 'Round4 probe' });
    assert.equal(res.status, 201, `create answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.code, `${STEM}-2`);
  });

  await test('QA-32 a Bigul product carries the BG- prefix and stays in Bigul', async () => {
    const res = await as(BIGUL_ADMIN)('POST', '/admin/products', { name: 'Round4 probe' });
    assert.equal(res.status, 201, `create answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.code, `BG-${STEM}`);
    assert.equal(res.body.sales_org, 'BIGUL');
    const across = one(
      `SELECT COUNT(*) n FROM product_cards pc JOIN leads l ON l.id = pc.lead_id
        WHERE pc.product_type_id = ? AND l.sales_org != 'BIGUL'`,
      [res.body.id],
    ).n;
    assert.equal(across, 0, `a Bigul product put ${across} card(s) on Bonanza leads`);
  });

  /* ============================================================ QA-03 */

  const seededHash = one('SELECT portal_password FROM partners WHERE portal_password IS NOT NULL ORDER BY id LIMIT 1')?.portal_password;
  assert(seededHash, 'no seeded partner to borrow a portal password hash from');

  const portalPartner = async (org) => {
    const email = `probe-round4-${org.toLowerCase()}-${RUN}@partner.test`;
    const id = Number(run(
      `INSERT INTO partners (sales_org, partner_code, name, business_name, partner_model, state_code,
                             email, portal_password, commission_pct, onboarded_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [org, `R4-${org}-${RUN}`, `${MARK} ${org} partner`, `${MARK} ${org} Ltd`, 'Associate', 'ACTIVE', email, seededHash, 0],
    ).lastInsertRowid);
    const res = await fetch(`${BASE}/api/auth/partner-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'partner' }),
    });
    assert(res.ok, `the ${org} probe partner could not sign in: HTTP ${res.status}`);
    return { id, org, token: (await res.json()).token };
  };

  const raise = async (partner) => {
    const res = await fetch(`${BASE}/api/portal/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${partner.token}` },
      body: JSON.stringify({ subject: `${MARK} ${partner.org} support`, description: 'Commission query', priority: 'Medium' }),
    });
    assert.equal(res.status, 201, `the portal ticket answered ${res.status}`);
    return (await res.json()).id;
  };

  for (const org of ['BONANZA', 'BIGUL']) {
    await test(`QA-03 a ${org} partner's ticket is Partner Support, in ${org}, worked from ${org}`, async () => {
      const partner = await portalPartner(org);
      const expected = expectedAgent('partner_rm', org);
      const t = caseRow(await raise(partner));

      assert.equal(t.sales_org, org, `the case was filed in ${t.sales_org}`);
      assert.equal(t.category_name, 'Partner Support', `the case is ${t.category_name ?? 'Uncategorised'}`);
      assert(t.ref.startsWith(org === 'BIGUL' ? 'BGL-' : 'BNZ-'), `the case is numbered ${t.ref}`);
      assert(t.response_due && t.resolution_due, 'the case has no SLA deadlines');

      /* Exactly the partner RM the book rule names -- which for a book with
         none is nobody, never an agent from the other business. */
      assert.equal(t.assignee_id ?? null, expected,
        `assigned to user ${t.assignee_id}, where the book rule names ${expected}`);
      if (t.assignee_id) {
        const u = one('SELECT role, sales_org, org_access FROM users WHERE id = ?', [t.assignee_id]);
        assert.equal(u.role, 'partner_rm', `assigned to a ${u.role}`);
        assert(booksOf(u).includes(org), `assigned to someone who works ${booksOf(u).join(', ')}`);
      }
    });
  }

  /* ============================================================ QA-28 */

  const confirm = (leadId, flag) => superCall('POST', '/ai/disposition/confirm', {
    lead_id: leadId, outcome: 'Connected — Interested', summary: `${MARK} call`, card_changes: [],
    next_action: 'No Action', next_action_due_hours: 4, follow_up_task: '',
    compliance_flag: flag, compliance_note: `${MARK} note`, score_signal: 0,
  });

  await test('QA-28 a Complaint on a Bigul lead opens a Bigul Complaint case with deadlines', async () => {
    const lead = seedLead('BIGUL', 'complainant');
    const expected = expectedAgent('customer_care', 'BIGUL');
    const res = await confirm(lead, 'Complaint');
    assert.equal(res.status, 200, `confirm answered ${res.status}: ${res.body?.error}`);
    const t = caseRow(res.body.compliance_ticket_id);

    assert.equal(t.sales_org, 'BIGUL', `the case was filed in ${t.sales_org}`);
    assert(t.ref.startsWith('BGL-'), `the case is numbered ${t.ref}`);
    assert.equal(t.category_name, 'Complaint', `the case is ${t.category_name ?? 'Uncategorised'}`);
    assert.equal(t.priority, 'High');
    assert(t.response_due && t.resolution_due, 'a High compliance case has no deadlines — the BNZ-00011 defect');
    assert.equal(t.assignee_id ?? null, expected, `assigned to user ${t.assignee_id}, where the book rule names ${expected}`);
  });

  /* Every flag the AI raises has a route since 14 Oct (compliancedesk.test.mjs
     covers them). This keeps the guarantee for a flag that has none: no
     category is invented, and the case still has its book and its clock. */
  await test('QA-28 a flag with no category of its own still gets a book and a clock', async () => {
    const lead = seedLead('BONANZA', 'regulatory');
    const res = await confirm(lead, 'A flag nobody has routed');
    assert.equal(res.status, 200, `confirm answered ${res.status}: ${res.body?.error}`);
    const t = caseRow(res.body.compliance_ticket_id);
    assert.equal(t.sales_org, 'BONANZA');
    assert.equal(t.category_id, null, 'a category was invented for a flag nobody has mapped');
    assert(t.response_due && t.resolution_due, 'the uncategorised case has no deadlines');
  });

  await test('QA-28 a flag that names an object property is just an unmapped flag', async () => {
    const lead = seedLead('BONANZA', 'proto');
    const res = await confirm(lead, '__proto__');
    assert.equal(res.status, 200, `a crafted flag answered ${res.status}: ${res.body?.error}`);
  });

  /* ============================================================ QA-30 */

  const list = one("SELECT id FROM lead_lists WHERE sales_org = 'BONANZA' AND kind != 'dynamic' ORDER BY id LIMIT 1");
  const whatsapp = one("SELECT id FROM templates WHERE channel = 'whatsapp' AND approved = 1 AND sales_org = 'BONANZA' ORDER BY id LIMIT 1");
  const sms = one("SELECT id FROM templates WHERE channel = 'sms' AND approved = 1 AND sales_org = 'BONANZA' ORDER BY id LIMIT 1");
  const unapproved = Number(run(
    "INSERT INTO templates (name, channel, body, approved) VALUES (?, 'whatsapp', 'Unapproved probe body', 0)",
    [`${MARK} unapproved`],
  ).lastInsertRowid);
  assert(list && whatsapp && sms, 'no Bonanza list or approved templates to build campaigns from');

  const create = (body) => adminCall('POST', '/admin/campaigns', { channel: 'whatsapp', list_id: list.id, ...body });

  await test('QA-30 a campaign with no content is refused', async () => {
    const res = await create({ name: `${MARK} empty` });
    assert.equal(res.status, 400, `answered ${res.status}`);
    assert(/approved template/i.test(res.body?.error ?? ''), `the refusal says: ${res.body?.error}`);
  });

  await test('QA-30 a campaign with unapproved content is refused', async () => {
    const res = await create({ name: `${MARK} unapproved`, template_id: unapproved });
    assert.equal(res.status, 409, `answered ${res.status}`);
  });

  await test("QA-30 a campaign with another channel's template is refused", async () => {
    const res = await create({ name: `${MARK} mismatch`, template_id: sms.id });
    assert.equal(res.status, 400, `answered ${res.status}`);
  });

  let made = null;
  await test('QA-30 a campaign with approved content for its channel is created', async () => {
    const res = await create({ name: `${MARK} approved`, template_id: whatsapp.id });
    assert.equal(res.status, 201, `answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.template_id, whatsapp.id);
    made = res.body;
  });

  await test('QA-30 an edit cannot strip the content or leave it on the wrong channel', async () => {
    assert(made, 'the campaign from the previous test is missing');
    const stripped = await adminCall('PATCH', `/admin/campaigns/${made.id}`, { template_id: '' });
    assert.equal(stripped.status, 400, `stripping the template answered ${stripped.status}`);
    const moved = await adminCall('PATCH', `/admin/campaigns/${made.id}`, { channel: 'sms' });
    assert.equal(moved.status, 400, `moving to SMS with a WhatsApp template answered ${moved.status}`);
    const both = await adminCall('PATCH', `/admin/campaigns/${made.id}`, { channel: 'sms', template_id: sms.id });
    assert.equal(both.status, 200, `a matching change answered ${both.status}: ${both.body?.error}`);
  });

  await test('QA-30 a duplicate is made on the same terms as a new campaign', async () => {
    /* The auditor's #4 was a duplicate of #3, which had no content. */
    const empty = Number(run(
      "INSERT INTO campaigns (name, channel, template_id, list_id, status, created_by, sales_org) VALUES (?, 'whatsapp', NULL, ?, 'Draft', ?, 'BONANZA')",
      [`${MARK} dup empty`, list.id, ADMIN.id],
    ).lastInsertRowid);
    const refused = await adminCall('POST', `/admin/campaigns/${empty}/duplicate`, {});
    assert.equal(refused.status, 400, `duplicating a campaign with no content answered ${refused.status}`);

    const source = await create({ name: `${MARK} dup source`, template_id: whatsapp.id });
    assert.equal(source.status, 201, `the source answered ${source.status}: ${source.body?.error}`);
    const copy = await adminCall('POST', `/admin/campaigns/${source.body.id}/duplicate`, {});
    assert.equal(copy.status, 201, `duplicating approved content answered ${copy.status}: ${copy.body?.error}`);
    assert.equal(copy.body.template_id, whatsapp.id);
    run('UPDATE campaigns SET name = ? WHERE id = ?', [`${MARK} dup copy`, copy.body.id]);
  });

  await test('QA-30 a campaign already saved with no content cannot be tested or sent', async () => {
    /* The auditor's campaign #3 was made before this rule and has no template.
       Those still exist, so the send asks again rather than trusting creation. */
    const legacy = Number(run(
      "INSERT INTO campaigns (name, channel, template_id, list_id, status, created_by, sales_org) VALUES (?, 'whatsapp', NULL, ?, 'Draft', ?, 'BONANZA')",
      [`${MARK} legacy`, list.id, ADMIN.id],
    ).lastInsertRowid);

    const tried = await adminCall('POST', `/admin/campaigns/${legacy}/test`, {});
    assert.equal(tried.status, 400, `the test send answered ${tried.status}`);
    const sent = await adminCall('POST', `/admin/campaigns/${legacy}/send`, {});
    assert.equal(sent.status, 400, `the send answered ${sent.status}`);

    const after = one('SELECT status, sent FROM campaigns WHERE id = ?', [legacy]);
    assert.equal(after.status, 'Draft', `the campaign is now ${after.status}`);
    assert.equal(after.sent ?? 0, 0, `${after.sent} people were contacted`);
  });
} finally {
  sweep();
  /* The seed sweeps probe accounts at the top of every run, so an account
     that is still referenced somewhere is left for it rather than failing a
     file whose results are already in. */
  for (const p of [SUPER, ADMIN, BIGUL_ADMIN, RM]) {
    try { p.cleanup(); } catch { /* swept by the next seed */ }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
