/**
 * QA-06 -- one masking rule, wherever a lead's identifiers leave the server;
 * Marketing sees and may export them in the clear, and a Setup policy can hold
 * Marketing's exports masked.
 *
 * The auditor found the policy applied in some places and not others: the lead
 * list masked a mobile that list #3 showed in full. So this does not test a
 * list of routes somebody remembered. It plants a lead with a known mobile and
 * email -- on a list, with a case and a KYC journey -- signs in as roles whose
 * masking hides both, calls every GET route in the source that takes no path
 * parameter plus the planted records' own routes, and demands that neither
 * value appear in any answer.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const here = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(here, '..', 'src', 'routes');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nQA-06 — one masking rule, and Marketing\'s exports');

const RUN = String(Date.now()).slice(-7);
const MARK = `PII probe ${RUN}`;
const POLICY = 'export_pii.marketing_manager';

/* The mount point of each route file, as index.js mounts them. Files that are
   not here serve no lead data a staff role reads (portal, webhooks, market). */
const MOUNTS = {
  'activities.js': { router: '/api/activities' }, 'admin.js': { router: '/api/admin' },
  'approvals.js': { router: '/api/approvals' }, 'calendar.js': { router: '/api/calendar' },
  'ccm.js': { router: '/api/ccm' }, 'clients.js': { router: '/api/clients' },
  'cockpit.js': { router: '/api/cockpit' }, 'crm.js': { router: '/api' },
  'dashboard.js': { router: '/api/dashboard' }, 'dashboards.js': { router: '/api/dashboards' },
  'library.js': { router: '/api/libraries' }, 'email.js': { router: '/api/email' },
  'kra.js': { router: '/api/kra' }, 'kyc.js': { internal: '/api/kyc' },
  'lists.js': { router: '/api/lists' }, 'orgs.js': { router: '/api/orgs' },
  'partners.js': { router: '/api/partners' }, 'pipeline.js': { router: '/api/pipeline' },
  'products.js': { router: '/api/products' }, 'reports.js': { router: '/api/reports' },
  'revenue.js': { router: '/api/revenue' }, 'search-advanced.js': { router: '/api/search-advanced' },
  'search.js': { router: '/api/search' }, 'setup.js': { router: '/api/setup' },
  'team.js': { router: '/api/team' }, 'tickets.js': { router: '/api/tickets' },
};
/* Streams never finish, and downloads are files the export tests cover. */
const SKIP = /stream|export|download/;

const listRoutes = () => {
  const found = [];
  for (const file of readdirSync(ROUTES)) {
    const map = MOUNTS[file];
    if (!map) continue;
    const src = readFileSync(join(ROUTES, file), 'utf8').replace(/\r\n/g, '\n');
    for (const m of src.matchAll(/(\w+)\.get\(\s*'([^']*)'/g)) {
      const [, variable, p] = m;
      if (!(variable in map) || p.includes(':')) continue;
      const full = (map[variable] + p).replace(/\/$/, '');
      if (!SKIP.test(full)) found.push(full);
    }
  }
  return found;
};

/** Every path in a JSON answer whose value carries one of the needles. */
const carrying = (text, needles) => {
  const hits = [];
  const walk = (v, at) => {
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k); return; }
    if (typeof v === 'string' && needles.some((n) => v.includes(n))) hits.push(at);
  };
  try { walk(JSON.parse(text), ''); } catch { if (needles.some((n) => text.includes(n))) hits.push('(body)'); }
  return hits;
};

const product = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND requires_kyc = 1 ORDER BY id LIMIT 1");
const planted = [];
let marketingRec = null;
const plant = (who, n) => {
  const mobile = `9${RUN}${String(n).padStart(2, '0')}`.slice(0, 10);
  const email = `pii-probe-${RUN}-${n}@example.invalid`;
  const lead = Number(run(
    "INSERT INTO leads (sales_org, name, mobile, email, source, stage, owner_id) VALUES ('BONANZA', ?, ?, ?, 'Website', 'New', ?)",
    [`${MARK} ${n}`, mobile, email, who.id],
  ).lastInsertRowid);
  const list = Number(run("INSERT INTO lead_lists (name, kind, owner_id, sales_org) VALUES (?, 'static', ?, 'BONANZA')", [`${MARK} list ${n}`, who.id]).lastInsertRowid);
  run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [list, lead]);
  const ticket = Number(run(
    "INSERT INTO tickets (subject, status, priority, sales_org, lead_id, assignee_id) VALUES (?, 'Open', 'Medium', 'BONANZA', ?, ?)",
    [`${MARK} case ${n}`, lead, who.id],
  ).lastInsertRowid);
  const journey = Number(run(
    "INSERT INTO kyc_journeys (lead_id, product_type_id, status, current_step, applicant_mobile, applicant_email) VALUES (?, ?, 'In Progress', 'BANK', ?, ?)",
    [lead, product.id, mobile, email],
  ).lastInsertRowid);
  const rec = { lead, list, ticket, journey, mobile, email };
  planted.push(rec);
  return rec;
};

const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, text: await res.text() };
};

const saved = one('SELECT * FROM business_policy WHERE key = ?', [POLICY]);
const CALLER = await probeAdmin('piimask-caller', { role: 'caller', sales_org: 'BONANZA' });
const DEALER = await probeAdmin('piimask-dealer', { role: 'dealer', sales_org: 'BONANZA' });
const MARKETING = await probeAdmin('piimask-marketing', { role: 'marketing_manager', sales_org: 'BONANZA' });
const ADMIN = await probeAdmin('piimask-admin', { role: 'admin', sales_org: 'BONANZA' });

/* The roles under test must actually be masked for both fields, or the crawl
   proves nothing. Checked rather than assumed: Setup can change it. */
const maskedFor = (role) => {
  const set = new Set(all('SELECT field FROM field_masking WHERE role_code = ? AND masked = 0', [role]).map((r) => r.field));
  return !set.has('mobile') && !set.has('email');
};

try {
  for (const [who, role] of [[CALLER, 'caller'], [DEALER, 'dealer']]) {
    // eslint-disable-next-line no-await-in-loop
    await test(`no route gives a ${role} a lead's full mobile or email`, async () => {
      assert(maskedFor(role), `${role} is configured to see these fields, so this proves nothing`);
      const rec = plant(who, planted.length + 1);
      const paths = [
        `/api/leads/${rec.lead}`, `/api/lists/${rec.list}`, `/api/tickets/${rec.ticket}`, `/api/kyc/journeys/${rec.journey}`,
        `/api/activities/lead/${rec.lead}`, `/api/email/compose/${rec.lead}`,
        `/api/leads?q=${encodeURIComponent(MARK)}`, `/api/tickets?q=${encodeURIComponent(MARK)}`, `/api/search?q=${encodeURIComponent(MARK)}`,
        ...listRoutes(),
      ];
      const call = as(who);
      const leaks = [];
      let reached = 0;
      for (const p of paths) {
        let r;
        // eslint-disable-next-line no-await-in-loop
        try { r = await call('GET', p); } catch { continue; }
        if (r.status !== 200) continue;
        if (p.includes(String(rec.lead)) || p.includes(String(rec.list)) || p.includes(String(rec.ticket))) reached += 1;
        const hits = carrying(r.text, [rec.mobile, rec.email]);
        if (hits.length) leaks.push(`${p} -> ${hits.slice(0, 3).join(', ')}`);
      }
      assert(reached >= 3, `the ${role} could open only ${reached} of the planted records, so this proves too little`);
      assert.deepEqual(leaks, [], `the full value reached the ${role} through:\n         ${leaks.join('\n         ')}`);
    });
  }

  await test('an unmask still shows the value, to a role allowed to ask, and is audited', async () => {
    const rm = await probeAdmin('piimask-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
    try {
      const rec = plant(rm, planted.length + 1);
      const masked = await as(rm)('GET', `/api/kyc/journeys/${rec.journey}`);
      assert.equal(masked.status, 200);
      assert(!masked.text.includes(rec.mobile), 'the journey shows the applicant\'s number without asking');
      const clear = await as(rm)('GET', `/api/kyc/journeys/${rec.journey}?unmask=true`);
      assert(clear.text.includes(rec.mobile), 'an allowed unmask did not show it');
      assert(one("SELECT id FROM audit_log WHERE action = 'pii_unmasked' AND entity = 'kyc_journey' AND entity_id = ?", [rec.journey]),
        'the unmask was not audited');
    } finally { rm.cleanup(); }
  });

  /* ============================================== Marketing, as ruled */

  await test('Marketing sees a lead\'s identifiers in the clear, on the lead and on a list', async () => {
    const rec = plant(MARKETING, planted.length + 1);
    marketingRec = rec;
    const lead = await as(MARKETING)('GET', `/api/leads/${rec.lead}`);
    assert.equal(lead.status, 200);
    const body = JSON.parse(lead.text);
    assert.equal(body.mobile, rec.mobile, 'Marketing\'s lead detail masks the mobile');
    const list = await as(MARKETING)('GET', `/api/lists/${rec.list}`);
    assert(list.text.includes(rec.mobile), 'Marketing\'s list masks the mobile');
  });

  const setPolicy = (value) => fetch(`${BASE}/api/setup/policies/${encodeURIComponent(POLICY)}`, {
    method: 'PUT', headers: ADMIN.headers, body: JSON.stringify({ value }),
  });

  await test('Marketing may export a list with identifiers in the clear while the policy says unmasked', async () => {
    assert.equal((await setPolicy('unmasked')).status, 200);
    const rec = marketingRec;
    assert(rec, 'Marketing has no planted list');
    const res = await as(MARKETING)('POST', `/api/lists/${rec.list}/export`, { unmask: true, columns: ['name', 'mobile', 'email'] });
    assert.equal(res.status, 200, `export answered ${res.status}: ${res.text.slice(0, 160)}`);
    assert(res.text.includes(rec.mobile), 'the clear export is masked');
  });

  await test('with the policy set to masked, Marketing\'s clear export is refused and a masked one still works', async () => {
    assert.equal((await setPolicy('masked')).status, 200);
    const rec = marketingRec;
    assert(rec, 'Marketing has no planted list');
    const refused = await as(MARKETING)('POST', `/api/lists/${rec.list}/export`, { unmask: true, columns: ['name', 'mobile'] });
    assert.equal(refused.status, 403, `a clear export was allowed (${refused.status})`);
    assert.match(refused.text, /business policy/);
    const maskedExport = await as(MARKETING)('POST', `/api/lists/${rec.list}/export`, { columns: ['name', 'mobile'] });
    assert.equal(maskedExport.status, 200);
    assert(!maskedExport.text.includes(rec.mobile), 'the masked export carries the number');
    const leads = await as(MARKETING)('POST', '/api/leads/export?unmask=true', { columns: ['name', 'mobile'] });
    assert.equal(leads.status, 403, `the lead export ignored the policy (${leads.status})`);
  });

  await test('the policy holds only Marketing: an Admin\'s clear export is unaffected', async () => {
    const rec = planted[0];
    const res = await as(ADMIN)('POST', `/api/lists/${rec.list}/export`, { unmask: true, columns: ['name', 'mobile'] });
    assert.equal(res.status, 200, `answered ${res.status}: ${res.text.slice(0, 160)}`);
  });

  await test('the policy is an Admin\'s to change, and is on the Business policies screen', async () => {
    const list = await fetch(`${BASE}/api/setup/policies`, { headers: ADMIN.headers }).then((r) => r.json());
    const p = list.policies.find((x) => x.key === POLICY);
    assert(p, 'the export policy is not listed');
    assert.deepEqual(p.options.map((o) => o.value), ['unmasked', 'masked']);
    const marketing = await fetch(`${BASE}/api/setup/policies/${encodeURIComponent(POLICY)}`, {
      method: 'PUT', headers: MARKETING.headers, body: JSON.stringify({ value: 'unmasked' }),
    });
    assert.equal(marketing.status, 403, 'Marketing changed its own export policy');
  });
} finally {
  run('DELETE FROM business_policy WHERE key = ?', [POLICY]);
  if (saved) run('INSERT INTO business_policy (key, value, updated_by, updated_at) VALUES (?,?,?,?)', [saved.key, saved.value, saved.updated_by, saved.updated_at]);
  for (const r of planted) {
    run('DELETE FROM kyc_journeys WHERE id = ?', [r.journey]);
    run('DELETE FROM tickets WHERE id = ?', [r.ticket]);
    run('DELETE FROM lead_lists WHERE id = ?', [r.list]);
    run('DELETE FROM activities WHERE lead_id = ?', [r.lead]);
    run('DELETE FROM leads WHERE id = ?', [r.lead]);
  }
  for (const p of [CALLER, DEALER, MARKETING, ADMIN]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
