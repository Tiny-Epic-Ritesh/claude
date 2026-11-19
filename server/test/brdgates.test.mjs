/**
 * A5: the BRD gate checks the auditor could not run (Round 4 report §1, the
 * gate table, and §5, the role ledger's "remaining acceptance work").
 *
 * Each section is one gate, run end to end through the API as the roles the
 * BRD names, with what it proves stated above it. The auditor's browser pass
 * could see that these flows existed; it could not time them, wait for them,
 * or read what they wrote.
 *
 *   A5a  P2  the Product RM hears of a Warm handoff within 60 seconds
 *   A5b  P3  DKYC step timers, abandonment, and a Product Supervisor's
 *            override written with a reason and audited
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};
const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const stamp = String(Date.now()).slice(-7);
const MARK = `BRD gate ${stamp}`;
const probes = [];
const leads = [];
const probe = async (slug, role, extra = {}) => {
  const p = await probeAdmin(`gate-${slug}`, { role, sales_org: 'BONANZA' });
  const sets = Object.keys(extra);
  if (sets.length) run(`UPDATE users SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(extra), p.id]);
  probes.push(p);
  return p;
};
const productId = (code) => one("SELECT id FROM product_types WHERE code = ? AND sales_org = 'BONANZA'", [code]).id;
const newLead = (owner, label) => {
  const id = Number(run(
    "INSERT INTO leads (sales_org, name, mobile, source, stage, owner_id) VALUES ('BONANZA', ?, ?, 'Website', 'Contacted', ?)",
    [`${MARK} ${label}`, `96${stamp}${leads.length}`.slice(0, 10), owner.id],
  ).lastInsertRowid);
  leads.push(id);
  return id;
};

console.log('\nA5: BRD gate checks the auditor could not run');

try {
  /* ================================================================ A5a
   * P2. A Sales RM hands a Warm product to its Product RM: within 60 seconds
   * the Product RM must know. The request does it all before it answers --
   * the bell, the High-priority task and the SMS are written inside it, not
   * left for a sweep -- and the bell reaches the Product RM's screen on the
   * inbox's next poll, every 30 seconds. The SMS is simulated until the SMS
   * gateway is connected (D4). */
  {
    const RM = await probe('rm', 'sales_rm');
    const PRM = await probe('prm', 'product_rm', { product_type_id: productId('MF'), phone: `95${stamp}9`.slice(0, 10) });
    const lead = newLead(RM, 'warm handoff');
    const card = Number(run(
      "INSERT INTO product_cards (lead_id, product_type_id, state, last_state_at) VALUES (?,?, 'WARM', datetime('now'))",
      [lead, productId('MF')],
    ).lastInsertRowid);

    let answeredIn = null;
    await test('A5a the handoff tells the Product RM before it answers, in under a second', async () => {
      const started = Date.now();
      const res = await as(RM)('POST', `/cards/${card}/request-product-rm`, {
        handover: { needs_to_know: `${MARK}: wants a SIP of 5,000 a month; call before Friday` },
      });
      answeredIn = Date.now() - started;
      assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
      assert.ok(res.body.product_rms.includes(`Probe gate-prm`), `the Product RM was not asked: ${res.body.product_rms}`);
      assert.ok(answeredIn < 1000, `the handoff took ${answeredIn} ms`);
    });

    await test('A5a the bell, the High-priority task and the SMS exist the moment it answers', async () => {
      const bell = one("SELECT * FROM notifications WHERE user_id = ? AND link = ? AND created_at >= datetime('now', '-60 seconds')", [PRM.id, `/leads/${lead}`]);
      assert.ok(bell, 'no notification for the Product RM within 60 seconds');
      const task = one("SELECT * FROM tasks WHERE assignee_id = ? AND card_id = ? AND priority = 'High' AND created_at >= datetime('now', '-60 seconds')", [PRM.id, card]);
      assert.ok(task, 'no High-priority task for the Product RM');
      const sms = one("SELECT * FROM integration_log WHERE kind = 'sms' AND summary LIKE ? AND at >= datetime('now', '-60 seconds')", [`%${MARK} warm handoff%`]);
      assert.ok(sms, 'no SMS to the Product RM');
      assert.equal(sms.simulated, 1, 'the SMS claims to be real; no gateway is connected (D4)');
    });

    await test('A5a the Product RM\'s own inbox carries it, and polls well inside 60 seconds', async () => {
      const mine = await as(PRM)('GET', '/notifications');
      assert.equal(mine.status, 200);
      assert.ok(mine.body.some((n) => n.link === `/leads/${lead}` && !n.read), 'the Product RM\'s inbox does not show it');
      const inbox = fs.readFileSync(path.join(CLIENT, 'crm/Inbox.jsx'), 'utf8');
      const poll = Number(inbox.match(/const POLL_MS = ([\d_]+);/)?.[1]?.replace(/_/g, ''));
      assert.ok(poll > 0 && poll + (answeredIn ?? 0) <= 60_000, `the inbox polls every ${poll} ms, so the bell can take longer than 60 seconds`);
    });
  }

  /* ================================================================ A5b
   * P3. Each DKYC step has its own timer. The sweep (every 30 seconds) marks
   * a journey Stalled once its step runs past the timer, and tells the card's
   * Product RM; an hour past it, Abandoned, and the lead's owner is told and
   * the "assisted completion" rule gives the Product RM a High-priority task.
   * An open High or Critical case on the card freezes the clock. A Product
   * Supervisor may override -- force a step complete -- only with a reason,
   * and the override is audited and moves the journey on as a finished step
   * would. Verification is Bonanza's own decision and is recorded, not forced. */
  {
    const ADMIN = await probe('admin', 'admin');
    const OWNER = await probe('owner', 'sales_rm');
    const PRM = await probe('kyc-prm', 'product_rm', { product_type_id: productId('EQD') });
    const PS = await probe('ps', 'product_supervisor');
    const lead = newLead(OWNER, 'kyc');
    const card = Number(run(
      "INSERT INTO product_cards (lead_id, product_type_id, state, last_state_at, product_rm_id) VALUES (?,?, 'PRODUCT_RM_ENGAGED', datetime('now'), ?)",
      [lead, productId('EQD'), PRM.id],
    ).lastInsertRowid);
    const started = await as(ADMIN)('POST', '/kyc/journeys', { lead_id: lead, card_id: card });
    const journey = started.body?.id;
    const read = async (who = ADMIN) => (await as(who)('GET', `/kyc/journeys/${journey}`)).body;
    const active = (j) => j.steps.find((st) => st.status === 'active' || st.status === 'stalled');
    /** Put the active step `seconds` past its own timer. */
    const pastTimer = async (seconds) => {
      const j = await read();
      const st = active(j);
      run("UPDATE kyc_journey_progress SET entered_at = datetime('now', ?) WHERE journey_id = ? AND step_code = ?",
        [`-${(st.timer_s || st.timer) + seconds} seconds`, journey, st.code]);
      return st;
    };
    const sweep = () => as(PRM)('POST', '/kyc/sweep');

    await test('A5b a journey starts on its first step, with that step\'s own timer', async () => {
      assert.equal(started.status, 201, `HTTP ${started.status}: ${started.body?.error}`);
      const j = await read();
      const first = active(j);
      assert.ok(first && (first.timer_s || first.timer) > 0, 'the first step has no timer');
      assert.equal(j.status, 'In Progress');
    });

    await test('A5b an open High case on the card freezes the timer', async () => {
      await pastTimer(60);
      const ticket = Number(run(
        "INSERT INTO tickets (ref, subject, sales_org, status, priority, lead_id, card_id) VALUES (?, ?, 'BONANZA', 'Open', 'High', ?, ?)",
        [`BNZ-GT${stamp}`, `${MARK} blocking case`, lead, card],
      ).lastInsertRowid);
      await sweep();
      assert.equal((await read()).status, 'In Progress', 'the journey stalled while a High case was open on its card');
      run("UPDATE tickets SET status = 'Resolved', resolved_at = datetime('now') WHERE id = ?", [ticket]);
    });

    await test('A5b past its timer the journey stalls, and its Product RM is told', async () => {
      const st = await pastTimer(60);
      await sweep();
      const j = await read();
      assert.equal(j.status, 'Stalled', `the journey is ${j.status}`);
      assert.equal(j.steps.find((x) => x.code === st.code).status, 'stalled');
      assert.ok(one("SELECT id FROM notifications WHERE user_id = ? AND title = 'KYC stalled'", [PRM.id]), 'the Product RM was not told');
      assert.ok(one("SELECT id FROM audit_log WHERE action = 'kyc_stalled' AND entity_id = ?", [journey]), 'the stall is not audited');
    });

    await test('A5b an hour past it the journey is abandoned, the owner told, and the Product RM given the assisted completion', async () => {
      await pastTimer(3600 + 60);
      await sweep();
      const j = await read();
      assert.equal(j.status, 'Abandoned', `the journey is ${j.status}`);
      assert.ok(j.abandoned_at, 'no abandonment time');
      assert.ok(one("SELECT id FROM notifications WHERE user_id = ? AND title = 'KYC abandoned'", [OWNER.id]), 'the lead\'s owner was not told');
      assert.ok(one("SELECT id FROM audit_log WHERE action = 'kyc_abandoned' AND entity_id = ?", [journey]), 'the abandonment is not audited');
      const { runRule } = await import('../src/engine/rules.js');
      const rule = one("SELECT id FROM rules WHERE name = 'KYC abandoned → assisted completion'");
      assert.ok(rule, 'the assisted-completion rule is missing');
      runRule(rule.id, { leadIds: [lead] });
      assert.ok(one("SELECT id FROM tasks WHERE lead_id = ? AND assignee_id = ? AND priority = 'High' AND title LIKE 'Assisted KYC completion%'", [lead, PRM.id]),
        'the Product RM got no assisted-completion task');
    });

    await test('A5b an abandoned application is taken over before it is overridden', async () => {
      const step = active(await read()).code;
      const refused = await as(PS)('POST', `/kyc/journeys/${journey}/override`, { step_code: step, action: 'complete', reason: `${MARK}: applicant asked us to finish` });
      assert.equal(refused.status, 409, `an abandoned application was overridden (HTTP ${refused.status})`);
      const taken = await as(PRM)('POST', `/kyc/journeys/${journey}/assist`);
      assert.equal(taken.status, 200, `HTTP ${taken.status}: ${taken.body?.error}`);
      assert.equal((await read()).status, 'In Progress');
    });

    await test('A5b an override needs the override permission, a step of this application, and a reason', async () => {
      const step = active(await read()).code;
      assert.equal((await as(PRM)('POST', `/kyc/journeys/${journey}/override`, { step_code: step, action: 'complete', reason: `${MARK}: x`.padEnd(20, 'x') })).status, 403,
        'a Product RM overrode a step');
      const noReason = await as(PS)('POST', `/kyc/journeys/${journey}/override`, { step_code: step, action: 'complete' });
      assert.equal(noReason.status, 400, `an override with no reason was accepted (HTTP ${noReason.status})`);
      const unknown = await as(PS)('POST', `/kyc/journeys/${journey}/override`, { step_code: 'NOT_A_STEP', action: 'complete', reason: `${MARK}: no such step here` });
      assert.equal(unknown.status, 400, `an override of a step that does not exist was accepted (HTTP ${unknown.status})`);
      assert.equal(active(await read()).code, step, 'a refused override changed the journey');
    });

    await test('A5b a forced step is finished like any other: the next step starts, with its own timer', async () => {
      const before = await read();
      const step = active(before).code;
      const res = await as(PS)('POST', `/kyc/journeys/${journey}/override`, { step_code: step, action: 'complete', reason: `${MARK}: OTP verified on a recorded call` });
      assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
      const after = await read();
      assert.equal(after.steps.find((x) => x.code === step).status, 'done', 'the step is not done');
      const next = active(after);
      assert.ok(next && next.code !== step, 'no next step was started');
      assert.equal(after.current_step, next.code, `the journey still points at ${after.current_step}`);
      assert.ok(next.entered_at, 'the next step has no start time, so its timer never runs');
      assert.equal(after.status, 'In Progress');
    });

    await test('A5b the override is written with its reason, audited, and shown on the journey', async () => {
      const row = one("SELECT * FROM audit_log WHERE action = 'kyc_override' AND entity_id = ? ORDER BY id DESC LIMIT 1", [journey]);
      assert.ok(row, 'the override is not audited');
      assert.equal(row.user_id, PS.id);
      assert.match(row.detail, /OTP verified on a recorded call/, `the audit does not carry the reason: ${row.detail}`);
      const shown = (await read(PS)).overrides ?? [];
      assert.ok(shown.some((o) => /OTP verified on a recorded call/.test(o.reason)), 'the journey does not show the override and its reason');
    });

    await test('A5b the KYC console asks for the reason before it overrides (source check)', async () => {
      const screen = fs.readFileSync(path.join(CLIENT, 'crm/KycConsole.jsx'), 'utf8');
      assert.match(screen, /override`, \{ step_code: forcing\.code, action: 'complete', reason: reason\.trim\(\) \}/, 'the console overrides without a reason');
      assert.match(screen, /reason\.trim\(\)\.length < 10/, 'the console lets an override go without a reason');
      assert.match(screen, /full\.overrides/, 'the console does not show the overrides');
    });

    await test('A5b Bonanza\'s verification is recorded, never forced', async () => {
      const res = await as(PS)('POST', `/kyc/journeys/${journey}/override`, { step_code: 'VERIFICATION', action: 'complete', reason: `${MARK}: trying to skip verification` });
      assert.equal(res.status, 409, `verification was forced complete (HTTP ${res.status})`);
    });
  }
} finally {
  for (const id of leads) {
    run('DELETE FROM notifications WHERE link = ?', [`/leads/${id}`]);
    for (const c of all('SELECT id FROM product_cards WHERE lead_id = ?', [id])) {
      run("DELETE FROM field_history WHERE entity = 'product_interest' AND record_id = ?", [c.id]);
      run('DELETE FROM product_rm_requests WHERE card_id = ?', [c.id]);
    }
    for (const j of all('SELECT id FROM kyc_journeys WHERE lead_id = ?', [id])) {
      run("DELETE FROM audit_log WHERE entity = 'kyc_journey' AND entity_id = ?", [j.id]);
    }
    run('DELETE FROM tickets WHERE lead_id = ?', [id]);
    run('DELETE FROM leads WHERE id = ?', [id]);
  }
  run("DELETE FROM integration_log WHERE summary LIKE ?", [`%${MARK}%`]);
  for (const p of probes) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
