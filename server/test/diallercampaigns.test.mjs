/**
 * Which CUBE queue a call goes into.
 *
 * This is the data half of the P2-04a cross-campaign requirement. The adapter
 * can carry a campaign per call; these rules decide which one, and they are
 * worth testing on their own because the failure is silent in both directions:
 * a call into the wrong queue still connects, and a Bigul call landing in a
 * Bonanza queue is a book boundary crossed on the vendor's side of the line,
 * where we cannot correct it afterwards.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { campaignFor } from '../src/integrations.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nDialler queue resolution');

const RUN = String(Date.now()).slice(-6);
const eqd = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND code = 'EQD'");
const mf = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND code = 'MF'");

test('a lead resolves to its own book, never the other one', () => {
  /* The boundary. A queue belongs to one business, and a Bigul lead must never
     be dialled from a Bonanza queue however the rules fall out. */
  const bonanzaQueues = new Set(
    all("SELECT cube_campaign_id FROM dialler_campaigns WHERE sales_org = 'BONANZA'")
      .map((c) => c.cube_campaign_id),
  );
  const bigulQueues = new Set(
    all("SELECT cube_campaign_id FROM dialler_campaigns WHERE sales_org = 'BIGUL'")
      .map((c) => c.cube_campaign_id),
  );

  for (const lead of all('SELECT id, sales_org FROM leads WHERE deleted_at IS NULL LIMIT 200')) {
    const { campaign } = campaignFor(lead);
    if (!campaign) continue;
    const wrongBook = lead.sales_org === 'BIGUL' ? bonanzaQueues : bigulQueues;
    assert(!wrongBook.has(campaign),
      `lead ${lead.id} (${lead.sales_org}) resolved to ${campaign}, which is the other book's queue`);
  }
});

test('an explicit product picks that product’s queue', () => {
  const lead = one("SELECT id, sales_org FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL LIMIT 1");
  const res = campaignFor(lead, eqd.id);
  assert.equal(res.source, 'product', `expected a product queue, got ${res.source}`);
  assert.equal(res.campaign, 'BNZ_EQ_DESK');
});

test('a product with no queue of its own falls back to the book default', () => {
  // MF has no registered queue, so it must not silently borrow the equity one.
  const lead = one("SELECT id, sales_org FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL LIMIT 1");
  const res = campaignFor(lead, mf.id);
  assert.equal(res.source, 'book', `expected the book default, got ${res.source}`);
  assert.equal(res.campaign, 'BNZ_SALES_OUT');
});

test('a Bigul lead cannot reach a Bonanza product queue even when named', () => {
  /* The nastiest case: an explicit Bonanza product id on a Bigul lead. The
     product lookup is scoped by the lead's book, so it finds nothing and falls
     through to Bigul's default rather than crossing. */
  const lead = one("SELECT id, sales_org FROM leads WHERE sales_org = 'BIGUL' AND deleted_at IS NULL LIMIT 1");
  if (!lead) throw new Error('no Bigul lead seeded to test with');
  const res = campaignFor(lead, eqd.id);
  assert.equal(res.campaign, 'BGL_SALES_OUT', `crossed the book to ${res.campaign}`);
});

test('a retired queue is never dialled into', () => {
  const q = one("SELECT * FROM dialler_campaigns WHERE cube_campaign_id = 'BNZ_EQ_DESK'");
  const lead = one("SELECT id, sales_org FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL LIMIT 1");
  run('UPDATE dialler_campaigns SET active = 0 WHERE id = ?', [q.id]);
  try {
    const res = campaignFor(lead, eqd.id);
    assert.notEqual(res.campaign, 'BNZ_EQ_DESK', 'a retired queue was still selected');
    assert.equal(res.campaign, 'BNZ_SALES_OUT', 'should fall through to the book default');
  } finally {
    run('UPDATE dialler_campaigns SET active = 1 WHERE id = ?', [q.id]);
  }
});

test('a book with no queues at all reports the fallback rather than inventing one', () => {
  /* The adapter then uses the configured placeholder. What matters is that the
     caller is told the queue was not chosen, so a screen can say so instead of
     showing a campaign name that means nothing. */
  const lead = { id: null, sales_org: `NOWHERE_${RUN}` };
  const res = campaignFor(lead);
  assert.equal(res.campaign, null);
  assert.equal(res.source, 'fallback');
});

test('one default per book, so "the book default" has one answer', () => {
  for (const org of ['BONANZA', 'BIGUL']) {
    const defaults = all(
      'SELECT cube_campaign_id FROM dialler_campaigns WHERE sales_org = ? AND is_default = 1 AND active = 1',
      [org],
    );
    assert(defaults.length <= 1,
      `${org} has ${defaults.length} default queues: ${defaults.map((d) => d.cube_campaign_id).join(', ')}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
