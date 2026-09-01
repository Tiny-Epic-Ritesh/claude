/**
 * Actually sending the email (P2-09).
 *
 * The composer was complete and the send was not. Three things were true at
 * once, and each of them looked fine from inside the CRM:
 *
 *   - `send()` hardcoded email to simulate, so every message was recorded on
 *     the timeline and silently never delivered;
 *   - the route and `send()` each wrote their own activity, so an email that
 *     went nowhere went nowhere twice;
 *   - collateral picked from the library was named on the timeline as
 *     "Attached", but its link never reached the message.
 *
 * The shared shape is that every one of them looks correct on our screen and is
 * wrong in the client's inbox. So these tests assert on the envelope — what
 * would go on the wire — rather than on what we wrote down about it.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as smtp from '../src/vendors/smtp.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  const done = (err) => {
    if (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
    else { passed += 1; console.log(`  ok   ${name}`); }
  };
  try { const r = fn(); return r instanceof Promise ? r.then(() => done(), done) : done(); }
  catch (err) { return done(err); }
};

console.log('\nEmail send');

const src = readFileSync(new URL('../src/routes/email.js', import.meta.url), 'utf8');
const integrations = readFileSync(new URL('../src/integrations.js', import.meta.url), 'utf8');

/* ------------------------------------------------------------ the envelope */

await test('the message is built identically whether or not it is delivered', async () => {
  /* The QuickCall rule applied here: simulation sits below the message build,
     so a mistake in the envelope fails a test rather than surviving until the
     first live send. */
  const res = await smtp.sendMail({
    to: 'client@example.com', subject: 'Your account', html: '<p>Hello</p>',
    text: 'Hello', userName: 'Priya Nair', replyTo: 'priya@bonanza.com',
  });
  assert(res.simulated, 'fixture: expected no SMTP credentials in test');
  assert.equal(res.envelope.to, 'client@example.com');
  assert.equal(res.envelope.subject, 'Your account');
  assert(res.envelope.has_html && res.envelope.has_text, 'a part went missing');
});

await test('the mail comes from the firm and replies go to the person', async () => {
  /* Sending as the RM's own address would fail SPF and DKIM for the Bonanza
     domain and land in spam. The client still sees who wrote to them, and a
     reply still reaches that person rather than a shared inbox nobody reads. */
  const res = await smtp.sendMail({
    to: 'c@example.com', subject: 's', html: '<p>b</p>',
    userName: 'Priya Nair', replyTo: 'priya@bonanza.com',
  });
  assert(/Priya Nair/.test(res.envelope.from), `from lost the RM: ${res.envelope.from}`);
  assert(/bonanzaonline\.com/.test(res.envelope.from), `from is not the firm: ${res.envelope.from}`);
  assert.equal(res.envelope.reply_to, 'priya@bonanza.com');
});

await test('a display name cannot break out of the From header', async () => {
  const res = await smtp.sendMail({
    to: 'c@example.com', subject: 's', html: '<p>b</p>',
    userName: 'Ev"il <attacker@evil.com>',
  });
  const inside = res.envelope.from.slice(0, res.envelope.from.lastIndexOf('<'));
  assert(!inside.includes('"attacker'), `From header was broken open: ${res.envelope.from}`);
});

await test('attachments reach the envelope, not just the timeline', async () => {
  const res = await smtp.sendMail({
    to: 'c@example.com', subject: 's', html: '<p>b</p>',
    attachments: [{ name: 'factsheet.pdf', content: 'AAAA', type: 'application/pdf' }],
  });
  assert.deepEqual(res.envelope.attachments, ['factsheet.pdf']);
});

await test('a message with no recipient is refused rather than sent nowhere', async () => {
  await assert.rejects(() => smtp.sendMail({ subject: 's', html: '<p>b</p>' }));
});

/* --------------------------------------------------- what the route passes */

test('the route hands the attachment bytes over, not only the names', () => {
  // They were listed on the timeline and dropped, so a client was told a
  // factsheet was attached and got a message with nothing on it.
  assert(/attachments: attachments\.map\(/.test(src),
    'the composer no longer passes attachment content to send()');
});

test('library collateral reaches the client as a link', () => {
  /* The library holds a URL rather than bytes so a document is corrected in one
     place instead of in every mailbox it was ever sent to. That only works if
     the link is in the message. */
  assert(/Documents for you/.test(src), 'the collateral links block is gone');
  assert(/bodyWithLinks/.test(src) && /textWithLinks/.test(src),
    'the message is being sent without the link-bearing bodies');
});

test('the link block goes through the sanitiser, not a second escaper', () => {
  // A document name is client-visible text and has to be escaped exactly as
  // carefully as the RM's own body; the href needs the same scheme check.
  const block = src.slice(src.indexOf('const links = library'), src.indexOf('const textWithLinks'));
  assert(/sanitizeHtml\(/.test(block), 'the collateral block bypasses the sanitiser');
});

test('email is no longer hardcoded to simulate', () => {
  assert(/channel === 'email' \? simulate\(smtp\.isLive\)/.test(integrations),
    'send() still pretends to deliver email regardless of configuration');
});

test('only one activity is written for an outbound message', () => {
  /* One shared interaction timeline, never a mirrored copy - the first
     non-negotiable in CLAUDE.md. Asserted on the source because the duplicate
     survived a passing e2e check that found the activity by id and so never
     noticed there were two. */
  const body = integrations.slice(
    integrations.indexOf('export function send('),
    integrations.indexOf('/* ------------------------------------------------------------ telephony */'),
  );
  assert(body.length > 0, 'could not locate send()');
  const inserts = body.match(/INSERT INTO activities \(lead_id/g) ?? [];
  assert.equal(inserts.length, 1, `send() writes ${inserts.length} lead activities`);
  assert(!/INSERT INTO activities \(lead_id/.test(src),
    'the composer writes its own activity again, on top of the one send() writes');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
