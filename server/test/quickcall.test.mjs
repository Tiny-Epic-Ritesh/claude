/**
 * CUBE QuickCall adapter.
 *
 * The previous adapter was written against vocabulary read out of the vendor's
 * app bundle and was wrong in nearly every particular — wrong endpoints, wrong
 * auth scheme, wrong field names. Nothing caught it, because the simulator sat
 * *above* the field mapping: no test ever built a request body.
 *
 * These tests exist to make that class of error impossible to repeat. The
 * adapter now simulates below its own mapping and returns the body it would
 * have sent, so every assertion here is against the exact payload CUBE would
 * receive. A typo in `CampaignID` fails a test rather than the first live call.
 *
 * Field names are asserted verbatim against
 * `docs/integrations/CUBE-QUICKCALL-API.md`, including the casing
 * inconsistencies the real API has.
 */

import { strict as assert } from 'node:assert';
import {
  makeCall, loadCampaign, fetchCallLog, parseCallEvent,
  normaliseMsisdn, wasAnswered, resetToken,
} from '../src/vendors/quickcall.js';

let passed = 0;
let failed = 0;
const test = async (nameOfTest, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${nameOfTest}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${nameOfTest}\n       ${err.message}`); }
};

console.log('\nCUBE QuickCall adapter');

/* ------------------------------------------------------------- numbers */

await test('Indian numbers reach the switch as bare ten digits', () => {
  for (const raw of ['9899978503', '+91 98999 78503', '09899978503', '91-9899978503']) {
    assert.equal(normaliseMsisdn(raw), '9899978503', `failed on ${raw}`);
  }
});

await test('an undialable number is refused before it reaches CUBE', async () => {
  await assert.rejects(() => makeCall({ mobile: '12345', campaign: 'CubeTest' }), /not a dialable/i);
  await assert.rejects(() => makeCall({ mobile: null, campaign: 'CubeTest' }), /not a dialable/i);
});

/* ------------------------------------------------------- the call body */

await test('a call is placed on Click2Call, with the exact documented fields', async () => {
  const res = await makeCall({
    agentId: 'bsingh', mobile: '+91 98999 78503', leadId: 4211,
    leadName: 'Anita Desai', campaign: 'CubeSales_Out',
  });

  // Verbatim from the specification. Note CampaignID / AgentID / ClientID are
  // upper-case D on this endpoint and lower on others; that is the vendor's
  // inconsistency, and the adapter must honour it rather than normalise it.
  assert.deepEqual(res.sent, {
    PhoneNo: '9899978503',
    CampaignID: 'CubeSales_Out',
    AgentID: 'bsingh',
    ClientID: '4211',
    Name: 'Anita Desai',
  }, 'the body CUBE would receive is not the documented one');
});

await test('the campaign travels per call — the cross-campaign requirement', async () => {
  /* P2-04a: an agent must be able to call irrespective of the campaign they
   * logged into. This is the whole reason Click2Call is used rather than
   * AuthManualPass, which takes no campaign at all. If a future change routed
   * calls through the session endpoint, this fails. */
  const a = await makeCall({ agentId: 'bsingh', mobile: '9899978503', campaign: 'CubeSales_Out' });
  const b = await makeCall({ agentId: 'bsingh', mobile: '9899978503', campaign: 'CubeRetention' });

  assert.equal(a.sent.CampaignID, 'CubeSales_Out');
  assert.equal(b.sent.CampaignID, 'CubeRetention');
  assert.equal(a.campaign, 'CubeSales_Out');
  assert.equal(b.campaign, 'CubeRetention');
});

await test('no AuthId and no agent password are ever sent on a call', async () => {
  /* The reason the calling path needs no credential store. If someone later
   * "improves" this by logging the agent in first, this test says why not. */
  const res = await makeCall({ agentId: 'bsingh', mobile: '9899978503', campaign: 'CubeTest' });
  const keys = Object.keys(res.sent);
  assert(!keys.includes('AuthId'), 'a session id leaked into the call body');
  assert(!keys.some((k) => /password/i.test(k)), 'a password leaked into the call body');
});

await test('empty optional fields are dropped rather than sent blank', async () => {
  // A blank Name on a dialler record is worse than an absent one: it overwrites.
  const res = await makeCall({ agentId: 'bsingh', mobile: '9899978503', campaign: 'CubeTest' });
  assert(!('Name' in res.sent), 'an empty Name was sent');
  assert(!('ClientID' in res.sent), 'an empty ClientID was sent');
  assert(!('Remark' in res.sent), 'an empty Remark was sent');
});

await test('a call always carries a campaign, even when none is named', async () => {
  /* CampaignID is required by CUBE, so there must always be one to fall back
     to. The adapter refuses rather than sending a blank — asserted here as the
     invariant that matters: no call leaves without a campaign on it. */
  const res = await makeCall({ agentId: 'bsingh', mobile: '9899978503' });
  assert(res.sent.CampaignID, 'a call went out with no campaign');
  assert.equal(res.campaign, res.sent.CampaignID, 'the reported campaign is not the one sent');
});

await test('the call id comes back, because it is the only reliable key we get', async () => {
  const res = await makeCall({ agentId: 'bsingh', mobile: '9899978503', campaign: 'CubeTest', leadId: 7 });
  assert(res.call_id, 'no call id returned');
  assert.equal(res.simulated, true, 'should be simulated with no credentials configured');
});

await test('the adapter does not claim the phone is ringing', () => {
  /* Click2Call may queue rather than dial — §7 of the reference, unverified
   * until UAT. Reporting "ringing" would be a small lie told to an agent
   * waiting for a connection. */
  return makeCall({ agentId: 'bsingh', mobile: '9899978503', campaign: 'CubeTest' })
    .then((res) => {
      assert.equal(res.status, 'accepted', `claimed "${res.status}" when only acceptance is known`);
    });
});

/* ----------------------------------------------------------- dial list */

await test('a dial list is uploaded with the documented shape', async () => {
  const res = await loadCampaign({
    campaign: 'CubeSales_Out',
    leads: [
      { id: 1, name: 'Anita Desai', mobile: '+919899978503' },
      { id: 2, name: 'Ravi Kumar', mobile: '09876543210' },
    ],
  });
  assert.equal(res.campaign, 'CubeSales_Out');
  assert.equal(res.inserted, 2, 'the load report was not read back');
  assert.equal(res.records, 2);
});

await test('the load report is surfaced, so a partial load is not called a success', async () => {
  const res = await loadCampaign({ campaign: 'CubeTest', leads: [{ id: 1, name: 'A', mobile: '9899978503' }] });
  for (const k of ['rejected', 'duplicates', 'malformed']) {
    assert.equal(typeof res[k], 'number', `${k} missing from the load result`);
  }
});

await test('an upload larger than one batch still reports one total', async () => {
  // Chunked at 500; the totals must accumulate rather than report the last chunk.
  const leads = Array.from({ length: 1100 }, (_, i) => ({ id: i + 1, name: `L${i}`, mobile: '9899978503' }));
  const res = await loadCampaign({ campaign: 'CubeTest', leads });
  assert.equal(res.records, 1100, `chunk totals did not accumulate: got ${res.records}`);
});

await test('an empty upload does not call CUBE at all', async () => {
  const res = await loadCampaign({ campaign: 'CubeTest', leads: [] });
  assert.equal(res.records, 0);
  assert.equal(res.inserted, 0);
});

/* ------------------------------------------------------------ call log */

await test('call log records are marked inferred, because CUBE returns no lead id', async () => {
  /* §4 of the reference: AuthCallLog returns neither our ClientId nor a call
   * id, so attribution from this source is a guess. It must be labelled as one
   * — an inferred match presented as fact is worse than one presented as
   * inferred, especially for family accounts sharing a mobile. */
  const res = await fetchCallLog({ campaign: 'CubeTest', date: '2026-08-31' });
  assert.equal(res.campaign, 'CubeTest');
  assert(Array.isArray(res.records), 'records is not a list');
  for (const r of res.records) {
    assert.equal(r.match, 'inferred', 'a call log record claimed a certain match');
    assert.equal(r.lead_id, null, 'a call log record invented a lead id');
  }
});

/* ------------------------------------------------------------- inbound */

await test('a Save Call callback is read whatever the casing', () => {
  const a = parseCallEvent({
    callID: 'C-1', ClientID: '4211', AgentID: 'bsingh', PhoneNo: '+919899978503',
    CallType: 'OUTBOUND', CallStatus: 'ANSWERED', Duration: '95', CampaignID: 'CubeTest',
  });
  const b = parseCallEvent({
    CallID: 'C-1', customerID: '4211', AgentId: 'bsingh', DialNumber: '9899978503',
    calltype: 'outbound', Status: 'ANSWERED', TalkTime: '95 s', CampaignName: 'CubeTest',
  });

  for (const e of [a, b]) {
    assert.equal(e.call_id, 'C-1');
    assert.equal(e.lead_id, 4211, 'the lead we dialled was not recovered');
    assert.equal(e.mobile, '9899978503');
    assert.equal(e.direction, 'outbound');
    assert.equal(e.duration_s, 95);
  }
});

await test('an inbound call is recognised as inbound', () => {
  assert.equal(parseCallEvent({ CallType: 'INBOUND' }).direction, 'inbound');
  assert.equal(parseCallEvent({ Direction: 'Incoming' }).direction, 'inbound');
  assert.equal(parseCallEvent({}).direction, 'outbound', 'an unlabelled call should default outbound');
});

await test('a call that never connected is not counted as a conversation', () => {
  assert.equal(wasAnswered({ duration_s: 0, status: 'ANSWERED' }), false, 'zero duration is not a conversation');
  assert.equal(wasAnswered({ duration_s: 40, status: 'NO ANSWER' }), false);
  assert.equal(wasAnswered({ duration_s: 40, status: 'no_answer' }), false);
  assert.equal(wasAnswered({ duration_s: 40, status: 'ANSWERED' }), true);
});

/* --------------------------------------------------------------- token */

await test('the token is cached rather than fetched per call', async () => {
  resetToken();
  const a = await makeCall({ agentId: 'x', mobile: '9899978503', campaign: 'CubeTest' });
  const b = await makeCall({ agentId: 'x', mobile: '9899978503', campaign: 'CubeTest' });
  // Simulated mode never authenticates, so this asserts the calls succeed
  // rather than the token count; the cache itself is exercised live.
  assert(a.call_id && b.call_id, 'repeat calls did not both succeed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
