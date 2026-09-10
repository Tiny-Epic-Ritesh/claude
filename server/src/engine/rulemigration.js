/**
 * Turning a rule into a flow (P3-16).
 *
 * A rule is a filter — conditions, actions, one pass, forget. A flow is a
 * process a lead is inside. The narrow shape converts mechanically: a rule
 * becomes an automation on a schedule, with the conditions as entry conditions
 * and the actions as a chain of cards. Salesforce ships this as *Migrate to
 * Flow* for the same reason it is here — so the old engine can be switched off
 * on a date rather than by attrition, and so nothing is hand-retyped.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO
 *
 * It never converts silently. Two vocabularies have to be reconciled and not
 * every leaf survives:
 *
 *   The condition fields differ. The rules engine calls a stage `lead_stage`;
 *   the registry the builder and `toSql` share calls it `stage`. Most map, and
 *   four do not exist in the registry at all. A condition that cannot be
 *   expressed is reported, not dropped — dropping it would widen the
 *   population the flow acts on, which for a rule that sends WhatsApp messages
 *   means messaging people the rule never touched.
 *
 *   `product_card_state` carries a product code alongside the value, and the
 *   tree has nowhere to put it. It is reported rather than half-converted.
 *
 * And the automation is always created as a draft, whatever the rule's state.
 * A conversion that turned on the moment it finished would double every send
 * in flight — the rule is still enabled, and now so is its copy.
 *
 * THE BOOK
 *
 * Rules have no `sales_org`: they run across every lead in the system. That is
 * a boundary hole in the old engine, and converting is where it gets closed —
 * so the caller names a book, and the report says plainly that the rule was
 * reaching both.
 */

import { all, one, run, audit, transact } from '../db.js';
import { fromLegacy, FIELDS, OPERATOR_CODES } from './conditions.js';
import { ACTION_TYPES } from './rules.js';

/* ------------------------------------------------------- the vocabulary */

/**
 * Rules-engine field → registry field.
 *
 * Only the ones that genuinely mean the same thing. A near-miss mapped anyway
 * is worse than one reported: it produces a flow that looks converted and acts
 * on a different population.
 */
const FIELD_MAP = {
  lead_stage: 'stage',
  lead_source: 'source',
  lead_age_days: 'lead_age_days',
  kyc_status: 'kyc_status',
  open_ticket_count: 'open_ticket_count',
  days_since_contact: 'days_since_contact',
  partner_linked: 'partner_linked',
  starred: 'starred',
};

/** Rules-engine operator → registry operator. Only `ne` is spelled differently. */
const OP_MAP = { ne: 'neq' };

/**
 * Fields the rules engine has and the registry does not.
 *
 * Each is a real gap rather than an oversight: `age_band` and `has_open_ticket`
 * are derived from fields the registry already carries, and the three KYC
 * journey fields describe a journey rather than a lead. Named here so the
 * report can say which, instead of "some conditions could not be converted".
 */
const NO_EQUIVALENT = {
  age_band: 'derive it from Lead age (days) instead',
  lead_score: 'the registry has no score field yet',
  contact_flag: 'the registry has no contact-flag field yet',
  kyc_journey_status: 'the registry carries KYC status, not the journey’s own state',
  kyc_step: 'the registry has no KYC step field yet',
  has_open_ticket: 'use Open cases is greater than 0 instead',
};

/** How many leaves a converted tree actually kept. */
function countLeaves(node) {
  if (!node) return 0;
  if (Array.isArray(node.children)) return node.children.reduce((n, c) => n + countLeaves(c), 0);
  return 1;
}

/* --------------------------------------------------------- the preview */

/** One leaf, converted — or the reason it could not be. */
function convertLeaf(leaf, original) {
  const problems = [];

  if (original?.product_code) {
    problems.push(
      `"${leaf.field}" tests the ${original.product_code} card specifically, and a condition tree has nowhere to carry the product code. Rebuild it as "Has a card in state".`,
    );
    return { problems };
  }

  const field = FIELD_MAP[leaf.field] ?? (FIELDS[leaf.field] ? leaf.field : null);
  if (!field) {
    const why = NO_EQUIVALENT[leaf.field];
    problems.push(why
      ? `"${leaf.field}" has no equivalent — ${why}.`
      : `"${leaf.field}" is not a field the flow builder knows.`);
    return { problems };
  }

  const operator = OP_MAP[leaf.operator] ?? leaf.operator;
  if (!OPERATOR_CODES().includes(operator)) {
    problems.push(`"${leaf.field}" uses the operator "${leaf.operator}", which the flow builder does not have.`);
    return { problems };
  }

  return { leaf: { field, operator, value: leaf.value }, problems };
}

/** Walk the tree, converting what converts and collecting what does not. */
function convertTree(node, flat) {
  const problems = [];
  if (!node) return { tree: null, problems };

  if (Array.isArray(node.children)) {
    const kept = [];
    for (const child of node.children) {
      const out = convertTree(child, flat);
      problems.push(...out.problems);
      if (out.tree) kept.push(out.tree);
    }
    return { tree: { op: node.op, children: kept }, problems };
  }

  /* The original row, so the product code survives long enough to be reported. */
  const original = flat.find((r) => r.field === node.field);
  const out = convertLeaf(node, original);
  problems.push(...out.problems);
  return { tree: out.leaf ?? null, problems };
}

/**
 * What converting this rule would produce, and what a person still has to do.
 *
 * Read-only. The screen shows this before anything is written, because the
 * answer is sometimes "four of these six conditions convert", and that is a
 * decision rather than a result.
 */
export function previewRule(ruleId) {
  const rule = one('SELECT * FROM rules WHERE id = ?', [ruleId]);
  if (!rule) return { error: 'No such rule' };

  const flat = JSON.parse(rule.conditions || '[]');
  const actions = JSON.parse(rule.actions || '[]');
  const { tree, problems } = convertTree(fromLegacy(flat), flat);

  /* An action the flow engine does not know would be a card that fails on
     every run. Both engines read ACTION_TYPES, so this should never fire —
     which is exactly why it is worth asserting rather than assuming. */
  const unknownActions = actions
    .filter((a) => !ACTION_TYPES.some((t) => t.type === a.type))
    .map((a) => `"${a.type}" is not an action the flow engine performs.`);

  const warnings = [...problems, ...unknownActions];

  if (!actions.length) warnings.push('This rule has no actions, so the flow would do nothing.');

  /* A rule whose conditions did not survive is the dangerous case, and it does
     not look dangerous: an AND group with no children is true for everybody, so
     the flow would act on the whole book where the rule acted on a handful. For
     a rule that sends WhatsApp messages that is messaging people it never
     touched. Refused, not warned about. */
  const lostEveryCondition = flat.length > 0 && countLeaves(tree) === 0;
  if (lostEveryCondition) {
    warnings.push('None of this rule’s conditions could be expressed, and a flow with no conditions runs on every lead in the book. Rebuild it by hand rather than converting it.');
  }


  return {
    rule: { id: rule.id, name: rule.name, description: rule.description, enabled: rule.enabled, priority: rule.priority },
    /* Every interval automation needs one; a rule's own `schedule` is a cron
       the flow engine does not speak, so it is shown rather than guessed at. */
    every_hours: 24,
    rule_schedule: rule.schedule ?? null,
    conditions: tree,
    steps: actions.map((a, i) => ({
      order: i,
      kind: 'action',
      label: ACTION_TYPES.find((t) => t.type === a.type)?.label ?? a.type,
      config: { type: a.type, params: a.params ?? {} },
    })),
    warnings,
    /* True of every conversion rather than of this rule, so it is carried apart
       from the warnings -- repeated once per row it reads as six problems when
       it is one fact. */
    book_note: 'Rules run across every lead in the system. A flow belongs to one book, so converting one means choosing which — or converting it twice.',
    /* Every condition has to survive, not most of them. A tree missing a leaf
       is a wider population than the rule had, and widening quietly is the one
       failure mode this converter exists to prevent. */
    convertible: !unknownActions.length && actions.length > 0 && problems.length === 0,
  };
}

/** Every rule, previewed — the list the migration screen opens on. */
export const previewAll = () =>
  all('SELECT id FROM rules ORDER BY priority, id').map((r) => previewRule(r.id));

/* ------------------------------------------------------- the conversion */

/**
 * Write the flow.
 *
 * As a draft, always. The rule it came from is still enabled, and an
 * automation that went live the moment it was created would double every send
 * the rule is already making.
 *
 * The rule is left exactly as it is. Disabling it belongs to whoever checks
 * the flow and decides it is right — which is a different act, done on a
 * different day, by somebody who has looked at it.
 */
export function convertRule(ruleId, { salesOrg, userId = null, everyHours = 24 } = {}) {
  const preview = previewRule(ruleId);
  if (preview.error) return preview;
  if (!preview.convertible) {
    return { error: 'This rule cannot be converted as it stands', warnings: preview.warnings };
  }
  if (!salesOrg) return { error: 'Say which book the flow belongs to' };

  return transact(() => {
    const autoId = Number(run(
      `INSERT INTO automation (name, description, sales_org, trigger_type, trigger_config,
                               entry_conditions, status, priority, created_by)
       VALUES (?,?,?,?,?,?,'draft',?,?)`,
      [
        `${preview.rule.name} (from the rule builder)`,
        preview.rule.description ?? null,
        salesOrg,
        'schedule.interval',
        JSON.stringify({ every_hours: everyHours }),
        preview.conditions ? JSON.stringify(preview.conditions) : null,
        preview.rule.priority ?? 100,
        userId,
      ],
    ).lastInsertRowid);

    /* Two passes, the same as anywhere a flow is built: every card exists
       before any card points at another. */
    const ids = preview.steps.map((s) => Number(run(
      'INSERT INTO automation_step (automation_id, kind, config, label, sort_order) VALUES (?,?,?,?,?)',
      [autoId, s.kind, JSON.stringify(s.config), s.label, s.order],
    ).lastInsertRowid));

    ids.forEach((id, i) => {
      run('UPDATE automation_step SET next_step_id = ? WHERE id = ?', [ids[i + 1] ?? null, id]);
    });
    run('UPDATE automation SET first_step_id = ? WHERE id = ?', [ids[0], autoId]);

    audit(userId, 'rule_converted_to_flow', 'automation', autoId, {
      rule_id: ruleId,
      rule_name: preview.rule.name,
      sales_org: salesOrg,
      warnings: preview.warnings,
    });

    return { automation_id: autoId, warnings: preview.warnings, steps: ids.length };
  });
}
