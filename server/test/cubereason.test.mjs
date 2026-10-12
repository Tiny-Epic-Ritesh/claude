/**
 * When CUBE refuses, say what CUBE said.
 *
 * WHY THIS FILE EXISTS
 *
 * The Test connection button reported
 *
 *   QuickCall (Cube Software) returned HTTP 401
 *
 * and nothing else, while CUBE's own answer sat unread in the response body:
 *
 *   {"Api":"AuthToken","Status":"Failed","Reason":"Invalid Credentials"}
 *
 * Ritesh hit exactly this on 12 October. From that screen he could not tell a
 * wrong password from a wrong host from a tenant that is not enabled — three
 * different afternoons. `vendorFetch` had already attached the body to the
 * error; `checkCredentials` dropped it.
 *
 * HOW IT IS TESTED
 *
 * Through the real path, not a mock of it: the credentials are saved the way
 * the screen saves them, `fetch` is replaced for the length of one call so the
 * switch answers exactly as the live one does, and everything between --
 * vendorFetch, VendorError, the catch -- is the shipped code. The first version
 * of the fix read `err.body`, which VendorError does not set (it is
 * `vendorBody`), so it silently changed nothing; a source-text test would have
 * passed on it.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { run } from '../src/db.js';
import { checkCredentials } from '../src/vendors/quickcall.js';
import { FORCE_SIMULATION } from '../src/vendors/config.js';
import { setValue } from '../src/vendors/store.js';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nWhat the screen says when CUBE refuses');

const realFetch = globalThis.fetch;

/** Answer the next call like the live switch does, then put fetch back. */
const answering = async (status, body, fn) => {
  globalThis.fetch = async () => new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
};

const clearCreds = () => run("DELETE FROM vendor_setting WHERE vendor = 'quickcall'");

try {
  if (FORCE_SIMULATION) {
    console.log('  --   simulation is forced on, so the live refusal path cannot run');
  } else {
    /* Configured, so `simulating()` is false and the request really goes out
       (to our stub). The values are nonsense on purpose: nothing here reaches
       a real switch. */
    setValue('quickcall', 'base_url', 'https://cube.invalid', { secret: false });
    setValue('quickcall', 'user', 'probe-user', { secret: true });
    setValue('quickcall', 'password', 'probe-password', { secret: true });

    await test("a refusal carries CUBE's own reason", async () => {
      const out = await answering(
        401,
        '{"Api":"AuthToken","Status":"Failed","Reason":"Invalid Credentials"}',
        () => checkCredentials(),
      );

      assert.equal(out.ok, false);
      assert.equal(out.configured, true);
      assert.equal(out.simulated, false);
      assert(/Invalid Credentials/.test(out.message),
        `the screen would have shown: ${out.message}`);
      assert(/401/.test(out.message), 'the status is no longer in the message');
      assert.equal(out.status, 401, 'the status is not reported alongside the message');
    });

    await test('a refusal with no reason still reads as a sentence', async () => {
      const out = await answering(401, '{"Api":"AuthToken","Status":"Failed"}', () => checkCredentials());
      assert.equal(out.ok, false);
      assert(/401/.test(out.message), `the message reads: ${out.message}`);
      assert(!/undefined|null|—\s*$/.test(out.message),
        `a missing reason leaked into the message: ${out.message}`);
    });

    await test('a body that is not JSON does not break the screen', async () => {
      const out = await answering(502, '<html>502 Bad Gateway</html>', () => checkCredentials());
      assert.equal(out.ok, false);
      assert(out.message.length > 0 && !/undefined/.test(out.message),
        `the message reads: ${out.message}`);
    });

    await test('the password is never put on the screen', async () => {
      /* The body of a failed auth call can echo the request, and the request
         carries the password. Only the reason is taken, so an echo cannot
         reach an administrator's screen — or a screenshot of it. */
      const out = await answering(
        401,
        JSON.stringify({
          Api: 'AuthToken',
          Status: 'Failed',
          Reason: 'Invalid Credentials',
          Request: { UserID: 'probe-user', Password: 'probe-password' },
        }),
        () => checkCredentials(),
      );
      assert(/Invalid Credentials/.test(out.message));
      assert(!/probe-password/.test(out.message),
        'the vendor echoed the request and we printed the password');
    });

    await test('a reason long enough to be a page is cut short', async () => {
      const out = await answering(
        401,
        JSON.stringify({ Reason: 'x'.repeat(5000) }),
        () => checkCredentials(),
      );
      assert(out.message.length < 400, `the message is ${out.message.length} characters`);
    });

    await test('an accepted credential still reads as success', async () => {
      const out = await answering(
        200,
        '{"Api":"AuthToken","Status":"Success","Token":"PROBE-TOKEN","ExpiresIn":3600}',
        () => checkCredentials(),
      );
      assert.equal(out.ok, true, `a good token was reported as: ${out.message}`);
      assert.equal(out.simulated, false);
    });
  }

  await test('with nothing configured it says so, rather than calling anybody', async () => {
    clearCreds();
    const out = await checkCredentials();
    assert.equal(out.ok, false);
    assert.equal(out.configured, false);
    assert(/No CUBE server/i.test(out.message), `the message reads: ${out.message}`);
  });
} finally {
  globalThis.fetch = realFetch;
  clearCreds();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
