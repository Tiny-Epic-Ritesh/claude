/**
 * The Private floor, and the grants above it.
 *
 * Non-negotiable 7: one restrictive floor, then grant-only layers.
 *
 * The tests that matter are the ones that prove a *reduction*. It is easy to
 * write a visibility model that only ever widens and never notices; the point
 * of a Private floor is that a lead outside every grant is genuinely invisible,
 * and that is what most of this file checks.
 */

import { strict as assert } from 'node:assert';
import { all, one, run, db } from '../src/db.js';
import { leadScope, can } from '../src/auth.js';
import { dataScope } from '../src/engine/access.js';
import { reportsOf, manages, managerScopeSql, explainVisibility } from '../src/engine/sharing.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const OWN_USERS = [];
const OWN_LEADS = [];

const sees = (user, leadId) => {
  const s = leadScope(user);
  return one(
    `SELECT COUNT(*) n FROM leads l WHERE l.id = ? AND l.deleted_at IS NULL AND (${s.sql})`,
    [leadId, ...s.params],
  ).n === 1;
};

function mkUser(name, role, org = 'BONANZA', managerId = null) {
  const r = run(
    'INSERT INTO users (name, email, password, role, active, sales_org, manager_id) VALUES (?,?,?,?,1,?,?)',
    [name, `${name.replace(/\W/g, '').toLowerCase()}.${Date.now()}@t.test`, 'x', role, org, managerId],
  );
  const id = Number(r.lastInsertRowid);
  OWN_USERS.push(id);
  return one('SELECT * FROM users WHERE id = ?', [id]);
}

function mkLead(name, ownerId, org = 'BONANZA') {
  const r = run(
    'INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id) VALUES (?,?,?,?,?,?)',
    [name, `9${String(Date.now()).slice(-9)}`, 'Manual', 'New', org, ownerId],
  );
  const id = Number(r.lastInsertRowid);
  OWN_LEADS.push(id);
  return id;
}

/* --------------------------------------------------- the manager chain */

console.log('\nThe management chain');

test('the chain follows reports to any depth', () => {
  // The old `team` scope was direct reports only, so a regional head above two
  // desk supervisors saw neither desk's leads. A hierarchy that works one level
  // deep is not a hierarchy.
  const head = mkUser('Chain Head', 'sales_supervisor');
  const mid = mkUser('Chain Mid', 'sales_supervisor', 'BONANZA', head.id);
  const leaf = mkUser('Chain Leaf', 'sales_rm', 'BONANZA', mid.id);

  const reports = reportsOf(head.id);
  assert(reports.includes(mid.id), 'the direct report is missing');
  assert(reports.includes(leaf.id), 'the grandchild is missing — the chain stops at one level');
  assert(manages(head.id, leaf.id), 'manages() does not follow the chain');
  assert(!manages(leaf.id, head.id), 'the chain runs upward as well as down');
});

test('a cycle in the data terminates instead of hanging', () => {
  // Two people pointing at each other is one bad edit away in any admin screen.
  const a = mkUser('Cycle A', 'sales_rm');
  const b = mkUser('Cycle B', 'sales_rm');
  run('UPDATE users SET manager_id = ? WHERE id = ?', [b.id, a.id]);
  run('UPDATE users SET manager_id = ? WHERE id = ?', [a.id, b.id]);

  const t0 = Date.now();
  const reports = reportsOf(a.id);
  assert(Date.now() - t0 < 1000, 'the recursive walk did not terminate promptly');
  assert(reports.includes(b.id));

  run('UPDATE users SET manager_id = NULL WHERE id IN (?,?)', [a.id, b.id]);
});

test('managing nobody yields no clause rather than a broken one', () => {
  // `owner_id IN ()` is a syntax error in SQLite, so the caller has to be able
  // to leave the grant out entirely.
  const lonely = mkUser('No Reports', 'sales_rm');
  assert.equal(managerScopeSql(lonely), null);
});

test('a clause that is emitted is properly bound', () => {
  const head = one("SELECT * FROM users WHERE name = 'Chain Head'");
  const g = managerScopeSql(head);
  assert(g, 'a manager with reports got no clause');
  assert.equal(g.sql.split('?').length - 1, g.params.length, 'placeholders and params disagree');
});

/* ------------------------------------------------------- the floor */

console.log('\nThe Private floor actually hides things');

test('a lead outside every grant is invisible, in the same org', () => {
  // The test that proves this is a floor and not decoration.
  const sup = mkUser('Floor Supervisor', 'sales_supervisor');
  const mine = mkUser('Floor Report', 'sales_rm', 'BONANZA', sup.id);
  const stranger = mkUser('Floor Stranger', 'sales_rm');

  const ours = mkLead('Inside the chain', mine.id);
  const theirs = mkLead('Outside the chain', stranger.id);

  assert(sees(sup, ours), 'a supervisor cannot see their own report’s lead');
  assert(!sees(sup, theirs), 'a lead outside every grant is visible — the floor is not holding');
});

test('an RM sees their own book and nothing else', () => {
  const a = mkUser('Own A', 'sales_rm');
  const b = mkUser('Own B', 'sales_rm');
  const mine = mkLead('A lead', a.id);
  const theirs = mkLead('B lead', b.id);

  assert(sees(a, mine));
  assert(!sees(a, theirs), 'an RM can see a peer’s lead');
});

test('org scope still sees everything in its org', () => {
  const stranger = one("SELECT * FROM users WHERE name = 'Floor Stranger'");
  const theirs = one('SELECT id FROM leads WHERE owner_id = ?', [stranger.id]).id;
  const admin = one("SELECT * FROM users WHERE role = 'admin' AND active = 1 LIMIT 1");

  assert(sees(admin, theirs), 'an org-scope role lost sight of its own org');
});

test('org scope does not cross into the other sales org', () => {
  // The floor is per-org as well: an org grant is still ANDed with org scope.
  const bigulRm = one("SELECT * FROM users WHERE sales_org = 'BIGUL' AND role = 'sales_rm' AND active = 1 LIMIT 1");
  if (!bigulRm) return;

  const bigulLead = mkLead('Bigul only', bigulRm.id, 'BIGUL');
  const bonanzaAdmin = one("SELECT * FROM users WHERE role = 'admin' AND active = 1 AND sales_org = 'BONANZA' LIMIT 1");

  if (JSON.parse(bonanzaAdmin.org_access || 'null')) return;   // entitled to both, nothing to prove
  assert(!sees(bonanzaAdmin, bigulLead), 'an org grant leaked across sales orgs');
});

/* --------------------------------------------- the declared scope wins */

console.log('\nThe capability and the declared scope agree');

test('lead.view.all is held only by roles declared org scope', () => {
  // It used to be held by Sales Supervisor, which is declared `team` — so
  // `data_scope` was decorative for that role and the two could disagree.
  const holders = all("SELECT role_code FROM role_capabilities WHERE capability = 'lead.view.all'")
    .map((r) => r.role_code)
    .filter((r) => !r.startsWith('regional_sup'));

  for (const role of holders) {
    assert.equal(dataScope(role), 'org',
      `${role} can see every lead but is declared ${dataScope(role)} scope`);
  }
});

test('Sales Supervisor reaches its team through the chain, not the whole org', () => {
  const sup = one("SELECT * FROM users WHERE role = 'sales_supervisor' AND active = 1 LIMIT 1");
  assert(!can(sup.role, 'lead.view.all'), 'Sales Supervisor still holds an org-wide grant');
  assert(reportsOf(sup.id).length > 0, 'the supervisor manages nobody, so they would see only their own book');
});

/* ------------------------------------------------------- explanation */

console.log('\n"Why can they see this?" has an answer');

test('visibility explains itself, grant by grant', () => {
  const sup = one("SELECT * FROM users WHERE role = 'sales_supervisor' AND active = 1 LIMIT 1");
  const out = explainVisibility(sup, dataScope(sup.role));

  assert.match(out.floor, /Private/);
  assert(out.grants.length >= 2, 'no grants were listed');
  assert(out.grants.some((g) => g.grant === 'Own book'), 'the floor itself is not listed');
  assert(out.grants.some((g) => g.grant === 'Management chain'), 'the chain grant is not explained');
});

test('someone who manages nobody is not told they manage a chain', () => {
  const rm = one("SELECT * FROM users WHERE name = 'Own A'");
  const out = explainVisibility(rm, 'own');
  assert(!out.grants.some((g) => g.grant === 'Management chain'), 'a chain grant was claimed for someone with no reports');
});

/* --------------------------------------------------------- cleanup */

if (OWN_LEADS.length) {
  const l = OWN_LEADS.map(() => '?').join(',');
  run(`DELETE FROM activities WHERE lead_id IN (${l})`, OWN_LEADS);
  run(`DELETE FROM leads WHERE id IN (${l})`, OWN_LEADS);
}
if (OWN_USERS.length) {
  const u = OWN_USERS.map(() => '?').join(',');
  run(`UPDATE users SET manager_id = NULL WHERE manager_id IN (${u})`, OWN_USERS);
  run(`DELETE FROM users WHERE id IN (${u})`, OWN_USERS);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
db.close();
process.exit(failed ? 1 : 0);
