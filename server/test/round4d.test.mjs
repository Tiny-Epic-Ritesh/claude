/**
 * Round 4 -- QA-29 and QA-42, the two findings the code alone did not explain.
 * Both were watched in a browser on 13 Oct.
 *
 *   QA-29  A static list stayed empty after a successful import, until reload.
 *          Reproduced: Done reloaded the list, but the dialog's Close, Escape
 *          and a click outside did not. The server was right throughout, and
 *          the values that did not match were gone once the dialog shut.
 *
 *   QA-42  A Dealer's engagement "produced no visible result". Start engaging
 *          opened the panel and Mark as Exploring worked; the result came from
 *          the panel's other moves, offered whether or not the role may make
 *          them. Lost answered 403 and the refusal went to the lead page behind
 *          the panel, so nothing changed and nothing was said. A move that
 *          worked closed the panel without a word, too.
 *
 * The client halves are source checks, as in round4b: the suite has no browser.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { can } from '../src/auth.js';
import { MOVE_NEEDS } from '../src/engine/nextaction.js';
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

console.log('\nRound 4 — QA-29 and QA-42, watched in a browser');

const RUN = String(Date.now()).slice(-6);
const MARK = `R4D probe ${RUN}`;
const MOBILE = `98${RUN}11`;
/* Indian mobiles start 6 to 9, so a number starting 5 is a miss whatever the
   seed holds. */
const NOWHERE = `55${RUN}00`;

const sweep = () => {
  run("DELETE FROM lead_lists WHERE name LIKE 'R4D probe %'");
  run("DELETE FROM leads WHERE name LIKE 'R4D probe %'");
};
sweep();

const RM = await probeAdmin('round4d-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const DEALER = await probeAdmin('round4d-dealer', { role: 'dealer', sales_org: 'BONANZA' });

const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const member = Number(run(
  "INSERT INTO leads (sales_org, name, source, stage, mobile, owner_id) VALUES ('BONANZA', ?, 'Website', 'New', ?, ?)",
  [`${MARK} member`, MOBILE, RM.id],
).lastInsertRowid);

const dealerLead = Number(run(
  "INSERT INTO leads (sales_org, name, source, stage, owner_id) VALUES ('BONANZA', ?, 'Website', 'New', ?)",
  [`${MARK} dealer`, DEALER.id],
).lastInsertRowid);
const product = one("SELECT id, name FROM product_types WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1");
run("INSERT OR IGNORE INTO product_cards (lead_id, product_type_id, state) VALUES (?, ?, 'INACTIVE')", [dealerLead, product.id]);
const card = one('SELECT id FROM product_cards WHERE lead_id = ? AND product_type_id = ?', [dealerLead, product.id]);

try {
  /* ============================================================ QA-29 */

  await test('QA-29 the server counts an import at once -- the list it reloads from is right', async () => {
    const expires = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const made = await as(RM)('POST', '/lists', { name: `${MARK} list`, kind: 'static', snapshot_reason: 'QA-29 probe', expires_at: expires });
    assert.equal(made.status, 201, `the list was not made: ${made.body?.error}`);
    assert.equal(made.body.member_count, 0);

    const imported = await as(RM)('POST', `/lists/${made.body.id}/import`, { match_on: 'mobile', values: `${MOBILE}\n${NOWHERE}` });
    assert.equal(imported.status, 200, `import answered ${imported.status}: ${imported.body?.error}`);
    assert.equal(imported.body.added, 1);
    assert.deepEqual(imported.body.missed, [NOWHERE], 'the miss did not come back as its value');

    const list = await as(RM)('GET', `/lists/${made.body.id}`);
    assert.equal(list.body.member_count, 1, 'the list does not count the lead it was just given');
    assert(list.body.members.some((m) => m.id === member), 'the lead is not among the members');
  });

  await test('QA-29 every way out of the import dialog reloads the list (source check)', async () => {
    const page = source('crm/ListDetail.jsx');
    const dialog = page.slice(page.indexOf('function ImportDialog'));
    assert(/const close = result \? finish : onClose;/.test(dialog), 'closing after an import does not go the way Done goes');
    assert(/<Modal title="Import"[^\n]*onClose=\{close\}>/.test(dialog), 'the dialog\'s Close, Escape and outside click skip the reload');
    assert(/onClick=\{finish\}/.test(dialog), 'Done no longer finishes the import');
    assert(/tool === 'import'[\s\S]{0,200}onDone=\{\(msg\) => \{ setTool\(null\); setDone\(msg\); reload\(\); \}\}/.test(page),
      'finishing an import does not reload the list');
  });

  await test('QA-29 what did not match is still there after the dialog shuts (source check)', async () => {
    const page = source('crm/ListDetail.jsx');
    assert(/missed: result\.missed,/.test(page), 'the misses are not handed to the list page');
    assert(/done\?\.missed\?\.length > 0 && \(\s*<details/.test(page), 'the list page does not offer the misses');
    assert(/value=\{done\.missed\.join\('\\n'\)\}/.test(page), 'the misses are not given back as values');
  });

  /* ============================================================ QA-42 */

  await test('QA-42 the panel offers a Dealer only the moves the route accepts', async () => {
    const detail = await as(DEALER)('GET', `/cards/${card.id}/detail`);
    assert.equal(detail.status, 200, `the Dealer cannot open the card (${detail.status})`);
    const { next } = detail.body;
    assert.equal(next.primary.to, 'EXPLORING');
    assert.equal(next.primary.allowed, true, 'Mark as Exploring is not offered to a Dealer');
    assert(next.alternatives.length, 'no alternatives, so this proves nothing');
    for (const a of next.alternatives) {
      assert.equal(a.allowed, can('dealer', MOVE_NEEDS[a.to]), `the panel says ${a.to} is ${a.allowed ? '' : 'not '}the Dealer's to make`);
      if (!a.allowed) assert(a.blocked_reason, `${a.to} is disabled without a reason`);
    }
    assert(next.alternatives.some((a) => !a.allowed), 'every move was allowed, so the refusal path is untested');
  });

  await test('QA-42 a move the panel disables is refused, and says why', async () => {
    const refused = await as(DEALER)('POST', `/cards/${card.id}/state`, { state: 'LOST', lost_reason: 'probe' });
    assert.equal(refused.status, 403);
    assert(/cannot/i.test(refused.body.error), `the refusal does not explain itself: ${refused.body.error}`);
    assert.equal(one('SELECT state FROM product_cards WHERE id = ?', [card.id]).state, 'INACTIVE');
  });

  await test('QA-42 Mark as Exploring moves the card, and the move is on record', async () => {
    const moved = await as(DEALER)('POST', `/cards/${card.id}/state`, { state: 'EXPLORING' });
    assert.equal(moved.status, 200, `the move answered ${moved.status}: ${moved.body?.error}`);
    assert.equal(moved.body.to, 'EXPLORING');
    assert.equal(one('SELECT state FROM product_cards WHERE id = ?', [card.id]).state, 'EXPLORING', 'the card did not move');
    const trail = all('SELECT from_state, to_state, user_id FROM card_audit WHERE card_id = ?', [card.id]);
    assert(trail.some((t) => t.from_state === 'INACTIVE' && t.to_state === 'EXPLORING' && t.user_id === DEALER.id),
      'the move is not in the card\'s history');
  });

  await test('QA-42 the panel says what happened, in the panel (source check)', async () => {
    const panel = source('crm/ProductPanel.jsx');
    assert(/catch \(e\) \{ setFailed\(e\.message\); setBusy\(false\); \}/.test(panel), 'a refusal is not kept in the panel');
    assert(/<ErrorBanner error=\{failed\}/.test(panel), 'the panel does not show its own refusal');
    assert(!/onError/.test(panel), 'the panel still hands its errors to the page behind it');
    assert(/disabled=\{busy \|\| a\.allowed === false\}/.test(panel), 'a move the role cannot make is still offered');
    assert(/return `\$\{d\.product_name\} is now \$\{STATE_LABEL\[r\.to\] \?\? r\.to\}\.`;/.test(panel), 'a move that worked says nothing');
  });
} finally {
  sweep();
  for (const p of [RM, DEALER]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
