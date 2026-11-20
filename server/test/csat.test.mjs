/**
 * A15 (B20, ruled 19 Nov 2026): a case's CSAT is its customer's alone.
 *
 * Asked once when the case is done, in its own business's name (OPS-65);
 * answered by a WhatsApp reply that starts with a number from 1 to 5 and
 * carries no other number, within 15 days, or by a partner on the portal;
 * kept as a Survey interaction, with the case's score worked out from it;
 * never set by staff, voided only with a reason by csat.void; voided by a
 * reopen; a 1 or 2 is a call-back for the next level up; credited to whoever
 * resolved the case; and staff-entered scores from before kept, not counted.
 *
 * The webhook itself is driven when the server runs under
 * scripts/webhook-secrets.mjs (E2E_WEBHOOK_SECRET set); otherwise the same
 * engine function it calls is called directly.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import * as db from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import { tokenKey } from '../src/security.js';

const { all, one, run } = db;
/* Loaded so that each check below fails on its own, not the whole file, when
   run against code without them -- which is how this was proved. */
const settleLegacyCsat = db.settleLegacyCsat ?? (() => { throw new Error('there is no legacy-score step'); });
const engine = await import('../src/engine/csat.js').catch(() => ({}));
const scoreOf = engine.scoreOf ?? (() => { throw new Error('there is no CSAT engine'); });
const answerFromWhatsApp = engine.answerFromWhatsApp ?? (() => { throw new Error('there is no CSAT engine'); });

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HOOK = process.env.E2E_WEBHOOK_SECRET || null;
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

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
const mobile = () => { serial += 1; return `7${stamp}${String(serial).padStart(3, '0')}`; };

const call = async (who, method, path, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json };
};

/** A WhatsApp reply arriving, through the webhook when it can be signed. */
const reply = async (number, text) => {
  const messageId = `CSAT-${stamp}-${serial += 1}`;
  if (!HOOK) return answerFromWhatsApp(`91${number}`, text, messageId);
  const res = await fetch(`${BASE}/api/webhooks/smartping/whatsapp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-secret': HOOK },
    body: JSON.stringify({ messageId, waNumber: `91${number}`, text, senderName: 'CSAT probe' }),
  });
  const body = await res.json();
  return body.csat ? { score: body.csat, ticket_id: body.ticket_id } : null;
};

const RESOLVER = await probeAdmin('csat-resolver', { role: 'admin', sales_org: 'BIGUL' });
const MANAGER = await probeAdmin('csat-manager', { role: 'admin', sales_org: 'BIGUL' });
const CARE = await probeAdmin('csat-care', { role: 'customer_care', sales_org: 'BIGUL' });
run('UPDATE users SET manager_id = ? WHERE id = ?', [MANAGER.id, RESOLVER.id]);
const probes = [RESOLVER, MANAGER, CARE];

/** A Bigul client's open case, assigned to the resolver. */
const openCase = () => {
  const number = mobile();
  const lead = make('leads', { name: 'CSAT probe client', mobile: number, source: 'Referral', stage: 'New', sales_org: 'BIGUL', owner_id: RESOLVER.id });
  const ticket = make('tickets', {
    ref: `BGL-C${stamp}${serial}`, subject: 'CSAT probe', description: 'A contract note was wrong; corrected and re-sent.', sales_org: 'BIGUL', status: 'Open', lead_id: lead, assignee_id: RESOLVER.id,
  });
  return { number, lead, ticket };
};
const surveys = (ticket) => all('SELECT * FROM csat_surveys WHERE ticket_id = ? ORDER BY id', [ticket]);
const scoreOn = (ticket) => one('SELECT csat FROM tickets WHERE id = ?', [ticket]).csat;
const resolve = (ticket, status = 'Resolved') => call(RESOLVER, 'PATCH', `/api/tickets/${ticket}`, { status });

console.log('\nA15: CSAT is the customer\'s alone');

try {
  await test('resolving a case asks its customer once, in its own business\'s name; closing it asks nothing more (OPS-65)', async () => {
    const c = openCase();
    const asked = () => all("SELECT body FROM activities WHERE lead_id = ? AND type = 'WhatsApp' AND direction = 'outbound' AND body LIKE '%has been resolved%'", [c.lead]);
    let out = await resolve(c.ticket);
    assert.equal(out.status, 200, `resolve: HTTP ${out.status} ${JSON.stringify(out.body).slice(0, 120)}`);
    const rows = surveys(c.ticket);
    assert.equal(rows.length, 1, `${rows.length} questions on resolving`);
    assert.equal(rows[0].status, 'Sent');
    assert.equal(rows[0].sent_to, c.number);
    assert.equal(rows[0].resolved_by, RESOLVER.id, 'not credited to whoever resolved it');
    assert.equal(one('SELECT resolved_by FROM tickets WHERE id = ?', [c.ticket]).resolved_by, RESOLVER.id, 'the case does not say who resolved it');
    assert.equal(asked().length, 1, 'the customer was not asked');
    assert.match(asked()[0].body, /your Bigul request/, `asked in the wrong name: ${asked()[0].body}`);
    assert.ok(!/Bonanza/.test(asked()[0].body), 'a Bigul customer was asked about a Bonanza request');
    out = await resolve(c.ticket, 'Closed');
    assert.equal(out.status, 200, `close: HTTP ${out.status}`);
    assert.equal(surveys(c.ticket).length, 1, 'closing a resolved case asked again');
    assert.equal(asked().length, 1, 'closing a resolved case sent the question again');
  });

  await test('only a reply that starts with a number from 1 to 5, and carries no other number, is a score', () => {
    const cases = { 5: 5, '4, good service': 4, '  3 ': 3, '1 - poor': 1, '5/5': null, 10: null, 0: null, 6: null, '3.5': null, thanks: null, '': null, 'I give it 5': null };
    for (const [text, want] of Object.entries(cases)) assert.equal(scoreOf(text), want, `"${text}" read as ${scoreOf(text)}`);
  });

  await test('the customer\'s reply is their score, recorded as a Survey interaction and credited to whoever resolved it', async () => {
    const c = openCase();
    await resolve(c.ticket);
    assert.equal(await reply(mobile(), '5'), null, 'a reply from a number that was not asked counted');
    const got = await reply(c.number, '4, good service');
    assert.equal(got?.score, 4, 'the reply was not taken as the score');
    assert.equal(scoreOn(c.ticket), 4, 'the case does not carry the score');
    const [row] = surveys(c.ticket);
    assert.equal(row.status, 'Answered');
    const interaction = one('SELECT type, lead_id, body FROM activities WHERE id = ?', [row.activity_id]);
    assert.equal(interaction?.type, 'Survey', 'no Survey interaction on the timeline');
    assert.equal(interaction.lead_id, c.lead);
    assert.equal(row.resolved_by, RESOLVER.id);
    assert.equal(await reply(c.number, '1'), null, 'a second reply changed the score');
    assert.equal(scoreOn(c.ticket), 4);
  });

  await test('an answer after 15 days does not count', async () => {
    const c = openCase();
    await resolve(c.ticket);
    run("UPDATE csat_surveys SET expires_at = datetime('now', '-1 minute') WHERE ticket_id = ?", [c.ticket]);
    assert.equal(await reply(c.number, '5'), null, 'a late answer counted');
    assert.equal(scoreOn(c.ticket), null);
  });

  await test('staff cannot set a score', async () => {
    const c = openCase();
    const set = await call(RESOLVER, 'POST', `/api/tickets/${c.ticket}/csat`, { score: 5 });
    assert.equal(set.status, 404, `the old route still answers: HTTP ${set.status}`);
    await call(RESOLVER, 'PATCH', `/api/tickets/${c.ticket}`, { csat: 5, priority: 'High' });
    assert.equal(scoreOn(c.ticket), null, 'an edit set the score');
  });

  await test('a score is voided only by someone holding csat.void, with a reason', async () => {
    const c = openCase();
    await resolve(c.ticket);
    await reply(c.number, '3');
    const care = await call(CARE, 'POST', `/api/tickets/${c.ticket}/csat/void`, { reason: 'Customer mistyped' });
    assert.equal(care.body?.required, 'csat.void', `Customer Care voided it: HTTP ${care.status}`);
    const bare = await call(RESOLVER, 'POST', `/api/tickets/${c.ticket}/csat/void`, { reason: 'no' });
    assert.equal(bare.status, 400, `voided without a reason: HTTP ${bare.status}`);
    const out = await call(RESOLVER, 'POST', `/api/tickets/${c.ticket}/csat/void`, { reason: 'Customer meant 5, said so on the call' });
    assert.equal(out.status, 200, `HTTP ${out.status} ${JSON.stringify(out.body).slice(0, 120)}`);
    assert.equal(scoreOn(c.ticket), null, 'the voided score still stands');
    assert.equal(surveys(c.ticket)[0].status, 'Voided');
    assert.ok(one("SELECT 1 v FROM audit_log WHERE action = 'csat_voided' AND entity_id = ?", [c.ticket]), 'not in the audit log');
  });

  await test('reopening a case voids its score, and resolving it again asks again', async () => {
    const c = openCase();
    await resolve(c.ticket);
    await reply(c.number, '5');
    const out = await call(RESOLVER, 'PATCH', `/api/tickets/${c.ticket}`, { status: 'Open', reason: 'Client says it happened again' });
    assert.equal(out.status, 200, `reopen: HTTP ${out.status} ${JSON.stringify(out.body).slice(0, 120)}`);
    assert.equal(scoreOn(c.ticket), null, 'the score stood after the case was reopened');
    assert.equal(surveys(c.ticket)[0].status, 'Voided');
    await resolve(c.ticket);
    const rows = surveys(c.ticket);
    assert.equal(rows.length, 2, 'resolving it again did not ask again');
    assert.equal(rows[1].status, 'Sent');
  });

  await test('a 1 or a 2 opens a call-back, the next working day, for the next level up from whoever resolved it', async () => {
    const c = openCase();
    await resolve(c.ticket);
    await reply(c.number, '2');
    const task = one("SELECT * FROM tasks WHERE ticket_id = ? AND title LIKE 'Call back%'", [c.ticket]);
    assert.ok(task, 'no call-back task');
    made.push(['tasks', task.id]);
    assert.equal(task.assignee_id, MANAGER.id, 'it did not go to the resolver\'s manager');
    assert.equal(task.priority, 'High');
    assert.ok(task.due_at > one("SELECT datetime('now') t").t, `due ${task.due_at}, not ahead`);
    assert.ok(one("SELECT 1 v FROM notifications WHERE user_id = ? AND title LIKE 'Low CSAT%'", [MANAGER.id]), 'the manager was not told');
    const four = openCase();
    await resolve(four.ticket);
    await reply(four.number, '4');
    assert.equal(one("SELECT COUNT(*) n FROM tasks WHERE ticket_id = ? AND title LIKE 'Call back%'", [four.ticket]).n, 0, 'a 4 opened a call-back');
  });

  await test('a partner rates their own case on the portal, once', async () => {
    const partner = make('partners', { name: 'CSAT probe partner', sales_org: 'BIGUL', state_code: 'ACTIVE' });
    const ticket = make('tickets', { ref: `BGL-P${stamp}`, subject: 'CSAT probe', description: 'Commission statement query; answered with the breakdown.', sales_org: 'BIGUL', status: 'Open', partner_id: partner, assignee_id: RESOLVER.id });
    const token = `csat-partner-${stamp}`;
    run("INSERT INTO sessions (token, partner_id, kind, expires_at, last_seen_at) VALUES (?,?,'partner',datetime('now','+1 hours'),datetime('now'))", [tokenKey(token), partner]);
    const PARTNER = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
    try {
      await resolve(ticket);
      const [row] = surveys(ticket);
      assert.equal(row?.channel, 'portal', 'a partner\'s case was not put to the partner');
      const dash = (await call(PARTNER, 'GET', '/api/portal/dashboard')).body;
      assert.ok(dash.tickets.find((t) => t.id === ticket)?.csat_open, 'the portal does not offer the rating');
      const rated = await call(PARTNER, 'POST', `/api/portal/tickets/${ticket}/csat`, { score: 5 });
      assert.equal(rated.status, 201, `HTTP ${rated.status} ${JSON.stringify(rated.body)}`);
      assert.equal(scoreOn(ticket), 5);
      const again = await call(PARTNER, 'POST', `/api/portal/tickets/${ticket}/csat`, { score: 1 });
      assert.equal(again.status, 409, `rated twice: HTTP ${again.status}`);
    } finally { run('DELETE FROM sessions WHERE token = ?', [tokenKey(token)]); }
  });

  await test('a score staff entered before the rule is kept as history, and not counted', () => {
    const ticket = make('tickets', { ref: `BGL-L${stamp}`, subject: 'CSAT probe', sales_org: 'BIGUL', status: 'Resolved', csat: 3 });
    settleLegacyCsat();
    assert.equal(scoreOn(ticket), null, 'a staff-entered score still counts');
    const [row] = surveys(ticket);
    assert.equal(row?.status, 'Legacy');
    assert.equal(row.score, 3, 'the history lost the score');
    settleLegacyCsat();
    assert.equal(surveys(ticket).length, 1, 'running it again recorded it twice');
  });

  await test('only the CSAT engine writes a case\'s score', () => {
    const files = (dir) => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
    });
    const writers = files(SRC)
      .filter((f) => /UPDATE\s+tickets\s+SET[^;]*\bcsat\s*=/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'))
      .filter((f) => !['engine/csat.js', 'db.js', 'seed.js'].includes(f));   // the engine; the legacy step; the demo
    assert.equal(writers.length, 0, `a case's score is written outside engine/csat.js: ${writers.join(', ')}`);
  });
} finally {
  run('UPDATE users SET manager_id = NULL WHERE id = ?', [RESOLVER.id]);
  for (const [table, id] of [...made].reverse()) {
    try {
      if (table === 'tickets') run('DELETE FROM csat_surveys WHERE ticket_id = ?', [id]);
      run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    } catch { /* removed with its parent */ }
  }
  for (const p of probes) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed${HOOK ? '' : ' (WhatsApp replies through the engine; run under scripts/webhook-secrets.mjs to drive the webhook)'}`);
if (failed) process.exit(1);
