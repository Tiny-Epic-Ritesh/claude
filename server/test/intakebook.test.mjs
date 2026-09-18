/**
 * Where a public applicant and a partner referral land (OPS-05).
 *
 * The two doors into the CRM with no CRM session behind them — the public DKYC
 * portal and the Partner Portal — each asked the whole firm for a matching
 * mobile, inserted the lead without a `sales_org` (so the column default made
 * it Bonanza whatever the applicant was opening), and handed it to the
 * least-loaded `sales_rm` in either business.
 *
 * Ritesh, 11 Sep 2026: a DKYC journey belongs to the product's book, a referral
 * to the partner's, and a partner may be told about their own book and never
 * the other one. The same person may be a lead in both businesses, so a match
 * in the other book is a different relationship, not a duplicate — the rule the
 * Meta webhook and the import wizard already follow.
 *
 * THE FIXTURE IS THE TEST
 * -----------------------
 * Two RMs are built so that a fix which forgets half the rule fails here rather
 * than passing by luck:
 *
 *   RM_BZ    Bonanza only, empty book — so an owner choice that does not ask
 *            about the book has somebody wrong, and cheap, to pick.
 *   RM_BOTH  both books, Bigul book empty, Bonanza book the heaviest in the
 *            firm — so an owner choice that counts a two-book RM's load across
 *            both businesses picks somebody else for a Bigul lead.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nIntake stays inside one book');

/* ------------------------------------------------------------- fixture */

const RUN = String(Date.now()).slice(-6);
const MARK = `OPS-05 probe ${RUN}`;
const mob = (n) => `9${RUN}00${n}`.slice(0, 10);

const M_BONANZA = mob(1);   // a client of Bonanza's, and of nobody else
const M_BIGUL = mob(2);     // a client of Bigul's
const M_DKYC = mob(3);      // a Bonanza client who then opens a Bigul account

const MOBILES = [M_BONANZA, M_BIGUL, M_DKYC];

const partners = [];
const sweep = () => {
  /* Leads first: a referral points at a partner, and the partner cannot go
     while it does. Everything a lead owns cascades with it. */
  run('DELETE FROM leads WHERE source = ?', [MARK]);
  run(`DELETE FROM leads WHERE mobile IN (${MOBILES.map(() => '?').join(',')})`, MOBILES);
  for (const p of partners) run('DELETE FROM partners WHERE id = ?', [p.id]);
};

sweep();
assert.equal(
  one(`SELECT COUNT(*) n FROM leads WHERE mobile IN (${MOBILES.map(() => '?').join(',')})`, MOBILES).n,
  0,
  'the run-unique mobiles are already on leads — the fixture would be testing somebody else\'s data',
);

const bigulProduct = one(
  "SELECT id FROM product_types WHERE sales_org = 'BIGUL' AND active = 1 AND requires_kyc = 1 ORDER BY sort_order, id LIMIT 1",
);
const bonanzaProduct = one(
  "SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 AND requires_kyc = 1 ORDER BY sort_order, id LIMIT 1",
);
assert(bigulProduct && bonanzaProduct, 'the seed has no KYC-bearing product in each book');

const RM_BZ = await probeAdmin(`ops05bz${RUN}`, { role: 'sales_rm', sales_org: 'BONANZA' });
const RM_BOTH = await probeAdmin(`ops05both${RUN}`, { role: 'sales_rm', sales_org: 'BONANZA' });
run('UPDATE users SET org_access = ? WHERE id = ?', [JSON.stringify(['BONANZA', 'BIGUL']), RM_BOTH.id]);

/* RM_BOTH carries more Bonanza leads than anyone carries anything, so "fewest
   leads" across both books can never be them — while their Bigul book, the one
   that decides a Bigul lead, is empty. */
const heaviest = one(`SELECT COALESCE(MAX(n), 0) AS n FROM (
  SELECT COUNT(*) AS n FROM leads WHERE owner_id IS NOT NULL AND deleted_at IS NULL GROUP BY owner_id)`).n;
for (let i = 0; i <= heaviest; i += 1) {
  run(
    "INSERT INTO leads (sales_org, name, mobile, source, stage, owner_id) VALUES ('BONANZA', ?, NULL, ?, 'New', ?)",
    [`OPS-05 filler ${i}`, MARK, RM_BOTH.id],
  );
}

const seededHash = one(
  'SELECT portal_password FROM partners WHERE portal_password IS NOT NULL ORDER BY id LIMIT 1',
)?.portal_password;
assert(seededHash, 'no seeded partner to borrow a portal password hash from');

const makePartner = (slug, org) => {
  const email = `probe-${slug}-${RUN}@partner.test`;
  const result = run(
    `INSERT INTO partners (sales_org, partner_code, name, business_name, partner_model, state_code,
                           email, portal_password, commission_pct, onboarded_at)
     VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
    [org, `PRB-${slug}-${RUN}`, `Probe ${slug}`, `Probe ${slug} Ltd`, 'Associate', 'ACTIVE', email, seededHash, 0],
  );
  const partner = { id: Number(result.lastInsertRowid), email, org };
  partners.push(partner);
  return partner;
};

const BIGUL_PARTNER = makePartner('bigul', 'BIGUL');
const BIGUL_PARTNER_2 = makePartner('bigul2', 'BIGUL');
const BONANZA_PARTNER = makePartner('bonanza', 'BONANZA');

/* An existing client on each side of the boundary. Unowned, so they weigh
   nothing in any RM's book. */
const seedLead = (org, mobile, name) => Number(run(
  "INSERT INTO leads (sales_org, name, mobile, source, stage) VALUES (?,?,?,?,'New')",
  [org, name, mobile, MARK],
).lastInsertRowid);

const BONANZA_LEAD = seedLead('BONANZA', M_BONANZA, 'OPS-05 Bonanza client');
const BIGUL_LEAD = seedLead('BIGUL', M_BIGUL, 'OPS-05 Bigul client');
const DKYC_LEAD = seedLead('BONANZA', M_DKYC, 'OPS-05 Bonanza client who also opens a Bigul account');

/* ------------------------------------------------------------- helpers */

/**
 * Which books a user holds — the rule in auth.js `orgsFor`, restated rather
 * than imported. A test that asks the implementation whether the implementation
 * is right cannot disagree with it.
 */
const booksOf = (u) => {
  let access = null;
  try { access = u.org_access ? JSON.parse(u.org_access) : null; } catch { access = null; }
  if (Array.isArray(access) && access.length) return access;
  return u.sales_org ? [u.sales_org] : [];
};

/** Who should get the next unrouted lead in this book, asked before it lands.
    Load is open leads in that book: settled ones are finished work (OPS-08). */
const expectedOwner = (org) => all(
  `SELECT u.id, u.sales_org, u.org_access,
          (SELECT COUNT(*) FROM leads l
            WHERE l.owner_id = u.id AND l.sales_org = ? AND l.deleted_at IS NULL
              AND l.stage NOT IN ('Won', 'Lost')) AS book_load
   FROM users u
   WHERE u.role = 'sales_rm' AND u.active = 1
   ORDER BY book_load, u.id`,
  [org],
).find((u) => booksOf(u).includes(org))?.id ?? null;

const partnerToken = async (email) => {
  const res = await fetch(`${BASE}/api/auth/partner-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'partner' }),
  });
  if (!res.ok) throw new Error(`partner login ${email}: HTTP ${res.status}`);
  return (await res.json()).token;
};

const refer = async (token, body) => {
  const res = await fetch(`${BASE}/api/portal/referrals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const dkyc = async (path, body) => {
  const res = await fetch(`${BASE}/dkyc-api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

/* Every field the master journey asks for, submitted at every step. The portal
   sends one step's fields; the test does not care which step it is on, only
   that the journey reaches the end. The account number ends even so the penny
   drop succeeds, and the income and segments stay under the thresholds that
   would add conditional steps. */
const ANSWERS = {
  first_name: 'Probe', last_name: 'Applicant',
  mobile: M_DKYC, otp: '123456',
  email: `probe-ops05-${RUN}@intake.test`, email_otp: '123456',
  pan: 'ABCDE1234F', dob: '1990-01-01', digilocker_consent: true,
  gender: 'Male', marital_status: 'Single', father_spouse: 'Probe Senior',
  address: '1 Probe Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
  trading_experience: 'None', education: 'Graduate', occupation: 'Business',
  annual_income: '₹1–5 Lakh', politically_exposed: 'No',
  account_number: '12345678902', ifsc: 'HDFC0001234', account_holder: 'Probe Applicant',
  nominee_opt: 'Opt out',
  segments: ['Equity Cash'], depository: 'CDSL', plan: 'Classic Percentage Plan',
  selfie: 'probe-selfie.png', signature: 'probe-signature.png', esign_otp: '123456',
};

const walk = async (token, firstStep) => {
  let step = firstStep;
  for (let i = 0; i < 40 && step; i += 1) {
    const { status, body } = await dkyc(`/resume/${token}/step`, { step_code: step, payload: ANSWERS });
    assert.equal(status, 200, `step ${step} returned HTTP ${status}: ${JSON.stringify(body)}`);
    if (body.done) return true;
    step = body.next_step;
  }
  throw new Error('the journey never completed');
};

const journeyByToken = (token) => one('SELECT * FROM kyc_journeys WHERE resume_token = ?', [token]);
const leadById = (id) => one('SELECT * FROM leads WHERE id = ?', [id]);

/* --------------------------------------------------------- the referral */

const bigulToken = await partnerToken(BIGUL_PARTNER.email);
const bigul2Token = await partnerToken(BIGUL_PARTNER_2.email);
const bonanzaToken = await partnerToken(BONANZA_PARTNER.email);

let referredLeadId = null;

await test('a Bigul partner may refer someone who is already a Bonanza client', async () => {
  /* The ruling in one case: this is a second relationship in another business,
     not a duplicate, and the partner is not refused. */
  const owner = expectedOwner('BIGUL');
  const { status, body } = await refer(bigulToken, { name: 'OPS-05 referred client', mobile: M_BONANZA, city: 'Pune' });
  assert.equal(status, 201, `referral refused: ${JSON.stringify(body)}`);

  referredLeadId = body.lead_id;
  const lead = leadById(referredLeadId);
  assert.equal(lead.sales_org, 'BIGUL', `the referral landed in ${lead.sales_org}`);
  assert.equal(lead.partner_id, BIGUL_PARTNER.id, 'the referral is not attributed to the partner');
  assert.equal(lead.owner_id, owner, 'the referral did not go to the least-loaded RM in the partner\'s book');
  assert(booksOf(one('SELECT * FROM users WHERE id = ?', [lead.owner_id])).includes('BIGUL'),
    'the referral is owned by somebody who cannot see Bigul');
});

await test('the Bonanza client it matched is left alone', async () => {
  const lead = leadById(BONANZA_LEAD);
  assert.equal(lead.sales_org, 'BONANZA', 'the existing lead changed book');
  assert.equal(lead.partner_id, null, 'the existing Bonanza lead was attributed to a Bigul partner');
  assert.notEqual(referredLeadId, BONANZA_LEAD, 'the referral was merged into the other book\'s lead');
});

await test('the same partner referring again is told it is already theirs', async () => {
  const { status, body } = await refer(bigulToken, { name: 'OPS-05 again', mobile: M_BONANZA });
  assert.equal(status, 409, `expected a refusal, got HTTP ${status}`);
  assert.equal(body.error, 'You have already referred this client.', body.error);
});

await test('another Bigul partner hears about Bigul, and never about Bonanza', async () => {
  const { status, body } = await refer(bigul2Token, { name: 'OPS-05 second partner', mobile: M_BONANZA });
  assert.equal(status, 409, `expected a refusal, got HTTP ${status}`);
  assert(/Bigul/.test(body.error), `the refusal does not name the partner's own book: ${body.error}`);
  assert(!/Bonanza/.test(body.error), `the refusal told a Bigul partner about Bonanza: ${body.error}`);
});

await test('a Bonanza partner hears about Bonanza, and never about Bigul', async () => {
  const { status, body } = await refer(bonanzaToken, { name: 'OPS-05 bonanza partner', mobile: M_BONANZA });
  assert.equal(status, 409, `expected a refusal, got HTTP ${status}`);
  assert(/Bonanza/.test(body.error), `the refusal does not name the partner's own book: ${body.error}`);
  assert(!/Bigul/.test(body.error), `the refusal told a Bonanza partner about Bigul: ${body.error}`);
});

await test('a Bonanza partner may refer someone who is only a Bigul client', async () => {
  const owner = expectedOwner('BONANZA');
  const { status, body } = await refer(bonanzaToken, { name: 'OPS-05 bonanza referral', mobile: M_BIGUL });
  assert.equal(status, 201, `referral refused: ${JSON.stringify(body)}`);

  const lead = leadById(body.lead_id);
  assert.equal(lead.sales_org, 'BONANZA', `the referral landed in ${lead.sales_org}`);
  assert.equal(lead.owner_id, owner, 'the referral did not go to the least-loaded RM in the partner\'s book');
  assert.equal(leadById(BIGUL_LEAD).partner_id, null, 'the existing Bigul lead was attributed to a Bonanza partner');
});

/* ------------------------------------------------------------ the DKYC */

let bigulToken2 = null;

await test('a Bigul application does not attach itself to the Bonanza record', async () => {
  const { status, body } = await dkyc('/start', { product_type_id: bigulProduct.id, mobile: M_DKYC });
  assert.equal(status, 201, `start refused: ${JSON.stringify(body)}`);

  bigulToken2 = body.resume_token;
  const journey = journeyByToken(bigulToken2);
  assert.equal(journey.lead_id, null,
    'a public Bigul journey attached to a lead in the other book — and its resume token with it');
});

await test('a Bonanza application does attach to it', async () => {
  /* The other half of the same rule: scoping the match must not break it. */
  const { status, body } = await dkyc('/start', { product_type_id: bonanzaProduct.id, mobile: M_DKYC });
  assert.equal(status, 201, `start refused: ${JSON.stringify(body)}`);
  assert.equal(journeyByToken(body.resume_token).lead_id, DKYC_LEAD,
    'a Bonanza journey no longer recognises the Bonanza client it belongs to');
});

await test('a product that names no book is refused', async () => {
  const { status } = await dkyc('/start', { product_type_id: 9_999_999, mobile: M_DKYC });
  assert.equal(status, 400, `expected a refusal, got HTTP ${status}`);
});

await test('finishing the Bigul application creates a Bigul lead, owned in Bigul', async () => {
  const owner = expectedOwner('BIGUL');
  await walk(bigulToken2, journeyByToken(bigulToken2).current_step);

  const journey = journeyByToken(bigulToken2);
  assert(journey.lead_id, 'a completed journey created no lead at all');
  assert.notEqual(journey.lead_id, DKYC_LEAD, 'the applicant was written onto the other book\'s lead');

  const lead = leadById(journey.lead_id);
  assert.equal(lead.sales_org, 'BIGUL', `the DKYC lead landed in ${lead.sales_org}`);
  assert.equal(lead.mobile, M_DKYC, 'the DKYC lead does not carry the applicant\'s mobile');
  assert.equal(lead.owner_id, owner, 'the DKYC lead did not go to the least-loaded RM in the product\'s book');
  assert(booksOf(one('SELECT * FROM users WHERE id = ?', [lead.owner_id])).includes('BIGUL'),
    'the DKYC lead is owned by somebody who cannot see Bigul');
});

await test('the Bonanza record is untouched by the Bigul application', async () => {
  const lead = leadById(DKYC_LEAD);
  assert.equal(lead.sales_org, 'BONANZA', 'the existing lead changed book');
  assert.equal(
    one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND type = 'KYC Event'", [DKYC_LEAD]).n,
    0,
    'the other book\'s lead was told about an application that is not its own',
  );
});

await test('a second Bigul application recognises the Bigul lead it made', async () => {
  /* ensureLead's match, scoped, still matching: the applicant comes back for a
     second Bigul product and is the same person, in this book. */
  const { status, body } = await dkyc('/start', { product_type_id: bigulProduct.id, mobile: M_DKYC });
  assert.equal(status, 201, `start refused: ${JSON.stringify(body)}`);

  const attached = journeyByToken(body.resume_token).lead_id;
  assert(attached, 'the second Bigul journey attached to nothing');
  assert.equal(leadById(attached).sales_org, 'BIGUL', 'the second Bigul journey attached across the book');
});

/* ------------------------------------------------------------- cleanup */

sweep();
RM_BZ.cleanup();
RM_BOTH.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
