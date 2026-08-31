/**
 * Ticket module — creation, SLA, replies, escalation, merge, CSAT.
 */

import { Router } from 'express';
import { all, one, run, audit, notify } from '../db.js';
import { can, requireUser, requirePermission, mayUseOrg } from '../auth.js';
import { applySla, sweepSla, handleStatusChange, slaRemaining, DEFAULT_SLA } from '../engine/sla.js';
import { send } from '../integrations.js';
import * as ai from '../ai/index.js';

const router = Router();
router.use(requireUser);

const STATUSES = ['Open', 'Pending', 'Waiting on Client', 'Resolved', 'Closed'];
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

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

router.get('/', (req, res) => {
  const { status, priority, mine, breached, lead_id, category_id } = req.query;
  const where = ['t.merged_into IS NULL'];
  const params = [];

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

  res.json(all(
    `SELECT t.*, l.name AS lead_name, l.mobile AS lead_mobile, u.name AS assignee_name,
            c.name AS category_name, pt.name AS product_name, p.name AS partner_name
     FROM tickets t
     LEFT JOIN leads l ON l.id = t.lead_id
     LEFT JOIN partners p ON p.id = t.partner_id
     LEFT JOIN users u ON u.id = t.assignee_id
     LEFT JOIN ticket_categories c ON c.id = t.category_id
     LEFT JOIN product_cards pc ON pc.id = t.card_id
     LEFT JOIN product_types pt ON pt.id = pc.product_type_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.breached DESC, CASE t.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, t.resolution_due
     LIMIT 300`,
    params,
  ).map(decorate));
});

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

  // Auto-assignment by category, round-robin by current open load (BRD §7.10).
  const category = category_id ? one('SELECT * FROM ticket_categories WHERE id = ?', [category_id]) : null;
  const assignee = category?.auto_assign_role
    ? one(
      `SELECT id FROM users WHERE role = ? AND active = 1
       ORDER BY (SELECT COUNT(*) FROM tickets WHERE assignee_id = users.id AND status NOT IN ('Resolved','Closed')) LIMIT 1`,
      [category.auto_assign_role],
    )
    : one("SELECT id FROM users WHERE role = 'customer_care' AND active = 1 ORDER BY (SELECT COUNT(*) FROM tickets WHERE assignee_id = users.id AND status NOT IN ('Resolved','Closed')) LIMIT 1");

  const result = run(
    `INSERT INTO tickets (subject, description, priority, category_id, lead_id, card_id, partner_id, channel, assignee_id, created_by, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,'Open')`,
    [subject, description || null, priority, category_id || null, lead_id || null, card_id || null, partner_id || null,
      channel, assignee?.id || null, req.user.id],
  );
  const id = Number(result.lastInsertRowid);
  run('UPDATE tickets SET ref = ? WHERE id = ?', [`BNZ-${String(id).padStart(5, '0')}`, id]);

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
  const ticket = one('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
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
  const ticket = one('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const { status, priority, assignee_id, category_id } = req.body;

  if (assignee_id !== undefined && !can(req.user.role, 'ticket.reassign')) {
    return res.status(403).json({ error: 'Reassignment requires Customer Care, a Supervisor or an Admin', required: 'ticket.reassign' });
  }
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of ${STATUSES.join(', ')}` });

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
  const ticket = one('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
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
  const { into_id } = req.body;
  const source = one('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
  const target = one('SELECT * FROM tickets WHERE id = ?', [into_id]);
  if (!source || !target) return res.status(404).json({ error: 'Both tickets must exist' });
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
  const score = Number(req.body.score);
  if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: 'CSAT must be 1–5' });
  run('UPDATE tickets SET csat = ? WHERE id = ?', [score, req.params.id]);
  res.json({ ok: true });
});

/* --------------------------------------------------------- maintenance */

/** Auto-close resolved tickets after 72h, then re-run the SLA sweep. */
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
