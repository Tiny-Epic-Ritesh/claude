/**
 * Correct by adding (QA-37, accepted 13 Oct).
 *
 * "History is append-only: a wrong note or activity is corrected by a new
 * entry linked to it, and the original is shown as corrected. No edit after
 * saving." The same holds for a case reply, which is correspondence.
 *
 * A correction is its own row, linked to the one it corrects, rather than a
 * new note or activity. A corrected call written as another activity would be
 * a second call to every count that reads the table -- reports, KRA, the
 * cockpit's calls today -- and new activities are what automation listens for.
 *
 * Only the author corrects (the ruling's "Author corrects"): what a call or a
 * note recorded is the author's account, and somebody else's version of it is
 * a new note, not a correction. An entry the system wrote has no author, so
 * it cannot be corrected; the refusal says so.
 *
 * The audit names the record and the correction, never the text: a
 * correction is as likely as the original to hold a client's details.
 */

import { all, one, run, audit } from '../db.js';

export const CORRECTABLE = {
  note: { column: 'note_id', table: 'notes', label: 'note' },
  activity: { column: 'activity_id', table: 'activities', label: 'activity' },
  reply: { column: 'reply_id', table: 'ticket_replies', label: 'reply' },
};

const BODY_MAX = 5000;

/**
 * Whether this user may correct this record, and if not, why not.
 * `record.user_id` is the author; a null author is the system.
 */
export function mayCorrect(kind, record, user) {
  if (!record.user_id) {
    return { error: `This ${CORRECTABLE[kind].label} was written by the system, so it has no author to correct it. Add a note instead.`, status: 409 };
  }
  if (record.user_id !== user.id) {
    return { error: `Only the author of this ${CORRECTABLE[kind].label} can correct it. Add a note of your own instead.`, status: 403 };
  }
  return null;
}

/** Add a correction to a record the caller has already been allowed to correct. */
export function addCorrection(kind, record, { body, reason }, user) {
  const { column, label } = CORRECTABLE[kind];
  const text = String(body ?? '').trim();
  const why = String(reason ?? '').trim();
  if (!text) return { error: 'Write what it should have said', field: 'body', status: 400 };
  if (text.length > BODY_MAX) return { error: `A correction is at most ${BODY_MAX} characters`, field: 'body', status: 400 };
  if (why.length < 5) return { error: 'Say what was wrong, in a few words', field: 'reason', status: 400 };

  const id = Number(run(
    `INSERT INTO corrections (${column}, body, reason, user_id) VALUES (?,?,?,?)`,
    [record.id, text, why, user.id],
  ).lastInsertRowid);
  audit(user.id, `${kind}_corrected`, kind === 'reply' ? 'ticket_reply' : kind, record.id, { correction_id: id });
  return {
    correction: one(
      `SELECT c.id, c.${column} AS record_id, c.body, c.reason, c.user_id, c.created_at, u.name AS user_name
         FROM corrections c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
      [id],
    ),
    message: `Corrected. The original ${label} stays, marked as corrected.`,
  };
}

/**
 * Each row with its corrections, oldest first, as `corrections`.
 *
 * Takes rows after field security has run. Where the original's body is
 * hidden from this reader, the correction's text and reason are hidden too:
 * the correction says what the body should have said, so it is the body.
 */
export function withCorrections(kind, rows) {
  const { column } = CORRECTABLE[kind];
  const list = (rows ?? []).filter(Boolean);
  if (!list.length) return rows;
  const ids = list.map((r) => r.id);
  const found = all(
    `SELECT c.id, c.${column} AS record_id, c.body, c.reason, c.user_id, c.created_at, u.name AS user_name
       FROM corrections c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.${column} IN (${ids.map(() => '?').join(',')})
      ORDER BY c.id`,
    ids,
  );
  const byRecord = new Map();
  for (const c of found) {
    if (!byRecord.has(c.record_id)) byRecord.set(c.record_id, []);
    byRecord.get(c.record_id).push(c);
  }
  return rows.map((r) => {
    if (!r) return r;
    const hidden = Array.isArray(r._restricted) && r._restricted.includes('body');
    const corrections = (byRecord.get(r.id) ?? []).map((c) => (
      hidden ? { ...c, body: null, reason: null, _restricted: ['body', 'reason'] } : c
    ));
    return { ...r, corrections };
  });
}
