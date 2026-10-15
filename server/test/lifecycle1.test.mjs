/**
 * QA-37, batch 1: lists and message templates, as accepted on 13 Oct.
 *
 *   Static list   rename and describe it; remove a member (the lead stays);
 *                 archive it, restorable; delete it only if nothing was ever
 *                 sent to it, and only with its name typed.
 *
 *   Template      edit it, and an approved one goes back for approval; retire
 *                 one a campaign or rule has used; delete only one never used,
 *                 with a named confirmation and a "Deleted" message.
 *
 * Archived and retired mean the same thing at every door: out of every new
 * use -- a picker, a campaign, a rule, a send from a lead -- still readable,
 * and restorable.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { runAction, leadFacts } from '../src/engine/rules.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');
const source = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nQA-37 lifecycle: lists and templates');

const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-6);
const MARK = `LC1 probe ${RUN}`;
const SLUG = `lc1_probe_${RUN}`;

const RM = await probeAdmin('lc1-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const ADMIN = await probeAdmin('lc1-admin', { role: 'admin', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('lc1-bigul', { role: 'admin', sales_org: 'BIGUL' });
const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const made = { lists: [], leads: [], templates: [], campaigns: [] };

const makeList = (label) => {
  const id = Number(run(
    `INSERT INTO lead_lists (name, kind, owner_id, created_by, shared_with, sales_org, snapshot_reason, expires_at, updated_at)
     VALUES (?, 'static', ?, ?, '[]', 'BONANZA', 'probe', date('now', '+30 days'), datetime('now'))`,
    [`${MARK} ${label}`, RM.id, RM.id],
  ).lastInsertRowid);
  made.lists.push(id);
  return id;
};
let seq = 0;
const makeLead = () => {
  seq += 1;
  const id = Number(run(
    "INSERT INTO leads (sales_org, name, source, stage, owner_id, mobile) VALUES ('BONANZA', ?, 'Website', 'New', ?, ?)",
    [`${MARK} lead ${seq}`, RM.id, `9${DIGITS}${String(seq).padStart(3, '0')}`],
  ).lastInsertRowid);
  made.leads.push(id);
  return id;
};
const COMPONENTS = { category: 'UTILITY', language: 'en' };
const makeTemplate = (label, { channel = 'whatsapp', approved = 1 } = {}) => {
  const id = Number(run(
    `INSERT INTO templates (name, channel, subject, body, approved, components, sales_org)
     VALUES (?, ?, ?, 'Hi {{name}}, your review is due.', ?, ?, 'BONANZA')`,
    [`${SLUG}_${label}`, channel, channel === 'email' ? 'Your review' : null, approved,
      channel === 'whatsapp' ? JSON.stringify(COMPONENTS) : null],
  ).lastInsertRowid);
  made.templates.push(id);
  return id;
};
const makeCampaign = (listId, templateId, status = 'Draft', sent = 0) => {
  const id = Number(run(
    `INSERT INTO campaigns (name, channel, template_id, list_id, status, sent, created_by, sales_org)
     VALUES (?, 'whatsapp', ?, ?, ?, ?, ?, 'BONANZA')`,
    [`${MARK} campaign`, templateId, listId, status, sent, ADMIN.id],
  ).lastInsertRowid);
  made.campaigns.push(id);
  return id;
};
const listRow = (id) => one('SELECT * FROM lead_lists WHERE id = ?', [id]);
const templateRow = (id) => one('SELECT * FROM templates WHERE id = ?', [id]);

try {
  /* ------------------------------------------------------------- lists */

  await test('the owner renames and describes a static list, and it is audited', async () => {
    const list = makeList('rename');
    const res = await as(RM)('PATCH', `/lists/${list}`, { name: `${MARK} renamed`, description: 'Warm, no contact in 7 days' });
    assert.equal(res.status, 200, `rename answered ${res.status}: ${res.body?.error}`);
    assert.equal(listRow(list).name, `${MARK} renamed`);
    assert.equal(listRow(list).description, 'Warm, no contact in 7 days');
    assert(one("SELECT id FROM audit_log WHERE action = 'list.update' AND entity_id = ?", [list]), 'the rename was not audited');
    assert.equal((await as(RM)('PATCH', `/lists/${list}`, { name: '  ' })).status, 400, 'a list was renamed to nothing');
  });

  await test('removing a member takes it off the list and leaves the lead alone', async () => {
    const list = makeList('members');
    const lead = makeLead();
    run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?, ?)', [list, lead]);
    const res = await as(RM)('DELETE', `/lists/${list}/members/${lead}`);
    assert.equal(res.status, 200, `remove answered ${res.status}: ${res.body?.error}`);
    assert.equal(one('SELECT 1 x FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [list, lead]), undefined);
    assert(one('SELECT id FROM leads WHERE id = ? AND deleted_at IS NULL', [lead]), 'removing a member touched the lead');
  });

  await test('an archived list asks why, leaves the list of lists, and cannot change until restored', async () => {
    const list = makeList('archive');
    const lead = makeLead();
    run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?, ?)', [list, lead]);

    assert.equal((await as(RM)('POST', `/lists/${list}/archive`, { reason: '' })).status, 400, 'archived with no reason');
    const res = await as(RM)('POST', `/lists/${list}/archive`, { reason: 'Campaign finished' });
    assert.equal(res.status, 200, `archive answered ${res.status}: ${res.body?.error}`);
    assert.equal(listRow(list).archived_by, RM.id);

    const inUse = await as(RM)('GET', '/lists');
    assert(!inUse.body.some((l) => l.id === list), 'an archived list is still among the lists in use');
    const archived = await as(RM)('GET', '/lists?archived=only');
    assert(archived.body.some((l) => l.id === list && l.archived_by_name), 'the archived view does not show it, or who archived it');

    for (const [method, url, body] of [
      ['PATCH', `/lists/${list}`, { name: `${MARK} sneaky` }],
      ['POST', `/lists/${list}/members`, { lead_ids: [makeLead()] }],
      ['DELETE', `/lists/${list}/members/${lead}`],
      ['POST', `/lists/${list}/bulk/message`, { lead_ids: [lead], channel: 'whatsapp', body: 'Hi' }],
    ]) {
      const r = await as(RM)(method, url, body);
      assert.equal(r.status, 409, `${method} ${url.replace(String(list), ':id')} changed an archived list: HTTP ${r.status}`);
    }
    assert(one('SELECT 1 x FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [list, lead]), 'a member left an archived list');
    assert.equal((await as(RM)('GET', `/lists/${list}`)).status, 200, 'an archived list cannot be read');

    const restored = await as(RM)('POST', `/lists/${list}/restore`);
    assert.equal(restored.status, 200, `restore answered ${restored.status}: ${restored.body?.error}`);
    assert.equal(listRow(list).archived_at, null);
    assert.equal((await as(RM)('PATCH', `/lists/${list}`, { name: `${MARK} back` })).status, 200, 'a restored list is still frozen');
  });

  await test('restoring a snapshot that lapsed gives it a fresh expiry, and says so', async () => {
    const list = makeList('lapsed');
    run("UPDATE lead_lists SET expires_at = date('now', '-3 days'), archived_at = datetime('now', '-2 days') WHERE id = ?", [list]);
    const res = await as(RM)('POST', `/lists/${list}/restore`);
    assert.equal(res.status, 200, `restore answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.expiry_renewed, true, 'a lapsed snapshot came back with its old expiry, to be swept again');
    assert(one("SELECT 1 x FROM lead_lists WHERE id = ? AND date(expires_at) > date('now')", [list]), 'the expiry is not in the future');
  });

  await test('nothing is sent to an archived list: no campaign is made, re-pointed or sent to it', async () => {
    const list = makeList('no-sends');
    const open = makeList('open');
    const template = makeTemplate('campaign');
    run("UPDATE lead_lists SET archived_at = datetime('now'), archive_reason = 'probe' WHERE id = ?", [list]);

    const create = await as(ADMIN)('POST', '/admin/campaigns', { name: `${MARK} c`, channel: 'whatsapp', template_id: template, list_id: list });
    assert.equal(create.status, 409, `a campaign was made for an archived list: HTTP ${create.status}`);

    const draft = makeCampaign(open, template);
    const repoint = await as(ADMIN)('PATCH', `/admin/campaigns/${draft}`, { list_id: list });
    assert.equal(repoint.status, 409, `a draft was re-pointed at an archived list: HTTP ${repoint.status}`);

    const already = makeCampaign(list, template);
    const send = await as(ADMIN)('POST', `/admin/campaigns/${already}/send`);
    assert.equal(send.status, 409, `a campaign sent to an archived list: HTTP ${send.status}`);
    assert(/archived/i.test(send.body?.error ?? ''), `the refusal does not say why: ${send.body?.error}`);
  });

  await test('a list is deleted only with its name typed, and never once anything was sent to it', async () => {
    const sentTo = makeList('sent');
    makeCampaign(sentTo, makeTemplate('sent'), 'Sent', 40);
    const viaCampaign = await as(RM)('DELETE', `/lists/${sentTo}`, { confirm_name: `${MARK} sent` });
    assert.equal(viaCampaign.status, 409, `a list a campaign went to was deleted: HTTP ${viaCampaign.status}`);
    assert.equal(viaCampaign.body.archive_instead, true, 'the refusal does not offer archiving');

    const bulk = makeList('bulk');
    run("INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?, 'lead.message', 'lead', ?, ?)",
      [RM.id, makeLead(), JSON.stringify({ channel: 'whatsapp', via_list: bulk })]);
    const viaBulk = await as(RM)('DELETE', `/lists/${bulk}`, { confirm_name: `${MARK} bulk` });
    assert.equal(viaBulk.status, 409, `a list a bulk message went out from was deleted: HTTP ${viaBulk.status}`);

    const clean = makeList('clean');
    assert.equal((await as(RM)('DELETE', `/lists/${clean}`)).status, 400, 'deleted without the name typed');
    assert.equal((await as(RM)('DELETE', `/lists/${clean}`, { confirm_name: 'something else' })).status, 400);
    const res = await as(RM)('DELETE', `/lists/${clean}`, { confirm_name: `${MARK} clean` });
    assert.equal(res.status, 200, `delete answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.deleted, `${MARK} clean`);
    assert.equal(listRow(clean), undefined, 'the row survived');
  });

  await test('the other business cannot archive, restore or delete a list', async () => {
    const list = makeList('book');
    assert.equal((await as(BIGUL)('POST', `/lists/${list}/archive`, { reason: 'Across the book' })).status, 404);
    assert.equal((await as(BIGUL)('DELETE', `/lists/${list}`, { confirm_name: `${MARK} book` })).status, 404);
    assert.equal(listRow(list).archived_at, null, 'the archive landed anyway');
  });

  /* --------------------------------------------------------- templates */

  await test('changing an approved template\'s text sends it back for approval, in a separate act', async () => {
    const t = makeTemplate('edit');
    const res = await as(ADMIN)('PATCH', `/admin/templates/${t}`, { body: 'Hi {{name}}, a different note.', approved: 1 });
    assert.equal(res.status, 200, `edit answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.approval_reset, true, 'the edit did not say approval was reset');
    assert.equal(templateRow(t).approved, 0, 'the changed text is still approved -- by the request that changed it');
    assert(one("SELECT id FROM audit_log WHERE action = 'template_updated' AND entity_id = ? AND detail LIKE '%approval_reset%'", [t]));

    assert.equal((await as(ADMIN)('PATCH', `/admin/templates/${t}`, { approved: 1 })).status, 200);
    assert.equal(templateRow(t).approved, 1, 'approving it afterwards did not stick');
  });

  await test('a rename, or a resave of the same text, keeps the approval', async () => {
    const t = makeTemplate('keep');
    const renamed = await as(ADMIN)('PATCH', `/admin/templates/${t}`, { name: `${SLUG}_kept` });
    assert.equal(renamed.body.approval_reset, false);
    /* What the builder sends on Save: every field, the keys of components in
       another order, and an empty subject where the row holds none. */
    const resave = await as(ADMIN)('PATCH', `/admin/templates/${t}`, {
      name: `${SLUG}_kept`, subject: '', body: templateRow(t).body, components: { language: 'en', category: 'UTILITY' },
    });
    assert.equal(resave.status, 200, `resave answered ${resave.status}: ${resave.body?.error}`);
    assert.equal(resave.body.approval_reset, false, 'an untouched resave lost its approval');
    assert.equal(templateRow(t).approved, 1);
  });

  await test('retiring asks why, and takes the template out of every picker', async () => {
    const wa = makeTemplate('retire');
    const email = makeTemplate('retire_mail', { channel: 'email' });
    assert.equal((await as(ADMIN)('POST', `/admin/templates/${wa}/retire`, { reason: 'no' })).status, 400, 'retired with no reason');
    for (const id of [wa, email]) {
      const res = await as(ADMIN)('POST', `/admin/templates/${id}/retire`, { reason: 'Replaced by the new review note' });
      assert.equal(res.status, 200, `retire answered ${res.status}: ${res.body?.error}`);
      assert.match(res.body.message, /^Retired /);
    }
    assert.equal(templateRow(wa).retired_by, ADMIN.id);

    const pickers = await as(ADMIN)('GET', '/admin/templates');
    assert(!pickers.body.some((t) => t.id === wa), 'a retired template is still offered');
    const screen = await as(ADMIN)('GET', '/admin/templates?retired=include');
    assert(screen.body.some((t) => t.id === wa && t.retired_at), 'the Templates screen cannot see it to restore it');

    const compose = await as(ADMIN)('GET', `/email/compose/${makeLead()}`);
    assert.equal(compose.status, 200, `compose answered ${compose.status}: ${compose.body?.error}`);
    assert(!compose.body.templates.some((t) => t.id === email), 'the email composer still offers a retired template');
  });

  await test('a retired template sends nothing new: not a campaign, a rule or a message from a lead', async () => {
    const t = makeTemplate('nosend');
    run("UPDATE templates SET retired_at = datetime('now'), retire_reason = 'probe' WHERE id = ?", [t]);
    const lead = makeLead();

    const campaign = await as(ADMIN)('POST', '/admin/campaigns', { name: `${MARK} r`, channel: 'whatsapp', template_id: t, list_id: makeList('r') });
    assert.equal(campaign.status, 409, `a campaign was made with a retired template: HTTP ${campaign.status}`);
    assert(/retired/i.test(campaign.body?.error ?? ''), campaign.body?.error);

    const message = await as(ADMIN)('POST', `/leads/${lead}/message`, { channel: 'whatsapp', template_id: t, intent: 'service' });
    assert.equal(message.status, 409, `a lead was sent a retired template: HTTP ${message.status}`);
    assert(/retired/i.test(message.body?.error ?? ''), message.body?.error);

    const rule = runAction({ type: 'whatsapp', params: { template_id: t, intent: 'service' } }, leadFacts(lead), { dryRun: false });
    // The reason names the template since OPS-36 (one answer for every door that sends one).
    assert.match(String(rule.skipped), /is retired/, `a rule card sent it: ${JSON.stringify(rule)}`);
  });

  await test('a retired template is read-only until restored, and restore brings it back', async () => {
    const t = makeTemplate('restore');
    run("UPDATE templates SET retired_at = datetime('now'), retire_reason = 'probe' WHERE id = ?", [t]);
    assert.equal((await as(ADMIN)('PATCH', `/admin/templates/${t}`, { body: 'Hi {{name}}, changed.' })).status, 409);
    assert.equal((await as(ADMIN)('PATCH', `/admin/templates/${t}`, { approved: 0 })).status, 409);
    const res = await as(ADMIN)('POST', `/admin/templates/${t}/restore`);
    assert.equal(res.status, 200, `restore answered ${res.status}: ${res.body?.error}`);
    assert.equal(templateRow(t).retired_at, null);
    assert((await as(ADMIN)('GET', '/admin/templates')).body.some((x) => x.id === t), 'a restored template is not offered again');
  });

  await test('a template something used is retired, not deleted; an unused one needs its name typed', async () => {
    const used = makeTemplate('used');
    makeCampaign(makeList('used'), used);
    const refused = await as(ADMIN)('DELETE', `/admin/templates/${used}`, { confirm_name: `${SLUG}_used` });
    assert.equal(refused.status, 409, `a template a campaign used was deleted: HTTP ${refused.status}`);
    assert.equal(refused.body.retire_instead, true, 'the refusal does not offer retiring');
    assert.match(refused.body.error, /Retire it instead/);

    const unused = makeTemplate('unused');
    assert.equal((await as(ADMIN)('DELETE', `/admin/templates/${unused}`)).status, 400, 'deleted without the name typed');
    const res = await as(ADMIN)('DELETE', `/admin/templates/${unused}`, { confirm_name: `${SLUG}_unused` });
    assert.equal(res.status, 200, `delete answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.message, `Deleted ${SLUG}_unused`);
    assert.equal(templateRow(unused), undefined, 'the row survived');
  });

  await test('the other business cannot retire or restore a template', async () => {
    const t = makeTemplate('book');
    assert.equal((await as(BIGUL)('POST', `/admin/templates/${t}/retire`, { reason: 'Across the book' })).status, 403);
    assert.equal(templateRow(t).retired_at, null, 'the retire landed anyway');
    run("UPDATE templates SET retired_at = datetime('now') WHERE id = ?", [t]);
    assert.equal((await as(BIGUL)('POST', `/admin/templates/${t}/restore`)).status, 403);
  });

  await test('the screens offer it: archive and typed delete on lists, retire and typed delete on templates (source check)', async () => {
    const detail = source('crm/ListDetail.jsx');
    assert(/\/archive`/.test(detail) && /\/restore`/.test(detail), 'the list screen cannot archive or restore');
    assert(/confirm_name: confirmName/.test(detail), 'the list delete is not typed');
    assert(/archived=only/.test(source('crm/LeadLists.jsx')), 'Lead Lists has no archived view');
    const templates = source('crm/admin/Templates.jsx');
    assert(/retired=include/.test(templates), 'the Templates screen cannot see a retired template');
    assert(/\/retire`/.test(templates) && /\/restore`/.test(templates), 'the Templates screen cannot retire or restore');
    assert(/confirm_name: confirmName/.test(templates), 'the template delete is not typed');
    assert(/approval_reset/.test(templates), 'the Templates screen does not say an edit reset approval');
  });
} finally {
  for (const id of made.campaigns) run('DELETE FROM campaigns WHERE id = ?', [id]);
  for (const id of made.lists) run('DELETE FROM lead_lists WHERE id = ?', [id]);
  for (const id of made.templates) run('DELETE FROM templates WHERE id = ?', [id]);
  for (const id of made.leads) {
    run('DELETE FROM activities WHERE lead_id = ?', [id]);
    run('DELETE FROM leads WHERE id = ?', [id]);
  }
  run("DELETE FROM campaigns WHERE name LIKE ?", [`${MARK}%`]);
  run("DELETE FROM templates WHERE name LIKE ?", [`${SLUG}%`]);
  for (const p of [RM, ADMIN, BIGUL]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
