/**
 * A2d: the role × business matrix -- every guarded route, every role, both
 * businesses, at the API.
 *
 * The QA handoff's P0 gate (§1, §5, §6): "direct API allow/deny tests for
 * every role and business", covering allowed, denied and masked values. The
 * routes and their guards are read from the source, the roles from the access
 * model, and what each role holds from the grants Setup holds (role grants
 * and permission sets) -- so the matrix is the configuration, and this asks
 * the running server whether it enforces it:
 *
 *   denied    every role lacking what a route's guard asks is refused, and
 *             refused by the guard (a 403 naming what is required), in both
 *             businesses -- for reads and writes alike; a write never runs,
 *             because the guard stands before it
 *   allowed   every role holding it gets past the guard on a read (writes are
 *             not sent by those who could make them)
 *   books     no role in either business is listed the other business's
 *             records, on any list of business records
 *   masked    every role in both businesses is shown a lead's mobile and email
 *             masked exactly where its masking says so
 *   open      every write route with no capability guard is named in
 *             OPEN_WRITES with the reason it is open to any signed-in user --
 *             a new one fails until somebody guards it or says why not
 *   figures   no scorecard counts the other business's cases, partners or KYC
 *             applications
 *   partner   the partner role: a partner signed in on the portal reaches no
 *             CRM route, no CRM role reaches the portal, and a partner sees
 *             only their own referrals, cases and commissions -- for a
 *             partner in each business
 *
 * And what the sweep found and fixed, each proved against the code before:
 * the KYC stall sweep pressed by anybody, across both businesses; the flow
 * guard acting before the capability check; and bulk moves of leads and
 * accounts filed against a record that shared the new owner's id, so the
 * other business decided them.
 *
 * Exported values are the guarded export routes (denied, above) and, for
 * what an export carries, exportrights.test.mjs and piimasking.test.mjs.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { SEED_ROLES, effectiveCapabilities, isApiOnly } from '../src/engine/access.js';
import { maskedFieldsFor } from '../src/engine/masking.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import { MOUNTS, ROUTES } from './helpers/routemap.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

/* ------------------------------------------------- the routes and guards */

/** A guard every route of a file passes through, before its own. */
const ROUTER_LEVEL = {
  'clients.js': [['client.view.all', 'client.view.own']],
};

/**
 * Every route with a capability guard, as { method, path, sets }: each set is
 * one guard, satisfied by any capability in it, and a route needs them all.
 */
function guardedRoutes() {
  const out = [];
  for (const [file, map] of Object.entries(MOUNTS)) {
    const src = readFileSync(join(ROUTES, file), 'utf8').replace(/\r\n/g, '\n');
    const defs = [...src.matchAll(/(\w+)\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)].filter((m) => m[1] in map);
    defs.forEach((m, i) => {
      const tail = src.slice(m.index + m[0].length, i + 1 < defs.length ? defs[i + 1].index : src.length);
      const cut = tail.search(/=>|\bfunction\b/);
      const head = cut >= 0 ? tail.slice(0, cut) : tail;
      const sets = [...(ROUTER_LEVEL[file] ?? [])];
      for (const g of head.matchAll(/requirePermission\('([^']+)'\)/g)) sets.push([g[1]]);
      for (const g of head.matchAll(/requireAnyPermission\(([^)]*)\)/g)) sets.push([...g[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
      if (/\brequireShared\b/.test(head)) sets.push(['setup.shared']);
      if (file === 'messages.js' && /\breviewer\b/.test(head)) sets.push(['comms.monitor']);
      if (file === 'messages.js' && /\bgridAdmin\b/.test(head)) sets.push(['admin.roles']);
      if (!sets.length) return;
      out.push({ method: m[2].toUpperCase(), path: (map[m[1]] + m[3]).replace(/\/$/, '') || '/', sets });
    });
  }
  return out;
}

const satisfies = (caps, sets) => sets.every((set) => set.some((c) => caps.has(c)));
const concrete = (path) => path.replace(/:\w+/g, '0');

/**
 * Every route of every router that admits only a CRM session -- it calls
 * `<router>.use(requireUser)` before any route of its own -- as
 * { method, path }. A route defined above that line would be public, so it is
 * left out rather than assumed.
 */
function crmSessionRoutes() {
  const out = [];
  for (const [file, map] of Object.entries(MOUNTS)) {
    const src = readFileSync(join(ROUTES, file), 'utf8').replace(/\r\n/g, '\n');
    for (const [variable, mount] of Object.entries(map)) {
      const gate = src.search(new RegExp(`^${variable}\\.use\\(requireUser\\)`, 'm'));
      if (gate < 0) continue;
      for (const m of src.matchAll(new RegExp(`^${variable}\\.(get|post|put|patch|delete)\\(\\s*'([^']*)'`, 'gm'))) {
        if (m.index > gate) out.push({ method: m[1].toUpperCase(), path: (mount + m[2]).replace(/\/$/, '') || '/' });
      }
    }
  }
  return out;
}

/** The partner portal's own routes. */
const portalRoutes = () => {
  const src = readFileSync(join(ROUTES, 'portal.js'), 'utf8');
  return [...src.matchAll(/^router\.(get|post|put|patch|delete)\(\s*'([^']*)'/gm)]
    .map((m) => ({ method: m[1].toUpperCase(), path: `/api/portal${m[2]}`.replace(/\/$/, '') }));
};

/* ------------------------- writes open to any signed-in user, and why */

const RECORD_EDIT = 'A lead\'s edit: loaded through its business (loadInBook); read-only roles are refused, a stage change needs lead.stage.change and a new owner lead.reassign -- checked inside, field by field.';
const CARD_MOVE = 'A product card\'s move: loaded through its business (loadInBook); each move needs the capability MOVE_NEEDS names for the state, checked inside.';
const CASE_EDIT = 'A case\'s edit: loaded through its business (loadInBook); a new assignee needs ticket.reassign, and a resolved or closed case\'s details do not change.';
const ON_A_RECORD = 'A note or a correction: held to its lead\'s or partner\'s business and the reader\'s visibility (loadInBook, reqScope); a correction to its author\'s rules (mayCorrect).';
const AI_DISPOSITION = 'An AI disposition on a lead: the lead is loaded through its business (loadInBook, OPS-18).';
const COPILOT = 'A question to the copilot, answered from the reader\'s own scope.';
const TASK_NEW = 'Any signed-in user may add a task; every record it links is checked against their books (QA-08).';
const TASK_RULE = 'One rule for changing a task, engine/taskaccess.js (A12): its books, and its assignee, its creator or a team manager.';
const APPROVAL_RAISE = 'Raising an approval: each kind\'s capability to ask is checked inside (REQUEST_CAP), and its record is read in the asker\'s books (a partner since OPS-25; a lead or an account since A2d).';
const APPROVAL_DECIDE = 'Deciding or withdrawing: the request\'s business first (inReach, A2b), then who may decide (the approver\'s capability, never one\'s own request) or withdraw (only who asked).';
const OWN = 'The reader\'s own: their attendance, their Outlook calendar, their notifications, their column and screen preferences, leaving a ghost session, a saved search they made.';
const DASHBOARD = 'A dashboard is its owner\'s: only the owner changes it, sharing one needs report.team, and every panel is computed through the viewer\'s own scope.';
const LIBRARY = 'A content library and its items: managed by the owning role or admin.content, in the library\'s and the item\'s business (mayManage, mayManageItem -- N-12).';
const LIST = 'A lead list\'s rules: reading needs mayReadList (its business first, then owner or sharing), changing it mayWriteList (owner, creator or an Admin, in its business -- N-12); members are leads the reader may see.';
const MESSAGE = 'A conversation between colleagues: membership, and for a new one the who-may-message-whom grid, decide inside the messaging engine; the writes by id are probed as the other business in bookscopewrites.test.mjs.';
const LOOKUP = 'An exact, audited, rate-limited lookup of a lead by its identifier, so an RM may name a lead to a colleague (P3-21).';
const TRANSFER = 'Asking a colleague for a lead: a request the lead\'s owner decides (lead_transfer); nothing moves until they approve.';
const SEARCH = 'The parameter is an object type; every entity is scoped to the reader where the search is built (scopeFor).';
const SEARCH_EXPORT = 'Export through advanced search: scoped as the search, and it checks export.<object> for the entity inside.';
const DKYC = 'Public KYC: the resume token is the credential; there is no CRM session.';
const PORTAL = 'Partner portal: signs in as a partner, and each route matches that partner\'s own records.';
const WEBHOOK = 'An inbound vendor webhook, authenticated by the vendor\'s signature (guard and verifyWebhook), not a CRM session.';

/** Every write route without a capability guard, and why that is right. */
const OPEN_WRITES = {
  'POST /api/activities/:id/correct': ON_A_RECORD,
  'POST /api/ai/copilot': COPILOT,
  'POST /api/ai/disposition': AI_DISPOSITION,
  'POST /api/ai/disposition/confirm': AI_DISPOSITION,
  'POST /api/approvals': APPROVAL_RAISE,
  'POST /api/approvals/:id/decide': APPROVAL_DECIDE,
  'POST /api/approvals/:id/withdraw': APPROVAL_DECIDE,
  'POST /api/attendance/check-in': OWN,
  'POST /api/attendance/check-out': OWN,
  'POST /api/calendar/sync': OWN,
  'POST /api/cards/:id/state': CARD_MOVE,
  'POST /api/dashboards': DASHBOARD,
  'DELETE /api/dashboards/:id': DASHBOARD,
  'PATCH /api/dashboards/:id': DASHBOARD,
  'POST /api/dashboards/:id/panels': DASHBOARD,
  'DELETE /api/dashboards/:id/panels/:panelId': DASHBOARD,
  'PATCH /api/dashboards/:id/panels/:panelId': DASHBOARD,
  'POST /api/dashboards/preview': DASHBOARD,
  'PATCH /api/leads/:id': RECORD_EDIT,
  'PATCH /api/libraries/:id': LIBRARY,
  'POST /api/libraries/:id/items': LIBRARY,
  'PATCH /api/libraries/items/:itemId': LIBRARY,
  'POST /api/libraries/items/:itemId/status': LIBRARY,
  'POST /api/libraries/items/:itemId/versions': LIBRARY,
  'DELETE /api/lists/:id': LIST,
  'PATCH /api/lists/:id': LIST,
  'POST /api/lists/:id/archive': LIST,
  'POST /api/lists/:id/bulk/membership': LIST,
  'POST /api/lists/:id/bulk/task': LIST,
  'PATCH /api/lists/:id/columns': LIST,
  'POST /api/lists/:id/import': LIST,
  'POST /api/lists/:id/members': LIST,
  'DELETE /api/lists/:id/members/:leadId': LIST,
  'POST /api/lists/:id/preview': LIST,
  'POST /api/lists/:id/refresh': LIST,
  'POST /api/lists/:id/restore': LIST,
  'POST /api/messages/channels': MESSAGE,
  'POST /api/messages/channels/:id/archive': MESSAGE,
  'POST /api/messages/channels/:id/join': MESSAGE,
  'POST /api/messages/channels/:id/leave': MESSAGE,
  'POST /api/messages/channels/:id/members': MESSAGE,
  'DELETE /api/messages/channels/:id/members/:userId': MESSAGE,
  'POST /api/messages/channels/:id/unarchive': MESSAGE,
  'POST /api/messages/conversations': MESSAGE,
  'POST /api/messages/conversations/:id/files': MESSAGE,
  'POST /api/messages/conversations/:id/messages': MESSAGE,
  'POST /api/messages/conversations/:id/read': MESSAGE,
  'POST /api/messages/lookup': LOOKUP,
  'POST /api/messages/message/:id/react': MESSAGE,
  'POST /api/messages/message/:id/withdraw': MESSAGE,
  'POST /api/messages/transfer': TRANSFER,
  'POST /api/notes': ON_A_RECORD,
  'POST /api/notes/:id/correct': ON_A_RECORD,
  'POST /api/notes/:id/pin': ON_A_RECORD,
  'POST /api/notifications/:id/read': OWN,
  'POST /api/notifications/read-all': OWN,
  'PATCH /api/portal/profile': PORTAL,
  'POST /api/portal/referrals': PORTAL,
  'POST /api/portal/tickets': PORTAL,
  'POST /api/portal/tickets/:id/replies': PORTAL,
  'POST /api/portal/tickets/:id/csat': PORTAL,
  'POST /api/portal/training/:module/complete': PORTAL,
  'POST /api/search-advanced/:entity': SEARCH,
  'POST /api/search-advanced/:entity/count': SEARCH,
  'POST /api/search-advanced/:entity/export': SEARCH_EXPORT,
  'POST /api/search-advanced/:entity/ids': SEARCH,
  'DELETE /api/search-advanced/saved/:id': OWN,
  'DELETE /api/setup/columns/:list': OWN,
  'PUT /api/setup/columns/:list': OWN,
  'POST /api/setup/ghost/exit': OWN,
  'PUT /api/setup/preferences/:key': OWN,
  'POST /api/tasks': TASK_NEW,
  'PATCH /api/tasks/:id': TASK_RULE,
  'POST /api/tasks/:id/cancel': TASK_RULE,
  'PATCH /api/tickets/:id': CASE_EDIT,
  'POST /dkyc-api/resume/:token/otp': DKYC,
  'POST /dkyc-api/resume/:token/step': DKYC,
  'POST /dkyc-api/start': DKYC,
  'POST /api/webhooks/bonanza-kyc/status': WEBHOOK,
  'POST /api/webhooks/meta': WEBHOOK,
  'POST /api/webhooks/quickcall/call': WEBHOOK,
  'POST /api/webhooks/smartping/whatsapp': WEBHOOK,
};

/* ---------------------------------------------- a reader per role, per book */

const BOOKS = ['BONANZA', 'BIGUL'];
const ROLES = SEED_ROLES.map((r) => r[0]).filter((code) => !isApiOnly(code));
const readers = [];
for (const role of ROLES) {
  for (const org of BOOKS) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await probeAdmin(`matrix-${role}-${org.toLowerCase()}`, { role, sales_org: org });
    const row = one('SELECT * FROM users WHERE id = ?', [probe.id]);
    readers.push({ role, org, probe, caps: effectiveCapabilities(row) });
  }
}

const reader = (role, org) => readers.find((w) => w.role === role && w.org === org);

/* The partner role: a partner in each business, signed in on the portal, with
   a referral, a case and a commission of their own. A session is written the
   way the portal's sign-in writes one, so no password is involved. */
const partners = [];
const own = { partners: [], leads: [], tickets: [], commissions: [], sessions: [] };
const insert = (table, cols) => {
  const keys = Object.keys(cols);
  const id = Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(cols)).lastInsertRowid);
  own[table].push(id);
  return id;
};
for (const org of BOOKS) {
  const id = insert('partners', { name: `Matrix partner ${org}`, sales_org: org, state_code: 'ACTIVE' });
  const stamp = String(Date.now()).slice(-6);
  const lead = insert('leads', { name: `Matrix referral ${org}`, mobile: `6${stamp}${org === 'BIGUL' ? '02' : '01'}0`, source: 'Partner', stage: 'New', sales_org: org, partner_id: id });
  const ticket = insert('tickets', { subject: `Matrix partner case ${org}`, sales_org: org, partner_id: id });
  const commission = insert('commissions', { partner_id: id, lead_id: lead, period: '2026-11', gross: 100, payout: 10 });
  const token = `matrix-partner-${org.toLowerCase()}-${stamp}`;
  run("INSERT INTO sessions (token, partner_id, kind, expires_at, last_seen_at) VALUES (?,?,'partner',datetime('now','+1 hours'),datetime('now'))", [token, id]);
  own.sessions.push(token);
  partners.push({ org, id, lead, ticket, commission, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
}
const dropPartners = () => {
  for (const token of own.sessions) run('DELETE FROM sessions WHERE token = ?', [token]);
  for (const table of ['commissions', 'tickets', 'leads', 'partners']) {
    if (own[table].length) run(`DELETE FROM ${table} WHERE id IN (${own[table].map(() => '?').join(',')})`, own[table]);
  }
};

/** A request as a partner signed in on the portal. */
const asPartner = async (partner, method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: partner.headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json };
};

/** A request with a body, as the screens send it. */
const send = async (who, method, path, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: who.probe.headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json };
};

const call = async (who, method, path) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: who.probe.headers,
    body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
  });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
};

/* ----------------------------------------------------------------- tests */

console.log(`\nA2d: the role × business matrix -- ${ROLES.length} roles and the partner role × ${BOOKS.length} businesses`);

const ROUTES_GUARDED = guardedRoutes();

try {
  await test(`every role lacking a route's guard is refused by it, in both businesses (${ROUTES_GUARDED.length} guarded routes)`, async () => {
    const problems = [];
    for (const who of readers) {
      const pending = ROUTES_GUARDED.filter((r) => !satisfies(who.caps, r.sets));
      for (let i = 0; i < pending.length; i += 25) {
        // eslint-disable-next-line no-await-in-loop
        const results = await Promise.all(pending.slice(i, i + 25).map(async (r) => ({ r, out: await call(who, r.method, concrete(r.path)) })));
        for (const { r, out } of results) {
          if (out.status !== 403 || !out.body?.required) {
            problems.push(`${who.role}@${who.org} ${r.method} ${r.path} → HTTP ${out.status} (needs ${r.sets.map((s) => s.join('|')).join(' + ')}): ${JSON.stringify(out.body).slice(0, 90)}`);
          }
        }
      }
    }
    assert.equal(problems.length, 0, `a role without the capability was not refused by the guard:\n${problems.slice(0, 40).map((p) => `         ${p}`).join('\n')}${problems.length > 40 ? `\n         ... and ${problems.length - 40} more` : ''}`);
  });

  await test('every role holding a read\'s guard gets past it, in both businesses', async () => {
    const problems = [];
    for (const who of readers) {
      const reads = ROUTES_GUARDED.filter((r) => r.method === 'GET' && satisfies(who.caps, r.sets));
      for (let i = 0; i < reads.length; i += 25) {
        // eslint-disable-next-line no-await-in-loop
        const results = await Promise.all(reads.slice(i, i + 25).map(async (r) => ({ r, out: await call(who, 'GET', concrete(r.path)) })));
        for (const { r, out } of results) {
          if ((out.status === 403 && out.body?.required) || out.status >= 500) {
            problems.push(`${who.role}@${who.org} GET ${r.path} → HTTP ${out.status}: ${JSON.stringify(out.body).slice(0, 90)}`);
          }
        }
      }
    }
    assert.equal(problems.length, 0, `a role holding the capability was refused, or the read broke:\n${problems.slice(0, 40).map((p) => `         ${p}`).join('\n')}${problems.length > 40 ? `\n         ... and ${problems.length - 40} more` : ''}`);
  });

  await test('every write route with no capability guard says why it is open to any signed-in user', () => {
    const src = (file) => readFileSync(join(ROUTES, file), 'utf8').replace(/\r\n/g, '\n');
    const open = [];
    for (const [file, map] of Object.entries(MOUNTS)) {
      const text = src(file);
      const defs = [...text.matchAll(/(\w+)\.(post|put|patch|delete|get)\(\s*'([^']*)'/g)].filter((m) => m[1] in map);
      defs.forEach((m, i) => {
        if (m[2] === 'get') return;
        const tail = text.slice(m.index + m[0].length, i + 1 < defs.length ? defs[i + 1].index : text.length);
        const cut = tail.search(/=>|\bfunction\b/);
        const head = cut >= 0 ? tail.slice(0, cut) : tail;
        const guarded = ROUTER_LEVEL[file] || /requirePermission\(|requireAnyPermission\(|requireShared|\breviewer\b|\bgridAdmin\b/.test(head);
        if (!guarded) open.push(`${m[2].toUpperCase()} ${(map[m[1]] + m[3]).replace(/\/$/, '')}`);
      });
    }
    const unsaid = open.filter((k) => !(k in OPEN_WRITES));
    assert.equal(unsaid.length, 0, `these writes take no capability and nobody has said why:\n${unsaid.map((k) => `         ${k}`).join('\n')}\n       Guard each, or add it to OPEN_WRITES in test/rolematrix.test.mjs with the reason.`);
    const stale = Object.keys(OPEN_WRITES).filter((k) => !open.includes(k));
    assert.equal(stale.length, 0, `these OPEN_WRITES entries no longer match an unguarded route:\n${stale.map((k) => `         ${k}`).join('\n')}`);
  });

  await test('a bulk move is never asked for with a hand-made list of records (A2d)', async () => {
    /* Raised only by the bulk screens, which choose the records through the
       asker's own filter and leave behind any outside the new owner's
       business. Through here it carried whatever ids it was sent. */
    const admin = reader('admin', 'BIGUL');
    const bonanzaLead = one("SELECT id FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL ORDER BY id LIMIT 1").id;
    const before = one('SELECT COUNT(*) n FROM approvals').n;
    for (const [scope, key] of [['bulk_reassign', 'lead_ids'], ['bulk_client_reassign', 'client_ids']]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await send(admin, 'POST', '/api/approvals', {
        scope, entity_id: admin.probe.id, payload: { [key]: [bonanzaLead], owner_id: admin.probe.id }, reason: 'A list made by hand',
      });
      assert.equal(out.status, 400, `${scope}: HTTP ${out.status} ${JSON.stringify(out.body)}`);
      assert.match(String(out.body?.error), /is raised from/, `${scope}: refused for another reason: ${out.body?.error}`);
    }
    assert.equal(one('SELECT COUNT(*) n FROM approvals').n, before, 'a request was recorded');
  });

  await test('a bulk move waits on the new owner\'s business, and only that business decides it (A2d)', async () => {
    /* An owner whose user id is also a lead's in the other business: a request
       filed against "lead <their id>" was that business's to see and decide. */
    const owner = one(`SELECT u.id FROM users u JOIN leads l ON l.id = u.id
      WHERE u.active = 1 AND u.sales_org = 'BIGUL' AND l.sales_org = 'BONANZA' ORDER BY u.id LIMIT 1`);
    assert.ok(owner, 'no Bigul user shares an id with a Bonanza lead, so this would prove nothing');
    const raiser = reader('admin', 'BIGUL');
    const decider = reader('sales_supervisor', 'BIGUL');
    const outsiders = [reader('admin', 'BONANZA'), reader('sales_supervisor', 'BONANZA')];
    const threshold = (await send(raiser, 'GET', '/api/leads/bulk/options')).body?.bulk_threshold;
    assert.ok(threshold > 0, 'no bulk threshold');

    const stamp = String(Date.now()).slice(-6);
    const ids = Array.from({ length: threshold }, (_, i) => Number(run(
      "INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id) VALUES (?,?,'Referral','New','BIGUL',?)",
      [`Matrix bulk move ${i}`, `8${stamp}${String(i).padStart(3, '0')}`, raiser.probe.id],
    ).lastInsertRowid));
    let requestId = null;
    try {
      const raised = await send(raiser, 'POST', '/api/leads/bulk/field', {
        field: 'owner_id', value: owner.id, mode: 'ids', ids, reason: 'Cover while away',
      });
      assert.equal(raised.status, 202, `HTTP ${raised.status} ${JSON.stringify(raised.body)}`);
      requestId = raised.body.request_id;

      for (const who of outsiders) {
        // eslint-disable-next-line no-await-in-loop
        const queue = (await send(who, 'GET', '/api/approvals')).body;
        assert.ok(!queue.waiting_on_me.some((r) => r.id === requestId), `${who.role}@${who.org} is asked to decide it`);
        // eslint-disable-next-line no-await-in-loop
        const tried = await send(who, 'POST', `/api/approvals/${requestId}/decide`, { approve: true, reason: 'Not ours' });
        assert.equal(tried.status, 404, `${who.role}@${who.org} deciding: HTTP ${tried.status} ${JSON.stringify(tried.body)}`);
      }
      const theirs = (await send(decider, 'GET', '/api/approvals')).body.waiting_on_me.find((r) => r.id === requestId);
      assert.ok(theirs?.can_decide, `${decider.role}@${decider.org} is not asked to decide it`);

      // One lead moves to the other business while it waits: the decision does not carry it across.
      run("UPDATE leads SET sales_org = 'BONANZA' WHERE id = ?", [ids[0]]);
      const decided = await send(decider, 'POST', `/api/approvals/${requestId}/decide`, { approve: true, reason: 'Agreed' });
      assert.equal(decided.status, 200, `HTTP ${decided.status} ${JSON.stringify(decided.body)}`);
      const owners = ids.map((id) => one('SELECT owner_id FROM leads WHERE id = ?', [id]).owner_id);
      assert.equal(owners[0], raiser.probe.id, 'the lead that left the business was moved with the rest');
      assert.ok(owners.slice(1).every((o) => o === owner.id), 'the leads in the business did not all move');
    } finally {
      if (requestId) run('DELETE FROM approvals WHERE id = ?', [requestId]);
      run(`DELETE FROM leads WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    }
  });

  await test('the KYC stall sweep is pressed only by those who manage KYC (A2d)', async () => {
    for (const who of readers) {
      // eslint-disable-next-line no-await-in-loop
      const out = await call(who, 'POST', '/api/kyc/sweep');
      if (who.caps.has('kyc.manage')) assert.notEqual(out.status, 403, `${who.role}@${who.org} was refused`);
      else assert.equal(out.body?.required, 'kyc.manage', `${who.role}@${who.org} ran it: HTTP ${out.status}`);
    }
  });

  await test('a write on a flow by someone without admin.rules is refused before anything happens (A2d)', async () => {
    /* The flow guard ran ahead of each route's capability check: it recorded a
       version under the asker's name, and told them an archived flow was
       archived. A flow that has run and has no version yet is the one it
       records a version for. */
    const now = one("SELECT datetime('now') t").t;
    const make = (extra) => Number(run(
      `INSERT INTO automation (name, sales_org, trigger_type, first_activated_at${extra ? ', archived_at' : ''})
       VALUES ('Matrix flow probe', 'BONANZA', 'lead.created', ?${extra ? ', ?' : ''})`,
      extra ? [now, now] : [now],
    ).lastInsertRowid);
    const live = make(false);
    const archived = make(true);
    const versions = () => one('SELECT COUNT(*) n FROM automation_versions WHERE automation_id IN (?,?)', [live, archived]).n;
    try {
      const problems = [];
      const outsiders = readers.filter((w) => w.org === 'BONANZA' && !w.caps.has('admin.rules'));
      assert.ok(outsiders.length > 0, 'every Bonanza role holds admin.rules, so this proves nothing');
      for (const who of outsiders) {
        for (const id of [live, archived]) {
          // eslint-disable-next-line no-await-in-loop
          const out = await call(who, 'POST', `/api/admin/automations/${id}/steps`);
          if (out.status !== 403 || out.body?.required !== 'admin.rules') {
            problems.push(`${who.role}@${who.org} ${id === live ? 'live' : 'archived'} flow → HTTP ${out.status}: ${JSON.stringify(out.body).slice(0, 90)}`);
          }
        }
      }
      assert.equal(versions(), 0, 'a refused request recorded a flow version');
      assert.equal(problems.length, 0, problems.join('\n         '));
    } finally {
      run('DELETE FROM automation_versions WHERE automation_id IN (?,?)', [live, archived]);
      run('DELETE FROM automation WHERE id IN (?,?)', [live, archived]);
    }
  });

  await test('no role in either business is listed the other business\'s records', async () => {
    const LISTS = {
      '/api/leads?limit=500': (r) => r.sales_org,
      '/api/clients?limit=500': (r) => r.sales_org,
      '/api/tickets?limit=500': (r) => r.sales_org,
      '/api/lists?limit=500': (r) => r.sales_org,
      '/api/partners?limit=500': (r) => r.sales_org,
      '/api/admin/templates?limit=500': (r) => r.sales_org,
      '/api/admin/automations': (r) => r.sales_org,
      '/api/admin/campaigns?limit=500': (r) => r.sales_org,
    };
    const problems = [];
    for (const who of readers.filter((w) => w.role !== 'superadmin')) {
      for (const [url, orgOf] of Object.entries(LISTS)) {
        // eslint-disable-next-line no-await-in-loop
        const out = await call(who, 'GET', url);
        if (out.status !== 200) continue;  // not theirs to list: the guard test covers it
        const rows = Array.isArray(out.body) ? out.body : (out.body?.rows ?? out.body?.items ?? out.body?.campaigns ?? []);
        const other = rows.find((row) => orgOf(row) && orgOf(row) !== who.org);
        if (other) problems.push(`${who.role}@${who.org} ${url} listed a ${orgOf(other)} row (#${other.id})`);
      }
    }
    assert.equal(problems.length, 0, problems.join('\n         '));
  });

  await test('no scorecard counts the other business\'s cases, partners or KYC applications (A2d)', async () => {
    /* Bonanza records each of these figures counts, all at once: a Bigul
       reader's scorecard must not move, and a Bonanza reader's must -- or the
       records were never countable and this proves nothing. */
    const SOURCES = ['cases_resolved', 'sla_breaches', 'csat', 'partners_active', 'partner_leads', 'onboarding_stalled', 'kyc_stalled'];
    const ROLES_MEASURED = ['customer_care', 'partner_rm', 'sales_supervisor'];
    const card = async (who) => Object.fromEntries(((await call(who, 'GET', '/api/kra')).body?.metrics ?? [])
      .filter((m) => SOURCES.includes(m.source)).map((m) => [m.source, m.actual]));
    const before = {};
    for (const role of ROLES_MEASURED) for (const org of BOOKS) {
      // eslint-disable-next-line no-await-in-loop
      before[`${role}@${org}`] = await card(reader(role, org));
    }

    const rm = reader('partner_rm', 'BONANZA').probe.id;
    const sup = reader('sales_supervisor', 'BONANZA').probe.id;
    const made = { tickets: [], partners: [], leads: [], kyc_journeys: [] };
    const make = (table, cols) => {
      const keys = Object.keys(cols);
      const id = Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(cols)).lastInsertRowid);
      made[table].push(id);
      return id;
    };
    const stamp = String(Date.now()).slice(-6);
    try {
      make('tickets', { subject: 'Matrix scorecard probe', sales_org: 'BONANZA', status: 'Resolved', resolved_at: one("SELECT datetime('now') t").t, csat: 1 });
      make('tickets', { subject: 'Matrix scorecard probe', sales_org: 'BONANZA', status: 'Open', breached: 1 });
      const partner = make('partners', { name: 'Matrix scorecard probe', sales_org: 'BONANZA', state_code: 'ACTIVE', owner_id: rm });
      make('partners', { name: 'Matrix scorecard probe', sales_org: 'BONANZA', state_code: 'ONBOARDING', owner_id: rm });
      make('leads', { name: 'Matrix scorecard probe', mobile: `7${stamp}001`, source: 'Referral', stage: 'New', sales_org: 'BONANZA', owner_id: sup, partner_id: partner });
      const lead = make('leads', { name: 'Matrix scorecard probe', mobile: `7${stamp}002`, source: 'Referral', stage: 'New', sales_org: 'BONANZA', owner_id: sup });
      const product = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1").id;
      make('kyc_journeys', { lead_id: lead, product_type_id: product, status: 'In Progress', started_at: one("SELECT datetime('now', '-8 days') t").t });

      const problems = [];
      for (const role of ROLES_MEASURED) for (const org of BOOKS) {
        const key = `${role}@${org}`;
        // eslint-disable-next-line no-await-in-loop
        const after = await card(reader(role, org));
        for (const [source, was] of Object.entries(before[key])) {
          const moved = after[source] !== was;
          if (org === 'BIGUL' && moved) problems.push(`${key} ${source} counted Bonanza's: ${was} → ${after[source]}`);
          if (org === 'BONANZA' && !moved) problems.push(`${key} ${source} did not count its own business's new record (${was}), so this proves nothing`);
        }
      }
      const looked = Object.values(before).reduce((n, c) => n + Object.keys(c).length, 0);
      assert.ok(looked >= SOURCES.length * 2, `only ${looked} figures were looked at`);
      assert.equal(problems.length, 0, problems.join('\n         '));
    } finally {
      for (const table of ['kyc_journeys', 'leads', 'partners', 'tickets']) {
        if (made[table].length) run(`DELETE FROM ${table} WHERE id IN (${made[table].map(() => '?').join(',')})`, made[table]);
      }
    }
  });

  await test('a partner signed in on the portal reaches no CRM route, in either business', async () => {
    const routes = crmSessionRoutes();
    assert.ok(routes.length > 400, `only ${routes.length} routes were found, so the inventory is broken`);
    const problems = [];
    for (const partner of partners) {
      for (let i = 0; i < routes.length; i += 25) {
        // eslint-disable-next-line no-await-in-loop
        const results = await Promise.all(routes.slice(i, i + 25).map(async (r) => ({ r, out: await asPartner(partner, r.method, concrete(r.path)) })));
        for (const { r, out } of results) {
          if (out.status !== 401) problems.push(`partner@${partner.org} ${r.method} ${r.path} → HTTP ${out.status}: ${JSON.stringify(out.body).slice(0, 80)}`);
        }
      }
    }
    assert.equal(problems.length, 0, `a partner session got past the CRM's sign-in:\n${problems.slice(0, 30).map((p) => `         ${p}`).join('\n')}`);
  });

  await test('no CRM role reaches the partner portal, in either business', async () => {
    const problems = [];
    for (const who of readers) {
      for (const r of portalRoutes()) {
        // eslint-disable-next-line no-await-in-loop
        const out = await call(who, r.method, concrete(r.path));
        if (out.status !== 401) problems.push(`${who.role}@${who.org} ${r.method} ${r.path} → HTTP ${out.status}`);
      }
    }
    /* A partner's password change sits outside the portal router, behind a
       limiter that counts every request from one address -- so it is asked
       once per business, not once per role, or the limiter answers first. */
    for (const org of BOOKS) {
      // eslint-disable-next-line no-await-in-loop
      const out = await call(reader('admin', org), 'POST', '/api/auth/partner-password');
      if (out.status !== 401) problems.push(`admin@${org} POST /api/auth/partner-password → HTTP ${out.status}`);
    }
    assert.equal(problems.length, 0, problems.slice(0, 30).join('\n         '));
  });

  await test('a partner is shown only their own referrals, cases and commissions, never another partner\'s', async () => {
    const problems = [];
    for (const me of partners) {
      const other = partners.find((p) => p !== me);
      // eslint-disable-next-line no-await-in-loop
      const dash = (await asPartner(me, 'GET', '/api/portal/dashboard')).body;
      const ids = (rows) => (rows ?? []).map((r) => r.id);
      if (!ids(dash?.sourced_leads).includes(me.lead)) problems.push(`partner@${me.org}: their own referral is not on their dashboard, so this proves nothing`);
      if (ids(dash?.sourced_leads).includes(other.lead)) problems.push(`partner@${me.org}: shown partner@${other.org}'s referral`);
      if (!ids(dash?.tickets).includes(me.ticket)) problems.push(`partner@${me.org}: their own case is not on their dashboard`);
      if (ids(dash?.tickets).includes(other.ticket)) problems.push(`partner@${me.org}: shown partner@${other.org}'s case`);
      if (ids(dash?.commissions).includes(other.commission)) problems.push(`partner@${me.org}: shown partner@${other.org}'s commission`);
      // eslint-disable-next-line no-await-in-loop
      const paid = (await asPartner(me, 'GET', '/api/portal/commissions')).body ?? [];
      if (ids(paid).includes(other.commission)) problems.push(`partner@${me.org}: /commissions lists partner@${other.org}'s`);
      for (const [method, path, body] of [
        ['GET', `/api/portal/tickets/${other.ticket}`],
        ['POST', `/api/portal/tickets/${other.ticket}/replies`, { body: 'Matrix probe' }],
        ['GET', `/api/portal/clients/${other.lead}`],
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const out = await asPartner(me, method, path, body);
        if (out.status !== 404) problems.push(`partner@${me.org} ${method} ${path} (partner@${other.org}'s) → HTTP ${out.status}`);
      }
    }
    const replies = one("SELECT COUNT(*) n FROM ticket_replies WHERE body = 'Matrix probe'").n;
    if (replies) problems.push(`${replies} reply was written on another partner's case`);
    assert.equal(problems.length, 0, problems.join('\n         '));
  });

  await test('a Partner RM\'s scorecard says what it counts, in both businesses (B22)', async () => {
    const SAYS = { partners_active: 'Partners with Active status.', onboarding_stalled: 'Partners still onboarding.' };
    for (const org of BOOKS) {
      // eslint-disable-next-line no-await-in-loop
      const metrics = (await call(reader('partner_rm', org), 'GET', '/api/kra')).body?.metrics ?? [];
      for (const [source, words] of Object.entries(SAYS)) {
        const m = metrics.find((x) => x.source === source);
        assert.ok(m, `partner_rm@${org} has no ${source} metric`);
        if (m.edited_at) continue;   // an Admin's own words stand
        assert.equal(m.description, words, `partner_rm@${org} ${source} says "${m.description}"`);
      }
    }
  });

  await test('every role in both businesses sees a lead\'s mobile and email masked exactly as its masking says', async () => {
    const problems = [];
    let looked = 0;
    for (const who of readers) {
      // eslint-disable-next-line no-await-in-loop
      const out = await call(who, 'GET', '/api/leads?limit=25');
      if (out.status !== 200) continue;
      const rows = Array.isArray(out.body) ? out.body : (out.body?.rows ?? []);
      const masked = maskedFieldsFor(who.role);
      for (const row of rows) {
        for (const field of ['mobile', 'email']) {
          const value = row[field];
          if (!value || String(value).length < 5) continue;
          looked += 1;
          const shown = String(value).includes('•');
          if (shown !== masked.has(field)) {
            problems.push(`${who.role}@${who.org} lead #${row.id} ${field}: ${shown ? 'masked' : 'in the clear'}, where its masking says ${masked.has(field) ? 'masked' : 'unmasked'}`);
            break;
          }
        }
      }
    }
    assert.ok(looked > 0, 'no lead values were looked at, so this proves nothing');
    assert.equal(problems.length, 0, problems.slice(0, 20).join('\n         '));
  });
} finally {
  for (const { probe } of readers) probe.cleanup();
  dropPartners();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
