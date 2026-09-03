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

test('a campaign belongs to a team, and the team wins over the product', () => {
  /* Ritesh, 3 Sep 2026: a Cube campaign is per team. That is why this is asked
     before the product — a team is a property of whoever is dialling, while a
     product is a property of the lead, so two people on one team calling the
     same lead about different things belong in the same queue. */
  const team = one("SELECT id FROM teams WHERE name = 'Digital Desk'");
  const row = one('SELECT cube_campaign_id FROM dialler_campaigns WHERE team_id = ?', [team.id]);
  assert(row, 'the Digital Desk has no campaign mapped, so this test proves nothing');

  const member = one('SELECT user_id FROM team_members WHERE team_id = ?', [team.id]);
  const lead = one("SELECT id, sales_org FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL");

  // With a product that has its own queue, the team still wins.
  const res = campaignFor(lead, eqd.id, member.user_id);
  assert.equal(res.source, 'team', `resolved by ${res.source}, not the team`);
  assert.equal(res.campaign, row.cube_campaign_id);
});

test('the mapped campaign is Cube\'s name, not one of ours', () => {
  /* `cube_campaign_id` is the CampaignId as CUBE knows it. Ours are labels.
     Sending our own code would have CUBE reject the call naming a campaign it
     does not have, which is a failure at the switch rather than here. */
  const team = one("SELECT id FROM teams WHERE name = 'Digital Desk'");
  const row = one('SELECT cube_campaign_id, label FROM dialler_campaigns WHERE team_id = ?', [team.id]);
  assert.equal(row.cube_campaign_id, 'Bonanza_APITest',
    'the Digital Desk is not mapped to the campaign Cube gave us');
  assert(!row.cube_campaign_id.startsWith('PLACEHOLDER_'),
    'a placeholder is mapped to a real team, which would fail at the switch');
});

test('a team in the other book is no way across the boundary', () => {
  /* The boundary again, from the new direction. Somebody on a Bonanza team
     calling a Bigul lead must not be handed their own team's queue — that
     would be the book crossed on the vendor's side, where it cannot be
     corrected afterwards. */
  const team = one("SELECT id FROM teams WHERE name = 'Digital Desk'");
  const member = one('SELECT user_id FROM team_members WHERE team_id = ?', [team.id]);
  const bigulLead = one("SELECT id, sales_org FROM leads WHERE sales_org = 'BIGUL' AND deleted_at IS NULL");

  if (!bigulLead) {
    assert(false, 'no Bigul lead in the seed, so the boundary cannot be tested');
    return;
  }

  const res = campaignFor(bigulLead, null, member.user_id);
  assert.notEqual(res.source, 'team', 'a Bonanza team was used to dial a Bigul lead');
  assert.notEqual(res.campaign, 'Bonanza_APITest', 'a Bigul lead resolved to the Bonanza test campaign');
});

test('somebody with no team campaign still falls through to the book', () => {
  // The chain has to keep working for everyone who is not on a mapped team.
  const lead = one("SELECT id, sales_org FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL");
  const orphan = one(
    `SELECT id FROM users WHERE sales_org = 'BONANZA' AND id NOT IN (
       SELECT m.user_id FROM team_members m
        JOIN dialler_campaigns dc ON dc.team_id = m.team_id)`,
  );
  assert(orphan, 'every Bonanza user is on a mapped team, so this path is untested');

  const res = campaignFor(lead, null, orphan.id);
  assert(['product', 'book', 'fallback'].includes(res.source),
    `resolved by ${res.source}, which is not one of the fallbacks`);
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
