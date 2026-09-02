/**
 * Lead lists — the features the market has and this did not.
 *
 * The LeadSquared audit is unusually blunt about this area: 4,810 lists against
 * 495,118 leads, "the single clearest governance failure in the tenant", driven
 * by a daily habit of exporting a CSV, editing it in Excel, and re-importing it
 * as a static list that is never deleted. `views-tasks-lists.md` draws two
 * conclusions, and both are testable:
 *
 *   1. Static lists are snapshots that rot. Saved queries should be the default
 *      and snapshots an explicit, expiring, audited artefact.
 *   2. The CSV round-trip is the real signal — people leave the product because
 *      it cannot express what they mean.
 *
 * So these tests are mostly about (1) being enforced rather than advertised, and
 * (2) being unnecessary rather than merely possible.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { all, one, run } from '../src/db.js';
import {
  isSnapshot, validateGovernance, defaultExpiry, archiveExpired, DEFAULT_SNAPSHOT_DAYS,
  DEFAULT_KIND, SNAPSHOT_KINDS,
} from '../src/engine/leadlists.js';
import { conditionSchema, NO_VALUE_OPERATORS, LIST_OPERATORS } from '../src/engine/conditions.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nLead list features');

const routes = readFileSync(new URL('../src/routes/lists.js', import.meta.url), 'utf8');
const builder = readFileSync(new URL('../../client/src/components/ConditionBuilder.jsx', import.meta.url), 'utf8');
const listsUi = readFileSync(new URL('../../client/src/crm/LeadLists.jsx', import.meta.url), 'utf8');

/* ------------------------------------------------- governance (audit #1) */

test('a snapshot must say why it is frozen and when it lapses', () => {
  /* The two questions nobody could answer about the 4,810. Asking them at the
     point of creation is the only thing that stops the pile forming. */
  assert(validateGovernance({ kind: 'static' }), 'a snapshot with no reason was accepted');
  assert(/why this is a snapshot/i.test(validateGovernance({ kind: 'static' }).error));

  assert(
    validateGovernance({ kind: 'static', snapshot_reason: 'audit evidence' }),
    'a snapshot with no expiry was accepted',
  );
  assert.equal(
    validateGovernance({ kind: 'static', snapshot_reason: 'audit evidence', expires_at: '2099-01-01' }),
    null,
  );
});

test('an expiry already in the past is refused', () => {
  const bad = validateGovernance({ kind: 'static', snapshot_reason: 'x', expires_at: '2000-01-01' });
  assert(bad && /past/i.test(bad.error), 'a snapshot could be born expired');
});

test('a live list needs a filter, because that is what makes it live', () => {
  assert(validateGovernance({ kind: 'refreshable' }), 'a live list with no filter was accepted');
  assert.equal(validateGovernance({ kind: 'refreshable', criteria: { op: 'AND', children: [] } }), null);
});

test('only static is a snapshot; the rest cannot rot', () => {
  assert(isSnapshot('static'));
  assert(!isSnapshot('refreshable'));
  assert(!isSnapshot('dynamic'));
});

test('the default expiry is a real date in the future', () => {
  const d = defaultExpiry();
  assert(/^\d{4}-\d{2}-\d{2}$/.test(d), `"${d}" is not a date`);
  const days = Math.round((new Date(d) - new Date()) / 86400000);
  assert(Math.abs(days - DEFAULT_SNAPSHOT_DAYS) <= 1, `default expiry is ${days} days, expected ${DEFAULT_SNAPSHOT_DAYS}`);
});

test('a lapsed snapshot is archived, never deleted', () => {
  /* Somebody may need to prove who was in a list when a campaign went out, and
     that is exactly the evidence a delete destroys. */
  const id = Number(run(
    `INSERT INTO lead_lists (name, kind, owner_id, created_by, shared_with, snapshot_reason, expires_at, updated_at)
     VALUES ('probe lapsed', 'static', 1, 1, '[]', 'probe', date('now','-2 days'), datetime('now'))`,
  ).lastInsertRowid);

  try {
    assert(archiveExpired() >= 1, 'nothing was archived');
    const row = one('SELECT archived_at FROM lead_lists WHERE id = ?', [id]);
    assert(row, 'the list was deleted rather than archived');
    assert(row.archived_at, 'the list was not archived');
  } finally {
    run('DELETE FROM lead_lists WHERE id = ?', [id]);
  }
});

test('a snapshot inside its expiry is left alone', () => {
  const id = Number(run(
    `INSERT INTO lead_lists (name, kind, owner_id, created_by, shared_with, snapshot_reason, expires_at, updated_at)
     VALUES ('probe live', 'static', 1, 1, '[]', 'probe', date('now','+30 days'), datetime('now'))`,
  ).lastInsertRowid);
  try {
    archiveExpired();
    assert(!one('SELECT archived_at FROM lead_lists WHERE id = ?', [id]).archived_at,
      'a snapshot well inside its expiry was archived');
  } finally {
    run('DELETE FROM lead_lists WHERE id = ?', [id]);
  }
});

test('the interface defaults to a live list, not a snapshot', () => {
  /* The audit's first recommendation. This used to check the form for a
     hardcoded 'refreshable'; the form now preselects whatever the API would
     have chosen for a request that states no kind, so the guarantee is checked
     where the decision actually lives — and checked as "not a snapshot" rather
     than as one particular spelling of live. */
  assert(!SNAPSHOT_KINDS.has(DEFAULT_KIND), 'the default list kind is a snapshot');
  assert(/kind = DEFAULT_KIND/.test(routes) || /kind \?\? DEFAULT_KIND/.test(routes),
    'the create route no longer applies the shared default');
  assert(/meta\??\.default_kind/.test(listsUi),
    'the new-list form no longer takes its default from the server');
  assert(!/useState\('static'\)/.test(listsUi), 'the new-list form defaults to a snapshot again');
});

/* --------------------------------------- expressing the question (audit #2) */

test('the filter catalogue reaches the interface', () => {
  /* The engine has taken nested AND/OR over every one of these since it was
     written. Nothing exposed the catalogue, so the only filter anybody could
     express was a single stage — which is why the real work happened in Excel. */
  const schema = conditionSchema();
  assert(schema.fields.length >= 25, `only ${schema.fields.length} fields offered`);
  assert(/schema: enrichedSchema\(\)/.test(routes), 'the schema is no longer served to the builder');
  for (const f of schema.fields) {
    assert(f.operators?.length, `"${f.label}" has no operators, so it cannot be filtered on`);
  }
});

test('an operator says whether it takes a value, and how many', () => {
  /* A text box beside "is empty" invites somebody to type into a field that is
     ignored; one box beside "is any of" makes a list operator behave like an
     equality one. Declared once so the builder and the compiler agree. */
  const ops = conditionSchema().operators;
  const byCode = new Map(ops.map((o) => [o.code, o]));
  for (const code of NO_VALUE_OPERATORS) {
    if (byCode.has(code)) assert.equal(byCode.get(code).arity, 0, `${code} should take no value`);
  }
  for (const code of LIST_OPERATORS) {
    if (byCode.has(code)) assert.equal(byCode.get(code).list, true, `${code} should take a list`);
  }
  assert.equal(byCode.get('eq').arity, 1);
  assert.equal(byCode.get('eq').list, false);
});

test('enum filters offer the values a lead actually has', () => {
  /* Joined from the metadata layer, so the builder offers what the pickers on a
     lead offer. A filter written against a value nobody can select matches
     nothing, and looks like a broken filter rather than an empty one. */
  assert(/enrichedSchema/.test(routes), 'enum values are no longer joined');
  const stage = one("SELECT id FROM field_def WHERE entity = 'lead' AND api_name = 'stage'");
  assert(stage, 'lead.stage has no field definition to read values from');
  const values = all('SELECT value FROM picklist_value WHERE field_id = ? AND active = 1', [stage.id]);
  assert(values.length >= 4, `only ${values.length} stage values are configured`);
});

test('the builder nests, and stops nesting before it becomes a query', () => {
  assert(/depth < 2/.test(builder), 'the builder no longer caps nesting depth');
  assert(/newGroup/.test(builder), 'groups cannot be added');
  assert(/'AND'|'OR'/.test(builder), 'the group operator is gone');
});

/* ----------------------------------------------- the CSV round trip closed */

test('a list can be exported, and the export is recorded', () => {
  /* People were exporting anyway, outside the product, which is why the trail
     ended at the list. For a SEBI-regulated broker the record is the point. */
  assert(/router\.post\('\/:id\/export'/.test(routes), 'lists cannot be exported');
  const handler = routes.slice(routes.indexOf("router.post('/:id/export'"), routes.indexOf("router.post('/:id/import'"));
  assert(/audit\(req\.user\.id, 'list\.export'/.test(handler), 'an export is not audited');
  assert(/rows: rows\.length/.test(handler) && /columns: chosen/.test(handler),
    'the audit row does not say what left');
});

test('an export masks identifiers unless the exporter may unmask', () => {
  const handler = routes.slice(routes.indexOf("router.post('/:id/export'"), routes.indexOf("router.post('/:id/import'"));
  assert(/pii\.unmask/.test(handler), 'unmasking an export needs no capability');
  assert(/unmasked/.test(handler), 'the export does not record whether it was in the clear');
  // Masked is the default: `unmask` has to be asked for.
  assert(/Boolean\(req\.body\?\.unmask\)/.test(handler), 'exports are unmasked by default');
});

test('a list can be imported into, and says what did not match', () => {
  assert(/router\.post\('\/:id\/import'/.test(routes), 'nothing can be imported');
  const handler = routes.slice(routes.indexOf("router.post('/:id/import'"), routes.indexOf('/* ------------------------------------------------------- more bulk actions */'));
  assert(/missed/.test(handler), 'the import does not report what failed to match');
  // The values, not just a count: "43 did not match" is not actionable.
  assert(/missed: missed\.slice/.test(handler), 'only a count of misses is returned');
  assert(/client_code.*mobile.*pan|match_on/.test(handler), 'there is no choice of what to match on');
});

test('rows cannot be imported into a live list', () => {
  // Adding members by hand to a saved query would make the query a lie.
  const handler = routes.slice(routes.indexOf("router.post('/:id/import'"));
  assert(/isSnapshot\(list\.kind\)/.test(handler.slice(0, 900)), 'a live list accepts hand-added rows');
});

/* --------------------------------------------------------- bulk actions */

test('every bulk action a list offers exists', () => {
  for (const action of ['reassign', 'stage', 'task', 'message', 'dialler', 'membership', 'field', 'delete']) {
    assert(routes.includes(`'/:id/bulk/${action}'`), `bulk ${action} is missing`);
  }
});

test('the dialler push goes through the same path a single lead does', () => {
  /* Two queues would give the two paths different behaviour on the day one of
     them mattered. */
  assert(/pushToAutodialler/.test(routes), 'the list push no longer uses the shared dialler path');
  assert(!/dialler_queue/.test(routes), 'a second dialler queue has reappeared');
});

test('a bulk edit cannot touch an identifier', () => {
  /* `mobile` here would be a way to destroy the thing every other record is
     matched on, and renaming 1,200 people at once is not a feature. */
  const set = routes.slice(routes.indexOf('const BULK_EDITABLE'), routes.indexOf('const BULK_EDITABLE') + 300);
  for (const forbidden of ['mobile', 'email', 'pan', 'name', 'client_code']) {
    assert(!new RegExp(`'${forbidden}'`).test(set), `${forbidden} can be set in bulk`);
  }
  assert(/'stage'/.test(set), 'stage cannot be set in bulk, which is the common case');
});

test('a bulk delete is soft, gated, and has to match the count shown', () => {
  /* Built against my recommendation, so the safeguards are the whole of the
     argument for it. A mis-scoped list is the likeliest input — the audit shows
     lists are frequently wrong — so the confirmation names the number rather
     than asking "are you sure". */
  const handler = routes.slice(routes.indexOf("router.post('/:id/bulk/delete'"));
  assert(/requirePermission\('lead\.delete'\)/.test(handler.slice(0, 200)), 'bulk delete needs no capability');
  assert(/confirm_count/.test(handler), 'bulk delete does not check the count the caller saw');
  assert(/deleted_at = datetime/.test(handler), 'bulk delete is not a soft delete');
  assert(!/DELETE FROM leads/.test(handler), 'bulk delete removes rows outright');
  assert(/recoverable: true/.test(handler), 'the response does not say it can be undone');
});

test('a bulk action writes one audit row per record', () => {
  // "Was this client contacted" has to stay answerable after the fact.
  const field = routes.slice(routes.indexOf("router.post('/:id/bulk/field'"), routes.indexOf("router.post('/:id/bulk/delete'"));
  assert(/audit\(req\.user\.id, 'lead\.bulk\.field', 'lead', id/.test(field),
    'a bulk edit is audited once for the action rather than once per lead');
  assert(/from: before\.v/.test(field), 'the audit does not record what the value used to be');
});

/* ------------------------------------------------------------- columns */

test('a list chooses its own columns, and identifiers are marked', () => {
  assert(/COLUMN_CHOICES/.test(routes), 'columns cannot be chosen');
  assert(/pii: true/.test(routes), 'no column is marked as an identifier');
  const block = routes.slice(routes.indexOf('export const COLUMN_CHOICES'), routes.indexOf('const DEFAULT_COLUMNS'));
  for (const key of ['name', 'stage', 'owner_name']) {
    assert(block.includes(`'${key}'`), `${key} is not offered as a column`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
