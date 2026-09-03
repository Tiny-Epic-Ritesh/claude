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
 * A wrapper rather than an inline `CRM_SCRYPT_N=16384 npm test` in package.json
 * because npm runs scripts through cmd on Windows, where that syntax is not a
 * variable assignment but a command it cannot find. The same applies to the
 * dev:webhooks and test:webhooks scripts, which are written that way and do not
 * work on this machine.
 *
 * The server and the tests must both run under it. If only the tests do, every
 * sign-in verifies a cheap hash and then rehashes it back up to the server's
 * full cost, which is slower than not bothering.
 *
 * Refused in production by security.js, which will not start with this set.
 */

import { spawn } from 'node:child_process';

const N = process.env.CRM_SCRYPT_N || '16384';
const argv = process.argv.slice(2);

if (argv.length === 0) {
  console.error('usage: node scripts/cheap-hashing.mjs <command> [args...]');
  process.exit(2);
}

console.warn(`[cheap-hashing] CRM_SCRYPT_N=${N} — passwords hashed below the production floor. Test runs only.`);

// shell:true so `npm` resolves to npm.cmd on Windows.
const child = spawn(argv[0], argv.slice(1), {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, CRM_SCRYPT_N: N },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
