/**
 * Access log — who asked for what, and what they got back.
 *
 * The CRM could already say who *changed* a record: audit() has 79 call sites
 * and every one records a write. It could not say who *read* one. That gap
 * turned a one-day fix into an open impact assessment when nine record routes
 * were found returning the other business's data (see
 * docs/security/CROSS-BOOK-EXPOSURE-2026-08.md) -- the code was corrected in a
 * day, but nobody could answer whether anyone had actually looked, because
 * nothing had been written down.
 *
 * A system holding client records under SEBI supervision should be able to
 * answer that question. This writes the answer down.
 *
 * WHAT IS DELIBERATELY NOT RECORDED
 *
 * No request bodies and no query strings. Both carry client data -- a PAN in a
 * lead edit, a mobile number in `?q=` on the duplicate check -- and a log that
 * captured them would become a second copy of the client book with none of the
 * masking applied to it. That is a new liability, not a control. The path is
 * enough to answer "who read this record", because the record id is in the
 * path; what somebody typed into a search box is not the question this exists
 * to answer.
 */

import { db, run, all, one } from '../db.js';
import { orgsFor } from '../auth.js';

/** Kept for 90 days. Long enough to investigate, short enough not to hoard. */
export const RETENTION_DAYS = Number(process.env.CRM_ACCESS_LOG_DAYS ?? 90);

/**
 * Paths that would drown the log without telling anyone anything.
 *
 * The health check is polled by the deploy pipeline and by uptime monitoring,
 * so it would quickly become most of the table.
 */
const SKIP = new Set(['/api/health']);

/**
 * Express middleware. Mount after the session is attached, so the log knows
 * who was asking, and let it write on 'finish' so it knows what they got.
 */
export function accessLog(req, res, next) {
  /**
   * originalUrl, captured now, with the query string cut off.
   *
   * Not `req.path`, and not read later. The middleware is mounted on '/api',
   * and inside a mounted handler Express rewrites req.url to the remainder --
   * so req.path reads '/2' rather than '/api/tickets/2'. Worse, it is restored
   * once routing unwinds, so reading it from the 'finish' callback gives one
   * answer or the other depending on how deep the route matched. A log that
   * records '/2' cannot answer any question worth asking of it.
   */
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (SKIP.has(path)) return next();

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    try {
      const ms = Number((process.hrtime.bigint() - startedAt) / 1000n) / 1000;

      /* Recorded even when nobody is signed in.
       *
       * An unauthenticated 401 storm against /api/leads/1..n is exactly the
       * shape of somebody probing, and dropping those rows would hide the
       * most interesting thing in the log. */
      const user = req.user ?? null;

      run(
        `INSERT INTO request_log
           (user_id, role, sales_org, partner_id, method, path, status, duration_ms, ip, api_credential_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          user?.id ?? null,
          user?.role ?? (req.partner ? 'partner' : null),
          user?.sales_org ?? null,
          req.partner?.id ?? null,
          req.method,
          // Captured above, query string already removed: the query string
          // carries what somebody typed into a search box, and that is a
          // client's mobile number often enough to keep out of here.
          path,
          res.statusCode,
          Math.round(ms),
          req.ip ?? null,
          /* Which integration made the call, when it was not a person. The
             user_id alone cannot answer that: a key authenticates AS a user,
             so an integration and its owner look identical without this. */
          req.api_credential?.id ?? null,
        ],
      );
    } catch (err) {
      // A failure to log must never fail the request the user was making.
      // It is a control, not the product.
      console.error('[accesslog]', err.message);
    }
  });

  return next();
}

/** Drop rows past the retention window. Returns how many went. */
export function sweepAccessLog(days = RETENTION_DAYS) {
  const before = one('SELECT COUNT(*) n FROM request_log').n;
  run("DELETE FROM request_log WHERE at < datetime('now', ?)", [`-${days} days`]);
  return before - one('SELECT COUNT(*) n FROM request_log').n;
}

/**
 * Reads of records belonging to a business the reader is not in.
 *
 * The query the cross-book incident needed and could not run. It resolves the
 * record's business from the id in the path, so it answers the question
 * directly rather than leaving somebody to join it up by hand.
 */
export function crossBookReads({ since = null, until = null } = {}) {
  const where = ["r.method = 'GET'", 'r.status = 200', 'r.sales_org IS NOT NULL'];
  const params = [];
  if (since) { where.push('r.at >= ?'); params.push(since); }
  if (until) { where.push('r.at <= ?'); params.push(until); }
  /* Entitlement is decided in JS below, by the same orgsFor() the API enforces,
   * rather than by comparing against the reader's home sales_org here.
   *
   * Superadmin spans both businesses by design, and a user may carry an
   * org_access list covering both. Comparing home org to record org flags every
   * one of their reads -- so the report would cry wolf about precisely the two
   * people who are supposed to see both books, and be ignored within a week. */

  /* Each pattern names the table the trailing id belongs to. A path with no
   * resolvable record -- a list route, say -- yields NULL and is filtered out,
   * because "read the lead list" is not a cross-book question. */
  return all(
    `WITH resolved AS (
       SELECT r.*,
              CASE
                WHEN r.path LIKE '/api/leads/%'    THEN (SELECT sales_org FROM leads    WHERE id = CAST(replace(r.path, '/api/leads/', '')    AS INTEGER))
                WHEN r.path LIKE '/api/clients/%'  THEN (SELECT sales_org FROM clients  WHERE id = CAST(replace(r.path, '/api/clients/', '')  AS INTEGER))
                WHEN r.path LIKE '/api/tickets/%'  THEN (SELECT sales_org FROM tickets  WHERE id = CAST(replace(r.path, '/api/tickets/', '')  AS INTEGER))
                WHEN r.path LIKE '/api/partners/%' THEN (SELECT sales_org FROM partners WHERE id = CAST(replace(r.path, '/api/partners/', '') AS INTEGER))
                WHEN r.path LIKE '/api/lists/%'    THEN (SELECT sales_org FROM lead_lists WHERE id = CAST(replace(r.path, '/api/lists/', '')  AS INTEGER))
                ELSE NULL
              END AS record_org
         FROM request_log r
        WHERE ${where.join(' AND ')}
     )
     SELECT resolved.at, resolved.user_id, u.email, u.org_access, resolved.role,
            resolved.sales_org AS reader_org, resolved.record_org,
            resolved.method, resolved.path, resolved.status
       FROM resolved
       LEFT JOIN users u ON u.id = resolved.user_id
      WHERE resolved.record_org IS NOT NULL
        AND resolved.record_org <> resolved.sales_org
      ORDER BY resolved.at DESC
      LIMIT 500`,
    params,
  )
    .filter((r) => !orgsFor({
      role: r.role,
      sales_org: r.reader_org,
      org_access: r.org_access,
    }).includes(r.record_org))
    .map(({ org_access, ...row }) => row);
}

/** Everything one person did, newest first — the "what did they touch?" view. */
export function activityOf(userId, { limit = 200 } = {}) {
  return all(
    `SELECT at, method, path, status, duration_ms, ip
       FROM request_log WHERE user_id = ?
      ORDER BY at DESC LIMIT ?`,
    [userId, Math.min(Math.max(Number(limit) || 200, 1), 1000)],
  );
}

/** Everyone who touched one path — the "who read this record?" view. */
export function readersOf(path, { limit = 200 } = {}) {
  return all(
    `SELECT r.at, r.user_id, u.email, r.role, r.sales_org, r.method, r.status, r.ip
       FROM request_log r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.path = ?
      ORDER BY r.at DESC LIMIT ?`,
    [path, Math.min(Math.max(Number(limit) || 200, 1), 1000)],
  );
}

/** Shape of the log right now, for the Setup screen to show it is running. */
export function accessLogSummary() {
  const totals = one(
    `SELECT COUNT(*) rows, MIN(at) oldest, MAX(at) newest,
            COUNT(DISTINCT user_id) people
       FROM request_log`,
  );
  return {
    ...totals,
    retention_days: RETENTION_DAYS,
    refused: one("SELECT COUNT(*) n FROM request_log WHERE status IN (401, 403)").n,
    server_errors: one('SELECT COUNT(*) n FROM request_log WHERE status >= 500').n,
    busiest: all(
      `SELECT path, COUNT(*) n FROM request_log
        GROUP BY path ORDER BY n DESC LIMIT 10`,
    ),
  };
}

export { db };
