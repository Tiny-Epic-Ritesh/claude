/**
 * Which columns a list shows.
 *
 * The interesting assertions here are not "a column can be hidden". They are:
 *
 *   • hiding a column is cosmetic and grants nothing when reversed — the same
 *     rule as tab visibility, and the one somebody will be tempted to break the
 *     first time a masking request arrives;
 *   • a person's choice beats their role's, and clearing it falls back rather
 *     than sticking;
 *   • the column that identifies the row cannot be hidden, because a list of
 *     rows nobody can identify is not a list;
 *   • and the server's catalogue matches what the client actually renders,
 *     the same way the Setup registry is held to the server's section list.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { all, one, run } from '../src/db.js';
import {
  LIST_COLUMNS, isList, columnTabId, resolveColumns, visibleColumnKeys,
  setUserColumns, setRoleColumns, clearUserColumns, roleDefaultsFor, hasUserChoice,
  COLUMN_PREFIX,
} from '../src/engine/columns.js';

/* Source read from disk, so line endings are whatever git checked out. */
const CRLF = /\r\n/g;

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nList columns');

const rm = one("SELECT * FROM users WHERE role = 'sales_rm' AND active = 1 LIMIT 1");
const other = one("SELECT * FROM users WHERE role = 'sales_rm' AND active = 1 AND id != ? LIMIT 1", [rm?.id ?? -1]);

/** Leave no settings behind, whatever a test did. */
const wipe = () => run(
  'DELETE FROM tab_visibility WHERE tab_id LIKE ?', [`${COLUMN_PREFIX}client:%`],
);

wipe();

/* ------------------------------------------------------------ the shape */

test('every column ships visible unless the catalogue says otherwise', () => {
  const cols = resolveColumns(rm, 'client');
  assert.equal(cols.length, LIST_COLUMNS.client.length, 'the catalogue did not come back whole');
  for (const c of cols) {
    assert.equal(c.visible, c.default !== false, `${c.key} did not ship at its default`);
  }
});

test('an unknown list is not a list', () => {
  assert(!isList('penguins'));
  assert.deepEqual(resolveColumns(rm, 'penguins'), []);
  assert(!setUserColumns(rm.id, 'penguins', { name: false }).ok);
});

test('an unknown column is refused rather than stored', () => {
  const out = setUserColumns(rm.id, 'client', { not_a_column: false });
  assert(!out.ok, 'an unknown column was accepted');
  assert(/not a column/i.test(out.error), out.error);
  wipe();
});

/* ---------------------------------------------------- the resolve chain */

test('a person\'s choice beats their role\'s default', () => {
  setRoleColumns('sales_rm', 'client', { owner_name: false });
  assert.equal(resolveColumns(rm, 'client').find((c) => c.key === 'owner_name').visible, false,
    'the role default did not apply');

  setUserColumns(rm.id, 'client', { owner_name: true });
  const mine = resolveColumns(rm, 'client').find((c) => c.key === 'owner_name');
  assert.equal(mine.visible, true, 'the personal choice did not win');
  assert.equal(mine.source, 'user', `resolved from ${mine.source}`);
  wipe();
});

test('clearing a choice falls back to the role, not to everything on', () => {
  setRoleColumns('sales_rm', 'client', { brokerage_ytd: false });
  setUserColumns(rm.id, 'client', { brokerage_ytd: true });
  assert(hasUserChoice(rm.id, 'client'), 'the personal choice was not recorded');

  clearUserColumns(rm.id, 'client');
  const after = resolveColumns(rm, 'client').find((c) => c.key === 'brokerage_ytd');
  assert.equal(after.visible, false, 'clearing turned the column on instead of following the role');
  assert.equal(after.source, 'role', `fell back to ${after.source}`);
  assert(!hasUserChoice(rm.id, 'client'), 'a cleared choice is still recorded');
  wipe();
});

test('one person\'s choice does not reach another', () => {
  if (!other) { assert(true, 'only one sales RM seeded; nothing to compare'); return; }
  setUserColumns(rm.id, 'client', { client_code: false });
  assert.equal(resolveColumns(other, 'client').find((c) => c.key === 'client_code').visible, true,
    'a colleague inherited somebody else\'s column choice');
  wipe();
});

/* ------------------------------------------------- what cannot be hidden */

test('the identifying column cannot be hidden', () => {
  setUserColumns(rm.id, 'client', { name: false });
  const name = resolveColumns(rm, 'client').find((c) => c.key === 'name');
  assert.equal(name.visible, true, 'the client name was hidden, leaving rows nobody can identify');
  assert.equal(name.source, 'required');
  wipe();
});

test('a row written straight into the table cannot hide it either', () => {
  /* A row predating `always`, or written by hand. The resolver must not trust
     it -- otherwise the list is stranded and nobody can see why. */
  run(
    `INSERT INTO tab_visibility (scope_type, scope_key, tab_id, visible)
     VALUES ('user', ?, ?, 0)`,
    [String(rm.id), columnTabId('client', 'name')],
  );
  assert.equal(resolveColumns(rm, 'client').find((c) => c.key === 'name').visible, true,
    'a hand-written row hid the identifying column');
  wipe();
});

/* --------------------------------------------- hiding is not security */

test('hiding a column changes nothing about what the API returns', () => {
  /* The rule that matters. "Just hide the column" is a tempting answer to a
     masking request and it is always the wrong one: the field is still sent,
     still masked by whatever applies to the caller, and ticking it back on
     grants nothing. If this ever becomes false, masking has been quietly
     replaced by a preference anyone can flip. */
  const source = readFileSync('src/engine/columns.js', 'utf8').replace(CRLF, '\n');
  assert(!/SELECT .*FROM clients/i.test(source),
    'the column engine reads client data, so it is no longer only a preference');

  const routes = readFileSync('src/routes/clients.js', 'utf8').replace(CRLF, '\n');
  assert(!/resolveColumns|visibleColumnKeys/.test(routes),
    'the clients route filters its payload by column choice, which makes a preference load-bearing');
});

test('a hidden column is still masked when shown again', () => {
  // Masking is keyed on role and field, never on whether a column is ticked.
  const masking = readFileSync('src/engine/masking.js', 'utf8').replace(CRLF, '\n');
  assert(!/tab_visibility|COLUMN_PREFIX|resolveColumns/.test(masking),
    'masking consults the column chooser, so unhiding a column would unmask a field');
});

/* ------------------------------------------ server and client agreement */

test('the server and the client know the same columns', () => {
  /* The same guard the Setup registry gets. The label is duplicated on purpose
     -- the server needs it for a Setup grid, the client needs its own render
     details -- and duplication that is checked is cheaper than moving rendering
     onto the server. */
  const src = readFileSync('../client/src/crm/Clients.jsx', 'utf8').replace(CRLF, '\n');
  const block = src.match(/const COLUMNS = \[([\s\S]*?)\];/);
  assert(block, 'could not find the COLUMNS table in Clients.jsx');

  const clientKeys = [...block[1].matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const serverKeys = LIST_COLUMNS.client.map((c) => c.key);

  assert.deepEqual(clientKeys, serverKeys,
    `client renders [${clientKeys}] but the server offers [${serverKeys}]`);

  for (const col of LIST_COLUMNS.client) {
    assert(block[1].includes(`'${col.label}'`),
      `the server calls ${col.key} "${col.label}" and the client does not`);
  }
});

/* -------------------------------------------------------- role defaults */

test('a role default is visible to Setup and scoped to that role', () => {
  setRoleColumns('caller', 'client', { holding_value: false });
  const defaults = roleDefaultsFor('client');
  const forCaller = defaults.filter((d) => d.role === 'caller');
  assert.equal(forCaller.length, 1, 'the role default was not recorded');
  assert.equal(forCaller[0].key, 'holding_value');
  assert.equal(forCaller[0].visible, false);

  assert.equal(defaults.filter((d) => d.role === 'sales_rm').length, 0,
    'a default set for one role reached another');
  wipe();
});

test('a role default cannot hide the identifying column either', () => {
  setRoleColumns('sales_rm', 'client', { name: false });
  assert.equal(resolveColumns(rm, 'client').find((c) => c.key === 'name').visible, true);
  wipe();
});

test('visibleColumnKeys returns only what is on', () => {
  setUserColumns(rm.id, 'client', { owner_name: false, client_code: false });
  const keys = visibleColumnKeys(rm, 'client');
  assert(!keys.includes('owner_name') && !keys.includes('client_code'), 'hidden columns came back');
  assert(keys.includes('name'), 'the identifying column went missing');
  wipe();
});

/* ------------------------------------------------ no collision with tabs */

test('column settings cannot collide with tab settings', () => {
  const id = columnTabId('client', 'name');
  assert(id.startsWith(COLUMN_PREFIX), 'column ids are not prefixed');
  assert.notEqual(id, 'clients', 'a column id collided with the clients tab');

  // And a column row must never be counted as a tab override.
  setUserColumns(rm.id, 'client', { owner_name: false });
  const tabRows = all(
    `SELECT tab_id FROM tab_visibility WHERE scope_type = 'user' AND scope_key = ?
       AND tab_id NOT LIKE ?`,
    [String(rm.id), `${COLUMN_PREFIX}%`],
  );
  assert(!tabRows.some((r) => r.tab_id.includes('client')),
    'a column choice was written where a tab override would be read');
  wipe();
});

wipe();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
