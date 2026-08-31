/**
 * Log retention and reading (P2-15a).
 *
 * The part worth testing is not that a table can be listed. It is that the
 * boundary and the retention promise both hold: a Bigul supervisor reading the
 * telephony log must not learn which Bonanza clients were called, and a
 * retention period nothing enforces is worse than none — under DPDP the firm
 * has then written down how long it keeps personal data and kept it longer.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { LOG_KINDS, retention, readLog, purge, seedRetention } from '../src/engine/logs.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nLogs and retention');

seedRetention();

test('every kind of log has a retention period and somewhere to read it from', () => {
  const sources = new Set(all("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name));
  for (const k of retention()) {
    assert(Number.isInteger(k.days) && k.days > 0, `${k.kind} has no retention period`);
    assert(sources.has(k.source), `${k.kind} reads from ${k.source}, which does not exist`);
    assert(k.note && k.note.trim(), `${k.kind} has no note saying why that period`);
  }
});

test('the payment period is flagged as an assumption rather than presented as law', () => {
  /* Seven years is general practice, not something I could source. A number
     nobody can trace back to a decision is the kind an auditor asks about and
     nobody can answer. */
  const pay = retention().find((k) => k.kind === 'payment');
  assert(/assumption/i.test(pay.note), `the payment note does not flag its own uncertainty: ${pay.note}`);
});

test('an integration log entry never carries a message body or a number', () => {
  /* The one that matters. A log that quietly becomes a second copy of the
     client database is a breach waiting for somebody to grant support read
     access. Asserted on the schema, so adding such a column fails here. */
  const cols = all('PRAGMA table_info(integration_log)').map((c) => c.name);
  for (const forbidden of ['body', 'payload', 'mobile', 'phone', 'to', 'email', 'pan', 'message']) {
    assert(!cols.includes(forbidden),
      `integration_log has a "${forbidden}" column — logs must not become a second copy of client data`);
  }
});

test('the telephony log is scoped to the reader’s book', () => {
  const lead = one("SELECT id, sales_org FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL LIMIT 1");
  const marker = `SCOPE-PROBE-${Date.now()}`;
  run(`INSERT INTO integration_log (kind, lead_id, reference, summary) VALUES ('telephony',?,?,?)`,
    [lead.id, marker, 'probe']);

  try {
    const bonanza = readLog('telephony', { orgs: ['BONANZA'] });
    assert(bonanza.rows.some((r) => r.reference === marker), 'the owning book cannot see its own entry');

    const bigul = readLog('telephony', { orgs: ['BIGUL'] });
    assert(!bigul.rows.some((r) => r.reference === marker),
      'a Bonanza call appeared in the Bigul telephony log');
  } finally {
    run('DELETE FROM integration_log WHERE reference = ?', [marker]);
  }
});

test('an entry attached to no lead is infrastructure and stays visible', () => {
  // Otherwise a failed vendor handshake — which belongs to nobody — vanishes
  // from the log of the person trying to diagnose it.
  const marker = `INFRA-${Date.now()}`;
  run(`INSERT INTO integration_log (kind, reference, summary) VALUES ('webhook',?,?)`, [marker, 'handshake']);
  try {
    const seen = readLog('webhook', { orgs: ['BIGUL'] });
    assert(seen.rows.some((r) => r.reference === marker), 'an unattached entry was hidden by book scope');
  } finally {
    run('DELETE FROM integration_log WHERE reference = ?', [marker]);
  }
});

test('the purge removes what is past its period and nothing else', () => {
  const days = retention().find((k) => k.kind === 'webhook').days;
  const old = `OLD-${Date.now()}`;
  const fresh = `FRESH-${Date.now()}`;

  run(`INSERT INTO integration_log (kind, reference, summary, at)
       VALUES ('webhook', ?, 'ancient', datetime('now', ?))`, [old, `-${days + 5} days`]);
  run(`INSERT INTO integration_log (kind, reference, summary) VALUES ('webhook', ?, 'today')`, [fresh]);

  purge();

  assert(!one('SELECT id FROM integration_log WHERE reference = ?', [old]),
    'an entry past its retention period survived the purge');
  assert(one('SELECT id FROM integration_log WHERE reference = ?', [fresh]),
    'the purge removed an entry that was inside its period');

  run('DELETE FROM integration_log WHERE reference IN (?,?)', [old, fresh]);
});

test('an unknown log kind is a not-found, not an empty table', () => {
  // An empty table reads as "nothing happened", which is a different and
  // much more reassuring statement than "that log does not exist".
  assert.equal(readLog('not_a_log', { orgs: ['BONANZA'] }), null);
});

test('every kind the engine offers is one the screen can name', () => {
  for (const k of LOG_KINDS) {
    assert(k.label && k.label.trim(), `${k.kind} has no label`);
    assert(k.label !== k.kind, `${k.kind} is showing its own identifier as its label`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
