/**
 * Fields that became maskable without a deployment (P3-11).
 *
 * Masking used to be a constant: seven field names in `MASKERS`, and an eighth
 * meant editing a source file. Now an administrator adds one from Setup, which
 * moves a security decision out of the release cycle and into a form -- so what
 * has to be proven is not that the form works, but that a field added through
 * it is masked as thoroughly as one that shipped.
 *
 * The clause that matters is "on screen, in exports and in the API", and the
 * export is the half that was nearly missed: it never went through maskRecord
 * at all, so a configured field would have been dotted on every screen and
 * written to a spreadsheet in the clear.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { maskRecord, MASK_STRATEGIES } from '../src/security.js';
import {
  BUILT_IN, maskableFields, isMaskable, addMaskable, removeMaskable,
  refreshMaskable, maskedFieldsFor,
} from '../src/engine/masking.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nConfigurable field masking');

/* A field name of our own, so a run cannot collide with anything real and a
   failed run leaves nothing behind that a later one would trip over. */
const FIELD = 'probe_secret_note';
const cleanup = () => {
  run('DELETE FROM maskable_field WHERE field = ?', [FIELD]);
  run('DELETE FROM field_masking WHERE field = ?', [FIELD]);
  refreshMaskable();
};
cleanup();

/* ------------------------------------------------------------ the list */

await test('a field added from Setup becomes maskable', () => {
  assert(!isMaskable(FIELD), 'the probe field was already maskable before the test');

  const r = addMaskable(FIELD, 'Probe note', 'hide', null);
  assert(!r.error, `adding was refused: ${r.error}`);
  assert(isMaskable(FIELD), 'the field was added and is still not maskable');

  const row = maskableFields().find((f) => f.field === FIELD);
  assert(row, 'the field is not in the list the Setup screen reads');
  assert.equal(row.custom, true, 'an added field is not marked as added');
  assert.equal(row.label, 'Probe note');
});

await test('the shipped fields are still there and still marked as shipped', () => {
  const list = maskableFields();
  for (const f of BUILT_IN) {
    const row = list.find((r) => r.field === f);
    assert(row, `"${f}" shipped as maskable and is missing from the list`);
    assert.equal(row.custom, false, `"${f}" ships as maskable and is marked as added`);
  }
});

/* --------------------------------------------------------- the refusals */

await test('a shipped field cannot be added again or removed', () => {
  /* Both directions, because they fail differently: adding would create a row
     that shadows a built-in, and removing would appear to work on a screen
     while the field carried on being masked. */
  assert(addMaskable('pan', 'PAN', 'ends', null).error, 'pan was added a second time');
  assert(removeMaskable('pan').error, 'pan, which ships masked, was removed');
  assert(isMaskable('pan'), 'pan stopped being maskable');
});

await test('a field name that is not a field name is refused', () => {
  for (const bad of ['Bad Name!', '1leading', '', 'x', 'a'.repeat(60), 'drop table']) {
    assert(addMaskable(bad, 'x', 'hide', null).error, `"${bad}" was accepted as a field name`);
  }
});

await test('an unknown masking strategy is refused, not defaulted', () => {
  /* Defaulting would be the dangerous kindness here: the field would look
     masked on the screen and be obscured by the wrong shape, which is how a
     value leaks while appearing to be protected. */
  const r = addMaskable('probe_other_field', 'x', 'nonsense', null);
  assert(r.error, 'an unknown strategy was accepted');
  assert(!isMaskable('probe_other_field'), 'the field was added despite the bad strategy');
});

/* ------------------------------------------------------- what it does */

await test('the chosen strategy is the one applied', () => {
  /* "hide" on this field, so the value must not survive in part. The last four
     characters of an account number are a courtesy; the last four of a date of
     birth are most of it, which is why the strategy is asked for. */
  const masked = maskRecord({ [FIELD]: 'sensitive value' }, { fields: new Set([FIELD]) });
  assert.notEqual(masked[FIELD], 'sensitive value', 'the field came back in the clear');
  assert(!String(masked[FIELD]).includes('alue'), 'the end of the value survived a "hide"');
  assert.equal(masked._pii_masked, true, 'the row is not flagged as masked');
});

await test('a shipped field keeps its own masker whatever the table says', () => {
  /* The table is spread under the built-ins, not over them. A row naming an
     existing field must not be able to make it LESS masked than it ships --
     a configuration mistake should not be able to widen exposure. */
  run("INSERT OR REPLACE INTO maskable_field (field, label, strategy) VALUES ('pan','PAN','hide')");
  refreshMaskable();
  try {
    const masked = maskRecord({ pan: 'ABCDE1234F' }, { fields: new Set(['pan']) });
    assert.equal(masked.pan, 'AB••••••4F', `pan masked as ${masked.pan}, not by its shipped masker`);
  } finally {
    run("DELETE FROM maskable_field WHERE field = 'pan'");
    refreshMaskable();
  }
});

await test('an added field is masked for the roles that mask everything else', () => {
  /* UNMASKED_BY_DEFAULT names the exceptions, so a role absent from it sees
     nothing in the clear -- which has to hold for fields added later, or every
     addition would arrive visible to everyone until somebody set the grid. */
  const masked = maskedFieldsFor('sales_rm');
  assert(masked.has(FIELD), 'a newly added field is not masked for a sales RM');

  const admin = maskedFieldsFor('admin');
  assert(!admin.has(FIELD), 'an admin, who sees everything in the clear, is masked');
});

/* ------------------------------------------------------------ the export */

await test('an added field is masked in an export, not just on screen', async () => {
  /* The clause that nearly went missing. The list export never called
     maskRecord: it had its own `pii: true` flag on two columns, so a field made
     maskable in Setup would have been dotted on every screen and then written
     to a spreadsheet in the clear -- the one direction where it matters, since
     the file leaves the building. */
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@bonanza.test', password: 'bonanza' }),
  });
  assert.equal(login.status, 200, 'could not sign in to check the export');
  const { token } = await login.json();

  // `city` is a real column on a lead and ships unmasked, so it can be observed
  // changing. Added as "hide" so a partial value cannot be mistaken for a pass.
  /* Cleared through the route, not the table. Deleting the row here would
     leave the SERVER still holding city in its cache, so the "before" export
     would come back masked and the test would fail on its own setup. */
  await fetch(`${BASE}/api/setup/field-masking/fields/city`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  refreshMaskable();
  const list = one('SELECT id FROM lead_lists LIMIT 1');
  assert(list, 'no lead list seeded, so the export cannot be checked');

  const exportIt = async () => {
    const res = await fetch(`${BASE}/api/lists/${list.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ columns: ['name', 'city'] }),
    });
    assert.equal(res.status, 200, `export returned HTTP ${res.status}`);
    return (await res.json()).csv ?? '';
  };

  const before = await exportIt();
  assert(/,"[A-Z]/.test(before.split('\n')[1] ?? ''), 'city was already masked before the test');

  /* Added over HTTP, not by calling the engine here. The cache lives in the
     process that serves the request, so adding it in this one would leave the
     server masking nothing and the test passing for the wrong reason. */
  const add = await fetch(`${BASE}/api/setup/field-masking/fields`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ field: 'city', label: 'City', strategy: 'hide' }),
  });
  assert.equal(add.status, 200, `could not add city: HTTP ${add.status}`);
  try {
    const after = await exportIt();
    const row = after.split('\n')[1] ?? '';
    assert(!/,"[A-Za-z]{2,}"/.test(row.replace(/^"[^"]*"/, '')),
      `the export still carries a city in the clear: ${row}`);
    assert(row.includes('*'), `the export does not mask city at all: ${row}`);
  } finally {
    await fetch(`${BASE}/api/setup/field-masking/fields/city`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    refreshMaskable();
  }
});

/* ----------------------------------------------------------- removing */

await test('removing a field takes its per-role decisions with it', () => {
  /* Otherwise re-adding the field later would silently restore settings that
     nobody could see in the meantime, which is the worst kind of surprise on a
     screen about who may read what. */
  run('INSERT OR REPLACE INTO field_masking (role_code, field, masked) VALUES (?,?,1)', ['sales_rm', FIELD]);
  assert.equal(all('SELECT 1 FROM field_masking WHERE field = ?', [FIELD]).length, 1, 'setup failed');

  const r = removeMaskable(FIELD);
  assert(!r.error, `removing was refused: ${r.error}`);
  assert(!isMaskable(FIELD), 'the field is still maskable after being removed');
  assert.equal(all('SELECT 1 FROM field_masking WHERE field = ?', [FIELD]).length, 0,
    'the per-role decisions outlived the field');
});

await test('a removed field is in the clear again', () => {
  const row = maskRecord({ [FIELD]: 'sensitive value' }, { fields: new Set([FIELD]) });
  assert.equal(row[FIELD], 'sensitive value', 'a removed field is still being masked');
});

await test('every strategy actually obscures something', () => {
  /* A strategy that returned its input would pass every test above by leaving
     the field "masked" in name only. */
  for (const [name, fn] of Object.entries(MASK_STRATEGIES)) {
    const out = fn('ABCDE1234F');
    assert.notEqual(out, 'ABCDE1234F', `strategy "${name}" returns the value unchanged`);
    assert(out.includes('•'), `strategy "${name}" does not obscure anything`);
  }
});

await test('the server notices the table changing underneath it', async () => {
  /* How this went wrong for real. A field was added through the screen, then a
     reseed emptied the table while the server kept running -- and it went on
     masking a field that no longer existed, because the cache was only ever
     filled by this process making the change itself.

     Harmless in that direction. The same drift the other way round is a field
     somebody just added NOT being masked, which is not harmless, and it lasted
     until a restart either way.

     So: change the table behind the server's back, the way a reseed, a restore
     or a migration does, and it must catch up on its own. */
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@bonanza.test', password: 'bonanza' }),
  });
  const { token } = await login.json();
  const list = one('SELECT id FROM lead_lists LIMIT 1');

  const cityInExport = async () => {
    const res = await fetch(`${BASE}/api/lists/${list.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ columns: ['name', 'city'] }),
    });
    return ((await res.json()).csv ?? '').split('\n')[1] ?? '';
  };

  // Added properly, so the server knows about it.
  await fetch(`${BASE}/api/setup/field-masking/fields`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ field: 'city', label: 'City', strategy: 'hide' }),
  });
  assert((await cityInExport()).includes('*'), 'the field was not masked even when added properly');

  try {
    /* Now taken away without telling it, which is what a reseed does. Retried
       because the server is mid-export on the same file and SQLite will refuse
       a writer while a reader holds the lock. */
    for (let i = 0; i < 20; i += 1) {
      try { run("DELETE FROM maskable_field WHERE field = 'city'"); break; }
      catch (err) {
        if (!/locked|busy/i.test(err.message) || i === 19) throw err;
        await new Promise((r) => setTimeout(r, 100));   // eslint-disable-line no-await-in-loop
      }
    }

    // Within the TTL it must stop, without a restart and without being asked.
    const deadline = Date.now() + 9000;
    let row = await cityInExport();
    while (row.includes('*') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 750));
      row = await cityInExport();               // eslint-disable-line no-await-in-loop
    }
    assert(!row.includes('*'),
      `the server is still masking a field the table no longer has: ${row}`);
  } finally {
    try { run("DELETE FROM maskable_field WHERE field = 'city'"); } catch { /* the route below is the real cleanup */ }
    await fetch(`${BASE}/api/setup/field-masking/fields/city`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }
});

cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
