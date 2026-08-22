/**
 * Partner Portal API — the separate authenticated surface for partners.
 *
 * BRD OD-10 stays intact: partners are entities in the CRM and never CRM users.
 * Everything here is scoped to req.partner, so a partner can only ever read or
 * write their own records.
 */

import { Router } from 'express';
import { all, one, run, audit, notify } from '../db.js';
import { requirePartner } from '../auth.js';
import { applySla } from '../engine/sla.js';
import { generateCards } from './crm.js';
import { kycStatusSql } from '../engine/kycstatus.js';

const router = Router();
router.use(requirePartner);

const month = () => new Date().toISOString().slice(0, 7);

/* ----------------------------------------------------------- dashboard */

router.get('/dashboard', (req, res) => {
  const id = req.partner.id;

  const sourced = all(
    `SELECT l.id, l.name, l.stage, l.city, l.created_at, ${kycStatusSql('l')} AS kyc_status,
            (SELECT GROUP_CONCAT(pt.code || ':' || pc.state)
             FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
             WHERE pc.lead_id = l.id AND pc.state != 'INACTIVE') AS cards,
            (SELECT COALESCE(SUM(value),0) FROM product_cards WHERE lead_id = l.id AND state = 'ACTIVE') AS aum
     FROM leads l WHERE l.partner_id = ? AND l.deleted_at IS NULL ORDER BY l.created_at DESC`,
    [id],
  );

  const converted = sourced.filter((l) => (l.cards || '').includes(':ACTIVE')).length;

  res.json({
    partner: {
      id: req.partner.id, name: req.partner.name, code: req.partner.partner_code,
      model: req.partner.partner_model, state: req.partner.state_code,
      business_name: req.partner.business_name, city: req.partner.city,
      commission_pct: req.partner.commission_pct, onboarded_at: req.partner.onboarded_at,
    },
    metrics: {
      leads_sourced: sourced.length,
      leads_this_month: sourced.filter((l) => String(l.created_at).startsWith(month())).length,
      converted,
      conversion_rate: sourced.length ? Math.round((converted / sourced.length) * 100) : 0,
      aum_attributed: sourced.reduce((s, l) => s + (l.aum || 0), 0),
      commission_month: one('SELECT COALESCE(SUM(payout),0) v FROM commissions WHERE partner_id = ? AND period = ?', [id, month()]).v,
      commission_lifetime: one('SELECT COALESCE(SUM(payout),0) v FROM commissions WHERE partner_id = ?', [id]).v,
      open_tickets: one("SELECT COUNT(*) n FROM tickets WHERE partner_id = ? AND status NOT IN ('Resolved','Closed')", [id]).n,
    },
    sourced_leads: sourced,
    onboarding: all('SELECT code, label, status, completed_at FROM partner_steps WHERE partner_id = ? ORDER BY sort_order', [id]),
    lms: all('SELECT module, status, score, completed_at FROM partner_lms WHERE partner_id = ?', [id]),
    commissions: all('SELECT c.*, pt.name AS product_name FROM commissions c LEFT JOIN product_types pt ON pt.id = c.product_type_id WHERE c.partner_id = ? ORDER BY c.period DESC LIMIT 12', [id]),
    tickets: all('SELECT id, ref, subject, status, priority, ai_summary, created_at FROM tickets WHERE partner_id = ? ORDER BY created_at DESC LIMIT 20', [id]),
    rm: req.partner.owner_id ? one('SELECT name, email, phone FROM users WHERE id = ?', [req.partner.owner_id]) : null,
    // Enough to render a product as a card rather than a line: what it is,
    // what it costs to start, what it is good for. `pitch_points` is already
    // the curated feature list — no need for a second one in the client.
    products: all(`SELECT id, code, name, category, min_investment, lock_in,
                          risk_category, pitch_points, brochure_url
                   FROM product_types WHERE active = 1 ORDER BY sort_order`),
  });
});

/* -------------------------------------------------------- lead referral */

/** A partner refers a lead. It lands in the CRM already attributed to them. */
router.post('/referrals', (req, res) => {
  const { name, mobile, email, city, product_type_id, note } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Client name is required' });
  if (!mobile || !/^[6-9]\d{9}$/.test(String(mobile))) return res.status(400).json({ error: 'A valid 10-digit mobile number is required' });

  const existing = one('SELECT id, partner_id FROM leads WHERE mobile = ? AND deleted_at IS NULL', [mobile]);
  if (existing) {
    return res.status(409).json({
      error: existing.partner_id === req.partner.id
        ? 'You have already referred this client.'
        : 'This client is already registered with Bonanza.',
    });
  }

  // Round-robin to the least-loaded Sales RM.
  const owner = one("SELECT id FROM users WHERE role = 'sales_rm' AND active = 1 ORDER BY (SELECT COUNT(*) FROM leads WHERE owner_id = users.id) LIMIT 1");

  const result = run(
    `INSERT INTO leads (name, mobile, email, city, source, stage, owner_id, partner_id)
     VALUES (?,?,?,?,?,'New',?,?)`,
    [name, mobile, email || null, city || null, `Partner referral — ${req.partner.name}`, owner?.id || null, req.partner.id],
  );
  const leadId = Number(result.lastInsertRowid);
  generateCards(leadId);

  // Mark the referred product as Exploring so the RM sees the intent immediately.
  if (product_type_id) {
    const card = one('SELECT * FROM product_cards WHERE lead_id = ? AND product_type_id = ?', [leadId, product_type_id]);
    if (card) {
      run("UPDATE product_cards SET state = 'EXPLORING', last_state_at = datetime('now') WHERE id = ?", [card.id]);
      run('INSERT INTO card_audit (card_id, from_state, to_state, note) VALUES (?,?,?,?)', [
        card.id, 'INACTIVE', 'EXPLORING', `Product interest flagged by partner ${req.partner.name}`,
      ]);
    }
  }

  run('INSERT INTO activities (partner_id, lead_id, type, direction, subject, body) VALUES (?,?,?,?,?,?)', [
    req.partner.id, leadId, 'Partner Activity', 'inbound', 'Lead referred via Partner Portal', note || null,
  ]);
  if (owner?.id) notify(owner.id, 'New partner referral', `${name} referred by ${req.partner.name}.`, `/leads/${leadId}`);
  if (req.partner.owner_id) notify(req.partner.owner_id, 'Partner sourced a lead', `${req.partner.name} referred ${name}.`, `/partners/${req.partner.id}`);

  audit(null, 'partner_referral', 'lead', leadId, { partner_id: req.partner.id });
  res.status(201).json({ lead_id: leadId, message: 'Referral received. Your RM will pick it up shortly.' });
});

/* ------------------------------------------------------------- tickets */

router.get('/tickets/:id', (req, res) => {
  const ticket = one('SELECT * FROM tickets WHERE id = ? AND partner_id = ?', [req.params.id, req.partner.id]);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  res.json({
    ...ticket,
    replies: all("SELECT body, author_type, created_at FROM ticket_replies WHERE ticket_id = ? AND internal = 0 ORDER BY created_at", [req.params.id]),
  });
});

router.post('/tickets', (req, res) => {
  const { subject, description, priority = 'Medium' } = req.body;
  if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required' });

  const assignee = one("SELECT id FROM users WHERE role = 'customer_care' AND active = 1 ORDER BY (SELECT COUNT(*) FROM tickets WHERE assignee_id = users.id AND status NOT IN ('Resolved','Closed')) LIMIT 1");

  const result = run(
    `INSERT INTO tickets (subject, description, priority, partner_id, channel, assignee_id, status)
     VALUES (?,?,?,?,'Portal',?,'Open')`,
    [subject, description || null, priority, req.partner.id, assignee?.id || null],
  );
  const id = Number(result.lastInsertRowid);
  run('UPDATE tickets SET ref = ? WHERE id = ?', [`BNZ-${String(id).padStart(5, '0')}`, id]);
  applySla(id);

  if (assignee?.id) notify(assignee.id, 'Partner raised a ticket', subject, `/tickets/${id}`);
  res.status(201).json(one('SELECT id, ref, subject, status FROM tickets WHERE id = ?', [id]));
});

router.post('/tickets/:id/replies', (req, res) => {
  const ticket = one('SELECT * FROM tickets WHERE id = ? AND partner_id = ?', [req.params.id, req.partner.id]);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!req.body.body?.trim()) return res.status(400).json({ error: 'Reply cannot be empty' });

  run("INSERT INTO ticket_replies (ticket_id, body, author_type) VALUES (?,?,'partner')", [req.params.id, req.body.body]);

  // A partner reply reopens a resolved ticket (BRD §7.10 re-open logic).
  if (['Resolved', 'Closed'].includes(ticket.status)) {
    run("UPDATE tickets SET status = 'Open', resolved_at = NULL, closed_at = NULL WHERE id = ?", [req.params.id]);
  }
  if (ticket.assignee_id) notify(ticket.assignee_id, `Partner replied — ${ticket.ref}`, req.body.body.slice(0, 120), `/tickets/${ticket.id}`);
  res.status(201).json({ ok: true });
});

/* ---------------------------------------------------------- statements */

router.get('/commissions', (req, res) => {
  res.json(all(
    `SELECT c.*, pt.name AS product_name, l.name AS lead_name
     FROM commissions c
     LEFT JOIN product_types pt ON pt.id = c.product_type_id
     LEFT JOIN leads l ON l.id = c.lead_id
     WHERE c.partner_id = ? ORDER BY c.period DESC, c.id DESC`,
    [req.partner.id],
  ));
});

router.patch('/profile', (req, res) => {
  const fields = ['business_name', 'mobile', 'email', 'city', 'state', 'bank_account', 'bank_ifsc'];
  const sets = [];
  const params = [];
  for (const f of fields) if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  run(`UPDATE partners SET ${sets.join(', ')} WHERE id = ?`, [...params, req.partner.id]);
  audit(null, 'partner_profile_updated', 'partner', req.partner.id, req.body);
  res.json({ ok: true });
});

export default router;
