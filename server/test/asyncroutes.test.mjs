/**
 * Express forwards a rejected promise to the error middleware.
 *
 * The app relies on this and no longer does anything itself about it. Express 4
 * did not: an async handler that rejected reached nobody, and Node's answer to
 * an unhandled rejection is to end the process, which is how a sign-in with no
 * email in the body — one unauthenticated request — stopped the server. That
 * was fixed by wrapping all 27 async handlers, and the wrapper was removed
 * again when this codebase moved to Express 5, which does it natively.
 *
 * So this tests the dependency, not our code. It is the assumption the removal
 * rests on: if a future upgrade, downgrade or swap stops forwarding rejections,
 * the crash comes back everywhere at once and nothing else in the suite would
 * say why.
 *
 * Built as its own throwaway app on an ephemeral port rather than against the
 * real one. The real app has no route that rejects on purpose, and adding one
 * to production code so a test can reach it would be worse than this.
 */

import { strict as assert } from 'node:assert';
import express from 'express';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

/** A one-route app on a port the OS picks, torn down after the callback. */
async function withApp(register, run) {
  const app = express();
  const seen = [];
  register(app);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    seen.push(err);
    res.status(500).json({ error: 'handled' });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

console.log('\nExpress — a rejected promise must reach the error middleware');

console.log(`  (express ${(await import('express/package.json', { with: { type: 'json' } })).default.version})`);

await test('an async handler that rejects becomes a 500, not a dropped request', async () => {
  await withApp(
    (app) => app.get('/boom', async () => { throw new Error('deliberate'); }),
    async (base, seen) => {
      const res = await fetch(`${base}/boom`);
      assert.equal(res.status, 500, 'the rejection did not reach the error middleware');
      assert.equal(seen.length, 1, `the error middleware saw ${seen.length} errors, expected 1`);
      assert.equal(seen[0].message, 'deliberate', 'a different error arrived');
    },
  );
});

await test('so does an async handler that rejects with a non-Error', async () => {
  await withApp(
    // eslint-disable-next-line prefer-promise-reject-errors
    (app) => app.get('/boom', async () => { throw 'a string'; }),
    async (base, seen) => {
      const res = await fetch(`${base}/boom`);
      assert.equal(res.status, 500);
      assert.equal(seen.length, 1);
    },
  );
});

await test('and a rejection from an awaited call deeper in the handler', async () => {
  // The shape the real bug had: the throw was two frames down, inside login().
  const deep = async () => { throw new Error('from below'); };
  await withApp(
    (app) => app.get('/boom', async (_req, res) => { await deep(); res.json({}); }),
    async (base, seen) => {
      const res = await fetch(`${base}/boom`);
      assert.equal(res.status, 500);
      assert.equal(seen[0].message, 'from below');
    },
  );
});

await test('a synchronous throw still reaches it too', async () => {
  await withApp(
    (app) => app.get('/boom', () => { throw new Error('sync'); }),
    async (base, seen) => {
      const res = await fetch(`${base}/boom`);
      assert.equal(res.status, 500);
      assert.equal(seen[0].message, 'sync');
    },
  );
});

await test('a handler that resolves normally is untouched', async () => {
  // Guards the guard: if every request returned 500 the assertions above would
  // pass for the wrong reason.
  await withApp(
    (app) => app.get('/fine', (_req, res) => res.json({ ok: true })),
    async (base, seen) => {
      const res = await fetch(`${base}/fine`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(seen.length, 0, 'the error middleware ran for a successful request');
    },
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
