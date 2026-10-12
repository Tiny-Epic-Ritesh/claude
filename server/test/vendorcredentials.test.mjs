/**
 * The CUBE connection is set in Setup, not in the server's environment. N-6.
 *
 * WHY THIS FILE EXISTS
 *
 * Every vendor credential lived in `server/.env`, so connecting the dialler --
 * or recovering from a rotated password -- needed a deployment and somebody
 * with shell access. Ritesh asked for a box to paste them into instead.
 *
 * A credential box is only as good as its rules, and these are the rules:
 *
 *   it is write-only        the screen is told a secret is set, by whom and
 *                           when, and never what it is -- not on the save, not
 *                           on the read, not anywhere
 *   it is encrypted         the database file on its own does not hand somebody
 *                           the dialler
 *   Setup wins              a value set here beats the environment, and
 *                           clearing it falls back rather than half-configuring
 *   only an administrator   this is admin.system, like the rest of the screen
 */

/* The same .env the server reads, so this process holds the same encryption
   key: a secret stored by the server is only readable with it. */
import 'dotenv/config';
import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { quickcall as cfg } from '../src/vendors/config.js';
import { valueOf } from '../src/vendors/store.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nThe CUBE connection, set from Setup');

/* The telephony screen is admin.system, which only a superadmin holds. */
const ADMIN = await probeAdmin('vendorcred', { role: 'superadmin' });
const RM = await probeAdmin('vendorcred-rm', { role: 'sales_rm' });

const call = async (who, method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* A password that appears nowhere else, so finding it anywhere is unambiguous.
   Never a real credential: this test writes to the development database. */
const SECRET = `Zq7-${Date.now().toString(36)}-NotARealPassword`;
const stored = () => all("SELECT name, value, secret FROM vendor_setting WHERE vendor = 'quickcall'");
const clear = () => run("DELETE FROM vendor_setting WHERE vendor = 'quickcall'");
clear();

try {
  await test('only an administrator may read or set the connection', async () => {
    const read = await call(RM, 'GET', '/setup/dialler');
    assert.equal(read.status, 403, `a Sales RM read the telephony screen: HTTP ${read.status}`);

    const write = await call(RM, 'POST', '/setup/dialler/credentials', { user: 'rm-should-not' });
    assert.equal(write.status, 403, `a Sales RM set a credential: HTTP ${write.status}`);
    assert.equal(stored().length, 0, 'the refused write stored something');
  });

  await test('what is set is reported as set, and never read back', async () => {
    const saved = await call(ADMIN, 'POST', '/setup/dialler/credentials', {
      user: 'tenant-probe', password: SECRET, base_url: 'http://127.0.0.1:9',
    });
    assert.equal(saved.status, 200, `HTTP ${saved.status}: ${JSON.stringify(saved.body)}`);
    assert(!JSON.stringify(saved.body).includes(SECRET), 'the save answered with the password in it');

    const { body } = await call(ADMIN, 'GET', '/setup/dialler');
    assert(!JSON.stringify(body).includes(SECRET), 'the screen was sent the password');
    assert(!JSON.stringify(body).includes('tenant-probe'), 'the screen was sent the username');

    const password = body.credentials.find((c) => c.name === 'password');
    assert.equal(password.set, true, 'the password is not reported as set');
    assert.equal(password.secret, true, 'the password is not marked secret');
    assert.equal(password.from_environment, false, 'a value set here is reported as coming from the environment');
    assert(password.updated_by_name, 'nobody is recorded as having set it');

    /* The server URL is not a secret, so the screen does show it -- an
       administrator has to be able to see which switch they are pointed at. */
    const url = body.credentials.find((c) => c.name === 'base_url');
    assert.equal(url.value, 'http://127.0.0.1:9', `the server URL reads ${url.value}`);
  });

  await test('a secret is encrypted at rest', async () => {
    const rows = stored();
    const password = rows.find((r) => r.name === 'password');
    assert(password, 'the password was not stored at all');
    assert.equal(Number(password.secret), 1, 'the password is not marked secret in the database');
    assert(!password.value.includes(SECRET), 'the password is in the database in plain text');
    assert.equal(valueOf('quickcall', 'password'), SECRET, 'the stored password does not decrypt to what was set');

    /* The server URL is not a secret and is stored as itself, which is what
       lets the screen show it. */
    const url = rows.find((r) => r.name === 'base_url');
    assert.equal(Number(url.secret), 0, 'the server URL is marked secret');
    assert.equal(url.value, 'http://127.0.0.1:9', 'the server URL was transformed');
  });

  await test('what is set in Setup is what the adapter uses', async () => {
    assert.equal(cfg.user, 'tenant-probe', `the adapter reads the user as ${cfg.user}`);
    assert.equal(cfg.password, SECRET, 'the adapter does not read the stored password');
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:9', `the adapter reads the URL as ${cfg.baseUrl}`);
    assert.equal(cfg.configured, true, 'the adapter still reports itself unconfigured');
  });

  await test('saving one field leaves the others alone', async () => {
    const r = await call(ADMIN, 'POST', '/setup/dialler/credentials', { campaign: 'PROBE_QUEUE' });
    assert.equal(r.status, 200, `HTTP ${r.status}`);
    assert.equal(valueOf('quickcall', 'password'), SECRET, 'saving the campaign wiped the password');
    assert.equal(cfg.campaign, 'PROBE_QUEUE', `the campaign reads ${cfg.campaign}`);
  });

  await test('clearing a field falls back to the server environment', async () => {
    const fromEnv = process.env.CUBE_QUICKCALL_CAMPAIGN || 'BONANZA_CRM';
    const r = await call(ADMIN, 'POST', '/setup/dialler/credentials', { campaign: '' });
    assert.equal(r.status, 200, `HTTP ${r.status}`);
    assert.equal(valueOf('quickcall', 'campaign'), null, 'the cleared value is still stored');
    assert.equal(cfg.campaign, fromEnv, `after clearing, the campaign reads ${cfg.campaign}`);
  });

  await test('a setting CUBE does not have is refused', async () => {
    const r = await call(ADMIN, 'POST', '/setup/dialler/credentials', { secret_sauce: 'x' });
    assert.equal(r.status, 400, `HTTP ${r.status}`);
    assert(!stored().some((s) => s.name === 'secret_sauce'), 'an unknown setting was stored');
  });

  await test('every change is in the configuration audit, without the value', async () => {
    const rows = all(
      "SELECT target, action, before_json, after_json FROM config_audit WHERE area = 'integration' AND target LIKE 'quickcall.%' ORDER BY id DESC LIMIT 20",
    );
    assert(rows.some((r) => r.target === 'quickcall.password' && r.action === 'updated'), 'the password change was not recorded');
    assert(rows.some((r) => r.target === 'quickcall.campaign' && r.action === 'cleared'), 'the clearing was not recorded');
    assert(!JSON.stringify(rows).includes(SECRET), 'the audit recorded the password itself');
  });

  await test('the test button reports a refusal rather than pretending', async () => {
    /* Pointed at a port nothing listens on, so this is a real attempt that
       fails fast rather than a call to a vendor from a test run. */
    const r = await call(ADMIN, 'POST', '/setup/dialler/test', {});
    assert.equal(r.status, 200, `HTTP ${r.status}`);
    assert.equal(r.body.ok, false, 'an unreachable CUBE reported a working connection');
    assert(r.body.message, 'the failure has no message to show anybody');
    assert(!JSON.stringify(r.body).includes(SECRET), 'the test answered with the password in it');
  });

  await test('with nothing set, the screen says so instead of guessing', async () => {
    clear();
    const { body } = await call(ADMIN, 'GET', '/setup/dialler');
    const password = body.credentials.find((c) => c.name === 'password');
    const envHas = Boolean(process.env.CUBE_QUICKCALL_PASSWORD);
    assert.equal(password.set, envHas, `the password reads set=${password.set} with the environment ${envHas ? 'set' : 'empty'}`);
    assert.equal(password.from_environment, envHas, 'the environment fallback is not reported honestly');
  });
} finally {
  clear();
  ADMIN.cleanup();
  RM.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
