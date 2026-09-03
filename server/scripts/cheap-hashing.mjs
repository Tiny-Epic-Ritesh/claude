/**
 * Run a command with the password hashing cost lowered.
 *
 *   node scripts/cheap-hashing.mjs npm test
 *   node scripts/cheap-hashing.mjs npm run dev
 *
 * The suite signs in constantly and each sign-in at the OWASP floor is about
 * 600ms of real work, which takes a full run from roughly 50s to roughly 170s.
 * This lowers CRM_SCRYPT_N for the child process only.
 *
 * The server and the tests must both run under it. If only the tests do, every
 * sign-in verifies a cheap hash and then rehashes it back up to the server's
 * full cost, which is slower than not bothering and gives no sign of why.
 *
 * Refused in production by security.js, which will not start with this set.
 */

import { runWithEnv } from './run-with-env.mjs';

const N = process.env.CRM_SCRYPT_N || '16384';

runWithEnv(
  { CRM_SCRYPT_N: N },
  process.argv.slice(2),
  {
    usage: 'node scripts/cheap-hashing.mjs <command> [args...]',
    note: `[cheap-hashing] CRM_SCRYPT_N=${N} — passwords hashed below the production floor. `
      + 'Test runs only, and the server must run under this too.',
  },
);
