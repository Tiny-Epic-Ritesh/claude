/**
 * What Source a Meta lead-ads form stamps on its leads.
 *
 * WHY THIS FILE EXISTS
 *
 * The last of OPS-14. A form's Source was a free-text box, so it could hold
 * anything — the same hole every other writer had, through the one door the
 * ticket said needed care: "its values also arrive from integrations such as
 * Meta lead ads, so a strict check could refuse real leads".
 *
 * So the rule is split, and this file is mostly about the split. Where a person
 * is choosing — the mapping screen — the picklist decides and a value can be
 * added there and then. Where a lead is arriving — the webhook — nothing is
 * ever refused: a configured Source the list no longer holds falls back to the
 * platform's own name and the fallback is recorded. Dropping somebody who
 * filled in an ad form is never the better trade.
 *
 * THE DEFECT NOBODY HAD NOTICED
 *
 * The Instagram default was the string "Instagram", and the Source list holds
 * "Instagram Lead Ads". Every Instagram lead ever created carried a Source no
 * picker offered and no filter reached — which is precisely the thing OPS-14
 * is about, sitting in the default rather than in a user's typing.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { all, one, run } from '../src/db.js';
import { columnPicklist } from '../src/engine/metadata.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nThe Source a Meta form stamps');

/* admin.system, which is what the Meta console asks for. */
const SUPER = await probeAdmin('metasource', { role: 'superadmin' });

const call = async (method, path, body, headers = SUPER.headers) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* Meta sends the platform lowercase, which is what vendors/meta.js matches
   on -- "Instagram" with a capital letter falls through to Facebook, as this
   fixture originally did. */
const deliver = async (formId, platform = 'facebook') => {
  const leadgenId = `src-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${BASE}/api/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'page',
      entry: [{
        changes: [{
          field: 'leadgen',
          value: {
            leadgen_id: leadgenId, form_id: formId, page_id: 'src-probe-page', platform,
          },
        }],
      }],
    }),
  });
  return { body: await res.json().catch(() => null), leadgenId };
};

/* ------------------------------------------------------------- fixtures */

const FORMS = ['src_probe_ok', 'src_probe_retired', 'src_probe_insta'];
const RETIRED = 'Source retired later (probe)';

const SOURCE_FIELD = one("SELECT id FROM field_def WHERE entity = 'lead' AND api_name = 'source'").id;

const clean = () => {
  const ids = all(
    `SELECT lead_id FROM meta_delivery WHERE form_id IN (${FORMS.map(() => '?').join(',')}) AND lead_id IS NOT NULL`,
    FORMS,
  ).map((r) => r.lead_id);
  for (const id of ids) run('DELETE FROM leads WHERE id = ?', [id]);
  run(`DELETE FROM meta_delivery WHERE form_id IN (${FORMS.map(() => '?').join(',')})`, FORMS);
  run(`DELETE FROM meta_lead_form WHERE form_id IN (${FORMS.map(() => '?').join(',')})`, FORMS);
  run('DELETE FROM picklist_value WHERE field_id = ? AND value = ?', [SOURCE_FIELD, RETIRED]);
};
clean();

const leadFor = (leadgenId) => {
  const row = one('SELECT lead_id FROM meta_delivery WHERE leadgen_id = ?', [leadgenId]);
  return row?.lead_id ? one('SELECT * FROM leads WHERE id = ?', [row.lead_id]) : null;
};

const BONANZA_SOURCES = columnPicklist('lead', 'source', 'BONANZA');
const ON_THE_LIST = BONANZA_SOURCES.find((v) => v !== 'Import') ?? BONANZA_SOURCES[0];

try {
  await test('both platform defaults are themselves on the list', () => {
    /* The defect: "Instagram" was the Instagram default and is not a Source.
       Checked as data rather than as a string in the route, because this is the
       assertion that would have caught it. */
    assert(BONANZA_SOURCES.includes('Facebook Lead Ads'), 'the Facebook default is not a Source');
    assert(BONANZA_SOURCES.includes('Instagram Lead Ads'), 'the Instagram default is not a Source');
    assert(!BONANZA_SOURCES.includes('Instagram'),
      'bare "Instagram" is on the list, so this test proves nothing');
  });

  await test('the console offers the Source list of each book it can see', async () => {
    const { status, body } = await call('GET', '/admin/connectors/meta/forms');
    assert.equal(status, 200, `HTTP ${status}`);
    assert(body.sources?.BONANZA?.length, 'no Bonanza sources offered');
    assert(body.sources.BONANZA.includes('Facebook Lead Ads'));
    /* A superadmin holds both books, so both lists are offered -- and they are
       separate lists, which is what the per-business values changed. */
    assert(body.sources?.BIGUL, 'Bigul has no source list in the response');
  });

  await test('a form may only be given a Source that is on the list', async () => {
    await deliver(FORMS[0]);                      // registers the form
    const form = one('SELECT * FROM meta_lead_form WHERE form_id = ?', [FORMS[0]]);
    assert(form, 'the delivery did not register the form');

    const bad = await call('PATCH', `/admin/connectors/meta/forms/${FORMS[0]}`, { source_label: 'Banana' });
    assert.equal(bad.status, 400, `HTTP ${bad.status}: ${JSON.stringify(bad.body)}`);
    assert.equal(bad.body.field, 'source_label');
    assert(/not a permitted value for Source/i.test(bad.body.error), `the reason reads: ${bad.body.error}`);
    assert.equal(one('SELECT source_label FROM meta_lead_form WHERE form_id = ?', [FORMS[0]]).source_label, null,
      'the refused value was stored anyway');

    const good = await call('PATCH', `/admin/connectors/meta/forms/${FORMS[0]}`, { source_label: ON_THE_LIST });
    assert.equal(good.status, 200, `HTTP ${good.status}: ${JSON.stringify(good.body)}`);
    assert.equal(one('SELECT source_label FROM meta_lead_form WHERE form_id = ?', [FORMS[0]]).source_label, ON_THE_LIST);

    /* Blank is a real choice: the lead takes the platform's own name. */
    const blank = await call('PATCH', `/admin/connectors/meta/forms/${FORMS[0]}`, { source_label: '' });
    assert.equal(blank.status, 200, `HTTP ${blank.status}: ${JSON.stringify(blank.body)}`);
    assert.equal(one('SELECT source_label FROM meta_lead_form WHERE form_id = ?', [FORMS[0]]).source_label, null);
  });

  await test("a form cannot be given the other book's Source", async () => {
    const BIGUL_ONLY = 'Bigul only meta probe';
    run(
      `INSERT INTO picklist_value (field_id, value, label, sort_order, sales_org) VALUES (?,?,?,980,'BIGUL')
       ON CONFLICT(field_id, value) DO UPDATE SET active = 1, sales_org = 'BIGUL'`,
      [SOURCE_FIELD, BIGUL_ONLY, BIGUL_ONLY],
    );
    try {
      /* The form is in Bonanza, so a Bigul-only value is refused -- and the
         refusal says which business it belongs to rather than claiming it does
         not exist. */
      const r = await call('PATCH', `/admin/connectors/meta/forms/${FORMS[0]}`, { source_label: BIGUL_ONLY });
      assert.equal(r.status, 400, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
      assert(/another business/i.test(r.body.error), `the reason reads: ${r.body.error}`);

      /* Moving the form to Bigul in the same request makes it legal, because
         the check is against the book the form will be in afterwards. */
      const moved = await call('PATCH', `/admin/connectors/meta/forms/${FORMS[0]}`,
        { sales_org: 'BIGUL', source_label: BIGUL_ONLY });
      assert.equal(moved.status, 200, `HTTP ${moved.status}: ${JSON.stringify(moved.body)}`);
    } finally {
      run('DELETE FROM picklist_value WHERE field_id = ? AND value = ?', [SOURCE_FIELD, BIGUL_ONLY]);
      await call('PATCH', `/admin/connectors/meta/forms/${FORMS[0]}`, { sales_org: 'BONANZA', source_label: '' });
    }
  });

  /* ------------------------------------------------- what arrives */

  await test('a lead arrives with the Source its form was given', async () => {
    await call('PATCH', `/admin/connectors/meta/forms/${FORMS[0]}`, { source_label: ON_THE_LIST });
    const { leadgenId } = await deliver(FORMS[0]);
    const lead = leadFor(leadgenId);
    assert(lead, 'no lead was created');
    assert.equal(lead.source, ON_THE_LIST);
  });

  await test('the Instagram default in the route is the value the list holds', () => {
    /*
     * Read from the source, which is not how this file would rather work.
     *
     * An Instagram lead cannot be driven through the webhook here: the platform
     * does not come from the callback but from `meta.fetchLead`, whose
     * simulation always answers "facebook". Making it answer otherwise would
     * mean changing vendor code to suit a test, which is worse than reading one
     * line of the route.
     *
     * The assertion that matters is the pair above -- both defaults are on the
     * list -- and this one holds the route to using them. The defect was
     * exactly this: the default said "Instagram" and the list says
     * "Instagram Lead Ads".
     */
    const route = readFileSync(new URL('../src/routes/webhooks.js', import.meta.url), 'utf8');
    /* The source line itself, not any mention of Instagram: the route also
       labels a Messenger DM's platform "Instagram", which is correct and is not
       a Source. A looser check matched that instead. */
    assert(
      /platformSource = lead\.platform === 'Instagram' \? 'Instagram Lead Ads' : 'Facebook Lead Ads'/.test(route),
      'the Meta source default is no longer the pair of values the Source list holds',
    );
  });

  await test('a Source retired after it was configured does not cost us the lead', async () => {
    /* The case the original ticket warned about. The form was set up with a
       value that was on the list; somebody later retired it; a lead arrives.
       It must not be dropped, and it must not be written holding a value
       nothing offers. */
    run(
      `INSERT INTO picklist_value (field_id, value, label, sort_order) VALUES (?,?,?,981)
       ON CONFLICT(field_id, value) DO UPDATE SET active = 1`,
      [SOURCE_FIELD, RETIRED, RETIRED],
    );
    await deliver(FORMS[1]);
    const set = await call('PATCH', `/admin/connectors/meta/forms/${FORMS[1]}`, { source_label: RETIRED });
    assert.equal(set.status, 200, `the valid value was refused: ${JSON.stringify(set.body)}`);

    run('UPDATE picklist_value SET active = 0 WHERE field_id = ? AND value = ?', [SOURCE_FIELD, RETIRED]);

    const { leadgenId } = await deliver(FORMS[1]);
    const lead = leadFor(leadgenId);
    assert(lead, 'the lead was dropped because of a retired Source');
    assert.equal(lead.source, 'Facebook Lead Ads',
      `the lead was written with "${lead.source}", which the list no longer holds`);

    /* And it is on the record that we did not do what the form asked. */
    const noted = all(
      "SELECT detail FROM audit_log WHERE action = 'meta_source_fallback' ORDER BY id DESC LIMIT 3",
    ).map((r) => String(r.detail ?? ''));
    assert(noted.some((d) => d.includes(RETIRED)),
      `the fallback is not on the record: ${noted.join(' | ')}`);
  });
} finally {
  clean();
  SUPER.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
