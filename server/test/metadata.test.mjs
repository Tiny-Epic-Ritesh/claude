/**
 * The metadata layer.
 *
 * Four things are worth proving, and they are the four the LeadSquared audit
 * says the legacy tenant gets wrong:
 *
 *   1. Label and API name are genuinely separate, and renaming one never moves
 *      the other. `mx_Subscription_End_dtae` exists because they were conflated.
 *   2. Custom fields validate on every path, including the ones with no form —
 *      most writes arrive from automation and integrations.
 *   3. Field history is queryable, so stage duration is a question you can ask
 *      rather than six automations you have to maintain.
 *   4. Field-level security separates the fact of an interaction from its
 *      content, which row-level security cannot express.
 */

import { strict as assert } from 'node:assert';
import { all, one, run, db } from '../src/db.js';
import {
  seedMetadata, entities, entityDef, fieldsOf, fieldDef, typeOf, FIELD_TYPES,
  picklistValues, customValues, setCustomValues, recordChange, historyFor,
  stageDurations, canReadField, applyFieldSecurity, storeColumn, auditConfig,
} from '../src/engine/metadata.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

seedMetadata();

/* ------------------------------------------------------ the registry */

console.log('\nRegistry');

test('every core entity is registered', () => {
  const names = entities().map((e) => e.api_name);
  for (const expected of ['lead', 'interaction', 'product_interest', 'case', 'partner', 'task']) {
    assert(names.includes(expected), `${expected} missing from the registry`);
  }
});

test('registered entities point at real tables', () => {
  for (const e of entities()) {
    if (!e.table_name) continue;
    const exists = one(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [e.table_name],
    );
    assert(exists, `${e.api_name} claims table "${e.table_name}", which does not exist`);
  }
});

test('every registered core field is a real column', () => {
  // The hybrid only works if the column side is honest about what exists. A
  // field marked storage='column' that has no column would fail at read time,
  // in production, on a screen.
  for (const e of entities()) {
    if (!e.table_name) continue;
    const columns = new Set(all('SELECT name FROM pragma_table_info(?)', [e.table_name]).map((c) => c.name));
    for (const f of fieldsOf(e.api_name).filter((x) => x.storage === 'column')) {
      assert(columns.has(f.api_name),
        `${e.api_name}.${f.api_name} is registered as a column but ${e.table_name} has no such column`);
    }
  }
});

test('every field declares a type from the palette', () => {
  for (const e of entities()) {
    for (const f of fieldsOf(e.api_name)) {
      assert(typeOf(f.type), `${e.api_name}.${f.api_name} has unknown type "${f.type}"`);
    }
  }
});

test('seeding twice changes nothing', () => {
  const before = all('SELECT entity, api_name, type FROM field_def ORDER BY entity, api_name');
  seedMetadata();
  const after = all('SELECT entity, api_name, type FROM field_def ORDER BY entity, api_name');
  assert.deepEqual(after, before);
});

/* -------------------------------------------------- label ≠ API name */

console.log('\nLabel is not API name');

test('renaming a label leaves the API name untouched', () => {
  const before = fieldDef('lead', 'stage');
  run("UPDATE field_def SET label = 'Pipeline Position' WHERE entity = 'lead' AND api_name = 'stage'");

  const after = fieldDef('lead', 'stage');
  assert.equal(after.api_name, 'stage', 'the API name moved with the label');
  assert.equal(after.label, 'Pipeline Position');

  run('UPDATE field_def SET label = ? WHERE id = ?', [before.label, before.id]);
});

test('re-seeding preserves an administrator’s renamed label', () => {
  // The platform owns the type and the storage. The label belongs to the
  // business, and a deploy must never quietly undo their rename.
  run("UPDATE field_def SET label = 'Prospect Grade' WHERE entity = 'lead' AND api_name = 'risk_profile'");
  seedMetadata();

  assert.equal(fieldDef('lead', 'risk_profile').label, 'Prospect Grade');
  run("UPDATE field_def SET label = 'Risk Profile' WHERE entity = 'lead' AND api_name = 'risk_profile'");
});

test('API names are unique within an entity', () => {
  const dupes = all(
    'SELECT entity, api_name, COUNT(*) n FROM field_def GROUP BY entity, api_name HAVING n > 1',
  );
  assert.equal(dupes.length, 0, `duplicate API names: ${JSON.stringify(dupes)}`);
});

/* ------------------------------------------------------ custom fields */

console.log('\nCustom fields');

const leadId = one('SELECT id FROM leads ORDER BY id LIMIT 1').id;
let customFieldId;
let cascadeParentId;
let cascadeChildId;

test('a custom field can be added without a migration', () => {
  run(
    `INSERT INTO field_def (entity, api_name, label, type, storage, required, purpose, is_custom)
     VALUES ('lead', 'referral_code', 'Referral Code', 'text', 'value', 0, 'Track the referral scheme', 1)`,
  );
  customFieldId = one("SELECT id FROM field_def WHERE entity='lead' AND api_name='referral_code'").id;

  const { ok, errors } = setCustomValues('lead', leadId, { referral_code: 'BIG-2026-A' });
  assert(ok, JSON.stringify(errors));
  assert.equal(customValues('lead', leadId).referral_code, 'BIG-2026-A');
});

test('custom values land in the column their type declares', () => {
  run(
    `INSERT INTO field_def (entity, api_name, label, type, storage, purpose, is_custom)
     VALUES ('lead', 'expected_aum', 'Expected AUM', 'currency', 'value', 'Sizing', 1)`,
  );
  setCustomValues('lead', leadId, { expected_aum: 2_500_000 });

  const row = one(
    `SELECT v.* FROM field_value v JOIN field_def f ON f.id = v.field_id
     WHERE f.api_name = 'expected_aum' AND v.record_id = ?`, [leadId],
  );
  assert.equal(row.num_value, 2_500_000, 'currency did not land in num_value');
  assert.equal(row.text_value, null, 'currency also wrote to text_value');
  assert.equal(storeColumn('currency'), 'num_value');
});

test('a required custom field is enforced', () => {
  run("UPDATE field_def SET required = 1 WHERE id = ?", [customFieldId]);
  const { ok, errors } = setCustomValues('lead', leadId, { referral_code: '' });

  assert.equal(ok, false);
  assert.match(errors.referral_code, /required/);
  run("UPDATE field_def SET required = 0 WHERE id = ?", [customFieldId]);
});

test('cascading picklists are enforced at the API, not the form', () => {
  // This is non-negotiable 11. The legacy tenant validates the cascade in the
  // browser only, so every import and every integration write bypasses it.
  run(
    `INSERT INTO field_def (entity, api_name, label, type, storage, purpose, is_custom)
     VALUES ('lead', 'segment', 'Segment', 'picklist', 'value', 'Product segment', 1)`,
  );
  cascadeParentId = one("SELECT id FROM field_def WHERE api_name = 'segment'").id;

  run(
    `INSERT INTO field_def (entity, api_name, label, type, storage, controlling_field, purpose, is_custom)
     VALUES ('lead', 'sub_segment', 'Sub-segment', 'picklist', 'value', ?, 'Narrower segment', 1)`,
    [cascadeParentId],
  );
  cascadeChildId = one("SELECT id FROM field_def WHERE api_name = 'sub_segment'").id;

  for (const [v, l] of [['EQUITY', 'Equity'], ['DERIVATIVES', 'Derivatives']]) {
    run('INSERT INTO picklist_value (field_id, value, label) VALUES (?,?,?)', [cascadeParentId, v, l]);
  }
  const children = [
    ['DELIVERY', 'Delivery', 'EQUITY'], ['INTRADAY', 'Intraday', 'EQUITY'],
    ['FUTURES', 'Futures', 'DERIVATIVES'], ['OPTIONS', 'Options', 'DERIVATIVES'],
  ];
  for (const [v, l, parent] of children) {
    run(
      'INSERT INTO picklist_value (field_id, value, label, controlling_value) VALUES (?,?,?,?)',
      [cascadeChildId, v, l, parent],
    );
  }

  // Valid pairing.
  const good = setCustomValues('lead', leadId, { segment: 'EQUITY', sub_segment: 'INTRADAY' });
  assert(good.ok, JSON.stringify(good.errors));

  // Invalid pairing: Options is a derivatives sub-segment, not an equity one.
  const bad = setCustomValues('lead', leadId, { segment: 'EQUITY', sub_segment: 'OPTIONS' });
  assert.equal(bad.ok, false, 'the cascade accepted a child that does not belong to its parent');
  assert.match(bad.errors.sub_segment, /not a permitted value/);
});

test('picklistValues narrows by the controlling value', () => {
  assert.deepEqual(picklistValues(cascadeChildId, 'EQUITY').map((v) => v.value), ['DELIVERY', 'INTRADAY']);
  assert.deepEqual(picklistValues(cascadeChildId, 'DERIVATIVES').map((v) => v.value), ['FUTURES', 'OPTIONS']);
  assert.equal(picklistValues(cascadeChildId).length, 4, 'unnarrowed should return every value');
});

test('an unknown picklist value is refused', () => {
  const { ok, errors } = setCustomValues('lead', leadId, { segment: 'COMMODITY' });
  assert.equal(ok, false);
  assert.match(errors.segment, /not a permitted value/);
});

test('derived fields are never written', () => {
  run(
    `INSERT INTO field_def (entity, api_name, label, type, storage, formula, purpose, is_custom)
     VALUES ('lead', 'days_open', 'Days Open', 'formula', 'derived', 'TODAY() - created_at', 'Ageing', 1)`,
  );
  const { written } = setCustomValues('lead', leadId, { days_open: 99 });

  assert(!written.includes('days_open'), 'a formula field accepted a write');
  const stored = one(
    `SELECT COUNT(*) n FROM field_value v JOIN field_def f ON f.id = v.field_id
     WHERE f.api_name = 'days_open'`,
  ).n;
  assert.equal(stored, 0);
});

test('writes to unknown fields are ignored, not crashed', () => {
  const { ok, written } = setCustomValues('lead', leadId, { not_a_field: 'x', referral_code: 'BIG-2026-B' });
  assert(ok);
  assert.deepEqual(written, ['referral_code']);
});

/* ----------------------------------------------------------- history */

console.log('\nField history');

test('a tracked field records its change', () => {
  const wrote = recordChange('lead', leadId, 'stage', 'New', 'Contacted', { actorId: 1, source: 'ui' });
  assert(wrote);

  const [latest] = historyFor('lead', leadId, 1);
  assert.equal(latest.field, 'stage');
  assert.equal(latest.old_value, 'New');
  assert.equal(latest.new_value, 'Contacted');
});

test('an untracked field records nothing', () => {
  const before = historyFor('lead', leadId).length;
  recordChange('lead', leadId, 'city', 'Pune', 'Mumbai', { actorId: 1 });
  assert.equal(historyFor('lead', leadId).length, before);
});

test('a no-op change records nothing', () => {
  const before = historyFor('lead', leadId).length;
  recordChange('lead', leadId, 'stage', 'Contacted', 'Contacted', { actorId: 1 });
  assert.equal(historyFor('lead', leadId).length, before, 'a change to the same value was logged');
});

test('stage duration is derived, not stamped', () => {
  // Non-negotiable 4, and the reason six legacy automations exist. Here it is
  // one query over history the platform already keeps.
  const probe = 9_100_001;
  const days = (n) => `2026-0${n < 10 ? n : 9}-01 09:00:00`;

  run(`INSERT INTO field_history (entity, record_id, field, old_value, new_value, changed_at)
       VALUES ('lead', ?, 'stage', NULL, 'New', '2026-01-01 09:00:00')`, [probe]);
  run(`INSERT INTO field_history (entity, record_id, field, old_value, new_value, changed_at)
       VALUES ('lead', ?, 'stage', 'New', 'Contacted', '2026-01-11 09:00:00')`, [probe]);
  run(`INSERT INTO field_history (entity, record_id, field, old_value, new_value, changed_at)
       VALUES ('lead', ?, 'stage', 'Contacted', 'Qualified', '2026-01-26 09:00:00')`, [probe]);

  const spans = stageDurations('lead', probe);
  assert.equal(spans.length, 3);
  assert.equal(spans[0].stage, 'New');
  assert.equal(spans[0].days, 10, 'New should have lasted ten days');
  assert.equal(spans[1].stage, 'Contacted');
  assert.equal(spans[1].days, 15);
  assert.equal(spans[2].days, null, 'the current stage has not been exited');
  assert.equal(spans[2].exited_at, null);
  void days;
});

test('history survives a custom field being deactivated', () => {
  // Deactivating a field must not erase what it once held — a report over last
  // quarter still needs to be answerable.
  run('UPDATE field_def SET history_tracked = 1 WHERE id = ?', [customFieldId]);
  setCustomValues('lead', leadId, { referral_code: 'BIG-2026-C' }, { actorId: 1 });

  const before = historyFor('lead', leadId).filter((h) => h.field === 'referral_code').length;
  assert(before > 0, 'the tracked custom field wrote no history');

  run('UPDATE field_def SET active = 0 WHERE id = ?', [customFieldId]);
  const after = historyFor('lead', leadId).filter((h) => h.field === 'referral_code').length;
  assert.equal(after, before, 'deactivating the field destroyed its history');

  run('UPDATE field_def SET active = 1 WHERE id = ?', [customFieldId]);
});

/* --------------------------------------------- field-level security */

console.log('\nField-level security — the interaction split');

const rm = one("SELECT id, manager_id FROM users WHERE role = 'sales_rm' AND active = 1 LIMIT 1");
const other = one("SELECT id FROM users WHERE role = 'sales_rm' AND active = 1 AND id != ? LIMIT 1", [rm.id])
  ?? one('SELECT id FROM users WHERE id != ? LIMIT 1', [rm.id]);

test('the notes body and recording are restricted; the outcome is not', () => {
  const restricted = fieldsOf('interaction').filter((f) => f.read_scope !== 'record').map((f) => f.api_name);
  assert.deepEqual(restricted.sort(), ['body', 'reason', 'recording_url']);

  for (const open of ['type', 'disposition', 'sub_disposition', 'created_at', 'duration_s']) {
    assert.equal(fieldDef('interaction', open).read_scope, 'record',
      `${open} must stay visible or coverage reporting goes dark`);
  }
});

test('an owner reads their own notes', () => {
  const body = fieldDef('interaction', 'body');
  assert.equal(canReadField({ id: rm.id }, body, rm.id, new Set()), true);
});

test('a peer does not', () => {
  const body = fieldDef('interaction', 'body');
  assert.equal(canReadField({ id: other.id }, body, rm.id, new Set()), false);
});

test('a manager does', () => {
  // Supervision is the whole reason the restriction is not simply "owner only".
  const manager = rm.manager_id;
  assert(manager, 'the fixture RM has no manager; the chain cannot be tested');
  const body = fieldDef('interaction', 'body');
  assert.equal(canReadField({ id: manager }, body, rm.id, new Set()), true);
});

test('a capability holder reads an encrypted field, nobody else does', () => {
  const pan = fieldDef('lead', 'pan');
  assert.equal(pan.read_scope, 'capability');
  assert.equal(canReadField({ id: other.id }, pan, rm.id, new Set(['pii.unmask'])), true);
  assert.equal(canReadField({ id: other.id }, pan, rm.id, new Set()), false);
  // Ownership does not grant it — that is what makes it a capability scope.
  assert.equal(canReadField({ id: rm.id }, pan, rm.id, new Set()), false);
});

test('redaction hides the value and says so', () => {
  const rows = [{ id: 1, user_id: other.id, disposition: 'Connected', body: 'discussed brokerage', duration_s: 240 }];
  const [seen] = applyFieldSecurity('interaction', rows, { id: rm.id });

  assert.equal(seen.body, null, 'the note leaked');
  assert.equal(seen.disposition, 'Connected', 'the outcome was hidden along with the note');
  assert.equal(seen.duration_s, 240);
  assert.deepEqual(seen._restricted, ['body'],
    'a withheld field must be distinguishable from an empty one');
});

test('an absent value is not reported as restricted', () => {
  // Silence and absence must not look the same in either direction: a call with
  // no recording should not claim one is being withheld.
  const rows = [{ id: 2, user_id: other.id, disposition: 'Busy', body: null, recording_url: null }];
  const [seen] = applyFieldSecurity('interaction', rows, { id: rm.id });
  assert.equal(seen._restricted, undefined);
});

test('field security holds over a mixed list', () => {
  const rows = [
    { id: 1, user_id: rm.id, body: 'mine' },
    { id: 2, user_id: other.id, body: 'theirs' },
    { id: 3, user_id: rm.id, body: 'mine too' },
  ];
  const seen = applyFieldSecurity('interaction', rows, { id: rm.id });

  assert.deepEqual(seen.map((r) => r.body), ['mine', null, 'mine too']);
});

test('an entity with no restricted fields is returned untouched', () => {
  const rows = [{ id: 1, title: 'Call back' }];
  assert.equal(applyFieldSecurity('task', rows, { id: rm.id })[0], rows[0]);
});

test('a management cycle terminates', () => {
  // Bad data must not hang a request. Two users pointing at each other is a
  // one-row mistake away in any admin screen.
  const a = run("INSERT INTO users (name, email, password, role, active) VALUES ('Cycle A','cyc-a@t.test','x','sales_rm',1)").lastInsertRowid;
  const b = run("INSERT INTO users (name, email, password, role, active) VALUES ('Cycle B','cyc-b@t.test','x','sales_rm',1)").lastInsertRowid;
  run('UPDATE users SET manager_id = ? WHERE id = ?', [b, a]);
  run('UPDATE users SET manager_id = ? WHERE id = ?', [a, b]);

  const body = fieldDef('interaction', 'body');
  const started = Date.now();
  canReadField({ id: 999_999 }, body, a, new Set());
  assert(Date.now() - started < 1000, 'the manager walk did not terminate promptly');

  run('DELETE FROM users WHERE id IN (?,?)', [a, b]);
});

/* ------------------------------------------------------ config audit */

console.log('\nConfiguration audit');

test('a config change is recorded with before and after', () => {
  auditConfig('field', 'lead.referral_code', 'updated', { label: 'Referral Code' }, { label: 'Referral Source' }, 1);
  const row = one("SELECT * FROM config_audit WHERE target = 'lead.referral_code' ORDER BY id DESC LIMIT 1");

  assert.equal(row.action, 'updated');
  assert.equal(JSON.parse(row.before_json).label, 'Referral Code');
  assert.equal(JSON.parse(row.after_json).label, 'Referral Source');
});

test('the config audit is separate from the data audit', () => {
  // Different question, different reader, different retention. Merging them is
  // how "who changed the schema?" becomes unanswerable in a busy log.
  const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('config_audit','audit_log')");
  assert.equal(tables.length, 2, 'both audit tables should exist independently');
});

/* --------------------------------------------------------- cleanup */

/**
 * Clean up exactly what this file created, and nothing else.
 *
 * This previously ran `DELETE FROM field_def WHERE is_custom = 1`, which is
 * every custom field in the database — including ones a real administrator
 * configured through Setup. A test that destroys production configuration when
 * pointed at the wrong database is worse than no test.
 */
const OWN_FIELDS = ['referral_code', 'expected_aum', 'segment', 'sub_segment', 'days_open'];
const list = OWN_FIELDS.map(() => '?').join(',');

run(`DELETE FROM field_value WHERE field_id IN
     (SELECT id FROM field_def WHERE entity = 'lead' AND api_name IN (${list}))`, OWN_FIELDS);
run(`DELETE FROM picklist_value WHERE field_id IN
     (SELECT id FROM field_def WHERE entity = 'lead' AND api_name IN (${list}))`, OWN_FIELDS);
run(`DELETE FROM field_def WHERE entity = 'lead' AND api_name IN (${list})`, OWN_FIELDS);
run('DELETE FROM field_history WHERE record_id = 9100001');
// The tracked-custom-field test writes history against a real seeded lead.
// Leaving those rows behind puts a retired field's changes on a live record's
// history tab, which is our mess, not the product's.
run(`DELETE FROM field_history WHERE field IN (${list})`, OWN_FIELDS);
run("DELETE FROM config_audit WHERE target = 'lead.referral_code'");

console.log(`\n${passed} passed, ${failed} failed\n`);
db.close();
process.exit(failed ? 1 : 0);
