/**
 * Field formats, on both sides of the wire. P3-30.
 *
 * The reported defect was silence: an invalid PAN did not save and nothing said
 * why. Three separate things caused it, and only one of them was the missing
 * inline check.
 *
 *   1. There was no client-side validation, so the first anybody heard of a
 *      format was after pressing Save.
 *   2. The form read field-level errors from `payload.fields`, a key the API
 *      has never sent -- it answers `errors: [{ field, message }]` -- so every
 *      per-field message the server produced was dropped.
 *   3. Core column fields had nowhere to render one anyway. Only custom fields
 *      did, so a malformed PAN had no home on screen even when the message
 *      arrived.
 *
 * The inline rules are a copy of the server's. That is the right trade -- the
 * server stays the control, since imports, automation and the API never touch a
 * form -- but a copy drifts, and a form that rejects what the API would accept
 * is worse than no inline check at all. So the two are compared here.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { V } from '../src/security.js';

const CRLF = /\r\n/g;
const read = (p) => readFileSync(p, 'utf8').replace(CRLF, '\n');

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nField formats');

const RULES = '../client/src/fieldRules.js';
const DETAIL = '../client/src/crm/LeadDetail.jsx';

/** The client's regexes, lifted out of the source as written. */
const clientPatterns = () => {
  const src = read(RULES);
  const out = {};
  for (const m of src.matchAll(/(\w+):\s*\{\s*test:\s*\(v\)\s*=>\s*(\/[^\n]+?\/)\.test/g)) {
    out[m[1]] = m[2];
  }
  return out;
};

test('the client checks the same formats the server does', () => {
  const client = clientPatterns();
  const serverNames = ['mobile', 'pan', 'ifsc', 'email', 'pincode'];

  for (const name of serverNames) {
    assert(client[name], `the client has no rule for ${name}, so the form will accept what the API refuses`);
  }
});

test('the two agree on what is valid, value by value', () => {
  /* Compared by behaviour rather than by regex text, which is what actually
     matters: the patterns may be written differently and still agree. */
  const src = read(RULES);
  const cases = {
    mobile: { good: ['9876543210', '6000000000'], bad: ['1234567890', '98765432101', '987654321', 'abcdefghij'] },
    pan: { good: ['ABCDE1234F'], bad: ['ABCDE1234', 'ABCDE12345F', '12345ABCDF', 'ABCDE1234FF'] },
    ifsc: { good: ['HDFC0001234'], bad: ['HDFC1001234', 'HDF0001234', 'HDFC000123'] },
    email: { good: ['a@b.co', 'name.surname@bonanza.com'], bad: ['a@b', 'a b@c.com', '@b.com', 'ab.com'] },
    pincode: { good: ['400001'], bad: ['040001', '40001', '4000012', 'abcdef'] },
  };

  for (const [name, { good, bad }] of Object.entries(cases)) {
    const m = src.match(new RegExp(`${name}:\\s*\\{\\s*test:\\s*\\(v\\)\\s*=>\\s*(/[^\\n]+?/)\\.test\\(([^)]*)\\)`));
    assert(m, `could not read the client rule for ${name}`);

    const upper = /toUpperCase/.test(m[2]);
    const re = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), m[1].slice(m[1].lastIndexOf('/') + 1));
    const clientOk = (v) => re.test(upper ? String(v).trim().toUpperCase() : String(v).trim());

    for (const v of good) {
      assert(V[name](v), `fixture wrong: the server rejects ${name} "${v}"`);
      assert(clientOk(v), `the client rejects ${name} "${v}" which the server accepts`);
    }
    for (const v of bad) {
      assert(!V[name](v), `fixture wrong: the server accepts ${name} "${v}"`);
      assert(!clientOk(v), `the client accepts ${name} "${v}" which the server refuses`);
    }
  }
});

test('a message names the field and the shape it wants', () => {
  const src = read(RULES);
  assert(/ABCDE1234F/.test(src), 'the PAN message does not show the expected shape');
  assert(/10-digit/.test(src), 'the mobile message does not state the length');
  assert(/cannot contain letters/.test(src),
    'a number field does not get the specific message the ticket asked for');
});

test('field errors are read from the key the API actually sends', () => {
  const rules = read(RULES);
  assert(/payload\?\.errors/.test(rules),
    'field errors are still read from a key the API does not send');

  const detail = read(DETAIL);
  assert(!/err\.payload\?\.fields/.test(detail),
    'the edit form still reads payload.fields, which is always undefined');
});

test('a core field can show its own error, not only a custom one', () => {
  const detail = read(DETAIL);
  const editForm = detail.slice(detail.indexOf('function EditLead'));
  const errorRenders = (editForm.match(/err-text/g) ?? []).length;
  assert(errorRenders >= 2,
    `only ${errorRenders} place renders a field error; core columns had none, `
    + 'which is why a malformed PAN had nowhere on screen to be reported');
});

test('a save that changes nothing says so rather than closing', () => {
  const detail = read(DETAIL);
  const editForm = detail.slice(detail.indexOf('function EditLead'));
  assert(!/if \(!Object\.keys\(body\)\.length\) \{ onClose\(\); return; \}/.test(editForm),
    'an empty save still closes the form silently, which is the reported defect');
  assert(/Nothing was saved|nothing to save/.test(editForm),
    'an empty save does not explain itself');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
