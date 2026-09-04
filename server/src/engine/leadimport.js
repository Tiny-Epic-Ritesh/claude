/**
 * Lead import: mapping, modes, and a record of what happened (P3-33, P3-34).
 *
 * The old importer took an array of objects already keyed by CRM field, which
 * quietly assumed the file's headers were our field names. Real files come from
 * the system being replaced, and their headers say "Mobile No", "Lead Owner",
 * "City/Town". So the mapping is now explicit, sent with the rows, and applied
 * here rather than guessed at either end.
 *
 * WHY THE SERVER MAPS
 * -------------------
 * The client could map before sending and post objects, and it would be less
 * code. But then the mapping exists only in the browser that made it: the run
 * record could not say how the file was read, a failed import could not be
 * explained afterwards, and nothing would stop a caller writing to a field the
 * importer was never meant to touch. Mapping here makes the allow-list real and
 * the audit honest.
 *
 * WHAT "UPDATE" MEANS
 * -------------------
 * Ritesh asked for the choice between creating and updating. Matching is on
 * mobile, because that is already the duplicate key this product uses and a
 * second answer to "is this the same person" is how two systems disagree about
 * a client. A row with no mobile can therefore never match, and in update mode
 * it fails with that reason rather than silently becoming a new lead.
 */

import { all, one, run, audit } from '../db.js';

/** Rows one import may carry. The same cap the bulk actions use. */
export const IMPORT_CAP = 5000;

/** Failures recorded per run before we stop writing them down. */
const FAILURE_CAP = 1000;

/**
 * The fields a file may be mapped onto.
 *
 * `pan` is deliberately absent. It is encrypted at rest with a blind index for
 * lookup, so importing one means writing two columns in step, and getting that
 * subtly wrong produces records that cannot be found by the value they hold.
 * It belongs in its own piece of work rather than smuggled into this one.
 */
export const IMPORT_FIELDS = [
  { key: 'name', label: 'Name', required: true, example: 'Rohan Kulkarni', note: 'The only column an import cannot do without.' },
  { key: 'mobile', label: 'Mobile', example: '9812345670', note: '10 digits, starting 6 to 9. Also how a row is matched to an existing lead.' },
  { key: 'email', label: 'Email', example: 'rohan.k@example.in' },
  { key: 'city', label: 'City', example: 'Pune' },
  { key: 'state', label: 'State', example: 'Maharashtra' },
  { key: 'source', label: 'Source', example: 'Website', note: 'Defaults to "Import" when blank.' },
  { key: 'language', label: 'Language', example: 'Marathi' },
  { key: 'risk_profile', label: 'Risk profile', example: 'Moderate' },
  { key: 'client_code', label: 'Client code', example: 'BNZ00123' },
];

const FIELD = new Map(IMPORT_FIELDS.map((f) => [f.key, f]));

export const MODES = [
  { key: 'create', label: 'Create new leads only', note: 'A row matching an existing lead is skipped.' },
  { key: 'update', label: 'Update existing leads only', note: 'A row matching nothing is skipped.' },
  { key: 'upsert', label: 'Create new and update existing', note: 'Every row lands somewhere.' },
];

/* ------------------------------------------------------------- mapping */

/**
 * Turn a header and a row of cells into a record keyed by CRM field.
 *
 * Anything the mapping does not name is dropped rather than guessed at. A file
 * from the old system carries thirty columns and we want nine of them; silently
 * matching the rest by similar-looking names is how a "Lead Owner" column ends
 * up in `source`.
 */
export function applyMapping(header, cells, mapping) {
  const out = {};
  header.forEach((column, i) => {
    const field = mapping?.[column];
    if (!field || !FIELD.has(field)) return;
    const value = cells[i];
    if (value === undefined || value === null) return;
    const trimmed = String(value).trim();
    if (trimmed !== '') out[field] = trimmed;
  });
  return out;
}

/**
 * A mapping the file and the importer both agree with.
 *
 * Returns what is wrong rather than throwing, because the step this feeds is a
 * screen where somebody fixes it — and being told about one problem at a time
 * is how a person gives up and edits the spreadsheet instead.
 */
export function checkMapping(header, mapping) {
  const problems = [];
  const used = new Map();

  for (const [column, field] of Object.entries(mapping ?? {})) {
    if (!header.includes(column)) {
      problems.push(`The file has no column called "${column}".`);
      continue;
    }
    if (!FIELD.has(field)) {
      problems.push(`"${field}" is not a field an import can write.`);
      continue;
    }
    /* Two columns onto one field is a mistake with a silent outcome: one of
       them wins, and which one depends on column order. */
    if (used.has(field)) {
      problems.push(`"${used.get(field)}" and "${column}" are both mapped to ${FIELD.get(field).label}.`);
      continue;
    }
    used.set(field, column);
  }

  if (!used.has('name')) problems.push('Name has to be mapped — a lead without one cannot be saved.');
  return { problems, mapped: used, unmapped: header.filter((h) => !mapping?.[h]) };
}

/* ------------------------------------------------------------ the run */

const MOBILE = /^[6-9]\d{9}$/;

/**
 * Read every row and say what would happen, or make it happen.
 *
 * `commit` false is the preview the wizard shows before anybody presses the
 * button. It walks exactly the same path, so the preview cannot be optimistic
 * about a row the real run would refuse.
 */
export function runImport({
  header, rows, mapping, mode = 'create', salesOrg, ownerId, listId = null,
  commit = false, generateCards,
}) {
  const report = {
    total: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failures: [],
    truncated: false,
    sales_org: salesOrg,
    mode,
  };

  const fail = (rowNo, reason, record) => {
    if (report.failures.length < FAILURE_CAP) {
      report.failures.push({ row: rowNo, reason, detail: JSON.stringify(record ?? {}).slice(0, 500) });
    } else {
      report.truncated = true;
    }
  };

  const touched = [];

  rows.forEach((cells, i) => {
    const rowNo = i + 1;
    const record = applyMapping(header, cells, mapping);

    if (!record.name) return fail(rowNo, 'Missing name', record);
    if (record.mobile && !MOBILE.test(record.mobile)) {
      return fail(rowNo, `"${record.mobile}" is not a valid Indian mobile number`, record);
    }

    /* Matched within the book, never across it. A Bigul file carrying a mobile
       that exists in Bonanza must not update that lead — it is a different
       person as far as this business is concerned. */
    const existing = record.mobile
      ? one('SELECT id FROM leads WHERE mobile = ? AND sales_org = ? AND deleted_at IS NULL',
        [record.mobile, salesOrg])
      : null;

    if (existing && mode === 'create') {
      report.skipped += 1;
      return undefined;
    }
    if (!existing && mode === 'update') {
      report.skipped += 1;
      return undefined;
    }
    if (!existing && !record.mobile && mode !== 'create') {
      /* No mobile means nothing to match on. In create mode that is fine; in
         the others it is a row that can never do what was asked of it. */
      return fail(rowNo, 'No mobile number, so this row cannot be matched to an existing lead', record);
    }

    if (existing) {
      if (commit) {
        const sets = Object.keys(record).filter((k) => k !== 'mobile');
        if (sets.length) {
          run(
            `UPDATE leads SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
            [...sets.map((k) => record[k]), existing.id],
          );
        }
        touched.push(existing.id);
      }
      report.updated += 1;
      return undefined;
    }

    if (commit) {
      const cols = ['sales_org', 'owner_id', ...Object.keys(record)];
      const vals = [salesOrg, ownerId, ...Object.keys(record).map((k) => record[k])];
      if (!record.source) { cols.push('source'); vals.push('Import'); }

      const result = run(
        `INSERT INTO leads (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        vals,
      );
      const id = Number(result.lastInsertRowid);
      generateCards?.(id);
      touched.push(id);
    }
    report.created += 1;
    return undefined;
  });

  report.failed = report.failures.length + (report.truncated ? 1 : 0);

  /* The list, once, at the end. Adding per row would mean a half-filled list
     when a run is interrupted, which is worse than none. */
  if (commit && listId && touched.length) {
    for (const id of touched) {
      run('INSERT OR IGNORE INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [listId, id]);
    }
  }

  report.touched = touched.length;
  return report;
}

/* ---------------------------------------------------------- the record */

/** Keep a run, and its failures, so the summary can be read again (P3-34). */
export function recordRun({ userId, salesOrg, filename, mode, mapping, listId, report }) {
  const result = run(
    `INSERT INTO import_run
       (user_id, sales_org, filename, mode, mapping, list_id, total, created, updated, skipped, failed, truncated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      userId ?? null, salesOrg, filename ?? null, mode, JSON.stringify(mapping ?? {}), listId ?? null,
      report.total, report.created, report.updated, report.skipped,
      report.failures.length, report.truncated ? 1 : 0,
    ],
  );
  const runId = Number(result.lastInsertRowid);

  for (const f of report.failures) {
    run('INSERT OR IGNORE INTO import_failure (run_id, row_no, reason, detail) VALUES (?,?,?,?)',
      [runId, f.row, f.reason, f.detail ?? null]);
  }

  audit(userId, 'leads_imported', 'lead', null, {
    run: runId, mode, created: report.created, updated: report.updated, failed: report.failures.length,
  });

  return runId;
}

/** One run and everything it says about itself. */
export function readRun(id, orgs) {
  const header = one(
    `SELECT r.*, u.name AS user_name, l.name AS list_name
       FROM import_run r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN lead_lists l ON l.id = r.list_id
      WHERE r.id = ?`,
    [id],
  );
  if (!header) return null;
  /* Scoped like everything else. An import run names a business and the rows it
     failed on, which is client data by another route. */
  if (!orgs.includes(header.sales_org)) return null;

  return {
    ...header,
    mapping: JSON.parse(header.mapping || '{}'),
    failures: all('SELECT row_no, reason, detail FROM import_failure WHERE run_id = ? ORDER BY row_no', [id]),
  };
}

/** Recent runs, for the screen that lists them. */
export const listRuns = (orgs, limit = 25) => all(
  `SELECT r.id, r.filename, r.mode, r.total, r.created, r.updated, r.skipped, r.failed, r.created_at,
          u.name AS user_name
     FROM import_run r
     LEFT JOIN users u ON u.id = r.user_id
    WHERE r.sales_org IN (${orgs.map(() => '?').join(',') || "''"})
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ?`,
  [...orgs, limit],
);
