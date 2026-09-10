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
import { checkConsent } from './consent.js';
import { isSnapshot } from './leadlists.js';
/* The one place an owner is chosen. An action hands the lead over; it does not
   pick, for the reason set out on the distribute_lead case below. */
import { assignLead } from './assignment.js';

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
    /* Readable as well as writable. A star an automation can set but nothing
       can branch on is a flag nobody can act on. */
    starred: Boolean(lead.starred),
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
  { field: 'starred', label: 'Starred', type: 'bool' },
];

/**
 * Everything an action card can do, in the categories the ticket names.
 *
 * `category` is here rather than in the client because the screen should offer
 * exactly what the engine runs -- the same reason /spec is served rather than
 * hardcoded. `flow_only` marks an action that has no meaning in a flat rule:
 * a rule has no next card to hand a lead to.
 */
export const ACTION_TYPES = [
  /* Messaging */
  { type: 'whatsapp', label: 'Send WhatsApp', category: 'Messaging', params: ['template_id'] },
  { type: 'sms', label: 'Send SMS', category: 'Messaging', params: ['template_id'] },
  { type: 'email', label: 'Send Email', category: 'Messaging', params: ['template_id'] },
  { type: 'opt_in_email', label: 'Send opt-in email', category: 'Messaging', params: ['template_id'] },
  { type: 'ivr', label: 'Trigger IVR call', category: 'Messaging', params: ['script'] },

  /* Lead actions */
  { type: 'update_lead', label: 'Update lead field', category: 'Lead', params: ['field', 'value'] },
  { type: 'update_card', label: 'Update product card state', category: 'Lead', params: ['product_code', 'state'] },
  { type: 'add_activity', label: 'Add an activity', category: 'Lead', params: ['activity_type', 'subject', 'body'] },
  { type: 'add_to_list', label: 'Add lead to a list', category: 'Lead', params: ['list_id'] },
  { type: 'remove_from_list', label: 'Remove lead from a list', category: 'Lead', params: ['list_id'] },
  { type: 'star_lead', label: 'Star the lead', category: 'Lead', params: ['starred'] },

  /* Sales execution */
  { type: 'task', label: 'Create task', category: 'Sales execution', params: ['title', 'assignee', 'due_in_hours'] },
  { type: 'notify', label: 'CRM notification', category: 'Sales execution', params: ['role_or_user', 'message'] },
  { type: 'notify_owner_sms', label: 'Notify the owner by SMS', category: 'Sales execution', params: ['message'] },
  { type: 'assign_queue', label: 'Assign to role queue', category: 'Sales execution', params: ['role'] },
  { type: 'distribute_lead', label: 'Distribute the lead', category: 'Sales execution', params: [] },

  /* Custom */
  { type: 'webhook', label: 'Post to a webhook', category: 'Custom', params: ['endpoint_id'] },
  { type: 'nudge_users', label: 'Nudge users', category: 'Custom', params: ['role_or_users', 'message'] },

  /* Composition -- performed by the flow engine, not here. */
  {
    type: 'sub_automation',
    label: 'Send to a sub-automation',
    category: 'Composition',
    params: ['automation_id'],
    flow_only: true,
  },
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

/* Exported so engine/automation.js performs an action the same way a rule does.
   Two implementations of "send a WhatsApp" would drift, and only one of them
   would be the one with the consent check in it. */
export function runAction(action, facts, { dryRun }) {
  const lead = facts._lead;
  const describe = { action: action.type, params: action.params };

  if (dryRun) return { ...describe, simulated: true };

  switch (action.type) {
    /* Every send from here goes through the consent check first.
     *
     * It did not, and that was the hole consent.js names in its own header:
     * "Hiding a button stops an RM. It does not stop an import, an automation
     * rule, a bulk action or an integration -- which is where volume sends
     * actually come from, and where a DND breach would actually happen." Every
     * route checked. This, the one path that can send to a whole segment
     * unattended, did not.
     *
     * `intent` comes from the card so a KYC reminder is not blocked by a
     * marketing opt-out, and defaults to marketing, which is the safer answer
     * for a card that does not say. */
    case 'whatsapp':
    case 'sms':
    case 'email': {
      const verdict = checkConsent(lead, action.type, action.params.intent === 'service' ? 'service' : 'marketing');
      if (!verdict.allowed) return { ...describe, skipped: verdict.reason, code: verdict.code };

      const template = action.params.template_id ? one('SELECT * FROM templates WHERE id = ?', [action.params.template_id]) : null;
      /* An unconfigured card used to send an empty message to a client and
         report success. There is no version of that which is better than
         refusing and saying which card it was. */
      if (!template && !action.params.message) {
        return { ...describe, skipped: action.params.template_id ? 'that template no longer exists' : 'no template or message on the card' };
      }

      const body = (template?.body || action.params.message).replace(/\{\{name\}\}/g, lead.name);
      send(action.type, { to: lead.mobile || lead.email, body, subject: template?.subject, leadId: lead.id });
      break;
    }

    /* An opt-in email asks somebody who opted out of marketing whether they
     * would like back in, so it is sent as service -- a marketing opt-out is
     * the very state it exists to address. `no_email` still blocks it, and
     * should: somebody who said "stop emailing me" does not get one more email
     * asking whether they meant it. */
    case 'opt_in_email': {
      const verdict = checkConsent(lead, 'email', 'service');
      if (!verdict.allowed) return { ...describe, skipped: verdict.reason, code: verdict.code };

      const template = action.params.template_id ? one('SELECT * FROM templates WHERE id = ?', [action.params.template_id]) : null;
      if (!template && !action.params.message) return { ...describe, skipped: 'no template or message on the card' };
      const body = (template?.body || action.params.message).replace(/\{\{name\}\}/g, lead.name);
      send('email', {
        to: lead.email,
        body,
        subject: template?.subject || 'May we keep in touch?',
        leadId: lead.id,
        templateId: template?.id ?? null,
      });
      break;
    }

    case 'ivr': {
      const verdict = checkConsent(lead, 'ivr', action.params.intent === 'service' ? 'service' : 'marketing');
      if (!verdict.allowed) return { ...describe, skipped: verdict.reason, code: verdict.code };
      if (!action.params.script) return { ...describe, skipped: 'no script on the card' };
      send('ivr', { to: lead.mobile, body: action.params.script, leadId: lead.id });
      break;
    }
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
      if (!action.params.role_or_user) return { ...describe, skipped: 'nobody named on the card' };
      const targets = /^\d+$/.test(String(action.params.role_or_user))
        ? [{ id: Number(action.params.role_or_user) }]
        : all('SELECT id FROM users WHERE role = ? AND active = 1', [action.params.role_or_user]);
      for (const t of targets) notify(t.id, 'Automation', action.params.message || 'Rule fired', `/leads/${lead.id}`);
      break;
    }
    case 'update_lead': {
      // `kyc_status` is derived from the journeys — an automation that wrote it
      // would be overwritten on the next read, which is worse than refusing.
      const WRITABLE = ['stage', 'score', 'risk_profile'];
      if (!WRITABLE.includes(action.params.field)) {
        /* Saying nothing and reporting success is how a card that quietly does
           nothing survives for months. */
        return {
          ...describe,
          skipped: action.params.field
            ? `${action.params.field} is not a field an automation may write. Only ${WRITABLE.join(', ')} are.`
            : 'no field chosen on the card',
        };
      }
      run(`UPDATE leads SET ${action.params.field} = ? WHERE id = ?`, [action.params.value, lead.id]);
      break;
    }
    case 'update_card': {
      if (!action.params.product_code) return { ...describe, skipped: 'no product chosen on the card' };
      const card = facts._cards.find((c) => c.product_code === action.params.product_code);
      if (!card) return { ...describe, skipped: `${lead.name} has no ${action.params.product_code} card` };
      {
        run("UPDATE product_cards SET state = ?, last_state_at = datetime('now') WHERE id = ?", [action.params.state, card.id]);
        run('INSERT INTO card_audit (card_id, from_state, to_state, note) VALUES (?,?,?,?)', [
          card.id, card.state, action.params.state, 'Set by automation rule',
        ]);
      }
      break;
    }
    case 'assign_queue': {
      if (!action.params.role) return { ...describe, skipped: 'no role named on the card' };
      const candidate = one(
        'SELECT id FROM users WHERE role = ? AND active = 1 ORDER BY (SELECT COUNT(*) FROM leads WHERE owner_id = users.id) LIMIT 1',
        [action.params.role],
      );
      if (!candidate) return { ...describe, skipped: `nobody active on the ${action.params.role} desk` };
      run('UPDATE leads SET owner_id = ? WHERE id = ?', [candidate.id, lead.id]);
      break;
    }
    /* One shared timeline, so an automation writes an activity the same way a
       person does -- non-negotiable 1. user_id stays null: nobody logged it. */
    case 'add_activity':
      run(
        'INSERT INTO activities (lead_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,NULL)',
        [
          lead.id,
          action.params.activity_type || 'Note',
          action.params.direction === 'inbound' ? 'inbound' : 'outbound',
          action.params.subject || 'Logged by automation',
          (action.params.body || '').replace(/\{\{name\}\}/g, lead.name),
        ],
      );
      break;

    /* Only a static list has membership to write to.
     *
     * A refreshable or dynamic list is a query -- non-negotiable 10, "segments
     * are live nested queries, not stored membership rows" -- so a row inserted
     * into one survives until the next refresh and then vanishes. Refusing says
     * so; succeeding would be a lie that takes a fortnight to notice. */
    case 'add_to_list':
    case 'remove_from_list': {
      const list = one('SELECT * FROM lead_lists WHERE id = ?', [Number(action.params.list_id)]);
      if (!list) return { ...describe, skipped: 'that list does not exist' };
      if (!isSnapshot(list.kind)) {
        return {
          ...describe,
          skipped: `${list.name} is a ${list.kind} list, which is a live query -- its membership cannot be set by hand`,
        };
      }
      if (list.archived_at) return { ...describe, skipped: `${list.name} is archived` };
      /* The book boundary, the same as everywhere else. */
      if (list.sales_org && lead.sales_org && list.sales_org !== lead.sales_org) {
        return { ...describe, skipped: `${list.name} belongs to another book` };
      }

      if (action.type === 'add_to_list') {
        run('INSERT OR IGNORE INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [list.id, lead.id]);
      } else {
        run('DELETE FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [list.id, lead.id]);
      }
      break;
    }

    /* `starred: false` un-stars, so one card covers both and a flow can clear
       the flag it set earlier in the same run. */
    case 'star_lead': {
      const on = action.params.starred === false || action.params.starred === 'false' ? 0 : 1;
      run(
        "UPDATE leads SET starred = ?, starred_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END WHERE id = ?",
        [on, on, lead.id],
      );
      break;
    }

    /* The owner is a colleague, not the lead, so this send carries no leadId.
     *
     * Passing one would write the SMS onto the lead's timeline as though the
     * client had received it, and the next person to read that timeline would
     * believe they had. The lead gets a notification instead, which is what
     * actually happened. */
    case 'notify_owner_sms': {
      if (!lead.owner_id) return { ...describe, skipped: 'the lead has no owner to notify' };
      const owner = one('SELECT id, name, phone FROM users WHERE id = ? AND active = 1', [lead.owner_id]);
      if (!owner) return { ...describe, skipped: 'the owner is no longer active' };
      if (!owner.phone) return { ...describe, skipped: `${owner.name} has no mobile number on record` };

      const message = (action.params.message || 'An automation needs your attention on {{name}}')
        .replace(/\{\{name\}\}/g, lead.name);
      send('sms', { to: owner.phone, body: message, userId: owner.id });
      notify(owner.id, 'Automation', message, `/leads/${lead.id}`);
      break;
    }

    /* Hand the lead to the assignment engine; never pick an owner here.
     *
     * Salesforce keeps one active assignment rule with its ordering internal to
     * it, precisely so two mechanisms cannot race, and the legacy tenant has
     * three "Lead Updated" automations running on overlapping populations. An
     * automation that chose an owner itself would be the fourth. */
    case 'distribute_lead': {
      const outcome = assignLead(lead);
      /* A lead placed in a queue is distributed, not failed -- the queue is the
         answer when no rule matched, and the desk picks it up from there. */
      if (outcome?.assigned) return { ...describe, executed: true, owner_id: outcome.user_id, reason: outcome.reason };
      if (outcome?.queued) return { ...describe, executed: true, queued: outcome.queued, reason: outcome.reason };
      return { ...describe, skipped: outcome?.reason || 'the assignment engine had nobody to give it to' };
    }

    /* Posts to an endpoint an admin registered, never to a URL typed on a card.
     *
     * The registration is where somebody decides that this destination may hold
     * client data -- a decision that belongs to a named admin for a SEBI-
     * regulated broker, not to whoever last edited the flow. The body carries
     * only the fields the endpoint was registered for; with none named it
     * carries the lead id and the receiver looks the rest up over an
     * authenticated API. */
    case 'webhook': {
      const endpoint = one(
        'SELECT * FROM webhook_endpoint WHERE id = ? AND active = 1',
        [Number(action.params.endpoint_id)],
      );
      if (!endpoint) return { ...describe, skipped: 'no active webhook endpoint with that id' };
      if (endpoint.sales_org && lead.sales_org && endpoint.sales_org !== lead.sales_org) {
        return { ...describe, skipped: `${endpoint.name} belongs to another book` };
      }

      const allowed = JSON.parse(endpoint.fields || '[]');
      const payload = { lead_id: lead.id, event: action.params.event || 'automation' };
      for (const f of allowed) if (lead[f] !== undefined) payload[f] = lead[f];

      const deliveryId = Number(run(
        'INSERT INTO webhook_delivery (endpoint_id, lead_id, payload) VALUES (?,?,?)',
        [endpoint.id, lead.id, JSON.stringify(payload)],
      ).lastInsertRowid);

      /* Queued, then posted by the sweeper. Awaiting a stranger's server inside
         a tick would let one slow endpoint hold up every other automation. */
      return { ...describe, executed: true, delivery_id: deliveryId, queued: true };
    }

    /* Several people at once, each with a link to the lead. `notify` above
       targets one person or one role; this is the "everybody who should look at
       this" version, and it de-duplicates so somebody in two named roles is
       nudged once. */
    case 'nudge_users': {
      const spec = String(action.params.role_or_users || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!spec.length) return { ...describe, skipped: 'nobody named on the card' };

      const ids = new Set();
      for (const item of spec) {
        if (/^\d+$/.test(item)) ids.add(Number(item));
        else for (const u of all('SELECT id FROM users WHERE role = ? AND active = 1', [item])) ids.add(u.id);
      }
      if (!ids.size) return { ...describe, skipped: 'nobody active matched' };

      const message = (action.params.message || 'This lead needs a look').replace(/\{\{name\}\}/g, lead.name);
      for (const id of ids) notify(id, 'Nudge', message, `/leads/${lead.id}`);
      return { ...describe, executed: true, nudged: ids.size };
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
