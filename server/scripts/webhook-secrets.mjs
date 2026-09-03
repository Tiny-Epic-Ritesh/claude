/**
 * Run a command with the vendor webhook secrets set to a known test value.
 *
 *   node scripts/webhook-secrets.mjs npm run dev        # the server
 *   node scripts/webhook-secrets.mjs npm run test:only  # the suite
 *
 * Each vendor refuses callbacks outright until its secret is configured, which
 * is the behaviour that matters in production and the reason the refusal paths
 * in the suite are never skipped. But it also means the signed paths cannot be
 * exercised at all unless the server has a secret to check against, so these
 * exist to give it one.
 *
 * Both halves, or the signed tests fail: the suite talks to a long-lived server
 * started separately, and it signs its callbacks with E2E_WEBHOOK_SECRET while
 * the server verifies against the three vendor variables. Start the server
 * without them and the signed requests are refused, which is a failing test
 * rather than a skipped one. Without E2E_WEBHOOK_SECRET the suite runs only the
 * refusal paths and says nothing about the signed ones.
 *
 * One constant, four variables. The value used to be written out four times
 * across two package.json scripts, where changing one would have broken the
 * pairing quietly.
 */

import { runWithEnv } from './run-with-env.mjs';

const SECRET = process.env.E2E_WEBHOOK_SECRET || 'e2e-webhook-secret';

runWithEnv(
  {
    // Read by the server, one per vendor.
    CUBE_QUICKCALL_WEBHOOK_SECRET: SECRET,
    SMARTPING_WEBHOOK_SECRET: SECRET,
    BONANZA_KYC_WEBHOOK_SECRET: SECRET,
    // Read by the suite, to sign with and to check it is never echoed back.
    E2E_WEBHOOK_SECRET: SECRET,
  },
  process.argv.slice(2),
  {
    usage: 'node scripts/webhook-secrets.mjs <command> [args...]',
    note: '[webhook-secrets] vendor webhook secrets set to a test value. '
      + 'The server and the suite must both run under this.',
  },
);
