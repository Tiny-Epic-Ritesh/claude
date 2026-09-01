/**
 * Role cockpits (BRD §4).
 *
 * Every role gets a purpose-built dashboard in three zones:
 *   Zone 1 — Metrics strip     (the numbers that role opens the CRM to see)
 *   Zone 2 — Primary work list (the list they live in)
 *   Zone 3 — Action pane       (their most frequent actions, one click away)
 *
 * The server decides the content of all three zones per role, so the client
 * renders one generic cockpit component rather than eleven bespoke screens.
 */

import { Router } from 'express';
import { all, one, daysSince, ageBand, CARD_COLOUR } from '../db.js';
import { requireUser, leadScope, unmaskRequested, maskFor, activeOrg, orgScope } from '../auth.js';
import { maskRecords } from '../security.js';
import { maskedFieldsFor } from '../engine/masking.js';
import { kycHealth } from '../engine/kyc.js';
import { integrationRegistry } from '../integrations.js';

const router = Router();
router.use(requireUser);

/**
 * One headline figure.
 *
 * `to` is the point of ENH-05: a count that cannot be opened is trivia. Where a
 * metric knows the query behind it, it carries the destination, and the client
 * renders the number as a link to exactly the records it counted.
 *
 * Metrics that genuinely have no list behind them — a percentage, an average —
 * simply omit it and render as plain text. Better an honest number than a link
 * that lands somewhere approximate.
 */
const metric = (label, value, sub, tone, to) => ({
  label, value, sub: sub ?? null, tone: tone ?? null, to: to ?? null,
});
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/* --------------------------------------------------------------- shared */

/**
 * `IN (...)` fragment for the orgs a user may see, narrowed by the switcher.
 *
 * The admin cockpits count straight off the tables rather than going through
 * myLeads(), so without this a Bonanza admin's headline figures would silently
 * include Bigul's book.
 */
function orgFilter(user, active, column = 'sales_org') {
  const scope = orgScope(user, 'x', active);
  return {
    sql: scope.sql.replace(/^x\./, `${column} `).replace(`x.${column}`, column),
    params: scope.params,
  };
}

/** Count with the org filter applied. */
function orgCount(user, active, table, extra = '') {
  const f = orgScope(user, table, active);
  const where = [f.sql.replace(new RegExp(`^${table}\.`), ''), extra].filter(Boolean).join(' AND ');
  return one(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`, f.params).n;
}

function myLeads(user, active = null) {
  // `active` is the sales org the header switcher is narrowed to. Threading it
  // here rather than at each call site means a new cockpit cannot forget it.
  const scope = leadScope(user, 'l', active);
  return all(
    `SELECT l.*,
            (SELECT MAX(created_at) FROM activities a WHERE a.lead_id = l.id AND a.type IN ('Call','WhatsApp','Email','SMS','Meeting')) AS last_contact,
            (SELECT COUNT(*) FROM tickets t WHERE t.lead_id = l.id AND t.status NOT IN ('Resolved','Closed')) AS open_tickets,
            u.name AS owner_name, p.name AS partner_name
     FROM leads l
     LEFT JOIN users u ON u.id = l.owner_id
     LEFT JOIN partners p ON p.id = l.partner_id
     WHERE l.deleted_at IS NULL AND ${scope.sql}
     ORDER BY l.updated_at DESC LIMIT 300`,
    scope.params,
  ).map((l) => {
    const days = daysSince(l.created_at) ?? 0;
    const cards = all(
      `SELECT pc.state, pt.code, pt.name FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
       WHERE pc.lead_id = ? AND pt.active = 1 ORDER BY pt.sort_order`,
      [l.id],
    );
    return {
      ...l,
      age_days: days,
      age_band: ageBand(days),
      days_since_contact: l.last_contact ? daysSince(l.last_contact) : null,
      cards: cards.map((c) => ({ ...c, colour: CARD_COLOUR[c.state] || 'grey' })),
      warm_count: cards.filter((c) => c.state === 'WARM').length,
      exploring_count: cards.filter((c) => c.state === 'EXPLORING').length,
      active_count: cards.filter((c) => c.state === 'ACTIVE').length,
    };
  });
}

const tasksDue = (userId) => all(
  `SELECT t.*, l.name AS lead_name FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id
   WHERE t.assignee_id = ? AND t.status = 'Open' ORDER BY t.due_at LIMIT 50`,
  [userId],
);

const countDueToday = (userId) => one(
  "SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status = 'Open' AND date(due_at) <= date('now')",
  [userId],
).n;

/* ------------------------------------------------------------ cockpits */

const COCKPITS = {

  /* ---- P0: Superadmin ------------------------------------------------ */
  superadmin: (user, active) => ({
    title: 'System cockpit',
    subtitle: 'Platform health, every action, every integration.',
    metrics: [
      metric('Active users', orgCount(user, active, 'users', 'active = 1'), `${all('SELECT DISTINCT role FROM users').length} roles in use`, null, '/admin?tab=users'),
      metric('Total leads', orgCount(user, active, 'leads', 'deleted_at IS NULL'), `${orgCount(user, active, 'leads', 'deleted_at IS NOT NULL')} in recycle bin`, null, '/leads'),
      metric('Product cards', one('SELECT COUNT(*) n FROM product_cards').n, `${one("SELECT COUNT(*) n FROM product_cards WHERE state != 'INACTIVE'").n} engaged`),
      metric('Rules fired today', one("SELECT COUNT(*) n FROM rule_runs WHERE date(created_at) = date('now') AND dry_run = 0").n, `${one('SELECT COUNT(*) n FROM rules WHERE enabled = 1').n} rules enabled`),
      (() => {
        const reg = integrationRegistry();
        const live = reg.filter((i) => i.status === 'live').length;
        return metric('Integrations', `${live}/${reg.length}`, live ? `${live} live, rest simulated` : 'all simulated in this build', live ? 'ok' : 'warn');
      })(),
      metric('Audit events today', one("SELECT COUNT(*) n FROM audit_log WHERE date(created_at) = date('now')").n, null, null, '/admin?tab=audit'),
    ],
    worklist: {
      type: 'audit',
      title: 'System activity log',
      rows: all(`SELECT a.*, u.name AS user_name, u.role AS user_role FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 120`),
    },
    actions: ['Manage users', 'Rule builder', 'Integration health', 'System config', 'Audit export'],
  }),

  /* ---- P0: Admin ----------------------------------------------------- */
  admin: (user, active) => ({
    title: 'Admin cockpit',
    subtitle: 'Configuration, users and system-wide activity.',
    metrics: [
      metric('Leads created today', orgCount(user, active, 'leads', "date(created_at) = date('now')")),
      metric('Calls today', one("SELECT COUNT(*) n FROM activities WHERE type = 'Call' AND date(created_at) = date('now')").n),
      metric('Tickets opened today', orgCount(user, active, 'tickets', "date(created_at) = date('now')"), null, null, '/tickets'),
      metric('SLA breaches', one('SELECT COUNT(*) n FROM tickets WHERE breached = 1').n, 'open + closed', 'danger', '/tickets?breached=1'),
      metric('Active users', orgCount(user, active, 'users', 'active = 1'), null, null, '/admin?tab=users'),
      metric('Products configured', orgCount(user, active, 'product_types', 'active = 1'), null, null, '/admin?tab=products'),
    ],
    worklist: {
      type: 'users',
      title: 'User management',
      rows: (() => {
        // A Bonanza administrator manages Bonanza staff. Listing Bigul's people
        // here would be the same boundary breach as listing their leads.
        const f = orgScope(user, 'u', active);
        return all(
          `SELECT u.id, u.name, u.email, u.role, u.active, u.employee_code, u.branch, u.sales_org,
                  pt.name AS product_name,
                  (SELECT COUNT(*) FROM leads WHERE owner_id = u.id AND deleted_at IS NULL) AS lead_count
           FROM users u LEFT JOIN product_types pt ON pt.id = u.product_type_id
           WHERE ${f.sql}
           ORDER BY u.role, u.name`,
          f.params,
        );
      })(),
    },
    actions: ['Create user', 'Create rule', 'Upload template', 'Configure product', 'KYC journeys', 'View reports'],
  }),

  /* ---- P1: Caller ---------------------------------------------------- */
  caller: (user, active) => {
    const leads = myLeads(user, active);
    const today = new Date().toISOString().slice(0, 10);
    const callsToday = all("SELECT * FROM activities WHERE user_id = ? AND type = 'Call' AND date(created_at) = date('now')", [user.id]);

    // Callbacks due first, then fresh, then ageing — the queue order that matters.
    const queue = [...leads].sort((a, b) => {
      const aCb = a.callback_at ? new Date(a.callback_at).getTime() : Infinity;
      const bCb = b.callback_at ? new Date(b.callback_at).getTime() : Infinity;
      if (aCb !== bCb) return aCb - bCb;
      return a.age_days - b.age_days;
    });

    return {
      title: 'Caller cockpit',
      subtitle: 'Your queue for today, ordered by what needs calling first.',
      metrics: [
        metric('Leads in queue', leads.length, null, null, '/leads'),
        metric('Assigned today', leads.filter((l) => String(l.created_at).startsWith(today)).length),
        metric('Calls made', callsToday.length),
        metric('Connects', callsToday.filter((c) => /connected/i.test(c.outcome || '')).length),
        metric('Callbacks pending', leads.filter((l) => l.callback_at).length, 'due first in the queue', 'warn'),
        metric('Marked Exploring', leads.reduce((s, l) => s + l.exploring_count, 0), null, null, '/leads?card_state=EXPLORING'),
      ],
      worklist: { type: 'leads', title: 'Call queue', rows: queue, columns: ['name', 'mobile', 'stage', 'age_band', 'callback_at', 'source'] },
      actions: ['Call', 'WhatsApp', 'SMS', 'Mark callback', 'Not reachable', 'Mark Exploring', 'Flag for Sales RM', 'Push to autodialler'],
    };
  },

  /* ---- P1: Dealer ---------------------------------------------------- */
  dealer: (user, active) => {
    const leads = myLeads(user, active);
    const sorted = [...leads].sort((a, b) => (b.warm_count - a.warm_count) || (b.exploring_count - a.exploring_count));
    return {
      title: 'Dealer cockpit',
      subtitle: 'Warmest products first — engagement and follow-ups.',
      metrics: [
        metric('Leads assigned', leads.length, null, null, '/leads'),
        metric('Follow-ups due today', countDueToday(user.id), null, 'warn', '/tasks'),
        // ENH-12: 'Warm cards' was ambiguous — it reads as leads at a warm
        // stage, but it counts product interests in the WARM state. Named for
        // what it counts, and it opens exactly those leads.
        metric('Products marked Warm', leads.reduce((s, l) => s + l.warm_count, 0),
          'across your leads — genuine interest confirmed', null, '/leads?card_state=WARM'),
        metric('Products being explored', leads.reduce((s, l) => s + l.exploring_count, 0),
          null, null, '/leads?card_state=EXPLORING'),
        metric('Brochures sent (7d)', one("SELECT COUNT(*) n FROM activities WHERE user_id = ? AND type = 'WhatsApp' AND created_at >= datetime('now','-7 days')", [user.id]).n),
        metric('Products now Active', leads.reduce((s, l) => s + l.active_count, 0),
          null, null, '/leads?card_state=ACTIVE'),
      ],
      worklist: { type: 'leads', title: 'Pipeline by warmth', rows: sorted, columns: ['name', 'mobile', 'cards', 'days_since_contact', 'age_band'] },
      actions: ['Call', 'WhatsApp', 'Send brochure', 'Mark Exploring', 'Mark Warm', 'Schedule follow-up', 'Create ticket', 'Hand to Sales RM'],
    };
  },

  /* ---- P2: Sales RM -------------------------------------------------- */
  sales_rm: (user, active) => {
    const leads = myLeads(user, active);
    const journeys = kycHealth().filter((j) => leads.some((l) => l.id === j.lead_id));
    return {
      title: 'Sales RM cockpit',
      subtitle: 'Your book — product states, ageing and what needs moving.',
      metrics: [
        metric('Leads owned', leads.length, null, null, '/leads'),
        metric('Active (7d contact)', leads.filter((l) => l.days_since_contact !== null && l.days_since_contact <= 7).length),
        metric('Products marked Warm', leads.reduce((s, l) => s + l.warm_count, 0), 'awaiting your next move', null, '/leads?card_state=WARM'),
        metric('KYC in progress', journeys.filter((j) => j.status === 'In Progress').length, null, null, '/kyc'),
        metric('At risk / cold', leads.filter((l) => ['At Risk', 'Cold'].includes(l.age_band)).length, 'ageing bands', 'danger', '/leads?band=Cold'),
        metric('Tasks due today', countDueToday(user.id), null, 'warn', '/tasks'),
      ],
      worklist: { type: 'leads', title: 'My leads', rows: leads, columns: ['name', 'stage', 'cards', 'age_band', 'days_since_contact', 'partner_name'] },
      actions: ['Call', 'WhatsApp', 'Send brochure', 'Mark Exploring / Warm', 'Request Product RM', 'Create task', 'Create ticket', 'Add note'],
    };
  },

  /* ---- P2: Sales Supervisor ------------------------------------------ */
  sales_supervisor: (user, active) => {
    const team = all("SELECT * FROM users WHERE role IN ('sales_rm','caller','dealer') AND active = 1");
    const leads = myLeads(user, active);

    const scorecard = team.map((rm) => {
      const owned = all("SELECT id, created_at FROM leads WHERE owner_id = ? AND deleted_at IS NULL", [rm.id]);
      const warm = one("SELECT COUNT(*) n FROM product_cards pc JOIN leads l ON l.id = pc.lead_id WHERE l.owner_id = ? AND pc.state = 'WARM'", [rm.id]).n;
      const won = one("SELECT COUNT(*) n FROM product_cards pc JOIN leads l ON l.id = pc.lead_id WHERE l.owner_id = ? AND pc.state = 'ACTIVE'", [rm.id]).n;
      return {
        id: rm.id, name: rm.name, role: rm.role,
        leads: owned.length,
        calls_today: one("SELECT COUNT(*) n FROM activities WHERE user_id = ? AND type = 'Call' AND date(created_at) = date('now')", [rm.id]).n,
        warm_cards: warm,
        deals_won: won,
        overdue_tasks: one("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status = 'Open' AND due_at < datetime('now')", [rm.id]).n,
        conversion: owned.length ? Math.round((won / owned.length) * 100) : 0,
      };
    });

    return {
      title: 'Sales Supervisor cockpit',
      subtitle: 'Team pipeline health, ageing and approvals.',
      metrics: [
        metric('Team leads', leads.length),
        metric('At risk + cold', leads.filter((l) => ['At Risk', 'Cold'].includes(l.age_band)).length, 'ageing alert', 'danger'),
        metric('Warm cards', one("SELECT COUNT(*) n FROM product_cards WHERE state = 'WARM'").n),
        metric('Team calls today', one("SELECT COUNT(*) n FROM activities WHERE type = 'Call' AND date(created_at) = date('now')").n),
        metric('Overdue follow-ups', scorecard.reduce((s, r) => s + r.overdue_tasks, 0), null, 'warn'),
        metric('Cards Active', one("SELECT COUNT(*) n FROM product_cards WHERE state = 'ACTIVE'").n),
      ],
      worklist: { type: 'scorecard', title: 'Team performance', rows: scorecard, secondary: { type: 'leads', title: 'All team leads', rows: leads } },
      actions: ['Reassign lead', 'Approve stage change', 'Escalate', 'RM scorecard', 'Export team report'],
    };
  },

  /* ---- P2: Partner RM ------------------------------------------------ */
  partner_rm: (user, active) => {
    const partners = all('SELECT * FROM partners WHERE owner_id = ? ORDER BY created_at DESC', [user.id]).map((p) => ({
      ...p,
      sourced_count: one('SELECT COUNT(*) n FROM leads WHERE partner_id = ? AND deleted_at IS NULL', [p.id]).n,
      sourced_this_month: one("SELECT COUNT(*) n FROM leads WHERE partner_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')", [p.id]).n,
      steps_done: one("SELECT COUNT(*) n FROM partner_steps WHERE partner_id = ? AND status = 'done'", [p.id]).n,
      steps_total: one('SELECT COUNT(*) n FROM partner_steps WHERE partner_id = ?', [p.id]).n,
      last_activity: one('SELECT MAX(created_at) at FROM activities WHERE partner_id = ?', [p.id]).at,
    }));

    return {
      title: 'Partner RM cockpit',
      subtitle: 'Partner pipeline, onboarding progress and sourcing performance.',
      metrics: [
        metric('Prospects in pipeline', partners.filter((p) => ['PROSPECT', 'QUALIFYING'].includes(p.state_code)).length),
        metric('In onboarding', partners.filter((p) => p.state_code === 'ONBOARDING').length),
        metric('Active partners', partners.filter((p) => p.state_code === 'ACTIVE').length),
        metric('Leads sourced this month', partners.reduce((s, p) => s + p.sourced_this_month, 0)),
        metric('Onboarding stalled', partners.filter((p) => p.state_code !== 'ACTIVE' && p.steps_done < p.steps_total && p.steps_done > 0).length, null, 'warn'),
        metric('Tasks due today', countDueToday(user.id)),
      ],
      worklist: { type: 'partners', title: 'Partner pipeline', rows: partners },
      actions: ['Add partner prospect', 'Log partner activity', 'Advance onboarding step', 'Request elevation', 'View partner profile', 'Create ticket'],
    };
  },

  /* ---- P3: Product RM ------------------------------------------------ */
  product_rm: (user, active) => {
    const productId = user.product_type_id;
    const product = productId ? one('SELECT * FROM product_types WHERE id = ?', [productId]) : null;

    const cards = all(`
      SELECT pc.*, l.name AS lead_name, l.created_at AS lead_created, u.name AS sales_rm_name,
             (SELECT j.status FROM kyc_journeys j WHERE j.card_id = pc.id ORDER BY j.created_at DESC LIMIT 1) AS kyc_status,
             (SELECT j.current_step FROM kyc_journeys j WHERE j.card_id = pc.id ORDER BY j.created_at DESC LIMIT 1) AS kyc_step,
             (SELECT MAX(created_at) FROM activities a WHERE a.card_id = pc.id) AS last_card_activity
      FROM product_cards pc
      JOIN leads l ON l.id = pc.lead_id AND l.deleted_at IS NULL
      LEFT JOIN users u ON u.id = l.owner_id
      WHERE pc.product_type_id = ?
      ORDER BY CASE pc.state WHEN 'WARM' THEN 0 WHEN 'PRODUCT_RM_ENGAGED' THEN 1 WHEN 'KYC_IN_PROGRESS' THEN 2 ELSE 3 END, pc.last_state_at DESC`,
      [productId ?? -1],
    ).map((c) => ({
      ...c,
      colour: CARD_COLOUR[c.state] || 'grey',
      age_days: daysSince(c.lead_created) ?? 0,
      age_band: ageBand(daysSince(c.lead_created) ?? 0),
    }));

    const journeys = kycHealth(productId);
    const count = (state) => cards.filter((c) => c.state === state).length;

    return {
      title: `Product RM cockpit${product ? ` — ${product.name}` : ''}`,
      subtitle: 'Read-only intelligence across every lead carrying your product. You are notified, not assigned.',
      read_only: true,
      metrics: [
        metric('Leads with this card', cards.length),
        metric('Untouched (Inactive)', count('INACTIVE'), 'never discussed'),
        metric('At Warm', count('WARM'), 'Sales RM confirmed interest', 'warn'),
        metric('Engaged by you', count('PRODUCT_RM_ENGAGED')),
        metric('KYC in progress', journeys.filter((j) => j.status === 'In Progress').length),
        metric('KYC stalled', journeys.filter((j) => ['Stalled', 'Abandoned'].includes(j.status)).length, 'needs assisted completion', 'danger'),
        metric('Active (won)', count('ACTIVE'), null, 'good'),
        metric('Lost / declined', count('LOST')),
      ],
      worklist: { type: 'cards', title: 'My product across all leads', rows: cards, secondary: { type: 'kyc', title: 'KYC journeys', rows: journeys } },
      actions: ['View lead (read-only)', 'View KYC progress', 'Add internal note', 'Flag concern to Supervisor'],
    };
  },

  /* ---- P3: Product Supervisor ---------------------------------------- */
  product_supervisor: (user, active) => {
    const journeys = kycHealth();
    const team = all("SELECT * FROM users WHERE role = 'product_rm' AND active = 1");

    const scorecard = team.map((rm) => ({
      id: rm.id, name: rm.name,
      product: rm.product_type_id ? one('SELECT name FROM product_types WHERE id = ?', [rm.product_type_id])?.name : '—',
      warm_cards: one("SELECT COUNT(*) n FROM product_cards WHERE product_type_id = ? AND state = 'WARM'", [rm.product_type_id ?? -1]).n,
      kyc_in_progress: journeys.filter((j) => j.product_type_id === rm.product_type_id && j.status === 'In Progress').length,
      stalled: journeys.filter((j) => j.product_type_id === rm.product_type_id && ['Stalled', 'Abandoned'].includes(j.status)).length,
      closed: one("SELECT COUNT(*) n FROM product_cards WHERE product_type_id = ? AND state = 'ACTIVE'", [rm.product_type_id ?? -1]).n,
    }));

    const completed = journeys.filter((j) => j.status === 'Complete' && j.elapsed_s);
    const avgMins = completed.length ? Math.round(completed.reduce((s, j) => s + j.elapsed_s, 0) / completed.length / 60) : 0;

    return {
      title: 'Product Supervisor cockpit',
      subtitle: 'KYC health and product team performance across the book.',
      metrics: [
        metric('Cards total', one('SELECT COUNT(*) n FROM product_cards').n),
        metric('Warm unactioned >4h', one("SELECT COUNT(*) n FROM product_cards WHERE state = 'WARM' AND last_state_at <= datetime('now','-4 hours')").n, null, 'warn'),
        metric('KYC stalled', journeys.filter((j) => j.status === 'Stalled').length, null, 'danger'),
        metric('KYC abandoned', journeys.filter((j) => j.status === 'Abandoned').length, 'assisted completion required', 'danger'),
        metric('Avg KYC completion', avgMins ? `${avgMins} min` : '—', `${completed.length} completed`),
        metric('Cards closed Active', one("SELECT COUNT(*) n FROM product_cards WHERE state = 'ACTIVE'").n, null, 'good'),
      ],
      worklist: { type: 'kyc', title: 'KYC health', rows: journeys, secondary: { type: 'scorecard', title: 'Product RM scorecard', rows: scorecard } },
      actions: ['Reassign product card', 'Override KYC step', 'Escalate stalled KYC', 'Export pipeline report'],
    };
  },

  /* ---- P4: Customer Care --------------------------------------------- */
  customer_care: (user, active) => {
    const queue = all(`
      SELECT t.*, l.name AS lead_name, p.name AS partner_name, c.name AS category_name
      FROM tickets t
      LEFT JOIN leads l ON l.id = t.lead_id
      LEFT JOIN partners p ON p.id = t.partner_id
      LEFT JOIN ticket_categories c ON c.id = t.category_id
      WHERE t.assignee_id = ? AND t.status NOT IN ('Closed') AND t.merged_into IS NULL
      ORDER BY t.breached DESC,
               CASE t.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
               t.resolution_due`,
      [user.id],
    );

    return {
      title: 'Customer Care cockpit',
      subtitle: 'Your ticket queue, breaches first.',
      metrics: [
        metric('Open assigned', queue.filter((t) => t.status !== 'Resolved').length),
        metric('Due today', queue.filter((t) => t.resolution_due && String(t.resolution_due).slice(0, 10) === new Date().toISOString().slice(0, 10)).length, null, 'warn'),
        metric('SLA breached', queue.filter((t) => t.breached).length, 'escalate now', 'danger'),
        metric('Resolved today', one("SELECT COUNT(*) n FROM tickets WHERE assignee_id = ? AND date(resolved_at) = date('now')", [user.id]).n, null, 'good'),
        metric('Waiting on client', queue.filter((t) => t.status === 'Waiting on Client').length),
        metric('CSAT (rolling)', one("SELECT ROUND(AVG(csat),2) v FROM tickets WHERE assignee_id = ? AND csat IS NOT NULL", [user.id]).v ?? '—'),
      ],
      worklist: { type: 'tickets', title: 'Ticket queue', rows: queue },
      actions: ['Open ticket', 'Reply', 'Reassign', 'Escalate', 'Mark resolved', 'Waiting on client', 'Merge', 'Send CSAT'],
    };
  },

  /* ---- P4: Marketing Manager ----------------------------------------- */
  marketing_manager: (user, active) => {
    const bySource = all(`
      SELECT COALESCE(source,'Unknown') AS source, COUNT(*) n,
             SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m','now') THEN 1 ELSE 0 END) this_month
      FROM leads WHERE deleted_at IS NULL GROUP BY source ORDER BY n DESC LIMIT 8`);

    return {
      title: 'Marketing cockpit',
      subtitle: 'Sources, campaigns, lists and content.',
      metrics: [
        metric('Leads this month', one("SELECT COUNT(*) n FROM leads WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").n),
        metric('Top source', bySource[0]?.source ?? '—', bySource[0] ? `${bySource[0].n} leads` : null),
        metric('Campaign sends', one('SELECT COALESCE(SUM(sent),0) v FROM campaigns').v),
        metric('Avg lead score', one('SELECT ROUND(AVG(score),1) v FROM leads WHERE deleted_at IS NULL').v ?? 0),
        metric('Lists', one('SELECT COUNT(*) n FROM lead_lists').n),
        metric('Content expiring 30d', one("SELECT COUNT(*) n FROM content_items WHERE expiry_date IS NOT NULL AND date(expiry_date) <= date('now','+30 days') AND status = 'approved'").n, null, 'warn'),
      ],
      worklist: {
        type: 'campaigns',
        title: 'Campaigns & sources',
        rows: all(`SELECT c.*, l.name AS list_name, t.name AS template_name FROM campaigns c
                   LEFT JOIN lead_lists l ON l.id = c.list_id LEFT JOIN templates t ON t.id = c.template_id
                   ORDER BY c.created_at DESC`),
        secondary: { type: 'sources', title: 'Lead sources', rows: bySource },
      },
      actions: ['Create list', 'Create campaign', 'Upload content', 'View source report', 'Export analytics'],
    };
  },
};

/* ---------------------------------------------------------------- route */

/**
 * Mask client identifiers in the cockpit payload.
 *
 * The cockpit is assembled from a dozen differently-shaped queries, so masking
 * at each source means one new query is one new leak. Walking the finished
 * payload is the version of this that stays correct as cockpits are added —
 * and this is the first screen every user sees.
 *
 * WHAT IS AND IS NOT MASKED
 * -------------------------
 * Client identifiers are masked. A colleague's work email is not: it is
 * directory information, and masking it turns the admin user-management screen
 * into a list of asterisks that nobody can act on. The distinction is taken
 * from the worklist's own declared `type` rather than guessed from field names,
 * because the cockpit already knows what it is showing.
 */
const CLIENT_BEARING = new Set(['leads', 'cards', 'kyc', 'partners', 'tickets']);

function maskRows(rows, masking) {
  return Array.isArray(rows) ? maskRecords(rows, masking) : rows;
}

/**
 * `masking` carries both the audited unmask decision and the role's own masked
 * field set (ENH-16), threaded together so a caller cannot apply one and forget
 * the other.
 */
function maskWorklist(worklist, masking) {
  if (!worklist) return worklist;
  const out = { ...worklist };
  if (CLIENT_BEARING.has(worklist.type)) out.rows = maskRows(worklist.rows, masking);
  if (worklist.secondary) out.secondary = maskWorklist(worklist.secondary, masking);
  return out;
}

/* ------------------------------------------------------- quick actions */

/**
 * The cockpit's action pane.
 *
 * These used to be bare strings, which the client rendered as `<span>` badges.
 * They looked like buttons, sat under a heading that promised "one click from
 * the work list", and did nothing at all — the space was allocated and never
 * connected.
 *
 * The fix is not to guess in the client what "Mark Warm" should do. It is for
 * the server to say, the same way it already declares tabs, capabilities and
 * disposition effects. Each action now carries where it goes and what kind of
 * thing it is, so the client renders without knowing what any of them mean.
 *
 *   kind: 'go'      a destination that exists — navigate there
 *   kind: 'pick'    needs a record the cockpit does not have. Opens the right
 *                   list, filtered, so the user chooses the target rather than
 *                   the system guessing it
 *   kind: 'soon'    the surface is genuinely not built. Says so on hover
 *                   instead of failing silently — an honest dead end beats a
 *                   button that swallows the click
 *
 * `needs` is a capability. An action a role cannot perform is not rendered,
 * so the pane never offers something the API would refuse.
 */
const ACTION = {
  /* ---- navigation ---- */
  'Manage users': { icon: 'group', kind: 'go', to: '/admin?tab=users', needs: 'admin.users' },
  'Create user': { icon: 'person_add', kind: 'go', to: '/admin?tab=users', needs: 'admin.users' },
  'Rule builder': { icon: 'rule', kind: 'go', to: '/admin?tab=rules', needs: 'admin.rules' },
  'Create rule': { icon: 'rule', kind: 'go', to: '/admin?tab=rules', needs: 'admin.rules' },
  'Integration health': { icon: 'cable', kind: 'go', to: '/admin?tab=integrations', needs: 'admin.system' },
  'System config': { icon: 'settings', kind: 'go', to: '/admin?tab=integrations', needs: 'admin.system' },
  'Audit export': { icon: 'receipt_long', kind: 'go', to: '/admin?tab=audit', needs: 'audit.read' },
  'Upload template': { icon: 'description', kind: 'go', to: '/admin?tab=templates', needs: 'admin.templates' },
  'Configure product': { icon: 'inventory_2', kind: 'go', to: '/admin?tab=products', needs: 'admin.products' },
  'KYC journeys': { icon: 'verified_user', kind: 'go', to: '/kyc', needs: 'kyc.view' },
  'View reports': { icon: 'assessment', kind: 'go', to: '/reports', needs: 'report.team' },
  'Create campaign': { icon: 'campaign', kind: 'go', to: '/admin?tab=campaigns', needs: 'campaign.manage' },
  'Upload content': { icon: 'folder', kind: 'go', to: '/admin?tab=content', needs: 'admin.content' },
  'View source report': { icon: 'insights', kind: 'go', to: '/reports', needs: 'report.team' },
  'Export analytics': { icon: 'download', kind: 'go', to: '/reports', needs: 'report.team' },
  'Export team report': { icon: 'download', kind: 'go', to: '/reports', needs: 'report.team' },
  'RM scorecard': { icon: 'leaderboard', kind: 'go', to: '/reports', needs: 'report.team' },
  'Export pipeline report': { icon: 'download', kind: 'go', to: '/reports', needs: 'report.team' },
  'View partner profile': { icon: 'handshake', kind: 'go', to: '/partners', needs: 'partner.view' },
  'Add partner prospect': { icon: 'person_add', kind: 'go', to: '/partners', needs: 'partner.create' },
  'Open ticket': { icon: 'support_agent', kind: 'go', to: '/tickets', needs: 'ticket.create' },

  /* ---- needs a record the cockpit does not have ---- */
  Call: { icon: 'call', kind: 'pick', to: '/leads', hint: 'Choose who to call', needs: 'lead.contact' },
  WhatsApp: { icon: 'chat', kind: 'pick', to: '/leads', hint: 'Choose who to message', needs: 'lead.contact' },
  SMS: { icon: 'sms', kind: 'pick', to: '/leads', hint: 'Choose who to message', needs: 'lead.contact' },
  'Send brochure': { icon: 'attach_file', kind: 'pick', to: '/leads', hint: 'Choose who to send to', needs: 'lead.contact' },
  'Mark callback': { icon: 'schedule', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'lead.contact' },
  'Not reachable': { icon: 'phone_missed', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'lead.contact' },
  'Mark Exploring': { icon: 'explore', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'card.mark.exploring' },
  'Mark Warm': { icon: 'local_fire_department', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'card.mark.warm' },
  'Mark Exploring / Warm': { icon: 'local_fire_department', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'card.mark.exploring' },
  'Schedule follow-up': { icon: 'event', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'lead.contact' },
  'Create task': { icon: 'add_task', kind: 'go', to: '/tasks' },
  'Create ticket': { icon: 'support_agent', kind: 'pick', to: '/tickets', hint: 'Raise against a lead', needs: 'ticket.create' },
  'Add note': { icon: 'edit_note', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'lead.contact' },
  'Flag for Sales RM': { icon: 'flag', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'lead.contact' },
  'Hand to Sales RM': { icon: 'forward', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'lead.contact' },
  'Request Product RM': { icon: 'support_agent', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'card.request.productrm' },
  'Reassign lead': { icon: 'person_pin', kind: 'pick', to: '/leads', hint: 'Choose the lead', needs: 'lead.reassign' },
  'Approve stage change': { icon: 'approval', kind: 'go', to: '/approvals', needs: 'lead.stage.change' },
  'Push to autodialler': { icon: 'dialpad', kind: 'pick', to: '/leads', hint: 'Select leads to push', needs: 'lead.contact' },
  'View lead (read-only)': { icon: 'visibility', kind: 'go', to: '/leads', needs: 'lead.view.all' },
  'View KYC progress': { icon: 'verified_user', kind: 'go', to: '/kyc', needs: 'kyc.view' },
  'Add internal note': { icon: 'edit_note', kind: 'pick', to: '/leads', hint: 'Choose the lead' },
  'Flag concern to Supervisor': { icon: 'flag', kind: 'pick', to: '/leads', hint: 'Choose the lead' },
  'Log partner activity': { icon: 'edit_note', kind: 'pick', to: '/partners', hint: 'Choose the partner', needs: 'partner.view' },
  'Advance onboarding step': { icon: 'trending_flat', kind: 'pick', to: '/partners', hint: 'Choose the partner', needs: 'partner.view' },
  'Request elevation': { icon: 'upgrade', kind: 'pick', to: '/partners', hint: 'Choose the partner', needs: 'partner.elevate.request' },
  Reply: { icon: 'reply', kind: 'pick', to: '/tickets', hint: 'Choose the case', needs: 'ticket.reply' },
  Reassign: { icon: 'person_pin', kind: 'pick', to: '/tickets', hint: 'Choose the case', needs: 'ticket.reassign' },
  Escalate: { icon: 'priority_high', kind: 'pick', to: '/tickets', hint: 'Choose the case', needs: 'ticket.escalate' },
  'Mark resolved': { icon: 'task_alt', kind: 'pick', to: '/tickets', hint: 'Choose the case', needs: 'ticket.reply' },
  'Waiting on client': { icon: 'hourglass_empty', kind: 'pick', to: '/tickets', hint: 'Choose the case', needs: 'ticket.reply' },
  Merge: { icon: 'merge', kind: 'pick', to: '/tickets', hint: 'Choose the case', needs: 'ticket.merge' },
  'Send CSAT': { icon: 'sentiment_satisfied', kind: 'pick', to: '/tickets', hint: 'Choose the case', needs: 'ticket.reply' },

  /* ---- honestly not built ---- */
  'Create list': { icon: 'format_list_bulleted', kind: 'soon', label: 'Lead Lists is still in build' },
  'Reassign product card': { icon: 'swap_horiz', kind: 'soon', label: 'Bulk card reassignment is still in build' },
  'Override KYC step': { icon: 'edit', kind: 'pick', to: '/kyc', hint: 'Choose the journey', needs: 'kyc.override' },
  'Escalate stalled KYC': { icon: 'priority_high', kind: 'pick', to: '/kyc', hint: 'Choose the journey', needs: 'kyc.view' },
};

/**
 * Resolve a role's action labels into things the client can actually render.
 *
 * Anything the user's capabilities do not permit is dropped rather than shown
 * disabled — the cockpit is a starting point, not a permissions explainer, and
 * a pane full of things you cannot do is worse than a shorter pane.
 */
export function resolveActions(labels, caps) {
  return labels
    .map((label) => {
      const def = ACTION[label];
      // An unmapped label is a bug in this table, not in the cockpit. Render it
      // as unavailable rather than as a button that does nothing.
      if (!def) return { label, icon: 'help', kind: 'soon', hint: 'Not wired up yet' };
      if (def.needs && !caps.has(def.needs)) return null;
      return { label, icon: def.icon, kind: def.kind, to: def.to ?? null, hint: def.hint ?? def.label ?? null };
    })
    .filter(Boolean);
}

router.get('/', (req, res) => {
  const build = COCKPITS[req.user.role];
  if (!build) return res.status(400).json({ error: `No cockpit configured for role "${req.user.role}"` });

  const cockpit = build(req.user, activeOrg(req));
  const masking = maskFor(req, 'cockpit');

  res.json({
    ...cockpit,
    // Resolved here rather than in each cockpit builder, so every role gets the
    // same treatment and a new action only has to be declared once.
    actions: resolveActions(cockpit.actions ?? [], req.caps ?? new Set()),
    worklist: maskWorklist(cockpit.worklist, masking),
    role: req.user.role,
    user: { id: req.user.id, name: req.user.name },
    tasks: tasksDue(req.user.id),
    notifications: all('SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT 20', [req.user.id]),
  });
});

export default router;
