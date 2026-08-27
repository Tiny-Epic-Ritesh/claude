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

router.get('/', (req, res) => {
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

  const clause = where.join(' AND ');
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

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
      ORDER BY c.activated_at DESC
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

router.get('/meta', (_req, res) =>
  res.json({ segments: SEGMENTS, statuses: CLIENT_STATUSES }));

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
