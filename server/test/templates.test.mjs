/**
 * Template creation (P3-17).
 *
 * The rules enforced here are not ours. A WhatsApp template is submitted to
 * Meta and approved or rejected by Meta, so a builder that accepts a
 * 90-character header collects somebody's work and loses it a day later to a
 * rejection they cannot read. Every limit is checked at the point of writing,
 * and these tests are the record of which limits those are.
 *
 * The other load-bearing piece is the translation. Our merge fields are named,
 * because a person writing a template should not have to hold a numbering in
 * their head; Meta's are positional. Getting that mapping wrong sends a client
 * their RM's name where their own should be, which is the kind of mistake that
 * is only ever noticed by the client.
 */

import { strict as assert } from 'node:assert';
import { one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import {
  checkTemplate, toMetaTemplate, smsSegments, withExamples, CHANNELS,
} from '../src/engine/templates.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

const PROBE = await probeAdmin('templates');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nTemplates');

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const WA = {
  channel: 'whatsapp',
  name: 'templates_probe',
  body: 'Hi {{name}}, your {{product}} review with {{rm}} is due.',
  components: {
    category: 'UTILITY',
    language: 'en',
    header: { type: 'text', text: '{{org}} portfolio review' },
    footer: 'Reply STOP to opt out',
    buttons: [{ type: 'quick_reply', text: 'Book a time' }],
  },
};

const clean = () => run("DELETE FROM templates WHERE name LIKE 'templates_probe%'");
clean();

/* -------------------------------------------------- the provider's limits */

await test('a valid WhatsApp template has nothing wrong with it', () => {
  assert.deepEqual(checkTemplate(WA), [], `unexpected problems: ${JSON.stringify(checkTemplate(WA))}`);
});

await test("Meta's limits are refused before Meta refuses them", () => {
  /* Each of these comes back from Meta as a rejection a day later if it is not
     caught here. The message has to name the rule, not just say no. */
  const cases = [
    ['a name Meta will not accept', { name: 'SIP Review' }, /lower case/i],
    ['a header over 60 characters', { components: { ...WA.components, header: { type: 'text', text: 'x'.repeat(61) } } }, /60/],
    ['two variables in a header', { components: { ...WA.components, header: { type: 'text', text: '{{name}} {{rm}}' } } }, /one merge field/i],
    ['a merge field in a footer', { components: { ...WA.components, footer: 'Hi {{name}}' } }, /footer cannot/i],
    ['no category', { components: { ...WA.components, category: undefined } }, /category/i],
    ['a body over 1024 characters', { body: 'x'.repeat(1025) }, /1024/],
  ];

  for (const [label, patch, expected] of cases) {
    const problems = checkTemplate({ ...WA, ...patch });
    assert(problems.length, `${label} was accepted`);
    assert(problems.some((p) => expected.test(p.message)),
      `${label}: message was "${problems.map((p) => p.message).join('; ')}"`);
  }
});

await test('too many buttons of either kind is refused', () => {
  const quick = checkTemplate({
    ...WA,
    components: { ...WA.components, buttons: Array.from({ length: 4 }, (_, i) => ({ type: 'quick_reply', text: `B${i}` })) },
  });
  assert(quick.some((p) => /3 quick replies/.test(p.message)), 'four quick replies were accepted');

  const cta = checkTemplate({
    ...WA,
    components: {
      ...WA.components,
      buttons: Array.from({ length: 3 }, (_, i) => ({ type: 'url', text: `B${i}`, url: 'https://x.test' })),
    },
  });
  assert(cta.some((p) => /2 call-to-action/.test(p.message)), 'three CTA buttons were accepted');
});

await test('a merge field we cannot fill is refused', () => {
  /* It would render as the literal text {{account_number}} in a client's
     WhatsApp, which is worse than refusing it here. */
  const problems = checkTemplate({ ...WA, body: 'Your balance is {{account_number}}' });
  assert(problems.some((p) => /account_number/.test(p.message)), 'an unknown merge field was accepted');
});

await test('all the problems come back, not the first', () => {
  /* Being told about one, fixing it, and being told about the next is how a
     form becomes something people work around. */
  const problems = checkTemplate({
    channel: 'whatsapp',
    name: 'Bad Name',
    body: '',
    components: { footer: 'Hi {{name}}' },
  });
  assert(problems.length >= 3, `only ${problems.length} problems reported: ${JSON.stringify(problems)}`);
});

/* ------------------------------------------------------- the translation */

await test('named merge fields become Meta positions, in order of first use', () => {
  const meta = toMetaTemplate(WA);

  assert.deepEqual(meta.variable_order, ['org', 'name', 'product', 'rm'],
    `order was ${meta.variable_order.join(', ')}`);

  const header = meta.components.find((c) => c.type === 'HEADER');
  const body = meta.components.find((c) => c.type === 'BODY');
  assert.equal(header.text, '{{1}} portfolio review', `header became ${header.text}`);
  assert(body.text.startsWith('Hi {{2}},'), `body became ${body.text}`);
});

await test('a field used twice takes one position, not two', () => {
  /* Meta counts distinct variables. Numbering the second use separately would
     mean sending the same value twice and the template being rejected for a
     count mismatch. */
  const meta = toMetaTemplate({
    ...WA,
    components: { ...WA.components, header: { type: 'none' } },
    body: 'Hi {{name}}, {{name}} — your review is due.',
  });
  assert.deepEqual(meta.variable_order, ['name']);
  assert.equal(meta.components.find((c) => c.type === 'BODY').text, 'Hi {{1}}, {{1}} — your review is due.');
});

await test('the parts Meta expects are all present', () => {
  const types = toMetaTemplate(WA).components.map((c) => c.type);
  assert.deepEqual(types, ['HEADER', 'BODY', 'FOOTER', 'BUTTONS'], `sent ${types.join(', ')}`);
});

/* --------------------------------------------------------------- the SMS */

await test('an SMS is counted in segments, and unicode halves them', () => {
  /* The billing fact. One rupee sign pasted from Word pushes the whole message
     into UCS-2, where a segment is 70 characters rather than 160 — which is
     noticed on an invoice rather than on a screen unless it is said here. */
  assert.equal(smsSegments('A'.repeat(160)).segments, 1);
  assert.equal(smsSegments('A'.repeat(161)).segments, 2);

  const rupee = smsSegments('Your SIP is ₹5,000');
  assert.equal(rupee.unicode, true, 'a rupee sign was not detected as unicode');
  assert.equal(rupee.per_segment, 70, `per segment was ${rupee.per_segment}`);
});

await test('the count is of what is sent, not of the template', () => {
  /* {{name}} is 8 characters and "Rohan" is 5. Counting the unrendered text
     would under-report a long name into a second segment. */
  const counted = smsSegments('Hi {{name}}');
  assert.equal(counted.characters, withExamples('Hi {{name}}').length,
    'the segment count is of the raw template rather than the rendered message');
});

/* ------------------------------------------------------------ the routes */

let created = null;

await test('a template can be created, edited and read back whole', async () => {
  const made = await call('POST', '/admin/templates', WA);
  assert.equal(made.status, 201, `create failed: ${JSON.stringify(made.body)}`);
  created = made.body.id;

  const row = one('SELECT * FROM templates WHERE id = ?', [created]);
  const components = JSON.parse(row.components);
  assert.equal(components.category, 'UTILITY');
  assert.equal(components.buttons.length, 1, 'the buttons did not survive the save');

  const edited = await call('PATCH', `/admin/templates/${created}`, { body: 'Hi {{name}}, a shorter note.' });
  assert.equal(edited.status, 200, `edit failed: ${JSON.stringify(edited.body)}`);
});

await test('an edit is checked against the whole template, not the fragment', async () => {
  /* Somebody editing only the body still has a header and buttons. Validating
     the patch alone would pass a change that makes the whole invalid. */
  const bad = await call('PATCH', `/admin/templates/${created}`, { body: 'x'.repeat(1025) });
  assert.equal(bad.status, 400, 'an over-long body was accepted on edit');
});

await test('the write refuses what the preview refuses', async () => {
  /* The preview and the save call the same check, so a screen cannot show
     "ready to save" for something the save rejects. */
  const draft = { ...WA, name: 'Not A Valid Name' };

  const preview = await call('POST', '/admin/templates/preview', draft);
  assert.equal(preview.body.ok, false, 'the preview called an invalid template ready');

  const save = await call('POST', '/admin/templates', draft);
  assert.equal(save.status, 400, 'the save accepted what the preview refused');
});

await test('a template still in use cannot be deleted', async () => {
  /* An automation rule or a scheduled campaign holding an id that no longer
     exists fails when it fires, which is when nobody is watching. */
  const campaign = one('SELECT id FROM campaigns LIMIT 1');
  if (!campaign) return;

  const before = one('SELECT template_id FROM campaigns WHERE id = ?', [campaign.id]).template_id;
  run('UPDATE campaigns SET template_id = ? WHERE id = ?', [created, campaign.id]);
  try {
    const res = await call('DELETE', `/admin/templates/${created}`);
    assert.equal(res.status, 409, `a template in use was deleted: HTTP ${res.status}`);
    assert(res.body.used_by, 'the refusal does not say what is using it');
  } finally {
    run('UPDATE campaigns SET template_id = ? WHERE id = ?', [before, campaign.id]);
  }
});

await test('an unused template deletes', async () => {
  const res = await call('DELETE', `/admin/templates/${created}`);
  assert.equal(res.status, 200, `delete failed: ${JSON.stringify(res.body)}`);
  assert(!one('SELECT id FROM templates WHERE id = ?', [created]), 'the row survived');
});

await test('the limits the builder shows are the limits the server holds', async () => {
  /* The screen reads them from here, so the two cannot drift. */
  const spec = await call('GET', '/admin/templates/spec');
  assert.equal(spec.body.channels.whatsapp.header.max, CHANNELS.whatsapp.header.max);
  assert(spec.body.merge_fields.length, 'no merge fields offered to the builder');
});

clean();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
