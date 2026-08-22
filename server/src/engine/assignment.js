/**
 * Lead assignment — who picks up an incoming enquiry, and how fast.
 *
 * WHY THIS IS SYNCHRONOUS
 * -----------------------
 * The general automation engine runs as a sweep every few minutes. That is fine
 * for "chase leads that went quiet", and wrong for routing: speed to first
 * contact is the strongest single predictor of conversion on an inbound
 * enquiry, and a lead sitting unowned is a prospect sitting unanswered. So
 * routing runs inline, at the moment the lead is created, and returns the owner
 * before the request completes.
 *
 * FOUR STRATEGIES
 * ---------------
 *   named         a specific person. Simple, and a single point of failure.
 *   round_robin   rotate through a team, honouring per-member weight.
 *   least_loaded  whoever holds fewest open leads — self-balancing under load.
 *   territory     match on city/state or product, then fall back to the group's
 *                 own strategy to pick the individual.
 *
 * All four resolve through a TEAM, even the named case, because that is what
 * makes "this person is on leave" a membership flag rather than an edit to
 * every rule that mentions them.
 */

import { all, one, run, audit, notify } from '../db.js';
import { evaluate, fromLegacy } from './conditions.js';

/* ------------------------------------------------------------ matching */

/**
 * Routing conditions use the shared condition tree, so `(source is Facebook AND
 * city is Mumbai) OR (source is Google AND score above 50)` is expressible here
 * exactly as it is in a segment or an automation rule.
 *
 * This replaced a local evaluator that ANDed everything with `.every()` and
 * silently ignored the `join` key it was given — which is the same flat-filter
 * limitation the audit blames for the legacy tenant's 4,810 static lists.
 */

/** The lead attributes a routing rule may test. */
export function routingFacts(lead) {
  return {
    source: lead.source,
    city: lead.city,
    state: lead.state,
    language: lead.language,
    sales_org: lead.sales_org,
    stage: lead.stage,
    partner_linked: lead.partner_id ? 1 : 0,
    client_code: lead.client_code,
    email: lead.email,
    mobile: lead.mobile,
    mobile_invalid: lead.mobile_invalid ?? 0,
    marketing_opt_out: lead.marketing_opt_out ?? 0,
    lead_age_days: 0,
    // Counts are zero on a brand-new lead, which is when routing runs.
    activity_count: 0,
    connect_count: 0,
    open_ticket_count: 0,
    active_product_count: 0,
    days_since_contact: 9999,
  };
}

/**
 * Parse stored conditions, accepting both shapes during the migration.
 * A legacy flat array is lifted into a tree rather than rejected, so existing
 * rules keep working while the UI is rebuilt.
 */
export function parseConditions(raw) {
  let parsed = [];
  try { parsed = JSON.parse(raw || '[]'); } catch { return { op: 'AND', children: [] }; }
  return Array.isArray(parsed) ? fromLegacy(parsed) : parsed;
}

/* ---------------------------------------------------------- strategies */

/** Team members currently accepting work, in rotation order. */
const eligible = (teamId) => all(
  `SELECT tm.user_id, tm.weight, u.name
   FROM team_members tm
   JOIN users u ON u.id = tm.user_id
   WHERE tm.team_id = ? AND tm.accepting = 1 AND u.active = 1
   ORDER BY tm.sort_order, tm.user_id`,
  [teamId],
);

/**
 * Round robin, weighted, with the cursor persisted on the team.
 *
 * Keeping the cursor in the database rather than in memory means rotation
 * survives a restart. Otherwise every deploy silently resets the rota to the
 * first person on the list, who quietly ends up with more leads than anyone.
 */
function roundRobin(team) {
  const members = eligible(team.id);
  if (!members.length) return null;

  // Weight 3 means three consecutive slots in the rota.
  const slots = members.flatMap((m) => Array.from({ length: Math.max(1, m.weight) }, () => m.user_id));
  const cursor = team.rr_cursor % slots.length;
  const picked = slots[cursor];

  run('UPDATE teams SET rr_cursor = ? WHERE id = ?', [(cursor + 1) % slots.length, team.id]);
  return picked;
}

/** Fewest open leads wins; ties break on the rota so it stays fair. */
function leastLoaded(team) {
  const members = eligible(team.id);
  if (!members.length) return null;

  const counted = members.map((m) => ({
    ...m,
    open: one(
      `SELECT COUNT(*) n FROM leads
       WHERE owner_id = ? AND deleted_at IS NULL AND stage NOT IN ('Won', 'Lost')`,
      [m.user_id],
    ).n,
  }));

  const min = Math.min(...counted.map((c) => c.open));
  const tied = counted.filter((c) => c.open === min);
  if (tied.length === 1) return tied[0].user_id;

  const cursor = team.rr_cursor % tied.length;
  run('UPDATE teams SET rr_cursor = ? WHERE id = ?', [(cursor + 1) % tied.length, team.id]);
  return tied[cursor].user_id;
}

/** Resolve a team to one person using the team's own strategy. */
export function pickFromTeam(teamId) {
  const team = one('SELECT * FROM teams WHERE id = ? AND active = 1', [teamId]);
  if (!team) return null;

  if (team.strategy === 'least_loaded') return leastLoaded(team);
  if (team.strategy === 'named') return eligible(team.id)[0]?.user_id ?? null;
  return roundRobin(team);
}

/* -------------------------------------------------------------- routing */

/**
 * Decide the owner for a lead.
 *
 * Returns `{ user_id, rule_id, reason }` so the decision is explainable — a
 * sales manager asking "why did this land with him?" gets a real answer rather
 * than a shrug, and the reason is written to the audit log.
 */
export function routeLead(lead) {
  const facts = routingFacts(lead);

  const rules = all(
    `SELECT * FROM assignment_rules
     WHERE enabled = 1 AND sales_org = ?
     ORDER BY priority, id`,
    [lead.sales_org || 'BONANZA'],
  );

  for (const rule of rules) {
    if (!evaluate(parseConditions(rule.conditions), facts)) continue;

    let userId = null;
    let how = rule.strategy;

    if (rule.strategy === 'named' && rule.user_id) {
      const u = one('SELECT id FROM users WHERE id = ? AND active = 1', [rule.user_id]);
      userId = u?.id ?? null;
      if (!userId) how = 'named (inactive, fell through)';
    } else if (rule.strategy === 'territory' || rule.strategy === 'product') {
      // routing_map is { "Mumbai": 4, "Delhi": 7 } — value → team id.
      let map = {};
      try { map = JSON.parse(rule.routing_map || '{}'); } catch { map = {}; }

      const key = rule.strategy === 'territory'
        ? (facts.city ?? facts.state)
        : facts.product_interest;

      const teamId = map[key] ?? map[String(key).toLowerCase()] ?? null;
      if (teamId) {
        userId = pickFromTeam(teamId);
        how = `${rule.strategy}:${key}`;
      }
    } else if (rule.team_id) {
      userId = pickFromTeam(rule.team_id);
    }

    // A matched rule that could not produce a person falls to its own
    // fallback team before we move on — otherwise a team on holiday silently
    // hands the lead to whatever rule happens to sit below it.
    if (!userId && rule.fallback_team_id) {
      userId = pickFromTeam(rule.fallback_team_id);
      how = `${how} → fallback team`;
    }

    if (userId) {
      run(
        "UPDATE assignment_rules SET fire_count = fire_count + 1, last_fired = datetime('now') WHERE id = ?",
        [rule.id],
      );
      return { user_id: userId, rule_id: rule.id, reason: `${rule.name} (${how})` };
    }
  }

  return { user_id: null, rule_id: null, reason: 'No assignment rule matched' };
}

/**
 * Route and assign, inline. Called at lead creation.
 *
 * An unrouted lead is left owned by whoever created it rather than left
 * ownerless — an unowned lead appears on nobody's work list, which is the worst
 * of the available outcomes.
 */
export function assignLead(lead, { fallbackUserId = null } = {}) {
  const decision = routeLead(lead);
  const ownerId = decision.user_id ?? fallbackUserId ?? lead.owner_id ?? null;

  /**
   * Nothing matched and nobody was named — so the lead goes to a queue rather
   * than nowhere.
   *
   * This is the case the polymorphic owner exists for. Before queues the only
   * options were leaving `owner_id` NULL, which puts the lead on no worklist
   * at all until a report finds it weeks later, or parking it on a placeholder
   * human whose book then fills with work that was never theirs.
   */
  if (!ownerId) {
    const queue = one(
      'SELECT * FROM queues WHERE entity = ? AND (sales_org = ? OR sales_org IS NULL) AND active = 1 ORDER BY sales_org IS NULL LIMIT 1',
      ['lead', lead.sales_org],
    );
    if (queue) {
      run(
        "UPDATE leads SET owner_queue_id = ?, owner_id = NULL, assigned_at = datetime('now') WHERE id = ?",
        [queue.id, lead.id],
      );
      run(
        'INSERT INTO activities (lead_id, type, direction, subject, body) VALUES (?,?,?,?,?)',
        [lead.id, 'Assignment', 'system', `Placed in ${queue.name}`,
          `${decision.reason}. Waiting for someone on the desk to take it.`],
      );
      audit(null, 'lead_queued', 'lead', lead.id, { queue: queue.code, reason: decision.reason });
      return { ...decision, assigned: false, queued: queue.code, queue_name: queue.name };
    }
    return { ...decision, assigned: false };
  }

  run(
    // owner_queue_id is cleared in the same statement: a lead owned by both a
    // person and a queue appears on two worklists.
    "UPDATE leads SET owner_id = ?, owner_queue_id = NULL, assigned_at = datetime('now'), assigned_by_rule = ? WHERE id = ?",
    [ownerId, decision.rule_id, lead.id],
  );

  audit(null, 'lead_assigned', 'lead', lead.id, {
    owner_id: ownerId,
    rule_id: decision.rule_id,
    reason: decision.reason,
    source: lead.source,
  });

  run(
    'INSERT INTO activities (lead_id, type, direction, subject, body) VALUES (?,?,?,?,?)',
    [lead.id, 'Assignment', 'system', 'Lead assigned', decision.reason],
  );

  // Tell them now. A routed lead nobody has been told about is the same as an
  // unrouted one.
  notify(
    ownerId,
    'New lead assigned',
    `${lead.name}${lead.source ? ` · from ${lead.source}` : ''}`,
    `/leads/${lead.id}`,
  );

  return { ...decision, user_id: ownerId, assigned: true };
}
