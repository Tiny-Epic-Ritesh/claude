/**
 * Opening a case, one way.
 *
 * WHY THIS EXISTS (QA-03, QA-28)
 *
 * A case can be opened through three doors — the case screen, the Partner
 * Portal and a confirmed AI call disposition — and each door had its own copy
 * of "open a case". They agreed about almost nothing:
 *
 *                     book   category   agent in the book   SLA clock
 *   case screen        yes      yes            yes             yes
 *   Partner Portal     no       no             no              yes
 *   AI disposition     no       no             no              no
 *
 * The portal gave a Bonanza partner's ticket to whichever Customer Care agent
 * was least busy in either business (QA-03: BNZ-00010, assigned to a Bigul
 * agent and shown as Uncategorised). The AI door raised a High compliance case
 * with no category and no deadlines (QA-28: BNZ-00011), assigned to the first
 * Customer Care agent in the table in either business. Both numbered every
 * case BNZ-, whoever it was about.
 *
 * So there is one way to open a case now, and the doors differ only in what
 * they know: the screen is told the category, the portal knows it is Partner
 * Support, and the AI disposition knows which compliance flag it raised.
 */

import { all, one, run } from '../db.js';
import { mayUseOrg } from '../auth.js';
import { applySla } from './sla.js';

/**
 * Whoever in this role carries the fewest open cases in the case's own book.
 *
 * Load is open cases, not leads: the question is who has room in their queue
 * now. The book test is `mayUseOrg`, the definition the case screen's own
 * gate uses. It was once `sales_org = ? OR org_access LIKE ?`, which reads like
 * the same rule and is not: `org_access` replaces a user's own book rather
 * than adding to it, and the LIKE was a substring test on JSON text.
 *
 * Nobody eligible returns null, never somebody from the other business.
 * Unassigned in the right book is recoverable from the queue; assigned in the
 * wrong one is a case that nobody who can read it is working.
 */
export function caseAssignee(role, org) {
  if (!role || !org) return null;
  return all(
    `SELECT id, role, sales_org, org_access,
            (SELECT COUNT(*) FROM tickets
              WHERE assignee_id = users.id AND status NOT IN ('Resolved','Closed')) AS open_load
       FROM users
      WHERE role = ? AND active = 1
      ORDER BY open_load, id`,
    [role],
  ).find((u) => mayUseOrg(u, org)) ?? null;
}

/** `BNZ-00012` or `BGL-00012`, so the book is readable from the reference. */
export const caseRef = (org, id) => `${org === 'BIGUL' ? 'BGL' : 'BNZ'}-${String(id).padStart(5, '0')}`;

/**
 * A live category by its name, for the two doors that cannot ask a person to
 * choose one. A door whose category has been retired or renamed opens the case
 * uncategorised rather than refusing it: the client's problem still needs an
 * owner and a deadline.
 */
export const categoryNamed = (name) => (name
  ? one('SELECT * FROM ticket_categories WHERE name = ? AND active = 1', [name]) ?? null
  : null);

/**
 * Open a case. Returns `{ id, ref, assignee, category }`.
 *
 * The book is required rather than defaulted. `tickets.sales_org` defaults to
 * BONANZA at the column, which is how two of the three doors filed every case
 * they opened into Bonanza's book; a caller that does not know the book has a
 * bug to fix, not a default to lean on.
 *
 * The caller still owns everything that is its own business: the case screen
 * writes a timeline entry and refreshes the AI summary, and each door words
 * its own notification.
 */
export function openCase({
  subject, description = null, priority = 'Medium', categoryId = null,
  leadId = null, cardId = null, partnerId = null, channel = 'CRM', createdBy = null, org,
}) {
  if (!org) throw new Error('openCase: the book the case belongs to is required');

  const category = categoryId ? one('SELECT * FROM ticket_categories WHERE id = ?', [categoryId]) : null;
  const assignee = caseAssignee(category?.auto_assign_role ?? 'customer_care', org);

  const result = run(
    `INSERT INTO tickets (subject, description, priority, category_id, lead_id, card_id, partner_id, channel, assignee_id, created_by, status, sales_org)
     VALUES (?,?,?,?,?,?,?,?,?,?,'Open',?)`,
    [subject, description, priority, category?.id ?? null, leadId, cardId, partnerId, channel,
      assignee?.id ?? null, createdBy, org],
  );
  const id = Number(result.lastInsertRowid);
  const ref = caseRef(org, id);
  run('UPDATE tickets SET ref = ? WHERE id = ?', [ref, id]);

  applySla(id);

  return { id, ref, assignee, category };
}
