/**
 * Nominees, as SEBI's circular of 29 May 2026 sets them
 * (SEBI/HO/OIAE/OIAE_IAD-3/P/CIR/2026/12676, in force from 1 Sep 2026).
 * Ruled 14 Oct: follow it. It supersedes the January 2025 circular the step
 * was first built to.
 *
 *   up to 3; only the name and relationship required, and a minor's date of
 *   birth; a share, mobile, email and identifier optional -- Aadhaar's last
 *   4, PAN, driving licence or passport, the number only -- and the same for
 *   a minor's guardian; what is given is checked; shares all given and
 *   adding to 100, or none, split equally; and an opt-out that shows the
 *   Annexure-B declaration in full and is affirmed, not assumed.
 *
 * The rules first, as the engine checks them; then a journey through the
 * public API; then the CRM's view, where a nominee's and a guardian's details
 * are masked like the applicant's own.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { encryptField } from '../src/security.js';
import { getJourney, stepByCode, validateNominees, createJourney } from '../src/engine/kyc.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nNominees — up to three, as SEBI\'s May 2026 circular sets them');

const RUN = String(Date.now()).slice(-6);
const STEP = stepByCode('NOMINEE');
const FIELD = STEP.fields.find((f) => f.name === 'nominees');
const TODAY = new Date().toISOString().slice(0, 10);
const yearsAgo = (n) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); return d.toISOString().slice(0, 10); };

/* Everything the form can take, optional details included. */
const nominee = (i, extra = {}) => ({
  name: `Probe Nominee ${i}`, relationship: 'Son', id_type: 'PAN', id_number: `PQRSX${1000 + i}Z`,
  mobile: `98765${String(10000 + i).slice(-5)}`, email: `nominee${i}@example.test`, ...extra,
});
/* Only what the circular requires. */
const bare = (i, extra = {}) => ({ name: `Probe Nominee ${i}`, relationship: 'Daughter', ...extra });
const check = (list, applicantPan = 'ABCDE1234F') => validateNominees(list, FIELD, { applicantPan, today: TODAY });
const refused = (list, pattern, applicantPan) => {
  const { problems } = check(list, applicantPan);
  assert(problems.length, `accepted: ${JSON.stringify(list).slice(0, 120)}`);
  assert(problems.some((p) => pattern.test(p.message)), `refused for another reason: ${problems.map((p) => p.message).join(' | ')}`);
};

/* Each test that writes to the database removes what it made in its own finally. */
{
  /* ============================================================ the rules */

  await test('up to three nominees are accepted, and a fourth is refused (5.1)', async () => {
    assert.equal(FIELD.max, 3);
    const three = [nominee(1), nominee(2), nominee(3)];
    assert.deepEqual(check(three).problems, []);
    refused([...three, nominee(4)], /up to 3/);
  });

  await test('only the name and relationship are required (7a)', async () => {
    const { problems, nominees } = check([bare(1)]);
    assert.deepEqual(problems, [], 'a nominee with only a name and a relationship was refused');
    for (const k of ['mobile', 'email', 'id_type', 'id_number', 'share']) {
      assert.equal(nominees[0][k], null, `an optional ${k} nobody gave was stored as ${JSON.stringify(nominees[0][k])}`);
    }
    refused([bare(1, { name: '' })], /full name/);
    refused([bare(1, { relationship: '' })], /relationship/);
  });

  await test('the old form\'s address and incapacity operator are gone from what is stored', async () => {
    const { nominees } = check([nominee(1, { address: '1 Probe Lane', may_operate: true, operate_limit_pct: 50 })]);
    for (const k of ['address', 'may_operate', 'operate_limit_pct']) {
      assert(!(k in nominees[0]), `${k} is still stored`);
    }
  });

  await test('an identifier, when given, is checked as its own kind of number; passport included', async () => {
    assert.deepEqual(check([nominee(1, { id_type: 'Driving licence', id_number: 'MH14 2011 0062821' })]).problems, []);
    assert.deepEqual(check([nominee(1, { id_type: 'Aadhaar (last 4 digits)', id_number: '4821' })]).problems, []);
    assert.deepEqual(check([nominee(1, { id_type: 'Passport', id_number: 'z1234567' })]).problems, []);
    refused([nominee(1, { id_number: 'BAD' })], /PAN number is not valid/);
    refused([nominee(1, { id_type: 'Aadhaar (last 4 digits)', id_number: '123456789012' })], /last 4 digits/);
    refused([nominee(1, { id_type: 'Passport', id_number: '12345678' })], /Passport number is not valid/);
    refused([bare(1, { id_number: 'ABCDE1234F' })], /say which identifier/);
    assert.equal(check([nominee(1, { id_type: 'Passport', id_number: '' })]).nominees[0].id_type, null,
      'a type with no number was stored as an identifier');
  });

  await test('a driving licence is stored as one run of characters', async () => {
    const { nominees } = check([nominee(1, { id_type: 'Driving licence', id_number: 'mh14-2011-0062821' })]);
    assert.equal(nominees[0].id_number, 'MH1420110062821');
  });

  await test('a mobile or email, when given, must work; when left blank, it is not asked for', async () => {
    assert.deepEqual(check([nominee(1, { mobile: '', email: '' })]).problems, []);
    refused([nominee(1, { mobile: '12345' })], /mobile/);
    refused([nominee(1, { email: 'nobody' })], /email/);
  });

  await test('a minor needs a date of birth; a guardian and their details are optional, and checked when given', async () => {
    refused([bare(1, { minor: true })], /date of birth/);
    refused([bare(1, { minor: true, dob: yearsAgo(20) })], /18 or over/);
    assert.deepEqual(check([bare(1, { minor: true, dob: yearsAgo(10) })]).problems, [], 'a minor with no guardian was refused');
    const minor = check([bare(1, {
      minor: true, dob: yearsAgo(10), guardian_name: 'Probe Guardian', guardian_relation: 'Mother',
      guardian_mobile: '9876500001', guardian_id_type: 'PAN', guardian_id_number: 'GHIJK5678L',
    })]);
    assert.deepEqual(minor.problems, []);
    assert.equal(minor.nominees[0].guardian_name, 'Probe Guardian');
    assert.equal(minor.nominees[0].guardian_id_number, 'GHIJK5678L');
    refused([bare(1, { minor: true, dob: yearsAgo(10), guardian_mobile: '42' })], /guardian: a mobile/);

    const adult = check([nominee(1, { dob: yearsAgo(40), guardian_name: 'Nobody', guardian_mobile: '9876500001' })]);
    assert.equal(adult.nominees[0].dob, null, 'an adult nominee\'s date of birth was kept');
    assert.equal(adult.nominees[0].guardian_name, null);
    assert.equal(adult.nominees[0].guardian_mobile, null);
  });

  await test('shares are all given and add up to 100, or all blank and split equally', async () => {
    assert.deepEqual(check([nominee(1), nominee(2), nominee(3)]).problems, [], 'blank shares were refused');
    assert.deepEqual(check([nominee(1, { share: 33.33 }), nominee(2, { share: 33.33 }), nominee(3, { share: 33.34 })]).problems, [],
      'two-decimal shares adding to 100 were refused');
    refused([nominee(1, { share: 60 }), nominee(2, { share: 30 })], /add up to 90%/);
    refused([nominee(1, { share: 60 }), nominee(2)], /every nominee a share, or leave every share blank/);
    refused([nominee(1, { share: 100.5 })], /up to 100/);
  });

  await test('two nominees cannot be one person, and nobody nominates themselves -- where an identifier says so', async () => {
    refused([nominee(1), nominee(2, { id_number: nominee(1).id_number })], /same PAN number as nominee 1/);
    refused([nominee(1, { id_number: 'ABCDE1234F' })], /cannot nominate yourself/, 'ABCDE1234F');
    assert.deepEqual(check([bare(1), bare(2)]).problems, [], 'two nominees with no identifiers were taken for one person');
  });

  await test('opting out shows the Annexure-B declaration in full (8b)', async () => {
    const consent = STEP.fields.find((f) => f.name === 'optout_declaration');
    const words = [consent.declaration.title, consent.declaration.lead, ...consent.declaration.understand, consent.label].join(' ');
    for (const phrase of ['do not wish to appoint any nominee', 'faster and smoother transmission',
      'court-issued documents', 'Investor Education and protection Fund Authority (IEPF)', 'my decision to opt out of nomination is voluntary']) {
      assert(words.includes(phrase), `the declaration is missing "${phrase}"`);
    }
  });

  /* ========================================================== the journey */

  const product = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 AND requires_kyc = 1 ORDER BY sort_order, id LIMIT 1");
  const post = async (url, body) => {
    const res = await fetch(`${BASE}/dkyc-api${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const started = await post('/start', { product_type_id: product.id });
  const token = started.body.resume_token;
  const toNominee = () => run("UPDATE kyc_journeys SET current_step = 'NOMINEE' WHERE resume_token = ?", [token]);
  const submit = (payload) => post(`/resume/${token}/step`, { step_code: 'NOMINEE', payload });

  try {
    await test('the journey takes nominees with only a name and relationship, split equally when no share is given', async () => {
      toNominee();
      const res = await submit({ nominee_opt: 'Add nominee', nominee_statement: 'The names of my nominees', nominees: [bare(1), nominee(2)] });
      assert.equal(res.status, 200, `refused: ${res.body?.error}`);
      const form = getJourney(token, { byToken: true }).form;
      assert.equal(form.nominees.length, 2);
      assert.equal(form.nominees[0].mobile, null);
      assert.equal(form.nominees[1].name, 'Probe Nominee 2');
      assert(form.nominees.every((n) => n.share === null), 'a blank share was stored as something');
      assert.equal(form.nominee_statement, 'The names of my nominees');
    });

    await test('every problem comes back at once, each naming its nominee', async () => {
      toNominee();
      const res = await submit({ nominee_opt: 'Add nominee', nominee_statement: 'The names of my nominees',
        nominees: [nominee(1, { email: 'x' }), nominee(2, { mobile: '1' })] });
      assert.equal(res.status, 400);
      const said = res.body.problems.map((p) => p.message).join(' | ');
      assert(/Nominee 1/.test(said) && /Nominee 2/.test(said), `the problems were: ${said}`);
    });

    await test('opting out is affirmed, and it clears any nominees given earlier', async () => {
      toNominee();
      const unaffirmed = await submit({ nominee_opt: 'Opt out' });
      assert.equal(unaffirmed.status, 400);
      assert.equal(unaffirmed.body.field, 'optout_declaration');
      toNominee();
      const out = await submit({ nominee_opt: 'Opt out', optout_declaration: true, nominees: [nominee(1)] });
      assert.equal(out.status, 200, `refused: ${out.body?.error}`);
      assert.equal(getJourney(token, { byToken: true }).form.nominees, null, 'the earlier nominees survived an opt-out');
    });
  } finally {
    run('DELETE FROM kyc_journeys WHERE resume_token = ?', [token]);
  }

  /* ============================================================== the CRM */

  await test('in the CRM, a nominee\'s and a guardian\'s mobile, email and identifier are masked like the applicant\'s', async () => {
    const RM = await probeAdmin('nominees-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
    const lead = Number(run("INSERT INTO leads (sales_org, name, source, stage, owner_id) VALUES ('BONANZA', ?, 'Website', 'New', ?)",
      [`NM probe ${RUN}`, RM.id]).lastInsertRowid);
    const journey = createJourney({ leadId: lead, productTypeId: product.id });
    const n = nominee(7, {
      minor: true, dob: yearsAgo(9), guardian_name: 'Probe Guardian',
      guardian_mobile: '9876500077', guardian_email: 'guardian7@example.test', guardian_id_type: 'PAN', guardian_id_number: 'GHIJK7777L',
    });
    run('UPDATE kyc_journeys SET form_data = ? WHERE id = ?', [encryptField(JSON.stringify({ nominee_opt: 'Add nominee', nominees: [n] })), journey.id]);
    try {
      const res = await fetch(`${BASE}/api/kyc/journeys/${journey.id}`, { headers: RM.headers });
      assert.equal(res.status, 200, `the RM cannot open their own lead's journey (${res.status})`);
      const body = await res.json();
      const seen = body.form.nominees[0];
      assert.equal(seen.name, n.name);
      for (const k of ['mobile', 'email', 'id_number', 'guardian_mobile', 'guardian_email', 'guardian_id_number']) {
        assert.notEqual(seen[k], n[k], `the ${k} reached a masked role in the clear`);
      }
    } finally {
      run('DELETE FROM kyc_journeys WHERE id = ?', [journey.id]);
      run('DELETE FROM leads WHERE id = ?', [lead]);
      RM.cleanup();
    }
  });

  await test('the portal draws the nominee list and the full declaration, each only for its answer (source check)', async () => {
    const page = fs.readFileSync(path.join(HERE, '..', '..', 'client', 'src', 'dkyc', 'DkycPortal.jsx'), 'utf8');
    assert(/function NomineesField/.test(page), 'no nominee list');
    assert(/field\.type === 'nominees'/.test(page), 'the nominee list is never drawn');
    assert(/field\.declaration/.test(page), 'the opt-out declaration is never drawn');
    assert(!/may_operate/.test(page), 'the portal still offers the incapacity operator');
    assert(/const shownFields = \(step\?\.fields \|\| \[\]\)\.filter\(isShown\)/.test(page), 'every field is drawn whatever the answer');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
