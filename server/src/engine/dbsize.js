/**
 * Database size, per book and per object (P2-19).
 *
 * WHAT IS MEASURED AND WHAT IS ESTIMATED
 *
 * The total and the per-table bytes are real: SQLite's `dbstat` reports actual
 * page usage per table and index, so "leads occupies 4.2 MB" is a fact.
 *
 * The per-book split is NOT. A table holds rows from both businesses in the
 * same pages, and nothing short of reading every row would say how many bytes
 * belong to which. So it is apportioned by row share and labelled an estimate
 * everywhere it appears. A number that looks precise and is not is worse than
 * an obviously rounded one — somebody will eventually put it in a capacity plan.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 *
 * Q-14 established that the platform is not multi-tenant in the isolation
 * sense: one database, one schema, a sales_org column. That answer is also the
 * reason this screen can only estimate. If Bigul ever needs genuine isolation
 * the split stops being an estimate and starts being a fact — and it is far
 * cheaper to make that change before 495,118 leads land than after.
 */

import { all, one, run } from '../db.js';

const BYTES = (n) => Number(n) || 0;

/** Total pages actually in use, which is the number a disk quota cares about. */
export function totalBytes() {
  const pages = one('PRAGMA page_count')?.page_count ?? 0;
  const size = one('PRAGMA page_size')?.page_size ?? 0;
  const free = one('PRAGMA freelist_count')?.freelist_count ?? 0;
  return {
    total: pages * size,
    // Space the file holds but is not using. A VACUUM returns it.
    reclaimable: free * size,
    pages,
    page_size: size,
  };
}

/**
 * Bytes per table, indexes folded into the table they serve.
 *
 * An index is not a separate thing an administrator can reason about — it
 * exists because of its table, and reporting it separately makes the biggest
 * table look smaller than it is.
 */
export function perTable() {
  const rows = all('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name');
  const indexOwner = new Map(
    all("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'")
      .map((i) => [i.name, i.tbl_name]),
  );

  const totals = new Map();
  for (const r of rows) {
    const owner = indexOwner.get(r.name) ?? r.name;
    totals.set(owner, BYTES(totals.get(owner)) + BYTES(r.bytes));
  }
  return totals;
}

/**
 * The breakdown an administrator reads: one row per object, with its table's
 * real bytes and its rows split by book.
 *
 * Objects come from entity_def, so this follows the configuration rather than a
 * second hard-coded list that would drift the first time an object was added.
 */
export function breakdown(orgs = []) {
  const bytes = perTable();
  const out = [];

  for (const e of all('SELECT api_name, label_plural, table_name FROM entity_def WHERE active = 1 ORDER BY sort_order')) {
    const cols = new Set(all(`PRAGMA table_info(${e.table_name})`).map((c) => c.name));
    const soft = cols.has('deleted_at') ? 'WHERE deleted_at IS NULL' : '';
    const total = one(`SELECT COUNT(*) n FROM ${e.table_name} ${soft}`).n;

    /* Not every table carries a book. An interaction belongs to its lead, and
       chasing that through a join for a size estimate would be precision
       theatre on a number already labelled an estimate. */
    const byOrg = {};
    if (cols.has('sales_org')) {
      for (const r of all(`SELECT sales_org, COUNT(*) n FROM ${e.table_name} ${soft} GROUP BY sales_org`)) {
        if (r.sales_org) byOrg[r.sales_org] = r.n;
      }
    }

    const visible = orgs.length && cols.has('sales_org')
      ? orgs.reduce((sum, o) => sum + (byOrg[o] ?? 0), 0)
      : total;

    const tableBytes = BYTES(bytes.get(e.table_name));
    out.push({
      object: e.api_name,
      label: e.label_plural,
      table: e.table_name,
      bytes: tableBytes,
      rows: visible,
      rows_total: total,
      by_org: byOrg,
      /* Apportioned by row share, and only when the table carries a book at
         all. Labelled an estimate on the screen. */
      estimated_bytes_by_org: cols.has('sales_org') && total > 0
        ? Object.fromEntries(Object.entries(byOrg).map(([o, n]) => [o, Math.round((n / total) * tableBytes)]))
        : null,
      bytes_are_estimated: false,
      split_is_estimated: cols.has('sales_org'),
    });
  }

  return out.sort((a, b) => b.bytes - a.bytes);
}

/**
 * Everything else in the file.
 *
 * Logs, sessions, audit history and the metadata layer are most of a young
 * database and none of them are objects. Leaving them out would make the
 * per-object figures add up to far less than the total, and the first question
 * anybody asks about a size report is why the numbers do not add up.
 */
export function nonObjectBytes() {
  const objectTables = new Set(all('SELECT table_name FROM entity_def').map((e) => e.table_name));
  const rows = [];
  for (const [table, bytes] of perTable()) {
    if (objectTables.has(table)) continue;
    rows.push({ table, bytes: BYTES(bytes) });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

/* ------------------------------------------------------------- growth */

/**
 * One sample a day, taken at boot.
 *
 * Growth rate needs history and there is no history without keeping some. A
 * sample is four numbers, so a decade of them is smaller than one lead.
 */
export function sample() {
  const today = one("SELECT date('now') d").d;
  if (one('SELECT day FROM db_size_sample WHERE day = ?', [today])) return null;

  const t = totalBytes();
  const leads = one('SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL').n;
  run('INSERT INTO db_size_sample (day, total_bytes, reclaimable_bytes, lead_count) VALUES (?,?,?,?)',
    [today, t.total, t.reclaimable, leads]);
  return { day: today, ...t, leads };
}

export const history = (days = 90) => all(
  "SELECT * FROM db_size_sample WHERE day >= date('now', ?) ORDER BY day",
  [`-${Number(days)} days`],
);

/**
 * Bytes per day, and what that implies.
 *
 * Reported as null rather than zero when there is not enough history: a growth
 * rate of "0 MB/day" on a database sampled once is a lie, and a projection
 * built on it is a worse one.
 */
export function growth() {
  const rows = history(90);
  if (rows.length < 2) {
    return { per_day: null, samples: rows.length, note: 'Not enough history yet — one sample a day is taken at start-up.' };
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const days = Math.max(1, (new Date(last.day) - new Date(first.day)) / 86400000);
  const perDay = (last.total_bytes - first.total_bytes) / days;

  return {
    per_day: Math.round(perDay),
    samples: rows.length,
    over_days: Math.round(days),
    per_lead: last.lead_count > 0 ? Math.round(last.total_bytes / last.lead_count) : null,
  };
}
