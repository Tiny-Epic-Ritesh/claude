/**
 * Internal messaging — P3-21, phase 1.
 *
 * The rules live in engine/messaging.js; this is their HTTP shape, and the two
 * capability gates. Reviewing needs comms.monitor and the grid needs
 * admin.roles. Both are read from req.caps rather than from the role, so a
 * permission set granting either to one named person works.
 */

import { Router } from 'express';
import { requireUser } from '../auth.js';
import { rateLimiter } from '../security.js';
import * as M from '../engine/messaging.js';

const router = Router();
router.use(requireUser);

/** The signed-in person with what they may do. The engine needs both. */
const me = (req) => ({ ...req.user, capabilities: req.caps });

const needs = (capability, why) => (req, res, next) => (
  req.caps?.has(capability)
    ? next()
    : res.status(403).json({ error: why, required: capability })
);
const reviewer = needs('comms.monitor', 'Reviewing conversations needs comms.monitor');
const gridAdmin = needs('admin.roles', 'Changing who may message whom needs admin.roles');

/* Sixty a minute each: plenty for anybody typing, not enough for a script. */
const sending = rateLimiter({
  name: 'message-send', limit: 60, windowMs: 60_000, by: (req) => `u${req.user?.id ?? req.ip}`,
});

const answer = (res, out, created = false) => (out.ok
  ? res.status(created ? 201 : 200).json(out)
  : res.status(out.status ?? 400).json({ error: out.error }));

const idOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/* ------------------------------------------------------------ talking */

router.get('/unread', (req, res) => res.json(M.unreadFor(req.user.id)));

router.get('/people', (req, res) => res.json(M.peopleFor(me(req), String(req.query.q ?? '').trim())));

router.get('/conversations', (req, res) => res.json({
  conversations: M.conversationsFor(me(req)),
  notice: M.MONITORING_NOTICE,
  suspended: M.suspensionOf(req.user.id)?.reason ?? null,
}));

router.post('/conversations', (req, res) => {
  const out = M.openDirect(me(req), req.body?.user_id);
  return answer(res, out, out.ok && out.created);
});

router.get('/conversations/:id/messages', (req, res) => {
  const id = idOf(req.params.id);
  // Not a member reads exactly like not there.
  if (!id || !M.isMember(id, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
  return res.json({
    conversation: M.conversationSummary(id, me(req)),
    messages: M.messagesFor(me(req), id, { after: req.query.after, limit: req.query.limit }),
  });
});

router.post('/conversations/:id/messages', sending, (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(404).json({ error: 'Conversation not found' });
  return answer(res, M.send(me(req), id, { body: req.body?.body, leadId: req.body?.lead_id ?? null }), true);
});

router.post('/conversations/:id/read', (req, res) => {
  const id = idOf(req.params.id);
  if (!id || !M.isMember(id, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
  M.markRead(req.user.id, id, req.body?.last_id);
  return res.json({ ok: true, ...M.unreadFor(req.user.id) });
});

router.post('/message/:id/withdraw', (req, res) => answer(res, M.withdrawMessage(me(req), idOf(req.params.id))));

router.post('/transfer', sending, (req, res) => answer(res, M.requestTransfer(me(req), {
  leadId: req.body?.lead_id, toUserId: req.body?.to_user_id, reason: req.body?.reason,
}), true));

/* ------------------------------------------------------------ the grid */

router.get('/policy', gridAdmin, (req, res) => res.json(M.policyGrid()));
router.put('/policy', gridAdmin, (req, res) => answer(res, M.setPolicy(me(req), req.body ?? {})));

/* ------------------------------------------------------------ reviewing */

router.get('/monitor', reviewer, (req, res) => res.json(M.monitorList(me(req))));
router.get('/monitor/:id', reviewer, (req, res) => answer(res, M.monitorRead(me(req), idOf(req.params.id))));

router.post('/conversations/:id/freeze', reviewer, (req, res) => answer(
  res, M.freeze(me(req), idOf(req.params.id), req.body?.reason),
));
router.post('/conversations/:id/unfreeze', reviewer, (req, res) => answer(
  res, M.unfreeze(me(req), idOf(req.params.id)),
));

router.get('/suspensions', reviewer, (req, res) => res.json(M.suspensionsFor(me(req))));
router.post('/suspensions', reviewer, (req, res) => answer(
  res, M.suspend(me(req), idOf(req.body?.user_id), req.body?.reason), true,
));
router.delete('/suspensions/:userId', reviewer, (req, res) => answer(
  res, M.unsuspend(me(req), idOf(req.params.userId)),
));

export default router;
