/**
 * QA-37, batch 3: library content, holidays and case categories, as accepted
 * on 13 Oct.
 *
 *   Library content   a new version, approved before it is offered; withdraw,
 *                     then archive; never deleted -- an item sent to a client
 *                     records what they were told. Content owners; a
 *                     different approver.
 *   Holiday           future dates only, to add or to remove.
 *   SLA category      retired, never deleted -- cases point at it.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { isSendable } from '../src/engine/library.js';
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

console.log('\nQA-37 lifecycle: library content, holidays and case categories');

const RUN = Date.now().toString(36);
const MARK = `LC3 probe ${RUN}`;

const AUTHOR = await probeAdmin('lc3-author', { role: 'marketing_manager', sales_org: 'BONANZA' });
const APPROVER = await probeAdmin('lc3-approver', { role: 'admin', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('lc3-bigul', { role: 'admin', sales_org: 'BIGUL' });
const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const library = Number(run(
  "INSERT INTO content_library (name, owner_role, sales_org, requires_approval) VALUES (?, 'marketing_manager', 'BONANZA', 1)",
  [`${MARK} collateral`],
).lastInsertRowid);
const makeItem = (label, status = 'approved') => Number(run(
  `INSERT INTO content_items (name, type, url, version, owner_role, library_id, status, created_by, approved_by, approved_at, sales_org)
   VALUES (?, 'PDF', ?, 1, 'marketing_manager', ?, ?, ?, ?, datetime('now'), 'BONANZA')`,
  [`${MARK} ${label}`, `https://files.test/${RUN}/${label}-v1.pdf`, library, status, AUTHOR.id, APPROVER.id],
).lastInsertRowid);
const item = (id) => one('SELECT * FROM content_items WHERE id = ?', [id]);
const days = [];
const categories = [];
const tickets = [];

try {
  /* ----------------------------------------------------------- library */

  await test('a new version waits for approval while the current one keeps going out', async () => {
    const v1 = makeItem('factsheet');
    assert.equal((await as(AUTHOR)('POST', `/libraries/items/${v1}/versions`, {})).status, 400, 'a version with no file was accepted');
    const res = await as(AUTHOR)('POST', `/libraries/items/${v1}/versions`, { url: `https://files.test/${RUN}/factsheet-v2.pdf` });
    assert.equal(res.status, 201, `new version answered ${res.status}: ${res.body?.error}`);
    const v2 = res.body.item.id;
    assert.equal(item(v2).version, 2);
    assert.equal(item(v2).status, 'draft');
    assert.equal(item(v2).supersedes_id, v1);
    assert.equal(item(v1).status, 'approved', 'the current version went out of use before the new one was approved');
    assert(isSendable(item(v1)), 'the current version stopped being sendable');
    assert.equal((await as(AUTHOR)('POST', `/libraries/items/${v1}/versions`, { url: 'https://files.test/again.pdf' })).status, 409,
      'a second new version was started while one waits');

    assert.equal((await as(AUTHOR)('POST', `/libraries/items/${v2}/status`, { status: 'pending' })).status, 200);
    assert.equal((await as(AUTHOR)('POST', `/libraries/items/${v2}/status`, { status: 'approved' })).status, 403, 'the author approved their own version');
    assert.equal((await as(APPROVER)('POST', `/libraries/items/${v2}/status`, { status: 'approved' })).status, 200);
    assert.equal(item(v2).status, 'approved');
    assert.equal(item(v1).status, 'archived', 'the old version is still on offer beside the new one');
    assert.equal(item(v1).url, `https://files.test/${RUN}/factsheet-v1.pdf`, 'the old version was rewritten');
  });

  await test('the file of something that has been on offer is never replaced in place', async () => {
    const v1 = makeItem('inplace');
    const res = await as(AUTHOR)('PATCH', `/libraries/items/${v1}`, { url: 'https://files.test/swapped.pdf' });
    assert.equal(res.status, 409, `the file was swapped: HTTP ${res.status}`);
    assert.equal(res.body.new_version, true);
    assert.equal(item(v1).url, `https://files.test/${RUN}/inplace-v1.pdf`);
    assert.equal(item(v1).status, 'approved', 'refusing the swap took it out of use');
    assert.equal((await as(AUTHOR)('PATCH', `/libraries/items/${v1}`, { name: `${MARK} inplace renamed` })).status, 200, 'a rename was refused');
  });

  await test('withdraw asks why and stops it going out; only then is it archived; nothing deletes it', async () => {
    const v1 = makeItem('withdraw');
    assert.equal((await as(AUTHOR)('POST', `/libraries/items/${v1}/status`, { status: 'archived' })).status, 403,
      'something on offer was archived without being withdrawn');
    assert.equal((await as(AUTHOR)('POST', `/libraries/items/${v1}/status`, { status: 'withdrawn' })).status, 400, 'withdrawn with no reason');
    const res = await as(AUTHOR)('POST', `/libraries/items/${v1}/status`, { status: 'withdrawn', reason: 'Brokerage figures changed' });
    assert.equal(res.status, 200, `withdraw answered ${res.status}: ${res.body?.error}`);
    const row = item(v1);
    assert.equal(row.status, 'withdrawn');
    assert.equal(row.withdraw_reason, 'Brokerage figures changed');
    assert.equal(row.withdrawn_by, AUTHOR.id);
    assert(!isSendable(row), 'a withdrawn item is still sendable');
    assert.equal((await as(AUTHOR)('POST', `/libraries/items/${v1}/status`, { status: 'draft' })).status, 403, 'a withdrawn item slipped back to draft');

    assert.equal((await as(AUTHOR)('POST', `/libraries/items/${v1}/status`, { status: 'archived' })).status, 200);
    assert.equal(item(v1).status, 'archived');
    assert.equal((await as(AUTHOR)('PATCH', `/libraries/items/${v1}`, { name: 'changed' })).status, 409, 'an archived item changed');
    assert.equal((await as(APPROVER)('DELETE', `/libraries/items/${v1}`)).status, 404, 'there is a way to delete library content');
    assert(item(v1), 'the item went');
  });

  await test('the older version route keeps the current version on offer too', async () => {
    const v1 = makeItem('legacy');
    const res = await as(APPROVER)('POST', `/admin/content/${v1}/version`, { url: 'https://files.test/legacy-v2.pdf' });
    assert.equal(res.status, 201, `answered ${res.status}: ${res.body?.error}`);
    assert.equal(item(v1).status, 'approved', 'the current version was archived before the new one was approved');
    const v2 = item(res.body.id);
    assert.equal(v2.library_id, library, 'the new version lost its library');
    assert.equal(v2.sales_org, 'BONANZA', 'the new version lost its business');
    assert.equal(v2.status, 'draft');
  });

  await test('the other business cannot version or withdraw an item', async () => {
    const v1 = makeItem('book');
    assert.equal((await as(BIGUL)('POST', `/libraries/items/${v1}/versions`, { url: 'https://files.test/x.pdf' })).status, 404);
    assert.equal((await as(BIGUL)('POST', `/libraries/items/${v1}/status`, { status: 'withdrawn', reason: 'Across the book' })).status, 404);
    assert.equal(item(v1).status, 'approved');
  });

  /* ---------------------------------------------------------- holidays */

  await test('a holiday is added or removed only for a future day', async () => {
    const past = one("SELECT date('now', '+330 minutes', '-3 days') d").d;
    const today = one("SELECT date('now', '+330 minutes') d").d;
    const future = one("SELECT date('now', '+330 minutes', '+400 days') d").d;

    assert.equal((await as(APPROVER)('POST', '/admin/calendars/office/days', { on_date: past, name: `${MARK} past` })).status, 409, 'a past day was added');
    assert.equal((await as(APPROVER)('POST', '/admin/calendars/office/days', { on_date: today, name: `${MARK} today` })).status, 409, 'today was added');
    const added = await as(APPROVER)('POST', '/admin/calendars/office/days', { on_date: future, name: `${MARK} future` });
    assert.equal(added.status, 201, `a future day was refused: ${added.body?.error}`);
    const futureRow = one('SELECT id FROM calendar_days WHERE name = ?', [`${MARK} future`]);
    days.push(futureRow.id);
    assert.equal((await as(APPROVER)('DELETE', `/admin/calendars/days/${futureRow.id}`)).status, 200, 'a future day could not be removed');

    const office = one("SELECT id FROM calendars WHERE kind = 'office'").id;
    const old = Number(run("INSERT INTO calendar_days (calendar_id, on_date, name, source) VALUES (?, ?, ?, 'manual')",
      [office, past, `${MARK} old`]).lastInsertRowid);
    days.push(old);
    const refused = await as(APPROVER)('DELETE', `/admin/calendars/days/${old}`);
    assert.equal(refused.status, 409, `a past holiday was removed: HTTP ${refused.status}`);
    assert(one('SELECT id FROM calendar_days WHERE id = ?', [old]), 'the past day went anyway');
  });

  /* -------------------------------------------------------- categories */

  await test('a category is renamed, and retired with a reason -- out of the pickers, kept by its cases', async () => {
    const cat = Number(run('INSERT INTO ticket_categories (name, auto_assign_role) VALUES (?, ?)', [`${MARK} refunds`, 'customer_care']).lastInsertRowid);
    categories.push(cat);
    const other = Number(run('INSERT INTO ticket_categories (name) VALUES (?)', [`${MARK} other`]).lastInsertRowid);
    categories.push(other);
    const kept = Number(run(
      "INSERT INTO tickets (ref, subject, priority, status, category_id, sales_org) VALUES (?, ?, 'Low', 'Open', ?, 'BONANZA')",
      [`LC3-${RUN}`, `${MARK} case`, cat],
    ).lastInsertRowid);
    tickets.push(kept);

    assert.equal((await as(APPROVER)('PATCH', `/admin/categories/${cat}`, { name: `${MARK} other` })).status, 409, 'two categories share a name');
    assert.equal((await as(APPROVER)('PATCH', `/admin/categories/${cat}`, { name: `${MARK} payouts` })).status, 200);
    assert.equal((await as(APPROVER)('POST', `/admin/categories/${cat}/retire`, { reason: '' })).status, 400, 'retired with no reason');
    const res = await as(APPROVER)('POST', `/admin/categories/${cat}/retire`, { reason: 'Merged into account changes' });
    assert.equal(res.status, 200, `retire answered ${res.status}: ${res.body?.error}`);

    const meta = await as(APPROVER)('GET', '/meta');
    assert(!meta.body.ticket_categories.some((c) => c.id === cat), 'a retired category is still offered');
    const created = await as(APPROVER)('POST', '/tickets', { subject: `${MARK} new`, category_id: cat });
    assert.equal(created.status, 400, `a new case took a retired category: HTTP ${created.status}`);
    const moved = await as(APPROVER)('PATCH', `/tickets/${kept}`, { category_id: other });
    assert.equal(moved.status, 200, `an open case could not change category: ${moved.body?.error}`);
    const back = await as(APPROVER)('PATCH', `/tickets/${kept}`, { category_id: cat });
    assert.equal(back.status, 400, 'a case was given a retired category');
    run('UPDATE tickets SET category_id = ? WHERE id = ?', [cat, kept]);
    assert.equal((await as(APPROVER)('GET', `/tickets/${kept}`)).status, 200, 'a case with a retired category cannot be opened');

    assert.equal((await as(APPROVER)('POST', `/admin/categories/${cat}/restore`)).status, 200);
    assert(one('SELECT active FROM ticket_categories WHERE id = ?', [cat]).active === 1);
  });

  await test('a category a compliance flag opens cases in is not retired until the flag is re-routed', async () => {
    const routed = one('SELECT category_id, flag FROM compliance_flag_routes WHERE category_id IS NOT NULL LIMIT 1');
    assert(routed, 'no compliance flag is routed anywhere to test with');
    const res = await as(APPROVER)('POST', `/admin/categories/${routed.category_id}/retire`, { reason: 'Probing the refusal' });
    assert.equal(res.status, 409, `a compliance category was retired: HTTP ${res.status}`);
    assert(res.body.flags.includes(routed.flag), 'the refusal does not name the flag');
    assert.equal(one('SELECT active FROM ticket_categories WHERE id = ?', [routed.category_id]).active, 1);
  });

  await test('the screens offer it: versions, withdraw, archive; category retire; future-only holidays (source check)', async () => {
    const lib = source('crm/Libraries.jsx');
    assert(/\/versions`/.test(lib) && /'withdrawn'/.test(lib) && /'archived'/.test(lib));
    const sla = source('crm/admin/Sla.jsx');
    assert(/\/retire`/.test(sla) && /\/restore`/.test(sla));
    assert(/tomorrowInIndia/.test(source('crm/admin/Calendars.jsx')));
  });
} finally {
  for (const id of tickets) run('DELETE FROM tickets WHERE id = ?', [id]);
  run('DELETE FROM tickets WHERE subject LIKE ?', [`${MARK}%`]);
  for (const id of categories) run('DELETE FROM ticket_categories WHERE id = ?', [id]);
  for (const id of days) run('DELETE FROM calendar_days WHERE id = ?', [id]);
  run('DELETE FROM calendar_days WHERE name LIKE ?', [`${MARK}%`]);
  run('DELETE FROM content_items WHERE library_id = ?', [library]);
  run('DELETE FROM content_library WHERE id = ?', [library]);
  for (const p of [AUTHOR, APPROVER, BIGUL]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
