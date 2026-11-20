/**
 * A19 (B25, ruled 20 Nov 2026): reopening a case, in the browser, as the
 * Customer Care agent who resolved it.
 *
 *   before    the Reopen dialog says the fresh deadlines the case would get,
 *             and that a breach in its first round stays on its record
 *   after     the reopen says the new deadlines, the case shows them, and it
 *             says which round it is in and the breach that stays
 *
 * Needs the client built (the server serves client/dist) and Playwright:
 *
 *   (cd client && npx vite build) && node test/ui/reopen.ui.mjs
 *
 * SHOTS=<dir> saves screenshots of the dialog and the reopened case there.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { one, run } from '../../src/db.js';
import { probeAdmin } from '../helpers/probeadmin.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const APP = `${BASE}/ai-crm`;
const SHOTS = process.env.SHOTS || null;

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${String(err.message).split('\n')[0]}`); }
};

const stamp = String(Date.now()).slice(-7);
const MARK = `Reopen UI ${stamp}`;
const CARE = await probeAdmin('reopen-ui-care', { role: 'customer_care', sales_org: 'BONANZA' });
const at = (modifier) => one("SELECT datetime('now', ?) t", [modifier]).t;

// Raised three days ago; breached in its first round; resolved since.
const ticket = Number(run(
  `INSERT INTO tickets (ref, subject, description, sales_org, status, priority, assignee_id, response_due, resolution_due,
     resolved_at, resolved_by, breached, breached_at, created_at, updated_at)
   VALUES (?, ?, 'The refund for the cancelled SIP has not arrived.', 'BONANZA', 'Resolved', 'Medium', ?, ?, ?, ?, ?, 1, ?, ?, datetime('now'))`,
  [`BNZ-RU${stamp}`, MARK, CARE.id, at('-2 days'), at('-1 days'), at('-2 hours'), CARE.id, at('-1 days'), at('-3 days')],
).lastInsertRowid);

const browser = await chromium.launch();
console.log('\nA19: reopening a case, in the browser (B25)');

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce', deviceScaleFactor: SHOTS ? 2 : 1 });
  await ctx.addInitScript((token) => localStorage.setItem('bnz_crm_token', token), CARE.token);
  const page = await ctx.newPage();
  await page.goto(`${APP}/tickets/${ticket}`);
  await page.getByText(MARK).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Not yet')?.click());

  const dialog = page.getByRole('dialog');

  await test('the Reopen dialog says the fresh deadlines, and that the first-round breach stays', async () => {
    await page.getByRole('button', { name: 'Reopen', exact: true }).click();
    await dialog.getByText(/It gets new deadlines under Medium, counted from when it is reopened/).waitFor({ timeout: 10000 });
    await dialog.getByText(/Its breach in round 1 \(.*\) stays on its record/).waitFor({ timeout: 5000 });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'B25-reopen-dialog.png') });
  });

  await test('reopening says the new deadlines it set', async () => {
    await dialog.getByLabel('Why').fill(`${MARK}: the client says the refund has still not arrived`);
    await dialog.getByRole('button', { name: 'Reopen', exact: true }).click();
    const toast = page.locator('.outcome-toast').filter({ hasText: 'reopened' });
    await toast.getByText(/New deadlines under Medium, counted from the reopening: a first response by .* and a resolution by/).waitFor({ timeout: 10000 });
  });

  await test('the case shows its new deadline, its round, and the breach that stays on its record', async () => {
    const t = one('SELECT resolution_due, sla_started_at, sla_round FROM tickets WHERE id = ?', [ticket]);
    assert.equal(t.sla_round, 2);
    const note = page.locator('.sla-round');
    await note.getByText(/Round 2: reopened .*, and its deadlines count from then\./).waitFor({ timeout: 10000 });
    await note.getByText(/Breached in round 1 on .*; that stays on its record\./).waitFor({ timeout: 5000 });
    const tile = page.locator('.card.stat').filter({ hasText: 'Resolution due' });
    assert.ok(!(await tile.getAttribute('class')).includes('tone-danger'), 'the new round is shown as breached');
    const shown = (await tile.locator('.stat-value').innerText()).trim();
    const [d, m, y] = shown.split(' ')[0].split('-');
    assert.ok(new Date(`${y}-${m}-${d}T23:59:59+05:30`) >= new Date(), `the case shows a resolution deadline in the past: ${shown}`);
    if (SHOTS) {
      await page.locator('.outcome-toast').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
      await page.screenshot({ path: path.join(SHOTS, 'B25-reopened-case.png') });
    }
  });
} finally {
  await browser.close();
  run('DELETE FROM notifications WHERE link = ?', [`/tickets/${ticket}`]);
  run("DELETE FROM field_history WHERE entity = 'case' AND record_id = ?", [ticket]);
  run("DELETE FROM audit_log WHERE entity IN ('ticket', 'case') AND entity_id = ?", [ticket]);
  run('DELETE FROM tickets WHERE id = ?', [ticket]);
  CARE.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
