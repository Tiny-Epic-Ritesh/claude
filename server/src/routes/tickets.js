/**
 * Ticket module — creation, SLA, replies, escalation, merge, CSAT.
 */

import { exportHeldMasked } from '../engine/policies.js';
import { istNow, dmyTime } from '../engine/daterange.js';
import { Router } from 'express';
import { all, one, run, audit, notify, ROLE_LABELS } from '../db.js';
import { can, requireUser, requirePermission, requireAnyPermission, mayUseOrg, activeOrg, orgsFor, reqTicketScope, maskFor, orgScope, userCan } from '../auth.js';
import { maskRecord } from '../security.js';
import { loadInBook } from '../engine/bookscope.js';
import { assertValid } from '../engine/validation.js';
import { recordChange } from '../engine/metadata.js';
import { withCorrections, mayCorrect, addCorrection } from '../engine/corrections.js';
import { applySla, sweepSla, closeResolved, deadlinesFor, repriceSla, handleStatusChange, slaRemaining, businessMinutesBetween, DEFAULT_SLA, breachedSql } from '../engine/sla.js';
import { openCase } from '../engine/cases.js';
import { send } from '../integrations.js';
import * as ai from '../ai/index.js';

const router = Router();
router.use(requireUser);

const STATUSES = ['Open', 'Pending', 'Waiting on Client', 'Resolved', 'Closed'];
/** QA-37: the statuses a case is finished in. Reopening is the way back. */
const DONE = ['Resolved', 'Closed'];
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
    /* A corrected reply is summarised as corrected (QA-37), or the summary
       would keep repeating what its author has since said was wrong. */
    const replies = withCorrections('reply', all('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at', [ticketId]))
      .map(({ corrections, ...r }) => (corrections.length ? { ...r, body: corrections.at(-1).body } : r));
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
/* QA-05. The Cases page's tabs, as the API reads them too, so a link such as
   /tickets?view=breached means the same set to the screen and to the server. */
const VIEW_FILTERS = { mine: { mine: 'true', open: 'true' }, open: { open: 'true' }, breached: { breached: 'true' }, all: {} };

function ticketFilter(req) {
  /* A view supplies its filters; anything the request names as well still
     applies. A resolved window asks about closed cases, which a view's own
     'open' would hide. Read into a copy: Express 5's req.query is read-only. */
  const qs = { ...(VIEW_FILTERS[req.query.view] ?? {}), ...req.query };
  if (req.query.view && (qs.resolved_from || qs.resolved_to) && req.query.open === undefined) delete qs.open;
  const { status, priority, mine, lead_id, category_id } = qs;
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
  else if (qs.open === 'true') where.push("t.status NOT IN ('Resolved','Closed')");

  /* P2-13. The predicates the dashboard tiles count on, so the tile and the
     list are the same set rather than two implementations that agree today. */
  if (qs.breached === 'true') where.push(breachedSql('t'));
  // QA-05: what the Customer Care figures count, so each links to its own set.
  if (qs.due_today === 'true') {
    where.push("t.status NOT IN ('Resolved','Closed') AND date(t.resolution_due, '+330 minutes') = date('now', '+330 minutes')");
  }
  if (qs.rated === 'true') where.push('t.csat IS NOT NULL');
  if (qs.resolved_from) { where.push("date(t.resolved_at, '+330 minutes') >= date(?)"); params.push(qs.resolved_from); }
  if (qs.resolved_to) { where.push("date(t.resolved_at, '+330 minutes') <= date(?)"); params.push(qs.resolved_to); }
  if (qs.created_from) { where.push("date(t.created_at, '+330 minutes') >= date(?)"); params.push(qs.created_from); }
  if (qs.created_to) { where.push("date(t.created_at, '+330 minutes') <= date(?)"); params.push(qs.created_to); }
  if (priority) { where.push('t.priority = ?'); params.push(priority); }
  if (lead_id) { where.push('t.lead_id = ?'); params.push(lead_id); }
  if (category_id) { where.push('t.category_id = ?'); params.push(category_id); }

  /* Find one case among hundreds without paging to it. Bound to what somebody
     would actually search a case by — its reference, its subject, or the person
     it was raised for. */
  const q = String(qs.q ?? '').trim();
  if (q) {
    where.push('(t.ref LIKE ? OR t.subject LIKE ? OR l.name LIKE ? OR l.mobile LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  return { clause: where.join(' AND '), params };
}

/** Which filters are in play, for an audit row. */
const appliedTicketFilters = (req) => Object.fromEntries(
  ['q', 'status', 'priority', 'mine', 'breached', 'open', 'lead_id', 'category_id',
    'created_from', 'created_to', 'resolved_from', 'resolved_to', 'due_today', 'rated']
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
  ).map((t) => maskRecord(decorate(t), maskFor(req, 'ticket_list'))));   // QA-06: lead_mobile
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
  may_export: userCan(req.user, 'export.case'),
  may_unmask: userCan(req.user, 'pii.unmask'),
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
    ...maskRecord(decorate(ticket), maskFor(req, 'ticket', ticket.id)),   // QA-06: lead_mobile
    replies: withCorrections('reply', all('SELECT r.*, u.name AS user_name FROM ticket_replies r LEFT JOIN users u ON u.id = r.user_id WHERE r.ticket_id = ? ORDER BY r.created_at', [req.params.id])),
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

  /* Auto-assignment by category, by current open load (BRD 7.10), within the
     case's own book; the reference and the SLA clock. The same for every door
     a case comes in by, so they are decided in one place -- engine/cases.js,
     after the portal and the AI disposition were found doing neither (QA-03,
     QA-28). */
  if (category_id && !category) return res.status(400).json({ error: 'That category does not exist' });
  // QA-37: a retired category stays on the cases that have it, and goes on no new one.
  if (category && !category.active) return res.status(400).json({ error: `"${category.name}" is retired. Choose another category.`, field: 'category_id' });
  const { id, assignee } = openCase({
    subject, description: description || null, priority, categoryId: category?.id ?? null,
    leadId: lead_id || null, cardId: card_id || null, partnerId: partner_id || null,
    channel, createdBy: req.user.id, org,
  });

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

  /* OPS-38. author_type came from the request, so an agent could record a
     reply as the client's or the system's. Someone signed in to the CRM writes
     as an agent; a client or partner writes through the portal. */
  const { body, internal = false } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Reply body is required' });

  run('INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, internal) VALUES (?,?,?,?,?)', [
    req.params.id, body, 'agent', req.user.id, internal ? 1 : 0,
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

/**
 * Correct a reply: QA-37.
 *
 * A reply is correspondence, so it is never edited after saving. Its author
 * adds a correction linked to it; the original stays, shown as corrected --
 * to the partner too, where the partner could see the original.
 */
router.post('/:id/replies/:replyId/correct', requirePermission('ticket.reply'), async (req, res) => {
  const found = loadInBook(req, 'ticket', req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const reply = one('SELECT * FROM ticket_replies WHERE id = ? AND ticket_id = ?', [req.params.replyId, found.row.id]);
  if (!reply) return res.status(404).json({ error: 'Reply not found' });
  /* Only what an agent wrote. An escalation note carries the escalator's id
     but is the system's record of the escalation, and a client's or a
     partner's words are theirs. */
  if (reply.author_type !== 'agent') {
    return res.status(409).json({ error: `This is a ${reply.author_type} entry, not a reply an agent wrote, so it cannot be corrected. Add a reply instead.` });
  }
  const refused = mayCorrect('reply', reply, req.user);
  if (refused) return res.status(refused.status).json({ error: refused.error });
  const out = addCorrection('reply', reply, req.body ?? {}, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error, field: out.field });
  run("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?", [found.row.id]);
  await refreshSummary(found.row.id);
  return res.status(201).json(out);
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

  if (assignee_id !== undefined && !userCan(req.user, 'ticket.reassign')) {
    return res.status(403).json({ error: 'Reassignment requires Customer Care, a Supervisor or an Admin', required: 'ticket.reassign' });
  }
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of ${STATUSES.join(', ')}` });

  /* QA-37: a case's fields change while it is open. Resolved or closed, the
     way back is to reopen it, and reopening says why -- the client was told it
     was done. A closed case is reopened, never set back to Resolved. */
  const finished = DONE.includes(ticket.status);
  const reopening = finished && Boolean(status) && !DONE.includes(status);
  const reason = String(req.body.reason ?? '').trim();
  if (finished) {
    if (['priority', 'assignee_id', 'category_id'].some((f) => req.body[f] !== undefined)) {
      return res.status(409).json({
        error: `${ticket.ref} is ${ticket.status.toLowerCase()}, so its details cannot change. Reopen it first.`,
        reopen_first: true,
      });
    }
    if (ticket.status === 'Closed' && status === 'Resolved') {
      return res.status(409).json({ error: `${ticket.ref} is closed. Reopen it if there is more to do.` });
    }
    if (reopening && reason.length < 5) {
      return res.status(400).json({ error: 'Say why it is being reopened', field: 'reason' });
    }
  }
  /* QA-37: a retired category is kept by the cases that already carry it, and
     is not given to another one. */
  if (category_id != null && Number(category_id) !== ticket.category_id) {
    const target = one('SELECT name, active FROM ticket_categories WHERE id = ?', [category_id]);
    if (!target) return res.status(400).json({ error: 'That category does not exist', field: 'category_id' });
    if (!target.active) return res.status(400).json({ error: `"${target.name}" is retired. Choose another category.`, field: 'category_id' });
  }

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
    if (reopening) sets.push('resolved_at = NULL', 'closed_at = NULL');
  }
  if (priority) { sets.push('priority = ?'); params.push(priority); }
  if (assignee_id !== undefined) { sets.push('assignee_id = ?'); params.push(assignee_id); }
  if (category_id !== undefined) { sets.push('category_id = ?'); params.push(category_id); }
  if (!sets.length) return res.json(decorate(ticket));

  run(`UPDATE tickets SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...params, req.params.id]);

  /* What changed, recorded like every other field change in the product.
   *
   * Non-negotiable #4 asks for field-change history to be first-class, and a
   * case was the last object without it. It also makes `ticket.changed` a
   * trigger that can exist: without this, the only way to notice a ticket had
   * moved would be `updated_at`, which moves on every reply — and a trigger
   * that fires on every reply is the 8.5-million-execution shape. */
  if (status && status !== ticket.status) {
    recordChange('case', ticket.id, 'status', ticket.status, status, { actorId: req.user.id });
  }
  if (category_id !== undefined && Number(category_id) !== ticket.category_id) {
    recordChange('case', ticket.id, 'category_id', ticket.category_id, category_id, { actorId: req.user.id });
  }

  audit(req.user.id, 'ticket_updated', 'ticket', Number(req.params.id), req.body);
  if (reopening) {
    /* On the case itself, where the next person to open it will look. */
    run('INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, internal) VALUES (?,?,?,?,1)', [
      ticket.id, `Reopened by ${req.user.name} (was ${ticket.status}): ${reason}`, 'system', req.user.id,
    ]);
    audit(req.user.id, 'ticket_reopened', 'ticket', ticket.id, { from: ticket.status, to: status, reason });
  }

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

  /* Part 4, ruled 16 Oct: a new priority redoes the deadlines, from when the
     case was opened. They stayed put, so a Low case raised to Critical kept
     Low's three days. */
  if (priority && priority !== ticket.priority) {
    const before = { response_due: ticket.response_due, resolution_due: ticket.resolution_due };
    const after = repriceSla(ticket.id, priority);
    audit(req.user.id, 'ticket_sla_repriced', 'ticket', ticket.id, { from: ticket.priority, to: priority, before, after });
  }

  await refreshSummary(Number(req.params.id));
  res.json(decorate(one('SELECT * FROM tickets WHERE id = ?', [req.params.id])));
});

/* ------------------------------------------- what an action would do */

/* An escalation raises the priority one step; Critical stays Critical. */
const raised = (p) => ({ Low: 'Medium', Medium: 'High' }[p] ?? 'Critical');

const bookName = (code) => one('SELECT name FROM sales_orgs WHERE code = ?', [code])?.name ?? code;
const person = (u) => (u ? { id: u.id, name: u.name, role: u.role, role_label: ROLE_LABELS[u.role] ?? u.role } : null);

/**
 * Who an escalation goes to: the assignee's manager, when they are active and
 * work in the case's business; otherwise a Sales Supervisor in the case's
 * business; otherwise nobody, and the escalation is refused.
 *
 * OPS-44. With no manager it went to the first active Sales Supervisor in
 * either business, so a Bigul case could land with Bonanza's supervisor -- and
 * a manager who had left was handed cases too.
 */
function escalationTarget(ticket) {
  const assignee = ticket.assignee_id ? one('SELECT * FROM users WHERE id = ?', [ticket.assignee_id]) : null;
  const manager = assignee?.manager_id ? one('SELECT * FROM users WHERE id = ? AND active = 1', [assignee.manager_id]) : null;
  if (manager && mayUseOrg(manager, ticket.sales_org)) return { user: manager, how: 'manager', assignee };
  const supervisor = all("SELECT * FROM users WHERE role = 'sales_supervisor' AND active = 1 AND id != ? ORDER BY id", [ticket.assignee_id ?? -1])
    .find((u) => mayUseOrg(u, ticket.sales_org));
  if (supervisor) return { user: supervisor, how: 'supervisor', assignee };
  return {
    user: null,
    assignee,
    refusal: `Nobody to escalate ${ticket.ref} to: ${assignee ? `${assignee.name} has no manager` : 'it has no assignee and so no manager'} in ${bookName(ticket.sales_org)}, and ${bookName(ticket.sales_org)} has no active Sales Supervisor. An Admin can set a manager in Setup.`,
  };
}

/* The case, loaded within the reader's book and scope -- as the detail is. */
function visibleCase(req) {
  const found = loadInBook(req, 'ticket', req.params.id);
  if (found.error) return found;
  if (!found.row) return { status: 404, error: 'Ticket not found' };
  const scope = reqTicketScope(req, 't');
  const visible = one(`SELECT 1 v FROM tickets t WHERE t.id = ? AND ${scope.sql}`, [found.row.id, ...scope.params]);
  if (!visible) return { status: 403, error: 'This case is outside your visibility scope' };
  return found;
}

/* What resolving or closing does, said the same way by both dialogs. */
function finishEffects(ticket, to) {
  const lead = ticket.lead_id ? one('SELECT name, mobile FROM leads WHERE id = ?', [ticket.lead_id]) : null;
  return [
    to === 'Resolved'
      ? 'Its status becomes Resolved, and the time is recorded as its resolution.'
      : 'Its status becomes Closed.',
    lead?.mobile
      ? `${lead.name} is sent a WhatsApp asking them to rate the help from 1 to 5.`
      : 'No client with a mobile number is linked, so nobody is asked for a rating.',
    ...(to === 'Resolved' ? ['If nobody reopens it, it closes by itself 72 hours after it is resolved.'] : []),
    'Its details stop changing. Reopening it later asks for a reason, which is kept on the case.',
  ];
}

/* What a change of priority does, given the deadlines it would bring. */
function priorityEffects(ticket, next) {
  const out = [{ tone: 'info', text: `Its deadlines are redone under ${next.priority}, counted from when it was opened on ${dmyTime(ticket.created_at)}: a first response by ${dmyTime(next.response_due)} and a resolution by ${dmyTime(next.resolution_due)}.` }];
  if (ticket.breached) {
    out.push({ tone: 'info', text: `It has already breached its SLA${ticket.breached_at ? ` (${dmyTime(ticket.breached_at)})` : ''}. A new priority does not undo that.` });
  } else if (next.past_due && ticket.status !== 'Waiting on Client') {
    out.push({ tone: 'warn', text: 'That resolution time has already passed, so the case is marked breached at once, and its assignee and their manager are told.' });
  }
  return out;
}

/**
 * Before Escalate (Part 4, item 1): who it goes to, every level above, the
 * deadlines at each, and what happens if it stays unresolved. Read-only.
 *
 * There is no separate escalation matrix to read: the chain is the manager
 * hierarchy in Setup, and the times are the case's SLA policy -- the
 * configuration Part 4 says to use.
 */
router.get('/:id/escalation', requirePermission('ticket.escalate'), (req, res) => {
  const found = visibleCase(req);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const ticket = found.row;
  if (DONE.includes(ticket.status)) {
    return res.status(409).json({ error: `${ticket.ref} is ${ticket.status.toLowerCase()}. Reopen it first.`, reopen_first: true });
  }
  const target = escalationTarget(ticket);
  const chain = [{
    level: 1, who: person(target.assignee), priority: ticket.priority,
    resolution_due: ticket.resolution_due, current: true,
  }];
  /* Each further escalation goes one manager up and one priority up. */
  let at = target.user;
  let priority = ticket.priority;
  const seen = new Set([ticket.assignee_id]);
  while (at && !seen.has(at.id) && chain.length < 5) {
    seen.add(at.id);
    priority = raised(priority);
    chain.push({ level: chain.length + 1, who: person(at), priority, resolution_due: deadlinesFor(ticket, priority).resolution_due });
    const up = at.manager_id ? one('SELECT * FROM users WHERE id = ? AND active = 1', [at.manager_id]) : null;
    at = up && mayUseOrg(up, ticket.sales_org) ? up : null;
  }
  const next = target.user ? deadlinesFor(ticket, raised(ticket.priority)) : null;
  const above = chain[2]?.who ?? null;
  res.json({
    ref: ticket.ref,
    business: bookName(ticket.sales_org),
    to: person(target.user),
    how: target.how ?? null,
    refusal: target.refusal ?? null,
    priority: { from: ticket.priority, to: raised(ticket.priority) },
    next,
    chain,
    effects: target.user ? [
      `The case moves to ${target.user.name}${target.how === 'manager' ? `, ${target.assignee?.name ?? 'the assignee'}'s manager` : `, a Sales Supervisor in ${bookName(ticket.sales_org)} (${target.assignee?.name ?? 'the case'} has no manager there)`}, who is notified.`,
      ticket.priority === 'Critical'
        ? 'Its priority stays Critical, the highest.'
        : `Its priority goes from ${ticket.priority} to ${raised(ticket.priority)}.`,
      'An internal note records who escalated it and why. The client is not told.',
    ] : [],
    sla: next && raised(ticket.priority) !== ticket.priority ? priorityEffects(ticket, next) : [],
    if_unresolved: target.user ? [
      next ? `If it is not resolved by ${dmyTime(next.resolution_due)}, it is marked breached within a minute, and ${target.user.name}${above ? ` and ${above.name} are` : ' is'} told.` : null,
      above ? `Escalating it again moves it to ${above.name} (${above.role_label}) at ${chain[2].priority}.` : 'There is nobody above them in the hierarchy to escalate to after this.',
    ].filter(Boolean) : [],
  });
});

/**
 * Before Mark resolved (Part 4, item 1): what the case has been through, what
 * to check first, and what resolving does. Read-only.
 */
router.get('/:id/resolution-check', requirePermission('ticket.reply'), (req, res) => {
  const found = visibleCase(req);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const ticket = found.row;
  const replies = all('SELECT author_type, internal, created_at, body FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at, id', [ticket.id]);
  const count = (fn) => replies.filter(fn).length;
  const publicReplies = replies.filter((r) => r.author_type === 'agent' && !r.internal);
  const lastAgent = publicReplies.at(-1) ?? null;
  const lastClient = replies.filter((r) => r.author_type === 'client' || r.author_type === 'partner').at(-1) ?? null;
  const tasks = all("SELECT id, title, due_at FROM tasks WHERE ticket_id = ? AND status NOT IN ('Done', 'Completed', 'Cancelled') ORDER BY due_at", [ticket.id]);

  const checks = [];
  if (!publicReplies.length) {
    checks.push({ tone: 'warn', text: 'Nobody has replied to the client on this case. Reply first, so they know what was done.' });
  } else if (lastClient && lastClient.created_at > lastAgent.created_at) {
    checks.push({ tone: 'warn', text: `The client's last message, on ${dmyTime(lastClient.created_at)}, has no reply after it.` });
  }
  if (ticket.status === 'Waiting on Client') {
    checks.push({ tone: 'warn', text: 'The case is waiting on the client. Resolve it only if they have answered, or no longer need anything.' });
  }
  if (tasks.length) {
    checks.push({ tone: 'warn', text: `${tasks.length} open task${tasks.length === 1 ? '' : 's'} on this case: ${tasks.map((t) => t.title).join('; ')}. They stay open after it is resolved.` });
  }
  if (ticket.breached) {
    checks.push({ tone: 'info', text: `It breached its SLA${ticket.breached_at ? ` on ${dmyTime(ticket.breached_at)}` : ''}. Resolving it does not undo that.` });
  }
  if (!checks.length) checks.push({ tone: 'ok', text: 'Nothing outstanding: the client has had the last word from you, and no task is open on the case.' });

  res.json({
    ref: ticket.ref,
    status: ticket.status,
    summary: {
      opened: ticket.created_at,
      channel: ticket.channel,
      priority: ticket.priority,
      ai_summary: ticket.ai_summary ?? null,
      client_messages: count((r) => r.author_type === 'client' || r.author_type === 'partner'),
      replies: publicReplies.length,
      internal_notes: count((r) => r.author_type === 'agent' && r.internal),
      events: count((r) => r.author_type === 'system'),
      last_client: lastClient ? { at: lastClient.created_at, excerpt: String(lastClient.body ?? '').slice(0, 160) } : null,
      last_reply_at: lastAgent?.created_at ?? null,
    },
    checks,
    effects: finishEffects(ticket, 'Resolved'),
  });
});

/**
 * Before a Manage change is saved (Part 4, item 3): the changes, what each
 * does, and what to check first. Read-only; the save is the PATCH above.
 */
router.get('/:id/change-preview', (req, res) => {
  const found = visibleCase(req);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const ticket = found.row;
  const { status, priority } = req.query;
  const assigneeId = req.query.assignee_id === undefined ? undefined : (Number(req.query.assignee_id) || null);

  if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of ${STATUSES.join(', ')}` });
  if (priority !== undefined && !PRIORITIES.includes(priority)) return res.status(400).json({ error: `Priority must be one of ${PRIORITIES.join(', ')}` });
  if (assigneeId !== undefined && !userCan(req.user, 'ticket.reassign')) {
    return res.status(403).json({ error: 'Reassignment requires Customer Care, a Supervisor or an Admin', required: 'ticket.reassign' });
  }

  const changes = [];
  const effects = [];
  const checks = [];
  const name = (id) => (id ? one('SELECT name FROM users WHERE id = ?', [id])?.name ?? `#${id}` : 'Unassigned');

  if (status !== undefined && status !== ticket.status) {
    changes.push({ field: 'status', label: 'Status', from: ticket.status, to: status });
    if (status === 'Waiting on Client') {
      effects.push({ tone: 'info', text: 'The SLA clock pauses. When the case moves on, its deadlines move out by the business time it spent waiting.' });
      checks.push('Send the client your question first, as a reply with Internal note unticked, so they know what you are waiting for.');
    } else if (ticket.status === 'Waiting on Client') {
      const waited = ticket.sla_paused_at ? businessMinutesBetween(new Date(`${ticket.sla_paused_at.replace(' ', 'T')}Z`), new Date()) : 0;
      effects.push({ tone: 'info', text: `The SLA clock restarts, and the deadlines move out by the business time spent waiting -- about ${Math.round(waited / 60)} h so far.` });
    } else if (status === 'Resolved' || status === 'Closed') {
      effects.push(...finishEffects(ticket, status).map((text) => ({ tone: 'info', text })));
      checks.push('Make sure the client has had a reply saying what was done.');
    } else {
      effects.push({ tone: 'info', text: 'The SLA clock keeps running.' });
    }
  }
  if (priority !== undefined && priority !== ticket.priority) {
    changes.push({ field: 'priority', label: 'Priority', from: ticket.priority, to: priority });
    effects.push(...priorityEffects(ticket, deadlinesFor(ticket, priority)));
    checks.push('Say why in an internal note. The client is not told of a change of priority.');
  }
  if (assigneeId !== undefined && assigneeId !== (ticket.assignee_id ?? null)) {
    changes.push({ field: 'assignee_id', label: 'Assignee', from: name(ticket.assignee_id), to: name(assigneeId) });
    effects.push(assigneeId
      ? { tone: 'info', text: `${name(assigneeId)} is notified, and the case moves to their queue.` }
      : { tone: 'warn', text: 'Nobody holds the case: no assignee is told of a breach until somebody takes it.' });
    if (assigneeId) checks.push(`Leave an internal note with what ${name(assigneeId)} needs to know.`);
  }
  res.json({ ref: ticket.ref, changes, effects, checks });
});

router.post('/:id/escalate', requirePermission('ticket.escalate'), (req, res) => {
  /* Escalating answered with the name of the person it went to, so this both
     wrote to the other book and named one of its staff. */
  const found = loadInBook(req, 'ticket', req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const ticket = found.row;
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  // QA-37: escalating moves the owner and the priority, which are details.
  if (DONE.includes(ticket.status)) {
    return res.status(409).json({ error: `${ticket.ref} is ${ticket.status.toLowerCase()}. Reopen it first.`, reopen_first: true });
  }

  const target = escalationTarget(ticket);
  if (!target.user) return res.status(400).json({ error: target.refusal });
  const manager = target.user;
  const priority = raised(ticket.priority);

  run('UPDATE tickets SET assignee_id = ?, priority = ?, updated_at = datetime(\'now\') WHERE id = ?',
    [manager.id, priority, req.params.id]);
  run('INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, internal) VALUES (?,?,?,?,1)', [
    req.params.id, `Escalated by ${req.user.name}. ${req.body.reason || ''}`, 'system', req.user.id,
  ]);
  // Part 4, ruled 16 Oct: the raised priority's deadlines, from when the case was opened.
  const sla = priority !== ticket.priority ? repriceSla(ticket.id, priority) : null;
  notify(manager.id, `Escalated — ${ticket.ref}`, ticket.subject, `/tickets/${ticket.id}`);
  audit(req.user.id, 'ticket_escalated', 'ticket', Number(req.params.id), { to: manager.id, how: target.how, priority, sla });
  const now = one('SELECT resolution_due, breached FROM tickets WHERE id = ?', [ticket.id]);
  /* QA-07: everything the confirmation promised, as it turned out. */
  res.json({
    escalated_to: manager.name,
    how: target.how,
    priority,
    resolution_due: now.resolution_due,
    breached: Boolean(now.breached),
  });
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
  const mayUnmask = userCan(req.user, 'pii.unmask');
  if (wantsClear && !mayUnmask) {
    return res.status(403).json({
      error: 'Exporting identifiers in the clear needs the unmask permission',
      required: 'pii.unmask',
    });
  }
  /* QA-06. A business policy can hold a role's exports masked, whatever it
     sees on screen (Setup → Business policies). */
  const held = exportHeldMasked(req.user.role);
  if (wantsClear && held) {
    return res.status(403).json({ error: held, policy: `export_pii.${req.user.role}` });
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

/* OPS-29. Any signed-in user could close every case resolved over 72 hours
   ago and run the SLA sweep. It belongs to whoever manages the case queue --
   Customer Care runs it from the Tickets screen -- or administers the SLA.

   OPS-45, and Part 4 item 4. It closed resolved cases and flagged breaches in
   both businesses, whoever pressed it, and the close happened only on a
   press. Both run by themselves every minute now (index.js); the button does
   the same at once, for the business being looked at -- or the reader's
   businesses, when no one is chosen -- and says what it did. */
const sweepBooks = (req) => {
  const active = activeOrg(req);
  return active && mayUseOrg(req.user, active) ? [active] : orgsFor(req.user);
};

router.get('/sweep/preview', requireAnyPermission('ticket.reassign', 'admin.sla'), (req, res) => {
  const books = sweepBooks(req);
  const marks = books.map(() => '?').join(',') || "''";
  const open = all(
    `SELECT status, resolution_due, breached FROM tickets
      WHERE sales_org IN (${marks}) AND status NOT IN ('Resolved', 'Closed') AND merged_into IS NULL`, books,
  );
  const now = new Date();
  res.json({
    businesses: books.map(bookName),
    open: open.length,
    past_due: open.filter((t) => !t.breached && t.status !== 'Waiting on Client' && t.resolution_due
      && new Date(`${t.resolution_due.replace(' ', 'T')}Z`) < now).length,
    to_close: one(
      `SELECT COUNT(*) n FROM tickets WHERE sales_org IN (${marks}) AND status = 'Resolved'
        AND resolved_at <= datetime('now', '-72 hours') AND merged_into IS NULL`, books,
    ).n,
  });
});

router.post('/sweep', requireAnyPermission('ticket.reassign', 'admin.sla'), (req, res) => {
  const books = sweepBooks(req);
  const closed = closeResolved({ books });
  const swept = sweepSla({ books });
  audit(req.user.id, 'sla_sweep_run', 'ticket', null, { books, ...swept, ...closed });
  res.json({ businesses: books.map(bookName), ...swept, ...closed });
});

router.get('/reports/summary', requirePermission('report.team'), (req, res) => {
  /* OPS-28. Counted both businesses' cases -- categories, agents, breaches and
     CSAT -- for anyone with report.team. The reader's books, and the one the
     switcher is narrowed to. */
  const book = orgScope(req.user, 't', activeOrg(req));
  const byCategory = all(`
    SELECT COALESCE(c.name, 'Uncategorised') AS category, COUNT(*) n,
           SUM(CASE WHEN ${breachedSql('t')} THEN 1 ELSE 0 END) breached,
           AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END) avg_hours
    FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id
    WHERE ${book.sql}
    GROUP BY category ORDER BY n DESC`, book.params);

  const byAgent = all(`
    SELECT u.name AS agent, COUNT(*) n,
           SUM(CASE WHEN t.status NOT IN ('Resolved','Closed') THEN 1 ELSE 0 END) open,
           SUM(CASE WHEN ${breachedSql('t')} THEN 1 ELSE 0 END) breached,
           AVG(t.csat) avg_csat
    FROM tickets t JOIN users u ON u.id = t.assignee_id
    WHERE ${book.sql}
    GROUP BY u.id ORDER BY n DESC`, book.params);

  res.json({
    // QA-05: the India day the "Resolved today" figure counts, for its link.
    today: istNow().toISOString().slice(0, 10),
    totals: {
      open: one(`SELECT COUNT(*) n FROM tickets t WHERE status NOT IN ('Resolved','Closed') AND ${book.sql}`, book.params).n,
      breached: one(`SELECT COUNT(*) n FROM tickets t WHERE ${breachedSql('t')} AND ${book.sql}`, book.params).n,
      resolved_today: one(`SELECT COUNT(*) n FROM tickets t WHERE date(resolved_at, '+330 minutes') = date('now', '+330 minutes') AND ${book.sql}`, book.params).n,
      avg_csat: one(`SELECT ROUND(AVG(csat), 2) v FROM tickets t WHERE csat IS NOT NULL AND ${book.sql}`, book.params).v,
    },
    by_category: byCategory,
    by_agent: byAgent,
    sla_defaults: DEFAULT_SLA,
  });
});

export default router;
