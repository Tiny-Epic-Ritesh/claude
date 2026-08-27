/**
 * No-code automation engine (BRD §7.7) and lead scoring (§7.4).
 *
 * A rule is IF <conditions joined by AND/OR> THEN <ordered actions>.
 * Everything is data — Admins compose rules in the UI, no developer involved.
 * Dry-run evaluates and reports without performing any action.
 */

import { all, one, run, notify, audit, daysSince, ageBand } from '../db.js';
import { rebuild } from './metrics.js';
import { send } from '../integrations.js';
import { kycStatusSql, kycStatusFor } from './kycstatus.js';

/* -------------------------------------------------------------- scoring */

/**
 * Scoring moved to engine/metrics.js.
 *
 * This used to be `UPDATE leads SET score = score + ?` on every activity — an
 * incrementing counter that was the only record of its own derivation. Retune a
 * weight and every historical value was silently wrong with no way to recompute
 * it. The audit lists exactly this pattern as a failure mode: the legacy
 * `Activity Score` automation has 8,023,974 lifetime triggers and produces a
 * number nobody can reconstruct.
 *
 * The score is now derived from the timeline. This function survives only as
 * the hook that marks a lead for recomputation, so the many call sites that
 * logged an interaction do not each have to know about metrics.
 */
export function applyScore(leadId) {
  if (!leadId) return 0;
  rebuild(leadId);
  return one('SELECT score FROM lead_metrics WHERE lead_id = ?', [leadId])?.score ?? 0;
}

/* ------------------------------------------------- condition evaluation */

/** Everything a rule can test, resolved for one lead. */
export function leadFacts(leadId) {
  const lead = one('SELECT * FROM leads WHERE id = ?', [leadId]);
  if (!lead) return null;

  const cards = all(
    'SELECT pc.*, pt.code AS product_code, pt.name AS product_name FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id WHERE pc.lead_id = ?',
    [leadId],
  );
  const lastContact = one(
    "SELECT MAX(created_at) AS at FROM activities WHERE lead_id = ? AND type IN ('Call','WhatsApp','Email','SMS','Meeting')",
    [leadId],
  );
  const openTickets = one(
    "SELECT COUNT(*) n FROM tickets WHERE lead_id = ? AND status NOT IN ('Resolved','Closed')",
    [leadId],
  );
  const journey = one(
    "SELECT * FROM kyc_journeys WHERE lead_id = ? AND status IN ('In Progress','Stalled') ORDER BY created_at DESC LIMIT 1",
    [leadId],
  );
  const ageDays = daysSince(lead.created_at) ?? 0;

  return {
    lead_age_days: ageDays,
    age_band: ageBand(ageDays),
    lead_stage: lead.stage,
    lead_score: lead.score,
    lead_source: lead.source,
    kyc_status: kycStatusFor(lead.id),
    kyc_step: journey?.current_step ?? null,
    kyc_journey_status: journey?.status ?? null,
    open_ticket_count: openTickets.n,
    has_open_ticket: openTickets.n > 0,
    days_since_contact: lastContact?.at ? daysSince(lastContact.at) : 999,
    partner_linked: Boolean(lead.partner_id),
    card_states: cards.map((c) => c.state),
    product_card_state: (code) => cards.find((c) => c.product_code === code)?.state ?? 'INACTIVE',
    contact_flag: cards.find((c) => c.contact_flag)?.contact_flag ?? null,
    _lead: lead,
    _cards: cards,
  };
}

const OPS = {
  eq: (a, b) => String(a) === String(b),
  ne: (a, b) => String(a) !== String(b),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  contains: (a, b) => Array.isArray(a) ? a.includes(b) : String(a ?? '').includes(String(b)),
  in: (a, b) => String(b).split(',').map((s) => s.trim()).includes(String(a)),
  is_true: (a) => a === true || a === 1 || a === 'true',
  is_false: (a) => !(a === true || a === 1 || a === 'true'),
};

export const CONDITION_FIELDS = [
  { field: 'lead_age_days', label: 'Lead age (days)', type: 'number' },
  { field: 'age_band', label: 'Age band', type: 'enum', options: ['Fresh', 'Active', 'Ageing', 'At Risk', 'Cold'] },
  { field: 'lead_stage', label: 'Lead stage', type: 'enum', options: ['New', 'Contacted', 'Qualified', 'In Progress', 'Won', 'Lost'] },
  { field: 'lead_score', label: 'Lead score', type: 'number' },
  { field: 'lead_source', label: 'Lead source', type: 'text' },
  { field: 'product_card_state', label: 'Product state', type: 'card' },
  { field: 'contact_flag', label: 'Contact flag', type: 'enum', options: ['Direct Contact', 'No Direct Contact', 'Schedule Joint Call'] },
  { field: 'kyc_status', label: 'KYC status', type: 'enum', options: ['Not Started', 'In Progress', 'Stalled', 'Abandoned', 'Complete'] },
  { field: 'kyc_journey_status', label: 'KYC journey status', type: 'enum', options: ['In Progress', 'Stalled', 'Abandoned', 'Complete'] },
  { field: 'kyc_step', label: 'KYC step', type: 'text' },
  { field: 'has_open_ticket', label: 'Has open ticket', type: 'bool' },
  { field: 'open_ticket_count', label: 'Open ticket count', type: 'number' },
  { field: 'days_since_contact', label: 'Days since last contact', type: 'number' },
  { field: 'partner_linked', label: 'Sourced by a partner', type: 'bool' },
];

export const ACTION_TYPES = [
  { type: 'whatsapp', label: 'Send WhatsApp', params: ['template_id'] },
  { type: 'sms', label: 'Send SMS', params: ['template_id'] },
  { type: 'email', label: 'Send Email', params: ['template_id'] },
  { type: 'ivr', label: 'Trigger IVR call', params: ['script'] },
  { type: 'task', label: 'Create task', params: ['title', 'assignee', 'due_in_hours'] },
  { type: 'notify', label: 'CRM notification', params: ['role_or_user', 'message'] },
  { type: 'update_lead', label: 'Update lead field', params: ['field', 'value'] },
  { type: 'update_card', label: 'Update product card state', params: ['product_code', 'state'] },
  { type: 'assign_queue', label: 'Assign to role queue', params: ['role'] },
];

export function evaluate(conditions, facts) {
  if (!conditions?.length) return false;

  let result = null;
  for (const c of conditions) {
    const raw = c.field === 'product_card_state'
      ? facts.product_card_state(c.product_code)
      : facts[c.field];

    const op = OPS[c.op] || OPS.eq;
    const outcome = op(raw, c.value);

    if (result === null) result = outcome;
    else if ((c.join || 'AND').toUpperCase() === 'OR') result = result || outcome;
    else result = result && outcome;
  }
  return Boolean(result);
}

/* --------------------------------------------------------------- actions */

function runAction(action, facts, { dryRun }) {
  const lead = facts._lead;
  const describe = { action: action.type, params: action.params };

  if (dryRun) return { ...describe, simulated: true };

  switch (action.type) {
    case 'whatsapp':
    case 'sms':
    case 'email': {
      const template = action.params.template_id ? one('SELECT * FROM templates WHERE id = ?', [action.params.template_id]) : null;
      const body = (template?.body || action.params.message || '').replace(/\{\{name\}\}/g, lead.name);
      send(action.type, { to: lead.mobile || lead.email, body, subject: template?.subject, leadId: lead.id });
      break;
    }
    case 'ivr':
      send('ivr', { to: lead.mobile, body: action.params.script, leadId: lead.id });
      break;
    case 'task':
      run('INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, priority) VALUES (?,?,?,NULL,datetime(\'now\', ?),?)', [
        action.params.title || 'Automated follow-up',
        lead.id,
        action.params.assignee === 'owner' ? lead.owner_id : (Number(action.params.assignee) || lead.owner_id),
        `+${Number(action.params.due_in_hours) || 4} hours`,
        action.params.priority || 'Normal',
      ]);
      break;
    case 'notify': {
      const targets = /^\d+$/.test(String(action.params.role_or_user))
        ? [{ id: Number(action.params.role_or_user) }]
        : all('SELECT id FROM users WHERE role = ? AND active = 1', [action.params.role_or_user]);
      for (const t of targets) notify(t.id, 'Automation', action.params.message || 'Rule fired', `/leads/${lead.id}`);
      break;
    }
    case 'update_lead':
      // `kyc_status` is derived from the journeys — an automation that wrote it
      // would be overwritten on the next read, which is worse than refusing.
      if (['stage', 'score', 'risk_profile'].includes(action.params.field)) {
        run(`UPDATE leads SET ${action.params.field} = ? WHERE id = ?`, [action.params.value, lead.id]);
      }
      break;
    case 'update_card': {
      const card = facts._cards.find((c) => c.product_code === action.params.product_code);
      if (card) {
        run("UPDATE product_cards SET state = ?, last_state_at = datetime('now') WHERE id = ?", [action.params.state, card.id]);
        run('INSERT INTO card_audit (card_id, from_state, to_state, note) VALUES (?,?,?,?)', [
          card.id, card.state, action.params.state, 'Set by automation rule',
        ]);
      }
      break;
    }
    case 'assign_queue': {
      const candidate = one(
        'SELECT id FROM users WHERE role = ? AND active = 1 ORDER BY (SELECT COUNT(*) FROM leads WHERE owner_id = users.id) LIMIT 1',
        [action.params.role],
      );
      if (candidate) run('UPDATE leads SET owner_id = ? WHERE id = ?', [candidate.id, lead.id]);
      break;
    }
    default:
      return { ...describe, skipped: 'unknown action type' };
  }
  return { ...describe, executed: true };
}

/** Run one rule across every live lead. */
export function runRule(ruleId, { dryRun = false, leadIds = null } = {}) {
  const rule = one('SELECT * FROM rules WHERE id = ?', [ruleId]);
  if (!rule) return { error: 'Rule not found' };

  const conditions = JSON.parse(rule.conditions || '[]');
  const actions = JSON.parse(rule.actions || '[]');

  const targets = leadIds
    ? leadIds.map((id) => ({ id }))
    : all('SELECT id FROM leads WHERE deleted_at IS NULL');

  const matched = [];
  for (const t of targets) {
    const facts = leadFacts(t.id);
    if (!facts || !evaluate(conditions, facts)) continue;

    /**
     * Each action is attempted independently, and a failure is captured rather
     * than thrown.
     *
     * Before this, one action throwing — a dead WhatsApp number, a template
     * that had been deleted — aborted the whole run. Every lead after the
     * failing one was silently skipped, and nothing recorded that it had
     * happened. Non-negotiable 12 asks for a failure queue precisely because
     * automation that fails quietly is worse than automation that does not run.
     */
    const performed = [];
    const failures = [];
    for (const a of actions) {
      try {
        performed.push(runAction(a, facts, { dryRun }));
      } catch (err) {
        const failure = { type: a.type, error: err.message };
        performed.push({ ...failure, failed: true });
        failures.push(failure);

        if (!dryRun) {
          run(
            `INSERT INTO rule_failures (rule_id, lead_id, action_type, error, payload)
             VALUES (?,?,?,?,?)`,
            [ruleId, t.id, a.type, err.message, JSON.stringify(a.params ?? {})],
          );
        }
      }
    }

    matched.push({
      lead_id: t.id, lead_name: facts._lead.name, actions: performed,
      failed: failures.length,
    });

    run('INSERT INTO rule_runs (rule_id, lead_id, dry_run, matched, detail) VALUES (?,?,?,1,?)', [
      ruleId, t.id, dryRun ? 1 : 0, JSON.stringify(performed),
    ]);
  }

  if (!dryRun && matched.length) {
    run("UPDATE rules SET fire_count = fire_count + ?, last_fired = datetime('now') WHERE id = ?", [matched.length, ruleId]);
    audit(null, 'rule_fired', 'rule', ruleId, { matched: matched.length });
  }

  const failed = matched.reduce((n, m) => n + (m.failed ?? 0), 0);
  return {
    rule: rule.name,
    dry_run: dryRun,
    evaluated: targets.length,
    matched_count: matched.length,
    failed,
    matched,
  };
}

/** Fire every enabled rule — called on the server's automation tick. */
export function runEnabledRules() {
  const rules = all('SELECT id FROM rules WHERE enabled = 1 ORDER BY priority');
  return rules.map((r) => runRule(r.id, { dryRun: false }));
}
