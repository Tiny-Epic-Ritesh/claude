/**
 * Setup as its own place.
 *
 * Setup used to be one route inside the CRM shell: the Home / Leads / Pipeline
 * strip sat above it, and 22 settings screens were crammed into a second
 * horizontally-scrolling strip below. Seven were unreachable until that strip
 * was made to scroll, which was a fix for the symptom.
 *
 * The shape now follows `docs/salesforce-reference/setup-tree.md` and its two
 * explicit rules: search-first rather than browse-first, and do not copy the
 * tree depth. One level of grouping, and a Quick Find that reaches anything.
 *
 * Four things are built from one registry — the sidebar, the search index, the
 * router and the permission gate. These tests exist because those four
 * disagreeing is the failure that matters: a screen listed in the nav and 403
 * when clicked, or reachable by URL and invisible everywhere.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { CAPABILITY_CATALOGUE } from '../src/engine/access.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nSetup shell');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const registry = read('../../client/src/setup/registry.js');
const shell = read('../../client/src/setup/SetupShell.jsx');
const home = read('../../client/src/setup/SetupHome.jsx');
const crm = read('../../client/src/crm/Crm.jsx');

/* Parsed from the source rather than imported: the registry is a client module
   that pulls in React, and the point here is what is declared, not what runs. */
const sections = [...registry.matchAll(
  /^ {4}key: '([a-z_]+)',\n {4}label: '([^']+)',\n {4}group: '([a-z_]+)',\n {4}icon: '([a-z0-9_]+)',(?:\n {4}needs: \[([^\]]*)\],)?/gm,
)].map((m) => ({
  key: m[1], label: m[2], group: m[3], icon: m[4],
  needs: m[5] ? m[5].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean) : [],
}));

const groups = [...registry.matchAll(/\{ key: '([a-z_]+)', label: '([^']+)', icon: '([a-z0-9_]+)' \}/g)]
  .map((m) => ({ key: m[1], label: m[2] }));

/* ------------------------------------------------------------ the registry */

test('every settings screen is declared', () => {
  // 22 was the number in the old tab strip. Losing one in the move would be
  // invisible: a screen nobody can reach looks exactly like a screen nobody
  // uses.
  assert(sections.length >= 22, `only ${sections.length} sections parsed — the registry or this pattern has drifted`);
  assert(groups.length >= 5, `only ${groups.length} groups parsed`);
});

test('no two screens share an address', () => {
  const keys = sections.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'two sections share a key, so one of them is unreachable');
});

test('every screen sits in a group that exists', () => {
  const known = new Set(groups.map((g) => g.key));
  for (const s of sections) {
    assert(known.has(s.group), `"${s.label}" is in group "${s.group}", which is not declared`);
  }
});

test('no group is empty', () => {
  // An empty heading in the sidebar is a promise of something that is not there.
  for (const g of groups) {
    assert(sections.some((s) => s.group === g.key), `the "${g.label}" group has no screens in it`);
  }
});

test('one level of grouping, never two', () => {
  /* The rule the reference is explicit about: "Do not copy the Setup tree
     depth. 15 top-level categories with 4 levels of nesting is only navigable
     because Quick Find exists." A `subgroup` appearing here is the first step
     back towards that. */
  assert(!/subgroup|children:|nested/.test(registry), 'the registry has grown a second level');
});

test('a group stays small enough to read', () => {
  // Six groups over 22 screens averages under four. A group past about eight
  // stops being scannable and starts needing its own search.
  for (const g of groups) {
    const n = sections.filter((s) => s.group === g.key).length;
    assert(n <= 8, `"${g.label}" holds ${n} screens — too many to scan without nesting`);
  }
});

/* ------------------------------------------------------------ permissions */

test('every capability a screen asks for actually exists', () => {
  /* A screen gated on a capability nobody can hold is invisible to everybody,
     and a typo produces exactly that with no error anywhere. */
  const known = new Set(CAPABILITY_CATALOGUE.map((c) => c[0]));
  for (const s of sections) {
    for (const cap of s.needs) {
      assert(known.has(cap), `"${s.label}" requires "${cap}", which is not in the capability catalogue`);
    }
  }
});

test('the router is built from the same list as the sidebar', () => {
  /* The whole reason for a registry. Built separately, one drifts, and a screen
     ends up in the nav returning 403 or reachable by URL and listed nowhere. */
  assert(/sectionsFor\(session\.permissions\)/.test(shell), 'the shell no longer filters sections by permission');
  assert(/available\.map\(\(\{ key, Component \}\)/.test(shell), 'the routes are no longer generated from that same list');
});

/* ---------------------------------------------------------------- search */

test('Quick Find is present and reachable from the keyboard', () => {
  // Search is the primary navigation, per the reference. An admin console that
  // needs the mouse to navigate is slower than the tab strip it replaced.
  assert(/searchSections/.test(shell), 'Quick Find no longer searches');
  assert(/e\.key === '\/'/.test(shell), 'the "/" shortcut is gone');
  assert(/ArrowDown/.test(shell) && /Enter/.test(shell), 'the results cannot be driven by the keyboard');
});

test('every screen carries words somebody would actually search for', () => {
  /* Nobody searches "SLA & categories". They search "response time" or
     "escalation" — including the words the previous CRM used. */
  for (const s of sections) {
    const block = registry.slice(registry.indexOf(`key: '${s.key}'`));
    const kw = block.slice(0, block.indexOf('Component:')).match(/keywords: \[([^\]]*)\]/);
    assert(kw, `"${s.label}" has no search keywords, so it can only be found by its own name`);
    assert(kw[1].split(',').length >= 4, `"${s.label}" has too few keywords to be findable`);
  }
});

/* --------------------------------------------------------------- the shell */

test('Setup renders outside the CRM shell', () => {
  /* The request, in one line: no Home / Leads / Pipeline above the settings.
     Returned before the CRM shell is built rather than as a route inside it,
     which is the only way none of it renders. */
  const from = crm.indexOf("location.pathname === '/setup'");
  assert(from > -1, 'Setup is back to being a route inside the CRM shell');
  // Everything between the Setup check and where the CRM shell markup begins.
  const branch = crm.slice(from, crm.indexOf('app-shell', from));
  assert(/SetupShell/.test(branch), 'the shell is not mounted in the Setup branch');
  assert(!/TabBar/.test(branch), 'the CRM tab strip renders inside Setup');
});

test('somebody acting as another user is still told so', () => {
  /* The one thing that follows into Setup, and it has to: the screen where a
     ghost session can rewrite the permission model is the last place to hide
     whose session it is. */
  const from = crm.indexOf("location.pathname === '/setup'");
  const branch = crm.slice(from, crm.indexOf('SetupShell', from));
  assert(/GhostBar/.test(branch), 'the ghost banner does not follow into Setup');
});

test('the old address still works', () => {
  // /admin was Setup's address for the whole build so far, and /admin?tab=sla
  // was made to work days ago. Bookmarks exist.
  assert(/AdminRedirect/.test(crm), 'the /admin redirect is gone');
  assert(/search\.get\('tab'\)/.test(crm), 'the ?tab= parameter is no longer carried across');
});

/* ----------------------------------------------------------------- home */

test('the home page reports real findings, not shortcuts', () => {
  /* A landing page earns its place only by answering something the sidebar
     cannot. Repeating the nav as tiles would be a page that costs a click and
     says nothing. */
  assert(/setup\/health/.test(home), 'the home page no longer asks what needs attention');
  assert(/finding/.test(home), 'the findings list is gone');
  assert(/Recently changed/.test(home), 'the recent configuration changes are gone');
});

test('every finding names the screen that fixes it', () => {
  // A warning you have to go and hunt for is half a warning.
  assert(/sectionByKey\(f\.section\)/.test(home), 'findings no longer resolve to a section');
  assert(/to=\{`\/setup\/\$\{f\.section\}`\}/.test(home), 'findings no longer link anywhere');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
