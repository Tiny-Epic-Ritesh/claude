/**
 * KYC engine — powers both the customer-facing DKYC portal and the CRM's KYC rail.
 *
 * BRD §7.6 / OD-05 / OD-09:
 *   • DIY journey, 15–20 minutes, no pausing.
 *   • Per-step timer. Exceed it → step is Stalled, Product RM alerted.
 *   • Stalled for 1 hour → journey Abandoned; customer can no longer self-serve.
 *   • A lead can run concurrent journeys for different products.
 *   • An open Critical/High ticket on the card pauses that journey's timer.
 *
 * Step definitions come from Bonanza's published KYC_Process_flow.pdf — the real
 * 16-step account-opening journey.
 */

import { randomUUID } from 'node:crypto';
import { all, one, run, notify, audit, daysSince } from '../db.js';
import { encryptField, decryptField } from '../security.js';

/**
 * The KYC form payload carries address, income band, nominee, bank details and
 * document references — the densest concentration of client PII in the system.
 * It is encrypted at rest as a single blob and only decrypted in memory.
 */
const readForm = (journey) => {
  const raw = decryptField(journey?.form_data);
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
};
const writeForm = (obj) => encryptField(JSON.stringify(obj || {}));

export const STALL_TO_ABANDON_MS = 60 * 60 * 1000;   // OD-09: 1 hour

/* The master step library, exactly as published by Bonanza. */
export const MASTER_STEPS = [
  { code: 'MOBILE', label: 'Enter mobile number', owner_type: 'Lead', timer: 90, group: 'Basic Verification',
    fields: [{ name: 'mobile', label: 'Mobile number', type: 'tel', required: true, pattern: '^[6-9][0-9]{9}$', help: '10-digit Indian mobile' }] },
  { code: 'MOBILE_OTP', label: 'Verify mobile with OTP', owner_type: 'Lead', timer: 120, group: 'Basic Verification',
    fields: [{ name: 'otp', label: 'Enter the 6-digit OTP', type: 'otp', required: true, pattern: '^[0-9]{6}$' }] },
  { code: 'EMAIL', label: 'Enter email address', owner_type: 'Lead', timer: 90, group: 'Basic Verification',
    fields: [{ name: 'email', label: 'Email address', type: 'email', required: true }] },
  { code: 'EMAIL_OTP', label: 'Verify email', owner_type: 'Lead', timer: 120, group: 'Basic Verification',
    fields: [{ name: 'email_otp', label: 'Enter the 6-digit code sent to your email', type: 'otp', required: true, pattern: '^[0-9]{6}$' }] },
  { code: 'PAN', label: 'Enter PAN details', owner_type: 'Lead', timer: 120, group: 'Identity Verification',
    fields: [
      { name: 'pan', label: 'PAN', type: 'text', required: true, pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$', transform: 'upper', help: 'e.g. ABCDE1234F' },
      { name: 'dob', label: 'Date of birth', type: 'date', required: true },
    ] },
  { code: 'AADHAAR_DIGILOCKER', label: 'Verify Aadhaar via DigiLocker', owner_type: 'System', timer: 240, group: 'Identity Verification',
    fields: [{ name: 'digilocker_consent', label: 'I consent to fetch my Aadhaar KYC from DigiLocker', type: 'consent', required: true }] },
  { code: 'PERSONAL', label: 'Personal details', owner_type: 'Lead', timer: 240, group: 'Personal Details',
    fields: [
      { name: 'gender', label: 'Gender', type: 'select', required: true, options: ['Male', 'Female', 'Other'] },
      { name: 'marital_status', label: 'Marital status', type: 'select', required: true, options: ['Single', 'Married', 'Other'] },
      { name: 'father_spouse', label: "Father's / Spouse name", type: 'text', required: true },
      { name: 'address', label: 'Address', type: 'textarea', required: true },
      { name: 'city', label: 'City', type: 'text', required: true },
      { name: 'state', label: 'State', type: 'text', required: true },
      { name: 'pincode', label: 'PIN code', type: 'text', required: true, pattern: '^[0-9]{6}$' },
    ] },
  { code: 'FINANCIAL', label: 'Financial & background information', owner_type: 'Lead', timer: 240, group: 'Financial Information',
    fields: [
      { name: 'trading_experience', label: 'Trading experience', type: 'select', required: true, options: ['None', 'Less than 1 year', '1–3 years', '3–5 years', 'More than 5 years'] },
      { name: 'education', label: 'Education', type: 'select', required: true, options: ['High School', 'Graduate', 'Post Graduate', 'Professional', 'Other'] },
      { name: 'occupation', label: 'Occupation', type: 'select', required: true, options: ['Private Sector', 'Public Sector', 'Government Service', 'Business', 'Professional', 'Agriculturist', 'Retired', 'Housewife', 'Student', 'Other'] },
      { name: 'annual_income', label: 'Annual income', type: 'select', required: true, options: ['Below ₹1 Lakh', '₹1–5 Lakh', '₹5–10 Lakh', '₹10–25 Lakh', '₹25 Lakh–1 Crore', 'Above ₹1 Crore'] },
      { name: 'politically_exposed', label: 'Are you a politically exposed person?', type: 'select', required: true, options: ['No', 'Yes'] },
    ] },
  { code: 'BANK', label: 'Bank account verification', owner_type: 'System', timer: 300, group: 'Bank Verification',
    fields: [
      { name: 'account_number', label: 'Bank account number', type: 'text', required: true },
      { name: 'ifsc', label: 'IFSC code', type: 'text', required: true, pattern: '^[A-Z]{4}0[A-Z0-9]{6}$', transform: 'upper' },
      { name: 'account_holder', label: 'Account holder name', type: 'text', required: true },
    ],
    note: 'Verified by penny drop. If the penny drop fails you can continue with manual entry and upload bank proof.' },
  { code: 'BANK_PROOF', label: 'Upload bank proof', owner_type: 'Lead', timer: 180, group: 'Bank Verification',
    conditional_on: 'penny_drop_failed',
    fields: [{ name: 'bank_proof', label: 'Cancelled cheque or bank statement', type: 'file', required: true, accept: 'image/*,application/pdf' }] },
  { code: 'NOMINEE', label: 'Nominee details', owner_type: 'Lead', timer: 240, group: 'Nominee',
    fields: [
      { name: 'nominee_opt', label: 'Do you want to add a nominee?', type: 'select', required: true, options: ['Add nominee', 'Opt out'] },
      { name: 'nominee_name', label: 'Nominee name', type: 'text', required: false },
      { name: 'nominee_relation', label: 'Relationship', type: 'select', required: false, options: ['Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Brother', 'Sister', 'Other'] },
      { name: 'nominee_share', label: 'Share (%)', type: 'number', required: false },
    ] },
  { code: 'SEGMENTS', label: 'Segment & depository selection', owner_type: 'Lead', timer: 180, group: 'Segments',
    fields: [
      { name: 'segments', label: 'Trading segments', type: 'multiselect', required: true,
        options: ['Equity Cash', 'Equity Derivatives (F&O)', 'Currency Derivatives', 'Commodity', 'Mutual Funds'] },
      { name: 'depository', label: 'Depository', type: 'select', required: true, options: ['CDSL', 'NSDL'] },
      { name: 'plan', label: 'Brokerage plan', type: 'select', required: true, options: ['Bigul Flat ₹0 Delivery', 'Classic Percentage Plan', 'PMS / Advisory'] },
    ] },
  { code: 'INCOME_PROOF', label: 'Upload income proof', owner_type: 'Lead', timer: 300, group: 'Income Proof',
    conditional_on: 'income_gt_10L_or_fno',
    fields: [{ name: 'income_proof', label: 'Latest ITR, Form 16, 6-month bank statement or salary slip', type: 'file', required: true, accept: 'image/*,application/pdf' }],
    note: 'Required only when annual income exceeds ₹10 Lakh or the F&O segment is selected.' },
  { code: 'SELFIE', label: 'Capture selfie (IPV)', owner_type: 'Lead', timer: 180, group: 'Final Verification',
    fields: [{ name: 'selfie', label: 'Live photograph', type: 'capture', required: true }] },
  { code: 'SIGNATURE', label: 'Upload signature', owner_type: 'Lead', timer: 180, group: 'Final Verification',
    fields: [{ name: 'signature', label: 'Signature on white paper', type: 'file', required: true, accept: 'image/*' }] },
  { code: 'ESIGN', label: 'eSign with Aadhaar OTP', owner_type: 'System', timer: 300, group: 'Final Verification',
    fields: [{ name: 'esign_otp', label: 'Aadhaar OTP', type: 'otp', required: true, pattern: '^[0-9]{6}$' }] },
];

export const stepByCode = (code) => MASTER_STEPS.find((s) => s.code === code);

/**
 * The step list as it was in a saved version, or null if that version is gone.
 *
 * Read straight from the snapshot rather than through engine/versioning.js, to
 * keep this module free of a dependency it would otherwise need only here.
 */
function pinnedJourney(versionId) {
  const row = one('SELECT payload FROM artefact_versions WHERE id = ? AND kind = ?',
    [versionId, 'kyc_journey']);
  if (!row) return null;
  try {
    const steps = JSON.parse(row.payload)?.steps ?? [];
    return steps.length ? steps : null;
  } catch { return null; }
}

/* ------------------------------------------------------------- journeys */

/**
 * Which steps apply to this product, honouring the Journey Composer overrides.
 *
 * `versionId` pins the answer to a specific saved version of the journey. A
 * journey already under way passes the version it started on, so an applicant
 * who began a sixteen-step flow finishes those sixteen steps even if somebody
 * edits the definition while they are halfway through it. Without the pin, a
 * definition change would add or remove steps under a live applicant.
 */
export function journeyStepsFor(productTypeId, versionId = null) {
  const pinned = versionId ? pinnedJourney(versionId) : null;
  const configured = pinned ?? all(
    'SELECT * FROM kyc_journey_steps WHERE product_type_id = ? ORDER BY sort_order',
    [productTypeId],
  );
  if (!configured.length) {
    return MASTER_STEPS.map((s, i) => ({ ...s, sort_order: i, timer_s: s.timer }));
  }
  return configured
    .map((c) => {
      const master = stepByCode(c.step_code);
      return master ? { ...master, sort_order: c.sort_order, timer_s: c.timer_override_s || master.timer, conditional_on: c.conditional_on || master.conditional_on } : null;
    })
    .filter(Boolean);
}

/**
 * Conditional steps are skipped unless the captured data triggers them.
 * BANK_PROOF only on penny-drop failure; INCOME_PROOF on >₹10L or F&O.
 */
export function stepApplies(step, form) {
  if (!step.conditional_on) return true;

  if (step.conditional_on === 'penny_drop_failed') return form.penny_drop_failed === true;

  if (step.conditional_on === 'income_gt_10L_or_fno') {
    const highIncome = ['₹10–25 Lakh', '₹25 Lakh–1 Crore', 'Above ₹1 Crore'].includes(form.annual_income);
    const fno = Array.isArray(form.segments) && form.segments.some((s) => /F&O|Derivatives/i.test(s));
    return highIncome || fno;
  }
  return true;
}

export function createJourney({ leadId = null, cardId = null, productTypeId, mobile = null, email = null }) {
  const token = randomUUID();
  const steps = journeyStepsFor(productTypeId);

  /* The definition this applicant is starting on, remembered now.
   *
   * Null when the journey has never been saved through the composer, which
   * means it is the master step list and there is nothing to pin to. */
  const pin = one(
    'SELECT id FROM artefact_versions WHERE kind = ? AND logical_id = ? AND is_current = 1',
    ['kyc_journey', String(productTypeId)],
  )?.id ?? null;

  const result = run(
    `INSERT INTO kyc_journeys (lead_id, card_id, product_type_id, applicant_mobile, applicant_email, resume_token, status, current_step, form_data, started_at, journey_version_id)
     VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?)`,
    [leadId, cardId, productTypeId, mobile, email, token, 'In Progress', steps[0].code, writeForm({}), pin],
  );
  const journeyId = Number(result.lastInsertRowid);

  steps.forEach((s, i) => {
    run('INSERT INTO kyc_journey_progress (journey_id, step_code, status, entered_at) VALUES (?,?,?,?)', [
      journeyId, s.code, i === 0 ? 'active' : 'pending', i === 0 ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
    ]);
  });

  if (cardId) {
    run("UPDATE product_cards SET state = 'KYC_IN_PROGRESS', last_state_at = datetime('now') WHERE id = ?", [cardId]);
  }
  if (leadId) {
    // The lead's KYC status is derived from this journey — see
    // engine/kycstatus.js. Nothing is copied onto the lead.
  }
  audit(null, 'kyc_started', 'kyc_journey', journeyId, { productTypeId, leadId });
  return getJourney(journeyId);
}

export function getJourney(id, { byToken = false } = {}) {
  const journey = byToken
    ? one('SELECT * FROM kyc_journeys WHERE resume_token = ?', [id])
    : one('SELECT * FROM kyc_journeys WHERE id = ?', [id]);
  if (!journey) return null;

  const form = readForm(journey);
  // Read against the version this applicant started on, not whatever the
  // composer holds now -- otherwise editing a journey rewrites the steps under
  // everyone currently part-way through it.
  const defs = journeyStepsFor(journey.product_type_id, journey.journey_version_id);
  const progress = all('SELECT * FROM kyc_journey_progress WHERE journey_id = ?', [journey.id]);

  const steps = defs.map((def) => {
    const p = progress.find((x) => x.step_code === def.code) || {};
    return {
      ...def,
      applies: stepApplies(def, form),
      status: p.status || 'pending',
      entered_at: p.entered_at,
      completed_at: p.completed_at,
      seconds_on_step: p.seconds_on_step || 0,
      payload: p.payload ? JSON.parse(p.payload) : null,
    };
  });

  const product = one('SELECT * FROM product_types WHERE id = ?', [journey.product_type_id]);
  const applicable = steps.filter((s) => s.applies);
  const done = applicable.filter((s) => s.status === 'done').length;

  return {
    ...journey,
    form,
    product,
    steps,
    progress_pct: applicable.length ? Math.round((done / applicable.length) * 100) : 0,
    steps_done: done,
    steps_total: applicable.length,
    elapsed_s: computeElapsed(journey),
    stall: stallState(journey, steps),
  };
}

function computeElapsed(journey) {
  if (!journey.started_at) return 0;
  const start = new Date(`${journey.started_at.replace(' ', 'T')}Z`).getTime();
  const end = journey.completed_at
    ? new Date(`${journey.completed_at.replace(' ', 'T')}Z`).getTime()
    : journey.abandoned_at
      ? new Date(`${journey.abandoned_at.replace(' ', 'T')}Z`).getTime()
      : Date.now();
  return Math.max(0, Math.round((end - start) / 1000));
}

/** Is the active step past its timer, and by how long? */
function stallState(journey, steps) {
  const active = steps.find((s) => s.status === 'active');
  if (!active || !active.entered_at || journey.status === 'Complete') return null;

  const enteredMs = new Date(`${active.entered_at.replace(' ', 'T')}Z`).getTime();
  const onStepS = Math.round((Date.now() - enteredMs) / 1000);
  const timer = active.timer_s || active.timer || 180;

  return {
    step_code: active.code,
    step_label: active.label,
    seconds_on_step: onStepS,
    timer_s: timer,
    stalled: onStepS > timer,
    over_by_s: Math.max(0, onStepS - timer),
    abandon_in_s: Math.max(0, Math.round(STALL_TO_ABANDON_MS / 1000) - Math.max(0, onStepS - timer)),
  };
}

/** Record a completed step and move the journey to the next applicable one. */
export function submitStep(journeyId, stepCode, payload) {
  const journey = one('SELECT * FROM kyc_journeys WHERE id = ?', [journeyId]);
  if (!journey) return { error: 'Journey not found' };
  if (journey.status === 'Abandoned') {
    return { error: 'This application was abandoned. A Bonanza representative will assist you from here.', abandoned: true };
  }
  if (journey.status === 'Complete') return { error: 'This application is already complete.' };

  const form = { ...readForm(journey), ...payload };

  // Simulated penny drop: the adapter decides, the journey just records the outcome.
  if (stepCode === 'BANK') form.penny_drop_failed = payload.penny_drop_failed === true;

  const current = one('SELECT * FROM kyc_journey_progress WHERE journey_id = ? AND step_code = ?', [journeyId, stepCode]);
  const onStepS = current?.entered_at
    ? Math.round((Date.now() - new Date(`${current.entered_at.replace(' ', 'T')}Z`).getTime()) / 1000)
    : 0;

  run(
    `UPDATE kyc_journey_progress SET status = 'done', completed_at = datetime('now'), seconds_on_step = ?, payload = ?
     WHERE journey_id = ? AND step_code = ?`,
    [onStepS, JSON.stringify(payload), journeyId, stepCode],
  );

  const steps = journeyStepsFor(journey.product_type_id, journey.journey_version_id);
  const idx = steps.findIndex((s) => s.code === stepCode);
  const next = steps.slice(idx + 1).find((s) => stepApplies(s, form));

  // Steps that turned out not to apply are marked skipped, not left pending.
  for (const s of steps.slice(idx + 1)) {
    if (next && s.code === next.code) break;
    if (!stepApplies(s, form)) {
      run("UPDATE kyc_journey_progress SET status = 'skipped' WHERE journey_id = ? AND step_code = ?", [journeyId, s.code]);
    }
  }

  if (next) {
    run("UPDATE kyc_journey_progress SET status = 'active', entered_at = datetime('now') WHERE journey_id = ? AND step_code = ?", [journeyId, next.code]);
    run('UPDATE kyc_journeys SET current_step = ?, form_data = ?, status = ? WHERE id = ?', [
      next.code, writeForm(form), 'In Progress', journeyId,
    ]);
    return { done: false, next_step: next.code, journey: getJourney(journeyId) };
  }

  return { done: true, journey: completeJourney(journeyId, form) };
}

export function completeJourney(journeyId, form) {
  const journey = one('SELECT * FROM kyc_journeys WHERE id = ?', [journeyId]);
  run(
    `UPDATE kyc_journeys SET status = 'Complete', completed_at = datetime('now'), current_step = NULL, form_data = ?, elapsed_s = ?
     WHERE id = ?`,
    [writeForm(form || readForm(journey)), computeElapsed(journey), journeyId],
  );

  // KYC complete flips the product card to ACTIVE (BRD §2.3).
  if (journey.card_id) {
    const card = one('SELECT * FROM product_cards WHERE id = ?', [journey.card_id]);
    run("UPDATE product_cards SET state = 'ACTIVE', last_state_at = datetime('now') WHERE id = ?", [journey.card_id]);
    run('INSERT INTO card_audit (card_id, from_state, to_state, note) VALUES (?,?,?,?)', [
      journey.card_id, card?.state, 'ACTIVE', 'KYC completed via DKYC portal',
    ]);
  }
  if (journey.lead_id) {
    // Derived, not stamped.
    run('INSERT INTO activities (lead_id, card_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?,NULL)', [
      journey.lead_id, journey.card_id, 'KYC Event', 'system', 'KYC completed',
      'Applicant completed the DKYC journey end to end.',
    ]);
    const lead = one('SELECT * FROM leads WHERE id = ?', [journey.lead_id]);
    notify(lead?.owner_id, 'KYC complete', `${lead?.name} finished KYC — card is now Active.`, `/leads/${journey.lead_id}`);
  }
  audit(null, 'kyc_complete', 'kyc_journey', journeyId, {});
  return getJourney(journeyId);
}

/**
 * Sweep in-progress journeys: flag stalls, abandon after an hour, pause on tickets.
 * Runs on an interval and is also exposed to the CRM for a manual refresh.
 */
export function sweepKyc() {
  const live = all("SELECT * FROM kyc_journeys WHERE status IN ('In Progress','Stalled')");
  let stalled = 0;
  let abandoned = 0;

  for (const journey of live) {
    // BRD §7.6: an open Critical/High ticket on this card freezes the timer.
    if (journey.card_id) {
      const blocking = one(
        `SELECT COUNT(*) n FROM tickets WHERE card_id = ? AND priority IN ('Critical','High') AND status NOT IN ('Resolved','Closed')`,
        [journey.card_id],
      );
      if (blocking.n > 0) continue;
    }

    const full = getJourney(journey.id);
    const stall = full?.stall;
    if (!stall?.stalled) continue;

    if (journey.status !== 'Stalled') {
      run("UPDATE kyc_journeys SET status = 'Stalled', stalled_at = datetime('now') WHERE id = ?", [journey.id]);
      run("UPDATE kyc_journey_progress SET status = 'stalled' WHERE journey_id = ? AND step_code = ?", [journey.id, stall.step_code]);
      stalled += 1;

      const card = journey.card_id ? one('SELECT * FROM product_cards WHERE id = ?', [journey.card_id]) : null;
      notify(card?.product_rm_id, 'KYC stalled', `Applicant stuck on "${stall.step_label}" for ${Math.round(stall.seconds_on_step / 60)} min.`,
        `/kyc/${journey.id}`);
      audit(null, 'kyc_stalled', 'kyc_journey', journey.id, { step: stall.step_code });
    }

    // Stalled for a full hour → Abandoned (OD-09). No further DIY progress.
    if (stall.over_by_s * 1000 >= STALL_TO_ABANDON_MS) {
      run("UPDATE kyc_journeys SET status = 'Abandoned', abandoned_at = datetime('now'), elapsed_s = ? WHERE id = ?", [
        computeElapsed(journey), journey.id,
      ]);
      abandoned += 1;

      if (journey.lead_id) {
        // Derived, not stamped.
        const lead = one('SELECT * FROM leads WHERE id = ?', [journey.lead_id]);
        notify(lead?.owner_id, 'KYC abandoned', `${lead?.name} abandoned KYC at "${stall.step_label}". Assisted completion required.`,
          `/leads/${journey.lead_id}`);
      }
      audit(null, 'kyc_abandoned', 'kyc_journey', journey.id, { step: stall.step_code });
    }
  }
  return { checked: live.length, stalled, abandoned };
}

/** Product RM takes over an abandoned/stalled journey (assisted completion). */
export function assist(journeyId, userId) {
  run("UPDATE kyc_journeys SET assisted_by = ?, status = 'In Progress' WHERE id = ?", [userId, journeyId]);
  const journey = one('SELECT * FROM kyc_journeys WHERE id = ?', [journeyId]);
  if (journey?.current_step) {
    run("UPDATE kyc_journey_progress SET status = 'active', entered_at = datetime('now') WHERE journey_id = ? AND step_code = ?",
      [journeyId, journey.current_step]);
  }
  audit(userId, 'kyc_assist', 'kyc_journey', journeyId, {});
  return getJourney(journeyId);
}

/** KYC health across all live journeys — feeds the Product Supervisor cockpit. */
export function kycHealth(productTypeId = null) {
  const rows = all(`
    SELECT j.*, p.name AS product_name, l.name AS lead_name, u.name AS product_rm_name
    FROM kyc_journeys j
    LEFT JOIN product_types p ON p.id = j.product_type_id
    LEFT JOIN leads l ON l.id = j.lead_id
    LEFT JOIN product_cards pc ON pc.id = j.card_id
    LEFT JOIN users u ON u.id = pc.product_rm_id
    ${productTypeId ? 'WHERE j.product_type_id = ?' : ''}
    ORDER BY j.created_at DESC
  `, productTypeId ? [productTypeId] : []);

  return rows.map((r) => {
    const full = getJourney(r.id);
    return {
      ...r,
      current_step_label: full?.stall?.step_label || (r.status === 'Complete' ? 'Completed' : r.current_step),
      seconds_on_step: full?.stall?.seconds_on_step ?? 0,
      progress_pct: full?.progress_pct ?? 0,
      elapsed_s: full?.elapsed_s ?? 0,
      age_days: daysSince(r.created_at),
    };
  });
}
