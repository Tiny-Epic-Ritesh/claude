/**
 * A throwaway administrator, for tests that need to sign in as one.
 *
 * The login limiter allows ten attempts a minute per account, and it is right
 * to. What is not right is a test suite that spends that budget on a shared
 * seeded account and then reports the consequence as a broken feature — which
 * has now happened twice, both times mine:
 *
 *   the whole e2e run failed with "Sign in required" everywhere, because
 *   several unit files each signed in as admin@bonanza.test
 *
 *   "the limiter is keyed per account, not per address" failed, because the
 *   e2e check proves that by signing in as admin@bonanza.test and the budget
 *   had already gone
 *
 * The fix is not a bigger budget. A test that needs to sign in as somebody
 * should bring its own somebody, so each file gets an account of its own, signs
 * in once, and never touches the accounts the rest of the suite relies on.
 *
 * The password hash is borrowed from a seeded user rather than reimplemented:
 * this is about signing in, not about how hashing works, and a second
 * implementation of the KDF in the test tree is a thing that can disagree with
 * the real one.
 */

import { one, run } from '../../src/db.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

/**
 * @param slug  a name unique to the calling test file, so two files running
 *              back to back never share an account or race each other's cleanup
 * @param role  the role the probe should hold; 'admin' unless a test needs more
 */
export async function probeAdmin(slug, role = 'admin') {
  const email = `probe-${slug}@bonanza.test`;

  const seeded = one("SELECT password FROM users WHERE email = 'admin@bonanza.test'");
  if (!seeded) throw new Error('no seeded administrator to borrow a password hash from');

  /* Recreated rather than reused, so a run always starts from a known state
     even if a previous one was interrupted before its cleanup. */
  run('DELETE FROM users WHERE email = ?', [email]);
  run(
    `INSERT INTO users (name, email, password, role, sales_org, active)
     VALUES (?,?,?,?,'BONANZA',1)`,
    [`Probe ${slug}`, email, seeded.password, role],
  );

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'bonanza' }),
  });
  if (res.status === 429) {
    throw new Error(`the probe account was rate limited, which should be impossible on a fresh account: ${email}`);
  }
  if (!res.ok) throw new Error(`probe admin could not sign in: HTTP ${res.status}`);

  const { token } = await res.json();
  const user = one('SELECT id FROM users WHERE email = ?', [email]);

  return {
    token,
    email,
    id: user.id,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    cleanup: () => run('DELETE FROM users WHERE email = ?', [email]),
  };
}
