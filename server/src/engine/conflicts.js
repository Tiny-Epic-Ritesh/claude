/**
 * Static conflict detection between automation rules.
 *
 * NON-NEGOTIABLE 12: explicit ordering, conflict detection, failure queue.
 *
 * WHAT THIS CATCHES, AND WHY IT IS STATIC
 * ---------------------------------------
 * Two enabled rules can quietly fight. One sets a lead's stage to Qualified
 * when the score passes 60; another sets it to Lost when there has been no
 * contact for 30 days. A lead that is both scores 60 and has gone quiet, and
 * the answer depends on which rule happens to run second — which is priority
 * order, which nobody looked at.
 *
 * The legacy tenant has 40-odd automations and no way to ask this question, so
 * the answer is found by noticing that a stage keeps flipping.
 *
 * Static, because the alternative is finding out at runtime on a real client.
 * This runs when a rule is saved and on demand, and reports pairs rather than
 * blocking — some overlaps are deliberate, and a tool that refuses to save a
 * rule an administrator meant is a tool they route around.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not try to prove that two condition sets can both be true. That is
 * satisfiability, and a cheap approximation that says "no conflict" when there
 * is one is worse than not checking. Instead it reports where two rules *could*
 * overlap and their actions disagree, and leaves the judgement to a human who
 * knows the book.
 */

import { all } from '../db.js';

/** Actions that write the same thing, and therefore can contradict. */
const WRITERS = {
  update_lead: (a) => `lead.${a.params?.field ?? '?'}`,
  update_card: (a) => `card.${a.params?.field ?? 'state'}`,
  assign_queue: () => 'lead.owner',
  reassign: () => 'lead.owner',
};

/** What an action writes, or null if it only sends or notifies. */
function writes(action) {
  const fn = WRITERS[action?.type];
  return fn ? { target: fn(action), value: action.params?.value ?? action.params?.state ?? null } : null;
}

/**
 * Could these two condition sets ever both hold?
 *
 * A deliberately shallow check: two conditions on the same field with different
 * equality values are mutually exclusive and the rules can never both fire.
 * Anything else is treated as "possibly overlapping", which errs toward
 * reporting. A false alarm costs a glance; a missed conflict costs a client
 * record flipping between two states for a week.
 */
function mightOverlap(aConds, bConds) {
  const eq = (list) => {
    const m = new Map();
    for (const c of list ?? []) {
      if (c.operator === 'eq' || c.operator === 'is') m.set(c.field, String(c.value));
    }
    return m;
  };

  const A = eq(aConds);
  const B = eq(bConds);

  for (const [field, valueA] of A) {
    const valueB = B.get(field);
    // Same field pinned to two different values — they cannot both match.
    if (valueB !== undefined && valueB !== valueA) return false;
  }
  return true;
}

/**
 * Every pair of enabled rules that could fight, worst first.
 *
 * Only enabled rules: a disabled rule cannot conflict with anything, and
 * reporting it is noise that trains people to ignore the list.
 */
export function detectConflicts() {
  const rules = all('SELECT * FROM rules WHERE enabled = 1 ORDER BY priority, id').map((r) => ({
    ...r,
    conditions: JSON.parse(r.conditions || '[]'),
    actions: JSON.parse(r.actions || '[]'),
  }));

  const conflicts = [];

  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i];
      const b = rules[j];

      if (!mightOverlap(a.conditions, b.conditions)) continue;

      for (const actionA of a.actions) {
        const wa = writes(actionA);
        if (!wa) continue;

        for (const actionB of b.actions) {
          const wb = writes(actionB);
          if (!wb || wb.target !== wa.target) continue;

          // Same target, same value is duplication, not conflict — worth
          // saying, but not the same problem.
          const contradiction = String(wa.value) !== String(wb.value);

          conflicts.push({
            severity: contradiction ? 'conflict' : 'duplicate',
            target: wa.target,
            rules: [
              { id: a.id, name: a.name, priority: a.priority, sets: wa.value },
              { id: b.id, name: b.name, priority: b.priority, sets: wb.value },
            ],
            // Priority decides, so say so plainly rather than leaving it implied.
            resolution: a.priority === b.priority
              ? 'Both have the same priority, so which one wins is not defined. Give one a lower number.'
              : `"${a.priority < b.priority ? a.name : b.name}" runs first, so the other one overwrites it.`,
            explain: contradiction
              ? `Both write ${wa.target}, to different values.`
              : `Both write ${wa.target} to the same value — one of them is redundant.`,
          });
        }
      }
    }
  }

  // Real contradictions before duplicates; a list that opens with cosmetic
  // findings gets closed.
  return conflicts.sort((x, y) => (x.severity === 'conflict' ? -1 : 1) - (y.severity === 'conflict' ? -1 : 1));
}

/**
 * Rules that share a priority.
 *
 * Ordering is only explicit if it is actually ordered. Two rules at priority
 * 100 run in whatever order the query returns them, which is stable until
 * somebody edits one.
 */
export function ambiguousOrdering() {
  return all(
    `SELECT priority, COUNT(*) n, GROUP_CONCAT(name, ' · ') AS names
     FROM rules WHERE enabled = 1
     GROUP BY priority HAVING n > 1`,
  ).map((r) => ({
    priority: r.priority,
    count: r.n,
    rules: r.names,
    why: 'Rules at the same priority have no defined order. If they touch the same field, the outcome is whichever ran last.',
  }));
}

/** Everything a Setup screen needs to show about automation health. */
export function healthReport() {
  const conflicts = detectConflicts();
  const ordering = ambiguousOrdering();
  const failures = all(
    `SELECT f.*, r.name AS rule_name, l.name AS lead_name
     FROM rule_failures f
     LEFT JOIN rules r ON r.id = f.rule_id
     LEFT JOIN leads l ON l.id = f.lead_id
     WHERE f.resolved_at IS NULL
     ORDER BY f.created_at DESC LIMIT 100`,
  );

  return {
    conflicts,
    ordering,
    failures,
    summary: {
      conflicts: conflicts.filter((c) => c.severity === 'conflict').length,
      duplicates: conflicts.filter((c) => c.severity === 'duplicate').length,
      ambiguous_priorities: ordering.length,
      unresolved_failures: failures.length,
    },
  };
}
