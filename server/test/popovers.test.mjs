/**
 * Header popovers dismiss. P3-31.
 *
 * Reported as "the App Launcher does not close on an outside click". It was all
 * four header popovers, and the cause was not the handler -- there was one, on a
 * scrim covering the whole viewport. Or so it read.
 *
 * `.popover-scrim` was `position: fixed; inset: 0`, and the header sets
 * `backdrop-filter`. A filtered ancestor becomes the containing block for a
 * fixed-position descendant, so `inset: 0` resolved to the header's own box:
 * the scrim covered the strip it sat in and nothing below it. Clicking the page
 * missed it entirely, clicking the header worked, and the handler was never at
 * fault.
 *
 * That is invisible in review -- the markup looks right and the CSS looks right,
 * and the interaction between them is two files apart. So it is asserted here
 * rather than trusted: no scrim, and every popover on the shared hook.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

/* Source read from disk, so line endings are whatever git checked out. */
const CRLF = /\r\n/g;
const read = (p) => readFileSync(p, 'utf8').replace(CRLF, '\n');

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nHeader popovers');

const NAV = '../client/src/components/AppNav.jsx';
const UI = '../client/src/components/ui.jsx';
const CSS = '../client/src/styles.css';

test('the scrim is gone from the markup', () => {
  for (const file of [NAV, UI]) {
    const src = read(file);
    assert(!/className="popover-scrim"/.test(src),
      `${file} still renders a scrim, which cannot cover the page beneath a filtered header`);
  }
});

test('the scrim is gone from the stylesheet', () => {
  const css = read(CSS);
  assert(!/^\.popover-scrim\s*\{/m.test(css),
    'the scrim rule is still defined, so it will be reached for again');
});

test('every popover uses the shared dismiss hook', () => {
  /* Four of them: the launcher, global search, the user menu and the org
     switcher. Fixing one and leaving three is how the other three stay broken
     while the ticket reads as closed. */
  const nav = read(NAV);
  const ui = read(UI);

  assert(/useDismiss/.test(ui), 'ui.jsx does not define or use the hook');
  assert(/export function useDismiss/.test(ui), 'useDismiss is not exported');

  const uses = (nav.match(/useDismiss\(/g) ?? []).length;
  assert.equal(uses, 3,
    `AppNav should call useDismiss three times (launcher, search, user menu), found ${uses}`);

  assert(/OrgSwitcher[\s\S]{0,400}useDismiss\(/.test(ui),
    'the org switcher does not use the hook');
});

test('the hook closes on Escape as well as an outside click', () => {
  const ui = read(UI);
  const hook = ui.slice(ui.indexOf('export function useDismiss'));
  assert(/mousedown/.test(hook), 'the hook does not listen for an outside press');
  assert(/'Escape'/.test(hook), 'the hook does not close on Escape, which the ticket requires');
  assert(/removeEventListener/.test(hook), 'the hook leaks its listeners');
});

test('it listens on mousedown, not click', () => {
  /* A click fires after the trigger that opened the popover has been released,
     so on a toggling trigger the same gesture closes and reopens it -- which
     looks exactly like the popover refusing to close. */
  const ui = read(UI);
  const hook = ui.slice(ui.indexOf('export function useDismiss'), ui.indexOf('export function useDismiss') + 1400);
  assert(!/addEventListener\('click'/.test(hook),
    'the hook listens on click, which reopens a toggling trigger in the same gesture');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
