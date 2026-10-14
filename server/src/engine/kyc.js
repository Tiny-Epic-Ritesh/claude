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
    note: 'If you gave your number when you started, it is filled in. We send a code to the number you confirm here.',
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
      { name: 'dob', label: 'Date of birth', type: 'date', required: true, help: 'You must be 18 or over to open an account online' },
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
      // No Indian PIN starts with 0; security.js V.pincode has always said so.
      { name: 'pincode', label: 'PIN code', type: 'text', required: true, pattern: '^[1-9][0-9]{5}$', help: '6 digits, not starting with 0' },
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
      { name: 'account_number', label: 'Bank account number', type: 'text', required: true, pattern: '^[0-9]{9,18}$', help: '9 to 18 digits' },
      { name: 'ifsc', label: 'IFSC code', type: 'text', required: true, pattern: '^[A-Z]{4}0[A-Z0-9]{6}$', transform: 'upper' },
      { name: 'account_holder', label: 'Account holder name', type: 'text', required: true },
    ],
    note: 'Verified by penny drop. If the penny drop fails you can continue with manual entry and upload bank proof.' },
  { code: 'BANK_PROOF', label: 'Upload bank proof', owner_type: 'Lead', timer: 180, group: 'Bank Verification',
    conditional_on: 'penny_drop_failed',
    fields: [{ name: 'bank_proof', label: 'Cancelled cheque or bank statement', type: 'file', required: true, accept: 'image/*,application/pdf' }] },
  /*
   * Nominees, as SEBI's circular of 29 May 2026 sets them
   * (SEBI/HO/OIAE/OIAE_IAD-3/P/CIR/2026/12676, in force from 1 Sep 2026; it
   * supersedes the circular of 10 January 2025 this step was first built to).
   * Ruled 14 Oct: follow it.
   *
   *   - up to three nominees (5.1);
   *   - mandatory: the nominee's name and relationship, and a date of birth
   *     when the nominee is a minor (7a);
   *   - optional, and the applicant may give all, any or none of it (7b, 7c):
   *     a share, mobile, email and one identifier -- Aadhaar (last four
   *     digits), PAN, driving licence or passport, the number only -- and the
   *     same for a minor's guardian (Annexure-A);
   *   - no shares given: split equally, any odd lot to the first nominee (7b);
   *   - the applicant's choice of what the statement of holding shows
   *     (Annexure-A, 2; 10.1);
   *   - opting out shows the Annexure-B declaration in full and the applicant
   *     agrees to it (8b). No OTP and no video: those were the January 2025
   *     circular's.
   *
   * The journey is the applicant's own, so the form validates as they go and
   * the server checks every rule again on submit.
   */
  { code: 'NOMINEE', label: 'Nominee details', owner_type: 'Lead', timer: 420, group: 'Nominee',
    note: 'You can name up to 3 nominees. Only each nominee\'s name and relationship are needed, and a date of birth for a minor. Give each a share, or leave every share blank and they are split equally.',
    fields: [
      { name: 'nominee_opt', label: 'Do you want to add nominees?', type: 'select', required: true, options: ['Add nominee', 'Opt out'] },
      { name: 'nominees', label: 'Nominees', type: 'nominees', required: false, required_when_shown: true,
        shown_when: { field: 'nominee_opt', equals: 'Add nominee' }, max: 3,
        relationships: ['Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Brother', 'Sister', 'Other'],
        id_types: ['Aadhaar (last 4 digits)', 'PAN', 'Driving licence', 'Passport'] },
      { name: 'nominee_statement', label: 'On my statement of holdings, show', type: 'select', required: false, required_when_shown: true,
        shown_when: { field: 'nominee_opt', equals: 'Add nominee' },
        options: ['The names of my nominees', 'Only whether I have made a nomination'] },
      /* Annexure-B, word for word: the regulated entity displays it and the
         investor agrees by choosing this option (8b). */
      { name: 'optout_declaration', type: 'consent', required: false, required_when_shown: true,
        shown_when: { field: 'nominee_opt', equals: 'Opt out' },
        declaration: {
          title: 'Declaration for Opting-out of Nomination',
          lead: 'I hereby confirm that I do not wish to appoint any nominee(s) to my demat account/ mutual fund folio at this point of time.',
          understand: [
            'the nomination helps to quickly identify the person for transfer of securities and helps in faster and smoother transmission of my securities to my legal heir(s) after my demise.',
            'in the absence of a nomination, my legal heir(s) may require the submission of certain additional legal or court-issued documents which may delay the process of transmission of securities to my legal heir(s).',
            'if no claim is made on the account / folio for a prolonged period after my demise, the holdings may be treated as unclaimed assets and they may be transferred to Investor Education and protection Fund Authority (IEPF) in accordance with the applicable regulatory framework.',
          ],
        },
        label: 'I confirm that I have understood the above implications and that my decision to opt out of nomination is voluntary.' },
    ] },
  { code: 'SEGMENTS', label: 'Segment & depository selection', owner_type: 'Lead', timer: 180, group: 'Segments',
    fields: [
      { name: 'segments', label: 'Trading segments', type: 'multiselect', required: true,
        options: ['Equity Cash', 'Equity Derivatives (F&O)', 'Currency Derivatives', 'Commodity', 'Mutual Funds'] },
      { name: 'depository', label: 'Depository', type: 'select', required: true, options: ['CDSL', 'NSDL'] },
      /* QA-13 (Ritesh, 13 Oct): Bigul's flat plan on Bigul applications only.
         `options` is every plan any business offers, for screens that list
         them all; an applicant is offered their own business's. */
      { name: 'plan', label: 'Brokerage plan', type: 'select', required: true, options: ['Bigul Flat ₹0 Delivery', 'Classic Percentage Plan', 'PMS / Advisory'],
        options_by_business: { BONANZA: ['Classic Percentage Plan', 'PMS / Advisory'], BIGUL: ['Bigul Flat ₹0 Delivery', 'Classic Percentage Plan'] } },
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
  /*
   * The seventeenth step, and the only one nobody can hurry.
   *
   * Everything above is the applicant's fifteen to twenty minutes. This is what
   * happens next: Bonanza checks the application, and then the depository does.
   * The journey had no step for it, so "waiting on the custodian" could only be
   * inferred -- which is exactly why the legacy tenant grew APPLICATION UNDER
   * VERIFICATION, INTERNALLY VERIFIED and CUSTODIAN VERIFIED as three stages of
   * a pipeline that was supposed to be about selling (gap 1 of
   * docs/feedback/MIGRATION-STAGE-SOURCE-MAPPING.md).
   *
   * "waits" is the whole difference between this step and the sixteen above it.
   * A timed step the applicant is not sitting at would stall within minutes and
   * be abandoned within the hour, reporting somebody as having given up while
   * their file sits in a queue at the depository. So a waiting step is outside
   * the timers, outside the sweep, and stops the clock on the applicant's own
   * journey when they reach it.
   */
  { code: 'VERIFICATION', label: 'Verification', owner_type: 'Ops', timer: 0, waits: true,
    group: 'Verification', fields: [],
    note: 'Bonanza checks the application, then the depository confirms it. Not a step the applicant fills in.' },
];

/**
 * How far verification has got.
 *
 * Three answers rather than a flag, because the two that are not "done" are
 * different problems with different owners: an application under review is ours
 * to move, and one waiting on the custodian is not. A single verified yes/no is
 * what left the legacy tenant unable to answer "how many are stuck with us?"
 * without somebody reading stage names.
 */
export const VERIFICATION_OUTCOMES = [
  { code: 'UNDER_REVIEW', label: 'Under review', waiting_on: 'Bonanza' },
  { code: 'INTERNALLY_VERIFIED', label: 'Internally verified', waiting_on: 'the custodian' },
  { code: 'CUSTODIAN_VERIFIED', label: 'Custodian verified', waiting_on: null },
];

export const verificationOutcome = (code) =>
  VERIFICATION_OUTCOMES.find((o) => o.code === code) ?? null;

export const stepByCode = (code) => MASTER_STEPS.find((s) => s.code === code);

/** A step's fields as one business's applicant sees them (QA-13). */
export const fieldsForBusiness = (fields = [], business = null) => fields.map(({ options_by_business: byBusiness, ...f }) => (
  byBusiness && business && byBusiness[business] ? { ...f, options: byBusiness[business] } : f
));

/**
 * Check one step's answers against what the step declares (QA-34).
 *
 * The declarations were always here -- required, pattern, options, the
 * upper-casing of a PAN -- and the portal passed only `required` to the
 * browser, while the server checked nothing. A public journey that ends in an
 * account application took mobile 123, PAN BAD and a 150% nominee, and kept
 * them on the lead. The browser is a courtesy; this is the check.
 *
 * Returns `{ problems, values }`: the problems in field order, each with the
 * field and a sentence for the applicant, and the answers as they should be
 * stored -- trimmed, and upper-cased where the field says so.
 */
export function validateStepPayload(step, payload = {}, form = {}) {
  const problems = [];
  const values = { ...payload };
  if (!step) return { problems, values };

  const today = new Date().toISOString().slice(0, 10);

  /* A field shown only for one answer -- the nominees for "Add nominee", the
     declaration for "Opt out" -- is required only then, and cleared when it is
     not shown: opting out after naming nominees drops them. */
  const shown = (f) => !f.shown_when || payload[f.shown_when.field] === f.shown_when.equals;

  for (const f of step.fields ?? []) {
    if (!shown(f)) { values[f.name] = null; continue; }
    let v = payload[f.name];
    if (typeof v === 'string') {
      v = v.trim();
      if (f.transform === 'upper') v = v.toUpperCase();
      values[f.name] = v;
    }

    const present = f.type === 'consent' ? v === true || v === 'true'
      : ['multiselect', 'nominees'].includes(f.type) ? Array.isArray(v) && v.length > 0
        : v !== undefined && v !== null && String(v).trim() !== '';
    const required = f.required || f.required_when_shown;

    if (!present) {
      if (required) {
        problems.push({
          field: f.name,
          message: f.type === 'consent' ? `Please confirm: ${f.label}`
            : f.type === 'nominees' ? 'Add at least one nominee, or choose to opt out' : `${f.label} is required`,
        });
      }
      continue;
    }

    if (f.type === 'nominees') {
      const checked = validateNominees(v, f, { applicantPan: form?.pan ?? null, today });
      problems.push(...checked.problems);
      if (!checked.problems.length) values[f.name] = checked.nominees;
      continue;
    }

    if (f.pattern && !new RegExp(f.pattern).test(String(v))) {
      problems.push({ field: f.name, message: `${f.label} is not valid${f.help ? ` — ${f.help}` : ''}` });
      continue;
    }
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v))) {
      problems.push({ field: f.name, message: `${f.label} is not a valid email address` });
      continue;
    }
    if (f.type === 'select' && f.options && !f.options.includes(v)) {
      problems.push({ field: f.name, message: `Choose one of the listed options for ${f.label}` });
      continue;
    }
    if (f.type === 'multiselect' && f.options && !v.every((x) => f.options.includes(x))) {
      problems.push({ field: f.name, message: `Choose only the listed options for ${f.label}` });
      continue;
    }
    if (f.type === 'date') {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
      if (!ok) { problems.push({ field: f.name, message: `${f.label} is not a date` }); continue; }
      if (v > today) { problems.push({ field: f.name, message: `${f.label} cannot be in the future` }); continue; }
      if (v < '1900-01-01') { problems.push({ field: f.name, message: `${f.label} is not plausible` }); continue; }
    }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) { problems.push({ field: f.name, message: `${f.label} must be a number` }); continue; }
      if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) {
        problems.push({ field: f.name, message: `${f.label} must be between ${f.min} and ${f.max}` });
        continue;
      }
      values[f.name] = n;
    }
  }

  /* QA-34, ruled 13 Oct: follow industry practice.
   *
   * An individual account opened online is an adult's. A minor's account is
   * opened and operated by a parent or court-appointed guardian, with the
   * guardian's KYC alongside the minor's, and brokers take those offline
   * rather than through a self-serve journey -- so this journey refuses an
   * applicant under 18 and says where to go instead. */
  const fieldOk = (name) => !problems.some((p) => p.field === name);
  if (step.code === 'PAN' && typeof values.dob === 'string' && fieldOk('dob') && yearsOld(values.dob, today) < 18) {
    problems.push({
      field: 'dob',
      message: 'You must be 18 or over to open an account online. A parent or guardian can open an account for a minor with us — call us and we will help.',
    });
  }

  return { problems, values };
}

/* What each identifier SEBI accepts for a nominee looks like (Annexure-A,
   3d: the number only, never the document). Driving licences are the state
   code, the RTO, then the year and serial: MH14 2011 0062821. An Indian
   passport is a letter and seven digits. */
const NOMINEE_ID_RULES = {
  PAN: { pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/, help: 'e.g. ABCDE1234F' },
  'Driving licence': { pattern: /^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,12}$/, help: '15 or 16 characters, e.g. MH1420110062821' },
  'Aadhaar (last 4 digits)': { pattern: /^[0-9]{4}$/, help: 'only the last 4 digits' },
  Passport: { pattern: /^[A-Z][0-9]{7}$/, help: 'a letter and 7 digits, e.g. A1234567' },
};

const truthy = (v) => v === true || v === 'true';
const blank = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * Check a list of nominees against SEBI's nomination rules (May 2026).
 *
 * Returns `{ problems, nominees }`: each problem names the nominee by number,
 * and `nominees` is the list as it should be stored -- trimmed, identifiers
 * upper-cased, a minor's date of birth and guardian kept and an adult's
 * dropped, shares as numbers or null when they are to be split equally, and
 * an optional detail nobody gave stored as null rather than as an empty
 * string.
 *
 * Only the name and relationship are required, and a minor's date of birth
 * (7a). Everything else is optional (7b) and the applicant may give all, any
 * or none of it (7c) -- but what is given is checked, because a mobile that
 * cannot be dialled is worse than none: it is the number somebody will try
 * when the investor has died.
 */
export function validateNominees(list, field, { applicantPan = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const problems = [];
  const say = (message, nominee = null) => problems.push({ field: 'nominees', nominee, message });
  const max = field?.max ?? 3;
  const relationships = field?.relationships ?? [];
  const idTypes = field?.id_types ?? Object.keys(NOMINEE_ID_RULES);
  const idNames = idTypes.map((t) => (t.startsWith('Aadhaar') ? 'the last 4 digits of Aadhaar' : t)).join(', ');

  if (!Array.isArray(list) || !list.length) { say('Add at least one nominee, or choose to opt out'); return { problems, nominees: [] }; }
  if (list.length > max) { say(`You can name up to ${max} nominees`); return { problems, nominees: [] }; }

  /* One optional contact-and-identifier set, checked only where given. Used
     for a nominee and for a minor's guardian alike (Annexure-A, note ***). */
  const optionalDetails = (n, prefix, who, i) => {
    const text = (k) => String(n[`${prefix}${k}`] ?? '').trim();
    const mobile = text('mobile').replace(/\D/g, '').slice(-10);
    const email = text('email');
    const idNumber = text('id_number').toUpperCase().replace(/[\s-]/g, '');
    const idType = idNumber ? text('id_type') : '';
    if (mobile && !/^[6-9][0-9]{9}$/.test(mobile)) say(`${who}: a mobile number is 10 digits — or leave it blank`, i);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) say(`${who}: that email address is not valid — or leave it blank`, i);
    if (idNumber) {
      const rule = NOMINEE_ID_RULES[idType];
      if (!idTypes.includes(idType) || !rule) say(`${who}: say which identifier that is — ${idNames}`, i);
      else if (!rule.pattern.test(idNumber)) say(`${who}: the ${idType} number is not valid — ${rule.help}`, i);
    }
    return {
      [`${prefix}mobile`]: mobile || null,
      [`${prefix}email`]: email || null,
      [`${prefix}id_type`]: idNumber ? idType : null,
      [`${prefix}id_number`]: idNumber || null,
    };
  };

  const nominees = list.map((raw, i) => {
    const n = raw && typeof raw === 'object' ? raw : {};
    const who = `Nominee ${i + 1}`;
    const text = (k) => String(n[k] ?? '').trim();
    const out = {
      name: text('name'),
      relationship: text('relationship'),
      ...optionalDetails(n, '', who, i),
      minor: truthy(n.minor),
      dob: null,
      guardian_name: null,
      guardian_relation: null,
      guardian_mobile: null,
      guardian_email: null,
      guardian_id_type: null,
      guardian_id_number: null,
      share: blank(n.share) ? null : Number(n.share),
    };

    if (out.name.length < 2) say(`${who}: give their full name`, i);
    if (!relationships.includes(out.relationship)) say(`${who}: choose their relationship to you`, i);

    /* A minor's date of birth is required (7a); their guardian, and the
       guardian's details, are optional (7b). */
    if (out.minor) {
      const dob = text('dob');
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(dob) && !Number.isNaN(Date.parse(`${dob}T00:00:00Z`)) && dob <= today && dob >= '1900-01-01';
      if (!ok) say(`${who}: give a minor nominee's date of birth`, i);
      else if (yearsOld(dob, today) >= 18) say(`${who} is 18 or over, so not a minor`, i);
      else out.dob = dob;
      out.guardian_name = text('guardian_name') || null;
      out.guardian_relation = text('guardian_relation') || null;
      Object.assign(out, optionalDetails(n, 'guardian_', `${who}'s guardian`, i));
    }

    // A tolerance, not equality: 33.33 * 100 is 3332.9999999999995 in floating point.
    if (out.share !== null && (!Number.isFinite(out.share) || out.share <= 0 || out.share > 100
      || Math.abs(Math.round(out.share * 100) - out.share * 100) > 1e-6)) {
      say(`${who}: a share is a percentage above 0 and up to 100, to two decimal places`, i);
    }
    return out;
  });

  /* Shares (7b): every one, adding up to 100, or none, split equally with any
     odd lot to the first nominee. A share for some and not others cannot be
     split either way, so it is asked about rather than guessed. */
  const given = nominees.filter((n) => n.share !== null);
  if (given.length && given.length !== nominees.length) {
    say('Give every nominee a share, or leave every share blank to split equally');
  } else if (given.length) {
    const total = Math.round(given.reduce((s, n) => s + n.share, 0) * 100) / 100;
    if (total !== 100) say(`Your nominees' shares add up to ${total}%; they must add up to 100%`);
  }

  /* Two nominees cannot be one person, and nobody can nominate themselves --
     checked where an identifier was given, which is the only way to tell. */
  nominees.forEach((n, i) => {
    if (!n.id_number) return;
    const first = nominees.findIndex((m) => m.id_type === n.id_type && m.id_number === n.id_number);
    if (first !== -1 && first < i) say(`Nominee ${i + 1} has the same ${n.id_type} number as nominee ${first + 1}`, i);
    if (n.id_type === 'PAN' && applicantPan && n.id_number === String(applicantPan).toUpperCase()) {
      say(`Nominee ${i + 1}: you cannot nominate yourself`, i);
    }
  });

  return { problems, nominees };
}

/** Whole years from a YYYY-MM-DD date of birth to a YYYY-MM-DD day. */
function yearsOld(dob, on) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  return y - by - ((m < bm || (m === bm && d < bd)) ? 1 : 0);
}

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
    /* QA-34. The mobile the journey was started with is the form's from the
       start, so the mobile step shows it to confirm rather than asking again. */
    [leadId, cardId, productTypeId, mobile, email, token, 'In Progress', steps[0].code, writeForm(mobile ? { mobile } : {}), pin],
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
  const at = (ts) => new Date(`${ts.replace(' ', 'T')}Z`).getTime();
  const start = at(journey.started_at);

  /* What the applicant spent, not how long the paperwork took.
   *
   * Every per-step timer and the whole 15-20 minute promise are about the
   * applicant's own sitting. Once they reach a waiting step the file is out of
   * their hands, so the clock stops there -- otherwise an application that
   * cleared verification in three days would report a three-day DIY time, and
   * the averages on the KYC health table would mean nothing. */
  const end = journey.applicant_done_at
    ? at(journey.applicant_done_at)
    : journey.completed_at
      ? at(journey.completed_at)
      : journey.abandoned_at
        ? at(journey.abandoned_at)
        : Date.now();
  return Math.max(0, Math.round((end - start) / 1000));
}

/** Is the active step past its timer, and by how long? */
function stallState(journey, steps) {
  const active = steps.find((s) => s.status === 'active');
  if (!active || !active.entered_at || journey.status === 'Complete') return null;

  /* A waiting step has no clock and cannot stall. Timed like the sixteen
     before it, VERIFICATION would stall in minutes and be abandoned within the
     hour -- the sweep reading "nobody has touched this" as "the applicant gave
     up", when the applicant has finished and somebody else is holding it. */
  if (active.waits) return null;

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

  const steps = journeyStepsFor(journey.product_type_id, journey.journey_version_id);

  /* Verification is recorded by Bonanza through recordVerification, not posted
     by whoever holds the resume token. Without this an applicant could mark
     their own application custodian-verified from the public portal -- the one
     step in the journey that exists to be somebody else's decision. */
  if (steps.find((s) => s.code === stepCode)?.waits) {
    return { error: 'Verification is recorded by Bonanza, not submitted with the application.' };
  }

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

  const idx = steps.findIndex((s) => s.code === stepCode);

  /* The next step that applies AND is not already finished.
   *
   * "Not already finished" is what makes a resubmission work. An objection
   * sends the applicant back to one step; everything after it is still done,
   * and walking forward from there would ask them to re-enter their nominee,
   * segments, selfie and signature because an address line was wrong. On a
   * first pass through nothing ahead is done, so this is the same answer the
   * plain search gave. */
  const finished = new Set(
    all("SELECT step_code FROM kyc_journey_progress WHERE journey_id = ? AND status = 'done'", [journeyId])
      .map((r) => r.step_code),
  );
  const next = steps.slice(idx + 1).find((s) => stepApplies(s, form) && !finished.has(s.code));

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
    if (next.waits) handedOver(journeyId, next);
    return { done: false, next_step: next.code, journey: getJourney(journeyId) };
  }

  return { done: true, journey: completeJourney(journeyId, form) };
}

/**
 * The applicant has finished and somebody else now holds the application.
 *
 * Stamped rather than inferred: the elapsed clock stops here, verification
 * opens at its first outcome instead of sitting blank for somebody to read a
 * meaning into, and the product RM is told -- because an application arriving
 * for review is work, and nothing else would have said so.
 */
function handedOver(journeyId, step) {
  /* Set rather than defaulted: a journey can arrive here more than once now.
     An objection sends it back to the applicant, and when they return the
     review starts again at the beginning -- an application that was
     internally verified before the objection is not still internally verified
     after it. The objection itself is cleared, except for the count, which is
     how "this is the third time" stays answerable. */
  run(
    `UPDATE kyc_journeys SET
       applicant_done_at    = datetime('now'),
       verification_outcome = 'UNDER_REVIEW',
       verification_at      = datetime('now'),
       objection_text = NULL, objection_step = NULL, objection_at = NULL,
       objection_by = NULL, objection_source = NULL
     WHERE id = ?`,
    [journeyId],
  );
  const journey = one('SELECT * FROM kyc_journeys WHERE id = ?', [journeyId]);
  if (!journey?.lead_id) {
    audit(null, 'kyc_submitted_for_verification', 'kyc_journey', journeyId, { step: step.code });
    return;
  }
  const again = (journey.objection_rounds ?? 0) > 0;
  run('INSERT INTO activities (lead_id, card_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?,NULL)', [
    journey.lead_id, journey.card_id, 'KYC Event', 'system',
    again ? 'Application resubmitted for verification' : 'Application submitted for verification',
    again
      ? `The applicant corrected what was objected to. "${step.label}" is back with Bonanza, round ${journey.objection_rounds + 1}.`
      : `The applicant finished every step they own. "${step.label}" is with Bonanza for review.`,
  ]);
  const card = journey.card_id ? one('SELECT * FROM product_cards WHERE id = ?', [journey.card_id]) : null;
  const lead = one('SELECT * FROM leads WHERE id = ?', [journey.lead_id]);
  notify(card?.product_rm_id ?? lead?.owner_id, 'KYC ready for verification',
    `${lead?.name} has submitted everything. The application is waiting on Bonanza's review.`,
    `/leads/${journey.lead_id}`);
  audit(null, 'kyc_submitted_for_verification', 'kyc_journey', journeyId, { step: step.code });
}

/**
 * Send an application back to the applicant with something to fix.
 *
 * An objection is not a rejection. A rejection ends the application; an
 * objection says "this one thing is wrong, correct it and send it back", and
 * the legacy tenant carried both as lead stages (APPLICATION UNDER OBJECTION,
 * APPLICATION RESUBMITTED) precisely because the CRM could not hold the
 * difference -- gap 2 of docs/feedback/MIGRATION-STAGE-SOURCE-MAPPING.md.
 *
 * Either side may raise one (Ritesh, 12 Oct): the external eKYC portal reports
 * them by webhook, and a reviewer at Bonanza can raise one by hand. `source`
 * records which, because "the portal bounced this" and "our own reviewer
 * bounced this" are different facts about the same application.
 *
 * Naming a step is optional but is what makes the objection actionable: with
 * one, the applicant goes back to exactly that step and their resume link
 * works again; without one the application stays with Bonanza and somebody has
 * to say what happens next.
 */
export function raiseObjection(journeyId, { text, stepCode = null, userId = null, source = 'crm' } = {}) {
  const journey = one('SELECT * FROM kyc_journeys WHERE id = ?', [journeyId]);
  if (!journey) return { error: 'Journey not found' };
  if (journey.status === 'Complete') {
    return { error: 'This application is already complete. Reopening a finished account is not an objection.' };
  }
  if (journey.status === 'Abandoned') {
    return { error: 'This application was abandoned. Take it over before objecting to it.' };
  }

  /* An objection with no reason is one the applicant cannot act on, and the
     whole point of the state is that it is recoverable. */
  const reason = String(text ?? '').trim();
  if (!reason) return { error: 'Say what has to be fixed', field: 'objection_text' };

  const steps = journeyStepsFor(journey.product_type_id, journey.journey_version_id);
  const waiting = steps.find((s) => s.waits);
  if (!waiting) return { error: 'This journey has no verification step.' };

  /* Only once the applicant has handed it over. Before that they are still
     filling the form in, and there is nothing yet to object to. */
  if (journey.current_step !== waiting.code && journey.status !== 'Objection') {
    const at = steps.find((s) => s.code === journey.current_step);
    return { error: `The applicant has not submitted yet — this journey is at "${at?.label ?? journey.current_step}".` };
  }

  let back = null;
  if (stepCode) {
    back = steps.find((s) => s.code === stepCode);
    if (!back) return { error: `"${stepCode}" is not a step of this journey`, field: 'objection_step' };
    if (back.waits) {
      return { error: 'Verification is not a step the applicant can redo. Name the step that has to be corrected.', field: 'objection_step' };
    }
    /* And a step this applicant actually has. The conditional ones -- bank
       proof after a failed penny drop, income proof above ten lakh -- are in
       every journey definition but apply to only some applicants. Sending
       somebody back to one they never saw strands them: it is not in the step
       list their portal renders, so they would open their resume link to a
       screen with no form on it. */
    if (!stepApplies(back, readForm(journey))) {
      return {
        error: `"${back.label}" is not part of this applicant's journey, so they cannot redo it.`,
        field: 'objection_step',
      };
    }
  }

  run(
    `UPDATE kyc_journeys SET
       status = 'Objection', current_step = ?,
       objection_text = ?, objection_step = ?, objection_at = datetime('now'),
       objection_by = ?, objection_source = ?, objection_rounds = objection_rounds + 1,
       verification_outcome = NULL, verification_at = NULL
     WHERE id = ?`,
    [back?.code ?? waiting.code, reason, back?.code ?? null, userId, source, journeyId],
  );

  /* Verification goes back to pending. It has not been passed, and leaving it
     active would let somebody record an outcome on an application that is
     sitting with the applicant. */
  run(
    "UPDATE kyc_journey_progress SET status = 'pending', completed_at = NULL WHERE journey_id = ? AND step_code = ?",
    [journeyId, waiting.code],
  );
  if (back) {
    run(
      `UPDATE kyc_journey_progress SET status = 'active', entered_at = datetime('now'), completed_at = NULL
        WHERE journey_id = ? AND step_code = ?`,
      [journeyId, back.code],
    );
  }

  if (journey.lead_id) {
    run('INSERT INTO activities (lead_id, card_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?,?)', [
      journey.lead_id, journey.card_id, 'KYC Event', 'system',
      back ? `Objection raised on "${back.label}"` : 'Objection raised',
      `${reason}${source === 'portal' ? ' (raised by the eKYC portal)' : ''}`,
      userId,
    ]);
    const lead = one('SELECT * FROM leads WHERE id = ?', [journey.lead_id]);
    const card = journey.card_id ? one('SELECT * FROM product_cards WHERE id = ?', [journey.card_id]) : null;
    notify(card?.product_rm_id ?? lead?.owner_id, 'KYC objection',
      `${lead?.name} — ${reason}`, `/leads/${journey.lead_id}`);
  }
  audit(userId, 'kyc_objection', 'kyc_journey', journeyId, { source, step: back?.code ?? null, rounds: (journey.objection_rounds ?? 0) + 1 });

  return { journey: getJourney(journeyId) };
}

/**
 * Record how far verification has got.
 *
 * Only the last outcome completes the journey. The other two are recorded and
 * nothing else happens, which is the point: the application sits in a state the
 * CRM can report on -- with us, or with the depository -- instead of being
 * "In Progress" for a week with nothing saying what it waits for.
 *
 * Outcomes are not forced forwards. A custodian can send a file back and a
 * reviewer can correct a mis-click; refusing either would mean inventing a rule
 * nobody asked for, and every change is on the timeline and in the audit log,
 * so what happened stays recoverable either way.
 */
export function recordVerification(journeyId, outcome, userId = null) {
  const journey = one('SELECT * FROM kyc_journeys WHERE id = ?', [journeyId]);
  if (!journey) return { error: 'Journey not found' };

  const known = verificationOutcome(outcome);
  if (!known) {
    return {
      error: `"${outcome}" is not a verification outcome`,
      allowed: VERIFICATION_OUTCOMES.map((o) => o.code),
    };
  }
  if (journey.status === 'Complete') return { error: 'This application is already complete.' };
  if (journey.status === 'Abandoned') {
    return { error: 'This application was abandoned. Take it over before verifying it.' };
  }

  const steps = journeyStepsFor(journey.product_type_id, journey.journey_version_id);
  const waiting = steps.find((s) => s.waits);
  if (!waiting) return { error: 'This journey has no verification step.' };
  /* Recording an outcome on an objected application withdraws the objection:
     it is how a reviewer undoes one they raised by mistake, or closes one that
     was settled on a phone call rather than through the portal. The count
     stays, so the rounds are still on the record. */
  const withdrawing = journey.status === 'Objection';
  if (!withdrawing && journey.current_step !== waiting.code) {
    const at = steps.find((s) => s.code === journey.current_step);
    return { error: `The applicant has not finished yet — this journey is at "${at?.label ?? journey.current_step}".` };
  }
  if (withdrawing) {
    run(
      `UPDATE kyc_journeys SET status = 'In Progress', current_step = ?,
         objection_text = NULL, objection_step = NULL, objection_at = NULL,
         objection_by = NULL, objection_source = NULL
       WHERE id = ?`,
      [waiting.code, journeyId],
    );
    run(
      `UPDATE kyc_journey_progress SET status = 'active', entered_at = datetime('now')
        WHERE journey_id = ? AND step_code = ?`,
      [journeyId, waiting.code],
    );
    if (journey.objection_step) {
      run(
        "UPDATE kyc_journey_progress SET status = 'done', completed_at = datetime('now') WHERE journey_id = ? AND step_code = ?",
        [journeyId, journey.objection_step],
      );
    }
  }

  const was = journey.verification_outcome;
  if (was === known.code) return { unchanged: true, journey: getJourney(journeyId) };

  const finished = known.code === 'CUSTODIAN_VERIFIED';
  run(
    `UPDATE kyc_journey_progress SET status = ?, payload = ?, completed_at = ${finished ? "datetime('now')" : 'NULL'}
      WHERE journey_id = ? AND step_code = ?`,
    [finished ? 'done' : 'active', JSON.stringify({ outcome: known.code }), journeyId, waiting.code],
  );
  run(
    "UPDATE kyc_journeys SET verification_outcome = ?, verification_at = datetime('now'), verified_by = ? WHERE id = ?",
    [known.code, userId, journeyId],
  );

  if (journey.lead_id) {
    run('INSERT INTO activities (lead_id, card_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?,?)', [
      journey.lead_id, journey.card_id, 'KYC Event', 'system', `Verification: ${known.label}`,
      known.waiting_on
        ? `Recorded as ${known.label.toLowerCase()}. Waiting on ${known.waiting_on}.`
        : `Recorded as ${known.label.toLowerCase()}. Verification is finished.`,
      userId,
    ]);
  }
  audit(userId, 'kyc_verification', 'kyc_journey', journeyId, { from: was, to: known.code });

  if (!finished) return { journey: getJourney(journeyId) };
  return { completed: true, journey: completeJourney(journeyId, null) };
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
export function kycHealth(productTypeId = null, books = null) {
  /* OPS-31. Given the reader's books, only journeys in them: a journey's book
     is its product's. Without, every journey, for callers that filter by a
     scope of their own. */
  const where = [];
  const params = [];
  if (productTypeId) { where.push('j.product_type_id = ?'); params.push(productTypeId); }
  if (books) {
    where.push(books.length ? `p.sales_org IN (${books.map(() => '?').join(',')})` : '1 = 0');
    params.push(...books);
  }
  const rows = all(`
    SELECT j.*, p.name AS product_name, l.name AS lead_name, u.name AS product_rm_name
    FROM kyc_journeys j
    LEFT JOIN product_types p ON p.id = j.product_type_id
    LEFT JOIN leads l ON l.id = j.lead_id
    LEFT JOIN product_cards pc ON pc.id = j.card_id
    LEFT JOIN users u ON u.id = pc.product_rm_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY j.created_at DESC
  `, params);

  return rows.map((r) => {
    const full = getJourney(r.id);
    const active = full?.steps?.find((s) => s.status === 'active');
    const outcome = verificationOutcome(r.verification_outcome);
    return {
      ...r,
      /* The active step, not the stalled one. They were the same thing until a
         step existed that cannot stall: VERIFICATION has no stall state, so the
         label fell through to the raw code and this column read "VERIFICATION"
         where every other row read a sentence. */
      current_step_label: active?.label || (r.status === 'Complete' ? 'Completed' : r.current_step),
      seconds_on_step: full?.stall?.seconds_on_step ?? 0,
      progress_pct: full?.progress_pct ?? 0,
      elapsed_s: full?.elapsed_s ?? 0,
      /* Who the application is sitting with -- the question the legacy tenant
         could not answer: is this ours to move, or the depository's? */
      verification: outcome && r.status !== 'Complete'
        ? { outcome: outcome.code, label: outcome.label, waiting_on: outcome.waiting_on, since: r.verification_at }
        : null,
      /* Back with the applicant, and why. A column reading "Objection" with
         nothing beside it is the legacy tenant's problem restated. */
      objection: r.status === 'Objection'
        ? {
          text: r.objection_text,
          step: r.objection_step,
          since: r.objection_at,
          source: r.objection_source,
          rounds: r.objection_rounds ?? 0,
        }
        : null,
      age_days: daysSince(r.created_at),
    };
  });
}
