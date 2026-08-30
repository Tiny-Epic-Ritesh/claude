/**
 * KYC routes.
 *
 *  /api/kyc/*  — internal: the CRM rail, health table, assisted completion.
 *  /dkyc/*     — public: the customer-facing self-service DKYC portal.
 *                No CRM session; the applicant holds a resume token.
 */

import { Router } from 'express';
import { all, one, run, audit } from '../db.js';
import { requireUser, requirePermission, reqScope } from '../auth.js';
import * as kyc from '../engine/kyc.js';
import { digilockerFetch, pennyDrop, esign, sendOtp, verifyOtp, DEMO_OTP } from '../integrations.js';
import { generateCards } from './crm.js';
import * as ai from '../ai/index.js';
import { kycStatusSql, kycStatusFor } from '../engine/kycstatus.js';

/* ============================== internal =============================== */

export const internal = Router();
internal.use(requireUser);

internal.get('/master-steps', (_req, res) => res.json(kyc.MASTER_STEPS));

internal.get('/health', (req, res) => {
  const productId = req.query.product_id || (req.user.role === 'product_rm' ? req.user.product_type_id : null);
  res.json(kyc.kycHealth(productId ? Number(productId) : null));
});

internal.get('/journeys/:id', (req, res) => {
  const journey = kyc.getJourney(Number(req.params.id));
  if (!journey) return res.status(404).json({ error: 'Journey not found' });

  /* A journey inherits its book from the lead it belongs to.
   *
   * This one matters more than the rest: the record carries resume_token, the
   * bearer token an applicant uses to re-enter their own KYC on the public
   * portal. Handing that across the book boundary hands over the journey. */
  const scope = reqScope(req, 'l');
  const visible = journey.lead_id
    ? one(`SELECT 1 v FROM leads l WHERE l.id = ? AND ${scope.sql}`, [journey.lead_id, ...scope.params])
    : null;
  if (!visible) return res.status(403).json({ error: 'This journey is outside your visibility scope' });

  res.json(journey);
});

/** Start a journey from the CRM (RM-initiated), returning the applicant link. */
internal.post('/journeys', requirePermission('kyc.manage'), (req, res) => {
  const { lead_id, card_id, product_type_id } = req.body;
  const card = card_id ? one('SELECT * FROM product_cards WHERE id = ?', [card_id]) : null;
  const productId = product_type_id || card?.product_type_id;
  if (!productId) return res.status(400).json({ error: 'product_type_id or card_id is required' });

  const lead = lead_id ? one('SELECT * FROM leads WHERE id = ?', [lead_id]) : null;
  const journey = kyc.createJourney({
    leadId: lead_id || null,
    cardId: card_id || null,
    productTypeId: productId,
    mobile: lead?.mobile,
    email: lead?.email,
  });
  audit(req.user.id, 'kyc_journey_created', 'kyc_journey', journey.id, {});
  res.status(201).json({ ...journey, applicant_url: `/dkyc/resume/${journey.resume_token}` });
});

internal.post('/journeys/:id/assist', requirePermission('kyc.manage'), (req, res) => {
  res.json(kyc.assist(Number(req.params.id), req.user.id));
});

/** Product Supervisor override — force a step complete or reset the journey. */
internal.post('/journeys/:id/override', requirePermission('kyc.override'), (req, res) => {
  const { step_code, action = 'complete' } = req.body;
  if (action === 'complete') {
    run("UPDATE kyc_journey_progress SET status = 'done', completed_at = datetime('now') WHERE journey_id = ? AND step_code = ?", [req.params.id, step_code]);
  } else {
    run("UPDATE kyc_journey_progress SET status = 'active', entered_at = datetime('now'), completed_at = NULL WHERE journey_id = ? AND step_code = ?", [req.params.id, step_code]);
    run('UPDATE kyc_journeys SET current_step = ? WHERE id = ?', [step_code, req.params.id]);
  }
  audit(req.user.id, 'kyc_override', 'kyc_journey', Number(req.params.id), { step_code, action });
  res.json(kyc.getJourney(Number(req.params.id)));
});

internal.get('/journeys/:id/coach', async (req, res, next) => {
  try {
    const journey = kyc.getJourney(Number(req.params.id));
    if (!journey) return res.status(404).json({ error: 'Journey not found' });

    /* Scoped like /journeys/:id above, which it was not when that one was
     * fixed. The coaching text quotes the applicant's stalled step and what to
     * say to them, so it describes the journey even though it does not return
     * the record. */
    const scope = reqScope(req, 'l');
    const visible = journey.lead_id
      ? one(`SELECT 1 v FROM leads l WHERE l.id = ? AND ${scope.sql}`, [journey.lead_id, ...scope.params])
      : null;
    if (!visible) return res.status(403).json({ error: 'This journey is outside your visibility scope' });

    res.json(await ai.kycCoach({
      product_name: journey.product?.name,
      step_code: journey.stall?.step_code || journey.current_step,
      step_label: journey.stall?.step_label || journey.current_step,
      seconds_on_step: journey.stall?.seconds_on_step || 0,
      timer_s: journey.stall?.timer_s || 180,
      status: journey.status,
      progress_pct: journey.progress_pct,
      form_summary: Object.fromEntries(Object.entries(journey.form).slice(0, 8)),
    }));
  } catch (err) { next(err); }
});

internal.post('/sweep', (_req, res) => res.json(kyc.sweepKyc()));

/* ================================ public =============================== */

export const dkyc = Router();

/** Products a walk-in applicant can open an account for. */
dkyc.get('/products', (_req, res) => {
  res.json(all(`SELECT id, code, name, category, min_investment, lock_in, risk_category,
                       pitch_points, brochure_url, requires_kyc
                FROM product_types WHERE active = 1 AND requires_kyc = 1 ORDER BY sort_order`));
});

dkyc.get('/steps/:productId', (req, res) => {
  res.json(kyc.journeyStepsFor(Number(req.params.productId)));
});

/** Start a fresh self-service application. */
dkyc.post('/start', (req, res) => {
  const { product_type_id, mobile } = req.body;
  if (!product_type_id) return res.status(400).json({ error: 'Please choose a product to continue' });

  // Recognise an existing lead by mobile so the journey attaches to the CRM record.
  const lead = mobile ? one('SELECT * FROM leads WHERE mobile = ? AND deleted_at IS NULL', [mobile]) : null;
  const card = lead ? one('SELECT * FROM product_cards WHERE lead_id = ? AND product_type_id = ?', [lead.id, product_type_id]) : null;

  const journey = kyc.createJourney({
    leadId: lead?.id ?? null,
    cardId: card?.id ?? null,
    productTypeId: Number(product_type_id),
    mobile: mobile || null,
  });
  res.status(201).json({ resume_token: journey.resume_token, journey: publicView(journey) });
});

dkyc.get('/resume/:token', (req, res) => {
  const journey = kyc.getJourney(req.params.token, { byToken: true });
  if (!journey) return res.status(404).json({ error: 'We could not find that application' });
  res.json(publicView(journey));
});

/** Send an OTP for the mobile/email verification steps. */
dkyc.post('/resume/:token/otp', (req, res) => {
  const journey = kyc.getJourney(req.params.token, { byToken: true });
  if (!journey) return res.status(404).json({ error: 'Application not found' });

  const { channel = 'sms', destination } = req.body;
  res.json({ ...sendOtp(channel, destination), demo_otp: DEMO_OTP });
});

/**
 * Submit the active step.
 * Steps backed by a vendor (DigiLocker, penny drop, eSign) run through the
 * simulated adapter first, and the adapter's verdict is stored with the step.
 */
dkyc.post('/resume/:token/step', (req, res) => {
  const journey = kyc.getJourney(req.params.token, { byToken: true });
  if (!journey) return res.status(404).json({ error: 'Application not found' });
  if (journey.status === 'Abandoned') {
    return res.status(409).json({
      error: 'This application has been paused for security. A Bonanza representative will call you to complete it.',
      abandoned: true,
    });
  }

  const { step_code, payload = {} } = req.body;
  if (step_code !== journey.current_step) {
    return res.status(409).json({ error: 'That step is no longer active', current_step: journey.current_step });
  }

  const enriched = { ...payload };

  // --- vendor-backed steps ------------------------------------------------
  if (['MOBILE_OTP', 'EMAIL_OTP'].includes(step_code)) {
    const submitted = payload.otp || payload.email_otp;
    if (!verifyOtp(submitted)) return res.status(400).json({ error: 'That code is not correct. Please try again.' });
    enriched.verified = true;
  }

  if (step_code === 'AADHAAR_DIGILOCKER') {
    const result = digilockerFetch({ pan: journey.form.pan, dob: journey.form.dob });
    if (!result.verified) return res.status(400).json({ error: 'DigiLocker verification did not complete. Please retry.' });
    enriched.digilocker = result;
  }

  if (step_code === 'BANK') {
    const result = pennyDrop({
      accountNumber: payload.account_number,
      ifsc: payload.ifsc,
      accountHolder: payload.account_holder,
    });
    enriched.penny_drop = result;
    enriched.penny_drop_failed = result.failed;
    // A failure is not an error — it routes the journey through BANK_PROOF.
  }

  if (step_code === 'ESIGN') {
    const result = esign({ otp: payload.esign_otp });
    if (!result.signed) return res.status(400).json({ error: 'eSign failed. Please re-enter the Aadhaar OTP.' });
    enriched.esign = result;
  }

  const outcome = kyc.submitStep(journey.id, step_code, enriched);
  if (outcome.error) return res.status(409).json(outcome);

  // On completion, make sure a CRM lead exists for this applicant.
  if (outcome.done) ensureLead(outcome.journey);

  res.json({
    done: outcome.done,
    next_step: outcome.next_step ?? null,
    journey: publicView(outcome.journey),
    penny_drop_failed: enriched.penny_drop_failed === true,
  });
});

/** A walk-in applicant becomes a real lead the moment they finish. */
function ensureLead(journey) {
  if (journey.lead_id) return;

  const f = journey.form || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(' ')
    || f.account_holder || f.father_spouse || `DKYC applicant ${journey.id}`;

  const existing = f.mobile || journey.applicant_mobile
    ? one('SELECT * FROM leads WHERE mobile = ? AND deleted_at IS NULL', [f.mobile || journey.applicant_mobile])
    : null;

  let leadId = existing?.id;
  if (!leadId) {
    const owner = one("SELECT id FROM users WHERE role = 'sales_rm' AND active = 1 ORDER BY (SELECT COUNT(*) FROM leads WHERE owner_id = users.id) LIMIT 1");
    const result = run(
      `INSERT INTO leads (name, mobile, email, pan, city, state, source, stage, owner_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [name, f.mobile || journey.applicant_mobile || null, f.email || journey.applicant_email || null, f.pan || null,
        f.city || null, f.state || null, 'DKYC Portal', 'Qualified', owner?.id || null],
    );
    leadId = Number(result.lastInsertRowid);
    generateCards(leadId);
  }

  const card = one('SELECT * FROM product_cards WHERE lead_id = ? AND product_type_id = ?', [leadId, journey.product_type_id]);
  run('UPDATE kyc_journeys SET lead_id = ?, card_id = ? WHERE id = ?', [leadId, card?.id ?? null, journey.id]);
  if (card) {
    run("UPDATE product_cards SET state = 'ACTIVE', last_state_at = datetime('now') WHERE id = ?", [card.id]);
  }
  // Completion is a fact about the journey; the lead's status follows from it.
  run('INSERT INTO activities (lead_id, card_id, type, direction, subject, body) VALUES (?,?,?,?,?,?)', [
    leadId, card?.id ?? null, 'KYC Event', 'inbound', 'Self-service KYC completed',
    'Applicant completed the DKYC journey without assistance.',
  ]);
  audit(null, 'dkyc_lead_created', 'lead', leadId, { journey_id: journey.id });
}

/** Only what the applicant is allowed to see — no CRM internals. */
function publicView(j) {
  return {
    id: j.id,
    resume_token: j.resume_token,
    status: j.status,
    current_step: j.current_step,
    progress_pct: j.progress_pct,
    steps_done: j.steps_done,
    steps_total: j.steps_total,
    elapsed_s: j.elapsed_s,
    product: j.product ? { id: j.product.id, name: j.product.name, code: j.product.code } : null,
    form: j.form,
    steps: j.steps
      .filter((s) => s.applies)
      .map((s) => ({
        code: s.code, label: s.label, group: s.group, status: s.status,
        fields: s.fields, note: s.note, timer_s: s.timer_s || s.timer,
        seconds_on_step: s.seconds_on_step,
      })),
    stall: j.stall ? { stalled: j.stall.stalled, seconds_on_step: j.stall.seconds_on_step, timer_s: j.stall.timer_s } : null,
  };
}
