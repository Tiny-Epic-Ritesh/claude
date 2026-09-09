/**
 * Product brochures (P3-15).
 *
 * The requirement gives the brochure two jobs, and between them they decide
 * that the file is stored rather than linked:
 *
 *   read on a call        a link to somebody else's host is only as reliable
 *                         as that host, and the moment it matters is the one
 *                         moment nobody can wait
 *   sent to a client      you cannot attach a URL to an email
 *
 * So the bytes go in the database — already backed up, already inside India,
 * already the thing the rest of the product trusts — and these tests are about
 * the bytes surviving the round trip and reaching a message.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

const PROBE = await probeAdmin('brochure');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nProduct brochures');

const product = one("SELECT id, name FROM product_types WHERE active = 1 LIMIT 1");
assert(product, 'no product to attach a brochure to');

/* A real PDF header, so nothing here passes on a string that only looks like
   one. Binary on purpose: the point of storing bytes is that bytes survive. */
const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x01]),   // bytes a text round trip would mangle
  Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF'),
]);

const upload = (name, body, type = 'application/pdf') => fetch(
  `${BASE}/api/admin/products/${product.id}/brochure`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${PROBE.token}`, 'Content-Type': type, 'X-Filename': name },
    body,
  },
);

const clean = () => run('DELETE FROM product_brochure WHERE product_type_id = ?', [product.id]);
clean();

/* ------------------------------------------------------------- attaching */

await test('the formats are stated by the server, not by the screen', async () => {
  /* So a dialog cannot offer something the upload refuses. */
  const meta = await (await fetch(`${BASE}/api/admin/products/brochure-formats`, {
    headers: { Authorization: `Bearer ${PROBE.token}` },
  })).json();

  assert(meta.formats.some((f) => f.label === 'PDF'), 'PDF is not an accepted format');
  assert(meta.accept.includes('.pdf'), `the accept string is ${meta.accept}`);
  assert(meta.max_bytes > 0, 'no size limit is stated');
});

await test('a brochure can be attached', async () => {
  const res = await upload('Equity brochure 2026.pdf', PDF);
  assert.equal(res.status, 201, `upload failed: HTTP ${res.status}`);

  const body = await res.json();
  assert.equal(body.size, PDF.length, `stored ${body.size} bytes of ${PDF.length}`);
  assert.equal(body.mime, 'application/pdf');
});

await test('a format that is not on the list is refused, and says what is', async () => {
  const res = await upload('notes.txt', Buffer.from('hello'), 'text/plain');
  assert.equal(res.status, 400, `a .txt was accepted as a brochure: HTTP ${res.status}`);

  const body = await res.json();
  assert(body.accepted, 'the refusal does not say what is accepted');
});

await test('the type is judged by the name, not by what the caller claims', async () => {
  /* A Content-Type is whatever the sender says it is. Somebody uploading an
     executable with `Content-Type: application/pdf` should still be refused. */
  const res = await upload('payload.exe', Buffer.from('MZ'), 'application/pdf');
  assert.equal(res.status, 400, 'a file was accepted because its header claimed to be a PDF');
});

/* -------------------------------------------------------------- reading */

await test('the bytes come back exactly as they went in', async () => {
  await upload('Equity brochure 2026.pdf', PDF);

  const res = await fetch(`${BASE}/api/products/${product.id}/brochure`, {
    headers: { Authorization: `Bearer ${PROBE.token}` },
  });
  assert.equal(res.status, 200, `download failed: HTTP ${res.status}`);
  assert.equal(res.headers.get('content-type'), 'application/pdf');

  const back = Buffer.from(await res.arrayBuffer());
  assert.equal(back.length, PDF.length, `got ${back.length} bytes, sent ${PDF.length}`);
  assert(back.equals(PDF), 'the bytes changed on the round trip');
});

await test('it opens in the tab rather than prompting a download', async () => {
  /* Its first job is being read while somebody is on the phone, and a save
     dialog mid-call is a worse answer than a tab. */
  const res = await fetch(`${BASE}/api/products/${product.id}/brochure`, {
    headers: { Authorization: `Bearer ${PROBE.token}` },
  });
  const disposition = res.headers.get('content-disposition') ?? '';
  assert(/inline/.test(disposition), `sent as ${disposition}`);
});

await test('a caller can read one without being an administrator', async () => {
  /* The requirement is that the person on the phone can open it. Gating it
     behind admin.products would mean exactly the one role that needs it cannot
     have it. It is marketing material written to be handed to strangers. */
  /* Its own caller, not the seeded one.
   *
   * This used to sign in as `caller@bonanza.test`, which the e2e suite also
   * uses — so the two together spend that account's ten-a-minute login budget
   * and the failure lands here as "a caller cannot open the brochure: 401",
   * which reads as the brochure being unreadable rather than as the sign-in
   * being refused. That is the whole reason probeAdmin exists; this was the
   * one place still going round it. */
  const caller = await probeAdmin('brochure_caller', { role: 'caller' });

  try {
    const res = await fetch(`${BASE}/api/products/${product.id}/brochure`, {
      headers: { Authorization: `Bearer ${caller.token}` },
    });
    assert.equal(res.status, 200, `a caller cannot open the brochure: HTTP ${res.status}`);
  } finally {
    caller.cleanup();
  }
});

await test('signing out does not leave it readable', async () => {
  const res = await fetch(`${BASE}/api/products/${product.id}/brochure`);
  assert.equal(res.status, 401, `the brochure is readable with no session: HTTP ${res.status}`);
});

/* --------------------------------------------------------- sending it on */

await test('a brochure reaches an email as an attachment', async () => {
  /* The second job. The RM names the product; the bytes are read on the server
     rather than being downloaded to the browser and posted back. */
  const lead = one("SELECT id FROM leads WHERE deleted_at IS NULL AND email IS NOT NULL AND sales_org = 'BONANZA' LIMIT 1");
  assert(lead, 'no lead with an email address');

  /* Recorded on the lead's timeline, not in a mail log — one shared
     interaction timeline is the first non-negotiable of this build. */
  const before = one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND type = 'Email'", [lead.id]).n;

  const res = await fetch(`${BASE}/api/email/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE.token}` },
    body: JSON.stringify({
      lead_id: lead.id,
      subject: 'Brochure probe',
      body: '<p>Here is the brochure you asked for.</p>',
      brochure_product_ids: [product.id],
    }),
  });
  assert.equal(res.status, 200, `send failed: ${JSON.stringify(await res.json().catch(() => null))}`);

  const after = one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND type = 'Email'", [lead.id]).n;
  assert.equal(after, before + 1, 'the message left no trace on the lead');

  const logged = one("SELECT body FROM activities WHERE lead_id = ? AND type = 'Email' ORDER BY id DESC LIMIT 1", [lead.id]);
  assert(/brochure/i.test(String(logged?.body ?? '')),
    `the brochure is not named on the timeline entry: ${logged?.body}`);
});

await test('asking for a brochure that is not there is refused, not sent empty', async () => {
  const lead = one("SELECT id FROM leads WHERE deleted_at IS NULL AND email IS NOT NULL AND sales_org = 'BONANZA' LIMIT 1");
  const other = one('SELECT id FROM product_types WHERE id != ? LIMIT 1', [product.id]);
  run('DELETE FROM product_brochure WHERE product_type_id = ?', [other.id]);

  const res = await fetch(`${BASE}/api/email/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE.token}` },
    body: JSON.stringify({
      lead_id: lead.id,
      subject: 'Missing brochure probe',
      body: '<p>Body.</p>',
      brochure_product_ids: [other.id],
    }),
  });
  assert.equal(res.status, 400, 'a message was sent claiming an attachment that does not exist');
});

/* ------------------------------------------------------------- removing */

await test('removing it takes the bytes with it', async () => {
  const res = await fetch(`${BASE}/api/admin/products/${product.id}/brochure`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${PROBE.token}` },
  });
  assert.equal(res.status, 200);

  assert.equal(all('SELECT 1 FROM product_brochure WHERE product_type_id = ?', [product.id]).length, 0,
    'the row survived the delete');

  const gone = await fetch(`${BASE}/api/products/${product.id}/brochure`, {
    headers: { Authorization: `Bearer ${PROBE.token}` },
  });
  assert.equal(gone.status, 404, `it is still being served: HTTP ${gone.status}`);
});

clean();

/* Give the borrowed administrator back, so it does not turn up in every
   owner and assignee picker in the app. */
PROBE.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
