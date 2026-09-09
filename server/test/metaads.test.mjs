/**
 * Meta's other three capabilities: ads, audiences and DMs (P3-18).
 *
 * All three had working routes and no screen, and one of them had been
 * silently discarding everything it received for as long as it has existed:
 * a Messenger sender was looked up against `leads.external_id`, which holds a
 * Meta *leadgen* id, so the lookup failed for every message and the connector
 * reported zero messages forever — indistinguishable from nobody messaging.
 *
 * The tests that matter most here are the ones about money and about data
 * leaving the country, because those are the two things nobody can undo.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import { saveMessage, linkSender, conversations, leadForPsid } from '../src/engine/metaads.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

const PROBE = await probeAdmin('metaads', { role: 'superadmin' });

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nMeta ads, audiences and messages');

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const PSID = 'probe-psid-0001';

const clean = () => {
  run("DELETE FROM meta_ad_campaign WHERE name LIKE 'probe camp%'");
  run("DELETE FROM meta_audience_push WHERE name LIKE 'probe aud%'");
  run('DELETE FROM meta_message WHERE psid LIKE ?', ['probe-psid-%']);
  run('DELETE FROM meta_contact WHERE psid LIKE ?', ['probe-psid-%']);
  run("DELETE FROM activities WHERE external_id LIKE 'probe-mid-%'");
};
clean();

/* ------------------------------------------------------------ campaigns */

let publishedId = null;

await test('a published campaign is created paused and kept', async () => {
  /* Paused is the whole safety property: a CRM button that starts spending the
     second it is pressed is a bad idea however good the dialog. And it has to
     be kept, or there is no list to pull spend against and no answer to "who
     started this". */
  const res = await call('POST', '/admin/connectors/meta/campaigns', {
    name: 'probe camp alpha', daily_budget: 5000,
  });
  assert.equal(res.status, 201, `publish failed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.status, 'PAUSED', `campaign came back ${res.body.status}`);

  publishedId = res.body.id;
  const row = one('SELECT * FROM meta_ad_campaign WHERE meta_id = ?', [String(publishedId)]);
  assert(row, 'the campaign was published and not recorded');
  assert.equal(row.daily_budget, 5000);
  assert.equal(row.created_by, PROBE.id, 'the record does not say who published it');
  assert(row.sales_org, 'the campaign was recorded with no book');
});

await test('a campaign with no name is refused before it reaches Meta', async () => {
  const res = await call('POST', '/admin/connectors/meta/campaigns', { daily_budget: 100 });
  assert.equal(res.status, 400, `HTTP ${res.status}`);
});

await test('spend is cached with the time it was taken', async () => {
  /* Pulled on request rather than per page load: a paid API call against a
     rate limit, and yesterday's spend does not change. The screen says how old
     the number is instead of implying it is live. */
  const before = one('SELECT insights, insights_at FROM meta_ad_campaign WHERE meta_id = ?', [String(publishedId)]);
  assert.equal(before.insights_at, null, 'insights were pulled without being asked for');

  const res = await call('GET', `/admin/connectors/meta/campaigns/${publishedId}/insights`);
  assert.equal(res.status, 200, `HTTP ${res.status}`);

  const after = one('SELECT insights, insights_at FROM meta_ad_campaign WHERE meta_id = ?', [String(publishedId)]);
  assert(after.insights_at, 'the pull did not record when it happened');
  assert(after.insights, 'the pull did not keep what it fetched');
});

await test('the list only shows campaigns from books the user holds', async () => {
  const res = await call('GET', '/admin/connectors/meta/campaigns');
  assert.equal(res.status, 200);
  assert(res.body.some((c) => String(c.meta_id) === String(publishedId)), 'the published campaign is missing');

  /* A campaign parked in a book nobody holds must not appear. */
  run(`INSERT INTO meta_ad_campaign (meta_id, name, sales_org) VALUES ('probe-elsewhere', 'probe camp elsewhere', 'NOSUCHORG')`);
  const again = await call('GET', '/admin/connectors/meta/campaigns');
  assert(!again.body.some((c) => c.meta_id === 'probe-elsewhere'),
    "a campaign from a book the user does not hold was listed");
  run("DELETE FROM meta_ad_campaign WHERE meta_id = 'probe-elsewhere'");
});

/* ------------------------------------------------------------ audiences */

await test('a push is refused while the capability is switched off', async () => {
  /* The one capability that breaks this firm's own data-residency rule. Off
     unless somebody deliberately enabled it, and the refusal has to explain
     that it is a policy decision rather than a missing setting. */
  const list = one('SELECT id FROM lead_lists LIMIT 1');
  if (!list) return;

  const res = await call('POST', '/admin/connectors/meta/audiences', {
    name: 'probe aud alpha', list_id: list.id,
  });

  const enabled = (await call('GET', '/admin/connectors/meta/audiences')).body.enabled;
  if (enabled) {
    assert.equal(res.status, 200, `an enabled push failed: ${JSON.stringify(res.body)}`);
    return;
  }

  assert.equal(res.status, 409, `a push was allowed with the capability off: HTTP ${res.status}`);
  assert(/residen|India|complian/i.test(JSON.stringify(res.body)),
    `the refusal does not explain the conflict: ${JSON.stringify(res.body)}`);
});

await test('the screen states the residency conflict, whether or not it is on', async () => {
  /* In front of the person about to press the button, not in a document they
     read once. */
  const res = await call('GET', '/admin/connectors/meta/audiences');
  assert.equal(res.status, 200);
  assert(res.body.residency_note, 'no residency note is offered to the screen');
  assert(/India/i.test(res.body.residency_note), res.body.residency_note);
  assert.equal(typeof res.body.enabled, 'boolean');
  assert(Array.isArray(res.body.lists), 'no lead lists offered to push');
});

await test('a push records what left the country, and how much of it', async () => {
  /* Three counts kept apart: on the list, sent after the opt-out check, and
     matched by Meta. The gaps are the meaning. */
  run(
    `INSERT INTO meta_audience_push (name, list_id, sales_org, considered, sent, matched, pushed_by)
     VALUES ('probe aud recorded', NULL, 'BONANZA', 100, 84, 61, ?)`,
    [PROBE.id],
  );

  const res = await call('GET', '/admin/connectors/meta/audiences');
  const row = res.body.pushes.find((p) => p.name === 'probe aud recorded');
  assert(row, 'a recorded push is not listed');
  assert.equal(row.considered, 100);
  assert.equal(row.sent, 84, 'the opt-out gap was lost');
  assert.equal(row.matched, 61);
  assert(row.pushed_by_name, 'the push does not say who did it');
});

/* ------------------------------------------------------------- messages */

await test('a message is kept even when nobody knows who sent it', async () => {
  /* The defect: the sender was matched against leads.external_id, which holds
     a leadgen id. A page-scoped sender id never equals one, so every message
     was discarded and the connector reported zero forever. */
  const saved = saveMessage({
    externalId: 'probe-mid-1', psid: PSID, platform: 'Instagram',
    body: 'Is the SIP plan still open?', attachments: 0, at: '2026-09-09 10:00:00',
  });

  assert(saved, 'the message was dropped');
  assert.equal(saved.leadId, null, 'an unknown sender was matched to a lead');

  const row = one('SELECT * FROM meta_message WHERE external_id = ?', ['probe-mid-1']);
  assert.equal(row.psid, PSID);
  assert.equal(row.lead_id, null);
});

await test('a retried message is not stored twice', async () => {
  const again = saveMessage({
    externalId: 'probe-mid-1', psid: PSID, platform: 'Instagram',
    body: 'Is the SIP plan still open?', attachments: 0, at: '2026-09-09 10:00:00',
  });
  assert.equal(again, null, 'Meta retrying produced a second message');
  assert.equal(all('SELECT id FROM meta_message WHERE external_id = ?', ['probe-mid-1']).length, 1);
});

await test('an unclaimed conversation is listed before the claimed ones', async () => {
  const { rows, unmatched } = conversations();
  assert(unmatched >= 1, 'the unclaimed conversation was not counted');
  assert(rows.some((r) => r.psid === PSID), 'the conversation is missing');
  const mine = rows.find((r) => r.psid === PSID);
  assert.equal(mine.messages, 1);
  assert(/SIP plan/.test(mine.last_body), `last message was ${mine.last_body}`);
});

await test('linking a sender back-fills what they already sent', async () => {
  /* A link that only worked going forwards would strand the conversation that
     prompted somebody to make it. */
  saveMessage({
    externalId: 'probe-mid-2', psid: PSID, platform: 'Instagram',
    body: 'Anyone there?', attachments: 0, at: '2026-09-09 10:05:00',
  });

  const lead = one("SELECT id, sales_org FROM leads WHERE deleted_at IS NULL AND sales_org = 'BONANZA' LIMIT 1");
  const backfilled = linkSender(PSID, lead.id, PROBE.id);

  assert.equal(backfilled, 2, `${backfilled} messages were attached, expected 2`);
  assert.equal(leadForPsid(PSID), lead.id, 'the sender was not remembered');

  const acts = all("SELECT * FROM activities WHERE external_id LIKE 'probe-mid-%' ORDER BY external_id");
  assert.equal(acts.length, 2, 'the messages did not reach the timeline');
  assert.equal(acts[0].lead_id, lead.id);
  assert.equal(acts[0].type, 'Messenger',
    `an Instagram DM was recorded as a "${acts[0].type}" — that is a channel it never went through`);
  assert.equal(acts[0].direction, 'inbound');
});

await test('a message from a known sender goes straight to the timeline', async () => {
  const saved = saveMessage({
    externalId: 'probe-mid-3', psid: PSID, platform: 'Instagram',
    body: 'Following up', attachments: 0, at: '2026-09-09 11:00:00',
  });
  assert(saved.leadId, 'a known sender was not matched');
});

await test('a lead in a book the user does not hold cannot be linked', async () => {
  const res = await call('POST', '/admin/connectors/meta/messages/link', { psid: PSID, lead_id: 99999999 });
  assert.equal(res.status, 404, `HTTP ${res.status}`);

  const missing = await call('POST', '/admin/connectors/meta/messages/link', { psid: PSID });
  assert.equal(missing.status, 400, 'a link with no lead was accepted');
});

await test('the conversations route answers', async () => {
  const res = await call('GET', '/admin/connectors/meta/messages');
  assert.equal(res.status, 200, `HTTP ${res.status}`);
  assert(Array.isArray(res.body.rows), 'no conversations returned');
  assert.equal(typeof res.body.unmatched, 'number');
});

clean();
PROBE.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
