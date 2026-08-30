/**
 * Every record route must be classified, and every record route must hold the
 * book boundary.
 *
 * The August exposure was not nine hard bugs. It was one easy check, needed in
 * nine places, written in none of them — and nothing in the build noticed,
 * because the routes were correct in every other respect
 * (docs/security/CROSS-BOOK-EXPOSURE-2026-08.md).
 *
 * So this does not test a list of routes somebody remembered to add. It reads
 * every route taking a path parameter straight out of the source and demands
 * that each one be declared, here, as either:
 *
 *   RECORD    it loads a business record, and the boundary is probed live
 *   NOT       it does not, with a stated reason
 *
 * A new `/:id` route that is in neither list fails this test. The author has to
 * say which it is, and if they say RECORD the boundary is checked for them
 * whether or not they remembered to write the guard.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { one } from '../src/db.js';
import { RECORD_KINDS, loadInBook, reachable } from '../src/engine/bookscope.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(here, '..', 'src', 'routes');
const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

/* --------------------------------------------------- route → mount point */

const MOUNTS = {
  'activities.js': { router: '/api/activities' },
  'admin.js': { router: '/api/admin' },
  'ai.js': { router: '/api/ai' },
  'approvals.js': { router: '/api/approvals' },
  'calendar.js': { router: '/api/calendar' },
  'ccm.js': { router: '/api/ccm' },
  'clients.js': { router: '/api/clients' },
  'cockpit.js': { router: '/api/cockpit' },
  'crm.js': { router: '/api' },
  'dashboard.js': { router: '/api/dashboard' },
  'email.js': { router: '/api/email' },
  'kra.js': { router: '/api/kra' },
  'kyc.js': { internal: '/api/kyc', dkyc: '/dkyc-api' },
  'lists.js': { router: '/api/lists' },
  'market.js': { router: '/api/market', publicIndices: '/public/market' },
  'orgs.js': { router: '/api/orgs' },
  'partners.js': { router: '/api/partners' },
  'pipeline.js': { router: '/api/pipeline' },
  'portal.js': { router: '/api/portal' },
  'products.js': { router: '/api/products' },
  'reports.js': { router: '/api/reports' },
  'revenue.js': { router: '/api/revenue' },
  'search-advanced.js': { router: '/api/search-advanced' },
  'search.js': { router: '/api/search' },
  'setup.js': { router: '/api/setup' },
  'team.js': { router: '/api/team' },
  'tickets.js': { router: '/api/tickets' },
  'webhooks.js': { router: '/api/webhooks' },
};

/** Every GET route in the codebase that takes a path parameter. */
function paramRoutes() {
  const found = [];
  for (const file of readdirSync(ROUTES)) {
    const map = MOUNTS[file];
    if (!map) continue;
    const src = readFileSync(join(ROUTES, file), 'utf8');
    for (const m of src.matchAll(/(\w+)\.get\(\s*'([^']*)'/g)) {
      const [, variable, path] = m;
      if (!(variable in map) || !path.includes(':')) continue;
      found.push({ file, path: (map[variable] + path).replace(/\/$/, '') });
    }
  }
  return found;
}

/* --------------------------------------------------------- the two lists */

/**
 * Routes that load a business record. Each says how to get an id belonging to
 * BONANZA, so the probe can ask for it as a BIGUL user and demand a refusal.
 */
const RECORD = {
  '/api/leads/:id': 'lead',
  '/api/activities/lead/:id': 'lead',
  '/api/ai/leads/:id/next-action': 'lead',
  '/api/email/compose/:leadId': 'lead',
  '/api/market/context/:leadId': 'lead',
  '/api/clients/:id': 'client',
  '/api/tickets/:id': 'ticket',
  '/api/lists/:id': 'list',
  '/api/partners/:id': 'partner',
  '/api/partners/:id/insight': 'partner',
  '/api/cards/:id/detail': 'card',
  '/api/cards/:id/audit': 'card',
  '/api/kyc/journeys/:id': 'journey',
  '/api/kyc/journeys/:id/coach': 'journey',
};

/** Routes that take a parameter but do not load a business record. */
const NOT_A_RECORD = {
  '/api/meta/fields/:entity': 'Field metadata for an entity type. Configuration, identical in both businesses.',
  '/api/setup/objects/:entity': 'Object definition. Configuration.',
  '/api/setup/objects/:entity/derivable': 'Formula sources for an entity type. Configuration.',
  '/api/setup/field-usage/:entity': 'Usage counts per field. Aggregate over configuration.',
  '/api/setup/history/:entity/:id': 'Field-change history; the underlying record is scoped where it is read.',
  '/api/setup/users/:id/access': 'A user, not a client record. Guarded by mayUseOrg on the user row.',
  '/api/setup/users/:id/tabs': 'As above.',
  '/api/search-advanced/fields/:entity': 'Searchable field list. Configuration.',
  '/api/search-advanced/saved/:entity': 'Saved searches, scoped to the owner.',
  '/api/admin/calendars/:kind/check': 'Working-calendar lookup. Firm-wide configuration.',
  '/api/admin/campaigns/:id/audience': 'Campaign audience; campaigns are org-scoped at the list route.',
  '/api/admin/connectors/meta/campaigns/:id/insights': 'Meta ad campaign, not a CRM record. Superadmin only.',
  '/api/admin/rules/:id/runs': 'Automation run history. Configuration, admin only.',
  '/api/admin/access-log/user/:id': 'Access-log rows for a user. Admin only; the log is not a client record.',
  '/api/admin/versions/:kind/:logicalId': 'Version history of a configurable artefact — a rule, template, journey or SLA policy. Configuration, identical across both businesses, admin only.',
  '/api/approvals/:id': 'Guarded by inReach() on the record the approval is about.',
  '/api/approvals/history/:entity/:id': 'Guarded by orgOf() on the record asked about.',
  '/api/approvals/scopes/:scope/approvers': 'Who may decide a scope. Configuration.',
  '/api/products/:id': 'A product type. Firm-wide catalogue, the same in both businesses.',
  '/api/queues/:id/work': 'Queue contents, scoped by the queue rules and by leadScope.',
  '/api/portal/clients/:leadId': 'Partner portal. Authenticates as a partner, not a CRM user.',
  '/api/portal/tickets/:id': 'Partner portal, as above.',
  '/api/portal/training/:module': 'Partner training content. Not a client record.',
  '/dkyc-api/resume/:token': 'Public KYC portal. The token is the credential; no CRM session.',
  '/dkyc-api/steps/:productId': 'Public KYC step list for a product. No client data.',
};

/* ------------------------------------------------------------- fixtures */

const login = async (email, password = 'bonanza') => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: HTTP ${res.status}`);
  return (await res.json()).token;
};

/** A BONANZA-owned id per record kind, read from the database, not an API. */
const bonanzaId = {
  lead: () => one("SELECT id FROM leads WHERE sales_org='BONANZA' AND deleted_at IS NULL ORDER BY id LIMIT 1")?.id,
  client: () => one("SELECT id FROM clients WHERE sales_org='BONANZA' AND deleted_at IS NULL ORDER BY id LIMIT 1")?.id,
  ticket: () => one("SELECT id FROM tickets WHERE sales_org='BONANZA' ORDER BY id LIMIT 1")?.id,
  list: () => one("SELECT id FROM lead_lists WHERE sales_org='BONANZA' ORDER BY id LIMIT 1")?.id,
  partner: () => one("SELECT id FROM partners WHERE sales_org='BONANZA' ORDER BY id LIMIT 1")?.id,
  card: () => one("SELECT pc.id FROM product_cards pc JOIN leads l ON l.id=pc.lead_id WHERE l.sales_org='BONANZA' ORDER BY pc.id LIMIT 1")?.id,
  journey: () => one("SELECT j.id FROM kyc_journeys j JOIN leads l ON l.id=j.lead_id WHERE l.sales_org='BONANZA' ORDER BY j.id LIMIT 1")?.id,
};

/* ---------------------------------------------------------------- tests */

console.log('\nBook scope conformance');

await test('every route taking a parameter is classified', () => {
  const unclassified = paramRoutes()
    .map((r) => r.path)
    .filter((p, i, a) => a.indexOf(p) === i)
    .filter((p) => !(p in RECORD) && !(p in NOT_A_RECORD));

  assert.equal(
    unclassified.length, 0,
    'these routes take a record id and nobody has said whether the book boundary applies:\n'
      + unclassified.map((p) => `         ${p}`).join('\n')
      + '\n       Add each to RECORD (with its kind) or NOT_A_RECORD (with a reason)'
      + ' in test/bookscope.test.mjs.',
  );
});

await test('every classified record route still exists', () => {
  // Catches the other drift: a route renamed or removed, leaving a stale
  // entry that quietly stops probing anything.
  const live = new Set(paramRoutes().map((r) => r.path));
  const stale = [...Object.keys(RECORD), ...Object.keys(NOT_A_RECORD)].filter((p) => !live.has(p));
  assert.equal(stale.length, 0, `these classifications no longer match a route:\n${stale.map((p) => `         ${p}`).join('\n')}`);
});

await test('every record route refuses the other book', async () => {
  const bigul = await login('rm.bookscope@bigul.test').catch(() => login('supervisor@bigul.test'));
  const problems = [];

  for (const [pattern, kind] of Object.entries(RECORD)) {
    const id = bonanzaId[kind]?.();
    if (id == null) { problems.push(`${pattern}: no BONANZA ${kind} in the seed to probe with`); continue; }

    const path = pattern.replace(/:[A-Za-z]+/, String(id));
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${bigul}` } });
    if (![403, 404].includes(res.status)) {
      // eslint-disable-next-line no-await-in-loop
      const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 120);
      problems.push(`${path} → HTTP ${res.status} (expected 403 or 404): ${body}`);
    }
  }

  assert.equal(problems.length, 0, `the book boundary does not hold:\n${problems.map((p) => `         ${p}`).join('\n')}`);
});

/* ------------------------------------------------- the accessor itself */

console.log('\nloadInBook');

await test('an unknown record kind is a loud failure, never a silent allow', () => {
  assert.throws(
    () => loadInBook({ user: { role: 'admin', sales_org: 'BONANZA' } }, 'nonsense', 1),
    /no record kind/,
  );
});

await test('a record from another book is refused, not returned', () => {
  const id = bonanzaId.ticket();
  if (id == null) return;
  const bigul = { user: { role: 'sales_rm', sales_org: 'BIGUL', org_access: null } };
  const out = loadInBook(bigul, 'ticket', id);
  assert.equal(out.row, undefined, 'the record came back anyway');
  assert.equal(out.status, 403);
  assert.match(out.error, /another book/);
});

await test('a record from your own book comes back, without the marker column', () => {
  const id = bonanzaId.ticket();
  if (id == null) return;
  const admin = { user: { role: 'admin', sales_org: 'BONANZA', org_access: null } };
  const out = loadInBook(admin, 'ticket', id);
  assert(out.row, `refused a record in the reader's own book: ${out.error}`);
  assert.equal(out.row.__org, undefined, 'the internal org marker leaked into the response');
  assert.equal(out.org, 'BONANZA');
});

await test('missing and malformed ids are told apart from a refusal', () => {
  const admin = { user: { role: 'admin', sales_org: 'BONANZA', org_access: null } };
  assert.equal(loadInBook(admin, 'ticket', 99999999).status, 404, 'a missing record should be 404');
  assert.equal(loadInBook(admin, 'ticket', 'abc').status, 400, 'a non-numeric id should be 400');
  assert.equal(loadInBook(admin, 'ticket', -1).status, 400, 'a negative id should be 400');
});

await test('a superadmin reaches both books', () => {
  const su = { user: { role: 'superadmin', sales_org: 'BONANZA', org_access: null } };
  for (const kind of ['lead', 'ticket', 'partner']) {
    const id = bonanzaId[kind]();
    if (id == null) continue;
    assert(loadInBook(su, kind, id).row, `superadmin was refused a ${kind}`);
  }
});

await test('reachable() answers the same question for a row already in hand', () => {
  const bigul = { user: { role: 'sales_rm', sales_org: 'BIGUL', org_access: null } };
  assert.equal(reachable(bigul, 'BONANZA'), false);
  assert.equal(reachable(bigul, 'BIGUL'), true);
  // A record with no business is nobody's to read.
  assert.equal(reachable(bigul, null), false, 'a record with no business was reachable');
});

await test('every record kind the accessor knows has a probe fixture', () => {
  // Keeps RECORD_KINDS and this suite from drifting apart: a kind added to the
  // accessor with no way to fetch a fixture is a kind nothing tests.
  const missing = Object.keys(RECORD_KINDS)
    .filter((k) => k !== 'card_audit_parent')
    .filter((k) => !(k in bonanzaId));
  assert.equal(missing.length, 0, `no fixture for: ${missing.join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);

// exitCode rather than process.exit(): calling exit() straight after the live
// HTTP probes tears down libuv handles mid-flight, and the runner dies with a
// UV assertion instead of reporting the result.
process.exitCode = failed ? 1 : 0;
