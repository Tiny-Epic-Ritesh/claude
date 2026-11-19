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
 * (retention.client_years) and are not a lead's to erase; nothing on it --
 * the lead itself, its deletion, its activities -- for the whole period; and
 * no case naming it, or one of its product interests (B23, ruled 19 Nov). A
 * case is never deleted (QA-37's table, 14 Oct), and a case kept without the
 * lead it is about no longer says whose complaint it was, so the lead stays
 * while a case does. The recycle bin says which leads are kept, and why.
 *
 * A purge is permanent. It removes the lead, and with it what hangs off it by
 * the schema's own rules (ON DELETE CASCADE): its product interests, its
 * activities and its tasks (B23: a task on an erased lead has nothing left to
 * do, and its title often names the person). Their custom field values and
 * their field history go in the same step (OPS-70, OPS-72): both name a record
 * by type and number rather than by a link, so the cascade never reached them,
 * and a tracked mobile or a custom field outlived the purge meant to erase it.
 * The audit records how many, which ids, why and under what period -- never a
 * name.
 *
 * Until 19 Nov this note said "a case or a task that named it keeps going
 * without the link". The schema has always cascaded both, so a purge erased
 * the lead's cases too -- a complaint closed a year before, or an open one
 * worked only by status changes and internal notes, which write nothing to
 * the lead's timeline (OPS-71).
 */

import { all, run, transact, audit } from '../db.js';
import { policy } from './policies.js';

/** The references of the cases that name lead `l`, directly or through one of its product interests. */
const CASE_REFS = `(SELECT GROUP_CONCAT(t.ref, ',') FROM tickets t
  WHERE t.lead_id = l.id
     OR t.card_id IN (SELECT pc.id FROM product_cards pc WHERE pc.lead_id = l.id))`;

/**
 * The leads in these books whose retention has run out, oldest first, each
 * with the cases that name it (`case_refs`, comma-separated, or null).
 */
function retentionRunOut(books) {
  if (!books?.length) return [];
  const years = policy('retention.lead_years');
  return all(
    `SELECT * FROM (
       SELECT l.id, l.sales_org, l.deleted_at,
              MAX(COALESCE(l.updated_at, l.created_at),
                  COALESCE(l.deleted_at, l.created_at),
                  COALESCE((SELECT MAX(a.created_at) FROM activities a WHERE a.lead_id = l.id), l.created_at)) AS last_touched,
              ${CASE_REFS} AS case_refs
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

/** The leads in these books whose retention has run out and that no case names: what a purge may erase. */
export function purgeableLeads(books) {
  return retentionRunOut(books)
    .filter((l) => !l.case_refs)
    .map(({ case_refs: _none, ...lead }) => lead);
}

/**
 * The leads in these books whose retention has run out but that a case still
 * names, with those cases' references (B23): kept, and the recycle bin says why.
 */
export function keptForCases(books) {
  return retentionRunOut(books)
    .filter((l) => l.case_refs)
    .map((l) => ({ id: l.id, sales_org: l.sales_org, last_touched: l.last_touched, cases: l.case_refs.split(',') }));
}

/*
 * What a purge takes with a lead by the schema's own rules, by the entity name
 * their custom field values and field history are filed under. Each query
 * gives the ids of that entity's records that go with lead `?`; `binds` is how
 * many times it needs the lead's id. Read before the lead is deleted: after,
 * there is nothing left to ask.
 */
const CARDS_OF = 'SELECT id FROM product_cards WHERE lead_id = ?';
const GOES_WITH = [
  { entity: 'lead', ids: 'SELECT ?', binds: 1 },
  { entity: 'product_interest', ids: CARDS_OF, binds: 1 },
  { entity: 'task', ids: `SELECT id FROM tasks WHERE lead_id = ? OR card_id IN (${CARDS_OF})`, binds: 2 },
  { entity: 'interaction', ids: `SELECT id FROM activities WHERE lead_id = ? OR card_id IN (${CARDS_OF})`, binds: 2 },
];

/** Erase the custom field values and field history of a lead and of everything that goes with it. */
function eraseValuesAndHistory(leadId) {
  for (const { entity, ids, binds } of GOES_WITH) {
    const params = [entity, ...Array(binds).fill(leadId)];
    run(`DELETE FROM field_history WHERE entity = ? AND record_id IN (${ids})`, params);
    run(`DELETE FROM field_value WHERE entity = ? AND record_id IN (${ids})`, params);
  }
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
    for (const id of purge) {
      eraseValuesAndHistory(id);
      run('DELETE FROM leads WHERE id = ?', [id]);
    }
  });
  audit(user.id, 'leads_purged', 'lead', null, {
    count: purge.length, ids: purge, reason, retention_years: policy('retention.lead_years'), books,
  });
  return { purged: purge.length, ids: purge, refused };
}
