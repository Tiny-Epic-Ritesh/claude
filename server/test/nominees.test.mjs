/**
 * Nominees, as SEBI's circular of 10 January 2025 sets them. Ruled 14 Oct:
 * support multiple nominees.
 *
 *   up to 10; an identifier each (PAN, driving licence, or Aadhaar's last 4 --
 *   the number only); full contact details; a date of birth only for a minor,
 *   a guardian optional; shares all given and adding to 100, or none, split
 *   equally; at most one adult who may operate the account if the investor is
 *   incapacitated; and an opt-out that is affirmed, not assumed.
 *
 * The rules first, as the engine checks them; then a journey through the
 * public API; then the CRM's view, where a nominee's details are masked like
 * the applicant's own.
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

console.log('\nNominees — up to ten, as SEBI\'s January 2025 circular sets them');

const RUN = String(Date.now()).slice(-6);
const FIELD = stepByCode('NOMINEE').fields.find((f) => f.name === 'nominees');
const TODAY = new Date().toISOString().slice(0, 10);
const yearsAgo = (n) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); return d.toISOString().slice(0, 10); };

const nominee = (i, extra = {}) => ({
  name: `Probe Nominee ${i}`, relationship: 'Son', id_type: 'PAN', id_number: `PQRSX${1000 + i}Z`,
  address: `${i} Probe Lane, Pune`, mobile: `98765${String(10000 + i).slice(-5)}`, email: `nominee${i}@example.test`, ...extra,
});
const check = (list, applicantPan = 'ABCDE1234F') => validateNominees(list, FIELD, { applicantPan, today: TODAY });
const refused = (list, pattern, applicantPan) => {
  const { problems } = check(list, applicantPan);
  assert(problems.length, `accepted: ${JSON.stringify(list).slice(0, 120)}`);
  assert(problems.some((p) => pattern.test(p.message)), `refused for another reason: ${problems.map((p) => p.message).join(' | ')}`);
};

/* Each test that writes to the database removes what it made in its own finally. */
{
  /* ============================================================ the rules */

  await test('up to ten nominees are accepted, and an eleventh is refused', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => nominee(i + 1));
    assert.deepEqual(check(ten).problems, []);
    refused([...ten, nominee(11)], /up to 10/);
  });

  await test('each identifier is checked as its own kind of number', async () => {
    assert.deepEqual(check([nominee(1, { id_type: 'Driving licence', id_number: 'MH14 2011 0062821' })]).problems, []);
    assert.deepEqual(check([nominee(1, { id_type: 'Aadhaar (last 4 digits)', id_number: '4821' })]).problems, []);
    refused([nominee(1, { id_number: 'BAD' })], /PAN number is not valid/);
    refused([nominee(1, { id_type: 'Aadhaar (last 4 digits)', id_number: '123456789012' })], /last 4 digits/);
    refused([nominee(1, { id_type: 'Passport', id_number: 'Z1234567' })], /choose PAN, driving licence/);
  });

  await test('a driving licence is stored as one run of characters', async () => {
    const { nominees } = check([nominee(1, { id_type: 'Driving licence', id_number: 'mh14-2011-0062821' })]);
    assert.equal(nominees[0].id_number, 'MH1420110062821');
  });

  await test('contact details are required: address, mobile and email', async () => {
    refused([nominee(1, { address: '' })], /postal address/);
    refused([nominee(1, { mobile: '12345' })], /mobile/);
    refused([nominee(1, { email: 'nobody' })], /email/);
  });

  await test('a minor needs a date of birth that makes them a minor; an adult\'s is not kept', async () => {
    refused([nominee(1, { minor: true })], /date of birth/);
    refused([nominee(1, { minor: true, dob: yearsAgo(20) })], /18 or over/);
    const minor = check([nominee(1, { minor: true, dob: yearsAgo(10), guardian_name: 'Probe Guardian' })]);
    assert.deepEqual(minor.problems, []);
    assert.equal(minor.nominees[0].guardian_name, 'Probe Guardian');
    const adult = check([nominee(1, { dob: yearsAgo(40), guardian_name: 'Nobody' })]);
    assert.equal(adult.nominees[0].dob, null, 'an adult nominee\'s date of birth was kept');
    assert.equal(adult.nominees[0].guardian_name, null);
  });

  await test('shares are all given and add up to 100, or all blank and split equally', async () => {
    assert.deepEqual(check([nominee(1), nominee(2), nominee(3)]).problems, [], 'blank shares were refused');
    assert.deepEqual(check([nominee(1, { share: 33.33 }), nominee(2, { share: 33.33 }), nominee(3, { share: 33.34 })]).problems, [],
      'two-decimal shares adding to 100 were refused');
    refused([nominee(1, { share: 60 }), nominee(2, { share: 30 })], /add up to 90%/);
    refused([nominee(1, { share: 60 }), nominee(2)], /every nominee a share, or leave every share blank/);
    refused([nominee(1, { share: 100.5 })], /up to 100/);
  });

  await test('one adult nominee at most may operate the account', async () => {
    assert.deepEqual(check([nominee(1, { may_operate: true, operate_limit_pct: 50 }), nominee(2)]).problems, []);
    refused([nominee(1, { may_operate: true }), nominee(2, { may_operate: true })], /Only one nominee/);
    refused([nominee(1, { minor: true, dob: yearsAgo(10), may_operate: true })], /minor nominee cannot operate/);
  });

  await test('two nominees cannot be one person, and nobody nominates themselves', async () => {
    refused([nominee(1), nominee(2, { id_number: nominee(1).id_number })], /same PAN number as nominee 1/);
    refused([nominee(1, { id_number: 'ABCDE1234F' })], /cannot nominate yourself/, 'ABCDE1234F');
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
    await test('the journey takes several nominees and stores them, split equally when no share is given', async () => {
      toNominee();
      const res = await submit({ nominee_opt: 'Add nominee', nominee_statement: 'The names of my nominees', nominees: [nominee(1), nominee(2)] });
      assert.equal(res.status, 200, `refused: ${res.body?.error}`);
      const form = getJourney(token, { byToken: true }).form;
      assert.equal(form.nominees.length, 2);
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
      const bare = await submit({ nominee_opt: 'Opt out' });
      assert.equal(bare.status, 400);
      assert.equal(bare.body.field, 'optout_declaration');
      toNominee();
      const out = await submit({ nominee_opt: 'Opt out', optout_declaration: true, nominees: [nominee(1)] });
      assert.equal(out.status, 200, `refused: ${out.body?.error}`);
      assert.equal(getJourney(token, { byToken: true }).form.nominees, null, 'the earlier nominees survived an opt-out');
    });
  } finally {
    run('DELETE FROM kyc_journeys WHERE resume_token = ?', [token]);
  }

  /* ============================================================== the CRM */

  await test('in the CRM, a nominee\'s mobile, email and identifier are masked like the applicant\'s', async () => {
    const RM = await probeAdmin('nominees-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
    const lead = Number(run("INSERT INTO leads (sales_org, name, source, stage, owner_id) VALUES ('BONANZA', ?, 'Website', 'New', ?)",
      [`NM probe ${RUN}`, RM.id]).lastInsertRowid);
    const journey = createJourney({ leadId: lead, productTypeId: product.id });
    const n = nominee(7);
    run('UPDATE kyc_journeys SET form_data = ? WHERE id = ?', [encryptField(JSON.stringify({ nominee_opt: 'Add nominee', nominees: [n] })), journey.id]);
    try {
      const res = await fetch(`${BASE}/api/kyc/journeys/${journey.id}`, { headers: RM.headers });
      assert.equal(res.status, 200, `the RM cannot open their own lead's journey (${res.status})`);
      const body = await res.json();
      const seen = body.form.nominees[0];
      assert.equal(seen.name, n.name);
      assert.notEqual(seen.mobile, n.mobile, 'the nominee\'s mobile reached a masked role in the clear');
      assert.notEqual(seen.email, n.email, 'the nominee\'s email reached a masked role in the clear');
      assert.notEqual(seen.id_number, n.id_number, 'the nominee\'s PAN reached a masked role in the clear');
    } finally {
      run('DELETE FROM kyc_journeys WHERE id = ?', [journey.id]);
      run('DELETE FROM leads WHERE id = ?', [lead]);
      RM.cleanup();
    }
  });

  await test('the portal draws the nominee list, and only for the answer it belongs to (source check)', async () => {
    const page = fs.readFileSync(path.join(HERE, '..', '..', 'client', 'src', 'dkyc', 'DkycPortal.jsx'), 'utf8');
    assert(/function NomineesField/.test(page), 'no nominee list');
    assert(/field\.type === 'nominees'/.test(page), 'the nominee list is never drawn');
    assert(/const shownFields = \(step\?\.fields \|\| \[\]\)\.filter\(isShown\)/.test(page), 'every field is drawn whatever the answer');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
