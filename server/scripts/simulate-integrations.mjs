/**
 * Run a command with every outbound vendor forced to simulate.
 *
 *   node scripts/simulate-integrations.mjs npm start          # the server
 *   node scripts/simulate-integrations.mjs npm run test:only  # the suite
 *
 * WHY THIS EXISTS
 * ---------------
 * The suite POSTs to `/api/leads/:id/call` in three places, and also sends
 * WhatsApp and email. If a vendor is configured and reachable, those stop being
 * assertions about our code and become real phone calls and real messages, to
 * whatever the seed fixtures carry — and the seeded leads carry plausible real
 * Indian mobile numbers. A test suite that rings strangers is not a test suite.
 *
 * Until now the only thing standing between the suite and a live dialler was
 * that no vendor had credentials. That is not a safeguard, it is an accident of
 * configuration, and it expires the day Cube sends us a tenant login. It would
 * expire silently, on a green suite, which is the worst way for it to go.
 *
 * WHICH PROCESS READS THIS
 * ------------------------
 * `CRM_SIMULATE_INTEGRATIONS` is read by the **server**, not by the suite,
 * because the adapters live there and the suite talks to it over HTTP. Wrapping
 * the suite alone does nothing at all. It has to wrap whatever starts the
 * server — which is why the usage above shows `npm start` first.
 *
 * The suite does not depend on this script: it asks the server what state its
 * vendors are in and refuses to run against a live one either way. This is the
 * supported way to get a server into that state, not the thing that enforces it.
 */

import { runWithEnv } from './run-with-env.mjs';

runWithEnv(
  { CRM_SIMULATE_INTEGRATIONS: '1' },
  process.argv.slice(2),
  {
    usage: 'node scripts/simulate-integrations.mjs <command> [args...]',
    note: '[simulate-integrations] every vendor forced to simulate. '
      + 'This must wrap the SERVER, not the suite.',
  },
);
