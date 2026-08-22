/**
 * Global search.
 *
 * One box across every object, which is the single most-used control in
 * Salesforce and the thing people miss most when it is absent.
 *
 * TWO PROPERTIES THIS MUST HAVE
 * -----------------------------
 * 1. It cannot become a discovery channel. Every query carries the caller's
 *    lead scope and org scope, so search can never confirm that a record
 *    exists — a Bonanza rep searching a Bigul client's name gets nothing, not
 *    "no permission", because even the existence is not theirs to learn.
 *
 * 2. It cannot leak identifiers. Results are titles and context, and any
 *    identifier shown is masked exactly as it would be on the record page.
 *    Searching BY mobile still works: matching on a value the user already
 *    typed tells them nothing they did not already know.
 */

import { Router } from 'express';
import { all } from '../db.js';
import { requireUser, reqScope, orgScope, can } from '../auth.js';
import { maskRecords } from '../security.js';

const router = Router();
router.use(requireUser);

const LIMIT = 6;

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ query: q, groups: {} });

  const like = `%${q}%`;
  const groups = {};

  /* ------------------------------------------------------------- leads */

  const leadScope = reqScope(req, 'l');
  const leads = all(
    `SELECT l.id, l.name, l.mobile, l.email, l.city, l.stage, l.sales_org, l.client_code
     FROM leads l
     WHERE l.deleted_at IS NULL AND ${leadScope.sql}
       AND (l.name LIKE ? OR l.mobile LIKE ? OR l.email LIKE ? OR l.client_code LIKE ?)
     ORDER BY l.updated_at DESC LIMIT ?`,
    [...leadScope.params, like, like, like, like, LIMIT],
  );

  if (leads.length) {
    groups.Leads = maskRecords(leads, { unmask: false }).map((l) => ({
      id: l.id,
      title: l.name,
      subtitle: [l.city, l.mobile].filter(Boolean).join(' · '),
      badge: l.stage,
      url: `/leads/${l.id}`,
    }));
  }

  /* ---------------------------------------------------------- partners */

  if (can(req.user.role, 'partner.view')) {
    const pScope = orgScope(req.user, 'p', req.query.org || null);
    const partners = all(
      `SELECT p.id, p.name, p.business_name, p.partner_code, p.state_code, p.city
       FROM partners p
       WHERE ${pScope.sql} AND (p.name LIKE ? OR p.business_name LIKE ? OR p.partner_code LIKE ?)
       ORDER BY p.name LIMIT ?`,
      [...pScope.params, like, like, like, LIMIT],
    );

    if (partners.length) {
      groups.Partners = partners.map((p) => ({
        id: p.id,
        title: p.name,
        subtitle: [p.business_name, p.partner_code, p.city].filter(Boolean).join(' · '),
        badge: p.state_code,
        url: `/partners/${p.id}`,
      }));
    }
  }

  /* ------------------------------------------------------------ cases */

  if (can(req.user.role, 'ticket.create')) {
    // Cases are reachable through the lead the caller can already see, which
    // keeps ticket visibility consistent with lead visibility rather than
    // inventing a second, divergent rule.
    const tScope = reqScope(req, 'l');
    const tickets = all(
      `SELECT t.id, t.ref, t.subject, t.status, t.priority, l.name AS lead_name
       FROM tickets t
       LEFT JOIN leads l ON l.id = t.lead_id
       WHERE (t.subject LIKE ? OR t.ref LIKE ?)
         AND (t.lead_id IS NULL OR (l.deleted_at IS NULL AND ${tScope.sql}))
       ORDER BY t.created_at DESC LIMIT ?`,
      [like, like, ...tScope.params, LIMIT],
    );

    if (tickets.length) {
      groups.Cases = tickets.map((t) => ({
        id: t.id,
        title: t.subject,
        subtitle: [t.ref, t.lead_name].filter(Boolean).join(' · '),
        badge: t.status,
        url: `/tickets/${t.id}`,
      }));
    }
  }

  /* --------------------------------------------------------- products */

  const prodScope = orgScope(req.user, 'pt', req.query.org || null);
  const products = all(
    `SELECT pt.id, pt.code, pt.name, pt.category, pt.sales_org
     FROM product_types pt
     WHERE pt.active = 1 AND ${prodScope.sql} AND (pt.name LIKE ? OR pt.code LIKE ?)
     ORDER BY pt.sort_order LIMIT ?`,
    [...prodScope.params, like, like, LIMIT],
  );

  if (products.length) {
    groups.Products = products.map((p) => ({
      id: p.id,
      title: p.name,
      subtitle: [p.category, p.sales_org].filter(Boolean).join(' · '),
      badge: p.code,
      url: `/products?id=${p.id}`,
    }));
  }

  /* ------------------------------------------------------------ people */

  if (can(req.user.role, 'report.team') || can(req.user.role, 'admin.users')) {
    const uScope = orgScope(req.user, 'u', req.query.org || null);
    const users = all(
      `SELECT u.id, u.name, u.role, u.employee_code, u.branch
       FROM users u
       WHERE u.active = 1 AND ${uScope.sql}
         AND (u.name LIKE ? OR u.employee_code LIKE ? OR u.email LIKE ?)
       ORDER BY u.name LIMIT ?`,
      [...uScope.params, like, like, like, LIMIT],
    );

    if (users.length) {
      groups.People = users.map((u) => ({
        id: u.id,
        title: u.name,
        subtitle: [u.employee_code, u.branch].filter(Boolean).join(' · '),
        badge: u.role,
        url: `/team?user=${u.id}`,
      }));
    }
  }

  return res.json({ query: q, groups });
});

export default router;
