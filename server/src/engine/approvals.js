/**
 * Approvals — one engine, four scopes.
 *
 * WHY A GENERIC ENGINE AND NOT FOUR BESPOKE FLOWS
 * -----------------------------------------------
 * The four things that need approval here — partner elevation, account closure,
 * fee and brokerage changes, bulk reassignment — have nothing in common in the
 * business, and everything in common as software. Each needs: a request that
 * captures what is being asked and why, a rule for who may decide it, a record
 * that is locked while it waits, a decision with a reason, and an audit trail
 * that survives both outcomes.
 *
 * Written four times, those five things end up subtly different four times, and
 * the fourth one gets the audit trail wrong because nobody remembered. Written
 * once, adding a fifth scope is a row in a table.
 *
 * THE RECORD IS LOCKED WHILE IT WAITS
 * -----------------------------------
 * This is the part that is easy to skip and expensive to skip. If a partner's
 * commission can still be edited while a change to it sits pending, the approver
 * signs off on a number that is no longer there. The lock is enforced on the
 * write path, not by hiding a button.
 *
 * SELF-APPROVAL IS REFUSED
 * ------------------------
 * Always, whatever capabilities the requester holds. An approval a person can
 * grant themselves is a log entry, not a control — and the whole point of these
 * four scopes is that money or access moves.
 */

import { all, one, run, audit, notify, transact } from '../db.js';
import { mayUseOrg } from '../auth.js';

/* ---------------------------------------------------------- the scopes */

/**
 * What can be approved, who decides, and what is locked while it waits.
 *
 * `entity` + `entity_id` identify the record under lock. `approver` is a
 * capability rather than a role, so an administrator can move the decision by
 * granting a permission set instead of asking for a code change.
 */
export const APPROVAL_SCOPES = {
  partner_elevation: {
    label: 'Partner elevation',
    entity: 'partner',
    approver: 'partner.elevate',
    describe: (r) => `Elevate ${r.subject_name} to a full partner with a portal login`,
    why: 'Issues a partner code and a portal credential — access, not just data.',
  },
  partner_closure: {
    label: 'Partner suspension or closure',
    entity: 'partner',
    approver: 'partner.suspend',
    describe: (r) => `Set ${r.subject_name} to ${r.payload?.state_code ?? 'closed'}`,
    why: 'Stops commission and revokes portal access.',
  },
  commission_change: {
    label: 'Commission or fee change',
    entity: 'partner',
    approver: 'partner.elevate',
    describe: (r) => `Change ${r.subject_name}'s commission to ${r.payload?.commission_pct}%`,
    why: 'Changes what the firm pays out, on every future payout.',
  },
  bulk_reassign: {
    label: 'Bulk lead reassignment',
    entity: 'lead',
    approver: 'lead.reassign',
    describe: (r) => `Move ${r.payload?.lead_ids?.length ?? 0} leads to ${r.subject_name}`,
    why: 'Moves a book between people — attribution, incentives and coverage all follow it.',
  },
};

/** How many records a bulk action may touch before it needs a second pair of eyes. */
export const BULK_THRESHOLD = Number(process.env.CRM_BULK_APPROVAL_THRESHOLD ?? 25);

/* --------------------------------------------------------- requesting */

/**
 * Ask for something.
 *
 * Returns the request rather than performing the action — nothing happens until
 * somebody decides. A second request against a record already under lock is
 * refused rather than queued, because two people asking for different changes
 * to the same commission is a conversation, not a workflow.
 */
export function request({
  scope, entityId, subjectName, payload, reason, requestedBy,
}) {
  const spec = APPROVAL_SCOPES[scope];
  if (!spec) return { ok: false, error: `${scope} is not something that can be approved` };
  if (!reason?.trim()) {
    return { ok: false, error: 'Say why. An approver deciding without a reason is rubber-stamping.' };
  }

  const pending = one(
    `SELECT * FROM approvals WHERE scope = ? AND entity = ? AND entity_id = ? AND status = 'Pending'`,
    [scope, spec.entity, entityId],
  );
  if (pending) {
    return {
      ok: false,
      error: `There is already a pending ${spec.label.toLowerCase()} on this record`,
      pending_id: pending.id,
    };
  }

  const info = run(
    `INSERT INTO approvals (scope, entity, entity_id, subject_name, payload, reason, requested_by)
     VALUES (?,?,?,?,?,?,?)`,
    [scope, spec.entity, entityId, subjectName ?? null,
      payload ? JSON.stringify(payload) : null, reason.trim(), requestedBy],
  );

  const row = byId(Number(info.lastInsertRowid));
  audit(requestedBy, 'approval_requested', spec.entity, entityId, { scope, reason });

  // Tell everyone who could decide it. An approval nobody knows about is a
  // record that sits still.
  for (const u of approversFor(scope)) {
    notify(u.id, `Approval needed: ${spec.label}`, spec.describe(row), '/approvals');
  }

  return { ok: true, request: row };
}

/** Who holds the capability that decides this scope. */
export function approversFor(scope) {
  const spec = APPROVAL_SCOPES[scope];
  if (!spec) return [];
  return all(
    `SELECT DISTINCT u.id, u.name, u.email FROM users u
     WHERE u.active = 1 AND (
       u.role IN (SELECT role_code FROM role_capabilities WHERE capability = ?)
       OR u.id IN (
         SELECT ups.user_id FROM user_permission_sets ups
         JOIN permission_sets ps ON ps.id = ups.set_id AND ps.active = 1
         JOIN permission_set_capabilities psc ON psc.set_id = ps.id
         WHERE psc.capability = ?
       )
     )`,
    [spec.approver, spec.approver],
  );
}

/* ---------------------------------------------------------- the lock */

/**
 * Is this record frozen by a pending approval?
 *
 * Called on the write path. Hiding the edit button is a courtesy; this is the
 * control, and it is what stops an approver signing off a number that has since
 * been changed underneath them.
 */
export function lockedBy(entity, entityId) {
  return one(
    `SELECT a.*, u.name AS requested_by_name FROM approvals a
     LEFT JOIN users u ON u.id = a.requested_by
     WHERE a.entity = ? AND a.entity_id = ? AND a.status = 'Pending'`,
    [entity, entityId],
  );
}

/** The refusal a route should return when a record is locked. */
export function lockRefusal(entity, entityId) {
  const lock = lockedBy(entity, entityId);
  if (!lock) return null;
  const spec = APPROVAL_SCOPES[lock.scope];
  return {
    error: `This record is waiting on an approval and cannot be changed`,
    detail: `${spec?.label ?? lock.scope} requested by ${lock.requested_by_name ?? 'someone'}: ${lock.reason}`,
    approval_id: lock.id,
  };
}

/* --------------------------------------------------------- deciding */

/**
 * Approve or reject.
 *
 * `apply` is passed in by the caller rather than looked up here, so this engine
 * never has to know what elevating a partner involves. It runs inside the same
 * transaction as the decision: an approval recorded against an action that then
 * failed is worse than no approval at all.
 */
export function decide(id, { approve, reason, decidedBy, apply }) {
  const req = byId(id);
  if (!req) return { ok: false, error: 'Approval not found' };
  if (req.status !== 'Pending') {
    return { ok: false, error: `This was already ${req.status.toLowerCase()}` };
  }

  // Never, whatever they hold. An approval you can grant yourself is a log line.
  if (Number(req.requested_by) === Number(decidedBy?.id)) {
    return { ok: false, error: 'You cannot approve your own request' };
  }

  const spec = APPROVAL_SCOPES[req.scope];
  const caps = decidedBy?.capabilities ?? new Set();
  if (spec && !caps.has(spec.approver)) {
    return { ok: false, error: `Deciding this needs ${spec.approver}` };
  }

  // Holding the capability is not the same as being in the right book. A
  // supervisor holds lead.reassign in whichever book they work in.
  if (!inReach(req, decidedBy)) {
    return { ok: false, error: 'This request belongs to another book' };
  }

  if (!approve && !reason?.trim()) {
    return { ok: false, error: 'Say why it was rejected — the requester has to know what to change.' };
  }

  try {
    return transact(() => {
      let applied = null;
      if (approve && typeof apply === 'function') applied = apply(req);

      run(
        `UPDATE approvals SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_reason = ?
         WHERE id = ?`,
        [approve ? 'Approved' : 'Rejected', decidedBy?.id ?? null, reason?.trim() ?? null, id],
      );

      audit(decidedBy?.id ?? null, approve ? 'approval_granted' : 'approval_rejected',
        req.entity, req.entity_id, { scope: req.scope, reason });

      if (req.requested_by) {
        notify(
          req.requested_by,
          approve ? `Approved: ${spec?.label ?? req.scope}` : `Rejected: ${spec?.label ?? req.scope}`,
          reason?.trim() || (approve ? 'Approved.' : 'Rejected.'),
          '/approvals',
        );
      }

      return { ok: true, request: byId(id), applied };
    });
  } catch (err) {
    // The whole transaction rolled back, so the request is still pending and
    // can be decided again once the underlying problem is fixed.
    return { ok: false, error: `Could not apply the change: ${err.message}` };
  }
}

/** Withdraw your own request. */
export function withdraw(id, user) {
  const req = byId(id);
  if (!req) return { ok: false, error: 'Approval not found' };
  if (req.status !== 'Pending') return { ok: false, error: `This was already ${req.status.toLowerCase()}` };
  if (Number(req.requested_by) !== Number(user.id)) {
    return { ok: false, error: 'Only the person who asked can withdraw it' };
  }
  run("UPDATE approvals SET status = 'Withdrawn', decided_at = datetime('now') WHERE id = ?", [id]);
  audit(user.id, 'approval_withdrawn', req.entity, req.entity_id, { scope: req.scope });
  return { ok: true };
}

/* -------------------------------------------------------- book scope */

/**
 * Which book an approval belongs to.
 *
 * The approvals table has no sales_org of its own, and should not grow one: a
 * request is always about a record, and the record already knows which book it
 * is in. Deriving it keeps the two from drifting apart, which a copied column
 * eventually always does.
 */
export const orgOf = (entity, entityId) => {
  const sql = {
    partner: 'SELECT sales_org FROM partners WHERE id = ?',
    lead: 'SELECT sales_org FROM leads WHERE id = ?',
  }[entity];
  if (!sql) return null;
  return one(sql, [entityId])?.sales_org ?? null;
};

/**
 * Whether this user's book covers the record an approval is about.
 *
 * Fails CLOSED on an entity with no mapping above. A new approval scope over a
 * new entity type should stop working visibly until someone adds it here,
 * rather than quietly becoming readable across both books -- which is exactly
 * how a Bigul supervisor came to hold a decide button on a Bonanza request.
 */
export const inReach = (row, user) => {
  if (!row || !user) return false;
  const org = orgOf(row.entity, row.entity_id);
  return org == null ? false : mayUseOrg(user, org);
};

/* ----------------------------------------------------------- reading */

export const byId = (id) => {
  const row = one(
    `SELECT a.*, rq.name AS requested_by_name, dc.name AS decided_by_name
     FROM approvals a
     LEFT JOIN users rq ON rq.id = a.requested_by
     LEFT JOIN users dc ON dc.id = a.decided_by
     WHERE a.id = ?`,
    [id],
  );
  if (!row) return null;
  return { ...row, payload: row.payload ? JSON.parse(row.payload) : null };
};

/**
 * What is waiting for this person.
 *
 * Their own requests are listed separately from the ones they can decide,
 * because "what am I waiting on?" and "what is waiting on me?" are different
 * questions and merging them makes both harder to answer.
 */
export function queueFor(user) {
  const caps = user?.capabilities ?? new Set();
  const decidable = Object.entries(APPROVAL_SCOPES)
    .filter(([, s]) => caps.has(s.approver))
    .map(([k]) => k);

  const decorate = (rows) => rows.map((r) => {
    const full = { ...r, payload: r.payload ? JSON.parse(r.payload) : null };
    const spec = APPROVAL_SCOPES[r.scope];
    return {
      ...full,
      label: spec?.label ?? r.scope,
      why: spec?.why ?? null,
      summary: spec ? spec.describe(full) : r.scope,
      // Never offer the button — the engine refuses anyway, but showing it and
      // then refusing is worse than not showing it.
      can_decide: decidable.includes(r.scope) && Number(r.requested_by) !== Number(user.id),
    };
  });

  const mine = all(
    `SELECT a.*, u.name AS requested_by_name FROM approvals a
     LEFT JOIN users u ON u.id = a.requested_by
     WHERE a.requested_by = ? ORDER BY a.created_at DESC LIMIT 50`,
    [user.id],
  );

  const waiting = decidable.length
    ? all(
      `SELECT a.*, u.name AS requested_by_name FROM approvals a
       LEFT JOIN users u ON u.id = a.requested_by
       WHERE a.status = 'Pending' AND a.requested_by != ?
         AND a.scope IN (${decidable.map(() => '?').join(',')})
       ORDER BY a.created_at ASC`,
      [user.id, ...decidable],
    )
    : [];

  // Both halves are filtered, not just the queue: "my requests" is listed by
  // requester id, which is already one person, but a user moved between books
  // would otherwise keep seeing what they raised in the old one.
  const here = (rows) => rows.filter((r) => inReach(r, user));

  return {
    waiting_on_me: decorate(here(waiting)),
    my_requests: decorate(here(mine)),
  };
}

export const history = (entity, entityId) => all(
  `SELECT a.*, rq.name AS requested_by_name, dc.name AS decided_by_name
   FROM approvals a
   LEFT JOIN users rq ON rq.id = a.requested_by
   LEFT JOIN users dc ON dc.id = a.decided_by
   WHERE a.entity = ? AND a.entity_id = ? ORDER BY a.created_at DESC`,
  [entity, entityId],
).map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
