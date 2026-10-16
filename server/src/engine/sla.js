/**
 * SLA engine — business-hours timers for tickets.
 *
 * BRD §7.10 / OD-08: SLA is configured per product type and priority, counts
 * business hours only, and pauses while a ticket sits in "Waiting on Client".
 */

import { all, one, run, notify, audit } from '../db.js';
import { isWorkingTime, addWorkingMinutes } from './calendar.js';
import { recordChange } from './metadata.js';

/* Default 09:00–19:00, Mon–Sat (BRD risk register: "KYC timer fires out of hours"). */
export const BUSINESS = { startHour: 9, endHour: 19, days: [1, 2, 3, 4, 5, 6] };

export const DEFAULT_SLA = {
  Critical: { response_mins: 15, resolution_mins: 120 },
  High: { response_mins: 60, resolution_mins: 480 },
  Medium: { response_mins: 240, resolution_mins: 1440 },
  Low: { response_mins: 480, resolution_mins: 4320 },
};

/**
 * Business time now means the office calendar, holidays included.
 *
 * This function's own docstring below has always promised to skip "nights,
 * Sundays and holidays". Until the calendar existed it skipped the first two
 * and counted every Diwali as a working day — so an SLA raised before a
 * three-day closure reported a breach nobody could have prevented, and the
 * whole metric was quietly untrustworthy.
 */
const isBusinessTime = (d) => isWorkingTime(d, 'office');

/** Advance `from` by `minutes` of business time, skipping nights, Sundays and holidays. */
export const addBusinessMinutes = (from, minutes) => addWorkingMinutes(from, minutes, 'office');

/** Business minutes actually elapsed between two instants. */
export function businessMinutesBetween(from, to) {
  const cursor = new Date(from);
  const end = new Date(to);
  let mins = 0;
  const SLICE = 5;
  let guard = 0;
  while (cursor < end && guard < 200_000) {
    guard += 1;
    cursor.setMinutes(cursor.getMinutes() + SLICE);
    if (isBusinessTime(cursor)) mins += SLICE;
  }
  return mins;
}

/**
 * The policy to measure a ticket against.
 *
 * `versionId` pins it to the policy as it stood when the ticket was raised. A
 * deadline that moves after it has been promised is not a deadline, and
 * "your SLA changed while your case was open" is not something anybody wants to
 * explain to a client or to an auditor.
 */
export function policyFor(productTypeId, priority, versionId = null) {
  if (versionId) {
    const snap = one('SELECT payload FROM artefact_versions WHERE id = ? AND kind = ?',
      [versionId, 'sla_policy']);
    if (snap) {
      try {
        const p = JSON.parse(snap.payload);
        if (p?.response_mins && p?.resolution_mins) return p;
      } catch { /* fall through to the live policy */ }
    }
  }

  const row = productTypeId
    ? one('SELECT * FROM sla_policies WHERE product_type_id = ? AND priority = ?', [productTypeId, priority])
    : null;
  return row || DEFAULT_SLA[priority] || DEFAULT_SLA.Medium;
}

const toSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Stamp response/resolution deadlines on a newly created ticket. */
export function applySla(ticketId) {
  const ticket = one('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  if (!ticket) return null;

  const card = ticket.card_id ? one('SELECT * FROM product_cards WHERE id = ?', [ticket.card_id]) : null;

  /* Pin the ticket to the policy in force now, and measure against that from
   * here on. Re-running applySla later -- on a priority change, say -- keeps
   * the pin, so the clock does not silently move under an open case. */
  const pin = ticket.sla_version_id ?? one(
    'SELECT id FROM artefact_versions WHERE kind = ? AND logical_id = ? AND is_current = 1',
    ['sla_policy', `${card?.product_type_id ?? 'null'}:${ticket.priority}`],
  )?.id ?? null;

  const policy = policyFor(card?.product_type_id, ticket.priority, pin);
  const from = new Date(`${ticket.created_at.replace(' ', 'T')}Z`);

  const responseDue = addBusinessMinutes(from, policy.response_mins);
  const resolutionDue = addBusinessMinutes(from, policy.resolution_mins);

  run('UPDATE tickets SET response_due = ?, resolution_due = ?, sla_version_id = ? WHERE id = ?', [
    toSql(responseDue), toSql(resolutionDue), pin, ticketId,
  ]);
  return { response_due: toSql(responseDue), resolution_due: toSql(resolutionDue) };
}

/**
 * What "SLA breached" means, everywhere it is counted or listed (QA-05).
 *
 * An open case the sweep has flagged as past its resolution deadline. The
 * Home tile added cases merely past due -- paused ones waiting on the client
 * included, which the sweep rightly leaves alone -- while the Breached tab
 * and the team summary counted every case ever flagged, resolved ones too.
 * The sweep runs every minute, so this is current to the minute.
 */
/**
 * The deadlines a case would have under a priority -- Part 4, ruled by Ritesh
 * on 16 Oct 2026.
 *
 * A change of priority, an escalation's included, redoes the deadlines under
 * the new priority counted from when the case was opened, as Freshdesk and
 * Zendesk do. They used to stay where they were, so a Low case raised to
 * Critical kept Low's three days. The case is pinned to the policy in force
 * now for the new priority, and the time it has spent waiting on the client
 * still does not count. Reads only: the confirmation dialogs ask it what a
 * change would do before anybody makes one.
 */
export function deadlinesFor(ticket, priority) {
  const card = ticket.card_id ? one('SELECT product_type_id FROM product_cards WHERE id = ?', [ticket.card_id]) : null;
  const pin = one(
    'SELECT id FROM artefact_versions WHERE kind = ? AND logical_id = ? AND is_current = 1',
    ['sla_policy', `${card?.product_type_id ?? 'null'}:${priority}`],
  )?.id ?? null;
  const policy = policyFor(card?.product_type_id, priority, pin);
  const from = new Date(`${ticket.created_at.replace(' ', 'T')}Z`);
  // Business minutes already spent waiting on the client, as the resume adds them.
  const waited = Math.round((ticket.sla_paused_ms ?? 0) / 60_000);
  const resolution = addBusinessMinutes(from, policy.resolution_mins + waited);
  return {
    priority,
    pin,
    response_due: toSql(addBusinessMinutes(from, policy.response_mins + waited)),
    resolution_due: toSql(resolution),
    resolution_mins: policy.resolution_mins,
    past_due: resolution < new Date(),
  };
}

/** Write deadlinesFor() to the case, and flag it at once if it is already past. */
export function repriceSla(ticketId, priority) {
  const ticket = one('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  if (!ticket) return null;
  const next = deadlinesFor(ticket, priority);
  run('UPDATE tickets SET response_due = ?, resolution_due = ?, sla_version_id = ? WHERE id = ?', [
    next.response_due, next.resolution_due, next.pin, ticketId,
  ]);
  flagBreach(one(
    'SELECT t.*, u.manager_id, u.name AS assignee_name FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?',
    [ticketId],
  ));
  return next;
}

/**
 * Close what was resolved 72 hours ago and not reopened -- Part 4, ruled by
 * Ritesh on 16 Oct 2026.
 *
 * It ran only when somebody pressed Run SLA sweep, and then across both
 * businesses (OPS-45): a Bonanza agent's press closed Bigul's cases, with no
 * history entry. It runs by itself now, with the breach check, and each close
 * is in the case's history and the audit. `books` limits it to those
 * businesses, for the button.
 */
export function closeResolved({ books = null } = {}) {
  const where = ["status = 'Resolved'", "resolved_at <= datetime('now', '-72 hours')", 'merged_into IS NULL'];
  const params = [];
  if (books) {
    where.push(books.length ? `sales_org IN (${books.map(() => '?').join(',')})` : '1 = 0');
    params.push(...books);
  }
  const due = all(`SELECT id, ref FROM tickets WHERE ${where.join(' AND ')} ORDER BY id`, params);
  for (const t of due) {
    run("UPDATE tickets SET status = 'Closed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'Resolved'", [t.id]);
    recordChange('case', t.id, 'status', 'Resolved', 'Closed', { source: 'automation' });
    audit(null, 'ticket_auto_closed', 'ticket', t.id, { ref: t.ref, after_hours: 72 });
  }
  return { closed: due.length, closed_refs: due.map((t) => t.ref) };
}

export const breachedSql = (a = 't') => `(${a}.breached = 1 AND ${a}.status NOT IN ('Resolved','Closed') AND ${a}.merged_into IS NULL)`;

/**
 * Sweep open tickets, flag breaches and escalate up the hierarchy.
 * Called on a timer by the server and on demand from the ticket routes.
 */
/* One open case past its resolution time: flag it and tell the assignee and
   their manager. False when there is nothing to do. */
function flagBreach(t, now = new Date()) {
  if (!t || ['Resolved', 'Closed'].includes(t.status) || t.merged_into) return false;
  // Paused tickets accrue no SLA time.
  if (t.status === 'Waiting on Client') return false;

  const due = t.resolution_due ? new Date(`${t.resolution_due.replace(' ', 'T')}Z`) : null;
  if (!due || now <= due || t.breached) return false;

  run('UPDATE tickets SET breached = 1, breached_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?', [t.id]);

  // Escalation: notify the assignee and their manager (BRD §7.10 escalation automation).
  notify(t.assignee_id, `SLA breached — ${t.ref}`, t.subject, `/tickets/${t.id}`);
  if (t.manager_id) {
    notify(t.manager_id, `Team SLA breach — ${t.ref}`, `${t.assignee_name || 'Unassigned'}: ${t.subject}`, `/tickets/${t.id}`);
  }
  audit(null, 'sla_breach', 'ticket', t.id, { ref: t.ref, priority: t.priority });
  return true;
}

/**
 * Flag every open case past its resolution time. The server runs it every
 * minute over every business; `books` limits it to those, for the Check SLAs
 * now button (OPS-45).
 */
export function sweepSla({ books = null } = {}) {
  const where = ["t.status NOT IN ('Resolved', 'Closed')", 't.merged_into IS NULL'];
  const params = [];
  if (books) {
    where.push(books.length ? `t.sales_org IN (${books.map(() => '?').join(',')})` : '1 = 0');
    params.push(...books);
  }
  const open = all(`
    SELECT t.*, u.manager_id, u.name AS assignee_name
    FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE ${where.join(' AND ')}
  `, params);

  const now = new Date();
  const flagged = open.filter((t) => flagBreach(t, now));
  return { checked: open.length, breached: flagged.length, breached_refs: flagged.map((t) => t.ref) };
}

/** Pause/resume the clock as a ticket moves in and out of "Waiting on Client". */
export function handleStatusChange(ticket, nextStatus) {
  const now = new Date();

  if (nextStatus === 'Waiting on Client' && !ticket.sla_paused_at) {
    run('UPDATE tickets SET sla_paused_at = ? WHERE id = ?', [toSql(now), ticket.id]);
    return;
  }

  if (ticket.sla_paused_at && nextStatus !== 'Waiting on Client') {
    // Push both deadlines out by the business minutes spent waiting.
    const pausedFrom = new Date(`${ticket.sla_paused_at.replace(' ', 'T')}Z`);
    const waited = businessMinutesBetween(pausedFrom, now);

    const shift = (iso) => (iso ? toSql(addBusinessMinutes(new Date(`${iso.replace(' ', 'T')}Z`), waited)) : null);

    run('UPDATE tickets SET sla_paused_at = NULL, sla_paused_ms = sla_paused_ms + ?, response_due = ?, resolution_due = ? WHERE id = ?', [
      waited * 60_000, shift(ticket.response_due), shift(ticket.resolution_due), ticket.id,
    ]);
  }
}

/** Remaining business minutes before resolution is due (negative once breached). */
export function slaRemaining(ticket) {
  if (!ticket.resolution_due) return null;
  if (['Resolved', 'Closed'].includes(ticket.status)) return null;
  const due = new Date(`${ticket.resolution_due.replace(' ', 'T')}Z`);
  const now = new Date();
  const sign = now > due ? -1 : 1;
  return sign * businessMinutesBetween(sign > 0 ? now : due, sign > 0 ? due : now);
}
