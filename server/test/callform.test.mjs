/**
 * The phone call form, and the fields an administrator puts on it. P3-13.
 *
 * The ticket's four acceptance points are: the form opens on an outbound call,
 * it captures a disposition and notes, the result is on the lead's timeline,
 * and an administrator can add, edit, reorder and remove its fields without a
 * code change. The first is a client gesture; the rest are contracts, and this
 * is those.
 *
 * WHAT IS WORTH TESTING HERE
 *
 * Not that a field can be created — Object Manager already does that and has
 * its own tests. What is new is the join: a field configured for one capture
 * form must appear on that form and not the others, must be enforced on the
 * write, and must survive being taken off a form. That last one is the
 * dangerous case. "Remove from the Call form" is a phrase that could plausibly
 * mean deactivate-the-field, and if it ever does, somebody tidying one form
 * silently blanks a year of another form's data.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { formFields } from '../src/engine/metadata.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const PROBE = await probeAdmin('callform', { role: 'superadmin' });

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nCapture forms');

/* ------------------------------------------------------------- fixtures */

const clean = () => {
  const ids = all("SELECT id FROM field_def WHERE entity = 'interaction' AND api_name LIKE 'probe_cf%'").map((f) => f.id);
  for (const id of ids) {
    run('DELETE FROM field_value WHERE field_id = ?', [id]);
    run('DELETE FROM picklist_value WHERE field_id = ?', [id]);
    run('DELETE FROM field_def WHERE id = ?', [id]);
  }
  run("DELETE FROM activities WHERE subject LIKE 'probe_cf%' OR body LIKE 'probe_cf%'");
  run("DELETE FROM leads WHERE name LIKE 'Call form probe%'");
};
clean();

const LEAD = Number(run(
  `INSERT INTO leads (name, mobile, email, source, stage, sales_org, owner_id)
   VALUES ('Call form probe lead', '9800000021', 'probe@callform.test', 'Referral', 'New', 'BONANZA', ?)`,
  [PROBE.id],
).lastInsertRowid);

/** Make a field on Interaction through the same route the screen uses. */
const makeField = async (apiName, patch = {}) => {
  const res = await call('POST', '/setup/objects/interaction/fields', {
    label: patch.label ?? apiName,
    api_name: apiName,
    type: patch.type ?? 'text',
    required: patch.required ? 1 : 0,
    purpose: 'A probe field for the capture form tests',
    owner_user_id: PROBE.id,
    values: patch.values,
  });
  assert.equal(res.status, 201, `could not create ${apiName}: ${JSON.stringify(res.body)}`);
  return res.body;
};

const onForms = async (apiName, types) => {
  const res = await call('PATCH', `/setup/objects/interaction/fields/${apiName}`, { on_activity_types: types });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

/* A Call is refused without an outcome, and rightly — an untagged call is one
   nobody can report on. Read from the table rather than written down here, so a
   reseed that renames the codes does not fail these tests for a reason that has
   nothing to do with capture forms. */
const OUTCOME = one(
  `SELECT code FROM dispositions
    WHERE activity_type = 'Call' AND active = 1
      AND requires_datetime = 0 AND requires_reason = 0
    ORDER BY sort_order LIMIT 1`,
)?.code;
assert(OUTCOME, 'no Call disposition without obligations — the fixture cannot log a call');

const logCall = (body) => call('POST', '/activities', {
  lead_id: LEAD, type: 'Call', disposition: OUTCOME, subject: 'probe_cf call', ...body,
});

/* -------------------------------------------------------- the vocabulary */

await test('a field configured for the Call form is offered on it', async () => {
  await makeField('probe_cf_competitor', { label: 'Competitor mentioned' });
  await onForms('probe_cf_competitor', ['Call']);

  const { body } = await call('GET', '/activities/meta');
  const onCall = body.form_fields.Call.map((f) => f.api_name);
  assert(onCall.includes('probe_cf_competitor'), `Call form carries ${onCall.join(', ')}`);
});

await test('and not on a form it was kept off', async () => {
  const { body } = await call('GET', '/activities/meta');
  const onEmail = body.form_fields.Email.map((f) => f.api_name);
  assert(!onEmail.includes('probe_cf_competitor'),
    'a field configured for the Call form appeared on the Email one');
});

await test('a field that has never said which forms it is on appears on all of them', () => {
  /* The right default. Somebody adding "Competitor mentioned" to Interaction
     almost certainly wants it wherever an interaction is captured, and having
     to opt in per type would mean a field that is configured and invisible —
     which reads as the feature being broken rather than as a setting. */
  run("UPDATE field_def SET on_activity_types = NULL WHERE entity = 'interaction' AND api_name = 'probe_cf_competitor'");
  for (const type of ['Call', 'Meeting', 'Email', 'Visit']) {
    assert(formFields(type).some((f) => f.api_name === 'probe_cf_competitor'),
      `an unassigned field is missing from the ${type} form`);
  }
  run(`UPDATE field_def SET on_activity_types = '["Call"]' WHERE entity = 'interaction' AND api_name = 'probe_cf_competitor'`);
});

await test('a computed field is never put on a form', async () => {
  /* A formula is derived, so a form asking somebody to type one would be asking
     for a value it is about to overwrite. */
  await makeField('probe_cf_derived', { type: 'text' });
  run(`UPDATE field_def SET type = 'formula', storage = 'derived' WHERE entity = 'interaction' AND api_name = 'probe_cf_derived'`);

  assert(!formFields('Call').some((f) => f.api_name === 'probe_cf_derived'),
    'a computed field was offered as something to fill in');
});

/* ------------------------------------------------------------ capturing */

await test('what an RM types on the form is saved with the activity', async () => {
  const res = await logCall({ custom: { probe_cf_competitor: 'Zerodha' } });
  assert([200, 201].includes(res.status), JSON.stringify(res.body));

  const back = await call('GET', `/activities/lead/${LEAD}`);
  const logged = back.body.find((a) => a.subject === 'probe_cf call');
  assert(logged, 'the activity is not on the timeline');
  assert.equal(logged.custom?.probe_cf_competitor, 'Zerodha',
    'the field was captured and does not come back on the timeline');
});

await test('a required field refuses the activity, and names itself', async () => {
  await makeField('probe_cf_reason_code', { label: 'Reason code', required: true });
  await onForms('probe_cf_reason_code', ['Call']);

  const res = await logCall({ custom: { probe_cf_competitor: 'Groww' } });
  assert.equal(res.status, 400, `HTTP ${res.status}`);
  assert(res.body.error.includes('Reason code'), res.body.error);
  assert.equal(res.body.field, 'probe_cf_reason_code');
});

await test('a required field left out entirely is caught, not only one sent empty', () => {
  /* setCustomValues validates the values it is given, which is a different
     question: a field omitted from the body would sail past it. An
     administrator marking a field required means the activity may not be
     logged without it, so the check has to be over the form. */
  assert(formFields('Call').some((f) => f.api_name === 'probe_cf_reason_code' && f.required),
    'the form does not know the field is required');
});

await test('a rejected activity is not left half-written', async () => {
  const before = one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND subject = 'probe_cf reject'", [LEAD]).n;
  await call('POST', '/activities', {
    lead_id: LEAD, type: 'Call', disposition: OUTCOME, subject: 'probe_cf reject', custom: {},
  });
  assert.equal(one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND subject = 'probe_cf reject'", [LEAD]).n, before,
    'the activity was written even though the form was refused');
});

await test('a choice that is not offered is refused', async () => {
  await makeField('probe_cf_channel', {
    label: 'Where they heard of us', type: 'picklist',
    values: [{ value: 'Website', label: 'Website' }, { value: 'Referral', label: 'Referral' }],
  });
  await onForms('probe_cf_channel', ['Call']);

  const res = await logCall({
    subject: 'probe_cf badchoice',
    custom: { probe_cf_reason_code: 'x', probe_cf_channel: 'Billboard' },
  });
  assert.equal(res.status, 400, `HTTP ${res.status}`);
  assert(!one("SELECT id FROM activities WHERE subject = 'probe_cf badchoice'"),
    'the activity survived a refused field value');
});

/* -------------------------------------------------------- configuring it */

await test('the Forms section lists the fields and which forms they are on', async () => {
  const res = await call('GET', '/setup/forms');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert(res.body.types.includes('Call'), 'the Call form is not offered');

  const f = res.body.fields.find((x) => x.api_name === 'probe_cf_competitor');
  assert(f, 'a configured field is missing from the Forms section');
  assert.deepEqual(f.on_activity_types, ['Call']);
});

await test('reordering the form is the order it is drawn in', async () => {
  const res = await call('PATCH', '/setup/forms/Call', {
    fields: ['probe_cf_channel', 'probe_cf_reason_code', 'probe_cf_competitor'],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const drawn = formFields('Call').map((f) => f.api_name).filter((n) => n.startsWith('probe_cf'));
  assert.deepEqual(drawn, ['probe_cf_channel', 'probe_cf_reason_code', 'probe_cf_competitor']);
});

await test('taking a field off one form leaves it on the others, with its data', async () => {
  /* The dangerous case. "Remove from the Call form" could plausibly mean
     deactivate the field — and if it ever does, somebody tidying one form
     silently blanks another form's history. */
  await onForms('probe_cf_competitor', ['Call', 'Meeting']);
  const valuesBefore = one(
    `SELECT COUNT(*) n FROM field_value v JOIN field_def f ON f.id = v.field_id
      WHERE f.api_name = 'probe_cf_competitor'`,
  ).n;
  assert(valuesBefore > 0, 'the fixture has no stored values, so this proves nothing');

  await call('PATCH', '/setup/forms/Call', { fields: ['probe_cf_channel', 'probe_cf_reason_code'] });

  const field = one("SELECT active, on_activity_types FROM field_def WHERE entity = 'interaction' AND api_name = 'probe_cf_competitor'");
  assert.equal(field.active, 1, 'removing a field from a form deactivated it');
  assert.deepEqual(JSON.parse(field.on_activity_types), ['Meeting'], 'it did not stay on the Meeting form');
  assert.equal(
    one(`SELECT COUNT(*) n FROM field_value v JOIN field_def f ON f.id = v.field_id
          WHERE f.api_name = 'probe_cf_competitor'`).n,
    valuesBefore,
    'stored values were destroyed by a form change',
  );
});

await test('a form nobody can log is refused', async () => {
  const res = await call('PATCH', '/setup/forms/Telepathy', { fields: [] });
  assert.equal(res.status, 400, `HTTP ${res.status}`);
});

await test('a field that is not on Interaction cannot be put on its form', async () => {
  const res = await call('PATCH', '/setup/forms/Call', { fields: ['probe_cf_channel', 'not_a_field'] });
  assert.equal(res.status, 400, `HTTP ${res.status}`);
  assert(res.body.error.includes('not_a_field'), res.body.error);
});

await test('configuring a form needs the objects capability', async () => {
  /* A capture form decides what every RM is asked for on every call. It is
     configuration, and it belongs behind the same gate as the fields it draws. */
  const rm = await probeAdmin('callform_rm', { role: 'sales_rm' });
  const res = await fetch(`${BASE}/api/setup/forms`, { headers: rm.headers });
  assert.equal(res.status, 403, `HTTP ${res.status}`);
  rm.cleanup();
});

clean();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
