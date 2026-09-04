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
import { one, all, run } from '../src/db.js';
import { RECORD_KINDS, loadInBook, reachable } from '../src/engine/bookscope.js';

/* Source read from disk, so line endings are whatever git checked out --
   CRLF on Windows. Every pattern below is written with \n, so normalise once
   here rather than in each assertion. */
const CRLF = /\r\n/g;

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
  'dashboards.js': { router: '/api/dashboards' },
  'library.js': { router: '/api/libraries' },
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
    const src = readFileSync(join(ROUTES, file), 'utf8').replace(CRLF, '\n');
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
  '/api/setup/objects/:entity/validation-rules': 'Validation rules for an entity type. Configuration, not a client record — a rule scoped to one business carries sales_org and is checked by mayUseOrg where it is written.',
  '/api/setup/columns/:list': 'A list name, not a record id. The setting is a display '
    + 'preference on tab_visibility keyed by role and user -- it decides which columns a '
    + 'person is shown, never which rows, so the book boundary does not arise. columns.test.mjs '
    + 'asserts the preference cannot reach client data or masking.',
  '/api/setup/columns/:list/roles': 'The column catalogue and its role defaults. Configuration, '
    + 'identical in both businesses.',
  '/api/setup/logs/:kind': 'A kind of log, not a record id. Rows inside are scoped to the reader entitlement by readLog, which is asserted in logs.test.mjs.',
  '/api/libraries/:id': 'A content library, not a client record. Readability is decided by owner_role and shared_with, and by sales_org where the library names one — asserted in library.test.mjs.',
  '/api/dashboards/:id': 'A dashboard definition. The panels inside it are scoped to whoever opens it, never to whoever built it.',
  '/api/setup/field-usage/:entity': 'Usage counts per field. Aggregate over configuration.',
  '/api/setup/objects/:entity/fields/:apiName/value-usage':
    'Record counts per picklist value. Both parameters are configuration api_names, not record ids. '
    + 'The counts themselves ARE scoped to the administrator\'s books inside valueUsage().',
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

/* -------------------------------------------------------- list routes */

/**
 * Routes that return many records rather than one.
 *
 * These were assumed filtered. Most were. `/api/tasks` was not: with
 * `all=true` a Bigul supervisor was returned every task in the system, forty
 * of them on Bonanza leads and each labelled with that client's name. Nothing
 * looked at it for weeks, because the record routes had a conformance test and
 * the list routes had an assumption.
 *
 * Each entry says which field on a returned row names the book it belongs to,
 * or how to resolve one. A route in neither list fails the classification test
 * below, exactly as record routes do.
 */
const LIST_ROUTES = {
  '/api/leads': { org: (r) => r.sales_org },
  '/api/clients': { org: (r) => r.sales_org },
  '/api/tickets': { org: (r) => r.sales_org },
  '/api/lists': { org: (r) => r.sales_org },
  '/api/partners': { org: (r) => r.sales_org },
  // A task inherits its lead's book, and a task with no lead has none.
  '/api/tasks': { query: 'all=true', viaLead: (r) => r.lead_id },
};

/** Routes that return many rows but not client records. */
const NOT_A_LIST_OF_RECORDS = {
  '/api/apps': 'The tabs this user may open. Navigation, not records.',
  '/api/calendar': 'Meetings and due work for the signed-in person only.',
  '/api/cockpit': 'Aggregate figures for the viewer, each already scoped where it is computed.',
  '/api/dashboard': 'Aggregates. Covered by suite 56, which checks each figure against its own drill-through.',
  '/api/dashboards': 'Saved dashboard DEFINITIONS, not their results. Every panel is run through the viewer own scope when they open it — panels.test.mjs asserts a supervisor and an RM get different numbers from the same shared dashboard.',
  '/api/libraries': 'Content libraries and the collateral in them. Not client records; readability is decided by owner_role, shared_with and sales_org.',
  '/api/kra': 'The viewer\'s own scorecard.',
  '/api/orgs': 'Which businesses this user may see. The answer to the scoping question, not a thing to scope.',
  '/api/products': 'The product catalogue. Firm-wide, identical in both books.',
  '/api/pipeline': 'Cards grouped by state, scoped through leadScope where it is built.',
  '/api/revenue': 'Aggregates, scoped where computed.',
  '/api/search': 'Cross-entity search, scoped per entity in the route.',
  '/api/team': 'Users and their numbers, not client records.',
  '/api/approvals': 'Guarded by inReach() per row; covered by the approvals suite.',
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


console.log('\nList routes');

await test('every list route is classified', () => {
  const live = new Set();
  for (const file of readdirSync(ROUTES)) {
    const map = MOUNTS[file];
    if (!map) continue;
    const src = readFileSync(join(ROUTES, file), 'utf8').replace(CRLF, '\n');
    for (const m of src.matchAll(/(\w+)\.get\(\s*'\/'/g)) {
      const mount = map[m[1]];
      if (mount) live.add(mount);
    }
  }

  const unclassified = [...live]
    .filter((r) => !(r in LIST_ROUTES) && !(r in NOT_A_LIST_OF_RECORDS));

  assert.equal(
    unclassified.length, 0,
    'these list routes are unclassified — say whether they return client records:\n'
      + unclassified.map((r) => `         ${r}`).join('\n')
      + '\n       Add each to LIST_ROUTES (with how to read its book) or'
      + ' NOT_A_LIST_OF_RECORDS (with a reason).',
  );
});

await test('no list route returns the other book', async () => {
  const bigul = await login('supervisor@bigul.test');
  const problems = [];

  // Which leads are Bonanza's, for the routes that inherit their book.
  const bonanzaLeads = new Set(
    all("SELECT id FROM leads WHERE sales_org='BONANZA' AND deleted_at IS NULL").map((r) => r.id),
  );

  for (const [route, spec] of Object.entries(LIST_ROUTES)) {
    const url = `${route}?limit=500${spec.query ? `&${spec.query}` : ''}`;
    const res = await fetch(`${BASE}${url}`, { headers: { Authorization: `Bearer ${bigul}` } });
    if (res.status === 403) continue;             // not entitled at all: fine
    if (!res.ok) { problems.push(`${url} → HTTP ${res.status}`); continue; }

    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.rows ?? body.items ?? []);

    for (const row of rows) {
      const org = spec.org ? spec.org(row) : null;
      if (org && org !== 'BIGUL') { problems.push(`${url} returned a ${org} row`); break; }

      if (spec.viaLead) {
        const leadId = spec.viaLead(row);
        if (leadId && bonanzaLeads.has(Number(leadId))) {
          problems.push(`${url} returned a row on a Bonanza lead (#${leadId})`);
          break;
        }
      }
    }
  }

  assert.equal(problems.length, 0, `a list route crosses the book boundary:\n         ${problems.join('\n         ')}`);
});

/* ---------------------------------------------------- the boundary on writes */

/**
 * A write is a way across the boundary too.
 *
 * Everything above this line is a GET, because the scanner that builds the
 * route list is `\w+\.get\(`. PATCH /admin/users/:id took name, role, active
 * and password by id and never asked which book the user was in -- so a Bigul
 * administrator, who cannot *see* a Bonanza user in the list because that query
 * is scoped, could still rename, re-role, disable or reset the password of one
 * by number. Ids are sequential.
 *
 * `/setup/users/:id` writes the same columns and has always checked. So have
 * ghost and reset-link. This endpoint was the one that did not, and no test
 * looked at it.
 *
 * There is no Bigul administrator in the seed, so one is made here: the hole
 * needed two books to have separate administrators, which is the arrangement
 * the books exist for.
 */

await test('a write cannot cross the book boundary', async () => {
  const victim = one("SELECT id, name, role, cube_campaign_id FROM users WHERE sales_org = 'BONANZA' AND role != 'superadmin' ORDER BY id LIMIT 1");
  assert(victim, 'no Bonanza user to aim at, so this proves nothing');

  /* Borrow a known-good hash rather than reimplement the KDF, so the seeded
     password works and the test says nothing about how hashing is done. */
  const seeded = one("SELECT password FROM users WHERE email = 'admin@bonanza.test'");
  assert(seeded, 'the seeded administrator is missing');

  const email = 'bookscope-probe@bigul.test';
  run('DELETE FROM users WHERE email = ?', [email]);
  run(`INSERT INTO users (name, email, password, role, sales_org, active)
       VALUES ('Bookscope Probe', ?, ?, 'admin', 'BIGUL', 1)`, [email, seeded.password]);

  try {
    const token = await login(email);
    const res = await fetch(`${BASE}/api/admin/users/${victim.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Renamed across the book', cube_campaign_id: 'BIGUL_QUEUE' }),
    });

    assert(res.status === 403 || res.status === 404,
      `a Bigul admin patched a Bonanza user and got HTTP ${res.status}`);

    // And nothing moved, which is the part that matters.
    const after = one('SELECT name, cube_campaign_id FROM users WHERE id = ?', [victim.id]);
    assert.equal(after.name, victim.name, 'the name was written across the boundary');
    assert(!after.cube_campaign_id,
      'a dialler campaign was set across the boundary -- those calls reach the switch');
  } finally {
    run('DELETE FROM users WHERE email = ?', [email]);

    /* Undo the write if it landed. When this test fails it fails *because* the
       patch succeeded, so leaving it in place would corrupt the seeded record
       and the next run would fail on the debris instead of the boundary. */
    run('UPDATE users SET name = ?, cube_campaign_id = ? WHERE id = ?',
      [victim.name, victim.cube_campaign_id ?? null, victim.id]);
  }
});

await test('a new user is created in the creator\'s own book', async () => {
  /* The same twin-endpoint problem as the write above, in the create path.
     POST /admin/users never named sales_org in its INSERT, so the column
     default applied and every user created anywhere became a Bonanza user --
     including the ones a Bigul administrator created, who then read the wrong
     book and vanished from their creator's own list. */
  const seeded = one("SELECT password FROM users WHERE email = 'admin@bonanza.test'");
  const admin = 'bookscope-creator@bigul.test';
  const made = 'bookscope-created@bigul.test';
  run('DELETE FROM users WHERE email IN (?,?)', [admin, made]);
  run(`INSERT INTO users (name, email, password, role, sales_org, active)
       VALUES ('Bookscope Creator', ?, ?, 'admin', 'BIGUL', 1)`, [admin, seeded.password]);

  try {
    const token = await login(admin);
    const res = await fetch(`${BASE}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Bookscope Created', email: made, role: 'sales_rm', password: 'bonanza' }),
    });
    assert.equal(res.status, 201, `creating a user returned HTTP ${res.status}`);

    const row = one('SELECT sales_org FROM users WHERE email = ?', [made]);
    assert(row, 'the user was not created');
    assert.equal(row.sales_org, 'BIGUL',
      `a Bigul administrator created a ${row.sales_org} user`);
  } finally {
    run('DELETE FROM users WHERE email IN (?,?)', [admin, made]);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);

// exitCode rather than process.exit(): calling exit() straight after the live
// HTTP probes tears down libuv handles mid-flight, and the runner dies with a
// UV assertion instead of reporting the result.
process.exitCode = failed ? 1 : 0;
