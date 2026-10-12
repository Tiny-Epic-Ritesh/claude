/**
 * A lead's KYC status, derived rather than stored.
 *
 * WHAT WAS WRONG
 * --------------
 * `leads.kyc_status` was a mirror: three places in the journey engine and one
 * webhook wrote it, and everything else read it. On the seeded data it was
 * already wrong on two of the six leads that have a journey at all — lead 2 read
 * "In Progress" while its journey had gone Stalled, and lead 26 read "Abandoned"
 * against a Stalled journey.
 *
 * That is a third of the rows that matter, in a database nobody has been using
 * in anger yet. It is the LeadSquared failure verbatim: a value maintained by
 * whoever remembered to maintain it, drifting from the thing it describes.
 *
 * THE TWO SOURCES
 * ---------------
 * A lead's KYC can be running in either of two places, and the answer has to
 * consider both:
 *
 *   internal   a `kyc_journeys` row — the CRM's own 16-step DKYC portal
 *   external   Bonanza's eKYC portal, which reports in by webhook and leaves
 *              `kyc_portal_stage` behind
 *
 * The internal journey wins when both exist, because a journey the CRM is
 * driving is the more specific fact. Neither is ever copied onto the lead.
 *
 * WHY COMPLETE BEATS RECENCY
 * --------------------------
 * A lead can carry a journey per product card, so "which one?" has to be
 * answered. It is not the newest: KYC in India is per client, not per product —
 * once someone is verified they are verified, and a later journey stalling on a
 * second product does not un-verify them. So the journeys are ranked by how far
 * they got, and the furthest wins.
 *
 * COST
 * ----
 * A correlated subquery per lead row. At 495k leads that is an indexed lookup
 * on `kyc_journeys(lead_id)` — the same shape as the score and AUM projections
 * already in `engine/metrics.js`, and the same trade: a little work on read in
 * exchange for a value that cannot be stale.
 */

import { one } from '../db.js';

/**
 * The SQL fragment, for anywhere that already selects from `leads`.
 *
 * `alias` is the table alias in the caller's query — `l` in most of them. It is
 * interpolated, so it must never come from a request; every caller passes a
 * literal.
 */
export const kycStatusSql = (alias = 'l') => `
  COALESCE(
    (SELECT j.status FROM kyc_journeys j
      WHERE j.lead_id = ${alias}.id
      ORDER BY CASE j.status
        WHEN 'Complete'    THEN 0
        /* Further than In Progress: the applicant finished everything and was
           sent back for one thing, which is a later state than still filling
           the form in. It ranks below Complete because it is not done.

           A BLOCK comment, not a line one: this whole fragment is collapsed to
           a single line by the .replace below, and a "--" comment would then
           comment out the rest of the statement -- which it did, and SQLite
           reported it as "incomplete input". */
        WHEN 'Objection'   THEN 1
        WHEN 'In Progress' THEN 2
        WHEN 'Stalled'     THEN 3
        WHEN 'Abandoned'   THEN 4
        ELSE 5 END, j.id DESC
      LIMIT 1),
    CASE
      WHEN ${alias}.client_code IS NOT NULL THEN 'Complete'
      /* Read from the stage mapped into our own vocabulary, not from the raw
         string the portal sent: an objection and a rejection are the two
         outcomes that have to be told apart, and both used to read
         "In Progress" -- Rejected was a status KYC_STATUSES offered and
         nothing could produce. */
      WHEN ${alias}.kyc_portal_state = 'Objection' THEN 'Objection'
      WHEN ${alias}.kyc_portal_state = 'Rejected' THEN 'Rejected'
      WHEN ${alias}.kyc_portal_stage IS NOT NULL THEN 'In Progress'
    END,
    'Not Started'
  )`.replace(/\s+/g, ' ').trim();

/** The same answer for one lead, for code paths that hold a row rather than a query. */
export function kycStatusFor(leadId) {
  const row = one(
    `SELECT ${kycStatusSql('l')} AS status FROM leads l WHERE l.id = ?`,
    [leadId],
  );
  return row?.status ?? 'Not Started';
}

/**
 * Decorate a lead row that has already been fetched.
 *
 * Used where a route has the row in hand and adding the subquery to its SELECT
 * would mean rewriting a large query for one column.
 */
export const withKycStatus = (lead) =>
  (lead ? { ...lead, kyc_status: kycStatusFor(lead.id) } : lead);

/** Every value the derived status can take, for pickers and validation. */
export const KYC_STATUSES = [
  'Not Started', 'In Progress', 'Objection', 'Stalled', 'Abandoned', 'Complete', 'Rejected',
];
