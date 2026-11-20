/**
 * A Caller or Dealer hands a lead they own to a Sales RM -- B26, ruled by
 * Ritesh on 20 Nov 2026 (found in A5, at BRD gate P1).
 *
 * There was no way to do it. The Dealer's home offered "Hand to Sales RM" and
 * the Caller's "Flag for Sales RM", and both opened the lead list and stopped
 * there: Callers and Dealers can change neither a lead's owner nor its stage,
 * and the only transfer in the CRM ran the other way -- somebody asks the owner
 * for the lead and the owner approves. The Caller's "Leads qualified" counted
 * their leads at Qualified, a stage they could not set, and a lead handed on
 * would have left their count.
 *
 * Ruled, as recommended, with three details ruled the same day:
 *
 *   who      a Caller or Dealer (lead.handover), on a lead they own
 *   to whom  a Sales RM in the lead's business they choose, or one the routing
 *            rules choose: the same rules, Sales RMs only, in the team's own
 *            order; with no such team, the least-loaded Sales RM there
 *            (assignment.routeToRole)
 *   note     what the Sales RM needs to know, as the Product RM handover asks
 *   when     at once, with no approval: an owner may give away their own lead,
 *            and their supervisor is told (ruled 11 Sep, for transfers)
 *   stage    at Qualified at least: New or Contacted becomes Qualified,
 *            Qualified and In Progress keep theirs, and a Won or Lost lead is
 *            not handed over
 *   tasks    their open tasks on the lead go with it, reminders and all: the
 *            Caller can no longer open the lead, and a callback promised to the
 *            client is kept by whoever owns it now
 *   told     the Sales RM gets a notice and a High-priority task, due in four
 *            hours as a Product RM's is, with the note in it
 *   credit   the Caller's "Leads qualified" counts the hand-overs they made in
 *            the period, and a team's for anyone with reports (B21)
 *   record   the owner and stage changes in the lead's field history; the
 *            stage change on the timeline, as every stage change is; the owner
 *            change not, as ruled for transfers on 11 Sep; and the hand-over
 *            itself in lead_handovers and the audit
 */

import { all, one, run, audit, notify, transact, ROLE_LABELS } from '../db.js';
import { orgsFor, leadScope } from '../auth.js';
import { tracked, SOURCE } from './history.js';
import { routeToRole } from './assignment.js';
import { columnRefusal } from './metadata.js';
import { assertValid } from './validation.js';
import { cancelReminders, scheduleReminders } from './followups.js';
import { dmyTime } from './daterange.js';
import { STATE_LABEL } from './nextaction.js';

export const HANDOVER_TASK_TITLE = 'Hand-over: ';
const SETTLED = ['Won', 'Lost'];
const EARLY = ['New', 'Contacted'];
const NOTE_MAX = 2000;

/**
 * Everyone who supervises this person: their manager on the org chart, and the
 * manager of any active sales group they sit on. Either may be the person who
 * needs to know, and N-7a is the reminder that they are often not the same.
 * (From routes/approvals.js, where an owner's own transfer tells them too.)
 */
export const supervisorsOf = (userId) => all(
  `SELECT manager_id AS id FROM users WHERE id = ? AND manager_id IS NOT NULL
   UNION
   SELECT t.manager_id FROM teams t JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.user_id = ? AND t.active = 1 AND t.manager_id IS NOT NULL`,
  [userId, userId],
).map((r) => Number(r.id));

/** The stage a hand-over leaves a lead at: Qualified at least. */
export const stageAfter = (stage) => (EARLY.includes(stage) ? 'Qualified' : stage);

const bookName = (org) => one('SELECT name FROM sales_orgs WHERE code = ?', [org])?.name ?? org;
const isSalesRmIn = (u, org) => Boolean(u && u.role === 'sales_rm' && u.active === 1 && orgsFor(u).includes(org));

/** The Sales RMs who work in a business, with the open leads each holds there, for the chooser. */
export function salesRmsIn(org) {
  return all(
    `SELECT u.id, u.name, u.role, u.active, u.sales_org, u.org_access,
            (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.sales_org = ? AND l.deleted_at IS NULL
                AND l.stage NOT IN ('Won', 'Lost')) AS open_leads
       FROM users u WHERE u.role = 'sales_rm' AND u.active = 1 ORDER BY u.name`,
    [org],
  ).filter((u) => isSalesRmIn(u, org)).map(({ id, name, open_leads }) => ({ id, name, open_leads }));
}

/** Does this person's scorecard carry the metric a hand-over counts on? */
const creditedOn = (user, org) => one(
  `SELECT label FROM kra_metrics WHERE role_code = ? AND source = 'leads_qualified' AND active = 1 AND sales_org = ?
    ORDER BY sort_order LIMIT 1`,
  [user.role, org],
)?.label ?? null;

/** Their open tasks on the lead: what moves with it. */
const tasksOf = (leadId, userId) => all(
  "SELECT id, title, due_at FROM tasks WHERE lead_id = ? AND assignee_id = ? AND status = 'Open' ORDER BY due_at, id",
  [leadId, userId],
);

/**
 * Why this person may not hand this lead over, or null. The lead was loaded
 * in the reader's book; this is what is particular to a hand-over.
 */
function refusal(lead, user) {
  if (lead.owner_queue_id || Number(lead.owner_id) !== Number(user.id)) {
    return { status: 403, error: `Only the lead's owner can hand it over, and ${lead.name} is not yours.` };
  }
  if (SETTLED.includes(lead.stage)) {
    return { status: 409, error: `${lead.name} is ${lead.stage}: a settled lead is not handed over.` };
  }
  const to = stageAfter(lead.stage);
  if (to !== lead.stage) {
    const bad = columnRefusal('lead', 'stage', to, lead.sales_org);
    if (bad) return { status: 400, error: `A hand-over moves the lead to ${to}, and ${bad.charAt(0).toLowerCase()}${bad.slice(1)}.` };
  }
  return null;
}

/** Saying who chose the Sales RM, and how. */
function chosenWords(pick, to, org) {
  if (pick.how === 'chosen') return `You chose ${to.name}.`;
  return pick.fallback
    ? `No routing rule's team has a Sales RM in ${bookName(org)}, so it goes to the one with the fewest open leads there: ${to.name}.`
    : `The routing rules chose ${to.name}, by the rule "${pick.rule_name}".`;
}

/**
 * Before the hand-over: who can be chosen, who the routing rules would choose
 * now, and everything it would do. Read-only -- the rules' rotation does not
 * move for being asked.
 */
export function handoverPreview(lead, user) {
  const no = refusal(lead, user);
  if (no) return no;
  const routed = routeToRole(lead, 'sales_rm', { dryRun: true });
  const routedTo = routed.user_id ? one('SELECT id, name FROM users WHERE id = ?', [routed.user_id]) : null;
  const tasks = tasksOf(lead.id, user.id);
  const supervisors = supervisorsOf(user.id).filter((id) => id !== Number(user.id))
    .map((id) => one('SELECT name FROM users WHERE id = ? AND active = 1', [id])?.name).filter(Boolean);
  const toStage = stageAfter(lead.stage);
  const credit = creditedOn(user, lead.sales_org);
  return {
    lead: lead.name,
    business: bookName(lead.sales_org),
    stage: { from: lead.stage, to: toStage },
    sales_rms: salesRmsIn(lead.sales_org),
    routed: routedTo
      ? { id: routedTo.id, name: routedTo.name, said: chosenWords({ how: 'routed', ...routed }, routedTo, lead.sales_org) }
      : null,
    tasks_moving: tasks,
    supervisors,
    will: [
      toStage !== lead.stage
        ? `${lead.name} becomes the Sales RM's lead at once, and moves from ${lead.stage} to ${toStage}.`
        : `${lead.name} becomes the Sales RM's lead at once, and stays at ${lead.stage}.`,
      'The Sales RM gets a notice, and a High-priority task due in 4 hours with your note in it.',
      tasks.length
        ? `Your ${tasks.length === 1 ? 'open task' : `${tasks.length} open tasks`} on it ${tasks.length === 1 ? 'goes' : 'go'} to them too, reminders and all: ${
          tasks.slice(0, 3).map((t) => t.title).join('; ')}${tasks.length > 3 ? `; and ${tasks.length - 3} more` : ''}.`
        : null,
      supervisors.length
        ? `${supervisors.join(' and ')} ${supervisors.length === 1 ? 'is' : 'are'} told, as your supervisor.`
        : 'You have no supervisor on record, so nobody else is told.',
      credit ? `It counts on your scorecard, under "${credit}".` : null,
      'No approval is needed: it is your lead to give.',
    ].filter(Boolean),
  };
}

/**
 * Hand the lead over. `toUserId` names the Sales RM; `auto` lets the routing
 * rules choose. Returns { status, error } when it may not happen, else what it
 * did, in words.
 */
export function handOver(lead, user, { toUserId = null, auto = false, note = '', source = SOURCE.ui } = {}) {
  const no = refusal(lead, user);
  if (no) return no;

  const needs = String(note ?? '').trim();
  if (!needs) return { status: 400, error: 'Say what the Sales RM needs to know before they call the client', field: 'needs_to_know' };
  if (needs.length > NOTE_MAX) return { status: 400, error: `Keep the note to ${NOTE_MAX} characters`, field: 'needs_to_know' };
  if (!auto && !toUserId) return { status: 400, error: 'Choose a Sales RM, or let the routing rules choose', field: 'to_user_id' };

  const org = lead.sales_org;
  const toStage = stageAfter(lead.stage);
  const staff = (id) => one('SELECT id, name, role, active, sales_org, org_access FROM users WHERE id = ?', [Number(id)]);

  let to;
  let pick;
  if (auto) {
    const routed = routeToRole(lead, 'sales_rm', { dryRun: true });
    if (!routed.user_id) {
      return { status: 409, error: `No active Sales RM works in ${bookName(org)}, so there is nobody to hand ${lead.name} to. An Admin sets one up in Setup → Users.` };
    }
    pick = { how: 'routed', ...routed };
  } else {
    to = staff(toUserId);
    if (!isSalesRmIn(to, org)) {
      return { status: 400, error: `Choose an active Sales RM who works in ${bookName(org)}`, field: 'to_user_id' };
    }
    pick = { how: 'chosen' };
  }

  /* Setup's validation rules hold for a hand-over as for any edit: it changes
     the owner, and perhaps the stage. Checked before anything is written. */
  const ownerFor = auto ? pick.user_id : to.id;
  const failed = assertValid('lead', {
    existing: lead,
    patch: { owner_id: ownerFor, ...(toStage !== lead.stage ? { stage: toStage } : {}) },
  });
  if (failed) {
    return { status: 422, error: failed[0].message, failed: failed.map((r) => ({ rule: r.rule, message: r.message })) };
  }

  return transact(() => {
    /* The rotation moves now, when the hand-over is made: the dialog asked
       without moving it. Same rules, same lead, so the same answer unless
       somebody else has been handed one from that team in between. */
    if (auto) {
      pick = { how: 'routed', ...routeToRole(lead, 'sales_rm') };
      to = pick.user_id ? staff(pick.user_id) : null;
      if (!to) return { status: 409, error: `No active Sales RM works in ${bookName(org)}, so there is nobody to hand ${lead.name} to.` };
    }

    const moved = tracked('lead', lead.id, { actorId: user.id, source }, () => run(
      `UPDATE leads SET owner_id = ?, owner_queue_id = NULL, stage = ?, assigned_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND owner_id = ? AND owner_queue_id IS NULL`,
      [to.id, toStage, lead.id, user.id],
    ));
    if (!moved.changes) return { status: 409, error: `${lead.name} has changed hands since you opened it.` };
    if (toStage !== lead.stage) {
      // On the timeline, as every stage change is (PATCH /leads/:id).
      run('INSERT INTO activities (lead_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?)', [
        lead.id, 'Note', 'system', 'Stage changed', `${lead.stage} → ${toStage}`, user.id,
      ]);
    }

    /* Their open tasks go with the lead, and their reminders with them, as a
       task given to somebody else anywhere does (OPS-48). */
    const tasks = tasksOf(lead.id, user.id);
    if (tasks.length) {
      const ids = tasks.map((t) => t.id);
      tracked('task', ids, { actorId: user.id, source }, () => run(
        `UPDATE tasks SET assignee_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [to.id, ...ids],
      ));
      for (const t of tasks) {
        if (!one('SELECT 1 v FROM reminders WHERE task_id = ?', [t.id])) continue;
        cancelReminders(t.id, 'handed over');
        scheduleReminders({ taskId: t.id, leadId: lead.id, userId: to.id, dueAt: t.due_at, detail: `${t.title} (handed over)` });
      }
    }

    const products = all(
      `SELECT pt.name, pc.state FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
        WHERE pc.lead_id = ? AND pc.state != 'INACTIVE' ORDER BY pt.sort_order`,
      [lead.id],
    );
    const roleName = ROLE_LABELS[user.role] ?? user.role;
    const taskBody = [
      `Handed over by ${user.name} (${roleName}).`,
      `What you need to know: ${needs}`,
      `Where it stands: ${toStage}${toStage !== lead.stage ? ` (was ${lead.stage})` : ''}.${products.length
        ? ` Products: ${products.map((p) => `${p.name} ${STATE_LABEL[p.state] ?? p.state}`).join(', ')}.` : ''}`,
      tasks.length
        ? `Moved to you with it: ${tasks.map((t) => `${t.title}${t.due_at ? ` (due ${dmyTime(t.due_at)})` : ''}`).join('; ')}.`
        : null,
    ].filter(Boolean).join('\n\n');
    const taskId = Number(run(
      "INSERT INTO tasks (title, description, lead_id, assignee_id, created_by, due_at, priority) VALUES (?,?,?,?,?,datetime('now','+4 hours'),'High')",
      [`${HANDOVER_TASK_TITLE}${lead.name}`, taskBody, lead.id, to.id, user.id],
    ).lastInsertRowid);
    const due = one('SELECT due_at FROM tasks WHERE id = ?', [taskId]).due_at;

    const handoverId = Number(run(
      `INSERT INTO lead_handovers (lead_id, sales_org, from_user_id, from_role, to_user_id, how, routed_by, needs_to_know,
                                   stage_from, stage_to, tasks_moved, task_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [lead.id, org, user.id, user.role, to.id, pick.how,
        pick.how === 'routed' ? (pick.fallback ? 'the least-loaded Sales RM' : pick.rule_name) : null,
        needs, lead.stage, toStage, tasks.length, taskId],
    ).lastInsertRowid);

    notify(to.id, `Lead handed to you — ${lead.name}`, `${user.name} handed ${lead.name} to you. ${needs.slice(0, 140)}`, `/leads/${lead.id}`);
    /* Their supervisor is told -- ruled 11 Sep for an owner giving their own
       lead away, the words the transfer uses. */
    const told = [];
    for (const sup of supervisorsOf(user.id)) {
      if (sup === Number(to.id) || sup === Number(user.id)) continue;
      const person = one('SELECT name FROM users WHERE id = ? AND active = 1', [sup]);
      if (!person) continue;
      notify(sup, `Lead handed over: ${lead.name}`, `${user.name} handed ${lead.name} to ${to.name}.`, `/leads/${lead.id}`);
      told.push(person.name);
    }
    audit(user.id, 'lead_handed_over', 'lead', lead.id, {
      handover_id: handoverId, to: to.id, how: pick.how, routed_by: pick.rule_name ?? (pick.fallback ? 'least_loaded' : null),
      stage_from: lead.stage, stage_to: toStage, tasks_moved: tasks.map((t) => t.id), supervisors_told: told.length,
    });

    const scope = leadScope(user, 'l');
    const stillMine = one(`SELECT 1 v FROM leads l WHERE l.id = ? AND ${scope.sql}`, [lead.id, ...scope.params]);
    const credit = creditedOn(user, org);
    return {
      handover_id: handoverId,
      to: { id: to.id, name: to.name },
      how: pick.how,
      stage: { from: lead.stage, to: toStage },
      tasks_moved: tasks.length,
      task_due_at: due,
      effects: [
        `${lead.name} is ${to.name}'s lead now${toStage !== lead.stage ? `, at ${toStage} (was ${lead.stage})` : `, still at ${toStage}`}.`,
        chosenWords(pick, to, org),
        `${to.name} has a notice, and a High-priority task due ${dmyTime(due)} with your note in it.`,
        tasks.length
          ? `Your ${tasks.length === 1 ? 'open task' : `${tasks.length} open tasks`} on it moved to ${to.name}: ${tasks.map((t) => t.title).join('; ')}.`
          : null,
        told.length
          ? `${told.join(' and ')} ${told.length === 1 ? 'was' : 'were'} told, as your supervisor.`
          : 'You have no supervisor on record, so nobody else was told.',
        credit ? `It counts on your scorecard, under "${credit}".` : null,
        stillMine ? null : 'It leaves your list now.',
      ].filter(Boolean),
    };
  });
}
