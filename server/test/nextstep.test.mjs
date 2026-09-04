/**
 * The next-step advice, and its button. P3-28, P3-29.
 *
 * Two defects with one shape: the server produced good advice and the client
 * could not act on it.
 *
 * P3-28 — the server emits five action kinds and the client's runner had cases
 * for two. `rm`, `kyc_view` and `none` fell through the switch, so "Request a
 * Product RM" and "Open the KYC journey" were buttons that did nothing at all.
 *
 * P3-29 — "Mark as Warm" routed to the add-a-product-interest modal, which by
 * design lists the products a lead is NOT engaged on. The one product the
 * advice was about was therefore the one product the dropdown could never
 * offer, and the modal hardcoded EXPLORING besides, ignoring the state the
 * advice asked for. The directive now carries its card, so the button acts on
 * it directly and the picker is out of the path.
 *
 * The check that matters is the first one: a kind added to the server with no
 * home in the client is a dead button, and it looks completely fine in review.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { nextStepForLead } from '../src/engine/nextaction.js';

const CRLF = /\r\n/g;
const read = (p) => readFileSync(p, 'utf8').replace(CRLF, '\n');

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nNext-step advice');

const ENGINE = 'src/engine/nextaction.js';
const ACTIONS = '../client/src/crm/leadActions.jsx';
const DETAIL = '../client/src/crm/LeadDetail.jsx';

test('every action kind the server emits has somewhere to go', () => {
  const kinds = [...new Set(
    [...read(ENGINE).matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]),
  )].sort();

  assert(kinds.length > 0, 'no kinds found — the scan is broken, not the code');

  const actions = read(ACTIONS);
  const detail = read(DETAIL);
  const client = actions + detail;

  for (const kind of kinds) {
    if (kind === 'none') continue;   // deliberately actionless; asserted below
    const handled = new RegExp(`(case '${kind}':|kind === '${kind}')`).test(client);
    assert(handled,
      `the server can emit kind "${kind}" and no client path handles it — `
      + 'that is a button that does nothing');
  }
});

test('a finished card offers no button at all', () => {
  /* `none` means there is nothing to chase. Rendering a control for it would be
     the very defect P3-28 was raised for. */
  const done = nextStepForLead([{
    id: 1, product_type_id: 1, product_name: 'Equity & Derivatives',
    state: 'ACTIVE', days_in_state: 3,
  }], new Set(['card.mark.warm', 'kyc.manage', 'kyc.view']));

  assert(done, 'an active card produced no advice at all');
  assert.equal(done.action, null, 'a finished card still offers a button');
  assert(done.headline, 'the advice lost its headline along with its button');
});

test('the advice carries the card it is about', () => {
  /* Without this the client cannot act, and falls back to a picker that lists
     the products the lead is not engaged on -- P3-29 exactly. */
  const step = nextStepForLead([{
    id: 42, product_type_id: 7, product_name: 'Equity & Derivatives',
    state: 'EXPLORING', days_in_state: 2,
  }], new Set(['card.mark.warm']));

  assert(step, 'no advice produced');
  assert.equal(step.card_id, 42, 'the advice does not name its card');
  assert.equal(step.product_type_id, 7, 'the advice does not name its product');
  assert.equal(step.action?.kind, 'state');
  assert.equal(step.action?.to, 'WARM', 'the advice does not say which state it means');
});

test('the button no longer routes through the add-a-product picker', () => {
  const detail = read(DETAIL);
  assert(!/actions\.run\(\s*lead\.next_step\.action\.kind === 'state' \? 'card'/.test(detail),
    'the next-step button still opens the add-a-product-interest modal, which '
    + 'cannot list the product the advice is about');
  assert(/actions\.nextStep\(/.test(detail), 'the button does not use the direct runner');
});

test('the runner acts on the card rather than opening a modal', () => {
  const actions = read(ACTIONS);
  const fn = actions.slice(actions.indexOf('async function nextStep'));
  assert(/cards\/\$\{step\.card_id\}\/state/.test(fn),
    'the state action does not post to the card it was given');
  assert(/request-product-rm/.test(fn),
    'the Product RM request is still unwired');
  assert(/action\.to/.test(fn),
    'the runner ignores the state the advice asked for, as the old modal did');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
