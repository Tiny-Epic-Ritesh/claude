/**
 * A15: a case's CSAT is its customer's alone (B20, ruled 19 Nov 2026).
 *
 * Any staff member who could open a case could set its score, with no
 * record, and nothing read the customer's own answer: the WhatsApp sent on
 * closing a case asked for a number and no reply was looked at. The score
 * feeds the Customer Care scorecard and the cockpit, so it was the desk
 * marking its own work. As ruled, after the BRD (§7.10: CSAT goes out on
 * close), both businesses' published escalation path, and SEBI SCORES, where
 * only the complainant rates a resolution:
 *
 *   - the customer is asked once, when the case is done, in the name of the
 *     business it belongs to (OPS-65: every case said "Bonanza", and was
 *     asked again when a resolved case was closed by hand)
 *   - a WhatsApp reply from the number asked, within 15 days (SCORES' own
 *     feedback window), that starts with a number from 1 to 5 and carries no
 *     other number, is the score; anything else stays an ordinary reply. A
 *     partner rates their own case on the portal.
 *   - the answer is a `Survey` interaction on the timeline, and the case's
 *     `csat` is worked out from the answers here -- written by settle() and
 *     nowhere else
 *   - staff do not set a score. A wrong one is voided, with a reason, by
 *     somebody holding `csat.void`; reopening the case voids it too
 *   - a 1 or a 2 opens a call-back task, the next working day, for the next
 *     level up from whoever resolved the case
 *   - the score is credited to whoever resolved the case
 */

import { all, one, run, audit, notify } from '../db.js';
import { send } from '../integrations.js';
import { checkConsent } from './consent.js';
import { bookName } from './policies.js';
import { nextWorkingTime } from './calendar.js';
import { IST_OFFSET_MIN, toStored, inRange } from './daterange.js';
import { escalationTarget } from './cases.js';

/** Days an answer counts for, after asking: SEBI SCORES' feedback window. */
export const ANSWER_DAYS = 15;

/** A score this low is followed up by a person. */
export const CALL_BACK_AT_OR_BELOW = 2;

/**
 * The score in a reply, or null: it starts with a number from 1 to 5 and
 * carries no other number -- "5", "4, good service" -- ruled 19 Nov. "5/5",
 * "10" or "thanks" are ordinary replies.
 */
export function scoreOf(text) {
  const t = String(text ?? '').trim();
  const m = /^([1-5])(?!\d)/.exec(t);
  if (!m) return null;
  if ((t.match(/\d/g) ?? []).length !== 1) return null;
  return Number(m[1]);
}

const lastTen = (n) => String(n ?? '').replace(/\D/g, '').slice(-10);

/** The question, in the name of the case's own business. */
export const questionFor = (ticket, name) =>
  `Hi ${name}, your ${bookName(ticket.sales_org)} request ${ticket.ref} has been resolved. `
  + 'How did we do? Reply with a number from 1 to 5 (5 = excellent).';

/* ----------------------------------------------------------- the score */

/** The one writer of `tickets.csat`: the latest answer that stands. */
export function settle(ticketId) {
  run(
    `UPDATE tickets SET csat = (
       SELECT score FROM csat_surveys WHERE ticket_id = ? AND status = 'Answered'
        ORDER BY answered_at DESC, id DESC LIMIT 1
     ) WHERE id = ?`,
    [ticketId, ticketId],
  );
}

/* --------------------------------------------------------------- asking */

/**
 * Ask once, when a case is done. A partner's own case is rated on the portal;
 * a client's, by WhatsApp to the lead's mobile. Returns the survey row.
 */
export function ask(ticket, resolvedBy) {
  run("UPDATE csat_surveys SET status = 'Cancelled' WHERE ticket_id = ? AND status = 'Sent'", [ticket.id]);

  const lead = ticket.lead_id ? one('SELECT * FROM leads WHERE id = ?', [ticket.lead_id]) : null;
  const base = {
    ticket_id: ticket.id, lead_id: lead?.id ?? null, partner_id: ticket.partner_id ?? null,
    sales_org: ticket.sales_org, resolved_by: resolvedBy ?? null,
  };
  const insert = (cols) => {
    const row = { ...base, ...cols };
    const keys = Object.keys(row);
    const id = Number(run(
      `INSERT INTO csat_surveys (${keys.join(',')}, expires_at)
       VALUES (${keys.map(() => '?').join(',')}, datetime('now', '+${ANSWER_DAYS} days'))`,
      Object.values(row),
    ).lastInsertRowid);
    return one('SELECT * FROM csat_surveys WHERE id = ?', [id]);
  };

  if (!lead && ticket.partner_id) return insert({ channel: 'portal' });
  if (!lead) return null;   // nobody outside the firm to ask

  if (!lead.mobile) return insert({ channel: 'whatsapp', status: 'NotSent', note: `${lead.name} has no mobile` });
  const consent = checkConsent(lead, 'whatsapp', 'service');
  if (!consent.allowed) return insert({ channel: 'whatsapp', status: 'NotSent', note: consent.reason });

  const survey = insert({ channel: 'whatsapp', sent_to: lastTen(lead.mobile) });
  send('whatsapp', { to: lead.mobile, body: questionFor(ticket, lead.name), leadId: lead.id });
  return survey;
}

/* ------------------------------------------------------------ answering */

function record(survey, score, { text = null, messageId = null, via }) {
  const ticket = one('SELECT * FROM tickets WHERE id = ?', [survey.ticket_id]);
  const activityId = Number(run(
    `INSERT INTO activities (lead_id, partner_id, type, direction, subject, body, external_id)
     VALUES (?,?,?,?,?,?,?)`,
    [survey.lead_id, survey.lead_id ? null : survey.partner_id, 'Survey', 'inbound',
      `CSAT for ${ticket.ref}: ${score}/5`, text ?? `${score}`, messageId],
  ).lastInsertRowid);
  run(
    "UPDATE csat_surveys SET status = 'Answered', score = ?, answered_at = datetime('now'), activity_id = ? WHERE id = ?",
    [score, activityId, survey.id],
  );
  settle(ticket.id);
  audit(null, 'csat_answered', 'ticket', ticket.id, { score, via, survey_id: survey.id });
  if (survey.resolved_by) notify(survey.resolved_by, `${ticket.ref} rated ${score}/5`, ticket.subject, `/tickets/${ticket.id}`);
  const callBack = score <= CALL_BACK_AT_OR_BELOW ? callBackTask(ticket, survey, score) : null;
  return { ticket_id: ticket.id, score, survey_id: survey.id, call_back_task_id: callBack };
}

/**
 * A WhatsApp reply, if it answers a question this number was asked within
 * the window. Returns what was recorded, or null for an ordinary reply.
 */
export function answerFromWhatsApp(mobile, text, messageId = null) {
  const score = scoreOf(text);
  if (score === null) return null;
  const survey = one(
    `SELECT * FROM csat_surveys
      WHERE status = 'Sent' AND channel = 'whatsapp' AND sent_to = ? AND expires_at > datetime('now')
      ORDER BY sent_at DESC, id DESC LIMIT 1`,
    [lastTen(mobile)],
  );
  if (!survey) return null;
  // A reply opens the 24-hour service window, whatever it says.
  if (survey.lead_id) run("UPDATE leads SET wa_last_inbound_at = datetime('now') WHERE id = ?", [survey.lead_id]);
  return record(survey, score, { text, messageId, via: 'whatsapp' });
}

/** A partner's rating of their own case, on the portal. */
export function answerFromPortal(partnerId, ticketId, score) {
  if (!(Number.isInteger(score) && score >= 1 && score <= 5)) return { status: 400, error: 'Rate it from 1 to 5' };
  const survey = one(
    `SELECT * FROM csat_surveys
      WHERE ticket_id = ? AND partner_id = ? AND channel = 'portal' AND status = 'Sent' AND expires_at > datetime('now')
      ORDER BY id DESC LIMIT 1`,
    [ticketId, partnerId],
  );
  if (!survey) return { status: 409, error: 'This request is not waiting for a rating' };
  return { ok: true, ...record(survey, score, { via: 'portal' }) };
}

/* ---------------------------------------------------- striking one out */

/** Void the score that stands, with who and why. */
export function voidScore(ticketId, { userId, reason }) {
  const why = String(reason ?? '').trim();
  if (why.length < 5) return { status: 400, error: 'Say why the score is being voided, in a few words', field: 'reason' };
  const standing = one(
    "SELECT * FROM csat_surveys WHERE ticket_id = ? AND status = 'Answered' ORDER BY answered_at DESC, id DESC LIMIT 1",
    [ticketId],
  );
  if (!standing) return { status: 409, error: 'This case has no customer score to void' };
  run(
    "UPDATE csat_surveys SET status = 'Voided', voided_by = ?, voided_at = datetime('now'), void_reason = ? WHERE id = ?",
    [userId, why, standing.id],
  );
  settle(ticketId);
  audit(userId, 'csat_voided', 'ticket', ticketId, { score: standing.score, reason: why, survey_id: standing.id });
  return { ok: true, voided: standing.score };
}

/** A reopened case's score no longer stands, and an unanswered question lapses. */
export function onReopen(ticketId, userId = null) {
  run(
    `UPDATE csat_surveys SET status = 'Voided', voided_by = ?, voided_at = datetime('now'), void_reason = 'The case was reopened'
      WHERE ticket_id = ? AND status = 'Answered'`,
    [userId, ticketId],
  );
  run("UPDATE csat_surveys SET status = 'Cancelled' WHERE ticket_id = ? AND status = 'Sent'", [ticketId]);
  settle(ticketId);
}

/* ------------------------------------------------------------ the call */

/** Noon on the next working day, India time. */
function nextWorkingNoon() {
  const wall = new Date(Date.now() + IST_OFFSET_MIN * 60_000);
  const noon = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1, 12, 0, 0)
    - IST_OFFSET_MIN * 60_000);
  return toStored(nextWorkingTime(noon));
}

/** A low score is a person to call back, at the next level up from whoever resolved the case. */
function callBackTask(ticket, survey, score) {
  const target = escalationTarget({ ...ticket, assignee_id: survey.resolved_by ?? ticket.assignee_id });
  const assignee = target.user?.id ?? survey.resolved_by ?? ticket.assignee_id ?? null;
  if (!assignee) return null;
  const who = survey.lead_id
    ? one('SELECT name FROM leads WHERE id = ?', [survey.lead_id])?.name
    : one('SELECT name FROM partners WHERE id = ?', [survey.partner_id])?.name;
  const taskId = Number(run(
    `INSERT INTO tasks (title, description, lead_id, ticket_id, partner_id, assignee_id, due_at, priority, status)
     VALUES (?,?,?,?,?,?,?,?, 'Open')`,
    [
      `Call back ${who ?? 'the customer'}: rated ${ticket.ref} ${score}/5`,
      `They were not satisfied with how ${ticket.ref} ("${ticket.subject}") was resolved. Call before they take it further.`,
      survey.lead_id, ticket.id, survey.lead_id ? null : survey.partner_id, assignee, nextWorkingNoon(), 'High',
    ],
  ).lastInsertRowid);
  notify(assignee, `Low CSAT on ${ticket.ref}: ${score}/5`, `Call ${who ?? 'the customer'} back`, `/tickets/${ticket.id}`);
  return taskId;
}

/* -------------------------------------------------------------- reading */

/** What the case page shows: the score that stands, what is waiting, and what came before. */
export function csatFor(ticketId) {
  const rows = all(
    `SELECT s.*, r.name AS resolved_by_name, v.name AS voided_by_name
       FROM csat_surveys s
       LEFT JOIN users r ON r.id = s.resolved_by
       LEFT JOIN users v ON v.id = s.voided_by
      WHERE s.ticket_id = ? ORDER BY s.id DESC`,
    [ticketId],
  );
  const standing = rows.find((r) => r.status === 'Answered') ?? null;
  const waiting = rows.find((r) => r.status === 'Sent' && r.expires_at > toStored(new Date())) ?? null;
  return { standing, waiting, history: rows };
}

/* ------------------------------------------------- one figure, everywhere */

/** Answers below which a CSAT figure is not scored (B21, ruled 19 Nov). */
export const CSAT_MIN_ANSWERS = 10;

/**
 * CSAT as one figure wherever it is shown -- the scorecard, the Customer Care
 * home and the case report (B21, ruled 19 Nov): the share of customers'
 * answers in the period that are a 4 or a 5, credited to whoever resolved the
 * case. It was an average of whatever was in the column, by whoever held the
 * case now, over all time.
 *
 * @param people  user ids it is credited to, or null for everyone in `orgs`
 * @param orgs    the businesses it is counted in
 * @param range   a resolved date range (engine/daterange.js), or null for all time
 * @returns { pct, answers, good } -- pct is null below CSAT_MIN_ANSWERS answers
 */
export function csatFigure({ people = null, orgs, range = null }) {
  const where = ["s.status = 'Answered'", `s.sales_org IN (${orgs.map(() => '?').join(',') || "''"})`];
  const params = [...orgs];
  if (people) {
    where.push(`s.resolved_by IN (${people.map(() => '?').join(',') || 'NULL'})`);
    params.push(...people);
  }
  if (range) {
    const r = inRange('s.answered_at', range);
    where.push(r.sql);
    params.push(...r.params);
  }
  const row = one(
    `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN s.score >= 4 THEN 1 ELSE 0 END), 0) good
       FROM csat_surveys s WHERE ${where.join(' AND ')}`,
    params,
  );
  const answers = Number(row?.n ?? 0);
  const good = Number(row?.good ?? 0);
  return { answers, good, pct: answers >= CSAT_MIN_ANSWERS ? Math.round((100 * good) / answers) : null };
}

/** What a CSAT figure that is not scored yet says instead. */
export const notEnoughAnswers = (answers) =>
  `${answers} answer${answers === 1 ? '' : 's'} so far; scored from ${CSAT_MIN_ANSWERS}`;
