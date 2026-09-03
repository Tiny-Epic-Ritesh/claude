/**
 * Ghost login (P2-04).
 *
 * The feature is one administrator seeing the product as one colleague sees it.
 * Everything worth testing is a constraint on that:
 *
 *   who may reach whom, and the escalation route that must stay shut
 *   that the audit trail EXTENDS rather than replaces
 *   that leaving works, and cannot take the administrator's own session with it
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { all, one, run, audit } from '../src/db.js';
import { mayGhost, start, stop, GHOST_MINUTES } from '../src/engine/ghost.js';
import { withContext } from '../src/engine/reqcontext.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nGhost login');

const byRole = (role) => one('SELECT * FROM users WHERE role = ? AND active = 1 LIMIT 1', [role]);
const superadmin = byRole('superadmin');
const admin = byRole('admin');
const rm = byRole('sales_rm');

test('nobody reaches a Super Admin, however senior they are', () => {
  /* The escalation route. If an Admin can act as a Super Admin then the
     permission boundary between them is decorative, and the person who would
     authorise crossing it is the person crossing it. */
  assert(mayGhost(admin, superadmin), 'an Admin was allowed to act as a Super Admin');
  assert(/Super Admin/i.test(mayGhost(admin, superadmin)), 'the refusal does not say why');

  const another = { id: -1, name: 'Another Super', role: 'superadmin', active: 1 };
  assert(mayGhost(superadmin, another), 'a Super Admin was allowed to act as another Super Admin');
});

test('an Admin reaches any non-admin, a Super Admin reaches anyone below them', () => {
  assert.equal(mayGhost(admin, rm), null, 'an Admin cannot act as an RM');
  assert.equal(mayGhost(superadmin, rm), null, 'a Super Admin cannot act as an RM');
  assert.equal(mayGhost(superadmin, admin), null, 'a Super Admin cannot act as an Admin');
});

test('an Admin cannot reach another Admin', () => {
  // Sideways is still a permission boundary, and the refusal names who can.
  const other = { id: -2, name: 'Other Admin', role: 'admin', active: 1 };
  const refusal = mayGhost(admin, other);
  assert(refusal, 'one Admin was allowed to act as another');
  assert(/Super Admin/i.test(refusal), `the refusal should say who can: ${refusal}`);
});

test('nobody below Admin can do this at all', () => {
  assert(mayGhost(rm, byRole('caller')), 'a Sales RM was allowed to impersonate somebody');
});

test('a deactivated user and yourself are both refused', () => {
  assert(mayGhost(admin, { ...rm, active: 0 }), 'a deactivated user could be impersonated');
  assert(mayGhost(admin, admin), 'an administrator could impersonate themselves');
});

test('a session is capped, and carries both identities', () => {
  const started = start(admin, rm);
  assert(!started.error, started.error);
  try {
    assert.equal(started.expires_in_minutes, GHOST_MINUTES);
    assert.equal(started.acting_as.id, rm.id);
    assert.equal(started.on_behalf_of.id, admin.id);

    const row = one('SELECT * FROM sessions WHERE token = ?', [started.token]);
    assert.equal(row.user_id, rm.id, 'the session is not the impersonated user');
    assert.equal(row.ghost_of, admin.id, 'the session does not record who is really acting');

    /* An hour, not a day. The failure mode is an administrator forgetting they
       are impersonating, not somebody stealing the token. */
    const life = (new Date(`${row.expires_at.replace(' ', 'T')}Z`) - new Date(`${row.created_at.replace(' ', 'T')}Z`)) / 60000;
    assert(Math.abs(life - GHOST_MINUTES) < 2, `the session lives ${Math.round(life)} minutes`);
  } finally {
    stop(started.token);
  }
});

test('leaving ends the ghost session and only the ghost session', () => {
  const started = start(admin, rm);
  const ownToken = 'not-a-ghost-token-probe';
  run(`INSERT INTO sessions (token, kind, user_id, created_at, last_seen_at, expires_at)
       VALUES (?, 'crm', ?, datetime('now'), datetime('now'), datetime('now', '+1 hour'))`,
    [ownToken, admin.id]);

  try {
    assert.equal(stop(started.token), true, 'the ghost session did not end');
    assert(!one('SELECT token FROM sessions WHERE token = ?', [started.token]), 'the ghost session survived');

    // An ordinary session must not be endable through this door.
    assert.equal(stop(ownToken), false, 'a non-ghost session was ended by the ghost exit');
    assert(one('SELECT token FROM sessions WHERE token = ?', [ownToken]),
      "the administrator's own session was destroyed by leaving a ghost session");
  } finally {
    run('DELETE FROM sessions WHERE token = ?', [ownToken]);
  }
});

test('every audited write during a ghost session names the real human', () => {
  /* The requirement from Q-04, and the reason this is not just a convenience
     feature. A session that logs only the impersonated user does not extend
     the audit trail, it destroys it: every action looks like the RM's own and
     "who actually did this" becomes unanswerable. */
  const marker = `ghost_probe_${Date.now()}`;

  withContext({ ghostOf: { id: admin.id, name: admin.name }, actingAs: { id: rm.id, name: rm.name } }, () => {
    audit(rm.id, marker, 'lead', 1, {});
  });

  const row = one('SELECT * FROM audit_log WHERE action = ?', [marker]);
  try {
    assert(row, 'nothing was audited');
    assert.equal(row.user_id, rm.id, 'the write should still be attributed to whose record it is');
    assert(row.actor, 'the real human was not recorded');
    assert(row.actor.includes(admin.name) && row.actor.includes(rm.name),
      `both names must appear: got "${row.actor}"`);
  } finally {
    run('DELETE FROM audit_log WHERE action = ?', [marker]);
  }
});

test('an ordinary write records no actor, so the column means something', () => {
  // If everything carried an actor the column would stop being a signal.
  const marker = `plain_probe_${Date.now()}`;
  audit(rm.id, marker, 'lead', 1, {});
  const row = one('SELECT actor FROM audit_log WHERE action = ?', [marker]);
  try {
    assert.equal(row.actor, null, `an ordinary write recorded an actor: ${row.actor}`);
  } finally {
    run('DELETE FROM audit_log WHERE action = ?', [marker]);
  }
});

/* ------------------------------------------- getting back out again */

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('no API response may be cached by anything', () => {
  /* This is what hid the banner. Express puts an ETag on every JSON response
     and nothing set Cache-Control or Vary, so a browser cache keyed on the URL
     served one identity's /api/auth/me to another — arriving with
     `ghost_of: null`, which is the field the banner is built from. */
  const index = read('../src/index.js');
  const block = index.slice(index.indexOf("app.use('/api', (_req, res, next)"), index.indexOf("app.use('/api', accessLog)"));
  assert(/no-store/.test(block), 'API responses are cacheable again');
  assert(/Vary.*Authorization/s.test(block), 'two identities can share a cache entry again');
});

test('the banner does not depend on a round trip', () => {
  /* The administrator's own token is only ever stashed while they are acting
     as somebody else, so its presence is local, synchronous proof. Trusting it
     as well as the server means a slow or cached response cannot leave
     somebody inside another account with nothing telling them so. */
  const crm = read('../../client/src/crm/Crm.jsx');
  assert(/hasParentToken\(\)/.test(crm), 'the banner is back to trusting the response alone');
});

test('signing out while acting as somebody else returns rather than ends', () => {
  /* The trap: with the banner missing, the profile menu's Sign out was the
     only exit anybody could find, and it ended both sessions and landed on the
     login screen. Salesforce does not offer that from inside a "log in as"
     session either. */
  const crm = read('../../client/src/crm/Crm.jsx');
  const signOut = crm.slice(crm.indexOf('const signOut = async'), crm.indexOf('const orgName ='));
  assert(/hasParentToken\(\)/.test(signOut), 'sign out no longer checks for a ghost session');
  assert(signOut.indexOf('leaveGhost') < signOut.indexOf("api.post('/auth/logout')"),
    'sign out ends the session before checking whether it is a ghost one');

  const nav = read('../../client/src/components/AppNav.jsx');
  assert(/Return to \{session\.ghost_of\.name\}/.test(nav), 'the menu still says Sign out while ghosting');
});

test('returning lands where the trip started', () => {
  // An administrator working down a list of users comes back to that list.
  // The user-record actions moved out of Admin.jsx when that file was split
  // into one file per Setup section; the ghosting entry point went with them.
  const admin = read('../../client/src/crm/admin/users.jsx');
  assert(/returnTo:/.test(admin), 'the origin is no longer recorded when ghosting starts');
  const bar = read('../../client/src/crm/GhostBar.jsx');
  assert(/ghostReturnTo|RETURN_KEY/.test(bar), 'the return path is not read back');
});

test('the way back is named, so it is obvious what it does', () => {
  const bar = read('../../client/src/crm/GhostBar.jsx');
  assert(/Return to \$\{parentName\(\)/.test(bar), 'the button no longer names who you return to');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
