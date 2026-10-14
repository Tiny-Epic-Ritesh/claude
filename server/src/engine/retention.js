/**
 * Erasing the leads whose retention has run out (QA-37, Ritesh 14 Oct).
 *
 * QA-37 ruled that a lead is recycled, restorable, and purged only after the
 * retention period, by an Admin. The period is a Business policy
 * (engine/policies.js, retention.lead_years, three years by default): the
 * DPDP Act asks for erasure once the purpose is served, and a lead who never
 * became a client and has not been touched for that long has served it.
 *
 * Purgeable means all of: in the recycle bin; never an account -- no client
 * converted from it and no UCC on it, since a client's records are kept for
 * at least eight years under SEBI's Stock Brokers Regulations
 * (retention.client_years) and are not a lead's to erase; and nothing on it
 * -- the lead itself, its deletion, its activities -- for the whole period.
 *
 * A purge is permanent. It removes the lead, and with it what hangs off it
 * by the schema's own rules: its cards and its activities go with it, a case
 * or a task that named it keeps going without the link. The audit records
 * how many, which ids, why and under what period -- never a name.
 */

import { all, run, transact, audit } from '../db.js';
import { policy } from './policies.js';

/** The leads in these books whose retention has run out, oldest first. */
export function purgeableLeads(books) {
  if (!books?.length) return [];
  const years = policy('retention.lead_years');
  return all(
    `SELECT * FROM (
       SELECT l.id, l.sales_org, l.deleted_at,
              MAX(COALESCE(l.updated_at, l.created_at),
                  COALESCE(l.deleted_at, l.created_at),
                  COALESCE((SELECT MAX(a.created_at) FROM activities a WHERE a.lead_id = l.id), l.created_at)) AS last_touched
         FROM leads l
        WHERE l.deleted_at IS NOT NULL
          AND l.sales_org IN (${books.map(() => '?').join(',')})
          AND (l.client_code IS NULL OR TRIM(l.client_code) = '')
          AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.converted_from_lead_id = l.id)
     ) WHERE last_touched <= datetime('now', ?)
     ORDER BY last_touched`,
    [...books, `-${years} years`],
  );
}

/**
 * Purge what is purgeable in these books. `ids`, when given, narrows it; an
 * id that is not purgeable is left alone and reported, never purged.
 */
export function purgeLeads({ books, ids = null, user, reason }) {
  const eligible = purgeableLeads(books);
  const allowed = new Set(eligible.map((l) => l.id));
  const wanted = ids ? ids.map(Number) : [...allowed];
  const refused = wanted.filter((id) => !allowed.has(id));
  const purge = wanted.filter((id) => allowed.has(id));

  transact(() => {
    for (const id of purge) run('DELETE FROM leads WHERE id = ?', [id]);
  });
  audit(user.id, 'leads_purged', 'lead', null, {
    count: purge.length, ids: purge, reason, retention_years: policy('retention.lead_years'), books,
  });
  return { purged: purge.length, ids: purge, refused };
}
