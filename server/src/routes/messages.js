/**
 * Internal messaging — P3-21, phase 1.
 *
 * The rules live in engine/messaging.js; this is their HTTP shape, and the two
 * capability gates. Reviewing needs comms.monitor and the grid needs
 * admin.roles. Both are read from req.caps rather than from the role, so a
 * permission set granting either to one named person works.
 */

import express, { Router } from 'express';
import { requireUser } from '../auth.js';
import { rateLimiter } from '../security.js';
import * as M from '../engine/messaging.js';
import * as C from '../engine/channels.js';
import * as F from '../engine/messagefiles.js';
import { listen } from '../engine/messagelive.js';

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

/* The wire format: a retry hint, then `event:` and `data:` lines, each
   record ended by a blank line. */
const BREAK = '\n\n';
const RETRY = 'retry: 5000' + BREAK;
const EVENT = 'event: change' + '\n' + 'data: ';
const BEAT = ': keep-alive' + BREAK;

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
  return answer(res, M.send(me(req), id, {
    body: req.body?.body,
    leadId: req.body?.lead_id ?? null,
    parentId: req.body?.parent_id ?? null,
    mentions: Array.isArray(req.body?.mentions) ? req.body.mentions : [],
    fileId: req.body?.file_id ?? null,
  }), true);
});

router.post('/conversations/:id/read', (req, res) => {
  const id = idOf(req.params.id);
  if (!id || !M.isMember(id, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
  M.markRead(req.user.id, id, req.body?.last_id);
  return res.json({ ok: true, ...M.unreadFor(req.user.id) });
});

router.get('/conversations/:id/thread/:messageId', (req, res) => {
  const id = idOf(req.params.id);
  if (!id || !M.isMember(id, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
  return answer(res, M.threadFor(me(req), id, idOf(req.params.messageId)));
});

router.post('/message/:id/withdraw', (req, res) => answer(res, M.withdrawMessage(me(req), idOf(req.params.id))));
router.post('/message/:id/react', (req, res) => answer(res, C.react(me(req), idOf(req.params.id), req.body?.emoji)));

/* A POST, not a GET, so the mobile number never sits in a URL -- where the
   access log would keep it. Twenty an hour each: enough for the clients who
   ring you, not enough to walk a colleague's book one number at a time. */
const lookingUp = rateLimiter({
  name: 'lead-lookup', limit: 20, windowMs: 60 * 60_000, by: (req) => `u${req.user?.id ?? req.ip}`,
});
router.post('/lookup', lookingUp, (req, res) => answer(res, M.lookupLeads(me(req), {
  mobile: req.body?.mobile, name: req.body?.name,
})));

router.post('/transfer', sending, (req, res) => answer(res, M.requestTransfer(me(req), {
  leadId: req.body?.lead_id, toUserId: req.body?.to_user_id, reason: req.body?.reason,
}), true));

/* --------------------------------------------------------------- files */

/* Raw bytes rather than a multipart form, as the brochure upload does: one
   route, no parsing dependency, and the browser can send the file as it is.
   The ceiling here is a little above the engine's, so a file just over the
   limit is refused in our own words rather than by the body parser. */
router.post(
  '/conversations/:id/files',
  express.raw({ type: '*/*', limit: F.MAX_BYTES + 4096 }),
  (req, res) => answer(res, F.upload(me(req), idOf(req.params.id), req.body, req.get('X-Filename')), true),
);

/**
 * The bytes.
 *
 * Inline, so an image shows in the conversation and a PDF opens in a tab, and
 * with `nosniff` and a filename so nothing uploaded can be served as something
 * that runs. Not cached by any shared cache: this is client-adjacent material
 * behind a session.
 */
router.get('/files/:id', (req, res) => {
  const out = F.bytesFor(me(req), idOf(req.params.id));
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.set({
    'Content-Type': out.file.mime,
    'Content-Length': String(out.file.size),
    'Content-Disposition': `inline; filename="${out.file.filename.replace(/"/g, '')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0, no-store',
  });
  return res.send(out.file.bytes);
});

/* -------------------------------------------------------------- search */

router.get('/search', (req, res) => res.json(M.searchMessages(me(req), req.query.q, { limit: req.query.limit })));

/* --------------------------------------------------------------- live */

/**
 * One long response, a line per change (P3-21 phase 3).
 *
 * `no-transform` and `X-Accel-Buffering: no` ask any proxy in front not to sit
 * on the bytes -- which is what makes this work without the nginx change a
 * WebSocket would need. A comment every 25 seconds keeps an idle stream from
 * being closed as dead, and the screens keep polling, slowly, so a stream that
 * never arrives costs a slower refresh rather than a page that silently stops.
 */
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(RETRY);

  // Membership is asked per event rather than cached: somebody added to a
  // channel while the stream is open should start hearing it at once.
  const stop = listen((event) => {
    if (!M.isMember(event.conversation_id, req.user.id)) return;
    res.write(EVENT + JSON.stringify(event) + BREAK);
  });
  const beat = setInterval(() => res.write(BEAT), 25_000);

  req.on('close', () => { clearInterval(beat); stop(); res.end(); });
});

/* ------------------------------------------------------------ channels */

router.get('/channels', (req, res) => res.json(C.browse(me(req))));
router.post('/channels', sending, (req, res) => answer(res, C.createChannel(me(req), req.body ?? {}), true));
router.post('/channels/:id/join', (req, res) => answer(res, C.join(me(req), idOf(req.params.id))));
router.post('/channels/:id/leave', (req, res) => answer(res, C.leave(me(req), idOf(req.params.id))));
router.get('/channels/:id/candidates', (req, res) => answer(
  res, C.candidates(me(req), idOf(req.params.id), String(req.query.q ?? '').trim()),
));
router.post('/channels/:id/members', (req, res) => answer(
  res, C.addMember(me(req), idOf(req.params.id), idOf(req.body?.user_id)), true,
));
router.delete('/channels/:id/members/:userId', (req, res) => answer(
  res, C.removeMember(me(req), idOf(req.params.id), idOf(req.params.userId)),
));
router.post('/channels/:id/archive', (req, res) => answer(res, C.archive(me(req), idOf(req.params.id))));
router.post('/channels/:id/unarchive', (req, res) => answer(res, C.unarchive(me(req), idOf(req.params.id))));

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
