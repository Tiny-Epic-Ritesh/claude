/**
 * A20 (B26, ruled 20 Nov 2026): a Caller hands their lead to a Sales RM, in
 * the browser.
 *
 *   menu      the lead's Actions offer "Hand to a Sales RM" to its Caller
 *   before    the dialog says who the routing rules would choose and why, lets
 *             them choose a Sales RM instead, asks what the Sales RM needs to
 *             know, and says everything it will do
 *   after     the lead is the Sales RM's, the Caller is back on their list, and
 *             what happened is said
 *
 * Needs the client built (the server serves client/dist) and Playwright:
 *
 *   (cd client && npx vite build) && node test/ui/handover.ui.mjs
 *
 * SHOTS=<dir> saves screenshots of the dialog and of what it said.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../../src/db.js';
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
const MARK = `Handover UI ${stamp}`;
const SUP = await probeAdmin('ho-ui-sup', { role: 'sales_supervisor', sales_org: 'BONANZA' });
const CALLER = await probeAdmin('ho-ui-caller', { role: 'caller', sales_org: 'BONANZA' });
const RM = await probeAdmin('ho-ui-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
run('UPDATE users SET manager_id = ? WHERE id = ?', [SUP.id, CALLER.id]);
const lead = Number(run(
  "INSERT INTO leads (sales_org, name, mobile, source, stage, owner_id, city) VALUES ('BONANZA', ?, ?, 'Facebook', 'Contacted', ?, 'Pune')",
  [MARK, `92${stamp}1`.slice(0, 10), CALLER.id],
).lastInsertRowid);
run("INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, status) VALUES (?,?,?,?, datetime('now', '+1 day'), 'Open')",
  [`Call ${MARK} back after 6 pm`, lead, CALLER.id, CALLER.id]);

const browser = await chromium.launch();
console.log('\nA20: a Caller hands their lead to a Sales RM, in the browser (B26)');

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: SHOTS ? 2 : 1 });
  await ctx.addInitScript((token) => localStorage.setItem('bnz_crm_token', token), CALLER.token);
  const page = await ctx.newPage();
  await page.goto(`${APP}/leads/${lead}`);
  await page.getByRole('heading', { name: MARK }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Not yet')?.click());

  const dialog = page.getByRole('dialog');

  await test('the lead\'s Actions offer its Caller "Hand to a Sales RM"', async () => {
    await page.locator('.record-toolbar').getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: /Hand to a Sales RM/ }).click();
    await dialog.getByText('Let the routing rules choose').waitFor({ timeout: 10000 });
  });

  await test('the dialog says who the rules would choose and why, and all a hand-over does', async () => {
    await dialog.getByText(/The routing rules chose .*, by the rule ".*"\. That is who it would be now\./).waitFor({ timeout: 5000 });
    for (const line of [
      /moves from Contacted to Qualified/,
      /High-priority task due in 4 hours with your note in it/,
      new RegExp(`Your open task on it goes to them too, reminders and all: Call ${MARK} back after 6 pm\\.`),
      /is told, as your supervisor/,
      /It counts on your scorecard, under "Leads qualified"/,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await dialog.locator('.handover-will').getByText(line).waitFor({ timeout: 5000 });
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'B26-handover-dialog.png') });
  });

  await test('it needs a note before it can go', async () => {
    assert.ok(await dialog.getByRole('button', { name: 'Hand over' }).isDisabled(), 'Hand over is available with no note');
  });

  await test('choosing a Sales RM by name hands it over, and says what happened', async () => {
    await dialog.getByText('Choose a Sales RM').click();
    await dialog.getByRole('combobox', { name: 'Sales RM', exact: true }).selectOption(String(RM.id));
    await dialog.getByLabel('What the Sales RM needs to know').fill(`${MARK}: wants a SIP of 5,000 a month; free after 6 pm`);
    await dialog.getByRole('button', { name: 'Hand over' }).click();
    await page.waitForURL(/\/leads(\?|$)/, { timeout: 10000 });
    const toast = page.locator('.outcome-toast').filter({ hasText: `${MARK} handed to` });
    await toast.getByText(/is .*'s lead now, at Qualified \(was Contacted\)\./).waitFor({ timeout: 10000 });
    await toast.getByText(/You chose /).waitFor({ timeout: 5000 });
    const l = one('SELECT owner_id, stage FROM leads WHERE id = ?', [lead]);
    assert.deepEqual({ ...l }, { owner_id: RM.id, stage: 'Qualified' });
    // Back on their own list, which no longer has it.
    await page.getByRole('heading', { name: 'Leads', exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await page.getByRole('link', { name: MARK }).count(), 0, 'the handed-over lead is still on the Caller\'s list');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'B26-handed-over.png') });
  });
} finally {
  await browser.close();
  run('DELETE FROM notifications WHERE link = ?', [`/leads/${lead}`]);
  for (const t of all('SELECT id FROM tasks WHERE lead_id = ?', [lead])) run("DELETE FROM field_history WHERE entity = 'task' AND record_id = ?", [t.id]);
  run("DELETE FROM field_history WHERE entity = 'lead' AND record_id = ?", [lead]);
  run("DELETE FROM audit_log WHERE entity = 'lead' AND entity_id = ?", [lead]);
  run('DELETE FROM leads WHERE id = ?', [lead]);
  run('UPDATE users SET manager_id = NULL WHERE id = ?', [CALLER.id]);
  RM.cleanup();
  CALLER.cleanup();
  SUP.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
