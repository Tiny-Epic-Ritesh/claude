/**
 * Lead Lists (BUG-25).
 *
 * A list is a saved question, not a grant. Membership is composed with the
 * reader's own scope on every read, so sharing a list never widens what someone
 * can see — a supervisor and an RM opening the same list correctly get
 * different row counts.
 *
 * The bulk actions are the reason this module needs care. They are the fastest
 * way to do something regrettable to several thousand client records at once,
 * so every one of them states its count before it runs, filters for consent
 * before it sends, and writes one audit row per record rather than one per
 * action — because "was this client contacted" has to stay answerable.
 */

import { Router } from 'express';
import { all, one, run, audit, notify, LEAD_STAGES } from '../db.js';
import {
  requireUser, requirePermission, reqScope, activeOrg, orgsFor, can,
} from '../auth.js';
import { validate } from '../security.js';
import { validateTree, describe } from '../engine/conditions.js';
import {
  LIST_KINDS, KIND_LABEL, KIND_HELP, normaliseKind, membersSql, refreshList,
  mayReadList, mayWriteList,
} from '../engine/leadlists.js';
import { checkConsent } from '../engine/consent.js';
import { send } from '../integrations.js';

const router = Router();
router.use(requireUser);

/** The largest set one action may touch. Past this, it is an import job. */
const BULK_CAP = 5000;

/**
 * Why a send was suppressed, in words a marketer can act on.
 *
 * Grouped by code rather than by the consent engine's message, because that
 * message names the person — "Arnav's mobile number is flagged invalid" — which
 * is right on one record and useless in a summary, where it produces one row
 * per lead instead of a count.
 */
const SUPPRESSION_LABEL = {
  no_destination: 'no contact detail on record',
  invalid_destination: 'contact detail flagged invalid',
  channel_opted_out: 'opted out of this channel',
  opted_out: 'opted out of marketing',
  unknown_channel: 'channel not available',
  no_lead: 'record missing',
};

const tally = (counts) => [...counts]
  .map(([code, count]) => ({ code, count, reason: SUPPRESSION_LABEL[code] ?? code }))
  .sort((a, b) => b.count - a.count);

const loadList = (req) => one('SELECT * FROM lead_lists WHERE id = ?', [req.params.id]);

/**
 * Resolve a list to lead ids the caller may actually see.
 *
 * membersSql answers "what is in this list"; reqScope answers "what may this
 * person open". Both, always, ANDed.
 */
function memberIds(list, req, cap = BULK_CAP) {
  const members = membersSql(list);
  const scope = reqScope(req, 'l');
  return all(
    `SELECT l.id FROM leads l
      WHERE l.deleted_at IS NULL AND (${members.sql}) AND (${scope.sql})
      LIMIT ?`,
    [...members.params, ...scope.params, cap],
  ).map((r) => r.id);
}

function memberCount(list, req) {
  const members = membersSql(list);
  const scope = reqScope(req, 'l');
  return one(
    `SELECT COUNT(*) n FROM leads l
      WHERE l.deleted_at IS NULL AND (${members.sql}) AND (${scope.sql})`,
    [...members.params, ...scope.params],
  ).n;
}

/* --------------------------------------------------------------- meta */

router.get('/meta', (_req, res) => res.json({
  kinds: LIST_KINDS.map((k) => ({ code: k, label: KIND_LABEL[k], help: KIND_HELP[k] })),
  stages: LEAD_STAGES,
  bulk_cap: BULK_CAP,
}));

/* --------------------------------------------------------------- list */

router.get('/', (req, res) => {
  const orgs = orgsFor(req.user);
  const rows = all(
    `SELECT ll.*, u.name AS owner_name, r.name AS refreshed_by_name
       FROM lead_lists ll
       LEFT JOIN users u ON u.id = ll.owner_id
       LEFT JOIN users r ON r.id = ll.last_refreshed_by
      WHERE ll.sales_org IN (${orgs.map(() => '?').join(',') || "''"})
      ORDER BY ll.created_at DESC`,
    orgs,
  ).filter((l) => mayReadList(l, req.user));

  res.json(rows.map((l) => ({
    ...l,
    kind: normaliseKind(l.kind),
    kind_label: KIND_LABEL[normaliseKind(l.kind)],
    // Counted under the reader's scope, so the number on the card always
    // matches the number of rows they get when they open it.
    member_count: memberCount(l, req),
  })));
});

/* ------------------------------------------------------------- create */

router.post('/', requirePermission('list.create'), (req, res) => {
  const { name, kind = 'static', criteria = null, description = null, shared_with = [] } = req.body ?? {};

  const bad = validate(req.body, { name: ['required', 'max:120'] });
  if (bad) return res.status(400).json(bad);

  const k = normaliseKind(kind);
  if (!LIST_KINDS.includes(kind)) {
    return res.status(400).json({ error: `Kind must be one of: ${LIST_KINDS.join(', ')}` });
  }

  // A filter-driven list without a filter is not a list, it is an empty set
  // waiting to confuse someone.
  if (k !== 'static') {
    if (!criteria) {
      return res.status(400).json({ error: `A ${KIND_LABEL[k].toLowerCase()} list needs a filter to build from.` });
    }
    const problems = validateTree(criteria);
    if (problems.length) return res.status(400).json({ error: problems[0].error, problems });
  }

  const org = activeOrg(req) || req.user.sales_org;
  const result = run(
    `INSERT INTO lead_lists (name, kind, criteria, description, owner_id, created_by, shared_with, sales_org, updated_at)
     VALUES (?,?,?,?,?,?,?,?, datetime('now'))`,
    [
      String(name).trim(), k, criteria ? JSON.stringify(criteria) : null,
      description || (criteria ? describe(criteria) : null),
      req.user.id, req.user.id, JSON.stringify(shared_with), org,
    ],
  );

  const id = Number(result.lastInsertRowid);
  // A refreshable list is built once at creation, so it is never born empty.
  if (k === 'refreshable') refreshList(id, req.user.id);

  audit(req.user.id, 'list.create', 'lead_list', id, { kind: k, name });
  const list = one('SELECT * FROM lead_lists WHERE id = ?', [id]);
  res.status(201).json({ ...list, member_count: memberCount(list, req) });
});

/* ------------------------------------------------------------- detail */

router.get('/:id', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const members = membersSql(list);
  const scope = reqScope(req, 'l');
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const total = memberCount(list, req);
  const rows = all(
    `SELECT l.id, l.name, l.mobile, l.email, l.stage, l.source, l.sales_org,
            l.client_code, l.marketing_opt_out, l.no_call, l.no_sms, l.no_email,
            l.no_whatsapp, l.mobile_invalid, l.created_at,
            u.name AS owner_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.owner_id
      WHERE l.deleted_at IS NULL AND (${members.sql}) AND (${scope.sql})
      ORDER BY l.updated_at DESC
      LIMIT ? OFFSET ?`,
    [...members.params, ...scope.params, limit, offset],
  );

  let criteria = null;
  try { criteria = list.criteria ? JSON.parse(list.criteria) : null; } catch { criteria = null; }

  res.set('X-Total-Count', String(total));
  res.json({
    ...list,
    kind: normaliseKind(list.kind),
    kind_label: KIND_LABEL[normaliseKind(list.kind)],
    kind_help: KIND_HELP[normaliseKind(list.kind)],
    criteria,
    criteria_text: criteria ? describe(criteria) : null,
    member_count: total,
    may_edit: mayWriteList(list, req.user),
    // Stated on the list itself, so nobody has to remember the rule.
    campaign_safe: normaliseKind(list.kind) !== 'dynamic',
    members: rows,
  });
});

/* ------------------------------------------------------------ refresh */

router.post('/:id/refresh', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });
  if (!mayWriteList(list, req.user)) return res.status(403).json({ error: 'Only the list owner or an admin can refresh it' });

  const r = refreshList(list.id, req.user.id);
  if (!r.ok) return res.status(400).json({ error: r.error });

  const fresh = one('SELECT * FROM lead_lists WHERE id = ?', [list.id]);
  res.json({ ...r, list: { ...fresh, member_count: memberCount(fresh, req) } });
});

/* ------------------------------------------------------- membership */

const requireStatic = (list, res) => {
  if (normaliseKind(list.kind) === 'dynamic') {
    res.status(400).json({ error: 'A dynamic list is defined by its filter. Change the filter, not the members.' });
    return false;
  }
  return true;
};

router.post('/:id/members', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });
  if (!mayWriteList(list, req.user)) return res.status(403).json({ error: 'Only the list owner or an admin can change membership' });
  if (!requireStatic(list, res)) return;

  const ids = (req.body?.lead_ids ?? []).map(Number).filter(Boolean).slice(0, BULK_CAP);
  if (!ids.length) return res.status(400).json({ error: 'Choose at least one lead' });

  // Only leads the caller can actually see may be added — otherwise a list
  // becomes a way to launder visibility.
  const scope = reqScope(req, 'l');
  const allowed = all(
    `SELECT l.id FROM leads l
      WHERE l.deleted_at IS NULL AND l.id IN (${ids.map(() => '?').join(',')}) AND (${scope.sql})`,
    [...ids, ...scope.params],
  ).map((r) => r.id);

  for (const id of allowed) {
    run('INSERT OR IGNORE INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [list.id, id]);
  }
  audit(req.user.id, 'list.members.add', 'lead_list', list.id, { added: allowed.length, requested: ids.length });
  res.json({ added: allowed.length, skipped: ids.length - allowed.length });
});

router.delete('/:id/members/:leadId', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });
  if (!mayWriteList(list, req.user)) return res.status(403).json({ error: 'Only the list owner or an admin can change membership' });
  if (!requireStatic(list, res)) return;

  run('DELETE FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [list.id, req.params.leadId]);
  audit(req.user.id, 'list.members.remove', 'lead_list', list.id, { lead_id: Number(req.params.leadId) });
  res.json({ ok: true });
});

/* --------------------------------------------------------------- bulk */

/**
 * What a bulk action would do, before it does it.
 *
 * Every destructive or outbound action goes through this first, and the client
 * shows the count it returns. "412 of 500 will receive this, 88 suppressed" is
 * the difference between an informed decision and a surprise.
 */
router.post('/:id/preview', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const { action, channel } = req.body ?? {};
  const ids = memberIds(list, req);

  if (action !== 'message') {
    return res.json({ action, total: ids.length, will_apply: ids.length, suppressed: 0, reasons: [] });
  }

  const reasons = new Map();
  let willSend = 0;
  for (const id of ids) {
    const lead = one('SELECT * FROM leads WHERE id = ?', [id]);
    const verdict = checkConsent(lead, channel, 'marketing');
    if (verdict.allowed) { willSend += 1; continue; }
    reasons.set(verdict.code, (reasons.get(verdict.code) || 0) + 1);
  }

  res.json({
    action: 'message',
    channel,
    total: ids.length,
    will_apply: willSend,
    suppressed: ids.length - willSend,
    reasons: tally(reasons),
  });
});

/** Reassign every member to one owner. */
router.post('/:id/bulk/reassign', requirePermission('lead.reassign'), (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const ownerId = Number(req.body?.owner_id);
  const owner = one('SELECT id, name, sales_org FROM users WHERE id = ? AND active = 1', [ownerId]);
  if (!owner) return res.status(400).json({ error: 'Choose an active user' });

  const ids = memberIds(list, req);
  let moved = 0;
  for (const id of ids) {
    const lead = one('SELECT id, owner_id, sales_org FROM leads WHERE id = ?', [id]);
    // Never move a lead into a business its new owner does not work in.
    if (!lead || lead.sales_org !== owner.sales_org) continue;
    run("UPDATE leads SET owner_id = ?, updated_at = datetime('now') WHERE id = ?", [ownerId, id]);
    // One row per record: "who was moved, and by whom" must stay answerable.
    audit(req.user.id, 'lead.reassign', 'lead', id, { from: lead.owner_id, to: ownerId, via_list: list.id });
    moved += 1;
  }

  notify(ownerId, 'Leads assigned to you', `${moved} leads from "${list.name}"`, '/leads');
  res.json({ ok: true, requested: ids.length, moved, skipped: ids.length - moved });
});

/** Move every member to one stage. */
router.post('/:id/bulk/stage', requirePermission('lead.stage.change'), (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const stage = req.body?.stage;
  if (!LEAD_STAGES.includes(stage)) {
    return res.status(400).json({ error: `Stage must be one of: ${LEAD_STAGES.join(', ')}` });
  }

  const ids = memberIds(list, req);
  for (const id of ids) {
    const before = one('SELECT stage FROM leads WHERE id = ?', [id]);
    if (!before || before.stage === stage) continue;
    run("UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE id = ?", [stage, id]);
    audit(req.user.id, 'lead.stage.change', 'lead', id, { from: before.stage, to: stage, via_list: list.id });
  }
  res.json({ ok: true, applied: ids.length, stage });
});

/** Create the same task against every member. */
router.post('/:id/bulk/task', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Give the task a title' });
  // due_at is NOT NULL, and a bulk task with no date is a bulk task nobody
  // does. Default to tomorrow rather than rejecting the request.
  const dueAt = req.body?.due_at
    || new Date(Date.now() + 864e5).toISOString().slice(0, 19).replace('T', ' ');

  const ids = memberIds(list, req);
  for (const id of ids) {
    const lead = one('SELECT owner_id FROM leads WHERE id = ?', [id]);
    run(
      `INSERT INTO tasks (lead_id, title, due_at, assignee_id, created_by, status)
       VALUES (?,?,?,?,?, 'Open')`,
      [id, title, dueAt, lead?.owner_id ?? req.user.id, req.user.id],
    );
  }
  audit(req.user.id, 'list.bulk.task', 'lead_list', list.id, { count: ids.length, title });
  res.json({ ok: true, created: ids.length });
});

/**
 * Bulk message.
 *
 * Consent is filtered here, not at the vendor, and the response reports exactly
 * who was suppressed and why. A send that silently drops half its audience is
 * indistinguishable from a broken integration.
 */
router.post('/:id/bulk/message', requirePermission('lead.contact'), (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const { channel, body, intent = 'marketing' } = req.body ?? {};
  if (!['sms', 'whatsapp', 'email'].includes(channel)) {
    return res.status(400).json({ error: 'Channel must be sms, whatsapp or email' });
  }
  if (!String(body || '').trim()) return res.status(400).json({ error: 'Write a message first' });

  const ids = memberIds(list, req);
  const reasons = new Map();
  let sent = 0;

  for (const id of ids) {
    const lead = one('SELECT * FROM leads WHERE id = ?', [id]);
    const verdict = checkConsent(lead, channel, intent);
    if (!verdict.allowed) {
      reasons.set(verdict.code, (reasons.get(verdict.code) || 0) + 1);
      continue;
    }
    // send() wants a destination, not a record — it has no business knowing
    // what a lead is.
    send(channel, {
      to: channel === 'email' ? lead.email : lead.mobile,
      body,
      subject: channel === 'email' ? `A note from ${req.user.name}` : undefined,
      leadId: id,
      userName: req.user.name,
    });
    run(
      `INSERT INTO activities (lead_id, type, direction, subject, body, user_id)
       VALUES (?,?, 'outbound', ?, ?, ?)`,
      [id, channel === 'email' ? 'Email' : channel === 'sms' ? 'SMS' : 'WhatsApp',
        `Bulk send from "${list.name}"`, body, req.user.id],
    );
    audit(req.user.id, 'lead.message', 'lead', id, { channel, intent, via_list: list.id });
    sent += 1;
  }

  res.json({
    ok: true,
    total: ids.length,
    sent,
    suppressed: ids.length - sent,
    reasons: tally(reasons),
  });
});

/* ------------------------------------------------------------- delete */

router.delete('/:id', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });
  if (!mayWriteList(list, req.user)) return res.status(403).json({ error: 'Only the list owner or an admin can delete it' });

  // A campaign pointing at a deleted list would lose its audience record, and
  // with it the ability to say who a send went to.
  const used = one('SELECT COUNT(*) n FROM campaigns WHERE list_id = ?', [list.id]).n;
  if (used) {
    return res.status(409).json({
      error: `"${list.name}" is used by ${used} campaign${used === 1 ? '' : 's'}. Detach it there first.`,
    });
  }

  run('DELETE FROM lead_lists WHERE id = ?', [list.id]);
  audit(req.user.id, 'list.delete', 'lead_list', list.id, { name: list.name });
  res.json({ ok: true });
});

export default router;
