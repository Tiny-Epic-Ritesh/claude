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
import { SETUP_SECTIONS, setupTabId, isSetupTabId, sectionKeyOf } from '../src/engine/setupsections.js';

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

/* ------------------------------------------- the two lists must agree */

test('the server and the client know the same screens', () => {
  /* The client registry holds how a screen looks; the server holds what it is
     called and what it takes to open. Visibility is configuration and cannot be
     validated against a list that only exists in a browser — so both exist, and
     a screen added to one and forgotten in the other is either a settings row
     that configures nothing or a screen nobody can hide. */
  const clientKeys = new Set(sections.map((sec) => sec.key));
  const serverKeys = new Set(SETUP_SECTIONS.map((sec) => sec.key));

  for (const k of serverKeys) assert(clientKeys.has(k), `the server knows "${k}" and the client does not`);
  for (const k of clientKeys) assert(serverKeys.has(k), `the client knows "${k}" and the server does not`);
});

test('both sides agree on what a screen takes to open', () => {
  // A capability on one side and not the other is a screen that appears in the
  // sidebar and refuses when clicked, or hides from somebody entitled to it.
  for (const server of SETUP_SECTIONS) {
    const client = sections.find((sec) => sec.key === server.key);
    assert.deepEqual(
      [...client.needs].sort(), [...(server.needs ?? [])].sort(),
      `"${server.label}" needs different capabilities on each side`,
    );
  }
});

test('a Setup screen cannot collide with a CRM tab', () => {
  /* `products` is both. Without the prefix, hiding the Products tab from a role
     would also hide the Products settings screen — one setting quietly doing
     two jobs. */
  assert(isSetupTabId(setupTabId('products')), 'setup ids are no longer prefixed');
  assert.equal(sectionKeyOf(setupTabId('products')), 'products');
  assert.notEqual(setupTabId('products'), 'products');
});

/* -------------------------------------------- what each person keeps */

test('preferences cannot change what anybody may see', () => {
  /* Pins, density and folded groups are conveniences. The moment one of them
     could hide a screen from somebody it would be an access control with no
     audit trail behind it. */
  assert(/sectionsFor\(session\.permissions\)/.test(shell), 'the capability filter is gone');
  assert(/allowed\.includes\(s\.key\)/.test(shell), 'role visibility is no longer applied');
  // Pins reorder; they never filter.
  assert(/pins\.map/.test(shell), 'pinning no longer builds from the pins list');
  assert(!/available\.filter\(\(s\) => pins/.test(shell), 'pinning filters the sidebar rather than reordering it');
});

test('hiding a screen is tidying, never security', () => {
  /* Capability AND visibility, in that order — a screen the role cannot open is
     never listed whatever the visibility says, and a merely hidden screen is
     still refused by the API if somebody types the URL. */
  const routes = readFileSync(new URL('../src/routes/setup.js', import.meta.url), 'utf8');
  const handler = routes.slice(routes.indexOf("router.get('/preferences'"), routes.indexOf("router.put('/preferences"));
  assert(/sec\.needs\.some\(\(c\) => can\(req\.user\.role, c\)\)/.test(handler),
    'the preferences endpoint no longer checks capability');
  assert(/visible\.has\(setupTabId\(sec\.key\)\)/.test(handler),
    'the preferences endpoint no longer applies role visibility');
});

/* ------------------------------------------- one screen, one crash */

test('a broken screen does not take Setup with it', () => {
  /* Not hypothetical. TabVisibility rendered PendingBar from a nested component
     where `draft` was not in scope, so opening Navigation threw and React
     unmounted everything — sidebar, header, the lot. An administrator could not
     navigate away from the screen that was broken. */
  assert(/SetupBoundary/.test(shell), 'the error boundary is gone from the shell');
  const boundary = readFileSync(new URL('../../client/src/setup/SetupBoundary.jsx', import.meta.url), 'utf8');
  assert(/getDerivedStateFromError/.test(boundary), 'the boundary no longer catches');
  assert(/resetKey/.test(boundary), 'a crash is sticky — it never clears when you navigate away');
});

test('the screen that crashed has its save bar back in scope', () => {
  const src = readFileSync(new URL('../../client/src/crm/TabVisibility.jsx', import.meta.url), 'utf8');
  const person = src.slice(src.indexOf('function PersonOverrides'));
  assert(!/PendingBar/.test(person),
    'the save bar is inside PersonOverrides again, where `draft` does not exist');
  const main = src.slice(src.indexOf('export default function TabVisibility'), src.indexOf('function PersonOverrides'));
  assert(/PendingBar/.test(main), 'the role grid has no save bar at all');
});

/* --------------------------------------------- the header controls */

test('the Setup header carries what was asked for', () => {
  // Theme and Copilot were chosen for this header and then not built. Named
  // individually so a silent removal fails rather than passing quietly.
  assert(/ThemeToggle/.test(shell), 'the light/dark toggle is missing from Setup');
  assert(/Copilot/.test(shell), 'the copilot is missing from Setup');
  assert(/OrgSwitcher/.test(shell), 'the business switcher is missing from Setup');
  assert(!/<select/.test(shell), 'the business switcher is a bare select rather than the shared control');
});

/* --------------------------------------------------- the sidebar reads */

test('no group label is long enough to wrap', () => {
  /* Four of six wrapped to two lines in a 280px sidebar, which dragged the
     items under them out of rhythm and made the whole column look unfinished.
     Measured in characters rather than pixels: at 10.5px uppercase with 0.6px
     tracking, the column fits about 22. */
  for (const g of groups) {
    assert(g.label.length <= 18, `"${g.label}" is ${g.label.length} characters — it will wrap`);
  }
});

test('group headings line up with the items beneath them', () => {
  /* The heading used to start at 10px and the item labels at 37px, so nothing
     in the column shared a left edge. The indent is the row padding plus the
     icon plus the gap, which is what puts the two on one line. */
  const css = readFileSync(new URL('../../client/src/styles.css', import.meta.url), 'utf8');
  const head = css.slice(css.indexOf('.setup-group-head {'), css.indexOf('.setup-nav ul'));
  assert(/padding: 0 10px 0 37px/.test(head), 'the heading indent no longer matches the item text');
  assert(/white-space: nowrap/.test(head), 'headings can wrap again');
});

test('an icon inside an uppercase heading keeps its ligature', () => {
  /* A Material Symbols glyph IS a ligature, and both `text-transform` and
     `letter-spacing` break one. The heading sets both, so the chevron rendered
     as the literal word EXPAND_LESS and ate 96px — which is what squeezed the
     heading text into an ellipsis. */
  const css = readFileSync(new URL('../../client/src/styles.css', import.meta.url), 'utf8');
  const at = css.indexOf('.setup-group-toggle .material-symbols-rounded {');
  assert(at > -1, 'the chevron reset rule is gone');
  const body = css.slice(at, css.indexOf('}', at));
  assert(/text-transform: none/.test(body), 'the chevron will render as its own name');
  assert(/letter-spacing: normal/.test(body), 'tracking will break the chevron ligature');
});

/* ------------------------------------------------- buttons stay readable */

test('a coloured button keeps its own background on hover', () => {
  /* 39 buttons are written `class="btn btn-primary"`. Both are single-class
     selectors, so source order decides — and `.btn:hover` sets
     `background: var(--glass-solid)`, which is white in light mode. A hover
     with no background of its own turned the green button white underneath
     white text, and "+ New field" vanished under the cursor. */
  const css = readFileSync(new URL('../../client/src/styles.css', import.meta.url), 'utf8');
  for (const kind of ['primary', 'danger']) {
    const at = css.indexOf(`.btn-${kind}:hover {`);
    assert(at > -1, `.btn-${kind}:hover does not exist, so .btn:hover decides its background`);
    const body = css.slice(at, css.indexOf('}', at));
    assert(/background:/.test(body), `.btn-${kind}:hover sets no background of its own`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
