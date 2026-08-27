/**
 * Dispositions — the rules that turn "what happened on the call" into
 * "what happens next".
 *
 * WHY THIS IS A TABLE AND NOT A DROPDOWN
 * --------------------------------------
 * In most CRMs a disposition is a label: the rep picks one, it is stored, and
 * nothing else occurs. That is why pipelines rot — the follow-up lives in
 * someone's head, or in a notes field nobody queries.
 *
 * Here each disposition carries its obligation. "Callback Requested" cannot be
 * saved without a date and time, and saving it creates a dated, owned, reminded
 * task. "Ringing" schedules its own retry a day out. "Not Interested" demands a
 * reason and closes the product card. The rep is never asked to remember
 * anything; the record does the remembering.
 *
 * The matrix below is seed data, not law. Everything an administrator can see
 * in Setup — new outcomes, changed offsets, different obligations — is edited
 * in the table, so the desk can evolve its own vocabulary without a release.
 */

import { all, one, run, audit } from '../db.js';

/* --------------------------------------------------------------- matrix */

/**
 * [code, activity_type, outcome, label, next_step, follow_up_hours,
 *  requires_datetime, requires_reason, sets_card_state, flags, score, hint]
 */
export const DISPOSITION_MATRIX = [
  /* ---- Connected ------------------------------------------------------ */
  ['CALL_PITCH_DONE', 'Call', 'Connected', 'Pitch Done', 'follow_up', 48, 0, 0, null, {}, 8,
    'Pitch delivered. Set the next touch so the interest does not go cold.'],
  ['CALL_CALLBACK', 'Call', 'Connected', 'Callback Requested', 'follow_up', null, 1, 0, null, {}, 10,
    'The client named a time. Enter it exactly — this becomes a dated commitment.'],
  ['CALL_MEETING_FIXED', 'Call', 'Connected', 'Meeting Fixed', 'meeting', null, 1, 0, null, {}, 15,
    'Capture the date, time and mode. A meeting activity is created alongside.'],
  ['CALL_NEEDS_INFO', 'Call', 'Connected', 'Needs Information', 'follow_up', 24, 0, 0, null, {}, 6,
    'Send the material, then follow up. Both steps are scheduled.'],
  ['CALL_NOT_INTERESTED', 'Call', 'Connected', 'Not Interested', 'none', null, 0, 1, 'LOST', {}, -5,
    'A reason is required. The product card closes as Lost.'],
  ['CALL_ALREADY_CLIENT', 'Call', 'Connected', 'Already a Client', 'none', null, 0, 1, null, {}, 0,
    'Check the Client Master before closing this off as a duplicate.'],
  ['CALL_WRONG_NUMBER', 'Call', 'Connected', 'Wrong Number', 'none', null, 0, 0, null,
    { flags_mobile_invalid: 1 }, -3,
    'The mobile is flagged invalid so nobody wastes another dial on it.'],

  /* ---- Not connected -------------------------------------------------- */
  ['CALL_NO_ANSWER', 'Call', 'Not Connected', 'Ringing / No Answer', 'retry', 24, 0, 0, null, {}, 1,
    'A retry is scheduled for tomorrow.'],
  ['CALL_BUSY', 'Call', 'Not Connected', 'Busy', 'retry', 4, 0, 0, null, {}, 1,
    'A retry is scheduled in four hours.'],
  ['CALL_SWITCHED_OFF', 'Call', 'Not Connected', 'Switched Off', 'retry', 24, 0, 0, null, {}, 0,
    'A retry is scheduled for tomorrow.'],
  ['CALL_OUT_OF_NETWORK', 'Call', 'Not Connected', 'Out of Network', 'retry', 48, 0, 0, null, {}, 0,
    'A retry is scheduled in two days.'],
  ['CALL_INVALID_NUMBER', 'Call', 'Not Connected', 'Invalid Number', 'none', null, 0, 0, null,
    { flags_mobile_invalid: 1 }, -3,
    'Flagged for a data fix rather than another dial.'],

  /* ---- Other ---------------------------------------------------------- */
  ['CALL_LANGUAGE', 'Call', 'Other', 'Language Barrier', 'none', null, 0, 0, null, {}, 0,
    'Consider reassigning to a colleague who speaks the language.'],
  ['CALL_DND', 'Call', 'Other', 'Do Not Disturb', 'none', null, 0, 1, null,
    { suppress_marketing: 1 }, 0,
    'Suppressed from all campaigns. Required under TRAI DND obligations.'],

  /* ---- Meeting outcomes ----------------------------------------------- */
  ['MEET_HELD_POSITIVE', 'Meeting', 'Connected', 'Held — Positive', 'follow_up', 72, 0, 0, null, {}, 20,
    'Strong signal. Schedule the next step while the meeting is fresh.'],
  ['MEET_HELD_NEUTRAL', 'Meeting', 'Connected', 'Held — Needs Follow-up', 'follow_up', 120, 0, 0, null, {}, 12,
    'Follow up within the week.'],
  ['MEET_NO_SHOW', 'Meeting', 'Not Connected', 'Client No-show', 'retry', 24, 0, 1, null, {}, -3,
    'Reschedule, and record why it was missed.'],
  ['MEET_RESCHEDULED', 'Meeting', 'Other', 'Rescheduled by Client', 'meeting', null, 1, 0, null, {}, 2,
    'Pick the new date and time.'],
  ['MEET_DECLINED', 'Meeting', 'Connected', 'Declined After Meeting', 'none', null, 0, 1, 'LOST', {}, -8,
    'A reason is required. The card closes as Lost.'],

  /* ---- Message outcomes ----------------------------------------------- */
  ['MSG_REPLIED', 'WhatsApp', 'Connected', 'Client Replied', 'follow_up', 4, 0, 0, null, {}, 6,
    'The service window is open — call while they are engaged.'],
  ['MSG_DELIVERED_NO_REPLY', 'WhatsApp', 'Not Connected', 'Delivered, No Reply', 'retry', 48, 0, 0, null, {}, 1,
    'Try a call in two days.'],
  ['MSG_OPT_OUT', 'WhatsApp', 'Other', 'Opted Out', 'none', null, 0, 0, null,
    { suppress_marketing: 1 }, -5,
    'Suppressed from all campaigns immediately.'],
];

/** Load the matrix into the database. Idempotent — safe on every boot. */
/**
 * Load the shipped matrix.
 *
 * Runs on every boot, and deliberately skips any row the business has edited:
 * the WHERE on the upsert means a disposition changed in Setup keeps its
 * change. Without it this function would quietly revert every customisation at
 * the next restart, and the Setup screen would be describing a state that only
 * survived until someone deployed.
 *
 * New shipped rows still arrive normally, because the conflict only fires on a
 * code that already exists.
 */
export function seedDispositions() {
  DISPOSITION_MATRIX.forEach((row, i) => {
    const [code, type, outcome, label, nextStep, hours, needsDt, needsReason, cardState, flags, score, hint] = row;
    run(
      `INSERT INTO dispositions
         (code, activity_type, outcome, label, next_step, follow_up_hours, requires_datetime,
          requires_reason, sets_card_state, flags_mobile_invalid, suppress_marketing,
          score_delta, hint, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET
         activity_type = excluded.activity_type, outcome = excluded.outcome,
         label = excluded.label, next_step = excluded.next_step,
         follow_up_hours = excluded.follow_up_hours,
         requires_datetime = excluded.requires_datetime,
         requires_reason = excluded.requires_reason,
         sets_card_state = excluded.sets_card_state,
         flags_mobile_invalid = excluded.flags_mobile_invalid,
         suppress_marketing = excluded.suppress_marketing,
         score_delta = excluded.score_delta, hint = excluded.hint,
         sort_order = excluded.sort_order
       WHERE dispositions.edited_at IS NULL`,
      [code, type, outcome, label, nextStep, hours, needsDt, needsReason, cardState,
        flags.flags_mobile_invalid ?? 0, flags.suppress_marketing ?? 0, score, hint, i],
    );
  });
  return DISPOSITION_MATRIX.length;
}

/* ------------------------------------------------------------ accessors */

/** The picker, grouped the way it is presented: outcome then sub-disposition. */
export function dispositionsFor(activityType) {
  const rows = all(
    'SELECT * FROM dispositions WHERE active = 1 AND activity_type = ? ORDER BY sort_order',
    [activityType],
  );

  const grouped = new Map();
  for (const r of rows) {
    if (!grouped.has(r.outcome)) grouped.set(r.outcome, []);
    grouped.get(r.outcome).push(r);
  }
  return [...grouped.entries()].map(([outcome, options]) => ({ outcome, options }));
}

export const dispositionByCode = (code) =>
  (code ? one('SELECT * FROM dispositions WHERE code = ? AND active = 1', [code]) : null);

/* ----------------------------------------------------------- validation */

/**
 * Check a submitted activity against its disposition's obligations.
 *
 * Returned as a list of field errors rather than thrown, so the UI can mark the
 * offending input instead of showing one opaque message.
 */
export function validateDisposition(code, body) {
  const d = dispositionByCode(code);
  if (!d) return { ok: false, errors: { disposition: 'Unknown or retired disposition' } };

  const errors = {};

  if (d.requires_datetime) {
    const when = d.next_step === 'meeting' ? body.meeting_at : body.follow_up_at;
    const field = d.next_step === 'meeting' ? 'meeting_at' : 'follow_up_at';

    if (!when) {
      errors[field] = `"${d.label}" requires a date and time`;
    } else if (Number.isNaN(Date.parse(when))) {
      errors[field] = 'Not a valid date and time';
    } else if (new Date(when).getTime() < Date.now() - 60_000) {
      // A follow-up in the past is almost always a typo, and it would never
      // surface on a work list ordered by what is due next.
      errors[field] = 'That is in the past — pick a future date and time';
    }
  }

  if (d.requires_reason && !String(body.reason || '').trim()) {
    errors.reason = `"${d.label}" requires a reason`;
  }

  return { ok: Object.keys(errors).length === 0, errors, disposition: d };
}

/**
 * When the next step falls due.
 * An explicit time from the RM always wins over the configured default.
 */
export function nextStepAt(disposition, body) {
  if (disposition.next_step === 'meeting') return body.meeting_at ?? null;
  if (body.follow_up_at) return body.follow_up_at;
  if (disposition.follow_up_hours == null) return null;

  return new Date(Date.now() + disposition.follow_up_hours * 3600_000)
    .toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Apply a disposition's side effects to the lead and its card.
 *
 * Deliberately narrow: reachability flags, marketing suppression and card
 * closure. Anything broader belongs in the automation rules, where it is
 * visible and editable rather than buried in a switch statement.
 */
export function applyEffects({ disposition, leadId, cardId, userId, reason }) {
  const effects = [];

  if (disposition.flags_mobile_invalid) {
    run('UPDATE leads SET mobile_invalid = 1 WHERE id = ?', [leadId]);
    effects.push('mobile flagged invalid');
  }

  if (disposition.suppress_marketing) {
    run('UPDATE leads SET marketing_opt_out = 1 WHERE id = ?', [leadId]);
    effects.push('suppressed from campaigns');
  }

  if (disposition.sets_card_state && cardId) {
    const card = one('SELECT state FROM product_cards WHERE id = ?', [cardId]);
    if (card && card.state !== disposition.sets_card_state) {
      run(
        "UPDATE product_cards SET state = ?, last_state_at = datetime('now') WHERE id = ?",
        [disposition.sets_card_state, cardId],
      );
      run(
        'INSERT INTO card_audit (card_id, from_state, to_state, user_id, note) VALUES (?,?,?,?,?)',
        [cardId, card.state, disposition.sets_card_state, userId, reason || disposition.label],
      );
      effects.push(`card → ${disposition.sets_card_state}`);
    }
  }

  if (effects.length) {
    audit(userId, 'disposition_effects', 'lead', leadId, { code: disposition.code, effects });
  }
  return effects;
}
