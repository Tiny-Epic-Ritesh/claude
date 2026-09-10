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

test('a live card offers the move its own advice names', () => {
  /* This used to assert that an Active card offered no button, and that was
     right while `ACTIVE` had nothing to offer. It did not: the state carried
     the label "See what else they could hold" all along, with `kind: 'none'`,
     so P3-28's rule stripped a control that was meant to be real and the panel
     read "Nothing to chase" for months.

     Ritesh settled it on 10 September. The rule underneath this test was never
     "Active has no button" -- it was "no button is rendered with nothing behind
     it", which is asserted separately below and still holds. */
  const done = nextStepForLead([{
    id: 1, product_type_id: 1, product_name: 'Equity & Derivatives',
    state: 'ACTIVE', days_in_state: 3,
  }], new Set(['card.mark.warm', 'kyc.manage', 'kyc.view']));

  assert(done, 'an active card produced no advice at all');
  assert(done.headline, 'the advice lost its headline');
  assert.equal(done.action?.kind, 'review',
    'the header says the next move is a review and then offers something else, or nothing');
  assert.equal(done.card_id, 1,
    'the review has no card to hang on, so the task would name no product');
});

test('no advice ever offers a button with nothing behind it', () => {
  /* The rule P3-28 was actually raised for, asserted directly rather than
     through one state that happened to have no action. */
  for (const state of ['INACTIVE', 'EXPLORING', 'WARM', 'PRODUCT_RM_ENGAGED',
    'KYC_IN_PROGRESS', 'ACTIVE', 'ON_HOLD', 'LOST']) {
    const step = nextStepForLead([{
      id: 9, product_type_id: 1, product_name: 'Equity & Derivatives',
      state, days_in_state: 1,
    }], new Set(['card.mark.warm', 'card.mark.exploring', 'card.request.productrm',
      'kyc.manage', 'kyc.view']));
    if (!step?.action) continue;
    assert.notEqual(step.action.kind, 'none',
      `${state} offers a button whose kind is "none" — a control that does nothing`);
  }
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
