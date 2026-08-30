/**
 * Loading a record without forgetting which business it belongs to.
 *
 * In August, nine routes loaded a record by id and returned it without checking
 * whether the reader's business owned it. None of the nine was a hard problem;
 * each needed the same three lines, and nine times in a row somebody did not
 * write them (docs/security/CROSS-BOOK-EXPOSURE-2026-08.md).
 *
 * That is not a discipline problem, it is a shape problem. `one('SELECT * FROM
 * tickets WHERE id = ?')` is the obvious thing to type and it is unsafe, so the
 * unsafe path is the default one. This module exists to make the safe path the
 * obvious one instead:
 *
 *     const { row: ticket, error, status } = loadInBook(req, 'ticket', req.params.id);
 *     if (error) return res.status(status).json({ error });
 *
 * It does not replace the per-route checks already in place — those are tested
 * and working. It is what the NEXT record route should use, and what
 * test/bookscope.test.mjs checks new routes against.
 */

import { one } from '../db.js';
import { orgsFor } from '../auth.js';

/**
 * How to find a record, and how to find the business that owns it.
 *
 * Three shapes, because ownership sits in three different places:
 *
 *   direct   the table has its own sales_org
 *   by lead  the record hangs off a lead and inherits the lead's business
 *   by card  the record hangs off a card, which hangs off a lead
 *
 * A record type absent from here cannot be loaded through this module, which is
 * deliberate: adding one is a decision about where its business comes from, and
 * that decision should be made explicitly rather than defaulted.
 */
export const RECORD_KINDS = {
  lead: {
    label: 'lead',
    sql: 'SELECT l.*, l.sales_org AS __org FROM leads l WHERE l.id = ? AND l.deleted_at IS NULL',
  },
  client: {
    label: 'client',
    sql: 'SELECT c.*, c.sales_org AS __org FROM clients c WHERE c.id = ? AND c.deleted_at IS NULL',
  },
  ticket: {
    label: 'ticket',
    sql: 'SELECT t.*, t.sales_org AS __org FROM tickets t WHERE t.id = ?',
  },
  list: {
    label: 'list',
    sql: 'SELECT ll.*, ll.sales_org AS __org FROM lead_lists ll WHERE ll.id = ?',
  },
  partner: {
    label: 'partner',
    sql: 'SELECT p.*, p.sales_org AS __org FROM partners p WHERE p.id = ?',
  },
  card: {
    label: 'card',
    sql: `SELECT pc.*, l.sales_org AS __org
            FROM product_cards pc JOIN leads l ON l.id = pc.lead_id
           WHERE pc.id = ?`,
  },
  journey: {
    label: 'journey',
    // A journey with no lead has no business to inherit, so __org is NULL and
    // the refusal below catches it. Failing closed is the right answer for a
    // record carrying an applicant's resume token.
    sql: `SELECT j.*, l.sales_org AS __org
            FROM kyc_journeys j LEFT JOIN leads l ON l.id = j.lead_id
           WHERE j.id = ?`,
  },
  card_audit_parent: {
    label: 'card',
    sql: `SELECT pc.id, l.sales_org AS __org
            FROM product_cards pc JOIN leads l ON l.id = pc.lead_id
           WHERE pc.id = ?`,
  },
};

/**
 * Load a record and decide whether this request may have it.
 *
 * Returns `{ row }` on success, or `{ error, status }` on refusal — never
 * throws, so a route reads as one guard clause rather than a try/catch.
 *
 * 404 when it does not exist; 403 when it exists in the other business. Those
 * are told apart deliberately: a system that returns 404 for "not yours" cannot
 * distinguish a typo from a boundary refusal in its own logs, and the access
 * log is the thing that has to answer that question later.
 */
export function loadInBook(req, kind, id) {
  const spec = RECORD_KINDS[kind];
  if (!spec) {
    // A programming error, not a user error. Loud, and never a silent allow.
    throw new Error(`loadInBook: no record kind "${kind}". Add it to RECORD_KINDS.`);
  }

  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { error: `That is not a ${spec.label} id`, status: 400 };
  }

  const row = one(spec.sql, [numeric]);
  if (!row) return { error: `${cap(spec.label)} not found`, status: 404 };

  const org = row.__org ?? null;
  if (org === null || !orgsFor(req.user).includes(org)) {
    return { error: `This ${spec.label} belongs to another book`, status: 403 };
  }

  const { __org, ...clean } = row;
  return { row: clean, org };
}

/**
 * The same decision for a record already in hand.
 *
 * For routes that have loaded a row for their own reasons and only need the
 * boundary answered.
 */
export function reachable(req, org) {
  return org != null && orgsFor(req.user).includes(org);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
