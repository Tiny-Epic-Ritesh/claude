/**
 * Every action the record menu offers can actually be performed. N-9, P3-29.
 *
 * WHY THIS FILE EXISTS
 *
 * "Start KYC journey" was offered to everyone holding `kyc.manage` and failed
 * on every single click. It posted `{ lead_id }`; `POST /kyc/journeys` needs a
 * `card_id` or a `product_type_id`, because a journey is a journey *for a
 * product* — the steps for a demat account are not the steps for a PMS mandate.
 * So the button returned 400 and put the server's own wording on screen:
 * "product_type_id or card_id is required".
 *
 * Nothing caught it, and nothing could have. The key was declared, the handler
 * existed, the route existed, the capability was right, and the import was
 * there. Only the *payload* was wrong. A code read finds none of that; it was
 * found by pressing the button, which is what N-9 asked for.
 *
 * These are the two checks that make the class cheaper than a click-through
 * next time: an offered action must have somewhere to go, and the two calls
 * whose bodies have a required shape must carry it.
 *
 * Static, like `icons.test.mjs` and `setupshell.test.mjs`: it reads the client
 * source rather than running it, because the alternative is a browser in CI.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const CRLF = /\r\n/g;
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(CRLF, '\n');

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nLead actions');

const MENU = read('../../client/src/components/ActionMenu.jsx');
const HOOK = read('../../client/src/crm/leadActions.jsx');
const MODALS = read('../../client/src/crm/ActionModals.jsx');

test('every action the record menu offers has somewhere to go', () => {
  /* The menu is declared in one place and performed in another. A key added to
     the first and forgotten in the second is a button that opens nothing —
     which is the defect P3-29 was raised for, in its other form. */
  const declared = [...MENU.matchAll(/\{ key: '([a-z_]+)', label: '[^']+'[^}]*group: '/g)].map((m) => m[1]);
  assert(declared.length >= 12, `only ${declared.length} record actions parsed — the pattern has drifted`);

  for (const key of declared) {
    const handled = new RegExp(`case '${key}':`).test(HOOK)
      /* `edit` is intercepted by the lead page itself, which owns the form. */
      || (key === 'edit' && /key === 'edit'/.test(read('../../client/src/crm/LeadDetail.jsx')));
    assert(handled, `the menu offers "${key}" and nothing in the action runner handles it`);
  }
});

test('every modal kind the runner opens is one the modal switch knows', () => {
  /* The other half of the same seam. `setModal({ kind: 'kyc' })` with no
     `case 'kyc'` renders nothing at all, silently. */
  const kinds = [...HOOK.matchAll(/setModal\(\{ kind: '([a-z_]+)'/g)].map((m) => m[1]);
  assert(kinds.length > 0, 'no modal kinds found — the scan is broken, not the code');

  for (const kind of new Set(kinds)) {
    assert(new RegExp(`case '${kind}':`).test(MODALS),
      `the runner opens a "${kind}" modal and ActionModals has no case for it`);
  }
});

test('starting a KYC journey always names a product', () => {
  /* The specific bug. `POST /kyc/journeys` requires a card or a product type,
     and a call that sends neither fails every time it is made — which is
     exactly what shipped, for every click of the Actions menu's Start KYC. */
  const sources = [
    ['ActionModals.jsx', MODALS],
    ['leadActions.jsx', HOOK],
    ['ProductPanel.jsx', read('../../client/src/crm/ProductPanel.jsx')],
    ['InCall.jsx', read('../../client/src/crm/InCall.jsx')],
  ];

  let found = 0;
  for (const [name, src] of sources) {
    for (const m of src.matchAll(/api\.post\(\s*'\/kyc\/journeys'\s*,\s*\{([^}]*)\}/g)) {
      found += 1;
      const body = m[1];
      assert(/card_id|product_type_id/.test(body),
        `${name} starts a KYC journey without naming a product — the route refuses it every time:\n         { ${body.trim()} }`);
    }
  }
  assert(found > 0, 'no KYC journey calls found in the client — the scan is broken, not the code');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
