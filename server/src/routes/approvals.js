/**
 * Approvals.
 *
 * The engine (`engine/approvals.js`) knows how to hold a request, lock a record
 * and record a decision. This file knows what each decision actually *does* —
 * the `apply` function handed to `decide()` — so the engine never learns what
 * elevating a partner involves and adding a fifth scope touches one place.
 */

import { Router } from 'express';
import { all, one, run, audit } from '../db.js';
import { requireUser, requirePermission } from '../auth.js';
import { newPartnerCode, issuePortalCredential } from './partners-support.js';
import {
  APPROVAL_SCOPES, BULK_THRESHOLD, request, decide, withdraw, byId,
  queueFor, history, lockedBy, approversFor,
} from '../engine/approvals.js';

const router = Router();
router.use(requireUser);

/**
 * What each approval does once granted.
 *
 * Every one runs inside the engine's transaction, so a failure here rolls the
 * decision back and leaves the request pending rather than recording an
 * approval for something that did not happen.
 */
const APPLY = {
  partner_elevation: (req) => {
    const partner = one('SELECT * FROM partners WHERE id = ?', [req.entity_id]);
    if (!partner) throw new Error('Partner no longer exists');
    if (partner.partner_code) throw new Error(`${partner.name} is already elevated`);

    const code = newPartnerCode(partner);
    const credential = issuePortalCredential(partner);
    run(
      "UPDATE partners SET partner_code = ?, state_code = 'ACTIVE', onboarded_at = datetime('now') WHERE id = ?",
      [code, partner.id],
    );
    return { partner_code: code, portal_login: credential };
  },

  partner_closure: (req) => {
    const state = req.payload?.state_code ?? 'SUSPENDED';
    run('UPDATE partners SET state_code = ? WHERE id = ?', [state, req.entity_id]);
    return { state_code: state };
  },

  commission_change: (req) => {
    const pct = Number(req.payload?.commission_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Commission must be between 0 and 100');
    run('UPDATE partners SET commission_pct = ? WHERE id = ?', [pct, req.entity_id]);
    return { commission_pct: pct };
  },

  bulk_reassign: (req) => {
    const ids = req.payload?.lead_ids ?? [];
    const owner = Number(req.payload?.owner_id);
    if (!ids.length || !owner) throw new Error('Nothing to move, or nobody to move it to');

    let moved = 0;
    for (const id of ids) {
      // owner_queue_id is cleared too: a lead cannot be owned by a person and a
      // queue at once.
      const r = run(
        "UPDATE leads SET owner_id = ?, owner_queue_id = NULL, updated_at = datetime('now') WHERE id = ?",
        [owner, id],
      );
      moved += r.changes;
    }
    return { moved };
  },
};

/* ------------------------------------------------------------ reading */

/** What is waiting on me, and what I am waiting on. */
router.get('/', (req, res) => {
  res.json({
    ...queueFor({ id: req.user.id, capabilities: req.caps }),
    scopes: Object.entries(APPROVAL_SCOPES).map(([key, s]) => ({
      key, label: s.label, why: s.why, approver: s.approver,
    })),
    bulk_threshold: BULK_THRESHOLD,
  });
});

router.get('/:id', (req, res) => {
  const row = byId(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Approval not found' });
  return res.json(row);
});

/** Everything that has ever been asked about one record. */
router.get('/history/:entity/:id', (req, res) => {
  res.json(history(req.params.entity, Number(req.params.id)));
});

/* --------------------------------------------------------- requesting */

router.post('/', (req, res) => {
  const { scope, entity_id: entityId, payload, reason } = req.body ?? {};
  const spec = APPROVAL_SCOPES[scope];
  if (!spec) return res.status(400).json({ error: `${scope} is not something that can be approved` });

  // The requester needs the capability to *ask*, which is the ordinary
  // permission for the action — approval is a second gate, not the only one.
  const REQUEST_CAP = {
    partner_elevation: 'partner.elevate.request',
    partner_closure: 'partner.view',
    commission_change: 'partner.view',
    bulk_reassign: 'lead.reassign',
  };
  const needed = REQUEST_CAP[scope];
  if (needed && !req.caps.has(needed)) {
    return res.status(403).json({ error: `Requesting this needs ${needed}`, required: needed });
  }

  const subject = spec.entity === 'partner'
    ? one('SELECT name FROM partners WHERE id = ?', [entityId])?.name
    : one('SELECT name FROM users WHERE id = ?', [payload?.owner_id])?.name;

  const out = request({
    scope,
    entityId: Number(entityId),
    subjectName: subject ?? null,
    payload,
    reason,
    requestedBy: req.user.id,
  });

  if (!out.ok) return res.status(409).json(out);
  return res.status(201).json(out.request);
});

/* ---------------------------------------------------------- deciding */

router.post('/:id/decide', (req, res) => {
  const { approve, reason } = req.body ?? {};
  const row = byId(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Approval not found' });

  const out = decide(Number(req.params.id), {
    approve: Boolean(approve),
    reason,
    decidedBy: { id: req.user.id, capabilities: req.caps },
    apply: APPLY[row.scope],
  });

  if (!out.ok) return res.status(409).json(out);
  return res.json(out);
});

router.post('/:id/withdraw', (req, res) => {
  const out = withdraw(Number(req.params.id), req.user);
  if (!out.ok) return res.status(409).json(out);
  return res.json(out);
});

/** Who could decide this scope — shown to a requester before they ask. */
router.get('/scopes/:scope/approvers', (req, res) => {
  if (!APPROVAL_SCOPES[req.params.scope]) return res.status(404).json({ error: 'Unknown scope' });
  res.json(approversFor(req.params.scope).map((u) => ({ id: u.id, name: u.name })));
});

void all;
void audit;
void requirePermission;
void lockedBy;
export default router;
