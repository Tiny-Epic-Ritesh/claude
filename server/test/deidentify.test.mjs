/**
 * De-identification unit tests.
 *
 * The e2e suite is deliberately HTTP-only, but this module is the one piece of
 * the system where a silent failure has a regulatory consequence rather than a
 * user-visible one: if scrubbing quietly stops working, every response still
 * looks correct. So it is tested directly, against the cases that actually
 * occur on an Indian broking desk.
 */

import assert from 'node:assert/strict';
import {
  Vault, scrubText, scrubDeep, knownIdentifiers, deidentify, residualPii, residualPiiDeep,
} from '../src/ai/deidentify.js';

const results = [];
const test = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: err.message }); }
};

/* --------------------------------------------------------- known values */

const LEAD = {
  name: 'Aarav Malhotra',
  mobile: '9876543210',
  email: 'aarav.malhotra@example.in',
  pan: 'ABCDE1234F',
  city: 'Indore',
  bank_account: '50100234567890',
  bank_ifsc: 'HDFC0001234',
};

test('a known full name is substituted', () => {
  const vault = new Vault();
  const out = scrubText('Spoke to Aarav Malhotra about F&O.', vault, knownIdentifiers({ lead: LEAD }));
  assert.ok(!out.includes('Aarav Malhotra'), out);
  assert.ok(out.includes('[NAME_'), out);
});

test('the first name alone is substituted too', () => {
  // On a transcript the caller says "Aarav", never the full name.
  const vault = new Vault();
  const out = scrubText('Aarav said he will fund tomorrow.', vault, knownIdentifiers({ lead: LEAD }));
  assert.ok(!/Aarav/i.test(out), out);
});

test('every known identifier type is removed', () => {
  const vault = new Vault();
  const text = Object.values(LEAD).join(' / ');
  const out = scrubText(text, vault, knownIdentifiers({ lead: LEAD }));
  for (const [field, value] of Object.entries(LEAD)) {
    assert.ok(!out.includes(value), `${field} survived: ${out}`);
  }
});

test('the same value always gets the same token', () => {
  const vault = new Vault();
  const out = scrubText('Call 9876543210, then 9876543210 again.', vault, []);
  const tokens = [...out.matchAll(/\[MOBILE_\d+\]/g)].map((m) => m[0]);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0], tokens[1]);
});

test('different values get different tokens', () => {
  const vault = new Vault();
  const out = scrubText('Primary 9876543210, alternate 9812345678.', vault, []);
  const tokens = new Set([...out.matchAll(/\[MOBILE_\d+\]/g)].map((m) => m[0]));
  assert.equal(tokens.size, 2, out);
});

/* ----------------------------------------------- unknown values: sweep */

test('a PAN we have never stored is still caught', () => {
  const vault = new Vault();
  const out = scrubText('He read out ZYXWV9876K on the call.', vault, []);
  assert.ok(!out.includes('ZYXWV9876K'), out);
});

test('an Aadhaar number is caught in every common format', () => {
  for (const form of ['234512347890', '2345 1234 7890', '2345-1234-7890']) {
    const vault = new Vault();
    const out = scrubText(`Aadhaar ${form}`, vault, []);
    assert.ok(!out.includes(form), `${form} survived: ${out}`);
  }
});

test('a number that cannot be an Indian mobile is not tokenised as one', () => {
  // Indian mobiles start 6-9. A 10-digit figure starting 2 must not be eaten,
  // or the sweep would corrupt legitimate values the model needs.
  const vault = new Vault();
  const out = scrubText('Turnover was 2345678901 rupees', vault, []);
  assert.ok(!out.includes('[MOBILE_'), out);
});

/* ------------------------------------------------- what must NOT be lost */

test('product names survive — the model must still reason about them', () => {
  const vault = new Vault();
  const out = scrubText('Interested in Mutual Funds and Equity Derivatives.', vault, knownIdentifiers({ lead: LEAD }));
  assert.ok(out.includes('Mutual Funds'), out);
  assert.ok(out.includes('Equity Derivatives'), out);
});

test('card states and ageing survive', () => {
  const vault = new Vault();
  const out = scrubText('Card is WARM, 14 days old, ticket breached.', vault, knownIdentifiers({ lead: LEAD }));
  assert.ok(out.includes('WARM'), out);
  assert.ok(out.includes('14 days'), out);
  assert.ok(out.includes('breached'), out);
});

/* ------------------------------------------------------------ round trip */

test('nested payloads are scrubbed at every depth', () => {
  const { scrubbed } = deidentify(
    { lead: { name: LEAD.name }, recent: [{ note: `Called ${LEAD.mobile}` }] },
    { lead: LEAD },
  );
  const raw = JSON.stringify(scrubbed);
  assert.ok(!raw.includes(LEAD.name), raw);
  assert.ok(!raw.includes(LEAD.mobile), raw);
});

test('numbers and booleans pass through untouched', () => {
  const vault = new Vault();
  const out = scrubDeep({ score: 87, breached: true, value: null }, vault, []);
  assert.deepEqual(out, { score: 87, breached: true, value: null });
});

test('the model answer is rehydrated with real identities', () => {
  const { scrubbed, vault } = deidentify({ summary: `Call ${LEAD.name} on ${LEAD.mobile}` }, { lead: LEAD });
  const token = scrubbed.summary.match(/\[NAME_\d+\]/)[0];
  const restored = vault.rehydrateDeep({ text: `Next: contact ${token} today.` });
  assert.ok(restored.text.includes(LEAD.name), restored.text);
});

test('the audit summary carries counts, never values', () => {
  const { vault } = deidentify({ t: `${LEAD.name} ${LEAD.mobile} ${LEAD.pan}` }, { lead: LEAD });
  const summary = vault.summary();
  const raw = JSON.stringify(summary);
  for (const value of Object.values(LEAD)) assert.ok(!raw.includes(value), `${value} in audit summary`);
  assert.ok(Object.values(summary).every(Number.isInteger), raw);
});

/* ---------------------------------------------------------- the verifier */

test('the verifier catches a known value that survived', () => {
  const found = residualPii(`contact ${LEAD.name}`, knownIdentifiers({ lead: LEAD }));
  assert.ok(found.length > 0);
});

test('the verifier never echoes the full value it found', () => {
  const found = residualPii(`contact ${LEAD.mobile}`, knownIdentifiers({ lead: LEAD }));
  for (const f of found) assert.ok(!f.value.includes(LEAD.mobile), JSON.stringify(f));
});

test('a properly scrubbed payload passes the verifier clean', () => {
  const { scrubbed } = deidentify({ lead: LEAD, note: `Spoke to ${LEAD.name} on ${LEAD.mobile}` }, { lead: LEAD });
  const found = residualPii(JSON.stringify(scrubbed), knownIdentifiers({ lead: LEAD }));
  assert.equal(found.length, 0, JSON.stringify(found));
});

test('a rupee amount is not mistaken for a PIN code', () => {
  // Regression: verifying JSON.stringify(payload) pulled untouched numeric
  // fields into the text, where a 250000 pipeline value matched the PIN
  // pattern and fail-closed blocked an entirely lawful call.
  const payload = { pipelineValue: 250000, score: 87, ageDays: 142536 };
  assert.deepEqual(residualPiiDeep(payload, knownIdentifiers({ lead: LEAD })), []);
});

test('an identifier hiding in a numeric field is still caught', () => {
  const payload = { alt_contact: Number(LEAD.mobile) };
  const found = residualPiiDeep(payload, knownIdentifiers({ lead: LEAD }));
  assert.ok(found.length > 0, 'a mobile number in a numeric column slipped through');
});

test('the deep verifier passes a correctly scrubbed realistic payload', () => {
  const payload = {
    lead: LEAD,
    pipelineValue: 250000,
    cards: [{ state: 'WARM', value: 100000, product_name: 'Mutual Funds' }],
    recent: [{ note: `Spoke to ${LEAD.name} on ${LEAD.mobile}`, at: '2026-08-20T09:15:00.000Z' }],
  };
  const { scrubbed } = deidentify(payload, { lead: LEAD });
  assert.deepEqual(residualPiiDeep(scrubbed, knownIdentifiers({ lead: LEAD })), []);
});

test('staff names are removed as well — they are personal data too', () => {
  const vault = new Vault();
  const known = knownIdentifiers({ lead: LEAD, owner: { name: 'Priya Deshmukh' } });
  const out = scrubText('Owner Priya Deshmukh reassigned the lead.', vault, known);
  assert.ok(!out.includes('Priya Deshmukh'), out);
  assert.ok(out.includes('[AGENT_'), out);
});

/* ------------------------------------------------------------- output */

console.log('\nde-identification');
for (const r of results) {
  console.log(`  ${r.ok ? '  ok' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n         → ${r.error}`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}\n`);
process.exit(failed ? 1 : 0);
