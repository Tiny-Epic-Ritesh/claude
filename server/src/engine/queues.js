/**
 * Queues, and a polymorphic owner.
 *
 * NON-NEGOTIABLE 8: an owner is a User *or* a Queue.
 *
 * WHY THIS MATTERS MORE THAN IT SOUNDS
 * ------------------------------------
 * Today `leads.owner_id` points at a user and nothing else. That forces a bad
 * choice whenever nobody should own something yet:
 *
 *   • leave it NULL — and it belongs to nobody, appears on no worklist, and is
 *     found weeks later by a report
 *   • assign it to a placeholder human — and one person's book fills with work
 *     that was never theirs, which is where shared logins come from
 *
 * The legacy tenant took the second route. Its audit found accounts shared
 * between staff precisely so a "team" could hold unassigned work, and the
 * consequence is that no activity in the system can be attributed to a person.
 *
 * A queue is the missing third answer: a real owner, with a real worklist, that
 * happens not to be a human. Work sits in it visibly until somebody takes it.
 *
 * HOW OWNERSHIP IS STORED
 * -----------------------
 * `owner_id` keeps pointing at a user, and a new `owner_queue_id` points at a
 * queue. Exactly one is set. That is deliberately not a single `owner_type` +
 * `owner_ref` pair: two nullable foreign keys keep referential integrity, keep
 * every existing query working, and make "leads owned by a user" an index hit
 * rather than a filtered scan.
 */

import { all, one, run, transact } from '../db.js';

/* ------------------------------------------------------------- queues */

export const SEED_QUEUES = [
  {
    code: 'UNASSIGNED_BONANZA',
    name: 'Unassigned — Bonanza',
    description: 'New leads with no owner yet. Anyone on the desk may take one.',
    sales_org: 'BONANZA',
    entity: 'lead',
  },
  {
    code: 'UNASSIGNED_BIGUL',
    name: 'Unassigned — Bigul',
    description: 'New Bigul leads with no owner yet.',
    sales_org: 'BIGUL',
    entity: 'lead',
  },
  {
    code: 'CARE_INBOX',
    name: 'Customer Care inbox',
    description: 'Cases waiting to be picked up by whoever is free.',
    sales_org: null,
    entity: 'case',
  },
  {
    code: 'KYC_REVIEW',
    name: 'KYC review',
    description: 'Journeys that stalled and need a human to look at them.',
    sales_org: null,
    entity: 'lead',
  },
];

export function seedQueues() {
  return transact(() => {
    let added = 0;
    for (const q of SEED_QUEUES) {
      if (one('SELECT id FROM queues WHERE code = ?', [q.code])) continue;
      run(
        `INSERT INTO queues (code, name, description, sales_org, entity)
         VALUES (?,?,?,?,?)`,
        [q.code, q.name, q.description, q.sales_org, q.entity],
      );
      added += 1;
    }
    return added;
  });
}

export const listQueues = (entity = null) => all(
  `SELECT q.*,
          (SELECT COUNT(*) FROM queue_members m WHERE m.queue_id = q.id) AS member_count,
          (SELECT COUNT(*) FROM leads l WHERE l.owner_queue_id = q.id AND l.deleted_at IS NULL) AS lead_count
   FROM queues q
   ${entity ? 'WHERE q.entity = ?' : ''}
   ORDER BY q.name`,
  entity ? [entity] : [],
);

export const queueByCode = (code) => one('SELECT * FROM queues WHERE code = ?', [code]);

/* --------------------------------------------------------- membership */

/**
 * Who may take work out of a queue.
 *
 * By role rather than by person, because a queue outlives the people in it —
 * naming individuals means the list is wrong the first time someone changes
 * desks, and nobody remembers to fix it.
 */
export function setMembers(queueId, roles) {
  return transact(() => {
    run('DELETE FROM queue_members WHERE queue_id = ?', [queueId]);
    for (const role of roles ?? []) {
      run('INSERT INTO queue_members (queue_id, role_code) VALUES (?,?)', [queueId, role]);
    }
    return roles?.length ?? 0;
  });
}

export const membersOf = (queueId) =>
  all('SELECT role_code FROM queue_members WHERE queue_id = ?', [queueId]).map((r) => r.role_code);

/** May this user take work out of this queue? */
export function mayTakeFrom(user, queue) {
  if (!user || !queue) return false;
  const roles = membersOf(queue.id);
  // A queue with no members named is open to the whole org rather than closed
  // to everyone — a queue nobody can empty is a black hole.
  if (!roles.length) return true;
  return roles.includes(user.role);
}

/* ------------------------------------------------------------ ownership */

/**
 * Who owns this record, as one answer whatever the underlying columns say.
 *
 * Everything above this reads `{ type, id, name }` and never has to branch on
 * which column happened to be populated.
 */
export function ownerOf(record) {
  if (record?.owner_queue_id) {
    const q = one('SELECT id, name, code FROM queues WHERE id = ?', [record.owner_queue_id]);
    return q ? { type: 'queue', id: q.id, name: q.name, code: q.code } : null;
  }
  if (record?.owner_id) {
    const u = one('SELECT id, name, role FROM users WHERE id = ?', [record.owner_id]);
    return u ? { type: 'user', id: u.id, name: u.name, role: u.role } : null;
  }
  return null;
}

/**
 * Put a lead in a queue.
 *
 * Clears the user owner in the same statement rather than in two: a record that
 * is briefly owned by both is a record that appears on two worklists, and the
 * window is exactly when a sweep is most likely to read it.
 */
export function assignToQueue(leadId, queueId, { actorId = null } = {}) {
  const queue = one('SELECT * FROM queues WHERE id = ?', [queueId]);
  if (!queue) return { ok: false, error: 'No such queue' };

  run(
    "UPDATE leads SET owner_queue_id = ?, owner_id = NULL, updated_at = datetime('now') WHERE id = ?",
    [queueId, leadId],
  );
  run(
    `INSERT INTO activities (lead_id, type, direction, subject, body, user_id)
     VALUES (?, 'Note', 'system', ?, ?, ?)`,
    [leadId, `Placed in ${queue.name}`, queue.description ?? null, actorId],
  );
  return { ok: true, queue: queue.name };
}

/**
 * Take a lead out of a queue and own it.
 *
 * The check is the point: a queue is not a free-for-all, and the person taking
 * work must be entitled to it. Returns a reason rather than a boolean so the
 * refusal can be shown.
 */
export function claimFromQueue(leadId, user) {
  const lead = one('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL', [leadId]);
  if (!lead) return { ok: false, error: 'Lead not found' };
  if (!lead.owner_queue_id) {
    const owner = ownerOf(lead);
    return {
      ok: false,
      error: owner ? `${lead.name} already belongs to ${owner.name}` : `${lead.name} is not in a queue`,
    };
  }

  const queue = one('SELECT * FROM queues WHERE id = ?', [lead.owner_queue_id]);
  if (!mayTakeFrom(user, queue)) {
    return { ok: false, error: `Your role cannot take work out of ${queue.name}` };
  }

  run(
    "UPDATE leads SET owner_id = ?, owner_queue_id = NULL, updated_at = datetime('now') WHERE id = ?",
    [user.id, leadId],
  );
  run(
    `INSERT INTO activities (lead_id, type, direction, subject, body, user_id)
     VALUES (?, 'Note', 'system', ?, ?, ?)`,
    [leadId, `Taken from ${queue.name}`, `${user.name} claimed this lead`, user.id],
  );
  return { ok: true, queue: queue.name, owner: user.name };
}

/** What is sitting in this queue, for the queue's own worklist. */
export const workIn = (queueId, limit = 100) => all(
  `SELECT l.id, l.name, l.mobile, l.city, l.source, l.stage, l.created_at
   FROM leads l WHERE l.owner_queue_id = ? AND l.deleted_at IS NULL
   ORDER BY l.created_at ASC LIMIT ?`,
  [queueId, limit],
);

/**
 * The SQL fragment for "leads I can see because they are in a queue I belong
 * to". Composed into the lead scope alongside role scope and manager sharing.
 */
export function queueScopeSql(user) {
  if (!user) return null;
  const queues = all(
    `SELECT q.id FROM queues q
     LEFT JOIN queue_members m ON m.queue_id = q.id
     WHERE m.role_code = ? OR NOT EXISTS (SELECT 1 FROM queue_members x WHERE x.queue_id = q.id)`,
    [user.role],
  ).map((q) => q.id);

  if (!queues.length) return null;
  return {
    sql: `l.owner_queue_id IN (${queues.map(() => '?').join(',')})`,
    params: queues,
  };
}
