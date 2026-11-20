/**
 * Every write route that takes a path parameter is classified, and every one
 * that writes a business record refuses the other business.
 *
 * bookscope.test.mjs does this for reads, and its scanner read `.get(` only --
 * N-12 (ruled 12 Oct: "classify every POST and PATCH that takes a record id,
 * then fix whatever that turns up"). Done on 18 Nov by driving all 201 write
 * routes as a Bigul Admin against Bonanza records; what went through was fixed
 * (n12writes.test.mjs). This is the net that keeps it so:
 *
 *   RECORD  it changes a business record. The probe signs in as somebody of
 *           the other business who holds what the route asks -- a Bigul Admin,
 *           or the role named -- and demands a refusal that is the boundary's:
 *           a refusal naming a missing permission (`required`) does not count.
 *   NOT     it does not, with the reason.
 *
 * A new write route in neither list fails here, and its author has to say
 * which it is.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { snapshot } from '../src/engine/versioning.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import { routesWithParams } from './helpers/routemap.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

/* ----------------------------------------------------------- the reasons */

const SHARED = 'A setting both businesses share: changed by a Superadmin only (setup.shared, ruled 18 Nov). Asserted in sharedsettings.test.mjs.';
const PICKLIST = 'Picklist values; the parameters are configuration names. A value of one business is held to it by every writer (picklistbooks.test.mjs); one both businesses use is a shared setting (sharedsettings.test.mjs).';
const VRULE_CREATE = 'Creates a validation rule for the object named. The business it names is checked (mayUseOrg); a rule for both is a shared setting (sharedsettings.test.mjs).';
const PREVIEW = 'A preview: evaluates a rule without saving it, and writes nothing.';
const SYSTEM = 'Superadmin only (admin.system). A Superadmin works in both businesses, so the boundary between them does not arise.';
const OWN = 'The reader\'s own preference or saved search; the parameter names a list, a key or an object type, not a record.';
const SEARCH = 'The parameter is an object type, not a record id. Every entity is scoped to the reader where the search is built (scopeFor in search-advanced.js).';
const MIGRATE = 'Converts a rule -- which both businesses share -- into a draft flow in the reader\'s own business. It changes no rule and no client record.';
const NOTIF = 'Marks the reader\'s own notification: user_id is in the WHERE, so another person\'s id changes nothing.';
const DKYC = 'Public KYC. The resume token is the credential; there is no CRM session to hold to a business.';
const PORTAL = 'Partner portal. Signs in as a partner, not a CRM user, and reads and writes only that partner\'s own records (each route matches partner_id).';

/* ------------------------------------------------------------- the lists */

/** Write routes that change a business record: the kind of fixture, and anything the route needs to read first. */
const RECORD = {
  'POST /api/activities/:id/correct': {kind: 'activity'},
  'PATCH /api/activities/follow-ups/:taskId': {kind: 'task', body: {'due_at': '2031-01-15 11:00'}},
  'POST /api/activities/follow-ups/:taskId/complete': {kind: 'task'},
  'DELETE /api/admin/automations/:id': {kind: 'flow'},
  'PATCH /api/admin/automations/:id': {kind: 'flow'},
  'POST /api/admin/automations/:id/activate': {kind: 'flow'},
  'POST /api/admin/automations/:id/archive': {kind: 'flow'},
  'PATCH /api/admin/automations/:id/layout': {kind: 'flow'},
  'POST /api/admin/automations/:id/pause': {kind: 'flow'},
  'POST /api/admin/automations/:id/restore': {kind: 'flow'},
  'POST /api/admin/automations/:id/steps': {kind: 'flow'},
  'DELETE /api/admin/automations/:id/steps/:stepId': {kind: 'flow'},
  'PATCH /api/admin/automations/:id/steps/:stepId': {kind: 'flow'},
  'POST /api/admin/automations/:id/steps/:stepId/duplicate': {kind: 'flow'},
  'POST /api/admin/automations/:id/stickies': {kind: 'flow'},
  'DELETE /api/admin/automations/:id/stickies/:stickyId': {kind: 'flow'},
  'PATCH /api/admin/automations/:id/stickies/:stickyId': {kind: 'flow'},
  'POST /api/admin/automations/:id/test': {kind: 'flow'},
  'DELETE /api/admin/campaigns/:id': {kind: 'campaign'},
  'PATCH /api/admin/campaigns/:id': {kind: 'campaign'},
  'POST /api/admin/campaigns/:id/duplicate': {kind: 'campaign'},
  'POST /api/admin/campaigns/:id/pause': {kind: 'campaign'},
  'POST /api/admin/campaigns/:id/resume': {kind: 'campaign'},
  'POST /api/admin/campaigns/:id/send': {kind: 'campaign'},
  'POST /api/admin/campaigns/:id/test': {kind: 'campaign'},
  'POST /api/admin/content/:id/version': {kind: 'item'},
  'POST /api/admin/kyc/journeys/:productId': {kind: 'product'},
  'PATCH /api/admin/products/:id': {kind: 'product', body: {'name': 'Probe rename'}},
  'DELETE /api/admin/products/:id/brochure': {kind: 'product'},
  'POST /api/admin/products/:id/brochure': {kind: 'product'},
  'POST /api/admin/rules/failures/:id/resolve': {kind: 'failure'},
  'POST /api/admin/rules/failures/:id/retry': {kind: 'failure'},
  'DELETE /api/admin/templates/:id': {kind: 'template'},
  'PATCH /api/admin/templates/:id': {kind: 'template'},
  'POST /api/admin/templates/:id/restore': {kind: 'template'},
  'POST /api/admin/templates/:id/retire': {kind: 'template'},
  'DELETE /api/admin/test-records/:id': {kind: 'testrec'},
  'PATCH /api/admin/users/:id': {kind: 'user', body: {'title': 'Probe'}},
  'POST /api/admin/versions/:id/restore': {kind: 'version'},
  'POST /api/approvals/:id/decide': {kind: 'approval'},
  'POST /api/approvals/:id/withdraw': {kind: 'approval'},
  'PATCH /api/attendance/policy/:org': {kind: 'literal', value: 'BONANZA'},
  'POST /api/cards/:id/request-product-rm': {kind: 'card'},
  'POST /api/cards/:id/state': {kind: 'card'},
  'PATCH /api/clients/:id': {kind: 'client'},
  'POST /api/clients/:id/nominations': {kind: 'client'},
  'POST /api/clients/:id/reassign': {kind: 'client'},
  'DELETE /api/dashboards/:id': {kind: 'dashboard'},
  'PATCH /api/dashboards/:id': {kind: 'dashboard'},
  'POST /api/dashboards/:id/panels': {kind: 'dashboard'},
  'DELETE /api/dashboards/:id/panels/:panelId': {kind: 'dashboard'},
  'PATCH /api/dashboards/:id/panels/:panelId': {kind: 'dashboard'},
  'DELETE /api/email/templates/:id': {kind: 'template'},
  'DELETE /api/kra/config/metrics/:id': {kind: 'kra'},
  'PATCH /api/kra/config/metrics/:id': {kind: 'kra', body: {'label': 'Probe'}},
  'PATCH /api/kra/config/plans/:id': {kind: 'plan'},
  'POST /api/kyc/journeys/:id/assist': {kind: 'journey'},
  'POST /api/kyc/journeys/:id/objection': {kind: 'journey'},
  'POST /api/kyc/journeys/:id/override': {kind: 'journey'},
  'POST /api/kyc/journeys/:id/verification': {kind: 'journey'},
  'DELETE /api/leads/:id': {kind: 'lead'},
  'PATCH /api/leads/:id': {kind: 'lead'},
  'POST /api/leads/:id/call': {kind: 'lead'},
  // B26: only a Caller or Dealer holds lead.handover.
  'POST /api/leads/:id/handover': {kind: 'lead', as: 'caller', body: {'auto': true, 'needs_to_know': 'Probe'}},
  'POST /api/leads/:id/log-call': {kind: 'lead'},
  'POST /api/leads/:id/message': {kind: 'lead'},
  'POST /api/leads/:id/restore': {kind: 'lead'},
  'PATCH /api/libraries/:id': {kind: 'library'},
  'POST /api/libraries/:id/items': {kind: 'library'},
  'PATCH /api/libraries/items/:itemId': {kind: 'item'},
  'POST /api/libraries/items/:itemId/status': {kind: 'item'},
  'POST /api/libraries/items/:itemId/versions': {kind: 'item', body: {'url': 'https://example.invalid/probe'}},
  'DELETE /api/lists/:id': {kind: 'list'},
  'PATCH /api/lists/:id': {kind: 'list'},
  'POST /api/lists/:id/archive': {kind: 'list'},
  'POST /api/lists/:id/bulk/delete': {kind: 'list'},
  'POST /api/lists/:id/bulk/dialler': {kind: 'list'},
  'POST /api/lists/:id/bulk/field': {kind: 'list'},
  'POST /api/lists/:id/bulk/membership': {kind: 'list'},
  'POST /api/lists/:id/bulk/message': {kind: 'list'},
  'POST /api/lists/:id/bulk/reassign': {kind: 'list'},
  'POST /api/lists/:id/bulk/stage': {kind: 'list'},
  'POST /api/lists/:id/bulk/task': {kind: 'list'},
  'PATCH /api/lists/:id/columns': {kind: 'list'},
  'POST /api/lists/:id/export': {kind: 'list'},
  'POST /api/lists/:id/import': {kind: 'list', body: {'values': 'PROBE1'}},
  'POST /api/lists/:id/members': {kind: 'list'},
  'DELETE /api/lists/:id/members/:leadId': {kind: 'list'},
  'POST /api/lists/:id/preview': {kind: 'list'},
  'POST /api/lists/:id/refresh': {kind: 'list'},
  'POST /api/lists/:id/restore': {kind: 'list'},
  'POST /api/messages/channels/:id/archive': {kind: 'channel'},
  'POST /api/messages/channels/:id/join': {kind: 'channel'},
  'POST /api/messages/channels/:id/leave': {kind: 'channel'},
  'POST /api/messages/channels/:id/members': {kind: 'channel'},
  'DELETE /api/messages/channels/:id/members/:userId': {kind: 'channel'},
  'POST /api/messages/channels/:id/unarchive': {kind: 'channel'},
  'POST /api/messages/conversations/:id/files': {kind: 'conversation'},
  'POST /api/messages/conversations/:id/freeze': {kind: 'conversation', body: {reason: 'Probe from the other business'}},
  'POST /api/messages/conversations/:id/messages': {kind: 'conversation', body: {body: 'Probe from the other business'}},
  'POST /api/messages/conversations/:id/read': {kind: 'conversation'},
  'POST /api/messages/conversations/:id/unfreeze': {kind: 'conversation'},
  'POST /api/messages/message/:id/react': {kind: 'message'},
  'POST /api/messages/message/:id/withdraw': {kind: 'message'},
  'DELETE /api/messages/suspensions/:userId': {kind: 'suspended'},
  'POST /api/notes/:id/correct': {kind: 'note'},
  'POST /api/notes/:id/pin': {kind: 'note'},
  'PATCH /api/partners/:id': {kind: 'partner'},
  'POST /api/partners/:id/activities': {kind: 'partner'},
  'POST /api/partners/:id/archive': {kind: 'partner'},
  'POST /api/partners/:id/elevate': {kind: 'partner'},
  'POST /api/partners/:id/lms/:module': {kind: 'partner'},
  'POST /api/partners/:id/portal-access/withdraw': {kind: 'partner'},
  'POST /api/partners/:id/portal-credential': {kind: 'partner'},
  'POST /api/partners/:id/request-elevation': {kind: 'partner', as: 'partner_rm'},
  'POST /api/partners/:id/restore': {kind: 'partner'},
  'POST /api/partners/:id/sourced-leads': {kind: 'partner'},
  'POST /api/partners/:id/steps/:code': {kind: 'partner'},
  'PUT /api/queues/:id/members': {kind: 'queue'},
  'POST /api/queues/:id/place/:leadId': {kind: 'queue'},
  'POST /api/queues/claim/:leadId': {kind: 'lead'},
  'DELETE /api/search-advanced/saved/:id': {kind: 'saved'},
  'DELETE /api/setup/groups/:id': {kind: 'team'},
  'PATCH /api/setup/groups/:id': {kind: 'team'},
  'POST /api/setup/groups/:id/members': {kind: 'team'},
  'DELETE /api/setup/groups/:id/members/:userId': {kind: 'team'},
  'POST /api/setup/handovers/:id/undo': {kind: 'handover'},
  'PUT /api/setup/policies/:key': {kind: 'literal', value: 'partner_referral_cross_book.BONANZA'},
  'PATCH /api/setup/users/:id': {kind: 'user'},
  'POST /api/setup/users/:id/active': {kind: 'user'},
  'POST /api/setup/users/:id/ghost': {kind: 'user'},
  'POST /api/setup/users/:id/handover': {kind: 'user'},
  'POST /api/setup/users/:id/handover/preview': {kind: 'user'},
  'POST /api/setup/users/:id/permission-sets': {kind: 'user'},
  'DELETE /api/setup/users/:id/permission-sets/:setId': {kind: 'user'},
  'POST /api/setup/users/:id/reset-link': {kind: 'user'},
  'POST /api/setup/users/:id/tabs': {kind: 'user', body: {'tab_id': 'leads', 'visible': false}},
  'DELETE /api/setup/validation-rules/:id': {kind: 'vrule'},
  'PATCH /api/setup/validation-rules/:id': {kind: 'vrule'},
  'PATCH /api/tasks/:id': {kind: 'task'},
  'POST /api/tasks/:id/cancel': {kind: 'task'},
  'PATCH /api/tickets/:id': {kind: 'ticket'},
  'POST /api/tickets/:id/csat/void': {kind: 'ticket'},
  'POST /api/tickets/:id/escalate': {kind: 'ticket'},
  'POST /api/tickets/:id/merge': {kind: 'ticket'},
  'POST /api/tickets/:id/replies': {kind: 'ticket'},
  'POST /api/tickets/:id/replies/:replyId/correct': {kind: 'ticket'},
};

/** Write routes that take a parameter but do not change a business record. */
const NOT_A_RECORD = {
  'POST /api/admin/automations/migration/:ruleId': MIGRATE,
  'PATCH /api/admin/calendars/:kind': SHARED,
  'POST /api/admin/calendars/:kind/days': SHARED,
  'DELETE /api/admin/calendars/days/:id': SHARED,
  'PATCH /api/admin/categories/:id': SHARED,
  'POST /api/admin/categories/:id/restore': SHARED,
  'POST /api/admin/categories/:id/retire': SHARED,
  'PUT /api/admin/compliance-flags/:flag': SHARED,
  'PATCH /api/admin/connectors/meta/forms/:formId': SYSTEM,
  'DELETE /api/admin/rules/:id': SHARED,
  'PATCH /api/admin/rules/:id': SHARED,
  'POST /api/admin/rules/:id/archive': SHARED,
  'POST /api/admin/rules/:id/restore': SHARED,
  'POST /api/admin/rules/:id/run': SHARED,
  'POST /api/notifications/:id/read': NOTIF,
  'PATCH /api/orgs/:code': SYSTEM,
  'POST /api/portal/tickets/:id/replies': PORTAL,
  'POST /api/portal/tickets/:id/csat': PORTAL,
  'POST /api/portal/training/:module/complete': PORTAL,
  'POST /api/search-advanced/:entity': SEARCH,
  'POST /api/search-advanced/:entity/count': SEARCH,
  'POST /api/search-advanced/:entity/export': SEARCH,
  'POST /api/search-advanced/:entity/ids': SEARCH,
  'POST /api/search-advanced/:entity/save': OWN,
  'DELETE /api/setup/api-credentials/:id': SYSTEM,
  'PATCH /api/setup/api-credentials/:id': SYSTEM,
  'POST /api/setup/api-credentials/:id/rotate': SYSTEM,
  'DELETE /api/setup/columns/:list': OWN,
  'PUT /api/setup/columns/:list': OWN,
  'PUT /api/setup/columns/:list/role/:role': SHARED,
  'PATCH /api/setup/dialler/agents/:id': SYSTEM,
  'DELETE /api/setup/dialler/campaigns/:id': SYSTEM,
  'PATCH /api/setup/dialler/campaigns/:id': SYSTEM,
  'DELETE /api/setup/dispositions/:id': SHARED,
  'PATCH /api/setup/dispositions/:id': SHARED,
  'DELETE /api/setup/field-masking/fields/:field': SHARED,
  'PATCH /api/setup/forms/:type': SHARED,
  'PATCH /api/setup/log-retention/:kind': SYSTEM,
  'PATCH /api/setup/objects/:entity': SHARED,
  'PATCH /api/setup/objects/:entity/field-order': SHARED,
  'POST /api/setup/objects/:entity/fields': SHARED,
  'DELETE /api/setup/objects/:entity/fields/:apiName': SHARED,
  'PATCH /api/setup/objects/:entity/fields/:apiName': SHARED,
  'PUT /api/setup/objects/:entity/fields/:apiName/values': PICKLIST,
  'POST /api/setup/objects/:entity/fields/:apiName/values/add': PICKLIST,
  'POST /api/setup/objects/:entity/fields/:apiName/values/merge': PICKLIST,
  'POST /api/setup/objects/:entity/validation-rules': VRULE_CREATE,
  'POST /api/setup/objects/:entity/validation-rules/preview': PREVIEW,
  'PATCH /api/setup/owd/:entity': SYSTEM,
  'PUT /api/setup/preferences/:key': OWN,
  'DELETE /api/setup/roles/:code': SHARED,
  'PATCH /api/setup/roles/:code': SHARED,
  'DELETE /api/setup/webhook-endpoints/:id': SYSTEM,
  'PATCH /api/setup/webhook-endpoints/:id': SYSTEM,
  'POST /dkyc-api/resume/:token/otp': DKYC,
  'POST /dkyc-api/resume/:token/step': DKYC,
};

/* -------------------------------------------------------------- fixtures */

const RUN = Date.now().toString(36);
const MARK = `Bookscope writes ${RUN}`;
const BNZ = await probeAdmin('bsw-bnz-admin', { role: 'admin', sales_org: 'BONANZA' });
const BNZ_RM = await probeAdmin('bsw-bnz-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const OTHER = {
  admin: await probeAdmin('bsw-bgl-admin', { role: 'admin', sales_org: 'BIGUL' }),
  partner_rm: await probeAdmin('bsw-bgl-prm', { role: 'partner_rm', sales_org: 'BIGUL' }),
  caller: await probeAdmin('bsw-bgl-caller', { role: 'caller', sales_org: 'BIGUL' }),
};
const call = async (who, method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** A row with the given values, every other required column given a placeholder. */
function makeRow(table, values) {
  const v = { ...values };
  for (const c of all(`PRAGMA table_info(${table})`)) {
    if (c.pk || c.name in v || !c.notnull || c.dflt_value !== null) continue;
    v[c.name] = /INT/i.test(c.type) ? 1 : (/REAL|NUM/i.test(c.type) ? 1 : `${MARK}`);
  }
  const keys = Object.keys(v);
  return Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => v[k])).lastInsertRowid);
}
const made = [];  // [table, id], removed at the end
const make = (table, values) => { const id = makeRow(table, values); made.push([table, id]); return id; };
const latest = (sql) => one(sql)?.id;

const lead = await call(BNZ, 'POST', '/leads', { name: MARK, mobile: `9${String(Date.now()).slice(-9)}`, source: 'Manual', route: false });
assert.equal(lead.status, 201, `the fixture lead: ${JSON.stringify(lead.body)}`);
const LEAD = lead.body.id;
const conv = await call(BNZ, 'POST', '/messages/conversations', { user_id: BNZ_RM.id });
const CONVERSATION = conv.body?.id;
await call(BNZ, 'POST', `/messages/conversations/${CONVERSATION}/messages`, { body: MARK });
const MESSAGE = latest(`SELECT id FROM message WHERE conversation_id = ${Number(CONVERSATION)} ORDER BY id DESC LIMIT 1`);
const channel = await call(BNZ, 'POST', '/messages/channels', { name: `bsw ${RUN}`, visibility: 'private' });
const CHANNEL = channel.body?.id;
const suspended = await call(BNZ, 'POST', '/messages/suspensions', { user_id: BNZ_RM.id, reason: MARK });
const TEMPLATE = latest("SELECT id FROM templates WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1");

const FIXTURE = {
  lead: () => LEAD,
  card: () => latest("SELECT pc.id FROM product_cards pc JOIN leads l ON l.id = pc.lead_id WHERE l.sales_org = 'BONANZA' ORDER BY pc.id DESC LIMIT 1"),
  ticket: () => latest("SELECT id FROM tickets WHERE sales_org = 'BONANZA' ORDER BY id DESC LIMIT 1"),
  list: () => latest("SELECT id FROM lead_lists WHERE sales_org = 'BONANZA' ORDER BY id DESC LIMIT 1"),
  partner: () => latest("SELECT id FROM partners WHERE sales_org = 'BONANZA' ORDER BY id DESC LIMIT 1"),
  client: () => latest("SELECT id FROM clients WHERE sales_org = 'BONANZA' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1"),
  journey: () => latest("SELECT j.id FROM kyc_journeys j JOIN leads l ON l.id = j.lead_id WHERE l.sales_org = 'BONANZA' ORDER BY j.id DESC LIMIT 1"),
  task: () => latest("SELECT t.id FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE l.sales_org = 'BONANZA' ORDER BY t.id DESC LIMIT 1"),
  note: () => latest("SELECT n.id FROM notes n JOIN leads l ON l.id = n.lead_id WHERE l.sales_org = 'BONANZA' ORDER BY n.id DESC LIMIT 1"),
  activity: () => latest("SELECT a.id FROM activities a JOIN leads l ON l.id = a.lead_id WHERE l.sales_org = 'BONANZA' ORDER BY a.id DESC LIMIT 1"),
  campaign: () => latest("SELECT id FROM campaigns WHERE sales_org = 'BONANZA' ORDER BY id DESC LIMIT 1"),
  template: () => TEMPLATE,
  item: () => latest("SELECT id FROM content_items WHERE sales_org = 'BONANZA' ORDER BY id DESC LIMIT 1"),
  queue: () => latest("SELECT id FROM queues WHERE sales_org = 'BONANZA' ORDER BY id DESC LIMIT 1"),
  user: () => BNZ_RM.id,
  team: () => latest("SELECT id FROM teams WHERE sales_org = 'BONANZA' ORDER BY id DESC LIMIT 1"),
  product: () => latest("SELECT id FROM product_types WHERE sales_org = 'BONANZA' ORDER BY id DESC LIMIT 1"),
  kra: () => latest("SELECT id FROM kra_metrics WHERE sales_org = 'BONANZA' ORDER BY id DESC LIMIT 1"),
  plan: () => latest("SELECT id FROM incentive_plans WHERE sales_org = 'BONANZA' ORDER BY id DESC LIMIT 1"),
  library: (() => { const id = make('content_library', { name: MARK, owner_role: 'marketing_manager', sales_org: 'BONANZA' }); return () => id; })(),
  vrule: (() => { const id = make('validation_rule', { entity: 'lead', name: MARK, sales_org: 'BONANZA', condition: '{}', message: MARK }); return () => id; })(),
  flow: (() => { const id = make('automation', { name: MARK, sales_org: 'BONANZA', trigger_type: 'lead.created' }); return () => id; })(),
  dashboard: (() => { const id = make('custom_dashboard', { name: MARK, sales_org: 'BONANZA', owner_id: BNZ.id }); return () => id; })(),
  saved: (() => { const id = make('saved_searches', { name: MARK, entity: 'lead', tree: '{}', sales_org: 'BONANZA', created_by: BNZ.id }); return () => id; })(),
  approval: (() => { const id = make('approvals', { scope: 'lead.bulk_reassign', entity: 'lead', entity_id: LEAD, reason: MARK, status: 'Pending', requested_by: BNZ.id }); return () => id; })(),
  handover: (() => { const id = make('handover_batch', { from_user_id: BNZ_RM.id, sales_org: 'BONANZA', strategy: 'one', run_by: BNZ.id }); return () => id; })(),
  testrec: (() => { const id = make('test_records', { entity: 'lead', record_id: LEAD }); return () => id; })(),
  failure: (() => { const id = make('rule_failures', { rule_id: latest('SELECT id FROM rules ORDER BY id LIMIT 1'), lead_id: LEAD, action_type: 'task', error: MARK }); return () => id; })(),
  version: (() => { const v = snapshot('template', TEMPLATE, { note: MARK }); made.push(['artefact_versions', v.id]); return () => v.id; })(),
  conversation: () => CONVERSATION,
  message: () => MESSAGE,
  channel: () => CHANNEL,
  suspended: () => (suspended.status < 300 ? BNZ_RM.id : null),
};

/* ----------------------------------------------------------------- tests */

console.log('\nBook scope conformance: writes');

const writes = () => routesWithParams(['post', 'put', 'patch', 'delete']);

try {
  await test('every write route taking a parameter is classified', () => {
    const open = writes().map((r) => `${r.method} ${r.path}`).filter((k) => !(k in RECORD) && !(k in NOT_A_RECORD));
    assert.equal(open.length, 0, `these write routes take a parameter and nobody has said whether the boundary applies:\n${open.map((k) => `         ${k}`).join('\n')}\n       Add each to RECORD (with its kind) or NOT_A_RECORD (with a reason) in test/bookscopewrites.test.mjs.`);
    const both = Object.keys(RECORD).filter((k) => k in NOT_A_RECORD);
    assert.equal(both.length, 0, `classified both ways: ${both.join(', ')}`);
  });

  await test('every classified write route still exists', () => {
    const live = new Set(writes().map((r) => `${r.method} ${r.path}`));
    const stale = [...Object.keys(RECORD), ...Object.keys(NOT_A_RECORD)].filter((k) => !live.has(k));
    assert.equal(stale.length, 0, `these classifications no longer match a route:\n${stale.map((k) => `         ${k}`).join('\n')}`);
  });

  await test('every record write refuses the other business -- by the boundary, not a missing permission', async () => {
    const problems = [];
    // Deletes last, so a missing guard spoils nothing the others probe with.
    const order = Object.entries(RECORD).sort(([a], [b]) => Number(a.startsWith('DELETE')) - Number(b.startsWith('DELETE')));
    for (const [key, spec] of order) {
      const [method, pattern] = key.split(' ');
      const id = spec.kind === 'literal' ? spec.value : FIXTURE[spec.kind]?.();
      if (id == null) { problems.push(`${key}: no Bonanza ${spec.kind} to probe with`); continue; }
      let first = true;
      const path = pattern.replace(/:(\w+)/g, (m, name) => {
        if (first) { first = false; return encodeURIComponent(String(id)); }
        return name === 'leadId' ? String(LEAD) : '1';
      });
      // eslint-disable-next-line no-await-in-loop
      const r = await call(OTHER[spec.as ?? 'admin'], method, path.replace(/^\/api/, ''), method === 'DELETE' ? undefined : (spec.body ?? {}));
      if (![403, 404].includes(r.status) || r.body?.required) {
        problems.push(`${method} ${path} → HTTP ${r.status}${r.body?.required ? `, refused for want of ${r.body.required} -- not by the boundary` : ''}: ${JSON.stringify(r.body).slice(0, 110)}`);
      }
    }
    assert.equal(problems.length, 0, `the boundary does not hold on these writes:\n${problems.map((p) => `         ${p}`).join('\n')}`);
  });

  await test('the other business\'s template, journey and KRA history is not read either (A2b)', async () => {
    const v = FIXTURE.version();
    const byArtefact = await call(OTHER.admin, 'GET', `/admin/versions/template/${TEMPLATE}`);
    assert.equal(byArtefact.status, 404, `an artefact's history: HTTP ${byArtefact.status}`);
    const diff = await call(OTHER.admin, 'GET', `/admin/versions/diff?a=${v}&b=${v}`);
    assert.equal(diff.status, 404, `a diff: HTTP ${diff.status}`);
    const recent = await call(OTHER.admin, 'GET', '/admin/versions?kind=template');
    assert.ok(!recent.body?.recent?.some((x) => x.id === v), 'the recent list showed it');
    const own = await call(BNZ, 'GET', `/admin/versions/template/${TEMPLATE}`);
    assert.equal(own.status, 200, `its own business could not read it: HTTP ${own.status}`);
  });
} finally {
  run('DELETE FROM messaging_suspension WHERE user_id = ?', [BNZ_RM.id]);
  for (const c of [CONVERSATION, CHANNEL].filter(Boolean)) {
    run('DELETE FROM message WHERE conversation_id = ?', [c]);
    run('DELETE FROM conversation_member WHERE conversation_id = ?', [c]);
    run('DELETE FROM conversation WHERE id = ?', [c]);
  }
  for (const [table, id] of made.reverse()) run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  run('DELETE FROM tasks WHERE lead_id = ?', [LEAD]);
  run('DELETE FROM leads WHERE id = ?', [LEAD]);
  for (const p of [BNZ, BNZ_RM, OTHER.admin, OTHER.partner_rm, OTHER.caller]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
