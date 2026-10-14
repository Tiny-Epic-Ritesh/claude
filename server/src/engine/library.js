/**
 * Content libraries and their approval flow (P2-20 + P2-22).
 *
 * These were raised as two items and are one screen: `/content` is labelled
 * "Marketing Hub" in the app, so "manage content libraries" and "edit and
 * configuration in the Marketing Hub" describe the same place. The same
 * duplication P2-02 and P2-15 turned out to be.
 *
 * WHAT A LIBRARY IS FOR
 *
 * Not tidiness. A library carries the two things that decide whether a document
 * should still be in front of a client: who may use it, and when it stops being
 * true. An out-of-date brochure quoting last year's brokerage is a compliance
 * problem rather than stale content, which is why expiry is a library-level
 * default and not a per-item afterthought that nobody fills in.
 *
 * WHY APPROVAL IS PER LIBRARY
 *
 * Regulatory documents need a second pair of eyes. An internal battlecard does
 * not, and forcing approval on both is how approval becomes a rubber stamp —
 * the reviewer stops reading because most of what reaches them did not need
 * reviewing. So it is a property of the library, decided once by whoever owns
 * the collateral.
 */

import { all, one, run } from '../db.js';
import { can, orgsFor } from '../auth.js';

/**
 * The states an item moves through.
 *
 * `approved` is the one the email composer looks for. It replaced `active`,
 * which meant "exists" rather than "somebody said this may go to a client" —
 * a distinction worth having in the word itself.
 */
export const STATUSES = {
  draft: { label: 'Draft', sendable: false },
  pending: { label: 'Waiting for approval', sendable: false },
  approved: { label: 'Approved', sendable: true },
  rejected: { label: 'Sent back', sendable: false },
  /* QA-37: "withdraw, then archive". Withdrawn is out of use with a reason,
     and can go back for approval; archived is put away. Never deleted -- an
     item sent to a client records what they were told. */
  withdrawn: { label: 'Withdrawn', sendable: false },
  archived: { label: 'Superseded', sendable: false },
};

const parse = (t, fallback = null) => { try { return t ? JSON.parse(t) : fallback; } catch { return fallback; } };

/**
 * May this person read this library?
 *
 * The owning role always can, and so can anyone the library names. A library
 * shared with nobody is the owner's alone — which is a real case: draft
 * collateral being worked on should not be visible to the desk until it is
 * ready.
 */
export function mayRead(library, user) {
  if (!library) return false;
  if (library.sales_org && !orgsFor(user).includes(library.sales_org)) return false;
  if (library.owner_role === user.role) return true;
  if (can(user.role, 'admin.content')) return true;
  const shared = parse(library.shared_with);
  // NULL means every role; an empty array means nobody but the owner.
  return shared === null ? true : shared.includes(user.role);
}

/** Only the owning role, or an administrator, changes a library. */
export const mayManage = (library, user) =>
  Boolean(library) && (library.owner_role === user.role || can(user.role, 'admin.content'));

export const libraries = (user) => all(
  'SELECT * FROM content_library WHERE active = 1 ORDER BY name',
).filter((l) => mayRead(l, user)).map((l) => ({
  ...l,
  shared_with: parse(l.shared_with),
  item_count: one('SELECT COUNT(*) n FROM content_items WHERE library_id = ?', [l.id]).n,
  awaiting: one("SELECT COUNT(*) n FROM content_items WHERE library_id = ? AND status = 'pending'", [l.id]).n,
}));

/* ---------------------------------------------------------- approval */

/**
 * Move an item along.
 *
 * Returns null when allowed, or the reason. Transitions are explicit rather
 * than "any status to any status" — an item going straight from draft to
 * approved without ever being submitted is how approval turns into a field
 * somebody sets on themselves.
 */
export function mayTransition(item, library, user, to) {
  if (!STATUSES[to]) return `"${to}" is not a status`;

  const owns = library ? mayManage(library, user) : can(user.role, 'admin.content');

  if (to === 'pending') {
    // A withdrawn item comes back only through approval again.
    if (!['draft', 'rejected', 'withdrawn'].includes(item.status)) {
      return 'Only a draft can be sent for approval';
    }
    return owns ? null : 'Only the library owner can send this for approval';
  }

  if (to === 'approved') {
    /* The reviewer must not be the author. A second pair of eyes that belongs
       to the same head is not a second pair of eyes — and this is the whole
       reason the flow exists for regulatory collateral. */
    if (item.created_by && item.created_by === user.id) {
      return 'Somebody other than the person who added it has to approve it';
    }
    if (!can(user.role, 'admin.content')) return 'Approving collateral needs content permission';
    if (item.status !== 'pending') return 'Only an item waiting for approval can be approved';
    return null;
  }

  if (to === 'rejected') {
    if (!can(user.role, 'admin.content')) return 'Sending an item back needs content permission';
    if (item.status !== 'pending') return 'Only an item waiting for approval can be sent back';
    return null;
  }

  /* Back to draft only from the approval queue. From approved it would be a
     way out of use that skips the reason withdrawing asks for. */
  if (to === 'draft') {
    if (!['pending', 'rejected'].includes(item.status)) return 'Withdraw it instead';
    return owns ? null : 'Only the library owner can do that';
  }
  if (to === 'withdrawn') {
    if (item.status !== 'approved') return 'Only an approved item is withdrawn';
    return owns ? null : 'Only the library owner can withdraw this';
  }
  /* QA-37: withdraw, then archive. Something on offer is withdrawn first, so
     there is always a recorded reason it stopped going to clients. */
  if (to === 'archived') {
    if (item.status === 'approved' || item.status === 'pending') return 'Withdraw it first, then archive it';
    if (item.status === 'archived') return 'It is already archived';
    return owns ? null : 'Only the library owner can archive this';
  }
  return 'That change is not allowed';
}

/**
 * What an item's expiry should be, if nobody set one.
 *
 * The failure this prevents is not somebody choosing badly, it is nobody
 * choosing at all — four years later the library is full of documents nobody
 * has looked at since. A library default answers the question by omission.
 */
export function expiryFor(library, given) {
  if (given) return given;
  if (!library?.default_expiry_days) return null;
  return one("SELECT date('now', ?) d", [`+${Number(library.default_expiry_days)} days`]).d;
}

/**
 * Items in one library, with everything the screen needs to show state.
 *
 * `expired` is derived rather than stored. A stored flag needs something to
 * turn it on, and whatever that is will not have run at the moment somebody
 * reads the screen.
 */
export const itemsIn = (libraryId) => all(
  `SELECT c.*, pt.name AS product_name, u.name AS approved_by_name,
          CASE WHEN c.expiry_date IS NOT NULL AND date(c.expiry_date, '+330 minutes') < date('now', '+330 minutes') THEN 1 ELSE 0 END AS expired,
          CASE WHEN c.expiry_date IS NOT NULL AND date(c.expiry_date) <= date('now', '+30 days')
                AND date(c.expiry_date, '+330 minutes') >= date('now', '+330 minutes') THEN 1 ELSE 0 END AS expiring_soon
     FROM content_items c
     LEFT JOIN product_types pt ON pt.id = c.product_type_id
     LEFT JOIN users u ON u.id = c.approved_by
    WHERE c.library_id ${libraryId ? '= ?' : 'IS NULL'}
    ORDER BY c.name`,
  libraryId ? [libraryId] : [],
);

/** Whether an item may actually be sent to a client, right now. */
export const isSendable = (item) => Boolean(
  STATUSES[item.status]?.sendable
  && (!item.expiry_date || new Date(item.expiry_date) >= new Date(new Date().toISOString().slice(0, 10))),
);

export function setStatus(item, to, user, reason = null) {
  run(
    `UPDATE content_items SET status = ?,
       submitted_at   = CASE WHEN ? = 'pending'  THEN datetime('now') ELSE submitted_at END,
       approved_by    = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END,
       approved_at    = CASE WHEN ? = 'approved' THEN datetime('now') ELSE approved_at END,
       rejected_reason = CASE WHEN ? = 'rejected' THEN ? ELSE NULL END,
       withdrawn_at    = CASE WHEN ? = 'withdrawn' THEN datetime('now') ELSE withdrawn_at END,
       withdrawn_by    = CASE WHEN ? = 'withdrawn' THEN ? ELSE withdrawn_by END,
       withdraw_reason = CASE WHEN ? = 'withdrawn' THEN ? ELSE withdraw_reason END
     WHERE id = ?`,
    [to, to, to, user.id, to, to, reason, to, to, user.id, to, reason, item.id],
  );
  /* QA-37: a new version replaces the one before it at the moment it is
     approved, not before -- until then the old one is still what goes out. */
  if (to === 'approved' && item.supersedes_id) supersede(item.supersedes_id);
}

/** Take the version a newer one replaces out of use. */
function supersede(oldId) {
  run("UPDATE content_items SET status = 'archived' WHERE id = ? AND status <> 'archived'", [oldId]);
}

/**
 * A new version of an item (QA-37: "a new version, approved before it is
 * offered").
 *
 * Its own row, linked to the one it replaces. In a library that requires
 * approval it starts as a draft and the current version stays on offer until
 * somebody other than its author approves the new one; in one that does not,
 * it replaces the old one at once. The old row is never edited, so what a
 * client was sent stays what the record says they were sent.
 */
export function newVersion(item, library, { url, expiry_date: expiry, name } = {}, user) {
  if (!url || !String(url).trim()) return { error: 'A new version needs the new file or link', field: 'url', status: 400 };
  if (!['approved', 'withdrawn'].includes(item.status)) {
    return { error: 'Only an approved or withdrawn item gets a new version; change a draft directly', status: 409 };
  }
  const open = one(
    "SELECT id FROM content_items WHERE supersedes_id = ? AND status IN ('draft', 'pending', 'rejected')",
    [item.id],
  );
  if (open) return { error: 'A new version of this is already waiting. Finish that one first.', status: 409 };

  const approval = Boolean(library?.requires_approval);
  const id = Number(run(
    `INSERT INTO content_items (name, type, url, product_type_id, kyc_step_code, version, expiry_date, owner_role,
                                library_id, status, created_by, sales_org, supersedes_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      String(name ?? item.name).trim(), item.type, String(url).trim(), item.product_type_id, item.kyc_step_code,
      item.version + 1, expiryFor(library, expiry || null), item.owner_role, item.library_id,
      approval ? 'draft' : 'approved', user.id, item.sales_org, item.id,
    ],
  ).lastInsertRowid);
  if (!approval) {
    run("UPDATE content_items SET approved_by = ?, approved_at = datetime('now') WHERE id = ?", [user.id, id]);
    supersede(item.id);
  }
  return { item: one('SELECT * FROM content_items WHERE id = ?', [id]), replaces_now: !approval };
}
