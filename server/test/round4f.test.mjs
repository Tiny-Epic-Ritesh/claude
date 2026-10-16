/**
 * Round 4, QA-15 (16 Oct 2026): the lead list's paging and sorting.
 *
 * The auditor opened Leads with 41 rows and found no page size or pages, and
 * sort buttons only on Lead and Stage. Two causes: the pager showed only when
 * the book overflowed a page, and the sortable columns were matched to the
 * table's columns by the server's sort key -- Age, Owner and Partner are the
 * columns age_days, owner_name and partner_name, so they never matched.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...rel) => fs.readFileSync(path.join(HERE, '..', '..', ...rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nRound 4, QA-15: the lead list pages and sorts');

const leadsJsx = read('client', 'src', 'crm', 'Leads.jsx');
const crmJs = read('server', 'src', 'routes', 'crm.js');

/* The table's columns, the sortable list, and the server's sorts, as written. */
const block = (src, start) => {
  const from = src.indexOf(start);
  assert(from >= 0, `not found: ${start}`);
  let depth = 0;
  for (let i = src.indexOf(start.at(-1), from); i < src.length; i += 1) {
    if ('{['.includes(src[i])) depth += 1;
    if ('}]'.includes(src[i])) { depth -= 1; if (!depth) return src.slice(from, i + 1); }
  }
  throw new Error(`unclosed: ${start}`);
};
const columns = [...block(leadsJsx, 'const LEAD_COLUMNS = {').matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
const sortable = [...block(leadsJsx, 'const SORTABLE = [').matchAll(/\{([^}]*)\}/g)].map((m) => {
  const key = m[1].match(/key:\s*'([^']+)'/)?.[1] ?? null;
  return { col: m[1].match(/col:\s*'([^']+)'/)?.[1] ?? key, key };
});
const serverSorts = [...block(crmJs, 'export const LEAD_SORTS = {').matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);

/* An Admin sees every lead in the business, so the orders below are over the whole book. */
const ADMIN = await probeAdmin('r4f-admin', { role: 'admin', sales_org: 'BONANZA' });
const call = async (url) => {
  const res = await fetch(`${BASE}/api${url}`, { headers: ADMIN.headers });
  return { status: res.status, total: Number(res.headers.get('x-total-count')), body: await res.json() };
};

try {
  await test('QA-15: every column the server can order offers a sort on its header', async () => {
    /* Assembled per page, so a header there would reorder fifty rows and call it a sort. */
    const perPage = new Set(['products', 'aum', 'score']);
    /* Where masked, the order would tell what the mask hides. */
    const identifiers = new Set(['mobile', 'email']);
    const header = /const sortable = SORTABLE\.find\(\(sc\) => (\(sc\.col \?\? sc\.key\)|sc\.col|sc\.key) === c\.key\)/.exec(leadsJsx)?.[1];
    assert.notEqual(header, 'sc.key', 'the header matches a column to the sortable list by the sort key, not the column');
    assert(header, 'the header no longer looks columns up in the sortable list');
    const offered = new Set(sortable.map((s) => s.col));
    const missing = columns.filter((c) => !perPage.has(c) && !identifiers.has(c) && !offered.has(c));
    assert.deepEqual(missing, [], `columns with no sort: ${missing.join(', ')}`);
    const unknown = sortable.filter((s) => !columns.includes(s.col) || !serverSorts.includes(s.key));
    assert.deepEqual(unknown, [], `sorts naming a column or a server sort that does not exist: ${JSON.stringify(unknown)}`);
    assert(!sortable.some((s) => identifiers.has(s.col)), 'a sort is offered on an identifier the reader may see masked');
  });

  await test('QA-15: each newly offered sort orders the whole list on the server', async () => {
    const fresh = ['state', 'language', 'risk_profile', 'client_code', 'owner', 'partner', 'age'];
    const field = { owner: 'owner_name', partner: 'partner_name', age: 'created_at' };
    const wrong = [];
    for (const key of fresh) {
      for (const dir of ['asc', 'desc']) {
        // eslint-disable-next-line no-await-in-loop
        const { status, body } = await call(`/leads?sort=${key}&dir=${dir}&limit=200`);
        assert.equal(status, 200);
        assert(body.length > 10, `only ${body.length} leads to order`);
        const values = body.map((l) => l[field[key] ?? key] ?? null);
        /* Age ascending is the newest first: created_at descending. */
        const ascending = (key === 'age') ? dir === 'desc' : dir === 'asc';
        const sqlOrder = (a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
        const ok = values.every((v, i) => i === 0 || (ascending ? sqlOrder(values[i - 1], v) <= 0 : sqlOrder(values[i - 1], v) >= 0));
        if (!ok) wrong.push(`${key} ${dir}`);
      }
    }
    assert.deepEqual(wrong, [], `not ordered: ${wrong.join(', ')}`);
  });

  await test('QA-15: the page size and the count show whenever there is a lead, not only past one page', async () => {
    const foot = /\{!found && !loading && ([^&]+?) && \(\s*<div className="card-foot/.exec(leadsJsx)?.[1];
    assert.equal(foot?.trim(), 'count > 0', `the pager shows only when ${foot}`);
    const { total, body } = await call('/leads?limit=25');
    assert(total > 0 && body.length <= 25, 'the list does not page at 25');
  });

  await test('QA-15: Bulk update says it acts on what the filter matches, not "across all pages"', async () => {
    const bulk = read('client', 'src', 'crm', 'BulkUpdate.jsx');
    assert(!/across all pages/.test(bulk), 'still says "across all pages"');
    assert(/leads this filter matches/.test(bulk), 'does not say what it selects');
  });
} finally {
  ADMIN.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
