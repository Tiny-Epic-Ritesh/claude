/**
 * Clients — the account book.
 *
 * Separate from leads because the two are separate things (engine/clients.js
 * carries the reasoning). Structurally this mirrors the lead list: one COUNT,
 * one page query, then one set-based query per attachment. The lead list was
 * 1,150 queries and 2.1s before that shape was imposed on it; there is no
 * reason to rediscover that here.
 */

import { Router } from 'express';
import { assertValid } from '../engine/validation.js';
import { all, one, run, audit } from '../db.js';
import {
  can, requireUser, requirePermission, reqClientScope, unmaskRequested, maskFor,
} from '../auth.js';
import { maskRecord, maskRecords, validate } from '../security.js';
import {
  SEGMENTS, CLIENT_STATUSES, dormantSql, segmentsFor, setSegments, timelineFor,
} from '../engine/clients.js';

const router = Router();
router.use(requireUser);

/**
 * The columns a client row can be ordered by or exported as.
 *
 * One table rather than two lists, because a column somebody can sort by and a
 * column somebody can export are the same question asked twice. `sql` is what
 * ORDER BY needs — several of these are joined or derived, so the column name
 * alone would not resolve.
 *
 * This is also the whitelist that keeps the sort parameter out of the query. It
 * lands in an ORDER BY, so it is never taken from the request directly.
 */
export const CLIENT_COLUMNS = [
  { key: 'name', label: 'Client', sql: 'c.name' },
  { key: 'client_code', label: 'UCC', sql: 'c.client_code' },
  { key: 'mobile', label: 'Mobile', sql: 'c.mobile', pii: true },
  { key: 'email', label: 'Email', sql: 'c.email', pii: true },
  { key: 'status', label: 'Status', sql: 'c.status' },
  { key: 'risk_profile', label: 'Risk profile', sql: 'c.risk_profile' },
  { key: 'holding_value', label: 'Holdings', sql: 'c.holding_value' },
  { key: 'brokerage_ytd', label: 'Brokerage YTD', sql: 'c.brokerage_ytd' },
  { key: 'ledger_balance', label: 'Ledger balance', sql: 'c.ledger_balance' },
  { key: 'margin_available', label: 'Margin available', sql: 'c.margin_available' },
  { key: 'trades_last_year', label: 'Trades (1y)', sql: 'c.trades_last_year' },
  { key: 'last_traded_at', label: 'Last trade', sql: 'c.last_traded_at' },
  { key: 'activated_at', label: 'Opened', sql: 'c.activated_at' },
  { key: 'days_since_trade', label: 'Days since trade', sql: 'days_since_trade' },
  { key: 'owner_name', label: 'Owner', sql: 'u.name' },
  { key: 'partner_name', label: 'Partner', sql: 'p.name' },
  { key: 'sales_org', label: 'Business', sql: 'c.sales_org' },
];

const columnBy = (key) => CLIENT_COLUMNS.find((col) => col.key === key);

/* The most one export may carry. Matches the lead-list cap — an export larger
   than this is a report, and a report is a different conversation. */
const EXPORT_CAP = 5000;

/** A role with no client grant at all should not see an empty tab and wonder. */
const mayViewClients = (user) =>
  can(user.role, 'client.view.all') || can(user.role, 'client.view.own');

router.use((req, res, next) => {
  if (!mayViewClients(req.user)) {
    return res.status(403).json({
      error: 'Your role does not have access to client accounts',
      required: 'client.view.own',
    });
  }
  next();
});

/* --------------------------------------------------------------- list */

/**
 * The filters behind the account book, as one clause.
 *
 * Shared by the list and the export deliberately. An export that rebuilt these
 * conditions separately would eventually disagree with the screen it was taken
 * from, and somebody would leave with a different set of accounts than the one
 * they were looking at — the kind of divergence nobody notices until an
 * auditor asks which rows were sent.
 */
function clientFilter(req) {
  const scope = reqClientScope(req, 'c');
  const where = ['c.deleted_at IS NULL', scope.sql];
  const params = [...scope.params];

  const { q, status, segment, owner_id, partner_id, dormant } = req.query;

  if (q) {
    // PAN is encrypted at rest and cannot be LIKE-searched; UCC can, and is
    // what people actually paste in.
    where.push('(c.name LIKE ? OR c.client_code LIKE ? OR c.mobile LIKE ? OR c.email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (owner_id) { where.push('c.owner_id = ?'); params.push(owner_id); }
  if (partner_id) { where.push('c.partner_id = ?'); params.push(partner_id); }
  if (segment) {
    where.push('EXISTS (SELECT 1 FROM client_segments s WHERE s.client_id = c.id AND s.segment = ? AND s.active = 1)');
    params.push(segment);
  }
  // Derived, so it narrows in SQL rather than after the limit.
  if (dormant === 'true') where.push(`${dormantSql('c')} = 'Dormant'`);

  /* P2-13. The window the "Accounts opened" tile counted over. Matched on
     activated_at, which is what that tile counts -- created_at would be a
     different set and a plausible-looking wrong answer. */
  if (req.query.opened_from) { where.push('date(c.activated_at) >= date(?)'); params.push(req.query.opened_from); }
  if (req.query.opened_to) { where.push('date(c.activated_at) <= date(?)'); params.push(req.query.opened_to); }

  return { clause: where.join(' AND '), params };
}

/** Which of the filters above are actually in play, for an audit row. */
const appliedFilters = (req) => Object.fromEntries(
  ['q', 'status', 'segment', 'owner_id', 'partner_id', 'dormant', 'opened_from', 'opened_to']
    .filter((k) => req.query[k])
    .map((k) => [k, req.query[k]]),
);

router.get('/', (req, res) => {
  const { clause, params } = clientFilter(req);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  /* Order, from the whitelist above. This is an account book whose columns are
     Holdings and Brokerage YTD, so "who are my largest clients" is the question
     it exists to answer — and until now the only way to ask it was to export
     the table and sort it somewhere else. `c.id` breaks ties so a row cannot
     appear on two consecutive pages when the sorted values are equal. */
  const sortCol = columnBy(req.query.sort);
  const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sortCol ? `${sortCol.sql} ${dir}, c.id ASC` : 'c.activated_at DESC';

  const total = one(`SELECT COUNT(*) n FROM clients c WHERE ${clause}`, params).n;

  const rows = all(
    `SELECT c.id, c.client_code, c.name, c.mobile, c.email, c.demat_id,
            c.sales_org, c.owner_id, c.partner_id, c.converted_from_lead_id,
            c.status, c.risk_profile, c.activated_at, c.first_traded_at,
            c.last_traded_at, c.trades_last_year, c.brokerage_ytd,
            c.ledger_balance, c.holding_value, c.margin_available,
            ${dormantSql('c')} AS activity_status,
            CAST(julianday('now') - julianday(COALESCE(c.last_traded_at, c.activated_at)) AS INTEGER) AS days_since_trade,
            u.name AS owner_name, p.name AS partner_name
       FROM clients c
       LEFT JOIN users u ON u.id = c.owner_id
       LEFT JOIN partners p ON p.id = c.partner_id
      WHERE ${clause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  res.set('X-Total-Count', String(total));
  if (rows.length === 0) return res.json([]);

  // Segments for this page only, in one query.
  const ids = rows.map((r) => r.id);
  const list = ids.map(() => '?').join(',');
  const segs = all(
    `SELECT client_id, segment FROM client_segments
      WHERE client_id IN (${list}) AND active = 1 ORDER BY segment`,
    ids,
  );
  const byClient = new Map();
  for (const s of segs) {
    if (!byClient.has(s.client_id)) byClient.set(s.client_id, []);
    byClient.get(s.client_id).push(s.segment);
  }

  res.json(maskRecords(
    rows.map((r) => ({ ...r, segments: byClient.get(r.id) || [] })),
    maskFor(req, 'client.list'),
  ));
});

/* ------------------------------------------------------------ summary */

/**
 * The counts behind the tab's summary cards. Computed under the same scope as
 * the list, so a figure can never describe accounts the person cannot open.
 */
/* --------------------------------------------------------------- export */

/** One CSV cell. Quotes everything, so a comma in a name cannot shift a column. */
const csvCell = (v) => (v === null || v === undefined ? '""' : `"${String(v).replace(/"/g, '""')}"`);

/**
 * Export the account book, as filtered.
 *
 * Clients are the one object in this system with no advanced search and no
 * export — leads, cases, tasks, partners and campaigns all have both. For a
 * broking CRM the account book is the revenue, so the absence meant the most
 * valuable table in the product was the one people had to copy out of the
 * screen by hand.
 *
 * Masked by default and gated the same way the rest of the system's exports
 * are: unmasking is a separate capability and is named in the audit row, so
 * taking identifiers out in the clear is a decision somebody made rather than
 * a default nobody noticed.
 */
router.post('/export', requirePermission('data.export'), (req, res) => {
  const chosen = (Array.isArray(req.body?.columns) && req.body.columns.length
    ? req.body.columns.filter((k) => columnBy(k))
    : ['name', 'client_code', 'status', 'holding_value', 'brokerage_ytd', 'last_traded_at', 'owner_name']);
  if (!chosen.length) return res.status(400).json({ error: 'Choose at least one column' });

  const wantsClear = Boolean(req.body?.unmask);
  const mayUnmask = can(req.user.role, 'pii.unmask');
  if (wantsClear && !mayUnmask) {
    return res.status(403).json({
      error: 'Exporting identifiers in the clear needs the unmask permission',
      required: 'pii.unmask',
    });
  }
  const unmasked = wantsClear && mayUnmask;

  const { clause, params } = clientFilter(req);
  const rows = all(
    `SELECT c.*, ${dormantSql('c')} AS activity_status,
            CAST(julianday('now') - julianday(COALESCE(c.last_traded_at, c.activated_at)) AS INTEGER) AS days_since_trade,
            u.name AS owner_name, p.name AS partner_name
       FROM clients c
       LEFT JOIN users u ON u.id = c.owner_id
       LEFT JOIN partners p ON p.id = c.partner_id
      WHERE ${clause}
      ORDER BY c.id
      LIMIT ?`,
    [...params, EXPORT_CAP],
  );

  /* Field-level masking still applies. An export is not a way around it — the
     screen this was taken from masked these same columns. */
  const visible = maskRecords(rows, maskFor(req, 'client.list'));

  const mask = (key, value) => {
    if (!columnBy(key)?.pii || unmasked || !value) return value;
    const str = String(value);
    return key === 'email'
      ? str.replace(/^(.).*(@.*)$/, '$1***$2')
      : `******${str.slice(-4)}`;
  };

  const header = chosen.map((k) => csvCell(columnBy(k).label)).join(',');
  const body = visible.map((r) => chosen.map((k) => csvCell(mask(k, r[k]))).join(',')).join('\n');

  /* One row naming what left, not one per client: this is a single act by one
     person, and five thousand rows would bury the fact of it. The filter is
     recorded because "who was in that export" is the question asked afterwards,
     and the filter is the only thing that answers it. */
  audit(req.user.id, 'client.export', 'client', null, {
    rows: visible.length, columns: chosen, unmasked, filters: appliedFilters(req),
  });

  res.json({
    filename: `clients-${new Date().toISOString().slice(0, 10)}.csv`,
    rows: visible.length,
    unmasked,
    truncated: visible.length >= EXPORT_CAP,
    csv: `${header}\n${body}`,
  });
});

router.get('/summary', (req, res) => {
  const scope = reqClientScope(req, 'c');
  const base = `FROM clients c WHERE c.deleted_at IS NULL AND ${scope.sql}`;
  const p = scope.params;

  const row = one(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN ${dormantSql('c')} = 'Active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN ${dormantSql('c')} = 'Dormant' THEN 1 ELSE 0 END) AS dormant,
           SUM(CASE WHEN c.status = 'Closed' THEN 1 ELSE 0 END) AS closed,
           COALESCE(SUM(c.brokerage_ytd), 0) AS brokerage_ytd,
           COALESCE(SUM(c.holding_value), 0) AS holding_value
    ${base}`, p);

  const bySegment = all(`
    SELECT s.segment, COUNT(*) n
      FROM client_segments s
      JOIN clients c ON c.id = s.client_id
     WHERE s.active = 1 AND c.deleted_at IS NULL AND ${scope.sql}
     GROUP BY s.segment ORDER BY n DESC`, p);

  const openedThisMonth = one(`
    SELECT COUNT(*) n ${base} AND strftime('%Y-%m', c.activated_at) = strftime('%Y-%m', 'now')`, p).n;

  res.json({ ...row, opened_this_month: openedThisMonth, by_segment: bySegment });
});

router.get('/meta', (req, res) =>
  res.json({
    segments: SEGMENTS,
    statuses: CLIENT_STATUSES,
    /* The columns the book can be ordered by and exported as, so the interface
       cannot offer one the route would refuse. `sql` stays server-side — it is
       the ORDER BY fragment and no business of the browser's. */
    columns: CLIENT_COLUMNS.map(({ key, label, pii }) => ({ key, label, pii: Boolean(pii) })),
    export_cap: EXPORT_CAP,
    /* Whether this person may take identifiers out in the clear, so the export
       dialog offers the choice only to somebody who has it rather than showing
       a control that answers 403. */
    may_export: can(req.user.role, 'data.export'),
    may_unmask: can(req.user.role, 'pii.unmask'),
  }));

/* ------------------------------------------------------------- detail */

const load = (req) => {
  const scope = reqClientScope(req, 'c');
  return one(
    `SELECT c.*, ${dormantSql('c')} AS activity_status,
            u.name AS owner_name, p.name AS partner_name
       FROM clients c
       LEFT JOIN users u ON u.id = c.owner_id
       LEFT JOIN partners p ON p.id = c.partner_id
      WHERE c.id = ? AND c.deleted_at IS NULL AND ${scope.sql}`,
    [req.params.id, ...scope.params],
  );
};

router.get('/:id', (req, res) => {
  const client = load(req);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const masking = maskFor(req, 'client.detail');
  const lead = client.converted_from_lead_id
    ? one('SELECT id, name, source, stage, created_at FROM leads WHERE id = ?', [client.converted_from_lead_id])
    : null;

  res.json({
    ...maskRecord(client, masking),
    segments: segmentsFor(client.id),
    // Attribution: the enquiry that became this account, and the campaign or
    // partner it arrived through. Long after the lead stops being worked, this
    // is what answers "where did this client come from?".
    origin_lead: lead,
    timeline: timelineFor(client, 100),
    open_cases: one(
      `SELECT COUNT(*) n FROM tickets
        WHERE lead_id = ? AND status NOT IN ('Resolved','Closed')`,
      [client.converted_from_lead_id ?? -1],
    ).n,
  });
});

/* -------------------------------------------------------------- write */

const EDITABLE = [
  'name', 'mobile', 'email', 'demat_id', 'risk_profile', 'nominee_name', 'status',
];

router.patch('/:id', requirePermission('client.edit'), (req, res) => {
  const client = load(req);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const bad = validate(req.body, {
    name: ['max:120'],
    mobile: ['mobile'],
    email: ['email'],
  });
  if (bad) return res.status(400).json(bad);

  if ('status' in req.body && !CLIENT_STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: `Status must be one of: ${CLIENT_STATUSES.join(', ')}` });
  }

  /* Configured validation rules, enforced at the API rather than in the form.
     Imports, automation and bulk actions all arrive here and none of them
     render a form. Every failing rule is reported, not just the first — being
     told about one problem, fixing it, and being told about the next is how a
     form becomes something people work around. */
  const refusals = assertValid('client', { existing: client, patch: req.body });
  if (refusals) {
    return res.status(422).json({
      error: refusals[0].message,
      failed: refusals.map((r) => ({ rule: r.rule, message: r.message })),
    });
  }

  const sets = [];
  const params = [];
  for (const field of EDITABLE) {
    if (!(field in req.body)) continue;
    sets.push(`${field} = ?`);
    params.push(req.body[field]);
  }

  if (Array.isArray(req.body.segments)) setSegments(client.id, req.body.segments);

  if (sets.length) {
    // A closed account keeps its closure date, so retention has a clock to run.
    if (req.body.status === 'Closed' && client.status !== 'Closed') {
      sets.push("closed_at = datetime('now')");
    }
    sets.push("updated_at = datetime('now')");
    run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, [...params, client.id]);
  }

  audit(req.user.id, 'client.update', 'client', client.id, {
    fields: Object.keys(req.body).filter((k) => EDITABLE.includes(k) || k === 'segments'),
  });

  res.json({ ok: true, client: load(req) });
});

router.post('/:id/reassign', requirePermission('client.reassign'), (req, res) => {
  const client = load(req);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const ownerId = Number(req.body?.owner_id);
  const owner = one('SELECT id, name, sales_org FROM users WHERE id = ? AND active = 1', [ownerId]);
  if (!owner) return res.status(400).json({ error: 'Choose an active user to own this account' });
  // An account cannot be handed to someone who cannot work in its business.
  if (owner.sales_org !== client.sales_org) {
    return res.status(400).json({ error: `${owner.name} does not work in ${client.sales_org}` });
  }

  run("UPDATE clients SET owner_id = ?, updated_at = datetime('now') WHERE id = ?", [ownerId, client.id]);
  audit(req.user.id, 'client.reassign', 'client', client.id, { from: client.owner_id, to: ownerId });
  res.json({ ok: true, client: load(req) });
});

export default router;
