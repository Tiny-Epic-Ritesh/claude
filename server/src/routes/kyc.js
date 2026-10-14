/**
 * KYC routes.
 *
 *  /api/kyc/*  — internal: the CRM rail, health table, assisted completion.
 *  /dkyc/*     — public: the customer-facing self-service DKYC portal.
 *                No CRM session; the applicant holds a resume token.
 */

import { Router } from 'express';
import { all, one, run, audit } from '../db.js';
import { requireUser, requirePermission, reqScope, maskFor, orgsFor, activeOrg } from '../auth.js';
import { maskRecord, maskRecords } from '../security.js';
import * as kyc from '../engine/kyc.js';
import { digilockerFetch, pennyDrop, esign, sendOtp, verifyOtp, DEMO_OTP } from '../integrations.js';
import { generateCards } from './crm.js';
import { leastLoadedRm } from '../engine/assignment.js';
import * as ai from '../ai/index.js';
import { kycStatusSql, kycStatusFor } from '../engine/kycstatus.js';

/* ============================== internal =============================== */

export const internal = Router();
internal.use(requireUser);

internal.get('/master-steps', (_req, res) => res.json(kyc.MASTER_STEPS));

/* OPS-31. It needed only a sign-in and read every journey in both businesses:
   applicants' names, stages and products. kyc.view, the reader's books, and the
   one the switcher is narrowed to. */
internal.get('/health', requirePermission('kyc.view'), (req, res) => {
  const productId = req.query.product_id || (req.user.role === 'product_rm' ? req.user.product_type_id : null);
  const books = activeOrg(req) ? [activeOrg(req)] : orgsFor(req.user);
  // QA-06: applicant_mobile and applicant_email were in the clear for every reader.
  res.json(maskRecords(kyc.kycHealth(productId ? Number(productId) : null, books), maskFor(req, 'kyc_health')));
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

  /* QA-06. The applicant's contact details, and the form they filled in --
     mobile, email, PAN, account number -- under the reader's masking, and
     unmasked on the same audited ask as a lead. */
  const masking = maskFor(req, 'kyc_journey', journey.id);
  res.json({ ...maskRecord(journey, masking), form: maskRecord(journey.form, masking) });
});

/** Start a journey from the CRM (RM-initiated), returning the applicant link. */
internal.post('/journeys', requirePermission('kyc.manage'), (req, res) => {
  const { lead_id, card_id, product_type_id } = req.body;

  /* Both record ids are read inside the caller's scope, the same shape as
   * /journeys/:id above and for the same reason: the reply carries the
   * journey's resume_token, as applicant_url. Unscoped, this route copied
   * another book's lead mobile and email onto a new journey and handed the
   * caller a working applicant link into it — and, reached through card_id
   * instead, flipped that book's card to KYC_IN_PROGRESS on the way past. */
  const scope = reqScope(req, 'l');

  const lead = lead_id
    ? one(`SELECT l.* FROM leads l WHERE l.id = ? AND ${scope.sql}`, [lead_id, ...scope.params])
    : null;
  if (lead_id && !lead) return res.status(403).json({ error: 'This lead is outside your visibility scope' });

  const card = card_id
    ? one(`SELECT c.* FROM product_cards c JOIN leads l ON l.id = c.lead_id
            WHERE c.id = ? AND ${scope.sql}`, [card_id, ...scope.params])
    : null;
  if (card_id && !card) return res.status(403).json({ error: 'This card is outside your visibility scope' });

  const productId = product_type_id || card?.product_type_id;
  if (!productId) return res.status(400).json({ error: 'product_type_id or card_id is required' });

  /* A journey belongs to one book, and the product is what says which — the
   * ruling /dkyc-api/start already works from. The steps come from this
   * product's own kyc_journey_steps and the cards from the lead's catalogue,
   * so a Bonanza lead started on a Bigul product is walked through the other
   * business's journey definition for something its book does not sell. */
  const product = one('SELECT id, name, sales_org FROM product_types WHERE id = ?', [Number(productId)]);
  if (!product) return res.status(400).json({ error: 'That product does not exist' });
  if (lead && lead.sales_org !== product.sales_org) {
    return res.status(400).json({
      error: `${product.name} is a ${product.sales_org} product and ${lead.name} is a ${lead.sales_org} lead`,
    });
  }

  const journey = kyc.createJourney({
    leadId: lead_id || null,
    cardId: card_id || null,
    productTypeId: productId,
    mobile: lead?.mobile,
    email: lead?.email,
  });
  audit(req.user.id, 'kyc_journey_created', 'kyc_journey', journey.id, { sales_org: product.sales_org });
  res.status(201).json({ ...journey, applicant_url: `/dkyc/resume/${journey.resume_token}` });
});

internal.post('/journeys/:id/assist', requirePermission('kyc.manage'), (req, res) => {
  res.json(kyc.assist(Number(req.params.id), req.user.id));
});

/** The outcomes a verification may be recorded at, so the screen offers what the write takes. */
internal.get('/verification-outcomes', (_req, res) => res.json({ outcomes: kyc.VERIFICATION_OUTCOMES }));

/**
 * Send an application back to the applicant (gap 2 of the migration mapping).
 *
 * Scoped exactly as the verification route below: with a lead, to that lead's
 * book; without one, kyc.manage alone, because a self-service journey is in
 * neither book until it completes.
 */
internal.post('/journeys/:id/objection', requirePermission('kyc.manage'), (req, res) => {
  const id = Number(req.params.id);
  const journey = one('SELECT * FROM kyc_journeys WHERE id = ?', [id]);
  if (!journey) return res.status(404).json({ error: 'Journey not found' });

  if (journey.lead_id) {
    const scope = reqScope(req, 'l');
    const visible = one(`SELECT 1 v FROM leads l WHERE l.id = ? AND ${scope.sql}`,
      [journey.lead_id, ...scope.params]);
    if (!visible) return res.status(403).json({ error: 'This journey is outside your visibility scope' });
  }

  const out = kyc.raiseObjection(id, {
    text: req.body?.text,
    stepCode: req.body?.step_code ?? null,
    userId: req.user.id,
    source: 'crm',
  });
  if (out.error) return res.status(400).json(out);
  return res.json(out);
});

/**
 * Record how far verification has got (gap 1 of the migration mapping).
 *
 * Book-scoped like `/journeys/:id`, and for the same reason: a journey belongs
 * to the book its lead does, and verifying the other business's application is
 * not something a reviewer in this one should be able to do.
 */
internal.post('/journeys/:id/verification', requirePermission('kyc.manage'), (req, res) => {
  const id = Number(req.params.id);
  const journey = one('SELECT * FROM kyc_journeys WHERE id = ?', [id]);
  if (!journey) return res.status(404).json({ error: 'Journey not found' });

  /* A journey with a lead belongs to the book that lead does, and verifying
     the other business's application is not something a reviewer in this one
     should be able to do. A self-service journey has no lead until it
     completes -- it is in neither book yet, so there is no boundary to police
     and kyc.manage alone governs it. Refusing those would mean nobody could
     ever verify a walk-in application. */
  if (journey.lead_id) {
    const scope = reqScope(req, 'l');
    const visible = one(`SELECT 1 v FROM leads l WHERE l.id = ? AND ${scope.sql}`,
      [journey.lead_id, ...scope.params]);
    if (!visible) return res.status(403).json({ error: 'This journey is outside your visibility scope' });
  }

  const out = kyc.recordVerification(id, req.body?.outcome, req.user.id);
  if (out.error) return res.status(400).json(out);

  /* The applicant's own path calls this when the last step lands. Completion
     happens HERE now, so without it a self-service application would finish
     verification and leave nothing in the CRM: no lead, no card, no owner. */
  if (out.completed) {
    ensureLead(out.journey);
    return res.json({ ...out, journey: kyc.getJourney(id) });
  }
  return res.json(out);
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

/* QA-13 (Ritesh, 13 Oct): a page per business. /dkyc is Bonanza's and
   /dkyc?business=bigul is Bigul's. The one page said "Open your Bonanza
   account" over both businesses' products. */
/* What the page says about its business: the name, the legal entity, and the
   help line it gives the applicant. */
const BUSINESS_FIELDS = 'code, name, legal_name, support_phone, support_email, support_hours';

const dkycBusiness = (req) => {
  const code = String(req.query?.business ?? req.body?.business ?? 'BONANZA').toUpperCase();
  return one(`SELECT ${BUSINESS_FIELDS} FROM sales_orgs WHERE code = ? AND active = 1`, [code]);
};

/** Products a walk-in applicant can open an account for, in the page's business. */
dkyc.get('/products', (req, res) => {
  const business = dkycBusiness(req);
  if (!business) return res.status(404).json({ error: 'We could not find that business' });
  res.json(all(`SELECT id, code, name, category, min_investment, lock_in, risk_category,
                       pitch_points, brochure_url, requires_kyc
                FROM product_types WHERE active = 1 AND requires_kyc = 1 AND sales_org = ? ORDER BY sort_order`, [business.code]));
});

/** Whose page this is: the name and the legal entity the page speaks for. */
dkyc.get('/business', (req, res) => {
  const business = dkycBusiness(req);
  if (!business) return res.status(404).json({ error: 'We could not find that business' });
  res.json(business);
});

dkyc.get('/steps/:productId', (req, res) => {
  res.json(kyc.journeyStepsFor(Number(req.params.productId)));
});

/** Start a fresh self-service application. */
dkyc.post('/start', (req, res) => {
  const { product_type_id, mobile } = req.body;
  if (!product_type_id) return res.status(400).json({ error: 'Please choose a product to continue' });

  /* The product decides the book (Ritesh, 11 Sep 2026).
   *
   * This is a public journey with no session to carry a book, and the
   * catalogue is per business — so the product the applicant chose is the only
   * thing here that says which of the two they are talking to. A product that
   * does not exist names no book, and is refused rather than guessed at. */
  const product = one('SELECT id, sales_org FROM product_types WHERE id = ?', [Number(product_type_id)]);
  if (!product) return res.status(400).json({ error: 'Please choose a product to continue' });
  /* A page names its business, and offers only its products (QA-13). A start
     that names one business and the other's product is refused. */
  if (req.body?.business && String(req.body.business).toUpperCase() !== product.sales_org) {
    return res.status(400).json({ error: 'Please choose one of the products on this page' });
  }

  /* Recognise an existing lead by mobile so the journey attaches to the CRM
     record — within the product's book, never across it. The same person can be
     a lead in both businesses, and attaching a Bigul application to their
     Bonanza record puts a public resume token on the other book's lead. */
  const lead = mobile
    ? one('SELECT * FROM leads WHERE mobile = ? AND sales_org = ? AND deleted_at IS NULL', [mobile, product.sales_org])
    : null;
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

  /* QA-34. Checked against the step's own declaration before any vendor
     call and before anything is stored, and stored as normalised. */
  const definition = kyc.stepByCode(step_code);
  const asOffered = definition && { ...definition, fields: kyc.fieldsForBusiness(definition.fields, journey.product?.sales_org) };
  const { problems, values } = kyc.validateStepPayload(asOffered, payload);
  if (problems.length) {
    return res.status(400).json({ error: problems[0].message, field: problems[0].field, problems });
  }
  const enriched = { ...values };

  // --- vendor-backed steps ------------------------------------------------
  if (['MOBILE_OTP', 'EMAIL_OTP'].includes(step_code)) {
    const submitted = values.otp || values.email_otp;
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
      accountNumber: values.account_number,
      ifsc: values.ifsc,
      accountHolder: values.account_holder,
    });
    enriched.penny_drop = result;
    enriched.penny_drop_failed = result.failed;
    // A failure is not an error — it routes the journey through BANK_PROOF.
  }

  if (step_code === 'ESIGN') {
    const result = esign({ otp: values.esign_otp });
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

  /* The same book the journey was started in, read from the product rather
     than carried along, so the answer cannot drift from /start's. The column
     is NOT NULL on the product, so this is missing only if the product itself
     is gone — and a journey with no book gets no lead rather than a Bonanza
     one by default. */
  const org = one('SELECT sales_org FROM product_types WHERE id = ?', [journey.product_type_id])?.sales_org;
  if (!org) return;

  const existing = f.mobile || journey.applicant_mobile
    ? one('SELECT * FROM leads WHERE mobile = ? AND sales_org = ? AND deleted_at IS NULL',
      [f.mobile || journey.applicant_mobile, org])
    : null;

  let leadId = existing?.id;
  if (!leadId) {
    const owner = leastLoadedRm(org);
    const result = run(
      `INSERT INTO leads (sales_org, name, mobile, email, pan, city, state, source, stage, owner_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [org, name, f.mobile || journey.applicant_mobile || null, f.email || journey.applicant_email || null, f.pan || null,
        f.city || null, f.state || null, 'DKYC Portal', 'Qualified', owner],
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
  audit(null, 'dkyc_lead_created', 'lead', leadId, { journey_id: journey.id, sales_org: org });
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
    /* So a resumed application carries its own business's name (QA-13). */
    business: j.product?.sales_org
      ? one(`SELECT ${BUSINESS_FIELDS} FROM sales_orgs WHERE code = ?`, [j.product.sales_org])
      : null,
    form: j.form,
    steps: j.steps
      .filter((s) => s.applies)
      .map((s) => ({
        code: s.code, label: s.label, group: s.group, status: s.status,
        fields: kyc.fieldsForBusiness(s.fields, j.product?.sales_org), note: s.note, timer_s: s.timer_s || s.timer,
        seconds_on_step: s.seconds_on_step,
        /* Whether this is a step the applicant fills in. Without it the portal
           drew the verification step as a form -- and it has no fields, so an
           empty one. What the applicant is NOT told is how far verification has
           got: "internally verified" versus "with the custodian" is our
           process, and the screen says we have it and are checking. */
        waits: s.waits === true,
      })),
    stall: j.stall ? { stalled: j.stall.stalled, seconds_on_step: j.stall.seconds_on_step, timer_s: j.stall.timer_s } : null,
    /* What has to be fixed, in the applicant's own words-to-read. The reason
       is the whole point of an objection -- "there is a problem with your
       application" with no sentence after it is why people ring the branch.
       Who raised it and how many rounds there have been stay internal. */
    objection: j.status === 'Objection'
      ? { text: j.objection_text, step: j.objection_step }
      : null,
  };
}
