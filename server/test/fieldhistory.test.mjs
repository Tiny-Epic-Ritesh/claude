/**
 * D9 (OPS-64): every change to a history-tracked field is in its record's
 * history, by whichever path it is made -- and OPS-66: that history is read
 * the way the record is.
 *
 * Field history is non-negotiable 4, and stage entry and exit are read from
 * it. It was written only by the screens that remembered to: some forty other
 * writes changed a lead's owner or stage, a case's status or assignee, an
 * account's owner or status, a partner's or a product card's state, or a
 * task's status, and left no trace.
 *
 *   census     every UPDATE of a tracked table that touches a tracked column
 *              (or a column chosen at run time) goes through `tracked()` or
 *              writes `recordChange` itself, or says here why not
 *   behaviour  each path, driven as it is in production, leaves a history row
 *              with the right value, the right person and the right source
 *   reading    the history route answers only someone who may open the
 *              record, in its business, and masks what their role sees masked
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { TRACKED_TABLES, trackedColumns } from '../src/engine/history.js';
import { assignLead } from '../src/engine/assignment.js';
import { assignToQueue, claimFromQueue } from '../src/engine/queues.js';
import { runAction, leadFacts } from '../src/engine/rules.js';
import { runImport } from '../src/engine/leadimport.js';
import { planHandover, runHandover, undoHandover } from '../src/engine/handover.js';
import { applyEffects } from '../src/engine/dispositions.js';
import { createJourney, completeJourney } from '../src/engine/kyc.js';
import { TEST_KINDS } from '../src/engine/testrecords.js';
import { activatePartner } from '../src/routes/partners-support.js';
import { maskedFieldsFor } from '../src/engine/masking.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

/* ------------------------------------------------------------- census */

/**
 * Writes that change a tracked column and are right not to record it per
 * record, each with the reason. Keyed by file and the first words of the SET.
 */
const EXEMPT = {
  'engine/metadata.js|${apiName} = ?':
    'A Setup picklist merge rewrites one value to another across records. Ruled 19 Nov (D9): configuration, logged once '
    + 'in the configuration audit log with the number of records moved (`values_merged`), not a history row per record.',
};

const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
});

/** Every UPDATE of a tracked table, or of a table named at run time, with what it sets. */
function writesToTrackedTables() {
  const tables = new Map(Object.entries(TRACKED_TABLES).map(([entity, table]) => [table, entity]));
  const out = [];
  for (const file of files(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, '/');
    if (['seed.js', 'testdata.js'].includes(rel)) continue;   // building the demo, not changing a record
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/UPDATE\s+(\$\{[^}]+\}|\w+)\s+SET\s+([\s\S]*?)\bWHERE\b/g)) {
      const table = m[1];
      const dynamicTable = table.startsWith('${');
      if (!dynamicTable && !tables.has(table)) continue;
      const sets = m[2];
      const entity = tables.get(table);
      const cols = entity ? trackedColumns(entity) : [];
      /* A column named at run time: `${field} = ?`, or a list of assignments
         built in code. `deleted_at = ${now}` names its column; only the value
         is interpolated. */
      const dynamicColumn = /\$\{[^}]*\}\s*=/.test(sets) || /\$\{[^}]*\.join\(/.test(sets);
      const touches = dynamicColumn || cols.some((c) => new RegExp(`(^|[\\s,(])${c}\\s*=`).test(sets));
      if (!touches) continue;
      const near = src.slice(Math.max(0, m.index - 400), m.index + m[0].length + 400);
      out.push({
        where: `${rel}:${src.slice(0, m.index).split('\n').length}`,
        key: `${rel}|${sets.trim().split(/[\n,]/)[0].trim()}`,
        covered: /\btracked\(|\brecordChange\(/.test(near),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------ fixtures */

const START = one('SELECT COALESCE(MAX(id), 0) n FROM field_history').n;
const made = [];
const make = (table, cols) => {
  const keys = Object.keys(cols);
  const id = Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(cols)).lastInsertRowid);
  made.push([table, id]);
  return id;
};
const stamp = String(Date.now()).slice(-6);
let serial = 0;
const mobile = () => { serial += 1; return `9${stamp}${String(serial).padStart(3, '0')}`; };

const ADMIN = await probeAdmin('fh-admin', { role: 'admin', sales_org: 'BONANZA' });
const ADMIN2 = await probeAdmin('fh-admin2', { role: 'admin', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('fh-bigul', { role: 'admin', sales_org: 'BIGUL' });
const RM1 = await probeAdmin('fh-rm1', { role: 'sales_rm', sales_org: 'BONANZA' });
const RM2 = await probeAdmin('fh-rm2', { role: 'sales_rm', sales_org: 'BONANZA' });
const probes = [ADMIN, ADMIN2, BIGUL, RM1, RM2];
const userRow = (p) => one('SELECT * FROM users WHERE id = ?', [p.id]);

const lead = (extra = {}) => make('leads', {
  name: 'History probe', mobile: mobile(), source: 'Referral', stage: 'New', sales_org: 'BONANZA', ...extra,
});
const PRODUCT = one("SELECT id, code FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 ORDER BY id LIMIT 1");
const card = (leadId, state = 'INACTIVE') => make('product_cards', { lead_id: leadId, product_type_id: PRODUCT.id, state });

const call = async (who, method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json };
};

/** The newest history row for one field of one record, written by this run. */
const latest = (entity, id, field) => one(
  'SELECT * FROM field_history WHERE id > ? AND entity = ? AND record_id = ? AND field = ? ORDER BY id DESC LIMIT 1',
  [START, entity, id, field],
);
const expectRow = (entity, id, field, { to, actor, source }) => {
  const row = latest(entity, id, field);
  assert.ok(row, `${entity} #${id}: no history row for ${field}`);
  if (to !== undefined) assert.equal(String(row.new_value ?? ''), String(to ?? ''), `${entity} #${id} ${field}: recorded ${row.new_value}, expected ${to}`);
  if (actor !== undefined) assert.equal(row.actor_id ?? null, actor, `${entity} #${id} ${field}: recorded actor ${row.actor_id}, expected ${actor}`);
  if (source !== undefined) assert.equal(row.source, source, `${entity} #${id} ${field}: recorded source ${row.source}, expected ${source}`);
};

/** An approval request as the bulk screens raise one, then decided through the API. */
const approve = async (scope, entity, entityId, payload) => {
  const id = make('approvals', {
    scope, entity, entity_id: entityId, subject_name: 'History probe', payload: JSON.stringify(payload),
    reason: 'History probe', status: 'Pending', requested_by: ADMIN.id,
  });
  const out = await call(ADMIN2, 'POST', `/api/approvals/${id}/decide`, { approve: true, reason: 'Agreed' });
  assert.equal(out.status, 200, `deciding ${scope}: HTTP ${out.status} ${JSON.stringify(out.body)}`);
};

console.log('\nD9: field history, by every path that changes a tracked field');

try {
  /* ---------------------------------------------------------- census */

  await test('every write to a tracked field records its history, or says here why not', () => {
    const writes = writesToTrackedTables();
    assert.ok(writes.length > 30, `only ${writes.length} writes were found, so the census is broken`);
    const silent = writes.filter((w) => !w.covered && !(w.key in EXEMPT));
    assert.equal(silent.length, 0, `these change a tracked field and write no history:\n${silent.map((w) => `         ${w.where}  (${w.key})`).join('\n')}\n       Wrap the write in tracked() (engine/history.js), or add it to EXEMPT in test/fieldhistory.test.mjs with the reason.`);
    const stale = Object.keys(EXEMPT).filter((k) => !writes.some((w) => w.key === k));
    assert.equal(stale.length, 0, `these EXEMPT entries no longer match a write: ${stale.join(', ')}`);
  });

  /* ----------------------------------------------------------- leads */

  await test('a lead: the leads list\'s bulk update records owner and stage, by the person who did it', async () => {
    const a = lead({ owner_id: RM1.id });
    const b = lead({ owner_id: RM1.id });
    let out = await call(ADMIN, 'POST', '/api/leads/bulk/field', { field: 'owner_id', value: RM2.id, mode: 'ids', ids: [a, b] });
    assert.equal(out.status, 200, `owner: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    out = await call(ADMIN, 'POST', '/api/leads/bulk/field', { field: 'stage', value: 'Contacted', mode: 'ids', ids: [a] });
    assert.equal(out.status, 200, `stage: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    for (const id of [a, b]) expectRow('lead', id, 'owner_id', { to: RM2.id, actor: ADMIN.id, source: 'ui' });
    expectRow('lead', a, 'stage', { to: 'Contacted', actor: ADMIN.id, source: 'ui' });
  });

  await test('a lead: a lead list\'s bulk field, reassign and stage each record it', async () => {
    const a = lead({ owner_id: RM1.id });
    const list = await call(ADMIN, 'POST', '/api/lists', {
      name: `History probe ${stamp}`, kind: 'static', snapshot_reason: 'History probe', expires_at: '2026-12-31',
    });
    assert.equal(list.status, 201, `list: HTTP ${list.status} ${JSON.stringify(list.body)}`);
    made.push(['lead_lists', list.body.id]);
    await call(ADMIN, 'POST', `/api/lists/${list.body.id}/members`, { lead_ids: [a] });
    let out = await call(ADMIN, 'POST', `/api/lists/${list.body.id}/bulk/field`, { field: 'stage', value: 'Contacted' });
    assert.equal(out.status, 200, `bulk field: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('lead', a, 'stage', { to: 'Contacted', actor: ADMIN.id, source: 'ui' });
    out = await call(ADMIN, 'POST', `/api/lists/${list.body.id}/bulk/stage`, { stage: 'Qualified' });
    assert.equal(out.status, 200, `bulk stage: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('lead', a, 'stage', { to: 'Qualified', actor: ADMIN.id, source: 'ui' });
    out = await call(ADMIN, 'POST', `/api/lists/${list.body.id}/bulk/reassign`, { owner_id: RM2.id });
    assert.equal(out.status, 200, `bulk reassign: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('lead', a, 'owner_id', { to: RM2.id, actor: ADMIN.id, source: 'ui' });
  });

  await test('a lead: an approved bulk move records each lead, under the person who approved it', async () => {
    const a = lead({ owner_id: RM1.id });
    await approve('bulk_reassign', 'user', RM2.id, { lead_ids: [a], owner_id: RM2.id });
    expectRow('lead', a, 'owner_id', { to: RM2.id, actor: ADMIN2.id, source: 'approval' });
  });

  await test('a lead: assignment, queues and automation rules record it as automation, or as the person', () => {
    const routed = lead({ owner_id: null });
    assignLead(one('SELECT * FROM leads WHERE id = ?', [routed]), { fallbackUserId: RM1.id });
    expectRow('lead', routed, 'owner_id', { actor: null, source: 'automation' });

    const queued = lead({ owner_id: RM1.id });
    const queue = one("SELECT id FROM queues WHERE entity = 'lead' AND sales_org = 'BONANZA' AND active = 1 ORDER BY id LIMIT 1").id;
    assert.ok(assignToQueue(queued, queue, { actorId: ADMIN.id }).ok, 'could not queue the lead');
    expectRow('lead', queued, 'owner_id', { to: null, actor: ADMIN.id, source: 'ui' });
    assert.ok(claimFromQueue(queued, userRow(RM2)).ok, 'could not claim the lead');
    expectRow('lead', queued, 'owner_id', { to: RM2.id, actor: RM2.id, source: 'ui' });

    const ruled = lead({ owner_id: null });
    runAction({ type: 'update_lead', params: { field: 'stage', value: 'Contacted' } }, leadFacts(ruled), { dryRun: false });
    expectRow('lead', ruled, 'stage', { to: 'Contacted', actor: null, source: 'automation' });
    runAction({ type: 'assign_queue', params: { role: 'sales_rm' } }, leadFacts(ruled), { dryRun: false });
    expectRow('lead', ruled, 'owner_id', { actor: null, source: 'automation' });
  });

  await test('a lead: an import that updates a field Setup tracks records it as an import -- tracking follows Setup', () => {
    /* An import cannot set a lead's stage or owner, so City is tracked for the
       length of this test: what is recorded is whatever Setup tracks at the
       moment of the write, with no path to find. */
    const def = one("SELECT history_tracked FROM field_def WHERE entity = 'lead' AND api_name = 'city'");
    assert.ok(def, 'no City field on a lead');
    run("UPDATE field_def SET history_tracked = 1 WHERE entity = 'lead' AND api_name = 'city'");
    try {
      const number = mobile();
      const a = lead({ mobile: number, owner_id: RM1.id, city: 'Pune' });
      const report = runImport({
        header: ['Full name', 'Phone', 'City'], rows: [['History probe', number, 'Nashik']],
        mapping: { 'Full name': 'name', Phone: 'mobile', City: 'city' },
        mode: 'update', salesOrg: 'BONANZA', ownerId: ADMIN.id, commit: true,
      });
      assert.equal(report.updated, 1, `the import did not update the lead: ${JSON.stringify(report.failures)}`);
      expectRow('lead', a, 'city', { to: 'Nashik', actor: ADMIN.id, source: 'import' });
    } finally {
      run("UPDATE field_def SET history_tracked = ? WHERE entity = 'lead' AND api_name = 'city'", [def?.history_tracked ?? 0]);
    }
  });

  /* ------------------------------------- a handover moves several kinds */

  await test('a handover and its undo record every lead, account and case they move', () => {
    const leaver = make('users', { name: 'History leaver', email: `probe-fh-leaver-${stamp}@bonanza.test`, password: 'x', role: 'sales_rm', sales_org: 'BONANZA', active: 1 });
    const a = lead({ owner_id: leaver });
    const client = make('clients', { client_code: `HP${stamp}`, name: 'History probe', sales_org: 'BONANZA', owner_id: leaver });
    const ticket = make('tickets', { subject: 'History probe', sales_org: 'BONANZA', assignee_id: leaver, status: 'Open' });
    const plan = planHandover({ from: leaver, targets: [RM2.id], include: ['leads_open', 'clients', 'tickets'] });
    const batch = runHandover(plan, { runBy: ADMIN.id, reason: 'History probe', salesOrg: 'BONANZA' });
    expectRow('lead', a, 'owner_id', { to: RM2.id, actor: ADMIN.id, source: 'handover' });
    expectRow('client', client, 'owner_id', { to: RM2.id, actor: ADMIN.id, source: 'handover' });
    expectRow('case', ticket, 'assignee_id', { to: RM2.id, actor: ADMIN.id, source: 'handover' });
    undoHandover(batch.batch_id, ADMIN2.id);
    expectRow('lead', a, 'owner_id', { to: leaver, actor: ADMIN2.id, source: 'handover' });
  });

  /* ----------------------------------------------------------- cases */

  await test('a case: reassigning, escalating, merging and retiring it record status and assignee', async () => {
    run('UPDATE users SET manager_id = ? WHERE id = ?', [ADMIN2.id, RM1.id]);
    const a = make('tickets', { subject: 'History probe', sales_org: 'BONANZA', assignee_id: RM2.id, status: 'Open' });
    let out = await call(ADMIN, 'PATCH', `/api/tickets/${a}`, { assignee_id: RM1.id });
    assert.equal(out.status, 200, `reassign: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('case', a, 'assignee_id', { to: RM1.id, actor: ADMIN.id, source: 'ui' });
    out = await call(ADMIN, 'POST', `/api/tickets/${a}/escalate`, { reason: 'History probe' });
    assert.equal(out.status, 200, `escalate: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('case', a, 'assignee_id', { to: ADMIN2.id, actor: ADMIN.id, source: 'ui' });

    const b = make('tickets', { subject: 'History probe', sales_org: 'BONANZA', status: 'Open' });
    out = await call(ADMIN, 'POST', `/api/tickets/${b}/merge`, { into_id: a });
    assert.equal(out.status, 200, `merge: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('case', b, 'status', { to: 'Closed', actor: ADMIN.id, source: 'ui' });

    const c = make('tickets', { subject: 'History probe', sales_org: 'BONANZA', status: 'Open' });
    TEST_KINDS.case.retire({ id: c }, 'History probe', ADMIN.id);
    expectRow('case', c, 'status', { to: 'Closed', actor: ADMIN.id, source: 'ui' });
  });

  await test('a case: a partner\'s reply that reopens it records it as the portal', async () => {
    const partner = make('partners', { name: 'History partner', sales_org: 'BONANZA', state_code: 'ACTIVE' });
    const ticket = make('tickets', { subject: 'History probe', sales_org: 'BONANZA', status: 'Resolved', partner_id: partner });
    const token = `history-partner-${stamp}`;
    run("INSERT INTO sessions (token, partner_id, kind, expires_at, last_seen_at) VALUES (?,?,'partner',datetime('now','+1 hours'),datetime('now'))", [token, partner]);
    try {
      const out = await call({ headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
        'POST', `/api/portal/tickets/${ticket}/replies`, { body: 'Still not working' });
      assert.equal(out.status, 201, `reply: HTTP ${out.status} ${JSON.stringify(out.body)}`);
      expectRow('case', ticket, 'status', { to: 'Open', actor: null, source: 'portal' });
    } finally { run('DELETE FROM sessions WHERE token = ?', [token]); }
  });

  /* -------------------------------------------------------- accounts */

  await test('an account: bulk reassign, its edit, a single reassign and an approved move record owner and status', async () => {
    const a = make('clients', { client_code: `HA${stamp}`, name: 'History probe', sales_org: 'BONANZA', owner_id: RM1.id, status: 'Active' });
    let out = await call(ADMIN, 'POST', '/api/clients/bulk/reassign', { client_ids: [a], owner_id: RM2.id });
    assert.equal(out.status, 200, `bulk: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('client', a, 'owner_id', { to: RM2.id, actor: ADMIN.id, source: 'ui' });
    out = await call(ADMIN, 'PATCH', `/api/clients/${a}`, { status: 'Dormant' });
    assert.equal(out.status, 200, `edit: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('client', a, 'status', { to: 'Dormant', actor: ADMIN.id, source: 'ui' });
    out = await call(ADMIN, 'POST', `/api/clients/${a}/reassign`, { owner_id: RM1.id });
    assert.equal(out.status, 200, `reassign: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('client', a, 'owner_id', { to: RM1.id, actor: ADMIN.id, source: 'ui' });
    await approve('bulk_client_reassign', 'user', RM2.id, { client_ids: [a], owner_id: RM2.id });
    expectRow('client', a, 'owner_id', { to: RM2.id, actor: ADMIN2.id, source: 'approval' });
  });

  /* -------------------------------------------------------- partners */

  await test('a partner: onboarding, activation and an approved suspension record its status', async () => {
    const a = make('partners', { name: 'History partner', sales_org: 'BONANZA', state_code: 'PROSPECT', owner_id: ADMIN.id });
    const out = await call(ADMIN, 'POST', `/api/partners/${a}/steps/KYC`);
    assert.equal(out.status, 200, `step: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('partner', a, 'state_code', { to: 'QUALIFYING', actor: ADMIN.id, source: 'ui' });
    activatePartner(one('SELECT * FROM partners WHERE id = ?', [a]), ADMIN2.id, 'approval');
    expectRow('partner', a, 'state_code', { to: 'ACTIVE', actor: ADMIN2.id, source: 'approval' });
    await approve('partner_closure', 'partner', a, { state_code: 'SUSPENDED' });
    expectRow('partner', a, 'state_code', { to: 'SUSPENDED', actor: ADMIN2.id, source: 'approval' });
  });

  /* ---------------------------------------------------- product cards */

  await test('a product card: a move, a call outcome, a rule, KYC and a partner\'s referral record its stage', async () => {
    const owner = lead({ owner_id: RM1.id });
    const a = card(owner);
    const out = await call(ADMIN, 'POST', `/api/cards/${a}/state`, { state: 'EXPLORING' });
    assert.equal(out.status, 200, `move: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('product_interest', a, 'state', { to: 'EXPLORING', actor: ADMIN.id, source: 'ui' });

    applyEffects({ disposition: { sets_card_state: 'LOST', label: 'History probe' }, leadId: owner, cardId: a, userId: RM1.id, reason: 'History probe' });
    expectRow('product_interest', a, 'state', { to: 'LOST', actor: RM1.id, source: 'ui' });

    runAction({ type: 'update_card', params: { product_code: PRODUCT.code, state: 'WARM' } }, leadFacts(owner), { dryRun: false });
    expectRow('product_interest', a, 'state', { to: 'WARM', actor: null, source: 'automation' });

    const journey = createJourney({ leadId: owner, cardId: a, productTypeId: PRODUCT.id, actorId: ADMIN.id });
    expectRow('product_interest', a, 'state', { to: 'KYC_IN_PROGRESS', actor: ADMIN.id, source: 'ui' });
    completeJourney(journey.id ?? journey.journey?.id ?? one('SELECT id FROM kyc_journeys WHERE card_id = ? ORDER BY id DESC', [a]).id, null);
    expectRow('product_interest', a, 'state', { to: 'ACTIVE', actor: null, source: 'portal' });

    const partner = make('partners', { name: 'History partner', sales_org: 'BONANZA', state_code: 'ACTIVE' });
    const token = `history-referral-${stamp}`;
    run("INSERT INTO sessions (token, partner_id, kind, expires_at, last_seen_at) VALUES (?,?,'partner',datetime('now','+1 hours'),datetime('now'))", [token, partner]);
    try {
      const referred = await call({ headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
        'POST', '/api/portal/referrals', { name: 'History referral', mobile: mobile(), product_type_id: PRODUCT.id });
      assert.equal(referred.status, 201, `referral: HTTP ${referred.status} ${JSON.stringify(referred.body)}`);
      const newLead = one('SELECT id FROM leads WHERE partner_id = ? ORDER BY id DESC', [partner]).id;
      made.push(['leads', newLead]);
      const newCard = one('SELECT id FROM product_cards WHERE lead_id = ? AND product_type_id = ?', [newLead, PRODUCT.id]).id;
      expectRow('product_interest', newCard, 'state', { to: 'EXPLORING', actor: null, source: 'portal' });
    } finally { run('DELETE FROM sessions WHERE token = ?', [token]); }
  });

  /* ----------------------------------------------------------- tasks */

  await test('a task: its edit, completing it, cancelling it and retiring it record its status', async () => {
    const owner = lead({ owner_id: ADMIN.id });
    const newTask = async () => {
      const out = await call(ADMIN, 'POST', '/api/tasks', { title: 'History probe', due_at: '2026-12-01 11:00', lead_id: owner, assignee_id: ADMIN.id });
      assert.equal(out.status, 201, `task: HTTP ${out.status} ${JSON.stringify(out.body)}`);
      made.push(['tasks', out.body.id]);
      return out.body.id;
    };
    const a = await newTask();
    let out = await call(ADMIN, 'PATCH', `/api/tasks/${a}`, { status: 'Done' });
    assert.equal(out.status, 200, `edit: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('task', a, 'status', { to: 'Done', actor: ADMIN.id, source: 'ui' });

    const b = await newTask();
    out = await call(ADMIN, 'POST', `/api/activities/follow-ups/${b}/complete`);
    assert.equal(out.status, 200, `complete: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('task', b, 'status', { to: 'Done', actor: ADMIN.id, source: 'ui' });

    const c = await newTask();
    out = await call(ADMIN, 'POST', `/api/tasks/${c}/cancel`, { reason: 'History probe' });
    assert.equal(out.status, 200, `cancel: HTTP ${out.status} ${JSON.stringify(out.body)}`);
    expectRow('task', c, 'status', { to: 'Cancelled', actor: ADMIN.id, source: 'ui' });

    const d = await newTask();
    TEST_KINDS.task.retire({ id: d }, 'History probe', ADMIN.id);
    expectRow('task', d, 'status', { to: 'Cancelled', actor: ADMIN.id, source: 'ui' });
  });

  /* -------------------------------------------------- reading it back */

  await test('a record\'s history is read only by someone who may open the record (OPS-66)', async () => {
    const mine = lead({ owner_id: RM1.id });
    await call(ADMIN, 'POST', '/api/leads/bulk/field', { field: 'stage', value: 'Contacted', mode: 'ids', ids: [mine] });
    const ticket = make('tickets', { subject: 'History probe', sales_org: 'BONANZA', status: 'Open' });
    const client = make('clients', { client_code: `HR${stamp}`, name: 'History probe', sales_org: 'BONANZA', owner_id: RM1.id });
    const partner = make('partners', { name: 'History partner', sales_org: 'BONANZA', state_code: 'ACTIVE' });
    const productCard = card(mine);

    const own = await call(ADMIN, 'GET', `/api/setup/history/lead/${mine}`);
    assert.equal(own.status, 200, `its own business's Admin: HTTP ${own.status}`);
    assert.ok(own.body.changes.some((h) => h.field === 'stage'), 'the stage change is not in its history');
    const owner = await call(RM1, 'GET', `/api/setup/history/lead/${mine}`);
    assert.equal(owner.status, 200, `the lead's own RM: HTTP ${owner.status}`);

    const problems = [];
    for (const [entity, id] of [['lead', mine], ['case', ticket], ['client', client], ['partner', partner], ['product_interest', productCard]]) {
      // eslint-disable-next-line no-await-in-loop
      const other = await call(BIGUL, 'GET', `/api/setup/history/${entity}/${id}`);
      if (other.status !== 404) problems.push(`the other business's Admin read ${entity} #${id}: HTTP ${other.status}`);
    }
    const colleague = await call(RM2, 'GET', `/api/setup/history/lead/${mine}`);
    if (colleague.status !== 404) problems.push(`a Sales RM read a colleague's lead's history: HTTP ${colleague.status}`);
    const unknown = await call(ADMIN, 'GET', `/api/setup/history/users/${ADMIN.id}`);
    if (unknown.status !== 404) problems.push(`a kind of record with no history answered: HTTP ${unknown.status}`);
    assert.equal(problems.length, 0, problems.join('\n         '));
  });

  await test('a tracked value the reader sees masked is masked in its history too (OPS-66)', async () => {
    const role = ['sales_rm', 'caller', 'dealer'].find((r) => maskedFieldsFor(r).has('mobile'));
    assert.ok(role, 'no role sees mobile masked, so this proves nothing');
    const reader = role === 'sales_rm' ? RM1 : await probeAdmin(`fh-${role}`, { role, sales_org: 'BONANZA' });
    if (reader !== RM1) probes.push(reader);
    const def = one("SELECT history_tracked FROM field_def WHERE entity = 'lead' AND api_name = 'mobile'");
    run("UPDATE field_def SET history_tracked = 1 WHERE entity = 'lead' AND api_name = 'mobile'");
    try {
      const a = lead({ owner_id: reader.id });
      const before = one('SELECT mobile FROM leads WHERE id = ?', [a]).mobile;
      const out = await call(ADMIN, 'PATCH', `/api/leads/${a}`, { mobile: mobile() });
      assert.equal(out.status, 200, `edit: HTTP ${out.status} ${JSON.stringify(out.body)}`);
      const seen = await call(reader, 'GET', `/api/setup/history/lead/${a}`);
      assert.equal(seen.status, 200, `HTTP ${seen.status}`);
      const row = seen.body.changes.find((h) => h.field === 'mobile');
      assert.ok(row, 'the mobile change is not in the history, so this proves nothing');
      assert.ok(!String(row.old_value).includes(before.slice(-6)) && String(row.old_value).includes('•'),
        `a ${role} read the old mobile in the clear: ${row.old_value}`);
      const page = await call(reader, 'GET', `/api/leads/${a}`);
      const onPage = (page.body.field_history ?? []).find((h) => h.field === 'mobile');
      assert.ok(onPage && String(onPage.old_value).includes('•'), `the lead page's history shows the mobile in the clear: ${onPage?.old_value}`);
    } finally {
      run("UPDATE field_def SET history_tracked = ? WHERE entity = 'lead' AND api_name = 'mobile'", [def?.history_tracked ?? 0]);
    }
  });
} finally {
  run('UPDATE users SET manager_id = NULL WHERE id = ?', [RM1.id]);
  for (const [table, id] of [...made].reverse()) {
    try { run(`DELETE FROM ${table} WHERE id = ?`, [id]); } catch { /* removed with its parent */ }
  }
  run('DELETE FROM field_history WHERE id > ?', [START]);
  for (const p of probes) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
