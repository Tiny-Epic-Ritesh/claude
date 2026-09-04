/**
 * Ticket module — creation, SLA, replies, escalation, merge, CSAT.
 */

import { Router } from 'express';
import { all, one, run, audit, notify } from '../db.js';
import { can, requireUser, requirePermission, mayUseOrg, activeOrg, reqTicketScope } from '../auth.js';
import { loadInBook } from '../engine/bookscope.js';
import { assertValid } from '../engine/validation.js';
import { applySla, sweepSla, handleStatusChange, slaRemaining, DEFAULT_SLA } from '../engine/sla.js';
import { send } from '../integrations.js';
import * as ai from '../ai/index.js';

const router = Router();
router.use(requireUser);

const STATUSES = ['Open', 'Pending', 'Waiting on Client', 'Resolved', 'Closed'];
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

/**
 * The columns a case queue can be ordered by or exported as.
 *
 * The default order is not one of them: a queue sorts breached-first, then by
 * priority, then by what is due soonest, because that is the order somebody
 * should work them in. Sorting is for asking a different question of the same
 * rows — "which of these has been open longest" — and it never becomes the
 * default.
 */
export const TICKET_COLUMNS = [
  { key: 'ref', label: 'Ref', sql: 't.ref' },
  { key: 'subject', label: 'Subject', sql: 't.subject' },
  { key: 'status', label: 'Status', sql: 't.status' },
  { key: 'priority', label: 'Priority', sql: "CASE t.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END" },
  { key: 'channel', label: 'Channel', sql: 't.channel' },
  { key: 'category_name', label: 'Category', sql: 'c.name' },
  { key: 'lead_name', label: 'Linked to', sql: 'l.name' },
  { key: 'lead_mobile', label: 'Mobile', sql: 'l.mobile', pii: true },
  { key: 'assignee_name', label: 'Assignee', sql: 'u.name' },
  { key: 'partner_name', label: 'Partner', sql: 'p.name' },
  { key: 'breached', label: 'Breached', sql: 't.breached' },
  { key: 'resolution_due', label: 'Resolution due', sql: 't.resolution_due' },
  { key: 'first_response_at', label: 'First response', sql: 't.first_response_at' },
  { key: 'resolved_at', label: 'Resolved', sql: 't.resolved_at' },
  { key: 'created_at', label: 'Raised', sql: 't.created_at' },
  { key: 'csat', label: 'CSAT', sql: 't.csat' },
  { key: 'sales_org', label: 'Business', sql: 't.sales_org' },
];

const ticketColumn = (key) => TICKET_COLUMNS.find((col) => col.key === key);

/* The most one export may carry, matching leads and clients. */
const EXPORT_CAP = 5000;

/** One CSV cell. Quotes everything, so a comma in a subject cannot shift a column. */
const csvCell = (v) => (v === null || v === undefined ? '""' : `"${String(v).replace(/"/g, '""')}"`);

const decorate = (t) => ({
  ...t,
  sla_remaining_mins: slaRemaining(t),
  ai_summary_lines: t.ai_summary ? t.ai_summary.split('\n') : [],
});

/** Regenerate the 2-line AI gist. Never blocks the caller's request. */
async function refreshSummary(ticketId) {
  try {
    const ticket = one(
      `SELECT t.*, pt.name AS product_name, u.name AS assignee_name
       FROM tickets t
       LEFT JOIN product_cards pc ON pc.id = t.card_id
       LEFT JOIN product_types pt ON pt.id = pc.product_type_id
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.id = ?`, [ticketId],
    );
    if (!ticket) return;
    const replies = all('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at', [ticketId]);
    const summary = await ai.ticketSummary(ticket, replies);
    run('UPDATE tickets SET ai_summary = ? WHERE id = ?', [`${summary.line1}\n${summary.line2}`, ticketId]);
  } catch (err) {
    console.error('[ai] ticket summary failed:', err.message);
  }
}

/* -------------------------------------------------------------- queries */

/**
 * The filters behind the case queue, as one clause.
 *
 * Shared by the queue and its export, so what leaves is what was on screen. The
 * alternative — rebuilding these conditions in the export — is how the two come
 * to disagree about which cases somebody actually took.
 */
function ticketFilter(req) {
  const { status, priority, mine, breached, lead_id, category_id } = req.query;
  const where = ['t.merged_into IS NULL'];
  const params = [];

  /* A ticket carries its own book, and this list never checked it.
   *
   * /tickets/:id was scoped in August; the list beside it was not, so a Bigul
   * supervisor's case queue included Bonanza tickets -- subject, description
   * and the client's name and mobile, all joined in. The record route and its
   * list are the same data with the same boundary, and fixing one of a pair is
   * how the other stays broken. Third time that exact shape has appeared, and
   * the reason the conformance test now covers list routes too. */
  /* §6a. The book check below answers "whose book", never "whose case", so
     until now every signed-in user read every case in their own book. The
     scope carries the org check itself, so this is one rule rather than two
     that have to agree. */
  const scope = reqTicketScope(req, 't');
  where.push(scope.sql);
  params.push(...scope.params);

  if (mine === 'true') { where.push('t.assignee_id = ?'); params.push(req.user.id); }
  if (status) { where.push('t.status = ?'); params.push(status); }
  else if (req.query.open === 'true') where.push("t.status NOT IN ('Resolved','Closed')");

  /* P2-13. The predicates the dashboard tiles count on, so the tile and the
     list are the same set rather than two implementations that agree today. */
  if (req.query.breached === 'true') where.push('t.breached = 1');
  if (req.query.resolved_from) { where.push('date(t.resolved_at) >= date(?)'); params.push(req.query.resolved_from); }
  if (req.query.resolved_to) { where.push('date(t.resolved_at) <= date(?)'); params.push(req.query.resolved_to); }
  if (req.query.created_from) { where.push('date(t.created_at) >= date(?)'); params.push(req.query.created_from); }
  if (req.query.created_to) { where.push('date(t.created_at) <= date(?)'); params.push(req.query.created_to); }
  if (priority) { where.push('t.priority = ?'); params.push(priority); }
  if (breached === 'true') where.push('t.breached = 1');
  if (lead_id) { where.push('t.lead_id = ?'); params.push(lead_id); }
  if (category_id) { where.push('t.category_id = ?'); params.push(category_id); }

  /* Find one case among hundreds without paging to it. Bound to what somebody
     would actually search a case by — its reference, its subject, or the person
     it was raised for. */
  const q = String(req.query.q ?? '').trim();
  if (q) {
    where.push('(t.ref LIKE ? OR t.subject LIKE ? OR l.name LIKE ? OR l.mobile LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  return { clause: where.join(' AND '), params };
}

/** Which filters are in play, for an audit row. */
const appliedTicketFilters = (req) => Object.fromEntries(
  ['q', 'status', 'priority', 'mine', 'breached', 'open', 'lead_id', 'category_id',
    'created_from', 'created_to', 'resolved_from', 'resolved_to']
    .filter((k) => req.query[k])
    .map((k) => [k, req.query[k]]),
);

/* The joins the queue and the export both read from. Written once because the
   column table above names `c.name`, `l.name` and `u.name` in its sort SQL, and
   those aliases have to mean the same thing wherever they are used. */
const TICKET_FROM = `FROM tickets t
     LEFT JOIN leads l ON l.id = t.lead_id
     LEFT JOIN partners p ON p.id = t.partner_id
     LEFT JOIN users u ON u.id = t.assignee_id
     LEFT JOIN ticket_categories c ON c.id = t.category_id
     LEFT JOIN product_cards pc ON pc.id = t.card_id
     LEFT JOIN product_types pt ON pt.id = pc.product_type_id`;

router.get('/', (req, res) => {
  const { clause, params } = ticketFilter(req);

  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  /* Breached first, then priority, then what is due soonest — the order a queue
     should be worked in. A chosen sort replaces it for the length of the
     question being asked, and never becomes the default. */
  const sortCol = ticketColumn(req.query.sort);
  const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sortCol
    ? `${sortCol.sql} ${dir}, t.id ASC`
    : `t.breached DESC, CASE t.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, t.resolution_due`;

  const total = one(`SELECT COUNT(*) n ${TICKET_FROM} WHERE ${clause}`, params).n;
  res.set('X-Total-Count', String(total));

  res.json(all(
    `SELECT t.*, l.name AS lead_name, l.mobile AS lead_mobile, u.name AS assignee_name,
            c.name AS category_name, pt.name AS product_name, p.name AS partner_name
     ${TICKET_FROM}
     WHERE ${clause}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ).map(decorate));
});

/* Declared before `/:id`, or Express reads "meta" as a ticket id. */
router.get('/meta', (req, res) => res.json({
  statuses: STATUSES,
  priorities: PRIORITIES,
  /* What the queue can be ordered by and exported as, so the interface cannot
     offer a column the route would refuse. `sql` stays here — it is an ORDER BY
     fragment and no business of the browser's. */
  columns: TICKET_COLUMNS.map(({ key, label, pii }) => ({ key, label, pii: Boolean(pii) })),
  export_cap: EXPORT_CAP,
  may_export: can(req.user.role, 'export.case'),
  may_unmask: can(req.user.role, 'pii.unmask'),
}));

router.get('/:id', (req, res) => {
  const ticket = one(
    `SELECT t.*, l.name AS lead_name, l.mobile AS lead_mobile, u.name AS assignee_name,
            c.name AS category_name, pt.name AS product_name, p.name AS partner_name
     FROM tickets t
     LEFT JOIN leads l ON l.id = t.lead_id
     LEFT JOIN partners p ON p.id = t.partner_id
     LEFT JOIN users u ON u.id = t.assignee_id
     LEFT JOIN ticket_categories c ON c.id = t.category_id
     LEFT JOIN product_cards pc ON pc.id = t.card_id
     LEFT JOIN product_types pt ON pt.id = pc.product_type_id
     WHERE t.id = ?`, [req.params.id],
  );
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  /* The ticket list is filtered by book; this route was not, so a known ref was
   * enough to read the other book's case notes -- which are the client's own
   * words about their own money. */
  if (!mayUseOrg(req.user, ticket.sales_org)) {
    return res.status(403).json({ error: 'This ticket belongs to another book' });
  }

  /* §6a. Right book is not the same question as your case. Asked against the
     same scope the list uses, so a case that cannot be found in the list
     cannot be opened by guessing its id either. */
  const scope = reqTicketScope(req, 't');
  const visible = one(`SELECT 1 v FROM tickets t WHERE t.id = ? AND ${scope.sql}`, [req.params.id, ...scope.params]);
  if (!visible) return res.status(403).json({ error: 'This case is outside your visibility scope' });

  res.json({
    ...decorate(ticket),
    replies: all('SELECT r.*, u.name AS user_name FROM ticket_replies r LEFT JOIN users u ON u.id = r.user_id WHERE r.ticket_id = ? ORDER BY r.created_at', [req.params.id]),
    merged: all('SELECT id, ref, subject FROM tickets WHERE merged_into = ?', [req.params.id]),
  });
});

/* -------------------------------------------------------------- create */

router.post('/', requirePermission('ticket.create'), async (req, res) => {
  const { subject, description, priority = 'Medium', category_id, lead_id, card_id, partner_id, channel = 'CRM' } = req.body;
  if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: `Priority must be one of ${PRIORITIES.join(', ')}` });

  /* A case belongs to the book of whatever it is about.
   *
   * `tickets.sales_org` defaults to 'BONANZA' at the column, and this route
   * never set it — so every case ever raised landed in Bonanza's book whoever
   * raised it and whoever it was about. Both halves of that are wrong: a Bigul
   * case was readable by Bonanza staff, and invisible to the Bigul colleagues
   * whose queue it belonged in. Two of the seeded cases sit on Bigul leads and
   * are marked BONANZA for exactly this reason.
   *
   * The subject decides, not the author: an agent who works both books raising
   * a case about a Bigul lead is raising a Bigul case. */
  const cardLead = card_id
    ? one('SELECT lead_id FROM product_cards WHERE id = ?', [card_id])
    : null;
  const subjectLead = lead_id ?? cardLead?.lead_id ?? null;

  const category = category_id ? one('SELECT * FROM ticket_categories WHERE id = ?', [category_id]) : null;

  const org =
    (subjectLead ? one('SELECT sales_org FROM leads WHERE id = ?', [subjectLead])?.sales_org : null)
    ?? (partner_id ? one('SELECT sales_org FROM partners WHERE id = ?', [partner_id])?.sales_org : null)
    ?? activeOrg(req)
    ?? req.user.sales_org;

  if (!mayUseOrg(req.user, org)) {
    return res.status(403).json({ error: 'That record belongs to another book' });
  }

  /* Auto-assignment by category, round-robin by current open load (BRD §7.10),
     and within the case's own book — an agent cannot work a queue they cannot
     read, so assigning across the book leaves the case stranded. Unassigned in
     the right book beats assigned in the wrong one, so there is no fallback to
     just anybody. */
  const assignee = one(
    `SELECT id FROM users
      WHERE role = ? AND active = 1
        AND (sales_org = ? OR org_access LIKE ?)
      ORDER BY (SELECT COUNT(*) FROM tickets WHERE assignee_id = users.id AND status NOT IN ('Resolved','Closed'))
      LIMIT 1`,
    [category?.auto_assign_role ?? 'customer_care', org, `%${org}%`],
  );

  const result = run(
    `INSERT INTO tickets (subject, description, priority, category_id, lead_id, card_id, partner_id, channel, assignee_id, created_by, status, sales_org)
     VALUES (?,?,?,?,?,?,?,?,?,?,'Open',?)`,
    [subject, description || null, priority, category_id || null, lead_id || null, card_id || null, partner_id || null,
      channel, assignee?.id || null, req.user.id, org],
  );
  const id = Number(result.lastInsertRowid);
  run('UPDATE tickets SET ref = ? WHERE id = ?', [
    `${org === 'BIGUL' ? 'BGL' : 'BNZ'}-${String(id).padStart(5, '0')}`, id,
  ]);

  applySla(id);

  if (lead_id) {
    run('INSERT INTO activities (lead_id, card_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?,?)', [
      lead_id, card_id || null, 'Ticket Event', 'system', `Ticket raised: ${subject}`, description || null, req.user.id,
    ]);
  }
  if (assignee?.id) notify(assignee.id, `New ticket assigned — ${priority}`, subject, `/tickets/${id}`);

  audit(req.user.id, 'ticket_created', 'ticket', id, { priority, category_id });
  await refreshSummary(id);
  res.status(201).json(decorate(one('SELECT * FROM tickets WHERE id = ?', [id])));
});

/* --------------------------------------------------------- interaction */

router.post('/:id/replies', requirePermission('ticket.reply'), async (req, res) => {
  /* A reply is correspondence with somebody else's client. */
  const found = loadInBook(req, 'ticket', req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const ticket = found.row;
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const { body, internal = false, author_type = 'agent' } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Reply body is required' });

  run('INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, internal) VALUES (?,?,?,?,?)', [
    req.params.id, body, author_type, req.user.id, internal ? 1 : 0,
  ]);

  if (!ticket.first_response_at && !internal) {
    run("UPDATE tickets SET first_response_at = datetime('now') WHERE id = ?", [req.params.id]);
  }
  run("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?", [req.params.id]);

  if (ticket.lead_id && !internal) {
    run('INSERT INTO activities (lead_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?)', [
      ticket.lead_id, 'Ticket Event', 'outbound', `Reply on ${ticket.ref}`, body.slice(0, 300), req.user.id,
    ]);
  }
  await refreshSummary(Number(req.params.id));
  res.status(201).json({ ok: true });
});

router.patch('/:id', async (req, res) => {
  /* Loaded within the reader's book. This route gated reassignment on a
     capability and never checked which case was being changed, so a Bonanza
     agent could reopen, reprioritise or reassign a Bigul case. It went
     unnoticed because every seeded case was Bonanza's — there was nothing in
     the other book to try it against. */
  const found = loadInBook(req, 'ticket', req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const ticket = found.row;

  const { status, priority, assignee_id, category_id } = req.body;

  if (assignee_id !== undefined && !can(req.user.role, 'ticket.reassign')) {
    return res.status(403).json({ error: 'Reassignment requires Customer Care, a Supervisor or an Admin', required: 'ticket.reassign' });
  }
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of ${STATUSES.join(', ')}` });

  /* Configured validation rules, enforced here rather than in the form —
     automation and the API reach this route without rendering one. Checked
     against the ticket as it WOULD be, not as it is, or a rule refusing a bad
     final state would let the save that creates it straight through. */
  const refusals = assertValid('case', { existing: ticket, patch: req.body });
  if (refusals) {
    return res.status(422).json({
      error: refusals[0].message,
      failed: refusals.map((r) => ({ rule: r.rule, message: r.message })),
    });
  }

  if (status && status !== ticket.status) handleStatusChange(ticket, status);

  const sets = [];
  const params = [];
  if (status) {
    sets.push('status = ?'); params.push(status);
    if (status === 'Resolved') sets.push("resolved_at = datetime('now')");
    if (status === 'Closed') sets.push("closed_at = datetime('now')");
  }
  if (priority) { sets.push('priority = ?'); params.push(priority); }
  if (assignee_id !== undefined) { sets.push('assignee_id = ?'); params.push(assignee_id); }
  if (category_id !== undefined) { sets.push('category_id = ?'); params.push(category_id); }
  if (!sets.length) return res.json(decorate(ticket));

  run(`UPDATE tickets SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...params, req.params.id]);
  audit(req.user.id, 'ticket_updated', 'ticket', Number(req.params.id), req.body);

  // CSAT goes out on close (BRD §7.10).
  if (status === 'Closed' || status === 'Resolved') {
    const lead = ticket.lead_id ? one('SELECT * FROM leads WHERE id = ?', [ticket.lead_id]) : null;
    if (lead) {
      send('whatsapp', {
        to: lead.mobile,
        body: `Hi ${lead.name}, your Bonanza request ${ticket.ref} has been resolved. How did we do? Reply 1–5 (5 = excellent).`,
        leadId: lead.id,
      });
    }
  }
  if (assignee_id) notify(assignee_id, `Ticket assigned to you — ${ticket.ref}`, ticket.subject, `/tickets/${ticket.id}`);

  await refreshSummary(Number(req.params.id));
  res.json(decorate(one('SELECT * FROM tickets WHERE id = ?', [req.params.id])));
});

router.post('/:id/escalate', requirePermission('ticket.escalate'), (req, res) => {
  /* Escalating answered with the name of the person it went to, so this both
     wrote to the other book and named one of its staff. */
  const found = loadInBook(req, 'ticket', req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const ticket = found.row;
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const assignee = ticket.assignee_id ? one('SELECT * FROM users WHERE id = ?', [ticket.assignee_id]) : null;
  const manager = assignee?.manager_id
    ? one('SELECT * FROM users WHERE id = ?', [assignee.manager_id])
    : one("SELECT * FROM users WHERE role = 'sales_supervisor' AND active = 1 LIMIT 1");

  if (!manager) return res.status(400).json({ error: 'No escalation target found in the hierarchy' });

  run("UPDATE tickets SET assignee_id = ?, priority = CASE priority WHEN 'Low' THEN 'Medium' WHEN 'Medium' THEN 'High' ELSE 'Critical' END, updated_at = datetime('now') WHERE id = ?",
    [manager.id, req.params.id]);
  run('INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, internal) VALUES (?,?,?,?,1)', [
    req.params.id, `Escalated by ${req.user.name}. ${req.body.reason || ''}`, 'system', req.user.id,
  ]);
  notify(manager.id, `Escalated — ${ticket.ref}`, ticket.subject, `/tickets/${ticket.id}`);
  audit(req.user.id, 'ticket_escalated', 'ticket', Number(req.params.id), { to: manager.id });
  res.json({ escalated_to: manager.name });
});

router.post('/:id/merge', requirePermission('ticket.merge'), (req, res) => {
  /* Both ends, because a merge moves the replies.
   *
   * This checked neither, and a merge does not just write across the book — it
   * relocates. `UPDATE ticket_replies SET ticket_id = ?` carried a Bigul
   * client's entire correspondence onto a Bonanza case and closed the original,
   * in either direction, permanently. Of everything found in this sweep it is
   * the one that moved the other book's data rather than reading or amending
   * it.
   *
   * The target is looked up inside the source's book, so a case in the other
   * one is "not found" rather than "belongs to another book" — the second
   * phrasing confirms it exists. */
  const { into_id } = req.body;

  const from = loadInBook(req, 'ticket', req.params.id);
  if (from.error) return res.status(from.status).json({ error: from.error });
  const source = from.row;

  const target = one(
    'SELECT * FROM tickets WHERE id = ? AND sales_org = ?',
    [Number(into_id) || -1, source.sales_org],
  );
  if (!target) return res.status(404).json({ error: 'Both tickets must exist' });
  if (source.id === target.id) return res.status(400).json({ error: 'Cannot merge a ticket into itself' });

  run('UPDATE ticket_replies SET ticket_id = ? WHERE ticket_id = ?', [into_id, req.params.id]);
  run("UPDATE tickets SET merged_into = ?, status = 'Closed', closed_at = datetime('now') WHERE id = ?", [into_id, req.params.id]);
  run('INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, internal) VALUES (?,?,?,?,1)', [
    into_id, `${source.ref} merged into this ticket by ${req.user.name}.`, 'system', req.user.id,
  ]);
  audit(req.user.id, 'ticket_merged', 'ticket', source.id, { into: target.id });
  res.json({ merged: true, into: target.ref });
});

router.post('/:id/csat', (req, res) => {
  /* Same book check as the rest. A satisfaction score is small, but it is the
     desk's own performance record and it was writable across the book by
     anybody signed in. */
  const found = loadInBook(req, 'ticket', req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });

  const score = Number(req.body.score);
  if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: 'CSAT must be 1–5' });
  run('UPDATE tickets SET csat = ? WHERE id = ?', [score, found.row.id]);
  res.json({ ok: true });
});

/* --------------------------------------------------------- maintenance */

/** Auto-close resolved tickets after 72h, then re-run the SLA sweep. */
/**
 * Export the case queue, as filtered.
 *
 * The queue is the record of how the desk performed — first response, breach,
 * CSAT — and it is what gets asked for when somebody outside support wants to
 * see the month. Without this the answer was a screenshot.
 *
 * Masked and audited like every other export here: the queue joins the client's
 * name and mobile in, so it carries identifiers even though a case is not a
 * person.
 */
router.post('/export', requirePermission('export.case'), (req, res) => {
  const chosen = (Array.isArray(req.body?.columns) && req.body.columns.length
    ? req.body.columns.filter((k) => ticketColumn(k))
    : ['ref', 'subject', 'status', 'priority', 'assignee_name', 'created_at', 'resolution_due', 'breached']);
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

  const { clause, params } = ticketFilter(req);
  const rows = all(
    `SELECT t.*, l.name AS lead_name, l.mobile AS lead_mobile, u.name AS assignee_name,
            c.name AS category_name, pt.name AS product_name, p.name AS partner_name
     ${TICKET_FROM}
     WHERE ${clause}
     ORDER BY t.id
     LIMIT ?`,
    [...params, EXPORT_CAP],
  );

  const mask = (key, value) => {
    if (!ticketColumn(key)?.pii || unmasked || !value) return value;
    return `******${String(value).slice(-4)}`;
  };

  const header = chosen.map((k) => csvCell(ticketColumn(k).label)).join(',');
  const body = rows.map((r) => chosen.map((k) => csvCell(mask(k, r[k]))).join(',')).join('\n');

  audit(req.user.id, 'ticket.export', 'ticket', null, {
    rows: rows.length, columns: chosen, unmasked, filters: appliedTicketFilters(req),
  });

  res.json({
    filename: `cases-${new Date().toISOString().slice(0, 10)}.csv`,
    rows: rows.length,
    unmasked,
    truncated: rows.length >= EXPORT_CAP,
    csv: `${header}\n${body}`,
  });
});

router.post('/sweep', (_req, res) => {
  run("UPDATE tickets SET status = 'Closed', closed_at = datetime('now') WHERE status = 'Resolved' AND resolved_at <= datetime('now', '-72 hours')");
  res.json(sweepSla());
});

router.get('/reports/summary', requirePermission('report.team'), (_req, res) => {
  const byCategory = all(`
    SELECT COALESCE(c.name, 'Uncategorised') AS category, COUNT(*) n,
           SUM(CASE WHEN t.breached = 1 THEN 1 ELSE 0 END) breached,
           AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END) avg_hours
    FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id
    GROUP BY category ORDER BY n DESC`);

  const byAgent = all(`
    SELECT u.name AS agent, COUNT(*) n,
           SUM(CASE WHEN t.status NOT IN ('Resolved','Closed') THEN 1 ELSE 0 END) open,
           SUM(CASE WHEN t.breached = 1 THEN 1 ELSE 0 END) breached,
           AVG(t.csat) avg_csat
    FROM tickets t JOIN users u ON u.id = t.assignee_id
    GROUP BY u.id ORDER BY n DESC`);

  res.json({
    totals: {
      open: one("SELECT COUNT(*) n FROM tickets WHERE status NOT IN ('Resolved','Closed')").n,
      breached: one('SELECT COUNT(*) n FROM tickets WHERE breached = 1').n,
      resolved_today: one("SELECT COUNT(*) n FROM tickets WHERE date(resolved_at) = date('now')").n,
      avg_csat: one('SELECT ROUND(AVG(csat), 2) v FROM tickets WHERE csat IS NOT NULL').v,
    },
    by_category: byCategory,
    by_agent: byAgent,
    sla_defaults: DEFAULT_SLA,
  });
});

export default router;
