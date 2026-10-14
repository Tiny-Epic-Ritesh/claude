/**
 * QA-34, the rulings of 13 Oct -- "apply standard industry practice":
 *
 *   an applicant under 18 is refused online; a minor's account is opened by
 *   a parent or guardian, offline, as brokers do
 *
 *   one nominee holds 100%, because the depositories' forms require the
 *   shares to add up to 100% and this journey took one nominee -- since 14
 *   Oct it takes up to three, as SEBI's May 2026 circular sets
 *   (nominees.test.mjs), and a lone nominee's share is still the whole of it
 *
 * and the auditor's other point: the journey asked again for the mobile it was
 * started with. It now holds it from the start, and the portal offers it to
 * confirm.
 *
 * Walked through the public API, as round4c is.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { getJourney } from '../src/engine/kyc.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nQA-34 — the age and nominee rulings, and the starting mobile');

const RUN = String(Date.now()).slice(-6);
const MOBILE = `8${RUN}034`.slice(0, 10);
const post = async (url, body) => {
  const res = await fetch(`${BASE}/dkyc-api${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const get = async (url) => {
  const res = await fetch(`${BASE}/dkyc-api${url}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

const product = one(
  "SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 AND requires_kyc = 1 ORDER BY sort_order, id LIMIT 1",
);

/** IST today, shifted by whole years, as YYYY-MM-DD. */
const istToday = one("SELECT date('now', '+330 minutes') d").d;
const yearsAgo = (n, dayOffset = 0) => {
  const d = new Date(`${istToday}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - n);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
};

const VALID = {
  MOBILE: { mobile: MOBILE },
  MOBILE_OTP: { otp: '123456' },
  EMAIL: { email: `probe-qa34b-${RUN}@example.test` },
  EMAIL_OTP: { email_otp: '123456' },
  PAN: { pan: 'ABCDE1234F', dob: '1990-01-01' },
  AADHAAR_DIGILOCKER: { digilocker_consent: true },
  PERSONAL: {
    gender: 'Female', marital_status: 'Single', father_spouse: 'Probe Senior',
    address: '1 Probe Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
  },
  FINANCIAL: {
    trading_experience: 'None', education: 'Graduate', occupation: 'Business',
    annual_income: '₹1–5 Lakh', politically_exposed: 'No',
  },
  BANK: { account_number: '12345678902', ifsc: 'HDFC0001234', account_holder: 'Probe Applicant' },
  NOMINEE: { nominee_opt: 'Opt out', optout_declaration: true },
};
const NOMINEE = {
  name: 'Probe Nominee', relationship: 'Spouse', id_type: 'PAN', id_number: 'PQRSX1234Z',
  address: '2 Probe Lane, Pune', mobile: '9876500001', email: 'nominee@example.test',
};

const tokens = [];
const start = async (mobile) => {
  const res = await post('/start', { product_type_id: product.id, ...(mobile ? { mobile } : {}) });
  assert.equal(res.status, 201, `the journey did not start: ${res.status} ${res.body?.error}`);
  tokens.push(res.body.resume_token);
  return res.body.resume_token;
};
const current = (token) => one('SELECT current_step FROM kyc_journeys WHERE resume_token = ?', [token]).current_step;
const submit = (token, step_code, payload) => post(`/resume/${token}/step`, { step_code, payload });
/** Walk valid answers until the named step is the current one. */
const walkTo = async (token, target) => {
  for (let guard = 0; guard < 20 && current(token) !== target; guard += 1) {
    const step = current(token);
    if (!VALID[step]) throw new Error(`the walk has no answer for ${step} on the way to ${target}`);
    // eslint-disable-next-line no-await-in-loop
    const res = await submit(token, step, VALID[step]);
    if (res.status !== 200) throw new Error(`${step} refused: ${res.body?.error}`);
  }
  assert.equal(current(token), target, `the walk stopped at ${current(token)}`);
};

try {
  /* ============================================================ the mobile */

  await test('a journey started with a mobile holds it, so the mobile step offers it to confirm', async () => {
    const token = await start(MOBILE);
    const resumed = await get(`/resume/${token}`);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.current_step, 'MOBILE');
    assert.equal(resumed.body.form?.mobile, MOBILE, 'the starting mobile is not on the application');
    const confirmed = await submit(token, 'MOBILE', { mobile: MOBILE });
    assert.equal(confirmed.status, 200, `confirming it answered ${confirmed.status}: ${confirmed.body?.error}`);
  });

  await test('the portal fills a step from what the application holds (source check)', async () => {
    const src = fs.readFileSync(path.join(HERE, '..', '..', 'client', 'src', 'dkyc', 'DkycPortal.jsx'), 'utf8');
    assert(/journey\.form\?\.\[f\.name\]/.test(src), 'the portal does not seed a step from the form');
  });

  /* ============================================================ age */

  await test('an applicant under 18 is refused, and told where to go instead', async () => {
    const token = await start();
    await walkTo(token, 'PAN');
    const minor = await submit(token, 'PAN', { pan: 'ABCDE1234F', dob: yearsAgo(18, 1) });
    assert.equal(minor.status, 400, `a 17-year-old was accepted (${minor.status})`);
    assert.equal(minor.body.field, 'dob');
    assert.match(minor.body.error, /18 or over/);
    assert.equal(current(token), 'PAN', 'the journey moved on anyway');
  });

  await test('an applicant who turns 18 today is accepted', async () => {
    const token = await start();
    await walkTo(token, 'PAN');
    const adult = await submit(token, 'PAN', { pan: 'ABCDE1234F', dob: yearsAgo(18) });
    assert.equal(adult.status, 200, `refused: ${adult.body?.error}`);
  });

  /* ============================================================ nominee */

  await test('a lone nominee holds 100%: a smaller share is refused, the whole is accepted', async () => {
    const token = await start();
    await walkTo(token, 'NOMINEE');
    const statement = 'The names of my nominees';
    const part = await submit(token, 'NOMINEE', { nominee_opt: 'Add nominee', nominee_statement: statement, nominees: [{ ...NOMINEE, share: 60 }] });
    assert.equal(part.status, 400, `a 60% share was accepted (${part.status})`);
    assert.equal(part.body.field, 'nominees');
    assert.match(part.body.error, /100%/);
    const whole = await submit(token, 'NOMINEE', { nominee_opt: 'Add nominee', nominee_statement: statement, nominees: [{ ...NOMINEE, share: 100 }] });
    assert.equal(whole.status, 200, `refused: ${whole.body?.error}`);
    assert.equal(getJourney(token, { byToken: true }).form.nominees[0].share, 100);
  });

  await test('opting out needs no share, and does need the declaration', async () => {
    const token = await start();
    await walkTo(token, 'NOMINEE');
    const bare = await submit(token, 'NOMINEE', { nominee_opt: 'Opt out' });
    assert.equal(bare.status, 400, 'an opt-out without the declaration was accepted');
    assert.equal(bare.body.field, 'optout_declaration');
    const out = await submit(token, 'NOMINEE', { nominee_opt: 'Opt out', optout_declaration: true });
    assert.equal(out.status, 200, `refused: ${out.body?.error}`);
  });

  /* ======================================================== QA-13 plans */

  await test('QA-13 a Bonanza applicant is offered Bonanza\'s plans, not Bigul\'s flat plan', async () => {
    const token = await start();
    await walkTo(token, 'SEGMENTS');
    const view = await get(`/resume/${token}`);
    const plan = view.body.steps.find((s) => s.code === 'SEGMENTS').fields.find((f) => f.name === 'plan');
    assert(!plan.options.some((o) => /Bigul/.test(o)), `offered: ${plan.options.join(', ')}`);
    assert(!('options_by_business' in plan), 'the table of every business\'s plans reached the applicant');
    const refused = await submit(token, 'SEGMENTS', { segments: ['Equity Cash'], depository: 'CDSL', plan: 'Bigul Flat ₹0 Delivery' });
    assert.equal(refused.status, 400, `Bigul's plan was accepted on a Bonanza application (${refused.status})`);
    assert.equal(refused.body.field, 'plan');
    const ok = await submit(token, 'SEGMENTS', { segments: ['Equity Cash'], depository: 'CDSL', plan: 'Classic Percentage Plan' });
    assert.equal(ok.status, 200, `refused: ${ok.body?.error}`);
  });
} finally {
  for (const t of tokens) run('DELETE FROM kyc_journeys WHERE resume_token = ?', [t]);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
