/**
 * Hunt the intermittent connection reset.
 *
 *   node scripts/soak-reset.mjs [requests] [--gaps]
 *
 * The end-to-end suite occasionally failed a check with `fetch failed`, and the
 * cause chain underneath it said ECONNRESET. It never repeated in the same
 * place, which is the signature of a transport race rather than a bug in any
 * one route -- so this reproduces the shape of the suite's traffic rather than
 * any of its assertions.
 *
 * WHAT IT VARIES, AND WHY
 * -----------------------
 * The suspect is keep-alive. Node's HTTP server closes an idle connection after
 * `keepAliveTimeout`, five seconds by default, and advertises that in a
 * `Keep-Alive: timeout=5` header. Undici -- which is what `fetch` uses -- keeps
 * its own pool and is meant to retire a socket a second before the server says
 * it will, precisely to avoid sending a request into a connection the server
 * has already decided to close.
 *
 * If that mechanism works, no gap length should produce a reset. If it does
 * not, resets will cluster around the server's timeout, which is why this walks
 * gaps either side of five seconds rather than hammering flat out: a flood
 * never lets a socket go idle long enough to be closed, which is exactly why
 * the suite only saw this occasionally and never twice in the same place.
 */

import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const TOTAL = Number(process.argv[2]) || 400;
const WITH_GAPS = process.argv.includes('--gaps');

/* Writes, not reads.
 *
 * This is the difference that matters, and it is why a GET soak proves less
 * than it looks. Undici retries an idempotent request transparently when the
 * connection it picked turns out to be closing -- so a GET can hit the
 * keep-alive race and succeed anyway, having quietly opened a new socket. A
 * POST cannot be retried, because the server may already have acted on it, so
 * the same race surfaces to the caller as ECONNRESET.
 *
 * The suite is full of POSTs and PATCHes. That is where its resets came from. */
const WRITES = process.argv.includes('--post');

/* A body-carrying POST that is cheap and harmless: the login route type-checks
   its input and refuses before it reaches scrypt, so this costs a JSON parse
   rather than a key derivation. */
const send = () => (WRITES
  ? fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 12345, password: null }),
  })
  : fetch(`${BASE}/api/health`));

/** Gap lengths in ms, walked in order, straddling the server's five seconds. */
const GAPS = [0, 0, 0, 250, 1000, 3000, 4000, 4500, 4900, 5000, 5100, 5500, 6000];

const chain = (err) => {
  const parts = [err.message];
  for (let c = err.cause, d = 0; c && d < 5; c = c.cause, d += 1) {
    parts.push([c.code, c.syscall, c.message].filter(Boolean).join(' '));
  }
  return parts.join(' <- ');
};

const failures = [];
let ok = 0;

console.log(`\nSoaking ${BASE} — ${TOTAL} ${WRITES ? 'POSTs' : 'GETs'}${WITH_GAPS ? ', walking idle gaps' : ', flat out'}`);
if (WITH_GAPS) console.log(`gaps: ${GAPS.join(', ')} ms\n`);

for (let i = 0; i < TOTAL; i += 1) {
  const gap = WITH_GAPS ? GAPS[i % GAPS.length] : 0;
  if (gap) await sleep(gap);

  try {
    const res = await send();
    await res.text();
    ok += 1;
  } catch (err) {
    failures.push({ i, gap, detail: chain(err) });
    process.stdout.write('x');
    continue;
  }
  if (i % 50 === 0) process.stdout.write('.');
}

console.log(`\n\n  ${ok} ok, ${failures.length} failed`);

if (failures.length) {
  // Grouped by the gap that preceded them: if keep-alive is the cause, the
  // failures sit at one gap length and nowhere else.
  const byGap = new Map();
  for (const f of failures) byGap.set(f.gap, (byGap.get(f.gap) ?? 0) + 1);

  console.log('\n  failures by preceding idle gap:');
  for (const [gap, n] of [...byGap.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    ${String(gap).padStart(5)} ms  ${'#'.repeat(n)} ${n}`);
  }
  console.log('\n  first three cause chains:');
  for (const f of failures.slice(0, 3)) console.log(`    #${f.i} after ${f.gap}ms: ${f.detail}`);
  process.exitCode = 1;
} else {
  console.log('  no resets');
}
