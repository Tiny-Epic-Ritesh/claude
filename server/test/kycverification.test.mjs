/**
 * Verification: the step after the applicant's twenty minutes.
 *
 * WHY THIS FILE EXISTS
 *
 * The journey stopped at eSign and then said "In Progress" until somebody
 * noticed the account had opened. Everything in between -- Bonanza reviewing
 * the application, and then the depository confirming it -- had no step, so
 * "waiting on the custodian" could only be inferred. That is why the legacy
 * tenant carries APPLICATION UNDER VERIFICATION, INTERNALLY VERIFIED and
 * CUSTODIAN VERIFIED as three stages of a pipeline meant to be about selling:
 * gap 1 of docs/feedback/MIGRATION-STAGE-SOURCE-MAPPING.md.
 *
 * THE ONE THAT WOULD HAVE BITTEN
 *
 * A seventeenth step added like the sixteen before it would have a timer, and
 * the stall sweep would mark every application stalled within minutes of eSign
 * and abandoned within the hour -- reporting applicants as having given up
 * while their file sat in a queue at the depository, and then refusing to let
 * them self-serve. So the first thing checked here is that the sweep leaves a
 * waiting step alone however long it has been sitting there.
 *
 * WHAT ELSE IT CHECKS
 *
 * The hand-over (what is stamped, what the timeline says, that the applicant's
 * clock stops), that the applicant cannot record their own verification, each
 * of the three outcomes and which one opens the account, the refusals, and that
 * the console can say whose desk the application is on.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import {
  MASTER_STEPS, VERIFICATION_OUTCOMES, createJourney, getJourney, submitStep,
  recordVerification, sweepKyc, kycHealth, journeyStepsFor,
} from '../src/engine/kyc.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nKYC verification');

const RM = await probeAdmin('kycverification', { role: 'product_rm', sales_org: 'BONANZA' });

const call = async (method, path, body, headers = RM.headers) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* ------------------------------------------------------------- fixtures */

const NAME = 'KYC verification probe';
const EQD = one("SELECT id FROM product_types WHERE code = 'EQD'").id;
const MF = one("SELECT id FROM product_types WHERE code = 'MF'")?.id ?? null;

/* A Product RM's visibility runs through the product they are responsible
   for. Set after the probe is made, because scope is derived from the user row
   on every request rather than baked into the session. */
run('UPDATE users SET product_type_id = (SELECT id FROM product_types WHERE code = ?) WHERE id = ?',
  ['EQD', RM.id]);

const clear = () => {
  const leads = all('SELECT id FROM leads WHERE name LIKE ?', [`${NAME}%`]).map((l) => l.id);
  for (const id of leads) {
    run('DELETE FROM kyc_journey_progress WHERE journey_id IN (SELECT id FROM kyc_journeys WHERE lead_id = ?)', [id]);
    run('DELETE FROM kyc_journeys WHERE lead_id = ?', [id]);
    run('DELETE FROM activities WHERE lead_id = ?', [id]);
    run('DELETE FROM product_cards WHERE lead_id = ?', [id]);
    run('DELETE FROM leads WHERE id = ?', [id]);
  }
};
clear();

const STAMP = String(Date.now()).slice(-5);
let serial = 0;

/** A lead with a product card and a journey, ready to be driven. */
const fixture = ({ org = 'BONANZA', productTypeId = EQD } = {}) => {
  serial += 1;
  const leadId = Number(run(
    "INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id) VALUES (?,?,'Manual','New',?,?)",
    [`${NAME} ${serial}`, `7${STAMP}${String(serial).padStart(4, '0')}`, org, RM.id],
  ).lastInsertRowid);
  const cardId = Number(run(
    "INSERT INTO product_cards (lead_id, product_type_id, state, product_rm_id) VALUES (?,?,'KYC_IN_PROGRESS',?)",
    [leadId, productTypeId, RM.id],
  ).lastInsertRowid);
  const journey = createJourney({ leadId, cardId, productTypeId, mobile: `7${STAMP}${serial}`, email: 'probe@bonanza.test' });
  return { leadId, cardId, journeyId: journey.id ?? journey };
};

/**
 * Submit every step the applicant owns, stopping at the one that waits.
 *
 * The payloads are empty because this file is about what happens after the
 * form, not about the form: submitStep records whatever it is given and the
 * conditional steps read the form, so an empty one simply skips them.
 */
const driveToHandover = (journeyId) => {
  for (let i = 0; i < 40; i += 1) {
    const journey = getJourney(journeyId);
    if (!journey.current_step) return journey;
    const step = journey.steps.find((s) => s.code === journey.current_step);
    if (step?.waits) return journey;
    const out = submitStep(journeyId, journey.current_step, {});
    if (out.error) throw new Error(`driving the journey stopped at ${journey.current_step}: ${out.error}`);
    if (out.done) return getJourney(journeyId);
  }
  throw new Error('the journey never reached a waiting step or an end');
};

try {
  /* ------------------------------------------------- the step definition */

  await test('verification is a step, and it is the one that waits', () => {
    const def = MASTER_STEPS.find((s) => s.code === 'VERIFICATION');
    assert(def, 'there is no VERIFICATION step');
    assert.equal(def.waits, true, 'the verification step is not marked as waiting');
    assert.equal(MASTER_STEPS.filter((s) => s.waits).length, 1, 'more than one step waits');
    assert.equal((def.fields ?? []).length, 0, 'the verification step asks the applicant for something');

    /* And it is on the broking journey, after eSign. */
    const steps = journeyStepsFor(EQD).map((s) => s.code);
    assert.equal(steps[steps.length - 1], 'VERIFICATION', `the broking journey ends at ${steps[steps.length - 1]}`);
    assert(steps.indexOf('ESIGN') < steps.indexOf('VERIFICATION'), 'verification comes before eSign');
  });

  await test('the three outcomes say who is being waited on', () => {
    assert.deepEqual(VERIFICATION_OUTCOMES.map((o) => o.code),
      ['UNDER_REVIEW', 'INTERNALLY_VERIFIED', 'CUSTODIAN_VERIFIED']);
    const waiting = VERIFICATION_OUTCOMES.filter((o) => o.waiting_on).map((o) => o.waiting_on);
    assert.deepEqual(waiting, ['Bonanza', 'the custodian'],
      'the two unfinished outcomes do not name different people');
    assert.equal(VERIFICATION_OUTCOMES.at(-1).waiting_on, null, 'the finished outcome still waits on somebody');
  });

  /* ------------------------------------------------- the hand-over */

  await test('finishing the applicant steps hands the application over', () => {
    const { journeyId, leadId } = fixture();
    const journey = driveToHandover(journeyId);

    assert.equal(journey.current_step, 'VERIFICATION', `the journey stopped at ${journey.current_step}`);
    assert.equal(journey.status, 'In Progress', 'the journey completed without anybody verifying it');
    assert.equal(journey.verification_outcome, 'UNDER_REVIEW',
      'verification did not open at its first outcome');
    assert(journey.applicant_done_at, 'nothing recorded when the applicant finished');

    /* And the account has not opened. This is the whole point of the step:
       before it, completing eSign flipped the card straight to ACTIVE. */
    const card = one('SELECT state FROM product_cards WHERE id = ?', [journey.card_id]);
    assert.notEqual(card.state, 'ACTIVE', 'the card opened before anybody verified the application');

    const said = all(
      "SELECT subject FROM activities WHERE lead_id = ? AND type = 'KYC Event' ORDER BY id", [leadId],
    ).map((a) => a.subject);
    assert(said.includes('Application submitted for verification'),
      `the timeline does not say it was handed over: ${said.join(' | ')}`);
  });

  await test("the applicant's clock stops when they hand it over", () => {
    const { journeyId } = fixture();
    driveToHandover(journeyId);

    /* Backdate the hand-over by a day. Elapsed has to stay where it was:
       the 15-20 minute promise is about the applicant's own sitting, and a
       three-day wait at the depository is not their time. */
    run("UPDATE kyc_journeys SET applicant_done_at = datetime('now','-1 day') WHERE id = ?", [journeyId]);
    const elapsed = getJourney(journeyId).elapsed_s;
    assert(elapsed <= 0, `the clock ran backwards: ${elapsed}s`);

    run("UPDATE kyc_journeys SET started_at = datetime('now','-1 day','-10 minutes') WHERE id = ?", [journeyId]);
    const withStart = getJourney(journeyId).elapsed_s;
    assert(withStart > 500 && withStart < 700,
      `elapsed should be the ten minutes the applicant spent, not the day since: ${withStart}s`);
  });

  await test('a waiting step is never stalled or abandoned', () => {
    const { journeyId } = fixture();
    driveToHandover(journeyId);

    /* Sitting on it for two days. A timed step would have stalled in minutes
       and been abandoned within the hour. */
    run(
      `UPDATE kyc_journey_progress SET entered_at = datetime('now','-2 days')
        WHERE journey_id = ? AND step_code = 'VERIFICATION'`,
      [journeyId],
    );
    assert.equal(getJourney(journeyId).stall, null, 'a waiting step reported a stall state');

    sweepKyc();
    const after = one('SELECT status FROM kyc_journeys WHERE id = ?', [journeyId]);
    assert.equal(after.status, 'In Progress',
      `the sweep moved a waiting application to ${after.status}`);
    const progress = one(
      "SELECT status FROM kyc_journey_progress WHERE journey_id = ? AND step_code = 'VERIFICATION'", [journeyId],
    );
    assert.equal(progress.status, 'active', `the sweep marked the waiting step ${progress.status}`);
  });

  await test('the applicant cannot record their own verification', () => {
    const { journeyId } = fixture();
    driveToHandover(journeyId);

    const out = submitStep(journeyId, 'VERIFICATION', { outcome: 'CUSTODIAN_VERIFIED' });
    assert(out.error, 'the public step submit accepted a verification');
    assert(/recorded by Bonanza/i.test(out.error), `the reason reads: ${out.error}`);
    assert.equal(one('SELECT status FROM kyc_journeys WHERE id = ?', [journeyId]).status, 'In Progress');
  });

  /* ------------------------------------------------- recording an outcome */

  await test('the middle outcome records and opens nothing', () => {
    const { journeyId, leadId } = fixture();
    driveToHandover(journeyId);

    const out = recordVerification(journeyId, 'INTERNALLY_VERIFIED', RM.id);
    assert(!out.error, `refused: ${out.error}`);
    assert(!out.completed, 'internal verification completed the journey');

    const row = one('SELECT * FROM kyc_journeys WHERE id = ?', [journeyId]);
    assert.equal(row.verification_outcome, 'INTERNALLY_VERIFIED');
    assert.equal(row.status, 'In Progress');
    assert.equal(row.verified_by, RM.id, 'nothing recorded who verified it');
    assert.notEqual(one('SELECT state FROM product_cards WHERE id = ?', [row.card_id]).state, 'ACTIVE',
      'the card opened before the custodian confirmed');

    const said = all("SELECT body FROM activities WHERE lead_id = ? AND type = 'KYC Event'", [leadId]);
    assert(said.some((a) => /waiting on the custodian/i.test(a.body)),
      'the timeline does not say who it is now waiting on');
  });

  await test('the last outcome completes the journey and opens the card', () => {
    const { journeyId } = fixture();
    driveToHandover(journeyId);
    recordVerification(journeyId, 'INTERNALLY_VERIFIED', RM.id);

    const out = recordVerification(journeyId, 'CUSTODIAN_VERIFIED', RM.id);
    assert(!out.error, `refused: ${out.error}`);
    assert(out.completed, 'custodian verification did not complete the journey');

    const row = one('SELECT * FROM kyc_journeys WHERE id = ?', [journeyId]);
    assert.equal(row.status, 'Complete');
    assert(row.completed_at, 'nothing recorded when it completed');
    assert.equal(one('SELECT state FROM product_cards WHERE id = ?', [row.card_id]).state, 'ACTIVE',
      'the card did not open after the custodian confirmed');
    assert.equal(
      one("SELECT status FROM kyc_journey_progress WHERE journey_id = ? AND step_code = 'VERIFICATION'", [journeyId]).status,
      'done',
    );
  });

  await test('an outcome that does not exist is refused, with the ones that do', () => {
    const { journeyId } = fixture();
    driveToHandover(journeyId);

    const out = recordVerification(journeyId, 'VERIFIED', RM.id);
    assert(out.error, 'any string was accepted as an outcome');
    assert.deepEqual(out.allowed, VERIFICATION_OUTCOMES.map((o) => o.code),
      'the refusal does not say what is allowed');
  });

  await test('verification cannot be recorded before the applicant finishes', () => {
    const { journeyId } = fixture();
    const at = getJourney(journeyId).current_step;

    const out = recordVerification(journeyId, 'CUSTODIAN_VERIFIED', RM.id);
    assert(out.error, 'an application still being filled in was verified');
    assert(/has not finished/i.test(out.error), `the reason reads: ${out.error}`);
    /* And it names where they actually are, rather than saying no. */
    const label = MASTER_STEPS.find((s) => s.code === at)?.label;
    assert(out.error.includes(label), `the reason does not say where they are: ${out.error}`);
  });

  await test('a journey with no verification step says so', () => {
    if (!MF) return;                       // this database has no MF product
    const { journeyId } = fixture({ productTypeId: MF });
    const out = recordVerification(journeyId, 'UNDER_REVIEW', RM.id);
    assert(out.error, 'a mutual fund application was verified');
    assert(/no verification step/i.test(out.error), `the reason reads: ${out.error}`);
  });

  /* ------------------------------------------------- the screens */

  await test('the console says whose desk it is on, by name', () => {
    const { journeyId } = fixture();
    driveToHandover(journeyId);
    recordVerification(journeyId, 'INTERNALLY_VERIFIED', RM.id);

    const row = kycHealth().find((j) => j.id === journeyId);
    assert(row, 'the journey is missing from the health table');
    assert.equal(row.verification?.waiting_on, 'the custodian');
    /* The label, not the code. VERIFICATION has no stall state, and the column
       used to fall through to the raw step code. */
    assert.equal(row.current_step_label, 'Verification',
      `the console reads "${row.current_step_label}"`);
  });

  /* ------------------------------------------------- the route */

  await test('the route records it, and only for somebody who may', async () => {
    const { journeyId } = fixture();
    driveToHandover(journeyId);

    const outcomes = await call('GET', '/kyc/verification-outcomes');
    assert.equal(outcomes.status, 200);
    assert.deepEqual(outcomes.body.outcomes.map((o) => o.code), VERIFICATION_OUTCOMES.map((o) => o.code),
      'the screen is offered a different list from the one the write takes');

    const ok = await call('POST', `/kyc/journeys/${journeyId}/verification`, { outcome: 'INTERNALLY_VERIFIED' });
    assert.equal(ok.status, 200, `HTTP ${ok.status}: ${JSON.stringify(ok.body)}`);
    assert.equal(one('SELECT verification_outcome FROM kyc_journeys WHERE id = ?', [journeyId]).verification_outcome,
      'INTERNALLY_VERIFIED');

    /* A Sales RM holds kyc.view and not kyc.manage: they can see the
       application and must not be able to open the account. */
    const sales = await probeAdmin('kycverification-sales', { role: 'sales_rm', sales_org: 'BONANZA' });
    try {
      const refused = await call('POST', `/kyc/journeys/${journeyId}/verification`,
        { outcome: 'CUSTODIAN_VERIFIED' }, sales.headers);
      assert.equal(refused.status, 403, `HTTP ${refused.status}`);
      assert.equal(one('SELECT status FROM kyc_journeys WHERE id = ?', [journeyId]).status, 'In Progress');
    } finally { sales.cleanup(); }
  });

  await test("the route will not verify the other business's application", async () => {
    const { journeyId } = fixture({ org: 'BIGUL' });
    driveToHandover(journeyId);

    /* The probe works in Bonanza. A journey belongs to the book its lead does,
       and opening an account in the other business is not a thing a reviewer
       in this one should be able to do. */
    const refused = await call('POST', `/kyc/journeys/${journeyId}/verification`, { outcome: 'CUSTODIAN_VERIFIED' });
    assert.equal(refused.status, 403, `HTTP ${refused.status}: ${JSON.stringify(refused.body)}`);
    assert.equal(one('SELECT status FROM kyc_journeys WHERE id = ?', [journeyId]).status, 'In Progress',
      "a Bonanza reviewer completed a Bigul application");
  });
} finally {
  clear();
  RM.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
