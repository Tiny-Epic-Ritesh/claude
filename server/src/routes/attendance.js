/**
 * Check-in, check-out and the attendance report (P3-09).
 *
 * Visibility, in the ticket's words: "the user themselves, their manager, Admin
 * and Super Admin — and scoped so that a manager sees only their own team."
 *
 * That is the management chain the rest of the product already uses, so it is
 * the same chain here rather than a second interpretation of "my team". A
 * supervisor with people reporting to people sees all of them, at any depth,
 * which is what a reporting line means everywhere else in this build.
 */

import { Router } from 'express';
import { all, one, run, audit } from '../db.js';
import { auditConfig } from '../engine/metadata.js';
import { requireUser, requirePermission, can, orgsFor, mayUseOrg } from '../auth.js';
import { sendCsv } from '../engine/csv.js';
import {
  policyFor, promptsFor, openSession, checkIn, checkOut, closeAbandoned,
  dayFor, report, REPORT_COLUMNS, UNCLOSED_POLICIES,
} from '../engine/attendance.js';

const router = Router();
router.use(requireUser);

/* ----------------------------------------------------------- their own day */

/**
 * What the login prompt needs to know.
 *
 * `prompt` is the whole question the client has to ask: should this person be
 * shown the check-in dialog right now. Deciding it here rather than in the
 * browser means the rule lives with the policy it comes from, and the mobile
 * app gets the same answer without reimplementing it.
 */
router.get('/me', (req, res) => {
  const open = openSession(req.user.id);
  const today = dayFor(req.user.id);

  res.json({
    checked_in: Boolean(open),
    since: open?.checked_in_at ?? null,
    today,
    applies: promptsFor(req.user),
    prompt: promptsFor(req.user) && !open,
    policy: policyFor(req.user.sales_org),
  });
});

router.post('/check-in', (req, res) => {
  if (!promptsFor(req.user)) {
    /* Not refused — attendance simply is not asked of this role, and somebody
       who wants to record their day anyway is not doing anything wrong. */
    const started = checkIn(req.user, req.body?.source);
    audit(req.user.id, 'attendance_check_in', 'user', req.user.id, { role: req.user.role, applies: false });
    return res.status(201).json(started);
  }

  const started = checkIn(req.user, req.body?.source);
  if (!started.already) audit(req.user.id, 'attendance_check_in', 'user', req.user.id, {});
  return res.status(started.already ? 200 : 201).json(started);
});

router.post('/check-out', (req, res) => {
  const done = checkOut(req.user, req.body?.note ?? null);
  if (done.error) return res.status(400).json(done);

  audit(req.user.id, 'attendance_check_out', 'user', req.user.id, {});
  return res.json({ ...done, today: dayFor(req.user.id) });
});

/* ------------------------------------------------------------- the report */

/**
 * Whose rows may this person see?
 *
 * Built from the same management chain the rest of the product uses. The
 * recursive walk follows reports to any depth: a supervisor whose RMs have
 * their own juniors sees all of them, because that is what a reporting line
 * means on every other screen.
 */
function reachFor(user) {
  if (can(user.role, 'report.system') || can(user.role, 'admin.users')) {
    const orgs = orgsFor(user);
    return {
      sql: `u.sales_org IN (${orgs.map(() => '?').join(',') || "''"})`,
      params: orgs,
      scope: 'org',
    };
  }

  if (can(user.role, 'report.team')) {
    return {
      sql: `(u.id = ? OR u.id IN (
              WITH RECURSIVE reports(id) AS (
                SELECT id FROM users WHERE manager_id = ?
                UNION
                SELECT u2.id FROM users u2 JOIN reports r ON u2.manager_id = r.id
              ) SELECT id FROM reports))`,
      params: [user.id, user.id],
      scope: 'team',
    };
  }

  // Everybody can see their own hours. The ticket names the user first.
  return { sql: 'u.id = ?', params: [user.id], scope: 'self' };
}

router.get('/report', (req, res) => {
  /* Close yesterday's abandoned days before counting them.
   *
   * Done here rather than on a timer because this product has no scheduler, and
   * a policy that only applies when a cron job is healthy is a policy that
   * stops applying without anybody noticing. Reading the report is the moment
   * the numbers have to be right, so it is the moment they are made right.
   *
   * Only touches days before today and only in the reader's own businesses. */
  for (const org of orgsFor(req.user)) closeAbandoned(org);

  const reach = reachFor(req.user);
  const from = req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);

  const rows = report({ reach: reach.sql, params: reach.params, from, to });

  res.json({
    rows,
    from,
    to,
    scope: reach.scope,
    columns: REPORT_COLUMNS,
    default: REPORT_COLUMNS.filter((c) => c.default !== false).map((c) => c.key),
    totals: {
      hours: Math.round(rows.reduce((s, r) => s + (r.hours ?? 0), 0) * 100) / 100,
      inferred_hours: Math.round(rows.reduce((s, r) => s + (r.inferred_hours ?? 0), 0) * 100) / 100,
      people: new Set(rows.map((r) => r.user_id)).size,
      days: new Set(rows.map((r) => r.day)).size,
    },
    note: reach.scope === 'team'
      ? 'Your own hours and those of everyone who reports to you, at any depth.'
      : reach.scope === 'self' ? 'Your own hours.' : 'Everyone in the businesses you can see.',
  });
});

/** The same rows as a file, with the columns chosen before download. */
router.get('/report/export', requirePermission('report.self'), (req, res) => {
  for (const org of orgsFor(req.user)) closeAbandoned(org);

  const reach = reachFor(req.user);
  const from = req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);

  const asked = String(req.query.columns ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const chosen = asked.length
    ? REPORT_COLUMNS.filter((c) => asked.includes(c.key))
    : REPORT_COLUMNS.filter((c) => c.default !== false);
  if (!chosen.length) return res.status(400).json({ error: 'Choose at least one column' });

  const rows = report({ reach: reach.sql, params: reach.params, from, to }).map((r) => ({
    ...r,
    open: r.open ? 'Yes' : 'No',
  }));

  audit(req.user.id, 'attendance_exported', 'user', null, { rows: rows.length, from, to, scope: reach.scope });
  return sendCsv(res, 'attendance', rows, chosen);
});

router.get('/report/columns', (_req, res) => {
  res.json({
    columns: REPORT_COLUMNS,
    default: REPORT_COLUMNS.filter((c) => c.default !== false).map((c) => c.key),
    note: 'Hours a rule inferred are counted separately — an hour somebody vouched for and an hour we guessed are different numbers.',
  });
});

/* ------------------------------------------------------------- the policy */

router.get('/policy', requirePermission('admin.users'), (req, res) => {
  res.json({
    policies: orgsFor(req.user).map((org) => policyFor(org)),
    options: UNCLOSED_POLICIES,
    roles: all('SELECT code, name FROM roles WHERE active = 1 ORDER BY sort_order, code'),
  });
});

router.patch('/policy/:org', requirePermission('admin.users'), (req, res) => {
  const org = req.params.org;
  if (!mayUseOrg(req.user, org)) return res.status(403).json({ error: 'That business is outside your access' });

  const { unclosed, auto_close_at: at, max_hours: maxHours, prompt_roles: roles } = req.body ?? {};
  if (unclosed && !UNCLOSED_POLICIES.some((p) => p.key === unclosed)) {
    return res.status(400).json({ error: `"${unclosed}" is not a policy`, field: 'unclosed' });
  }
  if (at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
    return res.status(400).json({ error: 'Give a time as HH:MM', field: 'auto_close_at' });
  }
  if (maxHours !== undefined && (!Number.isFinite(Number(maxHours)) || Number(maxHours) < 1 || Number(maxHours) > 24)) {
    return res.status(400).json({ error: 'A day is between 1 and 24 hours', field: 'max_hours' });
  }

  if (roles !== undefined && !Array.isArray(roles)) {
    return res.status(400).json({ error: 'Give the roles as a list', field: 'prompt_roles' });
  }

  const before = policyFor(org);

  /* Upsert. A business with no row yet is running on the shipped defaults, so
     the first edit has to create the row rather than update nothing and report
     success. */
  run(
    `INSERT INTO attendance_policy (sales_org, prompt_roles, unclosed, auto_close_at, max_hours, updated_by)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(sales_org) DO UPDATE SET
       prompt_roles  = excluded.prompt_roles,
       unclosed      = excluded.unclosed,
       auto_close_at = excluded.auto_close_at,
       max_hours     = excluded.max_hours,
       updated_by    = excluded.updated_by,
       updated_at    = datetime('now')`,
    [
      org,
      JSON.stringify(roles ?? before.prompt_roles),
      unclosed ?? before.unclosed,
      at ?? before.auto_close_at,
      maxHours === undefined ? before.max_hours : Number(maxHours),
      req.user.id,
    ],
  );

  const after = policyFor(org);
  auditConfig('attendance', org, 'policy', before, after, req.user.id);
  return res.json(after);
});

/**
 * Close what nobody closed, for the businesses this administrator can see.
 *
 * Run on demand rather than on a timer: this product has no scheduler, and a
 * check-in policy that only takes effect if a cron job is healthy is a policy
 * that quietly stops applying. The report calls it before reading, so the
 * numbers are right whether or not anybody presses this.
 */
router.post('/close-abandoned', requirePermission('admin.users'), (req, res) => {
  const results = orgsFor(req.user).map((org) => ({ org, ...closeAbandoned(org) }));
  const total = results.reduce((s, r) => s + r.closed.length, 0);
  if (total) audit(req.user.id, 'attendance_auto_closed', 'user', null, { closed: total });
  res.json({ results, closed: total });
});

export default router;
