/**
 * AI service — provider selection plus the context builders that feed it.
 *
 * The context builders are the important part: they decide exactly what the model
 * is allowed to see. Every snapshot is scoped by the caller's role, so the copilot
 * can never answer about a lead the user could not open in the UI.
 */

import { all, one, daysSince, ageBand } from '../db.js';
import { leadScope } from '../auth.js';
import * as mock from './mock.js';
import { withResidency, routeFor, residencyReport, MODE } from './residency.js';
import { kycHealth } from '../engine/kyc.js';
import { withKycStatus } from '../engine/kycstatus.js';

let provider = mock;

if (process.env.ANTHROPIC_API_KEY) {
  try {
    provider = await import('./claude.js');
  } catch (err) {
    console.error('[ai] Claude provider failed to load, staying on the stub:', err.message);
  }
}

console.log(`[ai] provider: ${provider.name}`);

export const providerName = provider.name;
export const isLive = provider.live === true;

/* ------------------------------------------------------ context builders */

export function dispositionContext(leadId, transcript, durationS) {
  const lead = withKycStatus(one('SELECT * FROM leads WHERE id = ?', [leadId]));
  if (!lead) return null;

  return {
    lead,
    owner: lead.owner_id ? one('SELECT name, role FROM users WHERE id = ?', [lead.owner_id]) : null,
    cards: all(
      `SELECT pc.*, pt.code AS product_code, pt.name AS product_name
       FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
       WHERE pc.lead_id = ? AND pt.active = 1 ORDER BY pt.sort_order`,
      [leadId],
    ),
    recent: all('SELECT * FROM activities WHERE lead_id = ? ORDER BY created_at DESC LIMIT 8', [leadId]),
    tickets: all("SELECT * FROM tickets WHERE lead_id = ? AND status NOT IN ('Resolved','Closed')", [leadId]),
    transcript,
    durationS,
  };
}

export function nextActionContext(leadId) {
  const lead = withKycStatus(one('SELECT * FROM leads WHERE id = ?', [leadId]));
  if (!lead) return null;

  const lastContact = one(
    "SELECT MAX(created_at) at FROM activities WHERE lead_id = ? AND type IN ('Call','WhatsApp','Email','SMS','Meeting')",
    [leadId],
  );
  const ageDays = daysSince(lead.created_at) ?? 0;

  const journeys = all(
    `SELECT j.*, pt.name AS product_name, pt.code AS product_code
     FROM kyc_journeys j JOIN product_types pt ON pt.id = j.product_type_id
     WHERE j.lead_id = ? AND j.status != 'Complete'`,
    [leadId],
  ).map((j) => {
    const health = kycHealth(null).find((h) => h.id === j.id);
    return { ...j, current_step_label: health?.current_step_label ?? j.current_step, progress_pct: health?.progress_pct ?? 0, seconds_on_step: health?.seconds_on_step ?? 0 };
  });

  return {
    lead,
    ageDays,
    ageBand: ageBand(ageDays),
    daysSinceContact: lastContact?.at ? daysSince(lastContact.at) : 999,
    cards: all(
      `SELECT pc.*, pt.code AS product_code, pt.name AS product_name
       FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
       WHERE pc.lead_id = ? AND pt.active = 1`,
      [leadId],
    ),
    journeys,
    tickets: all("SELECT * FROM tickets WHERE lead_id = ? AND status NOT IN ('Resolved','Closed')", [leadId]),
    recent: all('SELECT * FROM activities WHERE lead_id = ? ORDER BY created_at DESC LIMIT 6', [leadId]),
  };
}

/** Role-scoped snapshot — the only data the copilot ever sees. */
export function copilotSnapshot(user) {
  const scope = leadScope(user, 'l');

  const leads = all(
    `SELECT l.*,
            COALESCE(lm.score, 0) AS score, COALESCE(lm.aum, 0) AS aum,
            (SELECT MAX(created_at) FROM activities a WHERE a.lead_id = l.id AND a.type IN ('Call','WhatsApp','Email','SMS','Meeting')) AS last_contact
     FROM leads l
     LEFT JOIN lead_metrics lm ON lm.lead_id = l.id
     WHERE l.deleted_at IS NULL AND ${scope.sql}
     ORDER BY COALESCE(lm.score, 0) DESC LIMIT 60`,
    scope.params,
  ).map((l) => {
    const cards = all(
      `SELECT pc.state, pt.code FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
       WHERE pc.lead_id = ? AND pc.state != 'INACTIVE'`,
      [l.id],
    );
    const days = daysSince(l.created_at) ?? 0;
    return {
      ...l,
      age_days: days,
      age_band: ageBand(days),
      days_since_contact: l.last_contact ? daysSince(l.last_contact) : 999,
      card_summary: cards.map((c) => `${c.code}:${c.state}`).join(' ') || 'none active',
    };
  });

  const leadIds = leads.map((l) => l.id);
  const inClause = leadIds.length ? `(${leadIds.map(() => '?').join(',')})` : '(NULL)';

  const cardStates = {};
  for (const row of all(
    `SELECT pc.state, COUNT(*) n FROM product_cards pc WHERE pc.lead_id IN ${inClause} GROUP BY pc.state`,
    leadIds,
  )) {
    if (row.state !== 'INACTIVE') cardStates[row.state] = row.n;
  }

  const pipelineValue = one(
    `SELECT COALESCE(SUM(value),0) v FROM product_cards WHERE lead_id IN ${inClause} AND state = 'ACTIVE'`,
    leadIds,
  ).v;

  const tickets = user.role === 'customer_care'
    ? all("SELECT * FROM tickets WHERE assignee_id = ? AND status NOT IN ('Resolved','Closed') ORDER BY breached DESC, resolution_due", [user.id])
    : all(`SELECT * FROM tickets WHERE lead_id IN ${inClause} AND status NOT IN ('Resolved','Closed')`, leadIds);

  const journeys = kycHealth(user.role === 'product_rm' ? user.product_type_id : null)
    .filter((j) => j.status !== 'Complete')
    .filter((j) => user.role === 'product_rm' || !leadIds.length || j.lead_id === null || leadIds.includes(j.lead_id));

  const tasks = all(
    "SELECT t.*, l.name AS lead_name FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id WHERE t.assignee_id = ? AND t.status = 'Open' ORDER BY t.due_at LIMIT 20",
    [user.id],
  );

  const partners = ['partner_rm', 'admin', 'superadmin', 'sales_supervisor'].includes(user.role)
    ? all(`SELECT p.*, (SELECT COUNT(*) FROM leads WHERE partner_id = p.id) AS sourced_count FROM partners p ${user.role === 'partner_rm' ? 'WHERE p.owner_id = ?' : ''} ORDER BY sourced_count DESC LIMIT 20`,
      user.role === 'partner_rm' ? [user.id] : [])
    : [];

  return {
    role: user.role,
    user_name: user.name,
    generatedAt: new Date().toISOString(),
    leads, cardStates, pipelineValue, tickets, journeys, tasks, partners,
  };
}

export function partnerInsightContext(partnerId) {
  const p = one('SELECT * FROM partners WHERE id = ?', [partnerId]);
  if (!p) return null;

  const month = new Date().toISOString().slice(0, 7);
  return {
    ...p,
    sourced_count: one('SELECT COUNT(*) n FROM leads WHERE partner_id = ?', [partnerId]).n,
    sourced_this_month: one("SELECT COUNT(*) n FROM leads WHERE partner_id = ? AND strftime('%Y-%m', created_at) = ?", [partnerId, month]).n,
    converted_count: one(
      "SELECT COUNT(*) n FROM product_cards pc JOIN leads l ON l.id = pc.lead_id WHERE l.partner_id = ? AND pc.state = 'ACTIVE'",
      [partnerId],
    ).n,
    commission_month: one('SELECT COALESCE(SUM(payout),0) v FROM commissions WHERE partner_id = ? AND period = ?', [partnerId, month]).v,
    steps_done: one("SELECT COUNT(*) n FROM partner_steps WHERE partner_id = ? AND status = 'done'", [partnerId]).n,
    steps_total: one('SELECT COUNT(*) n FROM partner_steps WHERE partner_id = ?', [partnerId]).n,
    lms_done: one("SELECT COUNT(*) n FROM partner_lms WHERE partner_id = ? AND status = 'Completed'", [partnerId]).n,
    lms_total: one('SELECT COUNT(*) n FROM partner_lms WHERE partner_id = ?', [partnerId]).n,
    last_activity: one('SELECT MAX(created_at) at FROM activities WHERE partner_id = ?', [partnerId]).at,
  };
}

/* --------------------------------------------------------- capabilities */

/**
 * Every capability goes through the residency policy in residency.js, which
 * decides whether the payload may leave the country and de-identifies it first
 * when it may. See that module for the classification and the reasoning.
 *
 * `context` tells the de-identifier which real values to substitute. Because
 * those values come from our own database, substitution is exact rather than
 * inferred — the failure mode of NER-based scrubbing does not apply.
 */

const route = (capability, payload, context, fn) =>
  withResidency(capability, { payload, context, call: fn });

export async function disposition(ctx) {
  // PII_RAW: a transcript cannot be reliably de-identified, so it stays in country.
  const { result } = await route('disposition', ctx, {}, (p) => provider.disposition(p));
  return result;
}

export async function ticketSummary(ticket, replies) {
  const lead = ticket.lead_id ? withKycStatus(one('SELECT * FROM leads WHERE id = ?', [ticket.lead_id])) : null;
  const partner = ticket.partner_id ? one('SELECT * FROM partners WHERE id = ?', [ticket.partner_id]) : null;

  const { result } = await route(
    'ticketSummary',
    { ticket, replies },
    { lead, partner },
    (p) => provider.ticketSummary(p.ticket, p.replies),
  );
  return result;
}

export async function nextAction(ctx) {
  const { result } = await route('nextAction', ctx, { lead: ctx.lead }, (p) => provider.nextAction(p));
  return result;
}

export async function kycCoach(j) {
  const { result } = await route('kycCoach', j, {}, (p) => provider.kycCoach(p));
  return result;
}

export async function copilot(input) {
  // The copilot reasons over a whole book, so the de-identifier needs every
  // client and partner in the snapshot — not just one record. Without this the
  // pattern sweep would still catch mobiles and PANs, but names would only be
  // removed by luck.
  const snap = input.snapshot ?? {};
  const { result } = await route(
    'copilot',
    input,
    { leads: snap.leads ?? [], partners: snap.partners ?? [], owner: { name: snap.user_name } },
    (p) => provider.copilot(p),
  );
  return result;
}

export async function partnerInsight(p) {
  const { result } = await route('partnerInsight', p, { partner: p }, (x) => provider.partnerInsight(x));
  return result;
}

/** Exposed to the Admin UI and to auditors. */
export const residency = () => ({
  ...residencyReport(),
  active_provider: provider.name,
  frontier_live: isLive,
  effective_note: isLive
    ? 'A live frontier provider is configured. De-identified payloads are sent to it.'
    : 'No frontier provider is configured, so every call is served locally by the offline provider. '
      + 'De-identification still runs, so the policy is exercised and auditable before you go live.',
});

export { MODE as residencyMode, routeFor };
