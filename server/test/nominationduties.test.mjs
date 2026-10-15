/**
 * The firm's nomination obligations, SEBI's circular of 29 May 2026 --
 * Ritesh, 15 Oct: build them in the CRM.
 *
 *   9.3   every nomination, change and opt-out acknowledged to the investor,
 *         by SMS and email, with a reference -- made in an application or
 *         recorded from a form in the CRM;
 *   10.1  what the holding statement prints: the names, or only whether a
 *         nomination was made, as the investor chose -- for the back office
 *         that prints it;
 *   10.2  accounts without a nomination, opt-outs included, reminded twice a
 *         year by SMS and email and asked on the first log-in of the day --
 *         the trading platform asks the CRM, with a scoped API key; never an
 *         account that has a nomination.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { convertLead } from '../src/engine/clients.js';
import { sweepNominationNudges, halfYear } from '../src/engine/nominations.js';
import { issue, revoke } from '../src/engine/apikeys.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');
const source = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nNomination obligations — SEBI, May 2026');

const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-6);
const MARK = `ND probe ${RUN}`;

const ADMIN = await probeAdmin('nd-admin', { role: 'admin', sales_org: 'BONANZA' });
const RM = await probeAdmin('nd-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('nd-bigul', { role: 'admin', sales_org: 'BIGUL' });
const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let seq = 0;
const made = { clients: [], leads: [], keys: [] };
const makeClient = (extra = {}) => {
  seq += 1;
  const id = Number(run(
    `INSERT INTO clients (client_code, name, mobile, email, sales_org, owner_id, nominee_name, status)
     VALUES (?, ?, ?, ?, 'BONANZA', ?, ?, 'Active')`,
    [`ND${DIGITS}${seq}`, `${MARK} client ${seq}`, `98${DIGITS}${String(seq).padStart(2, '0')}`, `nd${seq}-${RUN}@example.test`,
      RM.id, extra.nominee_name ?? null],
  ).lastInsertRowid);
  made.clients.push(id);
  return id;
};
const nominee = (i, extra = {}) => ({ name: `Probe Nominee ${i}`, relationship: 'Son', mobile: `97${DIGITS}${i}0`.slice(0, 10), ...extra });
const current = (clientId) => one('SELECT * FROM nominations WHERE client_id = ? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1', [clientId]);

const product = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 AND requires_kyc = 1 ORDER BY sort_order, id LIMIT 1");
const dkyc = async (url, body) => {
  const res = await fetch(`${BASE}/dkyc-api${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  /* --------------------------------------------------------------- 9.3 */

  let token;
  let journeyId;
  await test('a nomination made in the application is acknowledged by SMS and email, and a change is acknowledged again', async () => {
    const started = await dkyc('/start', { product_type_id: product.id });
    token = started.body.resume_token;
    journeyId = one('SELECT id FROM kyc_journeys WHERE resume_token = ?', [token]).id;
    run("UPDATE kyc_journeys SET current_step = 'NOMINEE', applicant_mobile = ?, applicant_email = ? WHERE id = ?",
      [`96${DIGITS}11`, `applicant-${RUN}@example.test`, journeyId]);
    const res = await dkyc(`/resume/${token}/step`, {
      step_code: 'NOMINEE', payload: { nominee_opt: 'Add nominee', nominee_statement: 'The names of my nominees', nominees: [nominee(1), nominee(2)] },
    });
    assert.equal(res.status, 200, `the step answered ${res.status}: ${res.body?.error}`);
    assert.match(res.body.nomination_ack, /^NOM-B-\d{6}$/, `no reference came back: ${res.body.nomination_ack}`);
    const first = one('SELECT * FROM nominations WHERE journey_id = ? AND superseded_at IS NULL', [journeyId]);
    assert.equal(first.kind, 'nominated');
    assert.equal(first.nominee_count, 2);
    assert.equal(first.ack_channels, 'sms,email', 'the acknowledgement did not go by both');
    assert(!String(first.nominees).includes('Probe Nominee'), 'nominee details are stored in the clear');

    run("UPDATE kyc_journeys SET current_step = 'NOMINEE' WHERE id = ?", [journeyId]);
    const changed = await dkyc(`/resume/${token}/step`, { step_code: 'NOMINEE', payload: { nominee_opt: 'Opt out', optout_declaration: true } });
    assert.equal(changed.status, 200, changed.body?.error);
    assert.notEqual(changed.body.nomination_ack, res.body.nomination_ack, 'a change was not acknowledged afresh');
    assert(one('SELECT superseded_at FROM nominations WHERE id = ?', [first.id]).superseded_at, 'the first nomination was not superseded');
    assert.equal(one('SELECT kind FROM nominations WHERE journey_id = ? AND superseded_at IS NULL', [journeyId]).kind, 'opted_out');
  });

  await test('when the account opens, the application\'s nomination becomes the account\'s, acknowledged once', async () => {
    run("UPDATE kyc_journeys SET current_step = 'NOMINEE' WHERE id = ?", [journeyId]);
    const again = await dkyc(`/resume/${token}/step`, {
      step_code: 'NOMINEE', payload: { nominee_opt: 'Add nominee', nominee_statement: 'Only whether I have made a nomination', nominees: [nominee(3)] },
    });
    const lead = Number(run("INSERT INTO leads (sales_org, name, source, stage, owner_id) VALUES ('BONANZA', ?, 'Website', 'New', ?)",
      [`${MARK} lead`, RM.id]).lastInsertRowid);
    made.leads.push(lead);
    run('UPDATE kyc_journeys SET lead_id = ? WHERE id = ?', [lead, journeyId]);
    const opened = convertLead(lead, { clientCode: `NDC${DIGITS}` });
    assert(opened.ok && opened.created, JSON.stringify(opened));
    made.clients.push(opened.client.id);
    const carried = current(opened.client.id);
    assert(carried, 'the account has no nomination');
    assert.equal(carried.ack_ref, again.body.nomination_ack, 'the account\'s nomination is not the one the application acknowledged');
    assert.equal(one('SELECT nominee_name FROM clients WHERE id = ?', [opened.client.id]).nominee_name, 'Probe Nominee 3');
  });

  await test('staff record a change received on a form; it is checked, acknowledged, and the old one stays in the history', async () => {
    const c = makeClient();
    assert.equal((await as(ADMIN)('POST', `/clients/${c}/nominations`, { kind: 'nominated', mode: 'physical', evidence: 'Annexure-A at Pune branch', statement_shows: 'names',
      nominees: [nominee(1), nominee(2), nominee(3), nominee(4)] })).status, 400, 'four nominees were taken');
    assert.equal((await as(ADMIN)('POST', `/clients/${c}/nominations`, { kind: 'nominated', mode: 'physical', evidence: '', statement_shows: 'names',
      nominees: [nominee(1)] })).status, 400, 'recorded with nothing said about what was received');
    assert.equal((await as(ADMIN)('POST', `/clients/${c}/nominations`, { kind: 'nominated', mode: 'physical', evidence: 'Annexure-A at Pune branch', statement_shows: 'names',
      nominees: [nominee(1, { relationship: '' })] })).status, 400, 'a nominee with no relationship was taken');
    assert.equal((await as(ADMIN)('POST', `/clients/${c}/nominations`, { kind: 'opted_out', mode: 'physical', evidence: 'Annexure-B at Pune branch' })).status, 400,
      'an opt-out was taken without its declaration');

    const res = await as(ADMIN)('POST', `/clients/${c}/nominations`, {
      kind: 'nominated', mode: 'physical', evidence: 'Annexure-A received at Pune branch, 14 Oct', statement_shows: 'names', nominees: [nominee(1), nominee(2)],
    });
    assert.equal(res.status, 201, `record answered ${res.status}: ${res.body?.error}`);
    assert.match(res.body.ack_ref, /^NOM-B-\d{6}$/);
    assert.deepEqual(res.body.ack_channels, ['sms', 'email']);
    const out = await as(ADMIN)('POST', `/clients/${c}/nominations`, {
      kind: 'opted_out', mode: 'online', evidence: 'Request through the app, OTP-verified', declaration: true,
    });
    assert.equal(out.status, 201, out.body?.error);
    const history = all('SELECT kind, superseded_at FROM nominations WHERE client_id = ? ORDER BY id', [c]);
    assert.deepEqual(history.map((h) => [h.kind, Boolean(h.superseded_at)]), [['nominated', true], ['opted_out', false]]);
    assert.equal(one('SELECT nominee_name FROM clients WHERE id = ?', [c]).nominee_name, null);
    assert.equal((await as(BIGUL)('POST', `/clients/${c}/nominations`, { kind: 'opted_out', mode: 'online', evidence: 'Across the book', declaration: true })).status, 404);
  });

  await test('the nominee field is no longer typed over, and a nominee\'s contacts are masked like the client\'s', async () => {
    const c = makeClient();
    await as(ADMIN)('POST', `/clients/${c}/nominations`, {
      kind: 'nominated', mode: 'physical', evidence: 'Annexure-A at the head office', statement_shows: 'yes_no', nominees: [nominee(5)],
    });
    await as(ADMIN)('PATCH', `/clients/${c}`, { nominee_name: 'Typed over', risk_profile: 'Moderate' });
    assert.equal(one('SELECT nominee_name FROM clients WHERE id = ?', [c]).nominee_name, 'Probe Nominee 5', 'the nominee was typed over');
    const seen = (await as(RM)('GET', `/clients/${c}`)).body.nomination;
    assert.equal(seen.nominees[0].name, 'Probe Nominee 5');
    assert.notEqual(seen.nominees[0].mobile, nominee(5).mobile, 'a nominee\'s mobile reached a masked role in the clear');
  });

  /* -------------------------------------------------------------- 10.1 */

  await test('the statement prints the names, or only whether there is a nomination, as chosen', async () => {
    const names = makeClient();
    await as(ADMIN)('POST', `/clients/${names}/nominations`, { kind: 'nominated', mode: 'online', evidence: 'App request, OTP-verified', statement_shows: 'names', nominees: [nominee(1), nominee(2)] });
    const yesNo = makeClient();
    await as(ADMIN)('POST', `/clients/${yesNo}/nominations`, { kind: 'nominated', mode: 'online', evidence: 'App request, OTP-verified', statement_shows: 'yes_no', nominees: [nominee(1)] });
    const optedOut = makeClient();
    await as(ADMIN)('POST', `/clients/${optedOut}/nominations`, { kind: 'opted_out', mode: 'online', evidence: 'App request, OTP-verified', declaration: true });
    const legacy = makeClient({ nominee_name: 'Migrated Nominee' });
    const none = makeClient();
    const expect = {
      [names]: 'Nominees: Probe Nominee 1, Probe Nominee 2', [yesNo]: 'Nomination: Yes', [optedOut]: 'Nomination: No',
      [legacy]: 'Nomination: Yes', [none]: 'Nomination: No',
    };
    for (const [id, line] of Object.entries(expect)) {
      const detail = (await as(ADMIN)('GET', `/clients/${id}`)).body;
      assert.equal(detail.nomination.statement_line, line, `client ${id} on screen`);
      assert.equal(detail.nomination_statement, line, `client ${id} as the list and export read it`);
    }
    const exported = await fetch(`${BASE}/api/clients/export`, {
      method: 'POST', headers: ADMIN.headers, body: JSON.stringify({ columns: ['client_code', 'nomination_statement'] }),
    }).then((r) => r.text());
    assert(exported.includes('Nomination (statement)') && exported.includes('Nominees: Probe Nominee 1, Probe Nominee 2'), 'the export does not carry the statement line');
  });

  /* -------------------------------------------------------------- 10.2 */

  await test('twice a year, every account without a nomination is reminded -- opt-outs included -- and no other', async () => {
    const none = makeClient();
    const optedOut = makeClient();
    await as(ADMIN)('POST', `/clients/${optedOut}/nominations`, { kind: 'opted_out', mode: 'online', evidence: 'App request, OTP-verified', declaration: true });
    const nominated = makeClient();
    await as(ADMIN)('POST', `/clients/${nominated}/nominations`, { kind: 'nominated', mode: 'online', evidence: 'App request, OTP-verified', statement_shows: 'yes_no', nominees: [nominee(1)] });
    const legacy = makeClient({ nominee_name: 'Migrated Nominee' });
    const activitiesBefore = one('SELECT COUNT(*) n FROM activities').n;

    const july = new Date('2026-07-15T06:00:00Z');
    sweepNominationNudges({ now: july, limit: 100000 });
    const sent = (id) => all('SELECT period, channels FROM nomination_nudges WHERE client_id = ?', [id]);
    assert.deepEqual(sent(none).map((s) => s.period), ['2026-H2']);
    assert.equal(sent(none)[0].channels, 'sms,email');
    assert.equal(sent(optedOut).length, 1, 'an opt-out was not reminded');
    assert.equal(sent(nominated).length, 0, 'an account with a nomination was reminded');
    assert.equal(sent(legacy).length, 0, 'a migrated nomination was treated as none');

    sweepNominationNudges({ now: new Date('2026-11-02T06:00:00Z'), limit: 100000 });
    assert.equal(sent(none).length, 1, 'reminded twice in one half-year');
    sweepNominationNudges({ now: new Date('2027-01-10T06:00:00Z'), limit: 100000 });
    assert.deepEqual(sent(none).map((s) => s.period).sort(), ['2026-H2', '2027-H1']);
    assert.equal(halfYear(new Date('2026-06-30T20:00:00Z')), '2026-H2', 'the half-year is not counted in India');
    assert.equal(one('SELECT COUNT(*) n FROM activities').n, activitiesBefore, 'a reminder was counted as contact on a timeline');
  });

  await test('the trading platform asks on each log-in; the pop-up is shown once a day, only without a nomination', async () => {
    const none = makeClient();
    const nominated = makeClient({ nominee_name: 'Migrated Nominee' });
    const code = (id) => one('SELECT client_code FROM clients WHERE id = ?', [id]).client_code;
    const key = issue({ label: `${MARK} platform`, userId: ADMIN.id, scopes: ['client.nomination.prompt'] });
    made.keys.push(key.key_id);
    const ask = (id, business = 'BONANZA', k = key) => fetch(`${BASE}/api/clients/nomination-prompt?client_code=${code(id)}&business=${business}`, {
      headers: { 'x-api-key': k.key_id, 'x-api-secret': k.secret },
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    const first = await ask(none);
    assert.equal(first.status, 200, `the platform was refused: ${first.status} ${first.body?.error}`);
    assert.equal(first.body.show, true);
    assert.match(first.body.message, /nominee/i);
    assert.equal((await ask(none)).body.show, false, 'the pop-up showed twice in one day');
    assert.equal((await ask(nominated)).body.show, false, 'an account with a nomination was shown the pop-up');
    assert.equal((await ask(none, 'BIGUL')).status, 404, 'the other business answered');

    const wrong = issue({ label: `${MARK} wrong`, userId: ADMIN.id, scopes: ['client.view.all'] });
    made.keys.push(wrong.key_id);
    assert.equal((await ask(none, 'BONANZA', wrong)).status, 403, 'a key without the scope was answered');
  });

  await test('the screens show it: the nomination card and the applicant\'s reference (source check)', async () => {
    const card = source('crm/Nomination.jsx');
    assert(/statement_line/.test(card) && /\/nominations`/.test(card) && /Annexure-B/.test(card));
    assert(/NominationCard/.test(source('crm/ClientDetail.jsx')));
    assert(/nomination_ack/.test(source('dkyc/DkycPortal.jsx')));
  });
} finally {
  for (const id of made.keys) { try { revoke(id); } catch { /* gone */ } }
  run('DELETE FROM api_credential WHERE label LIKE ?', [`${MARK}%`]);
  run('DELETE FROM kyc_journeys WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE ?)', [`${MARK}%`]);
  run("DELETE FROM kyc_journeys WHERE applicant_email LIKE ?", [`applicant-${RUN}%`]);
  for (const id of made.clients) run('DELETE FROM clients WHERE id = ?', [id]);
  run('DELETE FROM clients WHERE name LIKE ?', [`${MARK}%`]);
  for (const id of made.leads) { run('DELETE FROM activities WHERE lead_id = ?', [id]); run('DELETE FROM leads WHERE id = ?', [id]); }
  for (const p of [ADMIN, RM, BIGUL]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
