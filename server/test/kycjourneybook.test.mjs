/**
 * An RM-initiated KYC journey stays inside the caller's book. OPS-07.
 *
 * WHY THIS FILE EXISTS
 *
 * OPS-05 closed the public half of this: `/dkyc-api/start` and `ensureLead()`
 * now take their book from the product the applicant chose. The internal half
 * -- `POST /api/kyc/journeys`, the button an RM presses in the CRM -- was left
 * with two holes, and it is the more dangerous of the two because it is the one
 * a signed-in user can aim.
 *
 * 1. The lead was read as `SELECT * FROM leads WHERE id = ?`, with no
 *    visibility scope at all, while `GET /journeys/:id` three lines above it
 *    built one with `reqScope` and returned 403. So a product RM could name any
 *    lead id in the firm and have that lead's mobile and email copied onto a
 *    new journey -- and the reply hands back `applicant_url`, which carries the
 *    journey's `resume_token`. That is a live bearer link into the other book's
 *    KYC, not merely a record disclosure.
 *
 * 2. Nothing checked that the product and the lead were in the same book. The
 *    journey's steps come from the product's own `kyc_journey_steps`, so a
 *    Bonanza lead could be walked through Bigul's journey definition for a
 *    product Bonanza does not sell.
 *
 * WHAT IT CHECKS
 *
 * Both refusals, and -- the half that makes them worth having -- that the route
 * still starts a journey normally inside one book. A guard that refuses
 * everything would satisfy the first three tests on its own.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nKYC journey book scope');

/* Once, at the top: a burst of sign-ins against one account is what the login
   rate limiter watches for, and the session does not change between tests. */
const ACTOR = 'productsupervisor@bonanza.test';
const TOKEN = await (async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ACTOR, password: 'bonanza' }),
  });
  if (!res.ok) throw new Error(`${ACTOR} could not sign in: HTTP ${res.status}`);
  return (await res.json()).token;
})();

const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

/* The actor is a Bonanza product supervisor: it holds `kyc.manage`, so it gets
   past the capability gate and the book boundary is the only thing left, and it
   holds `lead.view.all`, so its role scope is `1=1` and every refusal below is
   the org boundary doing the work rather than ownership. */

const BONANZA_PRODUCT = one(
  "SELECT id, name FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 ORDER BY sort_order, id LIMIT 1",
);
const BIGUL_PRODUCT = one(
  "SELECT id, name FROM product_types WHERE sales_org = 'BIGUL' AND active = 1 ORDER BY sort_order, id LIMIT 1",
);
assert(BONANZA_PRODUCT, 'fixture: no active Bonanza product');
assert(BIGUL_PRODUCT, 'fixture: no active Bigul product');

const NAMES = ['KYC book probe Bigul', 'KYC book probe Bonanza'];
const clear = () => {
  const ids = all(
    `SELECT id FROM leads WHERE name IN (${NAMES.map(() => '?').join(',')})`, NAMES,
  ).map((r) => r.id);
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  /* A journey started from card_id alone carries lead_id NULL and only the
     card_id, so it is found through the card, not the lead. */
  const mine = `SELECT id FROM kyc_journeys WHERE lead_id IN (${marks})
                 OR card_id IN (SELECT id FROM product_cards WHERE lead_id IN (${marks}))`;
  run(`DELETE FROM kyc_journey_progress WHERE journey_id IN (${mine})`, [...ids, ...ids]);
  run(`DELETE FROM kyc_journeys WHERE id IN (${mine})`, [...ids, ...ids]);
  run(`DELETE FROM product_cards WHERE lead_id IN (${marks})`, ids);
  run(`DELETE FROM leads WHERE id IN (${marks})`, ids);
};
clear();

const BIGUL_MOBILE = '9800000071';
const newLead = (name, org, mobile) => Number(run(
  `INSERT INTO leads (name, mobile, email, source, stage, sales_org, owner_id)
   VALUES (?,?,?,'Referral','New',?,NULL)`,
  [name, mobile, `${mobile}@kyc.test`, org],
).lastInsertRowid);

const BIGUL_LEAD = newLead('KYC book probe Bigul', 'BIGUL', BIGUL_MOBILE);
const BONANZA_LEAD = newLead('KYC book probe Bonanza', 'BONANZA', '9800000072');

const newCard = (leadId, productId) => Number(run(
  "INSERT INTO product_cards (lead_id, product_type_id, state) VALUES (?,?,'INACTIVE')",
  [leadId, productId],
).lastInsertRowid);

const BIGUL_CARD = newCard(BIGUL_LEAD, BIGUL_PRODUCT.id);
const BONANZA_CARD = newCard(BONANZA_LEAD, BONANZA_PRODUCT.id);

const start = async (body) => {
  const res = await fetch(`${BASE}/api/kyc/journeys`, {
    method: 'POST', headers: auth, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const journeys = (leadId) => all('SELECT id FROM kyc_journeys WHERE lead_id = ?', [leadId]).length;
const journeysOnCard = (cardId) => all('SELECT id FROM kyc_journeys WHERE card_id = ?', [cardId]).length;
const cardState = (id) => one('SELECT state FROM product_cards WHERE id = ?', [id]).state;

/* ------------------------------------------------ 1. the lead is scoped */

await test('a Bonanza supervisor cannot start a journey on a Bigul lead', async () => {
  const before = journeys(BIGUL_LEAD);
  const { status, body } = await start({ lead_id: BIGUL_LEAD, product_type_id: BIGUL_PRODUCT.id });

  assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(journeys(BIGUL_LEAD), before, 'a journey was created on the other book’s lead');
});

await test('the refusal hands back no resume link and no contact detail', async () => {
  /* The point of the finding. A 403 that still returned the journey body would
     leak both the bearer token and the applicant's mobile in one reply. */
  const { body } = await start({ lead_id: BIGUL_LEAD, product_type_id: BIGUL_PRODUCT.id });
  const text = JSON.stringify(body);

  assert(!body.applicant_url, `the refusal carried an applicant link: ${text.slice(0, 200)}`);
  assert(!body.resume_token, 'the refusal carried a resume token');
  assert(!text.includes(BIGUL_MOBILE), 'the refusal carried the Bigul lead’s mobile');
});

await test('card_id is scoped too, and a refused request leaves the card alone', async () => {
  /* card_id is the other way into this route: it names the product when
     product_type_id is absent, and createJourney() moves the card it names to
     KYC_IN_PROGRESS. Scoping the lead alone would leave the whole finding
     reachable by sending card_id instead of lead_id. */
  const before = journeysOnCard(BIGUL_CARD);
  const { status, body } = await start({ card_id: BIGUL_CARD });

  assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(cardState(BIGUL_CARD), 'INACTIVE',
    `a refused request moved the Bigul card to ${cardState(BIGUL_CARD)}`);
  assert.equal(journeysOnCard(BIGUL_CARD), before, 'a journey was created against the other book’s card');
});

/* --------------------------------------- 2. the product names the book */

await test('a lead and a product from different books is refused', async () => {
  const before = journeys(BONANZA_LEAD);
  const { status, body } = await start({ lead_id: BONANZA_LEAD, product_type_id: BIGUL_PRODUCT.id });

  assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(journeys(BONANZA_LEAD), before, 'a cross-book journey was created');
});

await test('the mismatch names both books, so the RM can see what is wrong', async () => {
  const { body } = await start({ lead_id: BONANZA_LEAD, product_type_id: BIGUL_PRODUCT.id });
  const error = String(body.error ?? '');

  assert(error.includes('BIGUL') && error.includes('BONANZA'),
    `the refusal does not name both books: ${error}`);
});

/* ------------------------------------- and the route still does its job */

await test('a lead and a product in the same book still starts a journey', async () => {
  const { status, body } = await start({ lead_id: BONANZA_LEAD, product_type_id: BONANZA_PRODUCT.id });

  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  assert(body.resume_token, 'the journey came back without a resume token');
  assert.equal(body.applicant_url, `/dkyc/resume/${body.resume_token}`,
    `the applicant link is wrong: ${body.applicant_url}`);

  const row = one('SELECT lead_id, product_type_id FROM kyc_journeys WHERE id = ?', [body.id]);
  assert(row, 'the journey was not stored');
  assert.equal(row.lead_id, BONANZA_LEAD, 'the journey attached to the wrong lead');
  assert.equal(row.product_type_id, BONANZA_PRODUCT.id, 'the journey took the wrong product');
});

await test('a card in the caller’s own book still starts a journey', async () => {
  /* The other half of the card check: it must refuse the other book without
     refusing the ordinary case, which is an RM pressing the button on a card
     in front of them. */
  const { status, body } = await start({ card_id: BONANZA_CARD });

  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(cardState(BONANZA_CARD), 'KYC_IN_PROGRESS',
    `the card was not moved into KYC: ${cardState(BONANZA_CARD)}`);
  assert.equal(
    one('SELECT product_type_id FROM kyc_journeys WHERE id = ?', [body.id]).product_type_id,
    BONANZA_PRODUCT.id, 'the journey took the wrong product from the card',
  );
});

clear();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
