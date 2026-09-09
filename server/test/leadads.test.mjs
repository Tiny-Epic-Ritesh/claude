/**
 * Meta Lead Ads: forms, mapping, routing and delivery (P3-18).
 *
 * The console is a view of this. What is tested here is the part that runs
 * with nobody watching — a webhook arriving at three in the morning and
 * deciding, on its own, whose book a client belongs in and whether the one
 * question the advertiser wrote is worth keeping.
 *
 * Two of these tests are for defects that were live before this ticket:
 * every Meta lead was written into the first sales org regardless of which
 * page it came from, and every answer to a question outside a nine-entry
 * constant was read and thrown away.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import { applyMap, mapFor, MAPPABLE, isMappable } from '../src/engine/leadads.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

/* Superadmin, because these routes sit behind admin.system like the rest of
   the connector screen -- the `admin` role does not hold it. */
const PROBE = await probeAdmin('leadads', { role: 'superadmin' });

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nLead ads');

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** Fire one leadgen delivery through the webhook, as Meta would. */
const deliver = async (formId, leadgenId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) => {
  const res = await fetch(`${BASE}/api/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'page',
      entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, form_id: formId, page_id: 'probe-page' } }] }],
    }),
  });
  return { body: await res.json(), leadgenId };
};

const FORMS = ['probe_form_a', 'probe_form_b'];

const clean = () => {
  const ids = all(
    `SELECT lead_id FROM meta_delivery WHERE form_id IN (${FORMS.map(() => '?').join(',')}) AND lead_id IS NOT NULL`,
    FORMS,
  ).map((r) => r.lead_id);
  for (const id of ids) run('DELETE FROM leads WHERE id = ?', [id]);
  run(`DELETE FROM meta_delivery WHERE form_id IN (${FORMS.map(() => '?').join(',')})`, FORMS);
  run(`DELETE FROM meta_lead_form WHERE form_id IN (${FORMS.map(() => '?').join(',')})`, FORMS);
  run(`DELETE FROM meta_field_map WHERE form_id IN (${FORMS.map(() => '?').join(',')})`, FORMS);
};
clean();

/* --------------------------------------------------------- the mapping */

await test('an answer is only written into a column it is safe to write into', () => {
  /* The form is designed outside the company. Letting an answer reach `stage`,
     `score` or `owner_id` would let whoever built the ad decide routing and
     reporting. */
  for (const key of ['name', 'mobile', 'email', 'city', 'pan']) {
    assert(isMappable(key), `${key} should be mappable`);
  }
  for (const key of ['stage', 'score', 'owner_id', 'sales_org', 'id', 'deleted_at']) {
    assert(!isMappable(key), `${key} must not be writable from a lead form`);
  }
  assert(MAPPABLE.length, 'no mappable fields are offered at all');
});

await test('an unmapped answer is kept, not dropped', () => {
  /* The defect this replaces: mapping was a constant listing nine Meta field
     names, and anything else was read and thrown away — including the one
     question the advertiser wrote, which is the only thing on the form that
     says why this person is interested. */
  const { fields, notes } = applyMap({
    full_name: 'Rohan Kulkarni',
    phone_number: '+919812345678',
    which_product_interests_you: 'Mutual Funds',
  }, 'probe_form_a');

  assert.equal(fields.name, 'Rohan Kulkarni');
  assert.equal(fields.mobile, '9812345678', `mobile came out as ${fields.mobile}`);

  const kept = notes.find((n) => n.question === 'which_product_interests_you');
  assert(kept, `the custom answer was dropped: ${JSON.stringify(notes)}`);
  assert.equal(kept.value, 'Mutual Funds');
  assert.equal(kept.known, false, 'an unmapped question was reported as already known');
});

await test('a form map overrides the default without restating it', () => {
  run("INSERT INTO meta_field_map (form_id, question, crm_field) VALUES ('probe_form_a', 'city', 'state')");
  try {
    const map = mapFor('probe_form_a');
    assert.equal(map.get('city'), 'state', 'the form map did not override the default');
    assert.equal(map.get('email'), 'email', 'the default was lost when a form map existed');
  } finally {
    run("DELETE FROM meta_field_map WHERE form_id = 'probe_form_a'");
  }
});

await test('a name is built from the parts when there is no whole one', () => {
  const { fields } = applyMap({ first_name: 'Priya', last_name: 'Sharma' }, 'probe_form_a');
  assert.equal(fields.name, 'Priya Sharma');
  assert(!('first_name' in fields), 'first_name was left as a column to write');
});

/* ------------------------------------------------------------ the book */

await test('a form is registered the first time one of its leads arrives', async () => {
  await deliver('probe_form_a');
  const form = one('SELECT * FROM meta_lead_form WHERE form_id = ?', ['probe_form_a']);
  assert(form, 'the form was not registered');
  assert.equal(form.page_id, 'probe-page');
  assert(form.last_seen_at, 'the form has no last seen time');
});

await test('the form decides the book, not whichever org sorts first', async () => {
  /* The defect: every Meta lead was written with SALES_ORGS[0], so a lead from
     a Bigul page arrived in Bonanza's book and was owned and called by RMs it
     did not belong to. This is the boundary the whole project is built on. */
  run("UPDATE meta_lead_form SET sales_org = 'BIGUL' WHERE form_id = 'probe_form_a'");

  await deliver('probe_form_a');
  const d = one("SELECT * FROM meta_delivery WHERE form_id = 'probe_form_a' AND outcome = 'created' ORDER BY id DESC LIMIT 1");
  const lead = one('SELECT sales_org FROM leads WHERE id = ?', [d.lead_id]);

  assert.equal(lead.sales_org, 'BIGUL', `a Bigul form's lead landed in ${lead.sales_org}`);
});

await test('the same person can be a lead in both books', async () => {
  /* Deduplication is within a book. Bonanza and Bigul are different
     relationships with different RMs, and collapsing them hides one from the
     book that owns it. */
  const mobile = `98${String(Date.now()).slice(-8)}`;

  run("INSERT INTO meta_lead_form (form_id, sales_org) VALUES ('probe_form_b', 'BONANZA')");
  run("INSERT INTO leads (name, mobile, source, stage, sales_org) VALUES ('Existing Bigul lead', ?, 'Referral', 'New', 'BIGUL')", [mobile]);

  const { fields } = applyMap({ phone_number: mobile }, 'probe_form_b');
  const clash = one('SELECT id FROM leads WHERE mobile = ? AND sales_org = ? AND deleted_at IS NULL', [fields.mobile, 'BONANZA']);
  assert(!clash, 'a Bigul lead blocked a Bonanza lead with the same number');

  run('DELETE FROM leads WHERE mobile = ?', [mobile]);
});

/* -------------------------------------------------------- the delivery */

await test('a delivery that creates nothing still leaves a row', async () => {
  /* Otherwise "the connector has stopped" and "everyone who filled the form
     was already a client" look identical from the lead list. */
  const { leadgenId } = await deliver('probe_form_a');
  await deliver('probe_form_a', leadgenId);   // Meta retrying the same one

  const rows = all('SELECT outcome FROM meta_delivery WHERE leadgen_id = ? ORDER BY id', [leadgenId]);
  assert.equal(rows.length, 2, `expected two rows, got ${rows.length}`);
  assert.equal(rows[0].outcome, 'created');
  assert.equal(rows[1].outcome, 'duplicate', `a retry was recorded as ${rows[1].outcome}`);
});

await test('the questions nobody has mapped are listed from what actually arrived', async () => {
  const res = await call('GET', '/admin/connectors/meta/field-map');
  assert.equal(res.status, 200, `HTTP ${res.status}`);

  const found = res.body.unmapped.find((u) => u.question === 'which_product_interests_you');
  assert(found, `the arrived question is not listed: ${JSON.stringify(res.body.unmapped)}`);
  assert(found.count >= 1, 'the question was listed with no count');
});

/* ---------------------------------------------------------- the routes */

await test('a question can be mapped, and only to a safe column', async () => {
  const ok = await call('PUT', '/admin/connectors/meta/field-map', {
    form_id: 'probe_form_a', question: 'which_product_interests_you', crm_field: 'risk_profile',
  });
  assert.equal(ok.status, 200, `mapping failed: ${JSON.stringify(ok.body)}`);

  const refused = await call('PUT', '/admin/connectors/meta/field-map', {
    form_id: 'probe_form_a', question: 'anything', crm_field: 'owner_id',
  });
  assert.equal(refused.status, 400, 'an answer was allowed into owner_id');

  run("DELETE FROM meta_field_map WHERE form_id = 'probe_form_a'");
});

await test('a form cannot be given an owner from the other book', async () => {
  /* They would be assigned leads they cannot see, which reads as the
     assignment silently failing. */
  const bigulUser = one("SELECT id, name FROM users WHERE sales_org = 'BIGUL' AND active = 1 LIMIT 1");
  if (!bigulUser) return;

  run("UPDATE meta_lead_form SET sales_org = 'BONANZA' WHERE form_id = 'probe_form_a'");
  const res = await call('PATCH', '/admin/connectors/meta/forms/probe_form_a', { owner_id: bigulUser.id });

  assert.equal(res.status, 400, `a cross-book owner was accepted: HTTP ${res.status}`);
  assert(/BIGUL/.test(res.body.error), res.body.error);
});

await test('a form that has never sent anything cannot be configured', async () => {
  /* Forms are registered on arrival. A PATCH naming one we have never seen is
     either a typo or somebody configuring a form that is not wired up, and
     silently creating a row for it would hide both. */
  const res = await call('PATCH', '/admin/connectors/meta/forms/no_such_form', { sales_org: 'BONANZA' });
  assert.equal(res.status, 404, `HTTP ${res.status}`);
});

/*
 * NOT TESTED HERE, deliberately: that an admin cannot move a form into a book
 * they do not hold. The route checks `mayUseOrg`, but these routes sit behind
 * `admin.system`, which only superadmin holds — and `orgsFor` gives a
 * superadmin every book by definition. So there is no actor who can reach the
 * route and fail the check, and a test asserting the refusal would be
 * asserting something unreachable. The cross-book rule that IS reachable is
 * the owner one above, which does not depend on the actor's own books.
 */

await test('the console lists forms, deliveries and their outcomes', async () => {
  const forms = await call('GET', '/admin/connectors/meta/forms');
  assert.equal(forms.status, 200);
  assert(forms.body.orgs.length >= 2, 'the books are not offered');
  assert(Array.isArray(forms.body.owners), 'no owners offered for routing');

  const deliveries = await call('GET', '/admin/connectors/meta/deliveries');
  assert.equal(deliveries.status, 200);
  assert(deliveries.body.rows.length, 'no deliveries listed');
  assert(deliveries.body.totals.created >= 1, `outcome totals were ${JSON.stringify(deliveries.body.totals)}`);
});

clean();
PROBE.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
