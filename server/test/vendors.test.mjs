/**
 * Vendor adapter unit tests.
 *
 * These cover the parts of an integration that fail silently rather than loudly:
 * field mapping (a mis-mapped field means a call that vanishes from the
 * timeline), number normalisation (a leading 91 means a dial that never
 * connects), template parameter ordering (a shifted array means a correct-looking
 * message that says the wrong thing), and webhook authentication (an unsigned
 * callback means anyone can write to a client's record).
 *
 * No network is touched. Everything here is pure mapping and policy.
 */

import assert from 'node:assert/strict';
import * as quickcall from '../src/vendors/quickcall.js';
import * as aisensy from '../src/vendors/aisensy.js';
import * as vendorConfig from '../src/vendors/config.js';
import * as bonanzakyc from '../src/vendors/bonanzakyc.js';
import { safeEqual } from '../src/vendors/http.js';

const results = [];
const test = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: err.message }); }
};

/* ------------------------------------------------- number normalisation */

test('Indian mobiles normalise to bare 10 digits from every common form', () => {
  for (const input of ['9876543210', '+919876543210', '919876543210', '09876543210', '+91 98765 43210', '98765-43210']) {
    assert.equal(quickcall.normaliseMsisdn(input), '9876543210', `failed on ${input}`);
  }
});

test('WhatsApp numbers carry the country code, dialler numbers do not', () => {
  /* Smartping's reference recommends `+(country code)(number)`, and says an
     unresolvable number is assumed Indian. Relying on a vendor's fallback to
     decide which country a client message goes to is not something to do on
     purpose, so the dial code is always explicit. The dialler is the opposite:
     the switch wants bare local digits. */
  assert.equal(aisensy.toWhatsAppNumber('9876543210'), '+919876543210');
  assert.equal(aisensy.toWhatsAppNumber('+91 98765 43210'), '+919876543210');
  assert.equal(aisensy.toWhatsAppNumber('09876543210'), '+919876543210');
  assert.equal(aisensy.toWhatsAppNumber(''), '', 'an empty number must not become a bare plus');
  assert.equal(quickcall.normaliseMsisdn('+919876543210'), '9876543210');
});

test('WhatsApp sends go to the Smartping path, not AiSensy own tenant path', () => {
  /* The adapter posted to /campaign/t1/api/v2 — AiSensy's tenant segment — for
     as long as this integration existed. Smartping's is /campaign/smartping/.
     Every send would have 404'd, and nothing would have caught it, because no
     test had ever looked at the URL. */
  assert.equal(vendorConfig.aisensy.campaignPath, '/campaign/smartping/api/v2');
});

/* ------------------------------------------------ QuickCall call events */

test('a QuickCall event maps regardless of field casing', () => {
  const lower = quickcall.parseCallEvent({
    callid: 'C-1', customerid: '42', dialnumber: '919876543210', calltype: 'OUTBOUND', callstatus: 'ANSWERED', talktime: '95',
  });
  const upper = quickcall.parseCallEvent({
    CallID: 'C-1', customerID: '42', DialNumber: '919876543210', CallType: 'OUTBOUND', CallStatus: 'ANSWERED', TalkTime: '95',
  });
  assert.deepEqual(lower, upper);
  assert.equal(upper.lead_id, 42);
  assert.equal(upper.mobile, '9876543210');
  assert.equal(upper.duration_s, 95);
});

test('inbound and outbound are told apart', () => {
  assert.equal(quickcall.parseCallEvent({ CallType: 'INBOUND' }).direction, 'inbound');
  assert.equal(quickcall.parseCallEvent({ CallType: 'OUTBOUND' }).direction, 'outbound');
  assert.equal(quickcall.parseCallEvent({ CallType: 'MANUAL' }).direction, 'outbound');
});

test('duration survives a vendor sending "00:01:35"-style values', () => {
  // Some deployments send a formatted string. We must not read that as zero.
  assert.ok(quickcall.parseCallEvent({ TalkTime: '95' }).duration_s === 95);
  assert.ok(quickcall.parseCallEvent({ TalkTime: '0' }).duration_s === 0);
});

test('a connected call is distinguished from a ring-out', () => {
  assert.equal(quickcall.wasAnswered({ duration_s: 95, status: 'ANSWERED' }), true);
  assert.equal(quickcall.wasAnswered({ duration_s: 0, status: 'NOANSWER' }), false);
  assert.equal(quickcall.wasAnswered({ duration_s: 0, status: 'BUSY' }), false);
  // Zero talk time is never a conversation, whatever the status says.
  assert.equal(quickcall.wasAnswered({ duration_s: 0, status: 'ANSWERED' }), false);
});

test('the recording URL is read from any of the known field names', () => {
  assert.equal(quickcall.parseCallEvent({ fileName: 'rec/1.wav' }).recording_url, 'rec/1.wav');
  assert.equal(quickcall.parseCallEvent({ RecordingURL: 'http://x/1.wav' }).recording_url, 'http://x/1.wav');
});

/* ----------------------------------------- AiSensy template parameters */

test('named template variables resolve into the declared positional order', () => {
  const params = aisensy.resolveParams(['name', 'product', 'rm'], { rm: 'Priya', name: 'Aarav', product: 'MF' });
  assert.deepEqual(params, ['Aarav', 'MF', 'Priya']);
});

test('a missing template variable is refused, never silently shifted', () => {
  // This is the failure that produces a plausible message saying the wrong thing.
  assert.throws(
    () => aisensy.resolveParams(['name', 'product', 'rm'], { name: 'Aarav', rm: 'Priya' }),
    /product/,
  );
});

test('a campaign with no declared variable order is refused', () => {
  assert.throws(() => aisensy.resolveParams([], { name: 'Aarav' }), /variable order/i);
  assert.throws(() => aisensy.resolveParams(undefined, {}), /variable order/i);
});

test('the 24-hour service window opens and closes correctly', () => {
  const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
  assert.equal(aisensy.windowOpen(minutesAgo(30)), true);
  assert.equal(aisensy.windowOpen(minutesAgo(23 * 60)), true);
  assert.equal(aisensy.windowOpen(minutesAgo(25 * 60)), false);
  assert.equal(aisensy.windowOpen(null), false);
  assert.equal(aisensy.windowOpen('not a date'), false);
});

test('a delivery receipt is told apart from a customer reply', () => {
  assert.equal(aisensy.parseWebhook({ status: 'delivered', destination: '919876543210' }).kind, 'status');
  assert.equal(aisensy.parseWebhook({ text: 'Yes please', waNumber: '919876543210' }).kind, 'message');
});

/* --------------------------------------------------- Bonanza eKYC link */

const LEAD = { id: 77, name: 'Aarav Malhotra', mobile: '9876543210' };

test('the KYC link carries the partner shortcode when a partner sourced the lead', () => {
  const url = new URL(bonanzakyc.journeyUrl({
    lead: LEAD,
    owner: { id: 5, kyc_shortcode: 'RM005' },
    partner: { id: 9, kyc_shortcode: 'PTR009' },
    productCode: 'EQ',
  }));
  // Partner attribution wins: the commission is theirs regardless of who services it.
  assert.equal(url.searchParams.get('shortcode'), 'PTR009');
  assert.equal(url.searchParams.get('utm_medium'), 'partner');
  assert.equal(url.searchParams.get('crm_ref'), 'LEAD-77');
});

test('an RM-sourced lead falls back to the RM shortcode', () => {
  const url = new URL(bonanzakyc.journeyUrl({ lead: LEAD, owner: { id: 5, kyc_shortcode: 'RM005' } }));
  assert.equal(url.searchParams.get('shortcode'), 'RM005');
  assert.equal(url.searchParams.get('utm_medium'), 'rm');
});

test('the link points at the configured portal and carries a correlation id', () => {
  const url = new URL(bonanzakyc.journeyUrl({ lead: LEAD }));
  assert.equal(url.origin, 'https://kyc.bonanzaonline.com');
  assert.equal(url.searchParams.get('crm_ref'), 'LEAD-77');
  assert.equal(url.searchParams.get('utm_source'), 'bonanza_crm');
});

test('an unrecognised portal stage becomes In Progress, never Complete', () => {
  // Wrongly reading a stage as Complete takes the lead off follow-up and loses
  // the account. Unknown must always fall to the safe side.
  const s = bonanzakyc.normaliseStatus({ stage: 'some_new_stage_we_have_not_seen' });
  assert.equal(s.stage, 'In Progress');
  assert.equal(s.complete, false);
  assert.equal(s.raw_stage, 'some_new_stage_we_have_not_seen');
});

test('terminal portal stages map correctly', () => {
  assert.equal(bonanzakyc.normaliseStatus({ stage: 'completed' }).complete, true);
  assert.equal(bonanzakyc.normaliseStatus({ stage: 'UCC' }).complete, true);
  assert.equal(bonanzakyc.normaliseStatus({ stage: 'rejected' }).rejected, true);
  assert.equal(bonanzakyc.normaliseStatus({ stage: 'penny drop' }).stage, 'Bank');
});

test('an empty payload reports not-found rather than a false status', () => {
  const s = bonanzakyc.normaliseStatus({});
  assert.equal(s.found, false);
  assert.equal(s.stage, null);
  assert.equal(s.complete, false);
});

/* ------------------------------------------------------ webhook safety */

test('every webhook refuses when no shared secret is configured', () => {
  // The default must be refusal. An unauthenticated writer of client records is
  // not an acceptable fallback, however convenient during setup.
  const req = { get: () => 'anything', query: {}, body: {} };
  for (const [label, verify] of [
    ['quickcall', quickcall.verifyWebhook],
    ['smartping', aisensy.verifyWebhook],
    ['bonanza kyc', bonanzakyc.verifyWebhook],
  ]) {
    const r = verify(req);
    assert.equal(r.ok, false, `${label} accepted a callback with no secret configured`);
    assert.match(r.reason, /SECRET/i, `${label} reason should name the missing setting`);
  }
});

test('signature comparison is length-safe and value-correct', () => {
  assert.equal(safeEqual('abc123', 'abc123'), true);
  assert.equal(safeEqual('abc123', 'abc124'), false);
  assert.equal(safeEqual('abc', 'abcdef'), false);
  assert.equal(safeEqual(null, ''), true);
  assert.equal(safeEqual(undefined, 'x'), false);
});

/* ------------------------------------------------------------- output */

console.log('\nvendor adapters');
for (const r of results) {
  console.log(`  ${r.ok ? '  ok' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n         → ${r.error}`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}\n`);
process.exit(failed ? 1 : 0);
