/**
 * D9 (OPS-64): field history for every change, by whatever path it is made.
 *
 * A field Setup marks "history tracked" promises its record's history shows
 * every change to it -- who, when, from what to what -- and stage entry and
 * exit (non-negotiable 4) are read straight from that history
 * (`stageDurations` in metadata.js). The promise was kept only by the screens
 * that called `recordChange` themselves: a lead's own edit, a lead transfer,
 * account opening, a case's status. Some forty other writes changed a tracked
 * field and left no trace -- every bulk update, assignment rules, queues,
 * automation rules, imports, approvals, escalation, a partner's activation, a
 * product card's every move, a task's completion. A lead's history did not
 * show most of the times it changed hands, and "days in stage" was wrong
 * whenever a rule moved one.
 *
 * `tracked()` is the one way code changes a tracked column. It reads the
 * tracked fields of the records named, runs the write, reads them again, and
 * records each difference. Two reasons for this shape rather than a history
 * line beside each UPDATE:
 *
 *   - the write stays exactly as it was. Each of these UPDATEs carries its
 *     own extra columns (assigned_at, last_state_at, owner_queue_id, ...) and
 *     some are built from a field name chosen at run time; rewriting them
 *     into one generic setter is how a column gets dropped
 *   - what is tracked is Setup's decision, read at the time of the write. A
 *     field marked tracked tomorrow is recorded by every path the next time
 *     it changes, without anybody finding the paths
 *
 * `test/fieldhistory.test.mjs` reads every UPDATE of a tracked table and fails
 * on one that changes a tracked column outside `tracked()` or `recordChange`.
 */

import { all } from '../db.js';
import { recordChange, historyFor, fieldDef, canReadField } from './metadata.js';
import { maskedFieldsFor } from './masking.js';
import { activeMaskers } from '../security.js';

/** The table behind each entity a field can be tracked on. */
export const TRACKED_TABLES = {
  lead: 'leads',
  case: 'tickets',
  client: 'clients',
  partner: 'partners',
  product_interest: 'product_cards',
  task: 'tasks',
};

/** The entity a table belongs to, for code that has only the table. */
export const entityOfTable = (table) =>
  Object.entries(TRACKED_TABLES).find(([, t]) => t === table)?.[0] ?? null;

/**
 * Where a change came from, as the history shows it ("via automation").
 * `ui` is a person in the CRM, a bulk action included: the person is named.
 */
export const SOURCE = {
  ui: 'ui',
  api: 'api',               // an API key
  automation: 'automation', // a rule, a flow, an assignment rule, a sweep
  import: 'import',
  vendor: 'vendor',         // a vendor's callback: KYC, telephony
  approval: 'approval',     // applied when a request was approved
  portal: 'portal',         // a partner or an applicant, outside the CRM
  handover: 'handover',     // a leaver's records moved in Setup, or put back
};

/** A request's source: a person in the CRM, or an API key acting for one. */
export const sourceOf = (req) => (req?.api_credential ? SOURCE.api : SOURCE.ui);

/** The tracked columns of an entity, as Setup has them now. */
export function trackedColumns(entity) {
  return all(
    `SELECT api_name FROM field_def
      WHERE entity = ? AND active = 1 AND history_tracked = 1 AND storage = 'column'`,
    [entity],
  ).map((r) => r.api_name).filter((c) => /^[a-z_][a-z0-9_]*$/i.test(c));
}

/**
 * Run `write` and record history for every tracked field it changed on the
 * records named.
 *
 * @param entity  a key of TRACKED_TABLES
 * @param ids     one id or several: the records the write may change
 * @param who     { actorId, source }: the person behind it (null for none),
 *                and where it came from (SOURCE)
 * @param write   the write itself, run once; its return value is returned
 */
export function tracked(entity, ids, { actorId = null, source = SOURCE.ui } = {}, write) {
  const table = TRACKED_TABLES[entity];
  // A programming error, not a user's: loud, never a silent write without history.
  if (!table) throw new Error(`tracked: no table for "${entity}". Add it to TRACKED_TABLES.`);
  if (!Object.values(SOURCE).includes(source)) throw new Error(`tracked: unknown source "${source}"`);

  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  const cols = trackedColumns(entity);
  if (!list.length || !cols.length) return write();

  const read = () => {
    const out = new Map();
    // In slices: SQLite caps the number of bound values in one statement.
    for (let i = 0; i < list.length; i += 500) {
      const slice = list.slice(i, i + 500);
      for (const row of all(
        `SELECT id, ${cols.join(', ')} FROM ${table} WHERE id IN (${slice.map(() => '?').join(',')})`,
        slice,
      )) out.set(Number(row.id), row);
    }
    return out;
  };

  const before = read();
  const result = write();
  const after = read();

  for (const [id, was] of before) {
    const now = after.get(id);
    if (!now) continue;   // deleted by the write: its history ends where it was
    for (const col of cols) {
      // recordChange skips a value that did not change, and a field that is not tracked.
      recordChange(entity, id, col, was[col], now[col], { actorId: actorId ?? null, source });
    }
  }
  return result;
}

/**
 * A record's history as one reader may see it (OPS-66).
 *
 * The history is the record's own values over time, so it is read under the
 * same rules as the record: a field the reader's field security withholds is
 * left out, and a value their role sees masked is masked in its history too.
 * Otherwise a tracked mobile or PAN could be read in the clear from the change
 * list beside the masked one. The caller decides first that the reader may
 * open the record at all.
 */
export function historyAsSeenBy(entity, recordId, user, { ownerId = null, caps = null, limit = 100 } = {}) {
  const masked = maskedFieldsFor(user?.role);
  const maskers = activeMaskers();
  const defs = new Map();
  const def = (field) => {
    if (!defs.has(field)) defs.set(field, fieldDef(entity, field) ?? null);
    return defs.get(field);
  };
  return historyFor(entity, recordId, limit)
    .filter((h) => {
      const d = def(h.field);
      return !d || canReadField(user, d, ownerId, caps);
    })
    .map((h) => {
      const mask = masked.has(h.field) ? maskers[h.field] : null;
      if (!mask) return h;
      return {
        ...h,
        old_value: h.old_value == null ? null : mask(h.old_value),
        new_value: h.new_value == null ? null : mask(h.new_value),
        old_label: null,
        new_label: null,
        _masked: true,
      };
    });
}
