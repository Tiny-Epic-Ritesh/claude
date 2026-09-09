/**
 * Check-in, check-out, and the hours that come out of them (P3-09).
 *
 * "Sales users check in when they start their day and check out when they
 * leave." Straightforward until somebody forgets to check out, which is the
 * part the ticket asks to settle before building — and rightly, because the
 * three plausible answers produce three different numbers for the same day.
 *
 * WHAT AN HOUR HERE IS WORTH
 * --------------------------
 * The legacy system closed everybody at 8pm. That automation fired 128,482
 * times, which is not a rare correction — it is how most days ended. It also
 * credits hours nobody worked: somebody who left at five is recorded until
 * eight, and their total is three hours of fiction that looks exactly like
 * three hours of work.
 *
 * So the default here closes an abandoned session at the last moment the person
 * actually did something in the CRM — a call logged, a lead edited, a page
 * loaded. That is evidence rather than a clock, and it can be defended if these
 * numbers are ever used for anything that matters to somebody's pay.
 *
 * Whatever the rule, an auto-closed interval is marked as one and the report
 * shows it apart. An hour a person vouched for and an hour a rule inferred are
 * different kinds of number, and adding them up silently is how a report stops
 * meaning anything.
 */

import { all, one, run } from '../db.js';

/** Roles asked to check in when nothing is configured. */
const DEFAULT_PROMPT_ROLES = ['sales_rm', 'caller', 'dealer', 'partner_rm', 'product_rm', 'sales_supervisor'];

export const UNCLOSED_POLICIES = [
  {
    key: 'last_activity',
    label: 'Close at their last activity',
    note: 'The last thing they actually did in the CRM. Evidence rather than a clock.',
  },
  {
    key: 'fixed_time',
    label: 'Close at a fixed time',
    note: 'What the old system did. Credits hours to anybody who left earlier.',
  },
  {
    key: 'leave_open',
    label: 'Leave it open',
    note: 'The day shows as incomplete and counts nothing until somebody corrects it.',
  },
];

/** The policy for a business, with the shipped defaults filled in. */
export function policyFor(org) {
  const row = one('SELECT * FROM attendance_policy WHERE sales_org = ?', [org]);
  const roles = (() => {
    try { return JSON.parse(row?.prompt_roles ?? 'null') ?? DEFAULT_PROMPT_ROLES; }
    catch { return DEFAULT_PROMPT_ROLES; }
  })();

  return {
    sales_org: org,
    prompt_roles: roles,
    unclosed: row?.unclosed ?? 'last_activity',
    auto_close_at: row?.auto_close_at ?? '20:00',
    max_hours: row?.max_hours ?? 12,
  };
}

/** Is this person asked to check in? */
export const promptsFor = (user) => policyFor(user.sales_org).prompt_roles.includes(user.role);

/* ------------------------------------------------------------ the day */

/** The interval they are in the middle of, if any. */
export const openSession = (userId) => one(
  'SELECT * FROM attendance_session WHERE user_id = ? AND checked_out_at IS NULL ORDER BY checked_in_at DESC LIMIT 1',
  [userId],
);

/**
 * Start an interval.
 *
 * Checking in twice is not an error and does not start a second interval — it
 * returns the one already running. Somebody with the CRM open in two tabs will
 * do this, and two overlapping intervals would double every hour of that day.
 */
export function checkIn(user, source = 'web') {
  const already = openSession(user.id);
  if (already) return { session: already, already: true };

  const result = run(
    'INSERT INTO attendance_session (user_id, sales_org, source) VALUES (?,?,?)',
    [user.id, user.sales_org, source],
  );
  return { session: one('SELECT * FROM attendance_session WHERE id = ?', [Number(result.lastInsertRowid)]) };
}

/** End the interval they are in. */
export function checkOut(user, note = null) {
  const open = openSession(user.id);
  if (!open) return { error: 'You are not checked in' };

  run(
    "UPDATE attendance_session SET checked_out_at = datetime('now'), closed_by = 'user', note = ? WHERE id = ?",
    [note, open.id],
  );
  return { session: one('SELECT * FROM attendance_session WHERE id = ?', [open.id]) };
}

/* ------------------------------------------------- the forgotten check-out */

/**
 * The last thing this person did, as far as the CRM can tell.
 *
 * Two sources, because neither alone is enough: the audit log knows when they
 * changed something, and the session row knows when they were last using the
 * product at all. Somebody who spent an afternoon reading leads without editing
 * one has no audit rows and was plainly still working.
 */
function lastSeen(userId, since, until) {
  /* Bounded at both ends, and the top one is the half that matters.
   *
   * Without `until` this asked for the latest activity after the check-in, and
   * a live session from this morning is "after yesterday's check-in" -- so the
   * answer was always today, always past the ceiling, and every abandoned day
   * closed at the cap. That is a fixed-time auto-checkout under another name,
   * which is the thing choosing evidence over a clock was meant to avoid. */
  const audit = one(
    'SELECT MAX(created_at) AS at FROM audit_log WHERE user_id = ? AND created_at > ? AND created_at <= ?',
    [userId, since, until],
  )?.at;
  const session = one(
    'SELECT MAX(last_seen_at) AS at FROM sessions WHERE user_id = ? AND last_seen_at > ? AND last_seen_at <= ?',
    [userId, since, until],
  )?.at;

  const times = [audit, session].filter(Boolean).sort();
  return times.length ? times[times.length - 1] : null;
}

/**
 * Close intervals nobody ended, according to the policy.
 *
 * Only intervals from before today: somebody checked in this morning and still
 * working has an open interval and that is correct, not a fault to be tidied.
 *
 * Returns what it did rather than logging quietly, so the caller can say so.
 */
export function closeAbandoned(org) {
  const policy = policyFor(org);
  const stale = all(
    `SELECT * FROM attendance_session
      WHERE checked_out_at IS NULL AND sales_org = ?
        AND date(checked_in_at) < date('now')`,
    [org],
  );

  const closed = [];
  for (const s of stale) {
    if (policy.unclosed === 'leave_open') continue;

    /* Computed rather than interpolated into the later SQL, because it is also
       the upper bound of the evidence window and both have to be the same
       moment. */
    const ceiling = one(
      "SELECT datetime(?, '+' || ? || ' hours') AS at",
      [s.checked_in_at, policy.max_hours],
    )?.at;
    let at = null;

    if (policy.unclosed === 'last_activity') {
      const seen = lastSeen(s.user_id, s.checked_in_at, ceiling);
      /* No evidence at all means they checked in and did nothing we can see.
         The interval is closed at the moment it opened rather than credited
         with a default — an unknown is not an hour. */
      at = seen ?? s.checked_in_at;
    } else {
      at = one("SELECT datetime(date(?) || ' ' || ? || ':00') AS at", [s.checked_in_at, policy.auto_close_at])?.at;
    }

    const capped = one('SELECT MIN(?, ?) AS at', [at, ceiling])?.at ?? at;
    run("UPDATE attendance_session SET checked_out_at = ?, closed_by = 'auto' WHERE id = ?", [capped, s.id]);
    closed.push({ id: s.id, user_id: s.user_id, at: capped });
  }
  return { policy: policy.unclosed, closed };
}

/* --------------------------------------------------------- the numbers */

/**
 * Minutes in an interval, as SQL.
 *
 * An interval still running counts up to now, so somebody looking at their own
 * day sees it growing rather than zero until they check out.
 */
const MINUTES = "CAST((julianday(COALESCE(s.checked_out_at, datetime('now'))) - julianday(s.checked_in_at)) * 1440 AS INTEGER)";

/** One person's day: the intervals, and what they add up to. */
export function dayFor(userId, day = null) {
  const on = day ?? new Date().toISOString().slice(0, 10);
  const intervals = all(
    `SELECT s.id, s.checked_in_at, s.checked_out_at, s.closed_by, s.source, s.note,
            ${MINUTES} AS minutes
       FROM attendance_session s
      WHERE s.user_id = ? AND date(s.checked_in_at) = date(?)
      ORDER BY s.checked_in_at`,
    [userId, on],
  );

  return {
    date: on,
    intervals,
    minutes: intervals.reduce((sum, i) => sum + (i.minutes ?? 0), 0),
    open: intervals.some((i) => !i.checked_out_at),
    /* Named separately rather than folded into the total. A day containing an
       inferred interval is a day somebody should look at before using. */
    inferred_minutes: intervals.filter((i) => i.closed_by === 'auto').reduce((s, i) => s + (i.minutes ?? 0), 0),
  };
}

/** Every column the attendance report can show. */
export const REPORT_COLUMNS = [
  { key: 'user_name', label: 'User' },
  { key: 'role_name', label: 'Role' },
  { key: 'day', label: 'Date' },
  { key: 'first_in', label: 'First check-in' },
  { key: 'last_out', label: 'Last check-out' },
  { key: 'hours', label: 'Hours' },
  { key: 'intervals', label: 'Intervals' },
  { key: 'inferred_hours', label: 'Inferred hours', default: false },
  { key: 'open', label: 'Still open', default: false },
  { key: 'manager_name', label: 'Reports to', default: false },
  { key: 'sales_org', label: 'Business', default: false },
];

/**
 * The report, one row per person per day.
 *
 * `reach` is an SQL fragment naming whose rows this person may see, built by
 * the route from the same rules everything else uses — the user themselves,
 * their manager, Admin and Super Admin, with a manager seeing only their own
 * team. It is passed in rather than decided here so there is one answer to
 * "whose records can you see" in the product, not two.
 */
export function report({ reach, params = [], from, to }) {
  return all(
    `SELECT u.id AS user_id, u.name AS user_name, u.sales_org,
            r.name AS role_name, m.name AS manager_name,
            date(s.checked_in_at) AS day,
            MIN(s.checked_in_at) AS first_in,
            MAX(s.checked_out_at) AS last_out,
            COUNT(*) AS intervals,
            ROUND(SUM(${MINUTES}) / 60.0, 2) AS hours,
            ROUND(SUM(CASE WHEN s.closed_by = 'auto' THEN ${MINUTES} ELSE 0 END) / 60.0, 2) AS inferred_hours,
            MAX(CASE WHEN s.checked_out_at IS NULL THEN 1 ELSE 0 END) AS open
       FROM attendance_session s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN roles r ON r.code = u.role
       LEFT JOIN users m ON m.id = u.manager_id
      WHERE ${reach}
        AND date(s.checked_in_at) BETWEEN date(?) AND date(?)
      GROUP BY u.id, date(s.checked_in_at)
      ORDER BY date(s.checked_in_at) DESC, u.name`,
    [...params, from, to],
  );
}
