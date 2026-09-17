/**
 * Channels — P3-21, phase 2.
 *
 * A conversation of kind 'channel': named, public or private, belonging to the
 * business of whoever opened it. The message itself -- sending, threads,
 * reactions' display, the lead chip, withdrawing, review -- is
 * engine/messaging.js, shared with direct messages. This file is who is in a
 * channel and how they got there, and the reaction itself.
 *
 * RITESH'S DECISIONS, 16 SEPTEMBER
 *
 *   Anyone may open a channel.
 *   A channel may mix both businesses, where the grid allows it.
 *   The grid governs direct messages only; in a channel, membership decides.
 *   Any member may add people to a private channel.
 *   Reactions are any emoji.
 *
 * HOW THE FIRST TWO FIT TOGETHER
 *
 * A channel is listed only to its own business, so a Bigul user never learns
 * the name of a Bonanza channel unless somebody adds them. When somebody comes
 * in -- joining, or added -- the grid is asked about them and each member they
 * share no business with, both ways, and must say 'any_book'. It is not asked
 * about anybody in the same business: a pair it blocks from direct messages
 * can still sit in one channel. The check is at the door. Closing the grid
 * later ejects nobody; a reviewer can freeze the channel.
 */

import { all, one, run, audit, notify, transact } from '../db.js';
import { orgsFor } from '../auth.js';
import {
  isMember, membersOf, reachFor, suspensionOf, refusalToMessage, monitorCanSee, MONITORING_NOTICE,
} from './messaging.js';

const NAME_MIN = 2;
const NAME_MAX = 60;
const TOPIC_MAX = 250;

const USER_COLUMNS = 'id, name, role, sales_org, org_access, active';
const userRow = (id) => (id ? one(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]) : null);
const publicUser = ({ id, name, role, sales_org: salesOrg }) => ({ id, name, role, sales_org: salesOrg });

const channelRow = (id) => (id ? one("SELECT * FROM conversation WHERE id = ? AND kind = 'channel'", [id]) : null);

const shareABook = (a, b) => {
  const mine = new Set(orgsFor(a));
  return orgsFor(b).some((o) => mine.has(o));
};

const systemLine = (conversationId, body) => run(
  "INSERT INTO message (conversation_id, sender_id, kind, body) VALUES (?, NULL, 'system', ?)",
  [conversationId, body],
);

const notFound = { ok: false, status: 404, error: 'Channel not found' };

/* --------------------------------------------------------------- seeing */

/** Whether this person may know the channel exists. */
export function canSeeChannel(user, c) {
  if (!c || !user) return false;
  if (isMember(c.id, user.id)) return true;
  return c.visibility === 'public' && orgsFor(user).includes(c.home_org);
}

/** Channels this person can see: public ones in their businesses, and any they are in. */
export function browse(user) {
  const books = orgsFor(user);
  const rows = all(
    `SELECT c.id, c.name, c.topic, c.visibility, c.home_org, c.archived_at, c.created_at, c.created_by,
            (SELECT COUNT(*) FROM conversation_member m WHERE m.conversation_id = c.id) AS members,
            EXISTS (SELECT 1 FROM conversation_member m WHERE m.conversation_id = c.id AND m.user_id = ?) AS joined
       FROM conversation c
      WHERE c.kind = 'channel'
        AND (
          (c.visibility = 'public' AND c.home_org IN (${books.map(() => '?').join(',') || "''"}))
          OR EXISTS (SELECT 1 FROM conversation_member m WHERE m.conversation_id = c.id AND m.user_id = ?)
        )
      ORDER BY c.archived_at IS NOT NULL, lower(c.name)`,
    [user.id, ...books, user.id],
  );
  return {
    channels: rows.map((r) => ({ ...r, joined: Boolean(r.joined) })),
    books,
    notice: MONITORING_NOTICE,
  };
}

/* ---------------------------------------------------------- the door */

/**
 * Why `person` may not come into this channel, or null when they may.
 *
 * The book boundary, and only that: for every member they share no business
 * with, the grid must open messages both ways across the businesses. Members
 * of the same business are not asked about at all (the grid governs direct
 * messages only).
 */
export function refusalToEnter(person, channelId) {
  if (!person || !Number(person.active)) return 'That person is not an active user';
  for (const m of membersOf(channelId)) {
    if (Number(m.id) === Number(person.id) || shareABook(person, m)) continue;
    if (reachFor(person.role, m.role) !== 'any_book' || reachFor(m.role, person.role) !== 'any_book') {
      return `${person.name} works in the other business from ${m.name}, and the grid does not open messages between them`;
    }
  }
  return null;
}

/* ---------------------------------------------------------- opening one */

/** Anyone may open a channel -- Ritesh, 16 September. */
export function createChannel(user, { name, topic, visibility = 'public', home_org: homeOrg } = {}) {
  const suspended = suspensionOf(user.id);
  if (suspended) return { ok: false, status: 403, error: `Your messaging is suspended: ${suspended.reason}` };

  const clean = String(name ?? '').trim().replace(/^#+/, '').trim().split(' ').filter(Boolean).join(' ');
  if (clean.length < NAME_MIN || clean.length > NAME_MAX) {
    return { ok: false, status: 400, error: `A channel name is ${NAME_MIN} to ${NAME_MAX} characters` };
  }
  if (!['public', 'private'].includes(visibility)) {
    return { ok: false, status: 400, error: 'A channel is public or private' };
  }
  const about = String(topic ?? '').trim();
  if (about.length > TOPIC_MAX) return { ok: false, status: 400, error: `A topic is at most ${TOPIC_MAX} characters` };

  const books = orgsFor(user);
  const org = homeOrg ?? user.sales_org ?? books[0];
  if (!org || !books.includes(org)) return { ok: false, status: 403, error: `You cannot open a channel in ${org}` };

  const taken = one(
    `SELECT 1 FROM conversation
      WHERE kind = 'channel' AND home_org = ? AND lower(name) = lower(?) AND archived_at IS NULL`,
    [org, clean],
  );
  if (taken) return { ok: false, status: 409, error: `There is already a channel called #${clean}` };

  const id = transact(() => {
    const cid = Number(run(
      `INSERT INTO conversation (kind, created_by, name, topic, visibility, home_org)
       VALUES ('channel', ?, ?, ?, ?, ?)`,
      [user.id, clean, about || null, visibility, org],
    ).lastInsertRowid);
    run('INSERT INTO conversation_member (conversation_id, user_id) VALUES (?,?)', [cid, user.id]);
    systemLine(cid, `${user.name} opened #${clean}`);
    audit(user.id, 'channel_created', 'conversation', cid, { name: clean, visibility, home_org: org });
    return cid;
  });
  return { ok: true, id };
}

/* ---------------------------------------------------------- coming in */

export function join(user, channelId) {
  const c = channelRow(channelId);
  if (!c || !canSeeChannel(user, c)) return notFound;
  if (isMember(c.id, user.id)) return { ok: true, id: c.id, joined: false };
  // A private channel is joined by invitation only, and is not visible to be joined.
  if (c.visibility !== 'public') return notFound;
  if (c.archived_at) return { ok: false, status: 409, error: 'This channel is archived' };

  const refusal = refusalToEnter(user, c.id);
  if (refusal) return { ok: false, status: 403, error: refusal };

  transact(() => {
    run('INSERT INTO conversation_member (conversation_id, user_id) VALUES (?,?)', [c.id, user.id]);
    systemLine(c.id, `${user.name} joined`);
    audit(user.id, 'channel_joined', 'conversation', c.id, {});
  });
  return { ok: true, id: c.id, joined: true };
}

/** Any member may add somebody -- Ritesh, 16 September. Every addition is recorded. */
export function addMember(actor, channelId, userId) {
  const c = channelRow(channelId);
  if (!c || !isMember(c.id, actor.id)) return notFound;
  if (c.archived_at) return { ok: false, status: 409, error: 'This channel is archived' };
  const suspended = suspensionOf(actor.id);
  if (suspended) return { ok: false, status: 403, error: `Your messaging is suspended: ${suspended.reason}` };

  const person = userRow(userId);
  if (!person || !Number(person.active)) return { ok: false, status: 404, error: 'That person is not an active user' };
  if (isMember(c.id, person.id)) return { ok: false, status: 409, error: `${person.name} is already in #${c.name}` };

  const refusal = refusalToEnter(person, c.id);
  if (refusal) return { ok: false, status: 403, error: refusal };

  transact(() => {
    run('INSERT INTO conversation_member (conversation_id, user_id) VALUES (?,?)', [c.id, person.id]);
    systemLine(c.id, `${actor.name} added ${person.name}`);
    audit(actor.id, 'channel_member_added', 'conversation', c.id, { user_id: person.id });
    notify(person.id, `${actor.name} added you to #${c.name}`, c.topic ?? null, `/messages?c=${c.id}`);
  });
  return { ok: true };
}

/** Colleagues a member could add: not in it already, and through the door. */
export function candidates(actor, channelId, q = '') {
  const c = channelRow(channelId);
  if (!c || !isMember(c.id, actor.id)) return notFound;
  const like = `%${String(q).replace(/[%_]/g, '')}%`;
  const people = all(
    `SELECT ${USER_COLUMNS} FROM users
      WHERE active = 1 AND name LIKE ?
        AND id NOT IN (SELECT user_id FROM conversation_member WHERE conversation_id = ?)
      ORDER BY name LIMIT 300`,
    [like, c.id],
  ).filter((u) => !refusalToEnter(u, c.id)).map(publicUser);
  return { ok: true, people };
}

/* ---------------------------------------------------------- going out */

export function leave(user, channelId) {
  const c = channelRow(channelId);
  if (!c || !isMember(c.id, user.id)) return notFound;
  transact(() => {
    run('DELETE FROM conversation_member WHERE conversation_id = ? AND user_id = ?', [c.id, user.id]);
    systemLine(c.id, `${user.name} left`);
    audit(user.id, 'channel_left', 'conversation', c.id, {});
  });
  return { ok: true };
}

/** The person who opened a channel may take somebody out of it. */
export function removeMember(actor, channelId, userId) {
  const c = channelRow(channelId);
  if (!c || !isMember(c.id, actor.id)) return notFound;
  if (Number(c.created_by) !== Number(actor.id)) {
    return { ok: false, status: 403, error: 'Only the person who opened a channel can remove somebody from it' };
  }
  if (Number(userId) === Number(actor.id)) return { ok: false, status: 400, error: 'To go yourself, leave the channel' };
  const person = userRow(userId);
  if (!person || !isMember(c.id, person.id)) return { ok: false, status: 404, error: 'That person is not in this channel' };

  transact(() => {
    run('DELETE FROM conversation_member WHERE conversation_id = ? AND user_id = ?', [c.id, person.id]);
    systemLine(c.id, `${actor.name} removed ${person.name}`);
    audit(actor.id, 'channel_member_removed', 'conversation', c.id, { user_id: person.id });
    notify(person.id, `You were removed from #${c.name}`, null, '/messages');
  });
  return { ok: true };
}

/* ---------------------------------------------------------- archiving */

/* The person who opened it, or a reviewer whose books it is in. */
const mayArchive = (actor, c) => Number(c.created_by) === Number(actor.id)
  || (actor.capabilities?.has('comms.monitor') && monitorCanSee(actor, c.id));

export function archive(actor, channelId) {
  const c = channelRow(channelId);
  if (!c || !canSeeChannel(actor, c)) {
    if (!(c && actor.capabilities?.has('comms.monitor') && monitorCanSee(actor, c.id))) return notFound;
  }
  if (!mayArchive(actor, c)) {
    return { ok: false, status: 403, error: 'Only the person who opened a channel, or a reviewer, can archive it' };
  }
  if (c.archived_at) return { ok: false, status: 409, error: 'This channel is already archived' };
  transact(() => {
    run("UPDATE conversation SET archived_at = datetime('now'), archived_by = ? WHERE id = ?", [actor.id, c.id]);
    systemLine(c.id, `Archived by ${actor.name}. It can be read, not written to.`);
    audit(actor.id, 'channel_archived', 'conversation', c.id, {});
  });
  return { ok: true };
}

export function unarchive(actor, channelId) {
  const c = channelRow(channelId);
  if (!c || !(canSeeChannel(actor, c) || (actor.capabilities?.has('comms.monitor') && monitorCanSee(actor, c.id)))) {
    return notFound;
  }
  if (!mayArchive(actor, c)) {
    return { ok: false, status: 403, error: 'Only the person who opened a channel, or a reviewer, can reopen it' };
  }
  if (!c.archived_at) return { ok: false, status: 409, error: 'This channel is not archived' };
  transact(() => {
    run('UPDATE conversation SET archived_at = NULL, archived_by = NULL WHERE id = ?', [c.id]);
    systemLine(c.id, `Reopened by ${actor.name}`);
    audit(actor.id, 'channel_unarchived', 'conversation', c.id, {});
  });
  return { ok: true };
}

/* ---------------------------------------------------------- reactions */

/*
 * Any emoji -- Ritesh, 16 September -- and nothing that is not one.
 *
 * "An emoji" is: something pictographic or a flag, with no letters, digits or
 * spaces in it. That lets through skin tones, flags and joined sequences like
 * a woman at a laptop, and keeps out "lol", "ok" and a word with an emoji on
 * the end -- a reaction is a mark, not a message, and a message goes through
 * the rules a message goes through.
 */
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const NOT_A_MARK = /[\p{L}\p{N}\s]/u;

export const isEmoji = (value) => {
  const e = String(value ?? '').trim();
  return e.length > 0 && e.length <= 32 && PICTOGRAPH.test(e) && !NOT_A_MARK.test(e);
};

/** Put a reaction on, or take it off if it is already there. */
export function react(user, messageId, emoji) {
  const m = messageId
    ? one(
      `SELECT m.id, m.conversation_id, m.kind, m.withdrawn_at, c.kind AS conversation_kind,
              c.frozen_at, c.archived_at
         FROM message m JOIN conversation c ON c.id = m.conversation_id
        WHERE m.id = ?`,
      [messageId],
    )
    : null;
  if (!m || !isMember(m.conversation_id, user.id)) return { ok: false, status: 404, error: 'Message not found' };

  const e = String(emoji ?? '').trim();
  if (!isEmoji(e)) return { ok: false, status: 400, error: 'A reaction is one emoji' };
  if (m.kind === 'system' || m.withdrawn_at) {
    return { ok: false, status: 409, error: 'That message cannot be reacted to' };
  }
  if (m.frozen_at || m.archived_at) {
    return { ok: false, status: 409, error: 'This conversation takes nothing new now' };
  }

  // A reaction is still something one person sends another.
  const suspended = suspensionOf(user.id);
  if (suspended) return { ok: false, status: 403, error: `Your messaging is suspended: ${suspended.reason}` };
  if (m.conversation_kind === 'direct') {
    for (const other of membersOf(m.conversation_id).filter((p) => Number(p.id) !== Number(user.id))) {
      const refusal = refusalToMessage(user, other);
      if (refusal) return { ok: false, status: 403, error: refusal };
    }
  }

  const there = one(
    'SELECT 1 FROM message_reaction WHERE message_id = ? AND user_id = ? AND emoji = ?',
    [m.id, user.id, e],
  );
  if (there) {
    run('DELETE FROM message_reaction WHERE message_id = ? AND user_id = ? AND emoji = ?', [m.id, user.id, e]);
  } else {
    run('INSERT INTO message_reaction (message_id, user_id, emoji) VALUES (?,?,?)', [m.id, user.id, e]);
  }
  return { ok: true, reacted: !there };
}
