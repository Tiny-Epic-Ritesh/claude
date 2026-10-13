/**
 * Round 4 — QA-34: the DKYC journey checks what it is told.
 *
 * The auditor completed a public journey with mobile 123, PAN BAD, IFSC BAD,
 * account 123, PIN 000000 and a nominee at 150%, and found mobile 123 and PAN
 * BAD still on the lead afterwards. The step definitions declared most of
 * those rules; nothing enforced them.
 *
 * This walks a real journey through the public API. At each step it first
 * offers the auditor's values -- each must be refused, naming its field, and
 * the journey must not move -- and then valid ones, which must be accepted.
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

console.log('\nRound 4 — QA-34, the DKYC journey checks what it is told');

const RUN = String(Date.now()).slice(-6);
const MOBILE = `9${RUN}007`.slice(0, 10);

const post = async (url, body) => {
  const res = await fetch(`${BASE}/dkyc-api${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const product = one(
  "SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 AND requires_kyc = 1 ORDER BY sort_order, id LIMIT 1",
);
assert(product, 'no KYC-bearing Bonanza product');

const started = await post('/start', { product_type_id: product.id, mobile: MOBILE });
assert.equal(started.status, 201, `the journey did not start: ${started.status}`);
const TOKEN = started.body.resume_token;
const current = () => one('SELECT current_step FROM kyc_journeys WHERE resume_token = ?', [TOKEN]);
// The form is encrypted at rest; the engine reads it back.
const form = () => getJourney(TOKEN, { byToken: true })?.form ?? {};
const submit = (step_code, payload) => post(`/resume/${TOKEN}/step`, { step_code, payload });

/* Valid answers for every step this walk reaches. An even last digit makes
   the simulated penny drop succeed, and the income and segments stay under the
   thresholds that add conditional steps. */
const VALID = {
  MOBILE: { mobile: MOBILE },
  MOBILE_OTP: { otp: '123456' },
  EMAIL: { email: `probe-qa34-${RUN}@example.test` },
  EMAIL_OTP: { email_otp: '123456' },
  PAN: { pan: 'abcde1234f', dob: '1990-01-01' },
  AADHAAR_DIGILOCKER: { digilocker_consent: true },
  PERSONAL: {
    gender: 'Male', marital_status: 'Single', father_spouse: 'Probe Senior',
    address: '1 Probe Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
  },
  FINANCIAL: {
    trading_experience: 'None', education: 'Graduate', occupation: 'Business',
    annual_income: '₹1–5 Lakh', politically_exposed: 'No',
  },
  BANK: { account_number: '12345678902', ifsc: 'HDFC0001234', account_holder: 'Probe Applicant' },
  NOMINEE: { nominee_opt: 'Opt out' },
};

const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

/* What the auditor typed, step by step, and the field each must be refused on. */
const BAD = {
  MOBILE: [[{ mobile: '123' }, 'mobile']],
  EMAIL: [[{ email: 'not-an-email' }, 'email']],
  PAN: [[{ pan: 'BAD', dob: '1990-01-01' }, 'pan'], [{ pan: 'ABCDE1234F', dob: future }, 'dob']],
  AADHAAR_DIGILOCKER: [[{ digilocker_consent: false }, 'digilocker_consent']],
  PERSONAL: [
    [{ ...VALID.PERSONAL, pincode: '000000' }, 'pincode'],
    [{ ...VALID.PERSONAL, gender: 'Unlisted' }, 'gender'],
  ],
  BANK: [
    [{ ...VALID.BANK, account_number: '123' }, 'account_number'],
    [{ ...VALID.BANK, ifsc: 'BAD' }, 'ifsc'],
  ],
  NOMINEE: [
    [{ nominee_opt: 'Add nominee', nominee_name: 'Probe Nominee', nominee_relation: 'Spouse', nominee_share: 150 }, 'nominee_share'],
    [{ nominee_opt: 'Add nominee', nominee_relation: 'Spouse', nominee_share: 100 }, 'nominee_name'],
  ],
};

try {
  for (let guard = 0; guard < 20; guard += 1) {
    const step = current().current_step;
    if (!VALID[step]) break;

    for (const [payload, field] of BAD[step] ?? []) {
      // eslint-disable-next-line no-await-in-loop
      await test(`QA-34 ${step}: ${JSON.stringify(payload).slice(0, 60)} is refused on ${field}`, async () => {
        const res = await submit(step, payload);
        assert.equal(res.status, 400, `accepted with ${res.status}`);
        assert.equal(res.body?.field, field, `refused on ${res.body?.field}: ${res.body?.error}`);
        assert.equal(current().current_step, step, 'the journey moved on anyway');
      });
    }

    // eslint-disable-next-line no-await-in-loop
    await test(`QA-34 ${step}: valid answers are accepted`, async () => {
      const res = await submit(step, VALID[step]);
      assert.equal(res.status, 200, `refused with ${res.status}: ${res.body?.error}`);
    });
  }

  await test('QA-34 the walk reached the segments step', async () => {
    assert.equal(current().current_step, 'SEGMENTS', `stopped at ${current().current_step}`);
  });

  await test('QA-34 a PAN is stored as the step says, upper-cased', async () => {
    assert.equal(form().pan, 'ABCDE1234F');
  });

  await test('QA-34 the portal tells the browser the same rules (source check)', async () => {
    const portal = fs.readFileSync(path.join(HERE, '..', '..', 'client', 'src', 'dkyc', 'DkycPortal.jsx'), 'utf8');
    assert(/pattern=\{field\.pattern\}/.test(portal), 'the pattern is not passed to the input');
  });
} finally {
  run('DELETE FROM kyc_journeys WHERE resume_token = ?', [TOKEN]);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
