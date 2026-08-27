/**
 * Clients — conversion, backfill and the unified timeline.
 *
 * A client is a live account: a UCC, a demat ID, a ledger, a risk profile and a
 * retention obligation measured in years. A lead is a prospect somebody is
 * working. The legacy tenant stored both in one row and paid for it in the
 * forty trading and financial mx_ fields catalogued in
 * docs/legacy-leadsquared/lead-fields.md, every one of which describes an
 * account that exists on a record that might only be an enquiry.
 *
 * This module owns the boundary between the two.
 */

import { all, one, run } from '../db.js';
import { encryptField, decryptField, blindIndex } from '../security.js';

/**
 * The segments an account can be enabled for.
 *
 * A list, not a column each. The legacy schema spent six boolean columns and
 * six activation-date twins on exactly this, which is why adding "Global" there
 * was a migration and here is a row.
 */
export const SEGMENTS = [
  'Equity', 'Derivatives', 'Commodity', 'Currency', 'Mutual Fund', 'Global',
];

export const CLIENT_STATUSES = ['Active', 'Dormant', 'Suspended', 'Closed'];

/**
 * Dormancy is a derived read, never a stored flag.
 *
 * A stored one needs a writer, and the writer is a nightly job that will at
 * some point not run — leaving a dormant account reading Active on the very
 * screen someone opened to find dormant accounts. Ninety days with no trade is
 * the retail broking convention.
 */
export const dormantSql = (alias = 'c') => `
  CASE
    WHEN ${alias}.status IN ('Closed', 'Suspended') THEN ${alias}.status
    WHEN ${alias}.last_traded_at IS NULL
      AND julianday('now') - julianday(${alias}.activated_at) > 90 THEN 'Dormant'
    WHEN ${alias}.last_traded_at IS NOT NULL
      AND julianday('now') - julianday(${alias}.last_traded_at) > 90 THEN 'Dormant'
    ELSE 'Active'
  END`;

/**
 * Turn a lead into a client.
 *
 * Idempotent on (client_code, sales_org): calling it twice for the same UCC
 * returns the existing account rather than creating a second one. That matters
 * because the trigger is an external event — the account-opening feed — and
 * external feeds redeliver.
 *
 * Nothing is copied off the lead except identity. The lead keeps its own
 * activities, its own owner history and its own audit trail; the client points
 * back at it. Copying would be mirroring, which is the first non-negotiable.
 */
export function convertLead(leadId, {
  clientCode,
  dematId = null,
  activatedAt = null,
  segments = [],
  ownerId = null,
} = {}) {
  const lead = one('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL', [leadId]);
  if (!lead) return { ok: false, error: 'Lead not found' };

  const code = String(clientCode || lead.client_code || '').trim();
  if (!code) return { ok: false, error: 'A UCC is required to convert a lead' };

  const existing = one(
    'SELECT * FROM clients WHERE client_code = ? AND sales_org = ?',
    [code, lead.sales_org],
  );
  if (existing) return { ok: true, client: existing, created: false };

  const info = run(
    `INSERT INTO clients
       (client_code, name, pan, mobile, email, demat_id, sales_org, owner_id,
        partner_id, converted_from_lead_id, risk_profile, activated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      code, lead.name,
      // Already ciphertext on the lead. Re-encrypting a ciphertext would double
      // wrap it and make the account's PAN permanently unreadable.
      lead.pan,
      lead.mobile, lead.email, dematId, lead.sales_org,
      ownerId ?? lead.owner_id, lead.partner_id, lead.id, lead.risk_profile,
      activatedAt || new Date().toISOString().slice(0, 19).replace('T', ' '),
    ],
  );

  const clientId = Number(info.lastInsertRowid);
  setSegments(clientId, segments);

  // The lead carries the UCC too, so existing screens and the KYC feed keep
  // working unchanged. It is a pointer now, not the definition of a client.
  if (!lead.client_code) {
    run('UPDATE leads SET client_code = ?, updated_at = datetime(\'now\') WHERE id = ?', [code, leadId]);
  }

  return { ok: true, client: one('SELECT * FROM clients WHERE id = ?', [clientId]), created: true };
}

/** Replace the segment set for an account. Unknown segment names are dropped. */
export function setSegments(clientId, segments = []) {
  const wanted = [...new Set(segments.filter((s) => SEGMENTS.includes(s)))];
  run('DELETE FROM client_segments WHERE client_id = ?', [clientId]);
  for (const segment of wanted) {
    run(
      `INSERT INTO client_segments (client_id, segment, active, activated_at)
       VALUES (?,?,1,datetime('now'))`,
      [clientId, segment],
    );
  }
  return wanted;
}

export const segmentsFor = (clientId) =>
  all('SELECT segment, active, activated_at FROM client_segments WHERE client_id = ? ORDER BY segment', [clientId]);

/**
 * The unified timeline.
 *
 * A client's history did not begin at conversion. The calls that won the
 * account sit on the lead, and an RM opening the account expects to see them.
 *
 * This is a UNION, not a copy. Non-negotiable #1 forbids mirroring activity
 * between records, and the legacy audit shows why: once the same interaction
 * exists twice, the two diverge and nobody can say which is true. The lead
 * keeps its rows, the client keeps its own, and the read joins them.
 */
export function timelineFor(client, limit = 100) {
  if (!client) return [];
  const params = [client.id];
  let where = 'a.client_id = ?';
  if (client.converted_from_lead_id) {
    where += ' OR a.lead_id = ?';
    params.push(client.converted_from_lead_id);
  }
  params.push(limit);

  return all(
    `SELECT a.*, u.name AS user_name,
            CASE WHEN a.client_id = ${Number(client.id)} THEN 'client' ELSE 'lead' END AS origin
       FROM activities a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE ${where}
      ORDER BY a.created_at DESC
      LIMIT ?`,
    params,
  );
}

/**
 * Create client records for leads that already carry a UCC.
 *
 * Runs on boot and is safe to run repeatedly. Without it the Clients tab would
 * be empty on an existing database while every account in the business sits in
 * the leads table with a client_code on it — which is the state this change
 * exists to end.
 */
export function backfillClients() {
  const pending = all(`
    SELECT l.* FROM leads l
     WHERE l.client_code IS NOT NULL AND TRIM(l.client_code) <> ''
       AND l.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM clients c
          WHERE c.client_code = l.client_code AND c.sales_org = l.sales_org)`);

  let created = 0;
  for (const lead of pending) {
    const r = convertLead(lead.id, { clientCode: lead.client_code });
    if (r.ok && r.created) created += 1;
  }
  return { scanned: pending.length, created };
}

/**
 * Give existing leads a searchable PAN fingerprint.
 *
 * Rows created before the blind index existed hold ciphertext and nothing to
 * match on, so the duplicate check would silently miss every one of them --
 * which is worse than not offering PAN search at all, because it answers
 * "no match" with apparent confidence.
 *
 * Decrypts and re-hashes only the rows that need it, so it is a no-op on every
 * boot after the first.
 */
export function backfillPanIndex() {
  const pending = all(
    "SELECT id, pan FROM leads WHERE pan IS NOT NULL AND TRIM(pan) <> '' AND pan_bidx IS NULL",
  );
  let done = 0;
  for (const row of pending) {
    const plain = decryptField(row.pan);
    if (!plain) continue;
    run('UPDATE leads SET pan_bidx = ? WHERE id = ?', [blindIndex(String(plain).toUpperCase()), row.id]);
    done += 1;
  }
  return { scanned: pending.length, indexed: done };
}
