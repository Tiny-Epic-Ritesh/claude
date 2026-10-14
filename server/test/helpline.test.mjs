/**
 * Each business's help line, and the QA-02 cleanup as labs runs it.
 *
 *   Help lines. Both account-opening pages printed 022-6153-0000, written into
 *   the page, which is neither business's published number. Ruled 13 Oct: Bigul's
 *   page gives Bigul's own line. Each business now carries its line on its
 *   record -- Bigul Customer Support 9090491913 (bigul.co/contact), Bonanza
 *   Customer Care 022-68363775 (bonanzaonline.com/contact.php) -- and a
 *   Superadmin's change to it is not undone at the next restart.
 *
 *   The cleanup. Ruled 13 Oct: a one-click workflow, preview then apply. The
 *   repository is public and so are its logs, so the workflow names leads by
 *   id; and apply snapshots the database before it changes anything.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { snapshot } from '../scripts/qa02-duplicate-tasks.mjs';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(SERVER, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nHelp lines per business, and the QA-02 cleanup as labs runs it');

const RUN = String(Date.now()).slice(-6);
const MARK = `HL probe ${RUN}`;
const dkyc = async (url, body) => {
  const res = await fetch(`${BASE}/dkyc-api${url}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const SUPER = await probeAdmin('helpline-super', { role: 'superadmin' });
const original = one('SELECT support_phone, support_email, support_hours FROM sales_orgs WHERE code = ?', ['BIGUL']);
const tokens = [];
const leadIds = [];

try {
  await test('Bigul\'s page gives Bigul\'s published line', async () => {
    const res = await dkyc('/business?business=BIGUL');
    assert.equal(res.status, 200);
    assert.equal(res.body.support_phone, '9090491913');
    assert.equal(res.body.support_email, 'support@bigul.co');
    assert(res.body.support_hours, 'no hours, so the applicant does not know when to call');
  });

  await test('Bonanza\'s page gives Bonanza\'s published line, not the old one', async () => {
    const res = await dkyc('/business?business=BONANZA');
    assert.equal(res.body.support_phone, '022-68363775');
    assert.equal(res.body.support_email, 'customercare@bonanzaonline.com');
  });

  await test('a resumed Bigul application carries Bigul\'s line', async () => {
    const product = one("SELECT id FROM product_types WHERE sales_org = 'BIGUL' AND active = 1 AND requires_kyc = 1 ORDER BY id LIMIT 1");
    const started = await dkyc('/start', { product_type_id: product.id, business: 'BIGUL' });
    assert.equal(started.status, 201, `the journey did not start: ${started.body?.error}`);
    tokens.push(started.body.resume_token);
    const resumed = await dkyc(`/resume/${started.body.resume_token}`);
    assert.equal(resumed.body.business.code, 'BIGUL');
    assert.equal(resumed.body.business.support_phone, '9090491913');
  });

  await test('a Superadmin\'s change to a help line survives a restart', async () => {
    const res = await fetch(`${BASE}/api/orgs/BIGUL`, {
      method: 'PATCH', headers: SUPER.headers, body: JSON.stringify({ support_phone: '9000000000' }),
    });
    assert.equal(res.status, 200, `the edit answered ${res.status}`);
    // Every boot re-runs the business seed; this is that, in a process of its own.
    const boot = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/db.js')"], {
      cwd: SERVER, env: process.env, encoding: 'utf8',
    });
    assert.equal(boot.status, 0, `the seed did not run: ${boot.stderr}`);
    assert.equal(one("SELECT support_phone FROM sales_orgs WHERE code = 'BIGUL'").support_phone, '9000000000',
      'the restart put the seeded number back over the Superadmin\'s');
  });

  await test('the page has no number of its own (source check)', async () => {
    const page = read('client/src/dkyc/DkycPortal.jsx');
    assert(!/\d{3}-\d{4}-\d{4}|\b\d{10}\b/.test(page), 'a phone number is still written into the page');
    assert((page.match(/<HelpLine \/>/g) ?? []).length >= 5, 'not every help sentence reads the business\'s line');
  });

  /* ------------------------------------------------------------ QA-02 */

  await test('the cleanup names leads by id when the workflow asks it to', async () => {
    const name = `${MARK} lead`;
    const lead = Number(run("INSERT INTO leads (sales_org, name, source, stage) VALUES ('BONANZA', ?, 'Website', 'New')", [name]).lastInsertRowid);
    leadIds.push(lead);
    for (let i = 0; i < 2; i += 1) {
      run("INSERT INTO tasks (title, lead_id, assignee_id, due_at, status) VALUES ('Automated follow-up', ?, ?, datetime('now', '+1 day'), 'Open')",
        [lead, SUPER.id]);
    }
    const out = spawnSync(process.execPath, ['scripts/qa02-duplicate-tasks.mjs', '--ids-only'], {
      cwd: SERVER, env: process.env, encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);
    assert(out.stdout.includes(`lead ${lead}`), 'the duplicate group is not reported');
    assert(!out.stdout.includes(name), 'a lead\'s name reached the log');
    assert(/Preview only/.test(out.stdout), 'a preview changed something, or did not say it was a preview');
    assert.equal(one("SELECT COUNT(*) n FROM tasks WHERE lead_id = ? AND status = 'Open'", [lead]).n, 2);
  });

  await test('apply snapshots the database first, and the snapshot is whole', async () => {
    const file = snapshot(`probe-${RUN}`);
    try {
      const copy = new DatabaseSync(file, { readOnly: true });
      const n = copy.prepare('SELECT COUNT(*) n FROM tasks').get().n;
      copy.close();
      assert.equal(n, one('SELECT COUNT(*) n FROM tasks').n, 'the snapshot is not the database it was taken from');
    } finally {
      fs.rmSync(file, { force: true });
    }
    const script = fs.readFileSync(path.join(SERVER, 'scripts', 'qa02-duplicate-tasks.mjs'), 'utf8');
    assert(/Snapshot taken first: \$\{snapshot\(\)\}`\);\s*const done = apply\(\);/.test(script), 'apply does not snapshot before it changes anything');
  });

  await test('labs can run it: the image carries the script and the workflow previews by default (source check)', async () => {
    assert(/COPY server\/scripts\/qa02-duplicate-tasks\.mjs /.test(read('Dockerfile')), 'the image does not carry the script');
    const flow = read('.github/workflows/qa02-cleanup.yml');
    assert(/workflow_dispatch:/.test(flow) && !/^\s*push:/m.test(flow), 'the cleanup runs on something other than a click');
    assert(/default: false/.test(flow), 'the workflow applies unless told not to');
    assert(/qa02-duplicate-tasks\.mjs --ids-only \$APPLY/.test(flow), 'the workflow does not keep names out of its log');
  });
} finally {
  run('UPDATE sales_orgs SET support_phone = ?, support_email = ?, support_hours = ? WHERE code = ?',
    [original.support_phone, original.support_email, original.support_hours, 'BIGUL']);
  for (const t of tokens) run('DELETE FROM kyc_journeys WHERE resume_token = ?', [t]);
  for (const id of leadIds) { run('DELETE FROM tasks WHERE lead_id = ?', [id]); run('DELETE FROM leads WHERE id = ?', [id]); }
  SUPER.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
