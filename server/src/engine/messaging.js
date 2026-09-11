/**
 * Internal messaging — P3-21, phase 1.
 *
 * WHAT THIS IS
 *
 * One-to-one conversations between colleagues, under a policy an administrator
 * sets, watched by a reviewer who can read, freeze and stop somebody sending.
 * Phase 2 adds channels, which is why a conversation has a `kind` and its
 * members are rows rather than two columns.
 *
 * THE THREE RULES THAT MATTER
 *
 * 1. Who may message whom is checked on every send, not only when a
 *    conversation is opened. A reply is a message too, and an administrator
 *    who closes a pair expects it closed today, not only for conversations
 *    that have not started yet.
 *
 * 2. A lead attached to a message is a pointer, never a copy. It is drawn for
 *    each reader through their own leadScope and masking, so a Bigul colleague
 *    sent a Bonanza lead sees "a lead you cannot open". Opening a conversation
 *    across the two books never opens the records.
 *
 * 3. Nothing is deleted. A sender may withdraw a message for a short window;
 *    the other person then sees that it was withdrawn, and a reviewer still
 *    sees what it said. How long messages are kept is a question for the
 *    compliance officer (P3-21 design, section 7), and until it is answered the
 *    answer is all of them.
 */

import { all, one, run, audit, notify, transact } from '../db.js';
import { orgsFor, leadScope, mayUseOrg } from '../auth.js';
import { effectiveCapabilities } from './access.js';
import { maskRecord } from '../security.js';
import { maskedFieldsFor } from './masking.js';
import { auditConfig } from './metadata.js';
import { request as requestApproval, byId as approvalById, mayDecide } from './approvals.js';

/* ----------------------------------------------------------- constants */

/** A grid cell: closed, open inside a shared book, or open across both. */
export const REACH = Object.freeze(['blocked', 'same_book', 'any_book']);
export const DEFAULT_REACH = 'same_book';

export const WITHDRAW_WINDOW_MINUTES = 15;
export const MAX_BODY = 4000;

/** Ritesh, 11 September: monitoring is disclosed, as a standing notice. */
export const MONITORING_NOTICE = 'Messages here can be reviewed by compliance.';

/* ------------------------------------------------------------- people */

const USER_COLUMNS = 'id, name, role, sales_org, org_access, active, manager_id';

const userRow = (id) => (id ? one(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]) : null);

const publicUser = ({ id, name, role, sales_org: salesOrg }) => ({ id, name, role, sales_org: salesOrg });

const roleNames = () => new Map(all('SELECT code, name FROM roles').map((r) => [r.code, r.name]));

/* ------------------------------------------------------------- policy */

/** The grid's answer for one pair of roles. No row means the default. */
export function reachFor(fromRole, toRole) {
  return one(
    'SELECT reach FROM messaging_policy WHERE from_role = ? AND to_role = ?',
    [fromRole, toRole],
  )?.reach ?? DEFAULT_REACH;
}

/* Two people share a book when either could work in a book the other does.
   A superadmin spans both, so for them "same book" is every book. */
const shareABook = (a, b) => {
  const mine = new Set(orgsFor(a));
  return orgsFor(b).some((o) => mine.has(o));
};

export const suspensionOf = (userId) => one(
  `SELECT s.*, u.name AS suspended_by_name FROM messaging_suspension s
   LEFT JOIN users u ON u.id = s.suspended_by WHERE s.user_id = ?`,
  [userId],
);

/**
 * Why `from` may not send to `to`, or null when they may.
 *
 * Returned as a sentence rather than a code, because it is shown as it stands:
 * somebody refused a message has to know whether to try again, ask an
 * administrator, or give up.
 */
export function refusalToMessage(from, to) {
  if (!to || !Number(to.active)) return 'That person is not an active user';
  if (Number(from.id) === Number(to.id)) return 'You cannot message yourself';

  const suspended = suspensionOf(from.id);
  if (suspended) return `Your messaging is suspended: ${suspended.reason}`;

  const reach = reachFor(from.role, to.role);
  if (reach === 'blocked') {
    const names = roleNames();
    return `Messages from ${names.get(from.role) ?? from.role} to ${names.get(to.role) ?? to.role} are switched off by your administrator`;
  }
  if (reach === 'same_book' && !shareABook(from, to)) {
    return `${to.name} works in the other business, and your administrator has not opened messages between the two for your role`;
  }
  return null;
}

/** People this person may start a conversation with. */
export function peopleFor(user, q = '') {
  const like = `%${String(q).replace(/[%_]/g, '')}%`;
  const names = roleNames();
  return all(
    `SELECT ${USER_COLUMNS} FROM users
      WHERE active = 1 AND id != ? AND name LIKE ?
      ORDER BY name LIMIT 300`,
    [user.id, like],
  )
    .filter((u) => !refusalToMessage(user, u))
    .map((u) => ({ ...publicUser(u), role_name: names.get(u.role) ?? u.role }));
}

/** The grid, for the Setup screen. */
export function policyGrid() {
  return {
    reach: REACH,
    default: DEFAULT_REACH,
    roles: all('SELECT code, name FROM roles ORDER BY sort_order, name'),
    cells: all('SELECT from_role, to_role, reach FROM messaging_policy ORDER BY from_role, to_role'),
  };
}

/**
 * Change one cell.
 *
 * A cell set back to the default is removed rather than stored, so the table
 * holds only the decisions somebody actually made -- and "what has the
 * administrator changed?" is a SELECT *.
 */
export function setPolicy(actor, { from_role: fromRole, to_role: toRole, reach } = {}) {
  if (!REACH.includes(reach)) {
    return { ok: false, status: 400, error: `Reach must be one of: ${REACH.join(', ')}` };
  }
  for (const code of [fromRole, toRole]) {
    if (!code || !one('SELECT 1 FROM roles WHERE code = ?', [code])) {
      return { ok: false, status: 400, error: `${code ?? 'That'} is not a role` };
    }
  }

  const before = reachFor(fromRole, toRole);
  if (reach === DEFAULT_REACH) {
    run('DELETE FROM messaging_policy WHERE from_role = ? AND to_role = ?', [fromRole, toRole]);
  } else {
    run(
      `INSERT INTO messaging_policy (from_role, to_role, reach, updated_by) VALUES (?,?,?,?)
       ON CONFLICT(from_role, to_role) DO UPDATE SET
         reach = excluded.reach, updated_by = excluded.updated_by, updated_at = datetime('now')`,
      [fromRole, toRole, reach, actor.id],
    );
  }
  // Non-negotiable 13: who may talk to whom is configuration, and audited as such.
  auditConfig('messaging_policy', `${fromRole}->${toRole}`, 'updated', { reach: before }, { reach }, actor.id);
  return { ok: true, from_role: fromRole, to_role: toRole, reach };
}

/* ------------------------------------------------------ conversations */

export const isMember = (conversationId, userId) => Boolean(one(
  'SELECT 1 FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
  [conversationId, userId],
));

export const membersOf = (conversationId) => all(
  `SELECT u.id, u.name, u.role, u.sales_org, u.org_access, u.active, u.manager_id
     FROM conversation_member m JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ?`,
  [conversationId],
);

const others = (conversationId, userId) => membersOf(conversationId)
  .filter((m) => Number(m.id) !== Number(userId))
  .map(publicUser);

const findDirect = (a, b) => one(
  `SELECT c.id FROM conversation c
     JOIN conversation_member x ON x.conversation_id = c.id AND x.user_id = ?
     JOIN conversation_member y ON y.conversation_id = c.id AND y.user_id = ?
    WHERE c.kind = 'direct'`,
  [a, b],
)?.id ?? null;

/* `transact` joins a transaction already open, so this is atomic on its own and
   also inside a transfer request that has to roll back as one. */
const createDirect = (a, b) => transact(() => {
  const id = Number(run("INSERT INTO conversation (kind, created_by) VALUES ('direct', ?)", [a]).lastInsertRowid);
  run('INSERT INTO conversation_member (conversation_id, user_id) VALUES (?,?), (?,?)', [id, a, id, b]);
  return id;
});

/**
 * The one conversation between two people, opened if it does not exist.
 *
 * An existing one is returned even if the grid has since closed the pair:
 * reading what was already said is not messaging, and the refusal comes on
 * the next send, where it is explained.
 */
export function openDirect(from, toUserId) {
  const to = userRow(Number(toUserId));
  if (!to || !Number(to.active)) return { ok: false, status: 404, error: 'That person is not an active user' };

  const existing = findDirect(from.id, to.id);
  if (existing) return { ok: true, id: existing, created: false };

  const refusal = refusalToMessage(from, to);
  if (refusal) return { ok: false, status: 403, error: refusal };
  return { ok: true, id: createDirect(from.id, to.id), created: true };
}

const previewOf = (m) => {
  if (m.withdrawn_at) return 'Message withdrawn';
  if (m.kind === 'transfer') return 'Asked for a lead';
  return m.body.length > 80 ? `${m.body.slice(0, 79)}…` : m.body;
};

/** This person's conversations, newest first, with what is unread in each. */
export function conversationsFor(user) {
  const rows = all(
    `SELECT c.id, c.kind, c.frozen_at, c.frozen_reason, c.last_message_at, c.created_at,
            me.last_read_id,
            (SELECT COUNT(*) FROM message m
              WHERE m.conversation_id = c.id AND m.id > me.last_read_id
                AND m.withdrawn_at IS NULL
                AND (m.sender_id IS NULL OR m.sender_id != ?)) AS unread
       FROM conversation c
       JOIN conversation_member me ON me.conversation_id = c.id AND me.user_id = ?
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
      LIMIT 200`,
    [user.id, user.id],
  );

  return rows.map((c) => {
    const last = one(
      'SELECT id, kind, body, withdrawn_at, sender_id, created_at FROM message WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
      [c.id],
    );
    return {
      ...c,
      with: others(c.id, user.id),
      last: last
        ? { id: last.id, at: last.created_at, mine: Number(last.sender_id) === Number(user.id), preview: previewOf(last) }
        : null,
    };
  });
}

export function conversationSummary(conversationId, reader) {
  const c = one(
    'SELECT id, kind, frozen_at, frozen_reason, created_at FROM conversation WHERE id = ?',
    [conversationId],
  );
  return c ? { ...c, with: others(conversationId, reader.id) } : null;
}

/** Unread across every conversation, for the header. */
export function unreadFor(userId) {
  const r = one(
    `SELECT COUNT(*) AS messages, COUNT(DISTINCT m.conversation_id) AS conversations
       FROM message m
       JOIN conversation_member me ON me.conversation_id = m.conversation_id AND me.user_id = ?
      WHERE m.id > me.last_read_id AND m.withdrawn_at IS NULL
        AND (m.sender_id IS NULL OR m.sender_id != ?)`,
    [userId, userId],
  );
  return { messages: r.messages, conversations: r.conversations };
}

/** Seen up to here. Never beyond the newest message, and never backwards. */
export function markRead(userId, conversationId, lastId) {
  const newest = one(
    'SELECT COALESCE(MAX(id), 0) AS id FROM message WHERE conversation_id = ?',
    [conversationId],
  ).id;
  const upTo = Math.min(Number(lastId) || newest, newest);
  run(
    'UPDATE conversation_member SET last_read_id = max(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?',
    [upTo, conversationId, userId],
  );
}

/* ---------------------------------------------------------- the lead */

/** Whether this person can open this lead, by exactly the rule the lead screen uses. */
export function canSeeLead(user, leadId) {
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const scope = leadScope(user, 'l');
  return Boolean(one(
    `SELECT 1 FROM leads l WHERE l.id = ? AND l.deleted_at IS NULL AND ${scope.sql}`,
    [id, ...scope.params],
  ));
}

function chipFor(reader, leadId, chips, fields) {
  if (!leadId) return null;
  if (!chips.has(leadId)) {
    const row = canSeeLead(reader, leadId)
      ? one('SELECT id, name, stage FROM leads WHERE id = ?', [leadId])
      : null;
    chips.set(leadId, row ? maskRecord(row, { fields }) : { hidden: true });
  }
  return chips.get(leadId);
}

function transferCard(approvalId, reader, reviewing) {
  const a = approvalById(approvalId);
  if (!a) return null;
  const pending = a.status === 'Pending';
  return {
    approval_id: a.id,
    status: a.status,
    reason: a.reason,
    requested_by: a.requested_by,
    requested_by_name: a.requested_by_name,
    target_user_id: a.target_user_id,
    target_name: a.target_name,
    decided_by_name: a.decided_by_name,
    decision_reason: a.decision_reason,
    decided_at: a.decided_at,
    // A reviewer reads; they do not act from inside somebody else's conversation.
    can_decide: !reviewing && pending && Number(a.requested_by) !== Number(reader.id) && mayDecide(a, reader),
    can_withdraw: !reviewing && pending && Number(a.requested_by) === Number(reader.id),
  };
}

/* ------------------------------------------------------------ messages */

function present(m, reader, { chips, fields, original, reviewing }) {
  const hidden = Boolean(m.withdrawn_at) && !original;
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    kind: m.kind,
    sender_id: m.sender_id,
    sender_name: m.sender_name ?? null,
    mine: Number(m.sender_id) === Number(reader.id),
    body: hidden ? null : m.body,
    withdrawn: Boolean(m.withdrawn_at),
    withdrawn_at: m.withdrawn_at,
    lead: hidden ? null : chipFor(reader, m.lead_id, chips, fields),
    transfer: m.approval_id ? transferCard(m.approval_id, reader, reviewing) : null,
    created_at: m.created_at,
  };
}

/**
 * Messages in a conversation, as this reader may see them.
 *
 * With no `after`, the newest page; with one, everything since -- which is how
 * the open conversation asks for what arrived while it was on screen.
 */
export function messagesFor(reader, conversationId, {
  after = 0, limit = 100, original = false, reviewing = false,
} = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const since = Number(after) || 0;
  const rows = since > 0
    ? all(
      `SELECT m.*, u.name AS sender_name FROM message m LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`,
      [conversationId, since, n],
    )
    : all(
      `SELECT * FROM (
         SELECT m.*, u.name AS sender_name FROM message m LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT ?
       ) ORDER BY id ASC`,
      [conversationId, n],
    );

  const ctx = { chips: new Map(), fields: maskedFieldsFor(reader.role), original, reviewing };
  return rows.map((m) => present(m, reader, ctx));
}

/**
 * Send.
 *
 * The grid is asked about every other member on every send (rule 1), and a
 * lead can only be attached by somebody who can open it -- refused with the
 * same words whether or not it exists, so the attach box cannot be used to ask
 * the system which lead ids are real.
 */
export function send(from, conversationId, {
  body, leadId = null, kind = 'text', approvalId = null, leadVerified = false,
} = {}) {
  const convo = one('SELECT * FROM conversation WHERE id = ?', [conversationId]);
  if (!convo || !isMember(conversationId, from.id)) {
    return { ok: false, status: 404, error: 'Conversation not found' };
  }
  if (convo.frozen_at) {
    return { ok: false, status: 409, error: `This conversation is frozen: ${convo.frozen_reason}` };
  }

  const text = String(body ?? '').trim();
  if (!text) return { ok: false, status: 400, error: 'Write something first' };
  if (text.length > MAX_BODY) {
    return { ok: false, status: 400, error: `A message can be at most ${MAX_BODY} characters` };
  }

  for (const other of membersOf(conversationId).filter((m) => Number(m.id) !== Number(from.id))) {
    const refusal = refusalToMessage(from, other);
    if (refusal) return { ok: false, status: 403, error: refusal };
  }

  /* `leadVerified` is set by requestTransfer alone, which has already allowed
     the lead on the requester's own lookup. The route builds these options
     itself and never passes it, so the attach box is still limited to leads
     the sender can open. */
  if (leadId != null && leadId !== '' && !leadVerified && !canSeeLead(from, leadId)) {
    return { ok: false, status: 404, error: 'Lead not found' };
  }

  const id = Number(run(
    `INSERT INTO message (conversation_id, sender_id, kind, body, lead_id, approval_id)
     VALUES (?,?,?,?,?,?)`,
    [conversationId, from.id, kind, text, leadId ? Number(leadId) : null, approvalId],
  ).lastInsertRowid);
  run("UPDATE conversation SET last_message_at = datetime('now') WHERE id = ?", [conversationId]);
  // Your own message is not unread to you.
  markRead(from.id, conversationId, id);
  return { ok: true, id, conversation_id: conversationId };
}

/** Take back a message just sent. The words stay on the record (rule 3). */
export function withdrawMessage(user, messageId) {
  const m = messageId ? one('SELECT * FROM message WHERE id = ?', [messageId]) : null;
  if (!m || !isMember(m.conversation_id, user.id)) {
    return { ok: false, status: 404, error: 'Message not found' };
  }
  if (Number(m.sender_id) !== Number(user.id)) {
    return { ok: false, status: 403, error: 'Only the person who sent a message can withdraw it' };
  }
  if (m.kind !== 'text') {
    return { ok: false, status: 409, error: 'Only a written message can be withdrawn. A transfer request is withdrawn from Approvals.' };
  }
  if (m.withdrawn_at) return { ok: false, status: 409, error: 'That message was already withdrawn' };

  const minutes = one("SELECT (julianday('now') - julianday(?)) * 1440 AS m", [m.created_at]).m;
  if (minutes > WITHDRAW_WINDOW_MINUTES) {
    return {
      ok: false, status: 409,
      error: `A message can be withdrawn for ${WITHDRAW_WINDOW_MINUTES} minutes after it is sent`,
    };
  }

  run("UPDATE message SET withdrawn_at = datetime('now') WHERE id = ?", [m.id]);
  audit(user.id, 'message_withdrawn', 'conversation', m.conversation_id, { message_id: m.id });
  return { ok: true };
}

/* ------------------------------------------------------ transfer request */

/**
 * Whether this person could say yes to handing this lead over.
 *
 * The lead's owner, or anybody holding lead.reassign in its book -- Ritesh,
 * 11 September. Checked when the request is raised, so nobody is sent a
 * request they cannot grant, and again by the approvals engine when it is
 * decided.
 */
export function canGrantTransfer(user, lead) {
  if (!user || !Number(user.active)) return false;
  if (!mayUseOrg(user, lead.sales_org)) return false;
  if (Number(lead.owner_id) === Number(user.id)) return true;
  return effectiveCapabilities(user).has('lead.reassign');
}

class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Ask a named person for a lead, inside the conversation the two of you have.
 *
 * The lead has to be one the requester can already open, or one they looked
 * up themselves in the last day (lookupLeads, below). Ritesh ruled on 11
 * September that an RM may name any lead in their book; the lookup is how
 * they name it, and requiring one is what stops "try every id" from becoming
 * a way to map a colleague's book. Every other case -- no such lead, the other
 * business, never looked up -- is refused in the same words.
 */
export function requestTransfer(requester, { leadId, toUserId, reason } = {}) {
  const notFound = { ok: false, status: 404, error: 'Lead not found' };
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) return notFound;

  const lead = one(
    'SELECT id, name, owner_id, owner_queue_id, sales_org FROM leads WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
  if (!lead || !mayUseOrg(requester, lead.sales_org)) return notFound;
  if (!canSeeLead(requester, id) && !lookedUp(requester.id, id)) return notFound;

  if (Number(lead.owner_id) === Number(requester.id)) {
    return { ok: false, status: 409, error: 'This lead is already yours' };
  }
  if (lead.owner_queue_id) {
    return { ok: false, status: 409, error: 'This lead is waiting in a queue. Take it from the queue instead.' };
  }
  if (!String(reason ?? '').trim()) {
    return { ok: false, status: 400, error: 'Say why you are asking for it. The person deciding needs a reason.' };
  }

  const target = userRow(Number(toUserId));
  if (!target || !Number(target.active)) {
    return { ok: false, status: 404, error: 'That person is not an active user' };
  }
  if (!canGrantTransfer(target, lead)) {
    return {
      ok: false, status: 409,
      error: `${target.name} cannot grant this. Ask the lead's owner, or somebody who can reassign leads in its book.`,
    };
  }

  const refusal = refusalToMessage(requester, target);
  if (refusal) return { ok: false, status: 403, error: refusal };

  try {
    return transact(() => {
      const conversationId = findDirect(requester.id, target.id) ?? createDirect(requester.id, target.id);

      const asked = requestApproval({
        scope: 'lead_transfer',
        entityId: lead.id,
        subjectName: requester.name,
        payload: { to_user_id: requester.id, from_owner_id: lead.owner_id, lead_name: lead.name },
        reason: String(reason).trim(),
        requestedBy: requester.id,
        targetUserId: target.id,
      });
      if (!asked.ok) throw new Refusal(409, asked.error);

      /* The message carries the reason and points at the lead and the request.
         It does not carry the lead's name (rule 2). */
      const sent = send(requester, conversationId, {
        body: String(reason).trim(), leadId: lead.id, kind: 'transfer', approvalId: asked.request.id,
        leadVerified: true,
      });
      if (!sent.ok) throw new Refusal(sent.status, sent.error);

      return { ok: true, approval: asked.request, conversation_id: conversationId, message_id: sent.id };
    });
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, status: err.status, error: err.message };
    throw err;
  }
}

/* ------------------------------------------- naming a lead you cannot open */

/** How long a lookup lets you ask for what it found. */
export const LOOKUP_WINDOW_HOURS = 24;

function lookedUp(userId, leadId) {
  return Boolean(one(
    `SELECT 1 FROM audit_log
      WHERE user_id = ? AND action = 'lead_lookup' AND entity = 'lead' AND entity_id = ?
        AND created_at >= datetime('now', ?)`,
    [userId, leadId, `-${LOOKUP_WINDOW_HOURS} hours`],
  ));
}

/* The ten digits, whatever was typed around them -- a country code, a leading
   zero, spaces. Stored mobiles are exactly ten digits, six to nine first. */
const tenDigits = (v) => {
  let d = String(v ?? '').replace(/[^0-9]/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9][0-9]{9}$/.test(d) ? d : null;
};

/** Who could say yes to handing this lead over, and whom the asker may message. */
function grantorsFor(asker, lead) {
  const people = all(`SELECT ${USER_COLUMNS} FROM users WHERE active = 1 AND id != ?`, [asker.id])
    .filter((u) => canGrantTransfer(u, lead) && !refusalToMessage(asker, u));
  // The owner first: most requests should go to them.
  const isOwner = (u) => Number(u.id) === Number(lead.owner_id);
  people.sort((a, b) => (isOwner(b) - isOwner(a)) || a.name.localeCompare(b.name));
  return people.slice(0, 10).map((u) => ({ ...publicUser(u), is_owner: isOwner(u) }));
}

/**
 * Find a lead in your own book by its exact mobile number or exact full name,
 * so you can ask for it. Ritesh, 11 September: an RM may name any lead.
 *
 * WHAT IT REVEALS, AND WHAT IT DOES NOT
 *
 * That the lead exists and who could hand it over -- the ruling accepted that
 * much. Nothing from the record: no name back for a mobile, no mobile back for
 * a name, no stage, no products. Exact matches only, so it answers "is the
 * client ringing me already somebody's?" and cannot be used to browse a
 * colleague's book. Never across the two businesses.
 *
 * Each lead found is written to the audit log against the person who looked,
 * which is also what lets them ask for it afterwards. A lookup that finds
 * nothing is logged too, without what was searched for.
 */
export function lookupLeads(user, { mobile, name } = {}) {
  let where;
  let param;
  let by;
  if (String(mobile ?? '').trim()) {
    param = tenDigits(mobile);
    if (!param) return { ok: false, status: 400, error: 'Enter the full 10-digit mobile number' };
    where = 'l.mobile = ?';
    by = 'mobile';
  } else if (String(name ?? '').trim()) {
    param = String(name).trim().split(' ').filter(Boolean).join(' ');
    if (param.length < 3) return { ok: false, status: 400, error: "Enter the client's full name" };
    where = 'lower(trim(l.name)) = lower(?)';
    by = 'name';
  } else {
    return { ok: false, status: 400, error: 'Give a mobile number or a full name' };
  }

  const books = orgsFor(user);
  if (!books.length) return { ok: true, matches: [] };

  const rows = all(
    `SELECT l.id, l.owner_id, l.owner_queue_id, l.sales_org, q.name AS queue_name
       FROM leads l LEFT JOIN queues q ON q.id = l.owner_queue_id
      WHERE l.deleted_at IS NULL
        AND l.sales_org IN (${books.map(() => '?').join(',')})
        AND ${where}
      ORDER BY l.id LIMIT 5`,
    [...books, param],
  );

  if (!rows.length) audit(user.id, 'lead_lookup', 'lead', null, { by, matched: 0 });
  for (const r of rows) audit(user.id, 'lead_lookup', 'lead', r.id, { by });

  return {
    ok: true,
    matches: rows.map((r) => {
      const owner = r.owner_id ? userRow(r.owner_id) : null;
      return {
        lead_id: r.id,
        mine: Number(r.owner_id) === Number(user.id),
        can_open: canSeeLead(user, r.id),
        in_queue: r.owner_queue_id ? (r.queue_name ?? 'a queue') : null,
        owner: owner ? publicUser(owner) : null,
        grantors: r.owner_queue_id ? [] : grantorsFor(user, r),
      };
    }),
  };
}

/* ------------------------------------------------------------ reviewing */

/** A conversation is in a reviewer's reach when anybody in it works in a book they cover. */
export function monitorCanSee(monitor, conversationId) {
  const books = new Set(orgsFor(monitor));
  return membersOf(conversationId).some((m) => orgsFor(m).some((o) => books.has(o)));
}

export function monitorList(monitor) {
  const books = new Set(orgsFor(monitor));
  const rows = all(
    `SELECT c.id, c.kind, c.frozen_at, c.frozen_reason, c.last_message_at, c.created_at,
            (SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id) AS messages
       FROM conversation c
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
      LIMIT 2000`,
  );
  const out = [];
  for (const c of rows) {
    const members = membersOf(c.id);
    if (!members.some((m) => orgsFor(m).some((o) => books.has(o)))) continue;
    out.push({ ...c, members: members.map(publicUser) });
    if (out.length >= 300) break;
  }
  return { conversations: out, notice: MONITORING_NOTICE };
}

/**
 * A reviewer opens a conversation.
 *
 * Every read is itself written to the audit log. A reviewer nobody reviews is
 * the gap the legacy audit keeps finding, and "who read this conversation?"
 * should have an answer the day somebody asks it.
 */
export function monitorRead(monitor, conversationId) {
  const convo = conversationId ? one('SELECT * FROM conversation WHERE id = ?', [conversationId]) : null;
  if (!convo) return { ok: false, status: 404, error: 'Conversation not found' };
  if (!monitorCanSee(monitor, conversationId)) {
    return { ok: false, status: 403, error: 'This conversation is outside the books you review' };
  }

  const members = membersOf(conversationId);
  audit(monitor.id, 'conversation_reviewed', 'conversation', conversationId, {
    members: members.map((m) => m.id),
  });
  return {
    ok: true,
    conversation: convo,
    members: members.map(publicUser),
    messages: messagesFor(monitor, conversationId, { limit: 200, original: true, reviewing: true }),
  };
}

const systemLine = (conversationId, body) => run(
  "INSERT INTO message (conversation_id, sender_id, kind, body) VALUES (?, NULL, 'system', ?)",
  [conversationId, body],
);

export function freeze(monitor, conversationId, reason) {
  const text = String(reason ?? '').trim();
  if (!text) return { ok: false, status: 400, error: 'Say why. Both people in the conversation are shown it.' };
  const convo = conversationId ? one('SELECT * FROM conversation WHERE id = ?', [conversationId]) : null;
  if (!convo) return { ok: false, status: 404, error: 'Conversation not found' };
  if (!monitorCanSee(monitor, conversationId)) {
    return { ok: false, status: 403, error: 'This conversation is outside the books you review' };
  }
  if (convo.frozen_at) return { ok: false, status: 409, error: 'This conversation is already frozen' };

  transact(() => {
    run(
      "UPDATE conversation SET frozen_at = datetime('now'), frozen_by = ?, frozen_reason = ? WHERE id = ?",
      [monitor.id, text, conversationId],
    );
    systemLine(conversationId, `Frozen by compliance: ${text}`);
    audit(monitor.id, 'conversation_frozen', 'conversation', conversationId, { reason: text });
    for (const m of membersOf(conversationId)) notify(m.id, 'A conversation was frozen', text, '/messages');
  });
  return { ok: true };
}

export function unfreeze(monitor, conversationId) {
  const convo = conversationId ? one('SELECT * FROM conversation WHERE id = ?', [conversationId]) : null;
  if (!convo) return { ok: false, status: 404, error: 'Conversation not found' };
  if (!monitorCanSee(monitor, conversationId)) {
    return { ok: false, status: 403, error: 'This conversation is outside the books you review' };
  }
  if (!convo.frozen_at) return { ok: false, status: 409, error: 'This conversation is not frozen' };

  transact(() => {
    run('UPDATE conversation SET frozen_at = NULL, frozen_by = NULL, frozen_reason = NULL WHERE id = ?', [conversationId]);
    systemLine(conversationId, 'Unfrozen by compliance');
    audit(monitor.id, 'conversation_unfrozen', 'conversation', conversationId, {});
  });
  return { ok: true };
}

const inReviewersBooks = (monitor, user) => {
  const books = new Set(orgsFor(monitor));
  return orgsFor(user).some((o) => books.has(o));
};

export function suspend(monitor, userId, reason) {
  const text = String(reason ?? '').trim();
  if (!text) return { ok: false, status: 400, error: 'Say why. The person suspended is told.' };
  const target = userRow(userId);
  if (!target) return { ok: false, status: 404, error: 'That person does not exist' };
  if (Number(target.id) === Number(monitor.id)) return { ok: false, status: 400, error: 'You cannot suspend yourself' };
  if (!inReviewersBooks(monitor, target)) {
    return { ok: false, status: 403, error: 'That person is outside the books you review' };
  }

  run(
    `INSERT INTO messaging_suspension (user_id, reason, suspended_by) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       reason = excluded.reason, suspended_by = excluded.suspended_by, suspended_at = datetime('now')`,
    [target.id, text, monitor.id],
  );
  audit(monitor.id, 'messaging_suspended', 'user', target.id, { reason: text });
  notify(target.id, 'Your messaging has been suspended', text, '/messages');
  return { ok: true };
}

export function unsuspend(monitor, userId) {
  const target = userRow(userId);
  if (!target) return { ok: false, status: 404, error: 'That person does not exist' };
  if (!inReviewersBooks(monitor, target)) {
    return { ok: false, status: 403, error: 'That person is outside the books you review' };
  }
  const gone = run('DELETE FROM messaging_suspension WHERE user_id = ?', [target.id]).changes;
  if (!gone) return { ok: false, status: 409, error: 'That person is not suspended' };
  audit(monitor.id, 'messaging_unsuspended', 'user', target.id, {});
  notify(target.id, 'Your messaging has been restored', null, '/messages');
  return { ok: true };
}

export function suspensionsFor(monitor) {
  return all(
    `SELECT s.user_id, s.reason, s.suspended_at, u.name, u.role, u.sales_org, u.org_access,
            b.name AS suspended_by_name
       FROM messaging_suspension s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN users b ON b.id = s.suspended_by
      ORDER BY s.suspended_at DESC`,
  )
    .filter((s) => inReviewersBooks(monitor, s))
    .map(({ org_access: _drop, ...rest }) => rest);
}
