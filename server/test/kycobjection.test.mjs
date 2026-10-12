/**
 * An objection is not a rejection.
 *
 * WHY THIS FILE EXISTS
 *
 * A rejection ends an application. An objection says "this one thing is wrong,
 * correct it and send it back" -- and the CRM could hold neither. `kyc_status`
 * listed Rejected and nothing could produce it: a lead the portal had rejected
 * read "In Progress", and so did one under objection. That is why the legacy
 * tenant carried APPLICATION UNDER OBJECTION and APPLICATION RESUBMITTED as
 * lead stages, and why the resubmission loop lived in people's heads. Gap 2 of
 * docs/feedback/MIGRATION-STAGE-SOURCE-MAPPING.md.
 *
 * THE ONE THAT WOULD HAVE BITTEN
 *
 * Sending an applicant back to step nine and then walking forward from there
 * would ask them to re-enter their nominee, segments, selfie and signature
 * because one address line was wrong. The step after a correction is the next
 * one NOT ALREADY DONE, and the test below counts exactly what they are asked
 * for on the way back.
 *
 * WHAT ELSE IT CHECKS
 *
 * Both ways in (a reviewer at Bonanza, and the eKYC portal's vocabulary), that
 * an objection needs a reason and a submitted application, the round count, the
 * withdrawal path, and that the derived status can now say Objection and
 * Rejected at all.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import {
  createJourney, getJourney, submitStep, recordVerification, raiseObjection,
  journeyStepsFor, kycHealth,
} from '../src/engine/kyc.js';
import { kycStatusFor, KYC_STATUSES } from '../src/engine/kycstatus.js';
import { normaliseStatus } from '../src/vendors/bonanzakyc.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nKYC objections');

const RM = await probeAdmin('kycobjection', { role: 'product_rm', sales_org: 'BONANZA' });
run('UPDATE users SET product_type_id = (SELECT id FROM product_types WHERE code = ?) WHERE id = ?',
  ['EQD', RM.id]);

const call = async (method, path, body, headers = RM.headers) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* ------------------------------------------------------------- fixtures */

const NAME = 'KYC objection probe';
const EQD = one("SELECT id FROM product_types WHERE code = 'EQD'").id;

const clear = () => {
  for (const { id } of all('SELECT id FROM leads WHERE name LIKE ?', [`${NAME}%`])) {
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

const fixture = ({ org = 'BONANZA' } = {}) => {
  serial += 1;
  const leadId = Number(run(
    "INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id) VALUES (?,?,'Manual','New',?,?)",
    [`${NAME} ${serial}`, `8${STAMP}${String(serial).padStart(4, '0')}`, org, RM.id],
  ).lastInsertRowid);
  const cardId = Number(run(
    "INSERT INTO product_cards (lead_id, product_type_id, state, product_rm_id) VALUES (?,?,'KYC_IN_PROGRESS',?)",
    [leadId, EQD, RM.id],
  ).lastInsertRowid);
  const journey = createJourney({ leadId, cardId, productTypeId: EQD, mobile: `8${STAMP}${serial}`, email: 'probe@bonanza.test' });
  return { leadId, cardId, journeyId: journey.id ?? journey };
};

/** Submit everything the applicant owns, and count what was asked for. */
const drive = (journeyId) => {
  const asked = [];
  for (let i = 0; i < 40; i += 1) {
    const journey = getJourney(journeyId);
    if (!journey.current_step) return asked;
    const step = journey.steps.find((s) => s.code === journey.current_step);
    if (step?.waits) return asked;
    asked.push(journey.current_step);
    const out = submitStep(journeyId, journey.current_step, {});
    if (out.error) throw new Error(`driving stopped at ${journey.current_step}: ${out.error}`);
    if (out.done) return asked;
  }
  throw new Error('the journey never reached a waiting step or an end');
};

const statusOf = (journeyId) => one('SELECT * FROM kyc_journeys WHERE id = ?', [journeyId]);
const progressOf = (journeyId, code) => one(
  'SELECT status FROM kyc_journey_progress WHERE journey_id = ? AND step_code = ?', [journeyId, code],
)?.status;

try {
  /* ------------------------------------------------- the status exists */

  await test('the derived status can say Objection, and Rejected at all', () => {
    assert(KYC_STATUSES.includes('Objection'), 'Objection is not a KYC status');
    assert(KYC_STATUSES.includes('Rejected'), 'Rejected has gone from the list');

    /* Both were unreachable: a lead the portal had rejected read In Progress,
       because the derived status only knew whether a portal stage existed. */
    const { leadId } = fixture();
    run("UPDATE leads SET kyc_portal_stage = 'rejected', kyc_portal_state = 'Rejected' WHERE id = ?", [leadId]);
    run('DELETE FROM kyc_journeys WHERE lead_id = ?', [leadId]);
    assert.equal(kycStatusFor(leadId), 'Rejected');

    run("UPDATE leads SET kyc_portal_stage = 'under objection', kyc_portal_state = 'Objection' WHERE id = ?", [leadId]);
    assert.equal(kycStatusFor(leadId), 'Objection');
  });

  await test("the portal's two words map to the two different outcomes", () => {
    assert.equal(normaliseStatus({ stage: 'under_objection' }).stage, 'Objection');
    assert.equal(normaliseStatus({ stage: 'Application Under Objection' }).objection, true);
    assert.equal(normaliseStatus({ stage: 'under_objection' }).rejected, false,
      'an objection was read as a rejection, which would end a recoverable application');
    assert.equal(normaliseStatus({ stage: 'rejected' }).objection, false);
    assert.equal(normaliseStatus({ stage: 'application_resubmitted' }).resubmitted, true);
    /* And the reason comes through, because an objection without one is not
       actionable. */
    assert.equal(normaliseStatus({ stage: 'objection', remarks: 'Address proof unreadable' }).reason,
      'Address proof unreadable');
  });

  /* ------------------------------------------------- raising one */

  await test('an objection needs a reason and a submitted application', () => {
    const { journeyId } = fixture();

    const early = raiseObjection(journeyId, { text: 'Too soon' });
    assert(early.error, 'an application still being filled in was objected to');
    assert(/has not submitted yet/i.test(early.error), `the reason reads: ${early.error}`);

    drive(journeyId);
    const silent = raiseObjection(journeyId, { text: '   ' });
    assert(silent.error, 'an objection with no reason was accepted');
    assert.equal(silent.field, 'objection_text');
    assert.equal(statusOf(journeyId).status, 'In Progress', 'a refused objection changed the journey');
  });

  await test('a reviewer sends it back to one step, and only that step', () => {
    const { journeyId, leadId } = fixture();
    drive(journeyId);

    const out = raiseObjection(journeyId, {
      text: 'The address proof is unreadable — please upload it again.',
      stepCode: 'PERSONAL',
      userId: RM.id,
    });
    assert(!out.error, `refused: ${out.error}`);

    const row = statusOf(journeyId);
    assert.equal(row.status, 'Objection');
    assert.equal(row.current_step, 'PERSONAL', `the applicant was sent to ${row.current_step}`);
    assert.equal(row.objection_step, 'PERSONAL');
    assert.equal(row.objection_source, 'crm');
    assert.equal(row.objection_by, RM.id);
    assert.equal(row.objection_rounds, 1);
    assert(row.objection_text.includes('address proof'), 'the reason was not kept');

    /* Verification is not passed, and nobody may record an outcome on an
       application that is sitting with the applicant. */
    assert.equal(progressOf(journeyId, 'VERIFICATION'), 'pending');
    assert.equal(row.verification_outcome, null, 'a stale verification outcome was left behind');
    assert.equal(progressOf(journeyId, 'PERSONAL'), 'active');

    /* The lead reads Objection, not "In Progress". */
    assert.equal(kycStatusFor(leadId), 'Objection');

    const said = all("SELECT subject, body FROM activities WHERE lead_id = ? AND type = 'KYC Event'", [leadId]);
    assert(said.some((a) => /Objection raised on "Personal details"/.test(a.subject)),
      `the timeline does not name the step: ${said.map((a) => a.subject).join(' | ')}`);
    assert(said.some((a) => /address proof/i.test(a.body ?? '')), 'the timeline does not carry the reason');
  });

  await test('the applicant redoes the objected step and nothing else', () => {
    const { journeyId } = fixture();
    const first = drive(journeyId);
    assert(first.includes('NOMINEE') && first.includes('SIGNATURE'),
      'the first pass did not cover the later steps, so this proves nothing');

    raiseObjection(journeyId, { text: 'Bank proof is for a different name.', stepCode: 'BANK', userId: RM.id });

    /* The whole point. Everything after BANK is already done; walking forward
       from it would ask for all of it again. */
    const again = drive(journeyId);
    assert.deepEqual(again, ['BANK'],
      `the applicant was asked to redo ${again.join(', ')} instead of just the objected step`);

    const row = statusOf(journeyId);
    assert.equal(row.status, 'In Progress', `the journey came back as ${row.status}`);
    assert.equal(row.current_step, 'VERIFICATION', 'the correction did not go back for verification');
    assert.equal(row.verification_outcome, 'UNDER_REVIEW',
      'the review did not start again after the correction');
    assert.equal(row.objection_text, null, 'the objection was not cleared when it was answered');
    assert.equal(row.objection_rounds, 1, 'the round count was cleared with the objection');
  });

  await test('an application that was internally verified is not still verified after an objection', () => {
    const { journeyId } = fixture();
    drive(journeyId);
    recordVerification(journeyId, 'INTERNALLY_VERIFIED', RM.id);

    raiseObjection(journeyId, { text: 'The custodian wants a clearer signature.', stepCode: 'SIGNATURE', userId: RM.id });
    drive(journeyId);

    assert.equal(statusOf(journeyId).verification_outcome, 'UNDER_REVIEW',
      'the resubmitted application kept the outcome it had before the objection');
  });

  await test('a second round is counted, and the timeline says so', () => {
    const { journeyId, leadId } = fixture();
    drive(journeyId);
    raiseObjection(journeyId, { text: 'First problem.', stepCode: 'BANK', userId: RM.id });
    drive(journeyId);
    raiseObjection(journeyId, { text: 'Second problem.', stepCode: 'BANK', userId: RM.id });
    drive(journeyId);

    assert.equal(statusOf(journeyId).objection_rounds, 2, 'the rounds were not counted');
    const said = all("SELECT subject FROM activities WHERE lead_id = ? AND type = 'KYC Event'", [leadId])
      .map((a) => a.subject);
    assert.equal(said.filter((t) => /resubmitted/i.test(t)).length, 2,
      `the timeline does not show both resubmissions: ${said.join(' | ')}`);
  });

  await test('an objection with no step named stays with Bonanza', () => {
    /* Which is what the portal's objections look like: it says why, never
       which of our steps is wrong. */
    const { journeyId } = fixture();
    drive(journeyId);

    const out = raiseObjection(journeyId, { text: 'Signature mismatch per the depository.', source: 'portal' });
    assert(!out.error, `refused: ${out.error}`);

    const row = statusOf(journeyId);
    assert.equal(row.status, 'Objection');
    assert.equal(row.objection_step, null);
    assert.equal(row.objection_source, 'portal');
    assert.equal(row.objection_by, null, 'the portal was recorded as a person');
    assert.equal(row.current_step, 'VERIFICATION', 'the applicant was sent back with nothing to do');
  });

  await test('recording an outcome withdraws an objection', () => {
    const { journeyId } = fixture();
    drive(journeyId);
    raiseObjection(journeyId, { text: 'Raised in error.', stepCode: 'BANK', userId: RM.id });

    const out = recordVerification(journeyId, 'INTERNALLY_VERIFIED', RM.id);
    assert(!out.error, `refused: ${out.error}`);

    const row = statusOf(journeyId);
    assert.equal(row.status, 'In Progress');
    assert.equal(row.current_step, 'VERIFICATION');
    assert.equal(row.objection_text, null, 'the objection was not withdrawn');
    assert.equal(row.verification_outcome, 'INTERNALLY_VERIFIED');
    assert.equal(row.objection_rounds, 1, 'withdrawing an objection erased that it happened');
    assert.equal(progressOf(journeyId, 'VERIFICATION'), 'active');
  });

  await test('the refusals', () => {
    const { journeyId } = fixture();
    drive(journeyId);

    const onVerification = raiseObjection(journeyId, { text: 'x', stepCode: 'VERIFICATION', userId: RM.id });
    assert(onVerification.error, 'the applicant was sent back to a step they cannot fill in');
    assert.equal(onVerification.field, 'objection_step');

    const nowhere = raiseObjection(journeyId, { text: 'x', stepCode: 'NOT_A_STEP', userId: RM.id });
    assert(nowhere.error, 'a step that does not exist was accepted');

    /* And a finished application is not objected to -- that is reopening an
       account, which is not this. */
    recordVerification(journeyId, 'CUSTODIAN_VERIFIED', RM.id);
    const done = raiseObjection(journeyId, { text: 'Too late.', userId: RM.id });
    assert(done.error, 'a completed application was objected to');
    assert(/already complete/i.test(done.error), `the reason reads: ${done.error}`);
  });

  /* ------------------------------------------------- the screens */

  await test('the console says it is back with the applicant, and why', () => {
    const { journeyId } = fixture();
    drive(journeyId);
    raiseObjection(journeyId, { text: 'PAN card image is cropped.', stepCode: 'PAN', userId: RM.id });

    const row = kycHealth().find((j) => j.id === journeyId);
    assert(row, 'the journey is missing from the health table');
    assert.equal(row.status, 'Objection');
    assert.equal(row.objection?.step, 'PAN');
    assert.equal(row.objection?.rounds, 1);
    assert(row.objection?.text.includes('cropped'), 'the console does not carry the reason');
    assert.equal(row.verification, null, 'the console still shows a verification outcome');
    assert.equal(row.current_step_label, 'Enter PAN details',
      `the console reads "${row.current_step_label}"`);
  });

  /* ------------------------------------------------- the route */

  await test('the route raises one, and only for somebody who may', async () => {
    const { journeyId } = fixture();
    drive(journeyId);

    const ok = await call('POST', `/kyc/journeys/${journeyId}/objection`,
      { text: 'Income proof is out of date.', step_code: 'INCOME_PROOF' });
    assert.equal(ok.status, 400, 'a step that does not apply to this journey was accepted');

    const real = await call('POST', `/kyc/journeys/${journeyId}/objection`,
      { text: 'Selfie is too dark.', step_code: 'SELFIE' });
    assert.equal(real.status, 200, `HTTP ${real.status}: ${JSON.stringify(real.body)}`);
    assert.equal(statusOf(journeyId).status, 'Objection');

    const sales = await probeAdmin('kycobjection-sales', { role: 'sales_rm', sales_org: 'BONANZA' });
    try {
      const refused = await call('POST', `/kyc/journeys/${journeyId}/objection`,
        { text: 'Not mine to raise.' }, sales.headers);
      assert.equal(refused.status, 403, `HTTP ${refused.status}`);
    } finally { sales.cleanup(); }
  });

  await test("the route will not object to the other business's application", async () => {
    const { journeyId } = fixture({ org: 'BIGUL' });
    drive(journeyId);

    const refused = await call('POST', `/kyc/journeys/${journeyId}/objection`, { text: 'Not my book.' });
    assert.equal(refused.status, 403, `HTTP ${refused.status}: ${JSON.stringify(refused.body)}`);
    assert.equal(statusOf(journeyId).status, 'In Progress');
  });
} finally {
  clear();
  RM.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
