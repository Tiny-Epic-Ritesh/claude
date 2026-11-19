/**
 * A3: what re-reading the write actions found (OPS-47 to OPS-54, and on).
 *
 * The eight defects found on 16 Oct reading the 283 write actions for Part 4
 * item 8.4 were ruled to be fixed one commit each and never written down.
 * On 19 Nov the same 283 calls were read again, each with the server code
 * that answers it, asking what actually happens. Each check here is one
 * defect, driven as the screen or the API drives it, and expects the right
 * behaviour: each failed before its fix.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { createFollowUp, sweepReminders } from '../src/engine/followups.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const made = [];
const make = (table, cols) => {
  const keys = Object.keys(cols);
  const id = Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(cols)).lastInsertRowid);
  made.push([table, id]);
  return id;
};
const stamp = String(Date.now()).slice(-6);
let serial = 0;
const mobile = () => { serial += 1; return `8${stamp}${String(serial).padStart(3, '0')}`; };
const lead = (extra = {}) => make('leads', {
  name: 'A3 probe', mobile: mobile(), source: 'Referral', stage: 'New', sales_org: 'BONANZA', ...extra,
});

const call = async (who, method, path, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json };
};

const ADMIN = await probeAdmin('a3-admin', { role: 'admin', sales_org: 'BONANZA' });
const BOTH = await probeAdmin('a3-both', { role: 'admin', sales_org: 'BONANZA' });
run('UPDATE users SET org_access = ? WHERE id = ?', ['["BONANZA","BIGUL"]', BOTH.id]);
const RM = await probeAdmin('a3-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const BIGUL_RM = await probeAdmin('a3-bigul-rm', { role: 'sales_rm', sales_org: 'BIGUL' });
const probes = [ADMIN, BOTH, RM, BIGUL_RM];
const inAnHour = () => one("SELECT datetime('now', '+1 hour') t").t;

console.log('\nA3: defects found re-reading the write actions');

try {
  // checks are added with their fixes, one commit each
  await test('an email from a lead goes to its email address, a WhatsApp to its mobile', async () => {
    const number = mobile();
    const a = lead({ mobile: number, email: `a3-${stamp}@example.in`, owner_id: ADMIN.id, marketing_opt_out: 0 });
    const email = await call(ADMIN, 'POST', `/api/leads/${a}/message`, { channel: 'email', subject: 'A3 probe', body: 'A3 probe', intent: 'service' });
    assert.equal(email.status, 201, `email: HTTP ${email.status} ${JSON.stringify(email.body).slice(0, 120)}`);
    assert.equal(email.body.to, `a3-${stamp}@example.in`, `the email was addressed to ${email.body.to}`);
    const wa = await call(ADMIN, 'POST', `/api/leads/${a}/message`, { channel: 'whatsapp', body: 'A3 probe', intent: 'service' });
    assert.equal(wa.status, 201, `whatsapp: HTTP ${wa.status} ${JSON.stringify(wa.body).slice(0, 120)}`);
    assert.equal(wa.body.to, number, `the WhatsApp was addressed to ${wa.body.to}`);
    const noMobile = lead({ mobile: null, email: `a3b-${stamp}@example.in`, owner_id: ADMIN.id });
    const sms = await call(ADMIN, 'POST', `/api/leads/${noMobile}/message`, { channel: 'sms', body: 'A3 probe', intent: 'service' });
    assert.notEqual(sms.body?.to, `a3b-${stamp}@example.in`, 'an SMS was addressed to an email address');
  });

} finally {
  for (const [table, id] of [...made].reverse()) {
    try { run(`DELETE FROM ${table} WHERE id = ?`, [id]); } catch { /* removed with its parent */ }
  }
  for (const p of probes) p.cleanup();
}

function ADMIN2() {
  ADMIN2.row ??= one("SELECT id FROM users WHERE role = 'admin' AND sales_org = 'BONANZA' AND active = 1 AND email NOT LIKE 'probe-%' ORDER BY id LIMIT 1");
  return ADMIN2.row;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
