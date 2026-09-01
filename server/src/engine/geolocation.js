/**
 * Where an in-person meeting was logged from (P2-01).
 *
 * The business need is proof of physical presence: an RM says they visited a
 * client, and the firm wants something more than their word for it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not capture location on calls, on WhatsApp, or on virtual meetings.
 * Position on a phone call is surveillance with no purpose attached, and the
 * first time somebody questions it the whole feature becomes contentious and
 * gets switched off — including the part that was justified.
 *
 * It does not block the save when position is refused or unavailable. Blocking
 * means the meeting simply goes unlogged, and an unlogged meeting is worse for
 * the business than an unlocated one. A refusal is stored as a value, so a
 * pattern of refusals by one person is itself the management signal — and it
 * arrives without anybody being locked out of their own CRM.
 *
 * IT IS OFF UNTIL COMPLIANCE SAYS OTHERWISE
 * -----------------------------------------
 * An employee's location is personal data about a member of staff. Under DPDP
 * that needs a stated purpose, a retention period and the employee being told.
 * All three exist here — the purpose is on the field definition, retention is
 * twelve months and enforced by `purge()`, and the capture is announced by
 * `notice()` — but whether the firm may do it at all is Compliance's call, not
 * engineering's. So the switch defaults to off: Compliance reviews something
 * they can see and turn on, rather than a description of something not built.
 *
 * ACCURACY IS STORED, AND THAT MATTERS
 * ------------------------------------
 * A browser fix can be a 2 km circle from a cell tower. Presenting that as a
 * precise street address produces evidence that does not survive being
 * challenged, which is worse than no evidence: it invites a finding about the
 * firm's controls rather than settling a question about one meeting.
 */

import { all, run } from '../db.js';

/** Off unless the environment says otherwise. Compliance owns this switch. */
export const isEnabled = () => ['1', 'true', 'yes', 'on'].includes(
  String(process.env.GEO_CAPTURE_ENABLED ?? '').toLowerCase(),
);

/** Twelve months, stated here and enforced by purge(). */
export const RETENTION_MONTHS = 12;

/**
 * The modes that mean somebody was physically somewhere.
 *
 * A branch visit is a physical meeting held at a branch, so it counts. Virtual
 * does not, and that is the whole distinction the feature rests on.
 */
export const PHYSICAL_MODES = new Set(['Physical', 'Branch Visit']);

/** Meetings only, and only the ones held in person. */
export const wants = (type, mode) =>
  isEnabled() && type === 'Meeting' && PHYSICAL_MODES.has(mode);

/**
 * What the person is told, at the moment of capture.
 *
 * Notice is a DPDP requirement and it is also just fair. Returned from the API
 * so one wording is shown everywhere rather than each screen inventing its own.
 */
export const notice = () => ({
  purpose: 'Confirming that an in-person client meeting took place where it was recorded.',
  retention: `Kept for ${RETENTION_MONTHS} months, then deleted automatically.`,
  visibility: 'You can see every location recorded about you on your own activity timeline.',
  optional: 'You can decline. The meeting is still saved, and the refusal is recorded rather than the position.',
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalise what the browser reported into what we store.
 *
 * Every outcome is a value, including the ones that are not a position:
 *
 *   captured     a fix, with its accuracy radius
 *   declined     the person said no
 *   unavailable  the device could not get a fix, or the page was not on HTTPS
 *
 * `null` means the question did not arise — not a meeting, not in person, or
 * the feature is off. That is different from "asked and got nothing", and
 * collapsing the two would make a refusal indistinguishable from a phone call.
 */
export function normalise(payload = {}) {
  const status = String(payload.status ?? '').toLowerCase();

  if (status === 'declined') return { status: 'declined', lat: null, lng: null, accuracy_m: null, address: null };
  if (status === 'unavailable') return { status: 'unavailable', lat: null, lng: null, accuracy_m: null, address: null };

  const lat = num(payload.lat ?? payload.latitude);
  const lng = num(payload.lng ?? payload.longitude);

  // A position outside the possible range is not a position.
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { status: 'unavailable', lat: null, lng: null, accuracy_m: null, address: null };
  }

  return {
    status: 'captured',
    lat,
    lng,
    /* Rounded to a metre, and kept whatever it says. A 2 km radius recorded as
       2 km is honest evidence; the same fix shown as an address is not. */
    accuracy_m: num(payload.accuracy_m ?? payload.accuracy) === null
      ? null
      : Math.round(num(payload.accuracy_m ?? payload.accuracy)),
    address: payload.address ? String(payload.address).slice(0, 300) : null,
  };
}

/**
 * Delete positions older than the stated retention.
 *
 * The activity itself stays — the meeting happened and the timeline is the
 * record of it. Only where the RM was standing is removed, because that is the
 * part with a retention period attached to it.
 */
export function purge() {
  const res = run(
    `UPDATE activities
        SET geo_status = CASE WHEN geo_status IS NULL THEN NULL ELSE 'expired' END,
            geo_lat = NULL, geo_lng = NULL, geo_accuracy_m = NULL, geo_address = NULL
      WHERE geo_status IS NOT NULL
        AND geo_status != 'expired'
        AND geo_captured_at < datetime('now', ?)`,
    [`-${RETENTION_MONTHS} months`],
  );
  return Number(res.changes ?? 0);
}

/**
 * How often each person declined, over a window.
 *
 * The management signal the "not mandatory" decision produces. It is reported
 * as a count next to the total, never as a list of the meetings themselves —
 * the question worth asking is "does this person always decline", not "where
 * was this person on Tuesday".
 */
export function refusalRates({ sinceDays = 90 } = {}) {
  return all(
    `SELECT u.id AS user_id, u.name,
            SUM(CASE WHEN a.geo_status = 'declined' THEN 1 ELSE 0 END) AS declined,
            COUNT(*) AS asked
       FROM activities a JOIN users u ON u.id = a.user_id
      WHERE a.geo_status IS NOT NULL
        AND a.geo_status != 'expired'
        AND a.created_at >= datetime('now', ?)
      GROUP BY u.id, u.name
      HAVING declined > 0
      ORDER BY declined DESC`,
    [`-${sinceDays} days`],
  );
}
