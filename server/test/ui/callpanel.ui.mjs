/**
 * A4 (QA-10, Part 4 item 9; preview approved 19 Nov): the call panel, in the
 * browser, as a Sales RM, on a lead of their own.
 *
 *   solid       nothing shows through it, in either theme
 *   End call    a solid red button with white text, always in view
 *   docked      on a laptop the lead page is not covered; on a phone it is
 *               full-screen with End call at the bottom
 *   dials       Start call places the call and says what happened (here, no
 *               dialler: a simulated call, said so)
 *   actions     one really happens and is listed; one that does not apply
 *               says why
 *   wrap-up     cannot be dismissed; the call is saved as a Call with one of
 *               Setup's outcomes, and a callback booked on it is its follow-up
 *   AI          a call the AI drafts is saved the same way, as a call (OPS-74)
 *
 * Needs the client built (the server serves client/dist) and Playwright, which
 * this environment has installed globally:
 *
 *   (cd client && npx vite build) && node test/ui/callpanel.ui.mjs
 */

import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../../src/db.js';
import { probeAdmin } from '../helpers/probeadmin.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const APP = `${BASE}/ai-crm`;

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${String(err.message).split('\n')[0]}`); }
};

const stamp = String(Date.now()).slice(-7);
const MARK = `Callpanel ${stamp}`;
const RM = await probeAdmin('callp-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const product = (code) => one("SELECT id FROM product_types WHERE code = ? AND sales_org = 'BONANZA'", [code]).id;
const lead = Number(run(
  `INSERT INTO leads (sales_org, name, mobile, email, source, stage, owner_id, no_sms, city, language)
   VALUES ('BONANZA', ?, ?, ?, 'Website', 'Contacted', ?, 1, 'Pune', 'Hindi')`,
  [MARK, `98${stamp}1`.slice(0, 10), `callp-${stamp}@example.com`, RM.id],
).lastInsertRowid);
const mf = Number(run("INSERT INTO product_cards (lead_id, product_type_id, state, last_state_at) VALUES (?,?, 'EXPLORING', datetime('now'))", [lead, product('MF')]).lastInsertRowid);
run("INSERT INTO product_cards (lead_id, product_type_id, state, last_state_at) VALUES (?,?, 'INACTIVE', datetime('now', '-3 days'))", [lead, product('EQD')]);

const browser = await chromium.launch();
const contexts = [];

/** The lead's page, signed in as the probe RM, with the given theme and size. */
async function leadPage({ width = 1280, height = 800, theme = 'light' } = {}) {
  // Reduced motion: the panel slides in, and a box measured mid-slide is not where it ends up.
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  contexts.push(ctx);
  await ctx.addInitScript(([token, t]) => {
    localStorage.setItem('bnz_crm_token', token);
    localStorage.setItem('bnz_theme', t);
  }, [RM.token, theme]);
  const page = await ctx.newPage();
  await page.goto(`${APP}/leads/${lead}`);
  await page.getByRole('heading', { name: MARK }).waitFor({ timeout: 15000 });
  // The attendance prompt a Sales RM gets on their first page of the day.
  await page.waitForTimeout(600);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Not yet')?.click());
  return page;
}

const panel = (page) => page.locator('aside.callp');
async function startCall(page) {
  await page.getByRole('button', { name: /Start call/ }).click();
  await panel(page).getByText(/Simulated call/).first().waitFor({ timeout: 10000 });
}
/** The colour's alpha: 1 for a solid colour. */
const alpha = (css) => {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map((x) => Number(x.trim()));
  return parts.length === 4 ? parts[3] : 1;
};

console.log('\nA4: the call panel (QA-10)');

try {
  const page = await leadPage();

  await test('Start call places the call and says what happened', async () => {
    await startCall(page);
    const text = await panel(page).innerText();
    assert.match(text, /No call is placed: the dialler isn't connected/, 'the panel does not say the call is simulated');
    const placed = one("SELECT COUNT(*) n FROM integration_log WHERE kind = 'telephony' AND lead_id = ?", [lead])?.n;
    assert.ok(placed >= 1, 'no dial was recorded');
  });

  await test('the panel is solid, and End call is white on red, always in view', async () => {
    const bg = await panel(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(alpha(bg), 1, `the panel's background is ${bg}: the page shows through`);
    const end = panel(page).getByRole('button', { name: 'End call' });
    const look = await end.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
    assert.equal(look.bg, 'rgb(196, 69, 58)', `End call is ${look.bg}`);
    assert.equal(look.fg, 'rgb(255, 255, 255)', `End call's text is ${look.fg}`);
    await panel(page).locator('.callp-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    assert.ok(await end.isVisible(), 'End call scrolled out of view');
  });

  await test('on a laptop it docks beside the lead, which stays uncovered', async () => {
    const box = await panel(page).boundingBox();
    assert.ok(box.x >= 1280 - 441 && box.width <= 441, `the panel spans ${box.x}..${box.x + box.width}`);
    const title = await page.getByRole('heading', { name: MARK }).boundingBox();
    assert.ok(title.x + title.width <= box.x, 'the lead\'s name is under the panel');
    const toolbar = await page.locator('.record-toolbar').boundingBox();
    assert.ok(toolbar.x + toolbar.width <= box.x + 1, 'the lead\'s toolbar is under the panel');
  });

  await test('an action that does not apply says why', async () => {
    const sms = panel(page).locator('.callp-act', { hasText: 'Send SMS' });
    assert.equal(await sms.getAttribute('aria-disabled'), 'true', 'SMS is offered to a lead who opted out of it');
    assert.match(await sms.innerText(), /asked not to be contacted by SMS/i);
  });

  await test('an action really happens, and is listed on the call', async () => {
    await panel(page).locator('.callp-act', { hasText: 'Add a note' }).click();
    await panel(page).getByPlaceholder('A note for the timeline').fill(`${MARK} wants the SIP details`);
    await panel(page).getByRole('button', { name: 'Save note' }).click();
    await panel(page).getByText('Note saved to the timeline.').waitFor({ timeout: 5000 });
    const note = one('SELECT id FROM notes WHERE lead_id = ? AND body = ?', [lead, `${MARK} wants the SIP details`]);
    assert.ok(note, 'the note is not on the lead');
  });

  await test('the wrap-up cannot be dismissed, and saves a Call with Setup\'s outcome', async () => {
    await panel(page).locator('.callp-act', { hasText: 'Book a callback' }).click();
    await panel(page).locator('.callp-inline button').first().click();
    await panel(page).getByText(/Callback set for/).waitFor();
    await panel(page).getByPlaceholder(/Type as you talk/).fill(`${MARK}: asked for a call back`);
    await panel(page).getByRole('button', { name: 'End call' }).click();
    assert.equal(await panel(page).getByRole('button', { name: 'Close' }).count(), 0, 'the wrap-up can be closed unsaved');
    await page.keyboard.press('Escape');
    assert.equal(await panel(page).count(), 1, 'Escape closed the wrap-up');
    await panel(page).getByRole('button', { name: 'Fill it in myself' }).click();
    const chosen = panel(page).locator('.chip.chip-active', { hasText: 'Callback Requested' });
    await chosen.waitFor({ timeout: 5000 });
    assert.ok(await panel(page).locator('#next-when').inputValue(), 'the callback booked on the call is not its follow-up time');
    await panel(page).getByRole('button', { name: 'Save the call' }).click();
    await panel(page).getByText(/Saved to .*timeline/).waitFor({ timeout: 8000 });
    const call = one("SELECT * FROM activities WHERE lead_id = ? AND type = 'Call' ORDER BY id DESC LIMIT 1", [lead]);
    assert.ok(call, 'no Call was logged');
    assert.equal(call.sub_disposition, 'Callback Requested', `logged as ${call.sub_disposition}`);
    assert.equal(call.card_id, mf, 'the call is not on the product it was about');
    assert.ok(one("SELECT id FROM tasks WHERE lead_id = ? AND status NOT IN ('Done','Completed','Cancelled')", [lead]), 'the callback made no follow-up');
    await panel(page).getByRole('button', { name: 'Close' }).first().click();
    await panel(page).waitFor({ state: 'detached', timeout: 5000 });
  });

  await test('a call the AI drafts is saved as a call too (OPS-74)', async () => {
    await startCall(page);
    await panel(page).getByPlaceholder(/Type as you talk/).fill('She is interested in a mutual fund SIP of 5000 a month and wants the details.');
    await panel(page).getByRole('button', { name: 'End call' }).click();
    await panel(page).getByRole('button', { name: /Draft with AI/ }).click();
    await panel(page).getByText('Drafted by the AI from your notes').waitFor({ timeout: 15000 });
    await panel(page).getByRole('button', { name: 'Save the call' }).click();
    await panel(page).getByText(/Saved to .*timeline/).waitFor({ timeout: 8000 });
    const call = one("SELECT * FROM activities WHERE lead_id = ? AND type = 'Call' ORDER BY id DESC LIMIT 1", [lead]);
    assert.equal(call.ai_generated, 1, 'the AI-drafted call is not marked as drafted by the AI');
    assert.ok(call.disposition, 'the AI-drafted call has no Setup outcome');
    assert.equal(one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND type = 'AI Call Summary'", [lead]).n, 0,
      'an "AI Call Summary" was written: it is not counted as a call');
  });

  await test('on a phone it is full-screen, with End call at the bottom, in the dark theme too', async () => {
    const phone = await leadPage({ width: 390, height: 844, theme: 'dark' });
    await startCall(phone);
    const box = await panel(phone).boundingBox();
    assert.ok(box.x <= 0 && box.width >= 389 && box.height >= 843, `the panel is ${JSON.stringify(box)}`);
    const bg = await panel(phone).evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(alpha(bg), 1, `the panel's background is ${bg} in the dark theme`);
    assert.equal(bg, 'rgb(22, 29, 39)', `the dark panel is ${bg}`);
    const end = await panel(phone).getByRole('button', { name: /End call/ }).boundingBox();
    assert.ok(end.y > 844 - 120, `End call is at y=${end.y}, not at the bottom`);
    await panel(phone).getByRole('button', { name: /End call/ }).click();
    await panel(phone).getByRole('button', { name: 'Fill it in myself' }).click();
    await panel(phone).getByText('Not Connected', { exact: false }).first().click().catch(() => {});
    // Leave it unsaved: the lead is removed below.
  });
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser.close();
  const cards = all('SELECT id FROM product_cards WHERE lead_id = ?', [lead]).map((r) => r.id);
  const acts = all('SELECT id FROM activities WHERE lead_id = ?', [lead]).map((r) => r.id);
  run("DELETE FROM field_history WHERE entity = 'lead' AND record_id = ?", [lead]);
  for (const id of cards) run("DELETE FROM field_history WHERE entity = 'product_interest' AND record_id = ?", [id]);
  for (const id of acts) run("DELETE FROM field_value WHERE entity = 'interaction' AND record_id = ?", [id]);
  run('DELETE FROM notes WHERE lead_id = ?', [lead]);
  run('DELETE FROM leads WHERE id = ?', [lead]);
  RM.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
