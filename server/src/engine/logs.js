/**
 * Log retention, and reading the logs back.
 *
 * P2-15a asks for one place to manage webhook, telephony, API, payment and
 * portal logs. Two things make that more than a table viewer:
 *
 * RETENTION IS CONFIGURATION, NOT A CONSTANT (D-8)
 *
 * The periods below are recommendations, not law. Ninety days for API and
 * webhook traffic is long enough to debug an integration and short enough not
 * to hoard; twelve months for telephony because call records attract regulatory
 * interest. The payment period is an assumption from general practice and is
 * the one I cannot source — it is seeded with a note saying so, and Compliance
 * can change it here without a deploy. A number somebody chose and can see
 * beats a number buried in code that nobody remembers agreeing to.
 *
 * PURGING IS THE POINT
 *
 * A retention period nothing enforces is a statement of intent, and under DPDP
 * it is worse than no statement: the firm has written down how long it keeps
 * personal data and then kept it longer. The purge runs on boot and on demand,
 * and reports what it removed.
 */

import { all, one, run } from '../db.js';

/**
 * The kinds of log the product keeps, and how long each is kept for.
 *
 * `source` says which table the rows live in, because they were not designed
 * together: request_log is the access log built for the cross-book incident,
 * integration_log is vendor traffic, audit_log is configuration history.
 * Presenting them as one thing is the point of the screen; pretending they are
 * one table would have meant rewriting all three.
 */
export const LOG_KINDS = [
  {
    kind: 'api',
    label: 'API and portal access',
    source: 'request_log',
    days: 90,
    note: 'Every request, with who made it. Matches the access log built for the book-boundary incident.',
  },
  {
    kind: 'telephony',
    label: 'Telephony',
    source: 'integration_log',
    days: 365,
    note: 'Call records attract regulatory interest, so kept a year rather than a quarter.',
  },
  {
    kind: 'webhook',
    label: 'Webhooks',
    source: 'integration_log',
    days: 90,
    note: 'Long enough to debug an integration, short enough not to hoard.',
  },
  {
    kind: 'messaging',
    label: 'WhatsApp, SMS and email',
    source: 'integration_log',
    days: 90,
    note: 'Delivery outcomes only — no message bodies are stored anywhere in these logs.',
  },
  {
    kind: 'payment',
    label: 'Payments',
    source: 'integration_log',
    days: 2555,
    note: 'SEVEN YEARS IS AN ASSUMPTION from general practice, not a sourced requirement. '
      + 'Compliance should confirm the number before go-live — it is both a storage commitment and a DPDP question.',
  },
  {
    kind: 'kyc',
    label: 'KYC',
    source: 'integration_log',
    days: 365,
    note: 'Journey callbacks and their outcomes. The KYC record itself is not a log and is not purged.',
  },
  {
    /* Separate from `config` because it is a different table and, on a young
       database, by far the largest thing in the file — it stores the whole
       before and after payload of every setting change, which is what makes it
       useful and what makes it grow. It had no retention policy at all until
       the size screen (P2-19) showed it was 41% of the database. */
    kind: 'config_detail',
    label: 'Configuration change detail',
    source: 'config_audit',
    days: 2555,
    note: 'Before and after values for every setting change. The largest log by '
      + 'some margin, because it keeps the payloads — which is the point of it.',
  },
  {
    kind: 'config',
    label: 'Configuration changes',
    source: 'audit_log',
    days: 2555,
    note: 'Who changed which setting, and when. An auditor asks about a change years after it was made.',
  },
];

/** Which integration_log kinds roll up under each screen heading. */
const MEMBERS = {
  telephony: ['telephony', 'autodialler'],
  messaging: ['whatsapp', 'sms', 'email'],
  payment: ['payment', 'penny_drop'],
  kyc: ['kyc', 'bonanza_kyc', 'digilocker', 'esign'],
  webhook: ['webhook'],
};

/** Seed the periods once. Never overwrites one somebody has changed. */
export function seedRetention() {
  let added = 0;
  for (const k of LOG_KINDS) {
    if (one('SELECT kind FROM log_retention WHERE kind = ?', [k.kind])) continue;
    run('INSERT INTO log_retention (kind, days, note) VALUES (?,?,?)', [k.kind, k.days, k.note]);
    added += 1;
  }
  return added;
}

export const retention = () => {
  const set = new Map(all('SELECT * FROM log_retention').map((r) => [r.kind, r]));
  return LOG_KINDS.map((k) => ({
    ...k,
    days: set.get(k.kind)?.days ?? k.days,
    note: set.get(k.kind)?.note ?? k.note,
    updated_at: set.get(k.kind)?.updated_at ?? null,
    // A period nobody has touched is a default, and worth saying so on screen.
    is_default: !set.get(k.kind)?.updated_at,
  }));
};

/**
 * Delete what is past its period.
 *
 * Returns what it removed rather than doing it silently: a purge that quietly
 * deletes a year of call records is indistinguishable from a bug, and the first
 * person to notice will be someone looking for a record that is gone.
 */
export function purge() {
  const removed = {};
  for (const k of retention()) {
    const cutoff = `-${Number(k.days)} days`;
    let n = 0;

    if (k.source === 'request_log') {
      n = run("DELETE FROM request_log WHERE at < datetime('now', ?)", [cutoff]).changes;
    } else if (k.source === 'config_audit') {
      n = run("DELETE FROM config_audit WHERE at < datetime('now', ?)", [cutoff]).changes;
    } else if (k.source === 'audit_log') {
      // audit_log stamps created_at, not at. The three log tables were not
      // designed together, which is exactly why this module exists.
      n = run("DELETE FROM audit_log WHERE created_at < datetime('now', ?)", [cutoff]).changes;
    } else {
      const kinds = MEMBERS[k.kind] ?? [k.kind];
      n = run(
        `DELETE FROM integration_log
         WHERE at < datetime('now', ?) AND kind IN (${kinds.map(() => '?').join(',')})`,
        [cutoff, ...kinds],
      ).changes;
    }

    if (n) removed[k.kind] = n;
  }
  return removed;
}

/* ----------------------------------------------------------- reading */

/**
 * One page of one kind of log.
 *
 * Book-scoped by the caller's entitlement, like everything else. A Bigul
 * supervisor reading the telephony log must not see which Bonanza clients were
 * called — the boundary does not stop being the boundary because the data is
 * shaped like a log.
 */
export function readLog(kind, { orgs = [], limit = 200, offset = 0, status = null, q = null } = {}) {
  const def = LOG_KINDS.find((k) => k.kind === kind);
  if (!def) return null;

  const marks = orgs.map(() => '?').join(',') || "''";

  if (def.source === 'request_log') {
    const where = [`(r.sales_org IN (${marks}) OR r.sales_org IS NULL)`];
    const params = [...orgs];
    if (status) { where.push('r.status = ?'); params.push(Number(status)); }
    if (q) { where.push('r.path LIKE ?'); params.push(`%${q}%`); }
    return {
      source: def.source,
      rows: all(
        `SELECT r.id, r.at, r.method, r.path, r.status, r.duration_ms, r.role, r.sales_org,
                u.name AS user_name
         FROM request_log r LEFT JOIN users u ON u.id = r.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY r.at DESC, r.id DESC LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)],
      ),
      total: one(`SELECT COUNT(*) n FROM request_log r WHERE ${where.join(' AND ')}`, params).n,
    };
  }

  if (def.source === 'config_audit') {
    return {
      source: def.source,
      rows: all(
        `SELECT c.id, c.at, c.area, c.target, c.action, u.name AS user_name
         FROM config_audit c LEFT JOIN users u ON u.id = c.actor_id
         ORDER BY c.at DESC, c.id DESC LIMIT ? OFFSET ?`,
        [Number(limit), Number(offset)],
      ),
      total: one('SELECT COUNT(*) n FROM config_audit').n,
    };
  }

  if (def.source === 'audit_log') {
    return {
      source: def.source,
      rows: all(
        `SELECT a.id, a.created_at AS at, a.action, a.entity, a.entity_id, a.actor, u.name AS user_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
        [Number(limit), Number(offset)],
      ),
      total: one('SELECT COUNT(*) n FROM audit_log').n,
    };
  }

  const kinds = MEMBERS[kind] ?? [kind];
  const where = [`l.kind IN (${kinds.map(() => '?').join(',')})`];
  const params = [...kinds];

  /* Book scope through the lead, since an integration row carries a lead more
     often than it carries an org. A row attached to nothing is infrastructure,
     not client data, and stays visible. */
  where.push(`(l.lead_id IS NULL OR EXISTS (
    SELECT 1 FROM leads le WHERE le.id = l.lead_id AND le.sales_org IN (${marks})))`);
  params.push(...orgs);

  if (status) { where.push('l.status = ?'); params.push(status); }
  if (q) { where.push('(l.summary LIKE ? OR l.reference LIKE ? OR l.vendor LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  return {
    source: def.source,
    rows: all(
      `SELECT l.*, le.name AS lead_name, u.name AS user_name
       FROM integration_log l
       LEFT JOIN leads le ON le.id = l.lead_id
       LEFT JOIN users u ON u.id = l.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY l.at DESC, l.id DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)],
    ),
    total: one(`SELECT COUNT(*) n FROM integration_log l WHERE ${where.join(' AND ')}`, params).n,
  };
}

/** Counts per kind, for the tab strip. */
export function counts(orgs = []) {
  const out = {};
  for (const k of LOG_KINDS) out[k.kind] = readLog(k.kind, { orgs, limit: 1 })?.total ?? 0;
  return out;
}
