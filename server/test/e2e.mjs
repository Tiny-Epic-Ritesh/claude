/**
 * Bonanza CRM — end-to-end test suite.
 *
 * Exercises every module through the real HTTP API: no mocks, no internal imports.
 * Run against a freshly seeded database:
 *
 *   npm run seed && npm start &   # or npm run dev
 *   npm test
 *
 * Exits non-zero if anything fails, so it can gate a deployment.
 */

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

/* ------------------------------------------------------------- harness */

const results = [];
let currentSuite = 'general';

const suite = (name) => { currentSuite = name; };

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ suite: currentSuite, name, ok: true, ms: Date.now() - started });
  } catch (err) {
    results.push({ suite: currentSuite, name, ok: false, ms: Date.now() - started, error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

const eq = (actual, expected, label) =>
  assert(actual === expected, `${label || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const includes = (haystack, needle, label) =>
  assert(String(haystack ?? '').includes(needle), `${label || 'value'}: expected to contain "${needle}", got "${haystack}"`);

/* ---------------------------------------------------------------- http */

async function req(path, { method = 'GET', body, token, expect, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // Vendor webhooks authenticate with a shared secret rather than a session,
      // so the suite needs to set arbitrary headers.
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} → expected HTTP ${expect}, got ${res.status}: ${text.slice(0, 220)}`);
  }
  return { status: res.status, data, res };
}

const login = async (email, password = 'bonanza') => {
  const { status, data } = await req('/api/auth/login', { method: 'POST', body: { email, password } });

  // The login limiter is keyed per account, so signing in by hand or through the
  // browser shortly before a run can exhaust it. Say so plainly: otherwise every
  // later test fails with "Sign in required" and the real cause is invisible.
  if (status === 429) {
    throw new Error(
      `Rate limited signing in as ${email}. The per-account login limit is 10/minute — `
      + 'wait a minute and re-run. (This is the limiter working, not a failure.)',
    );
  }
  if (status !== 200) throw new Error(`Could not sign in as ${email}: HTTP ${status}`);
  return data.token;
};

/* ------------------------------------------------------------ fixtures */

const T = {};      // role → token
const REF = {};    // reference records created by the suite

/**
 * Every run creates records under a unique identity, so the suite is idempotent:
 * it can run repeatedly against the same database without colliding with itself.
 */
const RUN = String(Date.now()).slice(-8);

/* Shown whenever a test trips over a seed fixture an earlier run consumed. */
const RESEED = 'The seed fixtures have been consumed by a previous run — '
  + 'reseed first: `npm test` (or `node src/seed.js` then `npm run test:only`).';

/** Guard for tests that build on a fixture, so the failure names the cause. */
const need = (value, what) => {
  if (!value) throw new Error(`${what} is not available. ${RESEED}`);
  return value;
};
const mob = (n) => `9${RUN}${n}`.slice(0, 10);
const mail = (who) => `${who}.${RUN}@e2e.local`;

/* ================================================================ tests */

async function run() {
  console.log(`\nBonanza CRM — end-to-end suite\ntarget: ${BASE}\n${'─'.repeat(64)}`);

  /* ---------------------------------------------------- 1. health/auth */
  suite('01 health & authentication');

  await check('API is reachable', async () => {
    const { data } = await req('/api/health', { expect: 200 });
    eq(data.ok, true, 'health.ok');
  });

  await check('valid credentials return a token', async () => {
    const { data } = await req('/api/auth/login', {
      method: 'POST', body: { email: 'admin@bonanza.test', password: 'bonanza' }, expect: 200,
    });
    assert(data.token, 'no token returned');
    eq(data.user.role, 'admin', 'user.role');
    assert(Array.isArray(data.user.permissions), 'permissions missing');
  });

  await check('wrong password is rejected with 401', async () => {
    await req('/api/auth/login', {
      method: 'POST', body: { email: 'admin@bonanza.test', password: 'wrong' }, expect: 401,
    });
  });

  await check('unknown user is rejected with 401', async () => {
    await req('/api/auth/login', {
      method: 'POST', body: { email: 'nobody@bonanza.test', password: 'bonanza' }, expect: 401,
    });
  });

  await check('protected route refuses an unauthenticated request', async () => {
    await req('/api/leads', { expect: 401 });
  });

  await check('all 11 roles can sign in', async () => {
    const roles = {
      superadmin: 'superadmin@bonanza.test',
      admin: 'admin@bonanza.test',
      caller: 'caller@bonanza.test',
      dealer: 'dealer@bonanza.test',
      sales_rm: 'salesrm@bonanza.test',
      sales_supervisor: 'salessupervisor@bonanza.test',
      partner_rm: 'partnerrm@bonanza.test',
      product_rm: 'productrm@bonanza.test',
      product_supervisor: 'productsupervisor@bonanza.test',
      customer_care: 'care@bonanza.test',
      marketing_manager: 'marketing@bonanza.test',
    };
    for (const [role, email] of Object.entries(roles)) {
      T[role] = await login(email);
      const { data } = await req('/api/auth/me', { token: T[role], expect: 200 });
      eq(data.user.role, role, `me.role for ${email}`);
    }
  });

  /* --------------------------------------------------------- 2. cockpits */
  suite('02 role cockpits');

  await check('every role returns a well-formed 3-zone cockpit', async () => {
    for (const [role, token] of Object.entries(T)) {
      const { data } = await req('/api/cockpit', { token, expect: 200 });
      assert(data.title, `${role}: no title`);
      assert(Array.isArray(data.metrics) && data.metrics.length > 0, `${role}: zone 1 metrics missing`);
      assert(data.worklist && Array.isArray(data.worklist.rows), `${role}: zone 2 worklist missing`);
      assert(Array.isArray(data.actions) && data.actions.length > 0, `${role}: zone 3 actions missing`);
      assert(Array.isArray(data.tasks), `${role}: tasks missing`);
    }
  });

  await check('Product RM cockpit is flagged read-only', async () => {
    const { data } = await req('/api/cockpit', { token: T.product_rm, expect: 200 });
    eq(data.read_only, true, 'product_rm.read_only');
    eq(data.worklist.type, 'cards', 'product_rm worklist type');
  });

  await check('Caller cockpit surfaces a lead queue', async () => {
    const { data } = await req('/api/cockpit', { token: T.caller, expect: 200 });
    eq(data.worklist.type, 'leads', 'caller worklist type');
  });

  await check('Customer Care cockpit surfaces a ticket queue', async () => {
    const { data } = await req('/api/cockpit', { token: T.customer_care, expect: 200 });
    eq(data.worklist.type, 'tickets', 'customer_care worklist type');
  });

  /* ------------------------------------------------------------ 3. leads */
  suite('03 lead management');

  await check('lead list returns decorated rows', async () => {
    const { data } = await req('/api/leads', { token: T.admin, expect: 200 });
    assert(Array.isArray(data) && data.length > 0, 'no leads returned');
    const lead = data[0];
    assert('age_band' in lead, 'age_band not computed');
    assert(Array.isArray(lead.cards), 'cards not attached');
    assert('open_tickets' in lead, 'open_tickets not counted');
  });

  await check("creating a lead auto-generates a card per product in the lead's own org", async () => {
    const { data: meta } = await req('/api/meta', { token: T.sales_rm, expect: 200 });

    const { data } = await req('/api/leads', {
      method: 'POST', token: T.sales_rm, expect: 201,
      // route:false keeps the lead with its creator. Suites 03-25 assert against
      // a known owner, and 'Website' is an inbound source that would otherwise
      // be handed to the digital desk by the assignment rules. Routing itself
      // is covered in suite 26.
      body: {
        name: 'E2E Test Lead', mobile: mob(1), email: mail('lead'),
        city: 'Mumbai', source: 'Website', route: false,
      },
    });
    REF.leadId = data.id;

    // The catalogue is per business: a Bonanza lead must not carry a Bigul
    // Connect card, so the count follows the lead's org, not the whole product
    // table. Asserting the identity is stronger than asserting the number.
    const ownOrg = meta.products.filter((p) => !p.sales_org || p.sales_org === data.sales_org);
    assert(ownOrg.length > 0, 'no products found for the org this lead belongs to');
    eq(data.cards.length, ownOrg.length, 'auto-generated card count');

    const cardProducts = new Set(data.cards.map((c) => c.product_type_id));
    for (const p of ownOrg) assert(cardProducts.has(p.id), `no card for ${p.code}`);

    assert(data.cards.every((c) => c.state === 'INACTIVE'), 'cards should all start Inactive');
  });

  await check('duplicate mobile is rejected with 409', async () => {
    const { data } = await req('/api/leads', {
      method: 'POST', token: T.sales_rm, expect: 409,
      body: { name: 'Duplicate', mobile: mob(1) },
    });
    assert(data.duplicate_id, 'duplicate_id not reported');
  });

  await check('lead without a name is rejected with 400', async () => {
    await req('/api/leads', { method: 'POST', token: T.sales_rm, expect: 400, body: { mobile: mob(8) } });
  });

  await check('search filter matches on mobile', async () => {
    const { data } = await req(`/api/leads?q=${mob(1)}`, { token: T.sales_rm, expect: 200 });
    eq(data.length, 1, 'search result count');
    eq(data[0].name, 'E2E Test Lead', 'search result name');
  });

  await check('card-state filter returns only matching leads', async () => {
    const { data } = await req('/api/leads?card_state=WARM', { token: T.admin, expect: 200 });
    for (const lead of data) {
      assert(lead.cards.some((c) => c.state === 'WARM'), `lead ${lead.id} has no WARM card`);
    }
  });

  await check('lead detail includes every related collection', async () => {
    const { data } = await req(`/api/leads/${REF.leadId}`, { token: T.sales_rm, expect: 200 });
    for (const key of ['activities', 'tasks', 'notes', 'tickets', 'journeys', 'cards']) {
      assert(Array.isArray(data[key]), `${key} missing from lead detail`);
    }
  });

  /* -------------------------------------------------------------- 4. RBAC */
  suite('04 permissions (enforced at the API)');

  await check('Caller cannot mark a card Warm', async () => {
    const { data: lead } = await req(`/api/leads/${REF.leadId}`, { token: T.sales_rm, expect: 200 });
    REF.cardId = lead.cards[0].id;
    REF.mfCardId = lead.cards.find((c) => c.product_code === 'MF').id;

    const { data } = await req(`/api/cards/${REF.cardId}/state`, {
      method: 'POST', token: T.caller, expect: 403, body: { state: 'WARM' },
    });
    eq(data.required, 'card.mark.warm', 'required capability not reported');
  });

  await check('Caller CAN mark a card Exploring', async () => {
    const { data } = await req(`/api/cards/${REF.cardId}/state`, {
      method: 'POST', token: T.caller, expect: 200, body: { state: 'EXPLORING', note: 'e2e' },
    });
    eq(data.to, 'EXPLORING', 'transition target');
  });

  await check('Sales RM cannot change lead stage without a supervisor', async () => {
    const { data } = await req(`/api/leads/${REF.leadId}`, {
      method: 'PATCH', token: T.sales_rm, expect: 403, body: { stage: 'Qualified' },
    });
    eq(data.required, 'lead.stage.change', 'required capability');
  });

  await check('Sales Supervisor CAN change lead stage', async () => {
    const { data } = await req(`/api/leads/${REF.leadId}`, {
      method: 'PATCH', token: T.sales_supervisor, expect: 200, body: { stage: 'Qualified' },
    });
    eq(data.stage, 'Qualified', 'stage after supervisor change');
  });

  await check('Product RM is refused write access to a lead', async () => {
    await req(`/api/leads/${REF.leadId}`, {
      method: 'PATCH', token: T.product_rm, expect: 403, body: { city: 'Delhi' },
    });
  });

  await check('lead visibility is scoped — Caller cannot open another RM\'s lead', async () => {
    const { data } = await req(`/api/leads/${REF.leadId}`, { token: T.caller, expect: 403 });
    includes(data.error, 'visibility scope', 'scope error message');
  });

  await check('non-admin is refused the admin user list', async () => {
    await req('/api/admin/users', { token: T.caller, expect: 403 });
  });

  await check('non-admin is refused the rule builder', async () => {
    await req('/api/admin/rules', { token: T.sales_rm, expect: 403 });
  });

  /* ------------------------------------------------------ 5. product cards */
  suite('05 product cards & state machine');

  await check('Sales RM can mark Warm and set a contact flag', async () => {
    const { data } = await req(`/api/cards/${REF.mfCardId}/state`, {
      method: 'POST', token: T.sales_rm, expect: 200,
      body: { state: 'WARM', contact_flag: 'Direct Contact', note: 'e2e warm' },
    });
    eq(data.to, 'WARM', 'state after warm');
  });

  await check('Warm notifies the Product RM for that product', async () => {
    const { data } = await req('/api/notifications', { token: T.product_rm, expect: 200 });
    assert(data.some((n) => /warm/i.test(n.title)), 'no warm notification for the Product RM');
  });

  await check('every state change is written to the card audit trail', async () => {
    const { data } = await req(`/api/cards/${REF.mfCardId}/audit`, { token: T.sales_rm, expect: 200 });
    assert(data.length > 0, 'audit trail empty');
    eq(data[0].to_state, 'WARM', 'latest audit entry');
    assert(data[0].user_name, 'audit entry has no actor');
  });

  await check('an unknown state is rejected with 400', async () => {
    await req(`/api/cards/${REF.mfCardId}/state`, {
      method: 'POST', token: T.sales_rm, expect: 400, body: { state: 'NONSENSE' },
    });
  });

  await check('Sales RM can request Product RM intervention', async () => {
    const { data } = await req(`/api/cards/${REF.mfCardId}/request-product-rm`, {
      method: 'POST', token: T.sales_rm, expect: 200, body: { reason: 'e2e intervention' },
    });
    eq(data.requested, true, 'intervention requested');
    assert(data.notified >= 1, 'no Product RM notified');
  });

  /* ------------------------------------------------- 6. activities/scoring */
  suite('06 activity & lead scoring');

  await check('logging an activity raises the lead score', async () => {
    const { data: before } = await req(`/api/leads/${REF.leadId}`, { token: T.sales_rm, expect: 200 });
    await req('/api/activities', {
      method: 'POST', token: T.sales_rm, expect: 201,
      // Contact activities now carry a mandatory outcome (suite 26): an
      // untagged meeting is one nobody can report on.
      body: {
        lead_id: REF.leadId, type: 'Meeting', subject: 'e2e meeting',
        disposition: 'MEET_HELD_POSITIVE', body: 'Positive discussion',
      },
    });
    const { data: after } = await req(`/api/leads/${REF.leadId}`, { token: T.sales_rm, expect: 200 });
    assert(after.score > before.score, `score did not rise (${before.score} → ${after.score})`);
  });

  await check('activity appears on the lead timeline', async () => {
    const { data } = await req(`/api/activities?lead_id=${REF.leadId}`, { token: T.sales_rm, expect: 200 });
    assert(data.some((a) => a.subject === 'e2e meeting'), 'activity not on timeline');
  });

  /* ------------------------------------------------------------- 7. tasks */
  suite('07 tasks');

  await check('a task without a due date is rejected', async () => {
    await req('/api/tasks', {
      method: 'POST', token: T.sales_rm, expect: 400,
      body: { title: 'No due date', lead_id: REF.leadId },
    });
  });

  await check('a task with a due date is created', async () => {
    const due = new Date(Date.now() + 864e5).toISOString().slice(0, 19).replace('T', ' ');
    const { data } = await req('/api/tasks', {
      method: 'POST', token: T.sales_rm, expect: 201,
      body: { title: 'E2E follow-up', lead_id: REF.leadId, due_at: due, priority: 'High' },
    });
    REF.taskId = data.id;
    eq(data.status, 'Open', 'new task status');
  });

  await check('a task can be completed', async () => {
    const { data } = await req(`/api/tasks/${REF.taskId}`, {
      method: 'PATCH', token: T.sales_rm, expect: 200, body: { status: 'Completed' },
    });
    eq(data.status, 'Completed', 'task status after update');
  });

  /* ------------------------------------------------------------- 8. notes */
  suite('08 notes');

  await check('a note is created and attributed', async () => {
    const { data } = await req('/api/notes', {
      method: 'POST', token: T.sales_rm, expect: 201,
      body: { lead_id: REF.leadId, body: 'E2E note — visible to the whole team.' },
    });
    REF.noteId = data.id;
    eq(data.user_role, 'sales_rm', 'note author role');
  });

  await check('an empty note is rejected', async () => {
    await req('/api/notes', { method: 'POST', token: T.sales_rm, expect: 400, body: { lead_id: REF.leadId, body: '  ' } });
  });

  await check('the author can pin their own note', async () => {
    const { data } = await req(`/api/notes/${REF.noteId}/pin`, { method: 'POST', token: T.sales_rm, expect: 200 });
    eq(data.pinned, true, 'pinned');
  });

  await check('an unrelated non-supervisor cannot pin someone else\'s note', async () => {
    await req(`/api/notes/${REF.noteId}/pin`, { method: 'POST', token: T.caller, expect: 403 });
  });

  /* ----------------------------------------------------------- 9. tickets */
  suite('09 ticketing & SLA');

  await check('editing a record checks which record, not only which fields', async () => {
    /* PATCH /leads/:id gated carefully what a caller may change — stage and
       owner both need a capability — and never checked which lead they may
       touch. It loaded by id alone, so a Bonanza dealer could edit a Bigul
       lead's name, mobile, city and consent flags. The read side of this record
       was scoped in August; the write side was not.

       Proved from the other book rather than by role, because the book is the
       boundary that must never bend. */
    const bigul = await login('rm@bigul.test');
    const { data: theirs } = await req('/api/leads?limit=1', { token: bigul, expect: 200 });
    const target = need(theirs[0], 'a BIGUL lead');

    const { data } = await req(`/api/leads/${target.id}`, {
      method: 'PATCH', token: T.dealer, expect: 403,
      body: { city: 'Nowhere' },
    });
    assert(/another book/i.test(data.error), `the refusal did not name the book: ${data.error}`);

    // And the lead is untouched.
    const { data: after } = await req(`/api/leads/${target.id}`, { token: bigul, expect: 200 });
    assert(after.city !== 'Nowhere', 'the refused edit was applied anyway');
  });

  await check('a case cannot be changed from the other book', async () => {
    /* Untestable until the seed grew a Bigul case. Every seeded ticket was
       Bonanza's, so there was nothing in the other book to try these against —
       and both routes turned out to accept the write the moment there was.

       PATCH gated reassignment on a capability and never checked which case;
       CSAT checked nothing at all. */
    const bigul = await login('care@bigul.test');
    const { data: theirs } = await req('/api/tickets?limit=1', { token: bigul, expect: 200 });
    const target = need(theirs[0], 'a BIGUL case');
    assert(target.ref.startsWith('BGL-'), `a Bigul case should carry a BGL ref, got ${target.ref}`);

    await req(`/api/tickets/${target.id}`, {
      method: 'PATCH', token: T.dealer, expect: 403, body: { priority: 'Low' },
    });
    await req(`/api/tickets/${target.id}/csat`, {
      method: 'POST', token: T.dealer, expect: 403, body: { score: 1 },
    });

    // Untouched, and still reachable by the people it belongs to.
    const { data: after } = await req(`/api/tickets/${target.id}`, { token: bigul, expect: 200 });
    eq(after.priority, target.priority, 'the refused edit was applied anyway');
    eq(after.csat, target.csat ?? null, 'the refused CSAT was recorded anyway');
  });

  await check('a second business gets the shipped targets too', async () => {
    /* seedKra inserted without naming a book, so every shipped metric landed on
       the column default and Bigul had none — while routes/kra.js reads
       `WHERE role_code = ? AND sales_org = ?`. A Bigul RM opened their
       scorecard and saw an empty one. Nothing looked wrong from Bonanza, which
       is why it lasted. */
    const bigul = await login('rm@bigul.test');
    const { data: theirs } = await req('/api/kra', { token: bigul, expect: 200 });
    const { data: ours } = await req('/api/kra', { token: T.sales_rm, expect: 200 });

    assert(theirs.metrics.length > 0, 'a Bigul RM has no KRA metrics at all');
    eq(theirs.metrics.length, ours.metrics.length,
      'the two businesses ship a different number of metrics for the same role');
  });

  await check('the targets screen configures one business at a time', async () => {
    /* This route took no request and returned every row. While only one
       business had metrics it looked right; with both, a role weighted to 200
       and the screen offered two unlabelled copies of each metric to edit. */
    const { data } = await req('/api/kra/config', { token: T.admin, expect: 200 });
    assert(data.sales_org, 'the config does not say which business it is for');

    const byRole = new Map();
    for (const m of data.metrics.filter((x) => x.active)) {
      byRole.set(m.role_code, (byRole.get(m.role_code) ?? 0) + m.weight);
    }
    for (const [role, total] of byRole) {
      eq(total, 100, `${role} weights to ${total}, not 100 — the config is mixing books`);
    }
    assert(data.metrics.every((m) => m.sales_org === data.sales_org),
      'the config returned a metric from another business');
  });

  await check('a list and a campaign stay in their own book', async () => {
    /* Both were uniform in the seed until now — every list and every campaign
       was Bonanza's — so mayReadList's book check and the book filter on the
       campaign list were carried by nothing. Neither turned out to be broken,
       which is worth knowing rather than assuming. */
    const bigul = await login('supervisor@bigul.test');

    const { data: theirLists } = await req('/api/lists', { token: bigul, expect: 200 });
    const theirs = need(theirLists.find((l) => l.name.startsWith('Bigul')), 'a BIGUL list');
    await req(`/api/lists/${theirs.id}`, { token: T.admin, expect: 404 });
    await req(`/api/lists/${theirs.id}`, { token: bigul, expect: 200 });

    const { data: ours } = await req('/api/admin/campaigns?limit=500', { token: T.admin, expect: 200 });
    assert(ours.length > 0, 'the campaign list came back empty, so this proves nothing');
    assert(!ours.some((c) => c.sales_org === 'BIGUL'), 'a Bonanza admin was shown a Bigul campaign');
  });

  await check('a campaign is created into the book of the list it sends to', async () => {
    /* campaigns.sales_org defaults to BONANZA at the column and the create
       route never set it — the same defect the ticket route had. It matters
       more now the campaign list filters by book: a Bigul marketer would have
       created a campaign into Bonanza's book, hidden from themselves and
       visible to the other business. */
    /* Created by a superadmin, who reaches both books — which makes this the
       sharper version of the question. If the author decided the book, a
       superadmin's campaign would land in whichever book they happen to sit in;
       the audience decides, so it lands in the list's. Bigul has no marketing
       manager of its own to create it, which is the other reason. */
    const bigul = await login('supervisor@bigul.test');
    const { data: lists } = await req('/api/lists', { token: bigul, expect: 200 });
    const audience = need(lists.find((l) => l.kind !== 'dynamic'), 'a BIGUL list to send to');

    const { data: made } = await req('/api/admin/campaigns', {
      method: 'POST', token: T.superadmin, expect: 201,
      body: { name: `Book check ${RUN}`, channel: 'whatsapp', list_id: audience.id },
    });
    eq(made.sales_org, 'BIGUL', 'a campaign on a Bigul list was created into the other book');

    const { data: bonanzaSees } = await req('/api/admin/campaigns?limit=500', { token: T.admin, expect: 200 });
    assert(!bonanzaSees.some((c) => c.id === made.id), 'a Bonanza admin was shown a Bigul campaign');
  });

  await check('a case is raised into the book of whatever it is about', async () => {
    /* tickets.sales_org defaults to BONANZA at the column and the create route
       never set it, so every case ever raised landed in Bonanza's book — a
       Bigul case readable by Bonanza staff and missing from the queue of the
       people it belonged to. The subject decides, not the author. */
    const bigul = await login('rm@bigul.test');
    const { data: leads } = await req('/api/leads?limit=1', { token: bigul, expect: 200 });
    const lead = need(leads[0], 'a BIGUL lead');
    const { data: meta } = await req('/api/meta', { token: bigul, expect: 200 });

    const { data: made } = await req('/api/tickets', {
      method: 'POST', token: bigul, expect: 201,
      body: {
        subject: `Book check ${RUN}`, description: 'Raised on a Bigul lead.',
        priority: 'Low', category_id: meta.ticket_categories[0].id, lead_id: lead.id,
      },
    });
    assert(made.ref.startsWith('BGL-'), `a Bigul case should carry a BGL ref, got ${made.ref}`);

    // Its own book can open it; the other cannot.
    await req(`/api/tickets/${made.id}`, { token: bigul, expect: 200 });
    await req(`/api/tickets/${made.id}`, { token: T.admin, expect: 403 });
  });

  await check('a task can only be changed by somebody it belongs to', async () => {
    /* This route had no check at all: it updated by id and returned the whole
       row, which made it a write primitive over every task in the system —
       reassign, reschedule, close — and a read primitive besides. */
    const bigul = await login('rm@bigul.test');
    const { data: theirTasks } = await req('/api/tasks?limit=1', { token: bigul, expect: 200 });

    if (theirTasks.length) {
      await req(`/api/tasks/${theirTasks[0].id}`, {
        method: 'PATCH', token: T.dealer, expect: 404, body: { priority: 'Low' },
      });
    }

    /* Within one book it is ownership, which is the rule the Tasks list
       applies: your own unless you hold report.team.

       Built rather than found. The lead scope runs first, so for most pairs of
       users the refusal is already a 404 and the ownership branch never
       executes — an earlier version of this test passed with that branch
       disabled. This puts a task on a lead the caller owns and assigns it to
       somebody else, which is the one shape that reaches it. */
    const { data: theirLeads } = await req('/api/leads?limit=1', { token: T.caller, expect: 200 });
    const lead = need(theirLeads[0], 'a lead the caller can see');

    const { data: me } = await req('/api/auth/me', { token: T.sales_rm, expect: 200 });

    const { data: made } = await req('/api/tasks', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        title: `Someone else's task ${RUN}`,
        lead_id: lead.id,
        assignee_id: me.user.id,
        due_at: '2030-01-01 09:00',
        priority: 'Normal',
      },
    });

    // The caller can see the lead, so they reach the ownership check itself.
    const { data: refused } = await req(`/api/tasks/${made.id}`, {
      method: 'PATCH', token: T.caller, expect: 403, body: { priority: 'Low' },
    });
    assert(/somebody else/i.test(refused.error), `unexpected refusal: ${refused.error}`);

    /* The other half of the rule. Not the assignee here on purpose: this task
       sits on a lead its assignee cannot see, so the lead scope refuses them
       too — and the Tasks list would hide it from them for the same reason.
       report.team is what reaches across that. */
    await req(`/api/tasks/${made.id}`, {
      method: 'PATCH', token: T.admin, expect: 200, body: { priority: 'Low' },
    });
  });

  await check('a supervisor may still act on a task in their team', async () => {
    // The rule is ownership OR report.team, not ownership alone — closing the
    // hole must not take the queue away from the people who manage it.
    const { data: any } = await req('/api/tasks?all=true&limit=1', { token: T.sales_supervisor, expect: 200 });
    if (!any.length) return;
    await req(`/api/tasks/${any[0].id}`, {
      method: 'PATCH', token: T.sales_supervisor, expect: 200, body: { priority: any[0].priority },
    });
  });

  await check('searching cases never shows more of them than the queue does', async () => {
    /* This one was not hypothetical. `tickets` carries a sales_org column, so
       the generic scope in advanced search found one and applied the book
       boundary — which made the gap look handled while every role rule was
       absent. Measured before the fix: a dealer who could open one case in the
       queue read all twelve in the business through the search box, and a
       caller three of twelve. */
    let compared = 0;
    for (const who of ['dealer', 'caller', 'product_rm', 'customer_care']) {
      const token = T[who];
      if (!token) continue;
      compared += 1;
      // eslint-disable-next-line no-await-in-loop
      const { data: queue } = await req('/api/tickets?limit=500', { token, expect: 200 });
      // eslint-disable-next-line no-await-in-loop
      const { data: found } = await req('/api/search-advanced/case', {
        method: 'POST', token, expect: 200, body: { where: null },
      });
      eq(found.total, queue.length, `${who}: search and the queue disagree about how many cases exist`);
    }
    /* A loop that skips every role is a test that proves nothing while
       reporting success — the shape of two mistakes already made in this
       suite. */
    eq(compared, 4, 'the roles this test exists to compare were not signed in');
  });

  await check('a merged case leaves the queue and the search together', async () => {
    /* The queue has always excluded merged cases and the search never did,
       which is why the two disagreed by exactly one row for every role. Merged
       here through the API rather than read out of the seed, so this exercises
       the path that creates the condition. */
    const { data: meta } = await req('/api/meta', { token: T.admin, expect: 200 });
    const category = meta.ticket_categories[0];
    const make = async (subject) => {
      const { data } = await req('/api/tickets', {
        method: 'POST', token: T.admin, expect: 201,
        body: { subject, description: subject, priority: 'Low', category_id: category.id, lead_id: REF.leadId },
      });
      return data.id;
    };

    const keep = await make(`Merge target ${RUN}`);
    const fold = await make(`Merge source ${RUN}`);

    const before = await req('/api/tickets?limit=500', { token: T.admin, expect: 200 });
    await req(`/api/tickets/${fold}/merge`, {
      method: 'POST', token: T.admin, expect: 200, body: { into_id: keep },
    });

    const { data: queue } = await req('/api/tickets?limit=500', { token: T.admin, expect: 200 });
    assert(!queue.some((t) => t.id === fold), 'a merged case is still in the queue');
    eq(queue.length, before.data.length - 1, 'the queue did not shrink by exactly the merged case');

    const { data: found } = await req('/api/search-advanced/case', {
      method: 'POST', token: T.admin, expect: 200, body: { where: null },
    });
    eq(found.total, queue.length, 'search counts a case the queue does not');
  });

  await check('the queue reports its true size and pages through it', async () => {
    const { res, data } = await req('/api/tickets?limit=2&sort=ref&dir=asc', { token: T.admin, expect: 200 });
    assert(data.length <= 2, `limit ignored: got ${data.length}`);
    const total = Number(res.headers.get('x-total-count'));
    assert(total >= data.length, 'X-Total-Count missing or smaller than the page');

    const { data: next } = await req('/api/tickets?limit=2&offset=2&sort=ref&dir=asc', { token: T.admin, expect: 200 });
    const overlap = next.filter((t) => data.some((f) => f.id === t.id));
    eq(overlap.length, 0, 'the second page repeats rows from the first');
  });

  await check('a queue sorts without losing the order it should be worked in', async () => {
    const refs = (d) => d.map((t) => t.ref);
    const { data: asc } = await req('/api/tickets?sort=ref&dir=asc&limit=50', { token: T.admin, expect: 200 });
    const { data: desc } = await req('/api/tickets?sort=ref&dir=desc&limit=50', { token: T.admin, expect: 200 });
    eq(JSON.stringify(refs(asc)), JSON.stringify([...refs(asc)].sort()), 'ascending is not ascending');
    assert(refs(asc)[0] !== refs(desc)[0], 'both directions returned the same order');

    /* Breached first, then priority, is the order a desk works. It has to
       survive being the default rather than becoming one sort among many. */
    const { data: def } = await req('/api/tickets?limit=50', { token: T.admin, expect: 200 });
    const firstUnbreached = def.findIndex((t) => !t.breached);
    const lastBreached = def.map((t) => Boolean(t.breached)).lastIndexOf(true);
    if (firstUnbreached !== -1 && lastBreached !== -1) {
      assert(lastBreached < firstUnbreached, 'a breached case sorted below an unbreached one by default');
    }
  });

  await check('an invented sort column is ignored, not run', async () => {
    const { data } = await req('/api/tickets?sort=(SELECT 1)&limit=5', { token: T.admin, expect: 200 });
    assert(Array.isArray(data), 'a bad sort broke the queue instead of being ignored');
  });

  await check('the queue can be searched by reference, subject or who it is for', async () => {
    const { data: all } = await req('/api/tickets?limit=500', { token: T.admin, expect: 200 });
    const target = all[0];
    const { data: hit } = await req(`/api/tickets?q=${encodeURIComponent(target.ref)}&limit=50`, { token: T.admin, expect: 200 });
    assert(hit.some((t) => t.id === target.id), 'a case could not be found by its own reference');
    assert(hit.length < all.length, 'the search matched everything');
  });

  await check('cases can be exported, masked, filtered and scoped', async () => {
    const { data } = await req('/api/tickets/export', {
      method: 'POST', token: T.admin, expect: 200,
      body: { columns: ['ref', 'subject', 'lead_mobile'] },
    });
    assert(data.csv.startsWith('"Ref","Subject","Mobile"'), `unexpected header: ${data.csv.slice(0, 60)}`);
    assert(/"\*{6}\d{4}"/.test(data.csv), 'a mobile left the export in the clear');
    eq(data.unmasked, false, 'an export unmasked without being asked to');

    // The export takes the queue's filter, so what leaves is what was on screen.
    const { data: breached } = await req('/api/tickets/export?breached=true', {
      method: 'POST', token: T.admin, expect: 200, body: { columns: ['ref'] },
    });
    assert(breached.rows <= data.rows, 'a filtered export returned more rows than an unfiltered one');

    // And the caller's own scope, not just the filter.
    const { data: queue } = await req('/api/tickets?limit=500', { token: T.sales_supervisor, expect: 200 });
    const { data: theirs } = await req('/api/tickets/export', {
      method: 'POST', token: T.sales_supervisor, expect: 200, body: { columns: ['ref'] },
    });
    eq(theirs.rows, queue.length, 'an export carried cases the exporter cannot open');
  });

  await check('exporting the queue is a permission', async () => {
    await req('/api/tickets/export', {
      method: 'POST', token: T.dealer, expect: 403, body: { columns: ['ref'] },
    });
  });

  await check('a ticket is created with a reference and SLA deadlines', async () => {
    const { data: meta } = await req('/api/meta', { token: T.sales_rm, expect: 200 });
    const category = meta.ticket_categories[0];

    const { data } = await req('/api/tickets', {
      method: 'POST', token: T.sales_rm, expect: 201,
      body: {
        subject: 'E2E — SIP debit failed', description: 'Mandate not registered.',
        priority: 'High', category_id: category.id, lead_id: REF.leadId, card_id: REF.mfCardId,
      },
    });
    REF.ticketId = data.id;
    assert(/^BNZ-\d{5}$/.test(data.ref), `bad ticket ref: ${data.ref}`);
    assert(data.response_due, 'response_due not stamped');
    assert(data.resolution_due, 'resolution_due not stamped');
    assert(data.assignee_id, 'ticket not auto-assigned');
  });

  await check('the AI 2-line summary is generated on creation', async () => {
    const { data } = await req(`/api/tickets/${REF.ticketId}`, { token: T.customer_care, expect: 200 });
    assert(data.ai_summary, 'no AI summary');
    eq(data.ai_summary.split('\n').length, 2, 'AI summary should be exactly two lines');
  });

  await check('a ticket event mirrors onto the lead activity feed', async () => {
    const { data } = await req(`/api/activities?lead_id=${REF.leadId}`, { token: T.sales_rm, expect: 200 });
    assert(data.some((a) => a.type === 'Ticket Event'), 'no ticket event on the lead');
  });

  await check('an agent reply is recorded and refreshes the summary', async () => {
    await req(`/api/tickets/${REF.ticketId}/replies`, {
      method: 'POST', token: T.customer_care, expect: 201,
      body: { body: 'We have raised this with operations.' },
    });
    const { data } = await req(`/api/tickets/${REF.ticketId}`, { token: T.customer_care, expect: 200 });
    assert(data.replies.length >= 1, 'reply not stored');
    assert(data.first_response_at, 'first_response_at not stamped');
  });

  await check('moving to Waiting on Client pauses the SLA clock', async () => {
    await req(`/api/tickets/${REF.ticketId}`, {
      method: 'PATCH', token: T.customer_care, expect: 200, body: { status: 'Waiting on Client' },
    });
    const { data } = await req(`/api/tickets/${REF.ticketId}`, { token: T.customer_care, expect: 200 });
    eq(data.status, 'Waiting on Client', 'status');
    assert(data.sla_paused_at, 'SLA not paused');
  });

  await check('resuming from Waiting on Client pushes the deadline out', async () => {
    const { data: paused } = await req(`/api/tickets/${REF.ticketId}`, { token: T.customer_care, expect: 200 });
    const before = paused.resolution_due;
    await req(`/api/tickets/${REF.ticketId}`, {
      method: 'PATCH', token: T.customer_care, expect: 200, body: { status: 'Open' },
    });
    const { data } = await req(`/api/tickets/${REF.ticketId}`, { token: T.customer_care, expect: 200 });
    assert(!data.sla_paused_at, 'SLA still marked paused');
    assert(data.resolution_due >= before, 'resolution deadline moved backwards');
  });

  await check('a caller cannot reassign a ticket', async () => {
    await req(`/api/tickets/${REF.ticketId}`, {
      method: 'PATCH', token: T.caller, expect: 403, body: { assignee_id: 1 },
    });
  });

  await check('escalation moves the ticket up the hierarchy', async () => {
    const { data } = await req(`/api/tickets/${REF.ticketId}/escalate`, {
      method: 'POST', token: T.customer_care, expect: 200, body: { reason: 'e2e escalation' },
    });
    assert(data.escalated_to, 'no escalation target');
  });

  await check('two tickets can be merged', async () => {
    const { data: dupe } = await req('/api/tickets', {
      method: 'POST', token: T.sales_rm, expect: 201,
      body: { subject: 'E2E duplicate', priority: 'Low', lead_id: REF.leadId },
    });
    const { data } = await req(`/api/tickets/${dupe.id}/merge`, {
      method: 'POST', token: T.customer_care, expect: 200, body: { into_id: REF.ticketId },
    });
    eq(data.merged, true, 'merge flag');

    const { data: target } = await req(`/api/tickets/${REF.ticketId}`, { token: T.customer_care, expect: 200 });
    assert(target.merged.length >= 1, 'merged ticket not linked to target');
  });

  await check('CSAT outside 1–5 is rejected', async () => {
    await req(`/api/tickets/${REF.ticketId}/csat`, { method: 'POST', token: T.customer_care, expect: 400, body: { score: 9 } });
  });

  await check('CSAT within range is stored', async () => {
    await req(`/api/tickets/${REF.ticketId}/csat`, { method: 'POST', token: T.customer_care, expect: 200, body: { score: 5 } });
    const { data } = await req(`/api/tickets/${REF.ticketId}`, { token: T.customer_care, expect: 200 });
    eq(data.csat, 5, 'csat');
  });

  await check('the SLA sweep runs and reports', async () => {
    const { data } = await req('/api/tickets/sweep', { method: 'POST', token: T.customer_care, expect: 200 });
    assert('checked' in data && 'breached' in data, 'sweep result shape');
  });

  await check('ticket reporting aggregates by category and agent', async () => {
    const { data } = await req('/api/tickets/reports/summary', { token: T.sales_supervisor, expect: 200 });
    assert(Array.isArray(data.by_category), 'by_category missing');
    assert(Array.isArray(data.by_agent), 'by_agent missing');
    assert('open' in data.totals, 'totals.open missing');
  });

  /* ---------------------------------------------------------- 10. partners */
  suite('10 partner lifecycle');

  await check('the partner list is bounded, counted, sorted and searchable', async () => {
    /* It had no LIMIT at all: the whole book came back on every call, with no
       count and nothing to order it by but the day each partner was added. */
    const { res, data } = await req('/api/partners?limit=2&sort=name&dir=asc', { token: T.admin, expect: 200 });
    assert(data.length <= 2, `limit ignored: got ${data.length}`);
    const total = Number(res.headers.get('x-total-count'));
    assert(total >= data.length, 'X-Total-Count missing or smaller than the page');

    const { data: page2 } = await req('/api/partners?limit=2&offset=2&sort=name&dir=asc', { token: T.admin, expect: 200 });
    eq(page2.filter((p) => data.some((f) => f.id === p.id)).length, 0, 'the second page repeats the first');

    const { data: desc } = await req('/api/partners?limit=2&sort=name&dir=desc', { token: T.admin, expect: 200 });
    assert(data[0].name !== desc[0].name, 'both sort directions returned the same order');

    const { data: hit } = await req(`/api/partners?q=${encodeURIComponent(data[0].name.split(' ')[0])}`, { token: T.admin, expect: 200 });
    assert(hit.length >= 1 && hit.length <= total, 'search returned an impossible count');
  });

  await check('the tiles count the book, not the page', async () => {
    /* The Partners tab used to make its two groups by pulling every partner and
       splitting the array in the browser, and its four tiles were sums over
       that same array. Honest only while the list was unbounded; the moment it
       started paging, both would have described a page. */
    const { data: summary } = await req('/api/partners/summary', { token: T.admin, expect: 200 });
    const { res: pipeline } = await req('/api/partners?group=pipeline&limit=1', { token: T.admin, expect: 200 });
    eq(Number(pipeline.headers.get('x-total-count')), summary.pipeline,
      'the pipeline tile and the pipeline tab disagree');

    // A page of one must not change what the tile says.
    const { data: summaryAgain } = await req('/api/partners/summary?limit=1', { token: T.admin, expect: 200 });
    eq(summaryAgain.pipeline, summary.pipeline, 'the summary followed the page size');
  });

  await check('a partner group is a server-side set, not a browser filter', async () => {
    const { data: pipeline } = await req('/api/partners?group=pipeline&limit=500', { token: T.admin, expect: 200 });
    const { data: active } = await req('/api/partners?group=active&limit=500', { token: T.admin, expect: 200 });
    const pipelineStates = new Set(pipeline.map((p) => p.state_code));
    for (const st of pipelineStates) {
      assert(['PROSPECT', 'QUALIFYING', 'ONBOARDING'].includes(st), );
    }
    eq(active.filter((p) => pipeline.some((q) => q.id === p.id)).length, 0, 'the two groups overlap');
  });

  await check('an invented partner sort column is ignored, not run', async () => {
    const { data } = await req('/api/partners?sort=(SELECT 1)&limit=3', { token: T.admin, expect: 200 });
    assert(Array.isArray(data), 'a bad sort broke the list instead of being ignored');
  });

  await check('partners export masked, scoped, and never the encrypted fields', async () => {
    const { data } = await req('/api/partners/export', {
      method: 'POST', token: T.admin, expect: 200,
      body: { columns: ['partner_code', 'name', 'mobile'] },
    });
    assert(data.csv.startsWith('"Code","Name","Mobile"'), `unexpected header: ${data.csv.slice(0, 60)}`);
    assert(/"\*{6}\d{4}"/.test(data.csv), 'a mobile left the export in the clear');
    eq(data.unmasked, false, 'an export unmasked without being asked to');

    /* PAN and bank account are encrypted at rest, so an export of them would
       ship ciphertext. They are not offered, and naming them leaves nothing to
       export rather than quietly exporting something useless. */
    const { data: refused } = await req('/api/partners/export', {
      method: 'POST', token: T.admin, expect: 400,
      body: { columns: ['pan', 'bank_account'] },
    });
    assert(/at least one column/i.test(refused.error), `unexpected refusal: ${refused.error}`);

    // Seeing partners and extracting them are different acts.
    await req('/api/partners/export', {
      method: 'POST', token: T.caller, expect: 403, body: { columns: ['name'] },
    });
  });

  await check('the campaign list is bounded, counted, sorted and searchable', async () => {
    const { res, data } = await req('/api/admin/campaigns?limit=2&sort=name&dir=asc', { token: T.admin, expect: 200 });
    assert(data.length <= 2, `limit ignored: got ${data.length}`);
    const total = Number(res.headers.get('x-total-count'));
    assert(total >= data.length, 'X-Total-Count missing or smaller than the page');

    const { data: desc } = await req('/api/admin/campaigns?limit=2&sort=name&dir=desc', { token: T.admin, expect: 200 });
    assert(data[0].name !== desc[0].name, 'both sort directions returned the same order');

    const { data: hit } = await req(`/api/admin/campaigns?q=${encodeURIComponent(data[0].name.slice(0, 6))}`, { token: T.admin, expect: 200 });
    assert(hit.length >= 1, 'a campaign could not be found by its own name');
  });

  await check('a partner prospect is created with onboarding steps and LMS modules', async () => {
    const { data } = await req('/api/partners', {
      method: 'POST', token: T.partner_rm, expect: 201,
      body: { name: 'E2E Partner', business_name: 'E2E Securities', partner_model: 'Remisier',
        mobile: mob(2), email: mail('partner'), city: 'Pune', commission_pct: 30 },
    });
    REF.partnerId = data.id;
    eq(data.state_code, 'PROSPECT', 'initial partner state');
    assert(data.steps_total > 0, 'no onboarding steps created');
  });

  await check('elevation is refused while onboarding steps are pending', async () => {
    const { data } = await req(`/api/partners/${REF.partnerId}/request-elevation`, {
      method: 'POST', token: T.partner_rm, expect: 400,
    });
    assert(data.pending > 0, 'pending step count not reported');
  });

  await check('completing every onboarding step advances the partner', async () => {
    const { data: partner } = await req(`/api/partners/${REF.partnerId}`, { token: T.partner_rm, expect: 200 });
    for (const step of partner.steps) {
      await req(`/api/partners/${REF.partnerId}/steps/${step.code}`, { method: 'POST', token: T.partner_rm, expect: 200 });
    }
    const { data } = await req(`/api/partners/${REF.partnerId}`, { token: T.partner_rm, expect: 200 });
    eq(data.steps_done, data.steps_total, 'all steps complete');
  });

  await check('a Partner RM cannot elevate on their own', async () => {
    await req(`/api/partners/${REF.partnerId}/elevate`, { method: 'POST', token: T.partner_rm, expect: 403 });
  });

  await check('Admin elevation issues a partner code and portal credential', async () => {
    const { data } = await req(`/api/partners/${REF.partnerId}/elevate`, {
      method: 'POST', token: T.admin, expect: 200, body: { portal_password: 'e2epass' },
    });
    eq(data.elevated, true, 'elevated');
    assert(/^BNZ-P\d{4}$/.test(data.partner_code), `bad partner code: ${data.partner_code}`);
    REF.partnerLogin = data.portal_login;
  });

  await check('an elevated partner is ACTIVE', async () => {
    const { data } = await req(`/api/partners/${REF.partnerId}`, { token: T.partner_rm, expect: 200 });
    eq(data.state_code, 'ACTIVE', 'partner state after elevation');
    eq(data.has_portal_login, true, 'portal login not issued');
  });

  await check('AI partner health insight returns a graded assessment', async () => {
    const { data } = await req(`/api/partners/${REF.partnerId}/insight`, { token: T.partner_rm, expect: 200 });
    assert(['Strong', 'Steady', 'Needs attention', 'At risk'].includes(data.health), `bad health: ${data.health}`);
    assert(Array.isArray(data.concerns), 'concerns missing');
  });

  /* ----------------------------------------------------- 11. partner portal */
  suite('11 partner portal (separate surface)');

  await check('a partner signs in on the portal', async () => {
    const { data } = await req('/api/auth/partner-login', {
      method: 'POST', expect: 200,
      body: { email: REF.partnerLogin.email, password: REF.partnerLogin.password },
    });
    REF.portalToken = data.token;
    eq(data.partner.state, 'ACTIVE', 'partner state');
  });

  await check('a suspended partner is refused at sign-in', async () => {
    await req('/api/auth/partner-login', {
      method: 'POST', expect: 403, body: { email: 'mohammed@partner.test', password: 'partner' },
    });
  });

  await check('a partner token cannot reach CRM endpoints', async () => {
    await req('/api/leads', { token: REF.portalToken, expect: 401 });
    await req('/api/admin/users', { token: REF.portalToken, expect: 401 });
  });

  await check('a CRM token cannot reach portal endpoints', async () => {
    await req('/api/portal/dashboard', { token: T.admin, expect: 401 });
  });

  await check('the portal dashboard is scoped to that partner', async () => {
    const { data } = await req('/api/portal/dashboard', { token: REF.portalToken, expect: 200 });
    eq(data.partner.id, REF.partnerId, 'dashboard partner id');
    assert('leads_sourced' in data.metrics, 'metrics missing');
    assert(Array.isArray(data.sourced_leads), 'sourced_leads missing');
    assert(data.sourced_leads.every((l) => !('mobile' in l)), 'portal leaked client mobile numbers');
  });

  await check('a portal referral creates an attributed CRM lead', async () => {
    const { data } = await req('/api/portal/referrals', {
      method: 'POST', token: REF.portalToken, expect: 201,
      body: { name: 'E2E Referral', mobile: mob(3), city: 'Pune', note: 'e2e referral' },
    });
    REF.referralLeadId = data.lead_id;

    const { data: lead } = await req(`/api/leads/${data.lead_id}`, { token: T.admin, expect: 200 });
    eq(lead.partner_id, REF.partnerId, 'referral not attributed to the partner');
    includes(lead.source, 'Partner referral', 'referral source');
  });

  await check('a referral with an invalid mobile is rejected', async () => {
    await req('/api/portal/referrals', {
      method: 'POST', token: REF.portalToken, expect: 400, body: { name: 'Bad', mobile: '123' },
    });
  });

  await check('a duplicate referral is rejected with 409', async () => {
    await req('/api/portal/referrals', {
      method: 'POST', token: REF.portalToken, expect: 409, body: { name: 'Dup', mobile: mob(3) },
    });
  });

  await check('a partner raises a support ticket that lands in the CRM queue', async () => {
    const { data } = await req('/api/portal/tickets', {
      method: 'POST', token: REF.portalToken, expect: 201,
      body: { subject: 'E2E partner query', description: 'Commission mismatch', priority: 'Medium' },
    });
    REF.partnerTicketId = data.id;

    const { data: crmView } = await req(`/api/tickets/${data.id}`, { token: T.customer_care, expect: 200 });
    eq(crmView.partner_id, REF.partnerId, 'ticket not linked to the partner');
    eq(crmView.channel, 'Portal', 'ticket channel');
  });

  await check('a partner reply re-opens a resolved ticket', async () => {
    await req(`/api/tickets/${REF.partnerTicketId}`, {
      method: 'PATCH', token: T.customer_care, expect: 200, body: { status: 'Resolved' },
    });
    await req(`/api/portal/tickets/${REF.partnerTicketId}/replies`, {
      method: 'POST', token: REF.portalToken, expect: 201, body: { body: 'Still not resolved.' },
    });
    const { data } = await req(`/api/tickets/${REF.partnerTicketId}`, { token: T.customer_care, expect: 200 });
    eq(data.status, 'Open', 'ticket did not re-open on partner reply');
  });

  await check('a partner cannot read another partner\'s ticket', async () => {
    await req(`/api/portal/tickets/${REF.ticketId}`, { token: REF.portalToken, expect: 404 });
  });

  /* ------------------------------------------------------------- 12. DKYC */
  suite('12 DKYC portal (public, 16-step)');

  await check('the public product list is reachable without a session', async () => {
    const { data } = await req('/dkyc-api/products', { expect: 200 });
    assert(data.length > 0, 'no products offered');
    REF.eqdProduct = data.find((p) => p.code === 'EQD');
    assert(REF.eqdProduct, 'Equity & Derivatives not offered');
  });

  await check('starting an application returns a resume token', async () => {
    const { data } = await req('/dkyc-api/start', {
      method: 'POST', expect: 201,
      body: { product_type_id: REF.eqdProduct.id, mobile: mob(4) },
    });
    REF.dkycToken = data.resume_token;
    eq(data.journey.status, 'In Progress', 'journey status');
    eq(data.journey.current_step, 'MOBILE', 'first step');
    assert(data.journey.steps_total >= 12, 'unexpectedly short journey');
  });

  await check('a journey can be resumed from its token', async () => {
    const { data } = await req(`/dkyc-api/resume/${REF.dkycToken}`, { expect: 200 });
    eq(data.current_step, 'MOBILE', 'resumed step');
  });

  await check('an unknown resume token returns 404', async () => {
    await req('/dkyc-api/resume/not-a-real-token', { expect: 404 });
  });

  const dkycStep = (step_code, payload) =>
    req(`/dkyc-api/resume/${REF.dkycToken}/step`, { method: 'POST', body: { step_code, payload } });

  await check('submitting a step out of order is rejected with 409', async () => {
    const { status, data } = await dkycStep('ESIGN', { esign_otp: '123456' });
    eq(status, 409, 'out-of-order status');
    eq(data.current_step, 'MOBILE', 'reported current step');
  });

  await check('a wrong OTP is rejected', async () => {
    await dkycStep('MOBILE', { mobile: mob(4) });
    const { status } = await dkycStep('MOBILE_OTP', { otp: '000000' });
    eq(status, 400, 'wrong OTP status');
  });

  await check('the correct OTP advances the journey', async () => {
    const { status, data } = await dkycStep('MOBILE_OTP', { otp: '123456' });
    eq(status, 200, 'otp status');
    eq(data.next_step, 'EMAIL', 'next step after mobile OTP');
  });

  await check('penny-drop failure routes to the bank-proof step', async () => {
    await dkycStep('EMAIL', { email: mail('dkyc') });
    await dkycStep('EMAIL_OTP', { email_otp: '123456' });
    await dkycStep('PAN', { pan: 'ABCDE1234F', dob: '1990-01-01' });
    await dkycStep('AADHAAR_DIGILOCKER', { digilocker_consent: true });
    await dkycStep('PERSONAL', {
      gender: 'Male', marital_status: 'Single', father_spouse: 'Test',
      address: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
    });
    await dkycStep('FINANCIAL', {
      trading_experience: 'None', education: 'Graduate', occupation: 'Business',
      annual_income: '₹10–25 Lakh', politically_exposed: 'No',
    });

    // Odd trailing digit forces the simulated penny drop to fail.
    const { status, data } = await dkycStep('BANK', {
      account_number: '123456789', ifsc: 'HDFC0001234', account_holder: 'Test User',
    });
    eq(status, 200, 'bank step status');
    eq(data.penny_drop_failed, true, 'penny drop should have failed');
    eq(data.next_step, 'BANK_PROOF', 'did not route to bank proof');
  });

  await check('high income plus F&O triggers the conditional income-proof step', async () => {
    await dkycStep('BANK_PROOF', { bank_proof: 'cheque.jpg' });
    await dkycStep('NOMINEE', { nominee_opt: 'Opt out' });
    const { data } = await dkycStep('SEGMENTS', {
      segments: ['Equity Cash', 'Equity Derivatives (F&O)'], depository: 'CDSL', plan: 'Bigul Flat ₹0 Delivery',
    });
    eq(data.next_step, 'INCOME_PROOF', 'income proof not triggered');
  });

  await check('completing eSign finishes the journey', async () => {
    await dkycStep('INCOME_PROOF', { income_proof: 'itr.pdf' });
    await dkycStep('SELFIE', { selfie: 'selfie.jpg' });
    await dkycStep('SIGNATURE', { signature: 'sign.jpg' });
    const { status, data } = await dkycStep('ESIGN', { esign_otp: '123456' });
    eq(status, 200, 'esign status');
    eq(data.done, true, 'journey not marked done');
    eq(data.journey.status, 'Complete', 'journey status');
    eq(data.journey.progress_pct, 100, 'progress');
  });

  await check('completing the journey creates an attributed CRM lead', async () => {
    const { data } = await req(`/api/leads?q=${mob(4)}`, { token: T.admin, expect: 200 });
    assert(data.length === 1, `expected 1 lead from DKYC, got ${data.length}`);
    eq(data[0].source, 'DKYC Portal', 'lead source');
    eq(data[0].kyc_status, 'Complete', 'kyc status');
    REF.dkycLeadId = data[0].id;
  });

  await check('the matching product card is set Active on completion', async () => {
    const { data } = await req(`/api/leads/${REF.dkycLeadId}`, { token: T.admin, expect: 200 });
    const card = data.cards.find((c) => c.product_type_id === REF.eqdProduct.id);
    eq(card.state, 'ACTIVE', 'EQD card state after KYC');
  });

  await check('a completed journey rejects further step submissions', async () => {
    const { status } = await dkycStep('ESIGN', { esign_otp: '123456' });
    assert(status === 409 || status === 400, `expected rejection, got ${status}`);
  });

  /* -------------------------------------------------- 13. KYC console */
  suite('13 KYC engine (internal)');

  await check('KYC health lists journeys with progress', async () => {
    const { data } = await req('/api/kyc/health', { token: T.product_supervisor, expect: 200 });
    assert(data.length > 0, 'no journeys');
    assert(data.every((j) => 'progress_pct' in j), 'progress not computed');
  });

  await check('the seeded stalled and abandoned journeys are present', async () => {
    const { data } = await req('/api/kyc/health', { token: T.product_supervisor, expect: 200 });

    // These two fixtures come from the seed, because a journey only becomes
    // Abandoned after an hour on one step — not something a test can wait for.
    // The takeover test below consumes the Abandoned one, so the suite must run
    // against a freshly seeded database. `npm test` does that; `npm run
    // test:only` deliberately does not, and will land here on a second pass.
    const stalled = data.find((j) => j.status === 'Stalled');
    const abandoned = data.find((j) => j.status === 'Abandoned');
    assert(stalled || abandoned, RESEED);
    assert(stalled, `no stalled journey in the reference data. ${RESEED}`);
    assert(abandoned, `no abandoned journey in the reference data. ${RESEED}`);

    // Either state means "self-service has failed and a human must step in".
    REF.abandonedJourney = abandoned || stalled;
  });

  await check('journey detail exposes the step rail', async () => {
    const { data } = await req(`/api/kyc/journeys/${need(REF.abandonedJourney, 'the abandoned KYC journey').id}`, { token: T.product_rm, expect: 200 });
    assert(Array.isArray(data.steps) && data.steps.length > 0, 'no steps');
    assert(data.steps.every((s) => 'status' in s && 'timer_s' in s || 'timer' in s), 'step shape');
  });

  await check('AI stall coaching returns a cause and a line to say', async () => {
    const { data } = await req(`/api/kyc/journeys/${need(REF.abandonedJourney, 'the abandoned KYC journey').id}/coach`, { token: T.product_rm, expect: 200 });
    assert(data.likely_cause, 'no likely_cause');
    assert(data.what_to_say, 'no what_to_say');
  });

  await check('a Product RM can take over an abandoned journey', async () => {
    const { data } = await req(`/api/kyc/journeys/${need(REF.abandonedJourney, 'the abandoned KYC journey').id}/assist`, {
      method: 'POST', token: T.product_rm, expect: 200,
    });
    eq(data.status, 'In Progress', 'status after takeover');
    assert(data.assisted_by, 'assisted_by not recorded');
  });

  await check('only a Product Supervisor can override a step', async () => {
    await req(`/api/kyc/journeys/${need(REF.abandonedJourney, 'the abandoned KYC journey').id}/override`, {
      method: 'POST', token: T.product_rm, expect: 403, body: { step_code: 'PAN', action: 'complete' },
    });
    await req(`/api/kyc/journeys/${need(REF.abandonedJourney, 'the abandoned KYC journey').id}/override`, {
      method: 'POST', token: T.product_supervisor, expect: 200, body: { step_code: 'PAN', action: 'complete' },
    });
  });

  await check('the stall sweep runs and reports', async () => {
    const { data } = await req('/api/kyc/sweep', { method: 'POST', token: T.product_supervisor, expect: 200 });
    assert('checked' in data, 'sweep result shape');
  });

  /* ------------------------------------------------------------- 14. AI */
  suite('14 AI layer');

  await check('AI status reports the provider and capability list', async () => {
    const { data } = await req('/api/ai/status', { token: T.sales_rm, expect: 200 });
    assert(data.provider, 'no provider reported');
    eq(data.capabilities.length, 6, 'capability count');
  });

  await check('disposition requires a transcript', async () => {
    await req('/api/ai/disposition', {
      method: 'POST', token: T.caller, expect: 400, body: { lead_id: REF.leadId, transcript: '' },
    });
  });

  await check('disposition returns a complete, schema-shaped proposal', async () => {
    const { data } = await req('/api/ai/disposition', {
      method: 'POST', token: T.sales_rm, expect: 200,
      body: {
        lead_id: REF.leadId, duration_s: 240,
        transcript: 'Client asked about starting a SIP in mutual funds at 5000 per month. Said go ahead and send the account opening link, he is ready to start this month.',
      },
    });
    for (const key of ['outcome', 'summary', 'card_changes', 'next_action', 'compliance_flag', 'score_signal']) {
      assert(key in data, `disposition missing ${key}`);
    }
    assert(Array.isArray(data.cards), 'current card states not returned for the confirm screen');
    REF.disposition = data;
  });

  await check('a compliance mention is flagged and raises a ticket on confirm', async () => {
    const { data: proposal } = await req('/api/ai/disposition', {
      method: 'POST', token: T.sales_rm, expect: 200,
      body: {
        lead_id: REF.leadId, duration_s: 180,
        transcript: 'The client says he will complain to SEBI if the payout is not credited today. He is very unhappy.',
      },
    });
    assert(proposal.compliance_flag !== 'None', `expected a compliance flag, got ${proposal.compliance_flag}`);

    const { data } = await req('/api/ai/disposition/confirm', {
      method: 'POST', token: T.sales_rm, expect: 200, body: { ...proposal, lead_id: REF.leadId },
    });
    assert(data.compliance_ticket_id, 'no compliance ticket raised');
    REF.complianceTicketId = data.compliance_ticket_id;
  });

  await check('the compliance ticket is High priority and assigned', async () => {
    const { data } = await req(`/api/tickets/${REF.complianceTicketId}`, { token: T.customer_care, expect: 200 });
    eq(data.priority, 'High', 'compliance ticket priority');
    assert(data.assignee_id, 'compliance ticket unassigned');
  });

  await check('confirming refuses card changes the role may not make', async () => {
    // A Caller confirming a proposed WARM transition must have that one change refused.
    const { data } = await req('/api/ai/disposition/confirm', {
      method: 'POST', token: T.caller, expect: 200,
      body: {
        lead_id: REF.leadId, outcome: 'Connected — Interested', summary: 'e2e role check',
        card_changes: [{ product_code: 'MF', from_state: 'WARM', to_state: 'WARM', evidence: 'e2e' }],
        next_action: 'No Action', next_action_due_hours: 4, follow_up_task: '',
        compliance_flag: 'None', compliance_note: '', score_signal: 0,
      },
    });
    eq(data.cards_refused.length, 1, 'the Warm change should have been refused for a Caller');
    includes(data.cards_refused[0].reason, 'cannot set', 'refusal reason');
  });

  await check('next-best-action puts an open complaint ahead of sales activity', async () => {
    const { data } = await req(`/api/ai/leads/${REF.leadId}/next-action`, { token: T.sales_rm, expect: 200 });
    for (const key of ['action', 'channel', 'urgency', 'reason', 'talking_point']) {
      assert(key in data, `next-action missing ${key}`);
    }
  });

  await check('the copilot answers and reports what it was grounded in', async () => {
    const { data } = await req('/api/ai/copilot', {
      method: 'POST', token: T.sales_rm, expect: 200, body: { question: 'who should I call today?' },
    });
    assert(data.reply && data.reply.length > 10, 'empty copilot reply');
    assert('leads' in data.grounded_in, 'grounding not reported');
  });

  await check('the copilot is scoped — a Caller sees fewer leads than an Admin', async () => {
    const { data: caller } = await req('/api/ai/copilot', {
      method: 'POST', token: T.caller, expect: 200, body: { question: 'how many leads do I have?' },
    });
    const { data: admin } = await req('/api/ai/copilot', {
      method: 'POST', token: T.admin, expect: 200, body: { question: 'how many leads do I have?' },
    });
    assert(caller.grounded_in.leads < admin.grounded_in.leads,
      `caller (${caller.grounded_in.leads}) should see fewer leads than admin (${admin.grounded_in.leads})`);
  });

  await check('an empty copilot question is rejected', async () => {
    await req('/api/ai/copilot', { method: 'POST', token: T.sales_rm, expect: 400, body: { question: '' } });
  });

  /* ------------------------------------------------------------ 15. rules */
  suite('15 automation rule builder');

  await check('the rule library exposes condition fields and action types', async () => {
    const { data } = await req('/api/admin/rules', { token: T.admin, expect: 200 });
    assert(data.condition_fields.length >= 10, 'condition field library too small');
    assert(data.action_types.length >= 5, 'action type library too small');
    assert(data.rules.length >= 1, 'no seeded rules');
    REF.ruleId = data.rules[0].id;
  });

  await check('a dry run reports matches without performing actions', async () => {
    const { data } = await req(`/api/admin/rules/${REF.ruleId}/run`, {
      method: 'POST', token: T.admin, expect: 200, body: { dry_run: true },
    });
    eq(data.dry_run, true, 'dry_run flag');
    assert('evaluated' in data && 'matched_count' in data, 'dry run result shape');
    for (const match of data.matched) {
      assert(match.actions.every((a) => a.simulated === true), 'a dry run performed a real action');
    }
  });

  await check('a rule can be created, enabled and disabled', async () => {
    const { data } = await req('/api/admin/rules', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        name: 'E2E rule', description: 'created by the test suite',
        conditions: [{ field: 'lead_age_days', op: 'gt', value: 3650 }],
        actions: [{ type: 'notify', params: { role_or_user: 'admin', message: 'e2e' } }],
      },
    });
    await req(`/api/admin/rules/${data.id}`, { method: 'PATCH', token: T.admin, expect: 200, body: { enabled: 1 } });
    await req(`/api/admin/rules/${data.id}`, { method: 'PATCH', token: T.admin, expect: 200, body: { enabled: 0 } });
  });

  await check('a rule without conditions is rejected', async () => {
    await req('/api/admin/rules', {
      method: 'POST', token: T.admin, expect: 400,
      body: { name: 'Bad rule', conditions: [], actions: [{ type: 'notify', params: {} }] },
    });
  });

  /* ------------------------------------------------------------ 16. admin */
  suite('16 administration');

  await check('the permission matrix is exposed for every role', async () => {
    const { data } = await req('/api/admin/roles', { token: T.admin, expect: 200 });
    eq(data.roles.length, 11, 'role count');
    assert(Object.keys(data.matrix).length > 20, 'permission matrix too small');
  });

  await check('a user can be created and disabled', async () => {
    const { data } = await req('/api/admin/users', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: 'E2E User', email: `e2euser.${RUN}@bonanza.test`, role: 'caller', password: 'bonanza' },
    });
    await req(`/api/admin/users/${data.id}`, { method: 'PATCH', token: T.admin, expect: 200, body: { active: 0 } });
  });

  await check('a duplicate email is rejected', async () => {
    await req('/api/admin/users', {
      method: 'POST', token: T.admin, expect: 409,
      body: { name: 'Dup', email: 'admin@bonanza.test', role: 'caller' },
    });
  });

  await check('an unknown role is rejected', async () => {
    await req('/api/admin/users', {
      method: 'POST', token: T.admin, expect: 400,
      body: { name: 'Bad role', email: 'badrole@bonanza.test', role: 'wizard' },
    });
  });

  await check('adding a product generates a card on every existing lead', async () => {
    const { data: before } = await req('/api/leads', { token: T.admin, expect: 200 });
    const { data } = await req('/api/admin/products', {
      method: 'POST', token: T.admin, expect: 201,
      body: { code: `E2E${RUN.slice(-4)}`, name: 'E2E Test Product', category: 'Investment', min_investment: 1000 },
    });
    assert(data.cards_generated >= before.length, `expected ≥${before.length} cards, got ${data.cards_generated}`);
    REF.e2eProductId = data.id;
    // Leave the environment as we found it.
    await req(`/api/admin/products/${data.id}`, { method: 'PATCH', token: T.admin, expect: 200, body: { active: 0 } });
  });

  await check('SLA policies are configured per product and priority', async () => {
    const { data } = await req('/api/admin/sla', { token: T.admin, expect: 200 });
    assert(data.policies.length > 0, 'no SLA policies');
    assert(data.defaults.Critical.response_mins === 15, 'critical default response');
  });

  await check('templates, content and campaigns are readable', async () => {
    const { data: templates } = await req('/api/admin/templates', { token: T.admin, expect: 200 });
    assert(templates.length > 0, 'no templates');
    const { data: content } = await req('/api/admin/content', { token: T.admin, expect: 200 });
    assert(content.length > 0, 'no content items');
    const { data: campaigns } = await req('/api/admin/campaigns', { token: T.marketing_manager, expect: 200 });
    assert(Array.isArray(campaigns), 'campaigns not returned');
  });

  await check('the integration registry reports every adapter', async () => {
    const { data } = await req('/api/admin/integrations', { token: T.admin, expect: 200 });
    assert(data.integrations.length >= 10, 'integration registry incomplete');
    assert(data.integrations.every((i) => i.contract), 'an adapter has no documented contract');
  });

  await check('the audit log records actions with an actor', async () => {
    const { data } = await req('/api/admin/audit', { token: T.admin, expect: 200 });
    assert(data.length > 0, 'audit log empty');
    assert(data.some((a) => a.action === 'card_state'), 'card state changes not audited');
  });

  /* ------------------------------------------------------ 17. lists/misc */
  suite('17 lists & notifications');

  await check('a lead list can be created and populated', async () => {
    const { data } = await req('/api/lists', {
      method: 'POST', token: T.marketing_manager, expect: 201,
      body: {
        name: 'E2E list', kind: 'static', shared_with: ['sales_rm'],
        // A snapshot has to say why it is one and when it stops being trusted.
        snapshot_reason: 'Fixed cohort for the end-to-end run',
        expires_at: '2030-01-01',
      },
    });
    REF.listId = data.id;
    const { data: added } = await req(`/api/lists/${REF.listId}/members`, {
      method: 'POST', token: T.marketing_manager, expect: 200, body: { lead_ids: [REF.leadId, REF.referralLeadId] },
    });
    eq(added.added, 2, 'members added');
  });

  await check('a shared list is visible to the recipient role', async () => {
    const { data } = await req('/api/lists', { token: T.sales_rm, expect: 200 });
    assert(data.some((l) => l.id === REF.listId), 'shared list not visible to sales_rm');
  });

  await check('notifications can be read and marked read', async () => {
    const { data } = await req('/api/notifications', { token: T.product_rm, expect: 200 });
    assert(Array.isArray(data), 'notifications not returned');
    await req('/api/notifications/read-all', { method: 'POST', token: T.product_rm, expect: 200 });
    const { data: after } = await req('/api/notifications', { token: T.product_rm, expect: 200 });
    assert(after.every((n) => n.read), 'notifications not marked read');
  });

  /* ------------------------------------------------------ 18. recycle bin */
  suite('18 recycle bin');

  await check('a deleted lead leaves the list but is recoverable', async () => {
    const { data: created } = await req('/api/leads', {
      method: 'POST', token: T.admin, expect: 201, body: { name: 'E2E Delete Me', mobile: mob(5) },
    });
    await req(`/api/leads/${created.id}`, { method: 'DELETE', token: T.admin, expect: 204 });

    const { data: list } = await req(`/api/leads?q=${mob(5)}`, { token: T.admin, expect: 200 });
    eq(list.length, 0, 'deleted lead still in the list');

    const { data: bin } = await req('/api/recycle-bin', { token: T.admin, expect: 200 });
    assert(bin.some((l) => l.id === created.id), 'lead not in the recycle bin');

    await req(`/api/leads/${created.id}/restore`, { method: 'POST', token: T.admin, expect: 200 });
    const { data: restored } = await req(`/api/leads?q=${mob(5)}`, { token: T.admin, expect: 200 });
    eq(restored.length, 1, 'lead not restored');
  });

  await check('a non-admin cannot delete a lead', async () => {
    await req(`/api/leads/${REF.leadId}`, { method: 'DELETE', token: T.sales_rm, expect: 403 });
  });

  /* ---------------------------------------------------------- 19. import */
  suite('19 lead import');

  await check('a dry-run import validates without committing', async () => {
    const { data } = await req('/api/leads/import', {
      method: 'POST', token: T.admin, expect: 200,
      body: {
        commit: false,
        rows: [
          { name: 'Import One', mobile: mob(6), city: 'Delhi' },
          { name: 'Import Bad', mobile: '123' },
          { name: '', mobile: mob(7) },
          { name: 'Import Dupe', mobile: mob(1) },
        ],
      },
    });
    eq(data.total, 4, 'row count');
    eq(data.valid, 1, 'valid count');
    eq(data.invalid.length, 2, 'invalid count');
    eq(data.duplicates.length, 1, 'duplicate count');
    eq(data.imported, 0, 'dry run must not import');
  });

  await check('a committed import creates the valid rows only', async () => {
    const { data } = await req('/api/leads/import', {
      method: 'POST', token: T.admin, expect: 200,
      body: { commit: true, rows: [{ name: 'Import One', mobile: mob(6), city: 'Delhi' }] },
    });
    eq(data.imported, 1, 'imported count');
    const { data: found } = await req(`/api/leads?q=${mob(6)}`, { token: T.admin, expect: 200 });
    eq(found.length, 1, 'imported lead not found');
    assert(found[0].cards.length > 0, 'imported lead has no product cards');
  });

  /* ---------------------------------------------------------- 20. security */
  suite('20 security & data protection');

  await check('client PII is masked in responses by default', async () => {
    const { data } = await req(`/api/leads/${REF.leadId}`, { token: T.sales_rm, expect: 200 });
    assert(String(data.mobile).includes('•'), `mobile not masked: ${data.mobile}`);
    eq(data._pii_masked, true, 'masking flag not set');
  });

  await check('a permitted role can unmask explicitly', async () => {
    const { data } = await req(`/api/leads/${REF.leadId}?unmask=true`, { token: T.sales_rm, expect: 200 });
    eq(data.mobile, mob(1), 'unmasked mobile');
    assert(!data._pii_masked, 'masking flag should be absent when unmasked');
  });

  await check('the cockpit masks PII — it is the most-viewed screen in the product', async () => {
    // Regression: /api/cockpit returned raw mobiles while /api/leads masked
    // them, so the first screen every user saw was the one leak in the system.
    for (const role of ['sales_rm', 'caller', 'sales_supervisor', 'customer_care']) {
      const { data } = await req('/api/cockpit', { token: T[role], expect: 200 });
      const rows = data.worklist?.rows ?? [];
      for (const r of rows) {
        if (r.mobile) {
          assert(String(r.mobile).includes('•'), `${role} cockpit exposed a mobile: ${r.mobile}`);
        }
        if (r.pan) assert(String(r.pan).includes('•'), `${role} cockpit exposed a PAN`);
      }
    }
  });

  await check('a permitted role can still unmask the cockpit explicitly', async () => {
    const { data } = await req('/api/cockpit?unmask=true', { token: T.sales_rm, expect: 200 });
    const withMobile = (data.worklist?.rows ?? []).find((r) => r.mobile);
    if (withMobile) assert(!String(withMobile.mobile).includes('•'), 'unmask had no effect on the cockpit');
  });

  await check('every unmask is written to the audit log', async () => {
    const { data } = await req('/api/admin/audit', { token: T.admin, expect: 200 });
    assert(data.some((a) => a.action === 'pii_unmasked'), 'unmask not audited');
  });

  await check('a role without pii.unmask stays masked even when asking', async () => {
    // A Caller is masked by default (ENH-16) and does not hold pii.unmask, so
    // asking for it changes nothing. Marketing used to be the subject here and
    // no longer is: the confirmed requirement gives that role clear values, so
    // it has nothing to unmask.
    const { data } = await req('/api/leads?unmask=true', { token: T.caller, expect: 200 });
    const withMobile = data.find((l) => l.mobile);
    assert(withMobile, 'no lead with a mobile to check');
    assert(String(withMobile.mobile).includes('•'), `a caller should not be able to unmask: ${withMobile.mobile}`);
  });

  await check('PAN is not recoverable from the raw database file', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bonanza.db');

    // Write a lead with a known PAN, then look for it in the file on disk.
    const pan = 'ZZTOP1234Z';
    await req('/api/leads', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: 'Encryption Probe', mobile: mob(9), pan },
    });
    const raw = readFileSync(dbPath).toString('latin1');
    assert(!raw.includes(pan), 'PAN found in plaintext in the database file — encryption at rest is not working');
  });

  await check('stored credentials are not recoverable from the database file', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bonanza.db');

    // Use a password that appears nowhere else, so a hit is unambiguous.
    const secret = `Zx9-${RUN}-QuetzalPassphrase`;
    await req('/api/admin/users', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: 'Crypto Probe', email: `crypto.${RUN}@bonanza.test`, role: 'caller', password: secret },
    });

    const raw = readFileSync(dbPath).toString('latin1');
    assert(!raw.includes(secret), 'a credential is stored in plaintext in the database file');
    assert(raw.includes('scrypt$'), 'no scrypt hashes present — hashing is not in effect');

    // And the credential still authenticates.
    const token = await login(`crypto.${RUN}@bonanza.test`, secret);
    assert(token, 'the hashed credential does not authenticate');
  });

  await check('signing out invalidates the token immediately', async () => {
    const token = await login('care2@bonanza.test');
    await req('/api/auth/me', { token, expect: 200 });
    await req('/api/auth/logout', { method: 'POST', token, expect: 200 });
    await req('/api/auth/me', { token, expect: 401 });
  });

  await check('a tampered token is rejected', async () => {
    await req('/api/leads', { token: 'not-a-real-token', expect: 401 });
  });

  await check('repeated failed logins are rate limited', async () => {
    const victim = 'ratelimit.probe@bonanza.test';
    let limited = false;
    for (let i = 0; i < 14; i += 1) {
      const { status } = await req('/api/auth/login', {
        method: 'POST', body: { email: victim, password: 'wrong' },
      });
      if (status === 429) { limited = true; break; }
    }
    assert(limited, 'brute-force attempts were never rate limited');
  });

  await check('the limiter is keyed per account, not per address', async () => {
    // The account limited above must not lock out a different account
    // from the same source address.
    const { status } = await req('/api/auth/login', {
      method: 'POST', body: { email: 'admin@bonanza.test', password: 'bonanza' },
    });
    eq(status, 200, 'a different account was collaterally locked out');
  });

  await check('invalid PAN and mobile formats are rejected', async () => {
    await req('/api/leads', {
      method: 'POST', token: T.admin, expect: 400,
      body: { name: 'Bad PAN', mobile: mob(0), pan: 'NOTAPAN' },
    });
    await req('/api/leads', {
      method: 'POST', token: T.admin, expect: 400,
      body: { name: 'Bad mobile', mobile: '1234567890' },
    });
  });

  /* ------------------------------------------------- 21. data residency */
  suite('21 AI data residency');

  await check('the residency policy is published by the running system', async () => {
    const { data } = await req('/api/ai/residency', { token: T.sales_rm, expect: 200 });
    eq(data.mode, 'hybrid', 'default residency mode');
    eq(data.capabilities.length, 6, 'capabilities classified');
    for (const c of data.capabilities) {
      assert(c.classification_reason, `${c.capability} has no stated reason`);
    }
  });

  await check('transcript and KYC reasoning never leave the country', async () => {
    const { data } = await req('/api/ai/residency', { token: T.admin, expect: 200 });
    for (const key of ['disposition', 'kycCoach']) {
      const cap = data.capabilities.find((c) => c.capability === key);
      eq(cap.data_class, 'CLASS_PII_RAW', `${key} data class`);
      eq(cap.leaves_india, false, `${key} must be processed in India`);
    }
  });

  await check('anything that does leave the country is de-identified first', async () => {
    const { data } = await req('/api/ai/residency', { token: T.admin, expect: 200 });
    const leaving = data.capabilities.filter((c) => c.leaves_india);
    assert(leaving.length > 0, 'no capability routed abroad — the test is not exercising the path');
    for (const c of leaving) {
      eq(c.deidentified, true, `${c.capability} would leave India without de-identification`);
    }
  });

  await check('the egress log is restricted to audit roles', async () => {
    await req('/api/ai/residency/log', { token: T.caller, expect: 403 });
    await req('/api/ai/residency/log', { token: T.admin, expect: 200 });
  });

  await check('a cross-border call is recorded with what was removed', async () => {
    await req(`/api/ai/leads/${REF.leadId}/next-action`, { token: T.sales_rm, expect: 200 });

    const { data } = await req('/api/ai/residency/log', { token: T.admin, expect: 200 });
    const entry = data.find((e) => e.action === 'ai_egress' && e.meta?.capability === 'nextAction');
    assert(entry, 'the cross-border call was not logged');
    eq(entry.meta.class, 'CLASS_DEIDENTIFIED', 'logged data class');
    assert(Object.keys(entry.meta.redacted).length > 0, 'nothing was recorded as redacted');
  });

  await check('the egress log records kinds and counts, never the values', async () => {
    const { data: lead } = await req(`/api/leads/${REF.leadId}?unmask=true`, { token: T.admin, expect: 200 });
    const { data: log } = await req('/api/ai/residency/log', { token: T.admin, expect: 200 });

    const raw = JSON.stringify(log);
    assert(!raw.includes(lead.mobile), 'a real mobile number is sitting in the egress log');
    assert(!raw.includes(lead.name), 'a real client name is sitting in the egress log');

    // What it should contain instead: the shape of what was removed.
    const entry = log.find((e) => e.action === 'ai_egress');
    for (const [kind, count] of Object.entries(entry.meta.redacted)) {
      assert(/^[A-Z]+$/.test(kind), `redaction kind looks like a value: ${kind}`);
      assert(Number.isInteger(count), `redaction count is not a number for ${kind}`);
    }
  });

  await check('the answer comes back with real identities restored', async () => {
    // De-identification must be invisible to the user: tokens go out, names come back.
    const { data } = await req(`/api/ai/leads/${REF.leadId}/next-action`, { token: T.sales_rm, expect: 200 });
    const text = JSON.stringify(data);
    assert(!/\[NAME_\d+\]|\[MOBILE_\d+\]|\[PAN_\d+\]/.test(text), `a de-identification token leaked to the user: ${text.slice(0, 200)}`);
    assert(data.action || data.next_action || data.recommendation, 'no recommendation returned');
  });

  await check('in_india_only mode is reachable and stops all egress', async () => {
    // The mode is process-level configuration, so assert the policy function
    // rather than restarting the server mid-suite.
    const { data } = await req('/api/ai/residency', { token: T.admin, expect: 200 });
    assert(data.modes_available.includes('in_india_only'), 'the lockdown mode is not offered');
    assert(data.modes_available.includes('offline'), 'the offline mode is not offered');
  });

  await check('AI status reports which residency mode is in force', async () => {
    const { data } = await req('/api/ai/status', { token: T.sales_rm, expect: 200 });
    eq(data.residency_mode, 'hybrid', 'status does not disclose the residency mode');
  });

  /* --------------------------------------------- 22. vendor integrations */
  suite('22 vendor webhooks');

  // Set when the server under test was started with matching secrets, which is
  // what `npm run test:webhooks` does. Without it only the refusal path runs —
  // and that is the path that matters most, so it is never skipped.
  const HOOK = process.env.E2E_WEBHOOK_SECRET || null;
  const signed = (secret) => ({ 'x-webhook-secret': secret });

  await check('an unsigned call event is refused', async () => {
    const { status } = await req('/api/webhooks/quickcall/call', {
      method: 'POST', body: { CallID: 'X-1', DialNumber: mob(1) },
    });
    eq(status, 401, 'an unsigned CTI callback was accepted');
  });

  await check('a wrongly signed call event is refused', async () => {
    const { status } = await req('/api/webhooks/quickcall/call', {
      method: 'POST', headers: signed('not-the-secret'), body: { CallID: 'X-2' },
    });
    eq(status, 401, 'a bad signature was accepted');
  });

  await check('unsigned WhatsApp and KYC callbacks are refused too', async () => {
    for (const path of ['/api/webhooks/smartping/whatsapp', '/api/webhooks/bonanza-kyc/status']) {
      const { status } = await req(path, { method: 'POST', body: {} });
      eq(status, 401, `${path} accepted an unsigned callback`);
    }
  });

  await check('the refusal says why, not just that it failed', async () => {
    // Two distinct causes, and an operator must be able to tell them apart:
    // the secret was never configured, or the caller did not present one.
    const { data } = await req('/api/webhooks/quickcall/call', { method: 'POST', body: {} });
    assert(
      /SECRET is not set|signature/i.test(data.error || ''),
      `unhelpful refusal: ${data.error}`,
    );
  });

  if (HOOK) {
    await check('a signed call event lands on the lead timeline', async () => {
      const callId = `E2E-CALL-${RUN}`;
      const { data } = await req('/api/webhooks/quickcall/call', {
        method: 'POST', headers: signed(HOOK), expect: 200,
        body: {
          CallID: callId, customerID: String(REF.leadId), DialNumber: `91${mob(1)}`,
          CallType: 'OUTBOUND', CallStatus: 'ANSWERED', TalkTime: '142',
          RecordingURL: 'https://voicelogger.local/e2e.wav', Disposition: 'Interested',
        },
      });
      eq(data.matched, true, 'the call did not match the lead');
      eq(data.lead_id, REF.leadId, 'matched the wrong lead');

      const { data: acts } = await req(`/api/activities?lead_id=${REF.leadId}`, { token: T.admin, expect: 200 });
      const call = acts.find((a) => a.external_id === callId);
      assert(call, 'the call is not on the timeline');
      eq(call.duration_s, 142, 'duration not recorded');
      eq(call.recording_url, 'https://voicelogger.local/e2e.wav', 'recording URL not recorded');
    });

    await check('a redelivered call event is not duplicated', async () => {
      // Every one of these vendors retries on timeout, so at-least-once delivery
      // is normal and de-duplication is not optional.
      const callId = `E2E-CALL-${RUN}`;
      const { data } = await req('/api/webhooks/quickcall/call', {
        method: 'POST', headers: signed(HOOK), expect: 200,
        body: { CallID: callId, customerID: String(REF.leadId), CallStatus: 'ANSWERED', TalkTime: '142' },
      });
      eq(data.duplicate, true, 'a redelivered event was recorded twice');
    });

    await check('an unmatched call is acknowledged, not dropped', async () => {
      const { data } = await req('/api/webhooks/quickcall/call', {
        method: 'POST', headers: signed(HOOK), expect: 200,
        body: { CallID: `E2E-ORPHAN-${RUN}`, DialNumber: '9000000000', CallType: 'INBOUND', CallStatus: 'ANSWERED', TalkTime: '10' },
      });
      eq(data.matched, false, 'an unknown number should not match a lead');
      eq(data.ok, true, 'an unmatched call must still be acknowledged');
    });

    await check('screen pop resolves a known number to its lead', async () => {
      const { data } = await req(`/api/webhooks/quickcall/screenpop?number=91${mob(1)}`, {
        method: 'GET', headers: signed(HOOK), expect: 200,
      });
      eq(data.found, true, 'a known caller was not resolved');
      eq(data.lead_id, REF.leadId, 'screen pop resolved the wrong lead');
    });

    await check('screen pop offers a create link for an unknown number', async () => {
      const { data } = await req('/api/webhooks/quickcall/screenpop?number=9000000000', {
        method: 'GET', headers: signed(HOOK), expect: 200,
      });
      eq(data.found, false, 'an unknown number should not resolve');
      assert(String(data.url).includes('mobile='), 'no create-with-number link offered');
    });

    await check('an inbound WhatsApp reply opens the 24-hour window', async () => {
      const { data } = await req('/api/webhooks/smartping/whatsapp', {
        method: 'POST', headers: signed(HOOK), expect: 200,
        body: { messageId: `E2E-WA-${RUN}`, waNumber: `91${mob(1)}`, text: 'Yes, please call me', senderName: 'E2E' },
      });
      eq(data.matched, true, 'the reply did not match the lead');

      const { data: lead } = await req(`/api/leads/${REF.leadId}`, { token: T.admin, expect: 200 });
      assert(lead.wa_last_inbound_at, 'the service window was not stamped');
    });

    await check('a delivery receipt is accepted without creating an activity', async () => {
      const { data } = await req('/api/webhooks/smartping/whatsapp', {
        method: 'POST', headers: signed(HOOK), expect: 200,
        body: { status: 'delivered', messageId: `E2E-WA-${RUN}`, destination: `91${mob(1)}` },
      });
      eq(data.kind, 'status', 'a delivery receipt was misread as a message');
    });

    await check('a KYC status callback becomes the authoritative status', async () => {
      const { data } = await req('/api/webhooks/bonanza-kyc/status', {
        method: 'POST', headers: signed(HOOK), expect: 200,
        body: { crm_ref: `LEAD-${REF.leadId}`, stage: 'completed', client_code: `BZ${RUN}`, mobile: mob(1) },
      });
      eq(data.matched, true, 'the KYC callback did not match the lead');

      const { data: lead } = await req(`/api/leads/${REF.leadId}`, { token: T.admin, expect: 200 });
      eq(lead.kyc_status, 'Complete', 'portal status did not become authoritative');
      eq(lead.client_code, `BZ${RUN}`, 'the client code was not recorded');
    });

    await check('an unknown portal stage does not mark the journey complete', async () => {
      const { data } = await req('/api/webhooks/bonanza-kyc/status', {
        method: 'POST', headers: signed(HOOK), expect: 200,
        body: { crm_ref: `LEAD-${REF.dkycLeadId}`, stage: 'awaiting_something_new' },
      });
      assert(data.stage !== 'Complete', `an unknown stage was read as Complete: ${data.stage}`);
    });
  }

  await check('the admin panel reports live vendor state without leaking secrets', async () => {
    const { data } = await req('/api/admin/integrations', { token: T.admin, expect: 200 });
    assert(data.vendors, 'no vendor status reported');
    assert(data.integrations.some((i) => /QuickCall/i.test(i.name)), 'QuickCall not listed');
    assert(data.integrations.some((i) => /Smartping/i.test(i.name)), 'Smartping not listed');
    assert(data.integrations.some((i) => /eKYC/i.test(i.name)), 'Bonanza eKYC not listed');

    // An integrations page that prints credentials is a leak with a nice UI.
    const raw = JSON.stringify(data);
    for (const secret of [process.env.SMARTPING_API_KEY, process.env.CUBE_QUICKCALL_PASSWORD, process.env.E2E_WEBHOOK_SECRET]) {
      if (secret) assert(!raw.includes(secret), 'a credential is being sent to the browser');
    }
  });

  /* ---------------------------------------------- 23. reports & data tools */
  suite('23 reports & data tools');

  await check('every report endpoint answers for an admin', async () => {
    for (const ep of ['overview', 'funnel', 'team', 'ageing', 'kyc', 'sla', 'partners', 'activity']) {
      await req(`/api/reports/${ep}`, { token: T.admin, expect: 200 });
    }
  });

  await check('reports are refused to roles without a reporting permission', async () => {
    await req('/api/reports/overview', { token: T.caller, expect: 403 });
    await req('/api/reports/team', { token: T.caller, expect: 403 });
  });

  await check('the partner report follows the partner remit, not the report tier', async () => {
    /* Superseded a check that asserted report.system, which put the report out
     * of reach of the two roles whose work it describes. It is gated on
     * partner.view now and scoped per role on the server, so opening it to a
     * supervisor does not widen what a supervisor reads. Suite 50 proves the
     * scoping; this one guards the gate itself. */
    await req('/api/reports/partners', { token: T.sales_supervisor, expect: 200 });
    await req('/api/reports/partners', { token: T.partner_rm, expect: 200 });
    await req('/api/reports/partners', { token: T.admin, expect: 200 });

    // No partner remit, no partner report.
    await req('/api/reports/partners', { token: T.caller, expect: 403 });
    await req('/api/reports/partners', { token: T.marketing_manager, expect: 403 });
  });

  await check('reports are scoped — an RM does not see the whole firm', async () => {
    // A Sales RM holds report.team only through their supervisor, so use the
    // supervisor, who legitimately sees a subset rather than everything.
    const { data: mine } = await req('/api/reports/overview', { token: T.sales_supervisor, expect: 200 });
    const { data: all_ } = await req('/api/reports/overview', { token: T.admin, expect: 200 });
    assert(mine.leads.total <= all_.leads.total, 'a scoped role saw more than the administrator');
  });

  await check('conversion excludes inactive cards from the denominator', async () => {
    const { data } = await req('/api/reports/overview', { token: T.admin, expect: 200 });
    // Every lead holds an INACTIVE card for every product, so a denominator that
    // included them would drive this to near zero for any realistic book.
    assert(data.cards.conversion_pct > 0, 'conversion collapsed — inactive cards are in the denominator');
    assert(data.cards.conversion_pct <= 100, `impossible conversion: ${data.cards.conversion_pct}`);
  });

  await check('an empty funnel does not nominate a stage nobody is in', async () => {
    const { data } = await req('/api/reports/funnel', { token: T.admin, expect: 200 });
    for (const p of data.products) {
      if (p.engaged === 0) eq(p.largest_stage, null, `${p.code} claims a busiest stage with nobody in it`);
    }
  });

  await check('reports never leak client PII', async () => {
    // These are aggregates. A mobile or PAN appearing here would mean a column
    // was selected that should never have been.
    for (const ep of ['overview', 'funnel', 'team', 'ageing', 'kyc', 'sla', 'partners', 'activity']) {
      const { data } = await req(`/api/reports/${ep}`, { token: T.admin, expect: 200 });
      const raw = JSON.stringify(data);
      assert(!/\b[6-9]\d{9}\b/.test(raw), `${ep} leaked something shaped like a mobile number`);
      assert(!/\b[A-Z]{5}\d{4}[A-Z]\b/.test(raw), `${ep} leaked something shaped like a PAN`);
    }
  });

  await check('the recycle bin masks PII like every other lead surface', async () => {
    // Regression: this endpoint used to SELECT * unmasked, making it the one
    // place a lead.delete holder could read the whole book's identifiers.
    const { data: created } = await req('/api/leads', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: 'Recycle Probe', mobile: mob(7), pan: 'RCYCL1234R' },
    });
    await req(`/api/leads/${created.id}`, { method: 'DELETE', token: T.admin, expect: 204 });

    // Admin now sees identifiers in the clear by default (ENH-16), so the
    // regression is expressed the way it actually matters: turn masking ON for
    // this role and prove the recycle bin HONOURS it rather than bypassing it,
    // which is what the original defect did.
    for (const field of ['mobile', 'pan']) {
      // eslint-disable-next-line no-await-in-loop
      await req('/api/setup/field-masking', {
        method: 'POST', token: T.superadmin, expect: 200,
        body: { role: 'admin', field, masked: true },
      });
    }

    const { data: bin } = await req('/api/recycle-bin', { token: T.admin, expect: 200 });
    const row = bin.find((l) => l.id === created.id);
    assert(row, 'the deleted lead is not in the recycle bin');
    assert(String(row.mobile).includes('•'), `recycle bin exposed a mobile: ${row.mobile}`);
    assert(!JSON.stringify(bin).includes('RCYCL1234R'), 'recycle bin exposed a PAN');

    for (const field of ['mobile', 'pan']) {
      // eslint-disable-next-line no-await-in-loop
      await req('/api/setup/field-masking', {
        method: 'POST', token: T.superadmin, expect: 200,
        body: { role: 'admin', field, masked: null },
      });
    }

    REF.recycledLeadId = created.id;
  });

  await check('a deleted lead can be restored and comes back whole', async () => {
    const id = need(REF.recycledLeadId, 'the recycled lead');
    await req(`/api/leads/${id}/restore`, { method: 'POST', token: T.admin, expect: 200 });

    const { data: lead } = await req(`/api/leads/${id}?unmask=true`, { token: T.admin, expect: 200 });
    eq(lead.name, 'Recycle Probe', 'the restored lead lost its name');
    eq(lead.mobile, mob(7), 'the restored lead lost its mobile');
    assert(lead.cards.length > 0, 'the restored lead lost its product cards');
  });

  await check('import validates without writing, then writes only valid rows', async () => {
    const rows = [
      { name: 'Import Good', mobile: mob(8), city: 'Pune' },
      { name: '', mobile: mob(9) },
      { name: 'Import Bad Mobile', mobile: '12345' },
    ];

    const { data: dry } = await req('/api/leads/import', {
      method: 'POST', token: T.admin, expect: 200, body: { rows, commit: false },
    });
    eq(dry.total, 3, 'dry run row count');
    eq(dry.valid, 1, 'dry run valid count');
    eq(dry.imported, 0, 'a dry run must not write anything');
    eq(dry.invalid.length, 2, 'dry run should reject two rows');

    const { data: found } = await req(`/api/leads?q=${mob(8)}`, { token: T.admin, expect: 200 });
    eq(found.length, 0, 'the dry run created a lead');

    const { data: live } = await req('/api/leads/import', {
      method: 'POST', token: T.admin, expect: 200, body: { rows, commit: true },
    });
    eq(live.imported, 1, 'only the valid row should import');
  });

  await check('import refuses a duplicate mobile rather than creating a twin', async () => {
    const { data } = await req('/api/leads/import', {
      method: 'POST', token: T.admin, expect: 200,
      body: { rows: [{ name: 'Duplicate Attempt', mobile: mob(8) }], commit: false },
    });
    eq(data.duplicates.length, 1, 'an existing mobile was not flagged as a duplicate');
    eq(data.valid, 0, 'a duplicate was counted as importable');
  });

  await check('timestamps are stored as UTC so the client can localise them', async () => {
    // Regression: the client parsed these bare strings as local time, rendering
    // every timestamp five and a half hours early for an IST user.
    const { data } = await req('/api/recycle-bin', { token: T.admin, expect: 200 });
    if (data.length) {
      const ts = data[0].deleted_at;
      assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts), `unexpected timestamp shape: ${ts}`);
      const asUtc = new Date(`${ts.replace(' ', 'T')}Z`).getTime();
      assert(Math.abs(Date.now() - asUtc) < 10 * 60 * 1000,
        'the stored timestamp is not UTC — read as UTC it is not close to now');
    }
  });

  /* ------------------------------------------------ 24. sales orgs */
  suite('24 sales orgs (Bonanza / Bigul)');

  const bigulRm = await login('rm@bigul.test');
  const crossRm = await login('salesrm3@bonanza.test');

  // mob() only has room for one digit after the run id, and suites 01-23 have
  // taken 0-9. Indian mobiles may start 8, so this suite gets its own range.
  const omob = (n) => `8${RUN}${n}`.slice(0, 10);

  await check('each user is offered only the orgs they are entitled to', async () => {
    const { data: admin } = await req('/api/orgs', { token: T.admin, expect: 200 });
    eq(admin.orgs.map((o) => o.code).join(','), 'BONANZA', 'admin org entitlement');
    eq(admin.may_switch, false, 'a single-org user should not get a switcher');

    const { data: cross } = await req('/api/orgs', { token: crossRm, expect: 200 });
    eq(cross.orgs.map((o) => o.code).sort().join(','), 'BIGUL,BONANZA', 'cross-org entitlement');
    eq(cross.may_switch, true, 'a cross-org user needs a switcher');

    const { data: sup } = await req('/api/orgs', { token: T.superadmin, expect: 200 });
    eq(sup.orgs.length, 2, 'superadmin spans both businesses');
  });

  await check('orgs carry their own branding', async () => {
    const { data } = await req('/api/orgs', { token: T.superadmin, expect: 200 });
    const bonanza = data.orgs.find((o) => o.code === 'BONANZA');
    const bigul = data.orgs.find((o) => o.code === 'BIGUL');
    assert(/^#[0-9a-f]{6}$/i.test(bonanza.accent), `bad accent: ${bonanza.accent}`);
    assert(bonanza.accent !== bigul.accent, 'the two businesses must be visually distinguishable');
    eq(bonanza.model, 'full_service', 'Bonanza is the RM-led business');
    eq(bigul.model, 'discount_digital', 'Bigul is the self-serve business');
  });

  await check('a single-org user never sees the other business', async () => {
    const { data } = await req('/api/leads', { token: T.admin, expect: 200 });
    assert(data.length > 0, 'no leads to check');
    for (const l of data) eq(l.sales_org, 'BONANZA', `a Bigul lead leaked to a Bonanza admin (lead ${l.id})`);
  });

  await check('a forged org parameter cannot widen entitlement', async () => {
    // The switcher is a view filter. Asking for an org you are not entitled to
    // must return your own book, never the other one and never an error that
    // reveals the other book exists.
    const { data } = await req('/api/leads?org=BIGUL', { token: T.admin, expect: 200 });
    for (const l of data) eq(l.sales_org, 'BONANZA', 'a forged ?org= widened an admin’s scope');

    const { data: b } = await req('/api/leads?org=BONANZA', { token: bigulRm, expect: 200 });
    for (const l of b) eq(l.sales_org, 'BIGUL', 'a forged ?org= widened a Bigul RM’s scope');
  });

  await check('the switcher narrows for a user entitled to both', async () => {
    const { data: all_ } = await req('/api/leads', { token: crossRm, expect: 200 });
    const { data: bigulOnly } = await req('/api/leads?org=BIGUL', { token: crossRm, expect: 200 });
    assert(bigulOnly.length <= all_.length, 'narrowing returned more than the unfiltered view');
    for (const l of bigulOnly) eq(l.sales_org, 'BIGUL', 'narrowing to BIGUL returned another org');
  });

  await check('role scope and org scope are ANDed, not substituted', async () => {
    // A Bigul RM is entitled to the Bigul org, but only to their own leads
    // within it — org entitlement must never widen role visibility.
    const { data } = await req('/api/leads', { token: bigulRm, expect: 200 });
    const { data: orgTotal } = await req('/api/leads', { token: T.superadmin, expect: 200 });
    const bigulTotal = orgTotal.filter((l) => l.sales_org === 'BIGUL').length;
    assert(data.length < bigulTotal, 'an RM saw the whole Bigul book, not just their own leads');
    assert(data.length > 0, 'the Bigul RM owns no leads — the fixture is wrong');
  });

  await check('each business has its own catalogue', async () => {
    const { data: bonanza } = await req('/api/meta', { token: T.admin, expect: 200 });
    const { data: bigul } = await req('/api/meta', { token: bigulRm, expect: 200 });

    const bCodes = bonanza.products.map((p) => p.code);
    const gCodes = bigul.products.map((p) => p.code);

    assert(bCodes.includes('PMS'), 'Bonanza should sell PMS');
    assert(gCodes.includes('BG-ALGO'), 'Bigul should sell Algos');
    assert(!bCodes.some((c) => c.startsWith('BG-')), 'a Bigul product appeared in the Bonanza catalogue');
    assert(!gCodes.includes('PMS'), 'a Bonanza product appeared in the Bigul catalogue');
  });

  await check('a lead only ever carries cards from its own catalogue', async () => {
    const { data } = await req('/api/leads', { token: T.superadmin, expect: 200 });
    const sample = data.filter((l) => l.sales_org === 'BIGUL').slice(0, 3);
    assert(sample.length, 'no Bigul leads to check');

    for (const l of sample) {
      const { data: full } = await req(`/api/leads/${l.id}`, { token: T.superadmin, expect: 200 });
      for (const c of full.cards) {
        assert(
          String(c.product_code).startsWith('BG-'),
          `Bigul lead ${l.id} carries a non-Bigul card: ${c.product_code}`,
        );
      }
    }
  });

  await check('a new lead inherits the org of whoever created it', async () => {
    const { data } = await req('/api/leads', {
      method: 'POST', token: bigulRm, expect: 201,
      body: { name: 'Bigul Org Probe', mobile: omob(1), city: 'Bengaluru' },
    });
    eq(data.sales_org, 'BIGUL', 'a Bigul RM created a lead in the wrong business');
    assert(data.cards.every((c) => String(c.product_code).startsWith('BG-')), 'wrong catalogue on a new Bigul lead');
  });

  await check('creating into an org you do not hold is refused', async () => {
    await req('/api/leads', {
      method: 'POST', token: T.admin, expect: 403,
      body: { name: 'Cross Org Probe', mobile: omob(2), sales_org: 'BIGUL' },
    });
  });

  await check('a cross-org user may choose which business a lead lands in', async () => {
    const { data } = await req('/api/leads', {
      method: 'POST', token: crossRm, expect: 201,
      body: { name: 'Cross Org Chooser', mobile: omob(3), sales_org: 'BIGUL' },
    });
    eq(data.sales_org, 'BIGUL', 'the chosen org was not honoured');
  });

  await check('bulk import lands in one named business, and refuses others', async () => {
    const { data } = await req('/api/leads/import', {
      method: 'POST', token: bigulRm, expect: 200,
      body: { rows: [{ name: 'Bigul Import', mobile: omob(4) }], commit: false },
    });
    eq(data.sales_org, 'BIGUL', 'import did not resolve to the caller’s org');

    await req('/api/leads/import', {
      method: 'POST', token: T.admin, expect: 403,
      body: { rows: [{ name: 'Wrong Org', mobile: omob(5) }], commit: false, sales_org: 'BIGUL' },
    });
  });

  await check('reports respect the org boundary', async () => {
    const { data: bonanza } = await req('/api/reports/overview', { token: T.admin, expect: 200 });
    const { data: both } = await req('/api/reports/overview', { token: T.superadmin, expect: 200 });
    assert(
      both.leads.total > bonanza.leads.total,
      'a superadmin spanning both orgs should count more leads than a single-org admin',
    );
  });

  /* ------------------------------------- 25. app shell, search, directory */
  suite('25 app shell & global search');

  await check('apps and tabs are filtered by permission', async () => {
    const { data: admin } = await req('/api/apps', { token: T.admin, expect: 200 });
    const { data: rep } = await req('/api/apps', { token: T.sales_rm, expect: 200 });

    const ids = (d) => d.apps.map((a) => a.id);
    assert(ids(admin).includes('setup'), 'an administrator should hold the Setup app');
    assert(!ids(rep).includes('setup'), 'a Sales RM must not hold the Setup app');
    assert(ids(rep).includes('sales'), 'a Sales RM should hold the Sales Console');
  });

  await check('a Sales RM is not handed a Marketing app', async () => {
    // list.create is held by nearly every role, so including it in the
    // Marketing app's requirements handed reps an app that was not theirs.
    const { data } = await req('/api/apps', { token: T.sales_rm, expect: 200 });
    assert(!data.apps.some((a) => a.id === 'marketing'), 'a Sales RM was given the Marketing app');
  });

  await check('a Marketing Manager is not handed Setup', async () => {
    // They hold admin.content and admin.templates, which is marketing work —
    // not a reason to land in platform configuration.
    const { data } = await req('/api/apps', { token: T.marketing_manager, expect: 200 });
    assert(!data.apps.some((a) => a.id === 'setup'), 'a Marketing Manager was given the Setup app');
    assert(data.apps.some((a) => a.id === 'marketing'), 'a Marketing Manager should hold Marketing');
  });

  await check('no app is offered with zero reachable tabs', async () => {
    for (const role of ['caller', 'dealer', 'customer_care', 'marketing_manager', 'product_rm']) {
      const { data } = await req('/api/apps', { token: T[role], expect: 200 });
      for (const a of data.apps) {
        assert(a.tabs.length > 0, `${role} was offered "${a.label}" with no tabs`);
        assert(a.primary, `${role}'s "${a.label}" has no landing tab`);
      }
    }
  });

  await check('every tab a user is offered names a permission they hold', async () => {
    const { data: me } = await req('/api/auth/me', { token: T.caller, expect: 200 });
    const held = new Set(me.user.permissions);
    const { data } = await req('/api/apps', { token: T.caller, expect: 200 });

    for (const tab of data.all_tabs) {
      if (!tab.needs) continue;
      assert(tab.needs.some((p) => held.has(p)), `caller was offered "${tab.label}" without a permission for it`);
    }
  });

  /* ------------------------------------------------------------- search */

  await check('global search finds a lead the caller can see', async () => {
    const { data } = await req('/api/search?q=Test', { token: T.admin, expect: 200 });
    assert(data.groups, 'no result groups returned');
    const leads = data.groups.Leads || [];
    assert(leads.length > 0, 'admin search found no leads');
    assert(leads[0].url.startsWith('/leads/'), 'result has no navigable url');
  });

  await check('search results carry masked identifiers, never raw ones', async () => {
    const { data } = await req('/api/search?q=9', { token: T.admin, expect: 200 });
    const raw = JSON.stringify(data);
    assert(!/\b[6-9]\d{9}\b/.test(raw), 'global search returned an unmasked mobile number');
  });

  await check('search cannot be used to discover another org’s records', async () => {
    // Not "no permission" — nothing at all. Confirming a record exists is
    // itself a disclosure.
    const { data: all_ } = await req('/api/leads', { token: T.superadmin, expect: 200 });
    const bigulLead = all_.find((l) => l.sales_org === 'BIGUL');
    assert(bigulLead, 'no Bigul lead to probe with');

    const term = String(bigulLead.name).split(' ')[0];
    const { data } = await req(`/api/search?q=${encodeURIComponent(term)}`, { token: T.admin, expect: 200 });
    for (const r of data.groups.Leads || []) {
      assert(r.id !== bigulLead.id, 'a Bonanza admin found a Bigul lead through search');
    }
  });

  await check('search below two characters returns nothing rather than everything', async () => {
    const { data } = await req('/api/search?q=a', { token: T.admin, expect: 200 });
    eq(Object.keys(data.groups).length, 0, 'a one-character search should not scan the book');
  });

  await check('a role without partner access gets no partner results', async () => {
    const { data } = await req('/api/search?q=a', { token: T.caller, expect: 200 });
    assert(!data.groups.Partners, 'a caller should not see partners in search');
  });

  /* ------------------------------------------------ staff vs client PII */

  await check('the admin user directory is scoped to their own business', async () => {
    const { data } = await req('/api/cockpit', { token: T.admin, expect: 200 });
    const rows = data.worklist?.rows ?? [];
    assert(rows.length > 0, 'no users listed');
    for (const u of rows) {
      eq(u.sales_org, 'BONANZA', `a Bonanza admin sees Bigul staff: ${u.name}`);
    }
  });

  await check('colleague emails are readable — they are directory data, not client PII', async () => {
    // Masking staff contact details turns user management into a list of
    // asterisks nobody can act on. Client identifiers are the thing to protect.
    const { data } = await req('/api/cockpit', { token: T.admin, expect: 200 });
    const rows = data.worklist?.rows ?? [];
    const withEmail = rows.filter((u) => u.email);
    assert(withEmail.length > 0, 'no staff emails present to check');
    for (const u of withEmail) {
      assert(!String(u.email).includes('•'), `a colleague email was masked: ${u.email}`);
    }
  });

  /* --------------------------- 26. activities, dispositions, follow-ups */
  suite('26 activity capture & follow-up intelligence');

  const soon = (h) => new Date(Date.now() + h * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

  await check('the disposition matrix is served for the capture form', async () => {
    const { data } = await req('/api/activities/meta', { token: T.sales_rm, expect: 200 });
    assert(data.dispositions.Call, 'no call dispositions');

    const outcomes = data.dispositions.Call.map((g) => g.outcome);
    assert(outcomes.includes('Connected'), 'no Connected group');
    assert(outcomes.includes('Not Connected'), 'no Not Connected group');

    const connected = data.dispositions.Call.find((g) => g.outcome === 'Connected').options;
    assert(connected.some((o) => o.code === 'CALL_CALLBACK'), 'Callback Requested missing');
    assert(connected.some((o) => o.code === 'CALL_MEETING_FIXED'), 'Meeting Fixed missing');
  });

  await check('a contact activity without an outcome is refused', async () => {
    // An untagged call is a call nobody can report on.
    const { data } = await req('/api/activities', {
      method: 'POST', token: T.sales_rm, expect: 400,
      body: { lead_id: REF.leadId, type: 'Call', body: 'Spoke to them' },
    });
    assert(/outcome/i.test(data.error), `unexpected error: ${data.error}`);
  });

  await check('"Callback Requested" cannot be saved without a date and time', async () => {
    // The whole value of this module rests on the follow-up existing, so the
    // obligation is enforced by the API and not merely by the form.
    const { data } = await req('/api/activities', {
      method: 'POST', token: T.sales_rm, expect: 400,
      body: { lead_id: REF.leadId, type: 'Call', disposition: 'CALL_CALLBACK', body: 'Call me later' },
    });
    assert(data.fields?.follow_up_at, `expected a field error, got ${JSON.stringify(data)}`);
  });

  await check('a follow-up in the past is refused', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    const { data } = await req('/api/activities', {
      method: 'POST', token: T.sales_rm, expect: 400,
      body: { lead_id: REF.leadId, type: 'Call', disposition: 'CALL_CALLBACK', follow_up_at: past },
    });
    assert(/past/i.test(data.fields?.follow_up_at ?? ''), 'a backdated follow-up was accepted');
  });

  await check('logging a callback creates a dated, owned, auto-created task', async () => {
    const due = soon(20);
    const { data } = await req('/api/activities', {
      method: 'POST', token: T.sales_rm, expect: 201,
      body: {
        lead_id: REF.leadId, type: 'Call', disposition: 'CALL_CALLBACK',
        duration_s: 95, body: 'In a meeting, asked for a callback tomorrow', follow_up_at: due,
      },
    });

    assert(data.follow_up, 'no follow-up task was created');
    eq(data.follow_up.kind, 'follow_up', 'wrong task kind');
    eq(data.follow_up.auto_created, 1, 'task should be marked auto-created');
    eq(data.follow_up.status, 'Open', 'task should be open');
    assert(data.follow_up.assignee_id, 'the task has no owner');
    assert(data.confirmation.includes(data.follow_up.due_at), 'the rep is not told what was committed');

    REF.followUpTaskId = data.follow_up.id;
    REF.callActivityId = data.activity.id;
  });

  await check('the activity and its task are linked in both directions', async () => {
    const { data } = await req(`/api/activities/lead/${REF.leadId}`, { token: T.sales_rm, expect: 200 });
    const logged = data.find((a) => a.id === REF.callActivityId);
    assert(logged, 'the activity is not on the timeline');
    eq(logged.follow_up_task_id, REF.followUpTaskId, 'activity does not point at its task');
    eq(logged.sub_disposition, 'Callback Requested', 'sub-disposition not stored');
    eq(logged.outcome, 'Connected', 'outcome not stored');
  });

  await check('reminders are queued across every channel', async () => {
    const { data } = await req('/api/activities/follow-ups', { token: T.sales_rm, expect: 200 });
    const all_ = [...data.overdue, ...data.today, ...data.upcoming];
    assert(all_.some((t) => t.id === REF.followUpTaskId), 'the new follow-up is not on the board');
  });

  await check('a "Ringing" outcome schedules its own retry with no input', async () => {
    const { data } = await req('/api/activities', {
      method: 'POST', token: T.sales_rm, expect: 201,
      body: { lead_id: REF.leadId, type: 'Call', disposition: 'CALL_NO_ANSWER', body: 'Rang out' },
    });
    assert(data.follow_up, 'no retry was scheduled');
    eq(data.follow_up.kind, 'retry', 'wrong task kind for a no-answer');
  });

  await check('"Not Interested" demands a reason and closes the card', async () => {
    const { data: refused } = await req('/api/activities', {
      method: 'POST', token: T.sales_rm, expect: 400,
      body: { lead_id: REF.leadId, type: 'Call', disposition: 'CALL_NOT_INTERESTED' },
    });
    assert(refused.fields?.reason, 'a refusal was accepted without a reason');

    const { data: lead } = await req(`/api/leads/${REF.leadId}`, { token: T.sales_rm, expect: 200 });
    const card = lead.cards.find((c) => c.state !== 'INACTIVE' && c.state !== 'LOST');
    if (card) {
      const { data } = await req('/api/activities', {
        method: 'POST', token: T.sales_rm, expect: 201,
        body: {
          lead_id: REF.leadId, card_id: card.id, type: 'Call',
          disposition: 'CALL_NOT_INTERESTED', reason: 'Invested elsewhere, locked in',
        },
      });
      assert(data.effects.some((e) => e.includes('LOST')), `card was not closed: ${JSON.stringify(data.effects)}`);
    }
  });

  await check('"Wrong Number" flags the mobile so nobody redials it', async () => {
    const { data } = await req('/api/activities', {
      method: 'POST', token: T.admin, expect: 201,
      body: { lead_id: REF.leadId, type: 'Call', disposition: 'CALL_WRONG_NUMBER', body: 'Not their number' },
    });
    assert(data.effects.includes('mobile flagged invalid'), 'the mobile was not flagged');
  });

  await check('"Do Not Disturb" suppresses the lead from campaigns', async () => {
    const { data } = await req('/api/activities', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        lead_id: REF.leadId, type: 'Call', disposition: 'CALL_DND',
        reason: 'Client asked to be removed from all marketing',
      },
    });
    assert(data.effects.includes('suppressed from campaigns'), 'marketing was not suppressed');
  });

  await check('an outcome from the wrong activity type is refused', async () => {
    const { data } = await req('/api/activities', {
      method: 'POST', token: T.sales_rm, expect: 400,
      body: { lead_id: REF.leadId, type: 'Meeting', disposition: 'CALL_PITCH_DONE' },
    });
    assert(/not an outcome for a Meeting/i.test(data.error), `unexpected: ${data.error}`);
  });

  await check('rescheduling moves the task and re-arms the reminders', async () => {
    const id = need(REF.followUpTaskId, 'the follow-up task');
    const newDue = soon(48);
    const { data } = await req(`/api/activities/follow-ups/${id}`, {
      method: 'PATCH', token: T.sales_rm, expect: 200,
      body: { due_at: newDue, note: 'Client moved it to Thursday' },
    });
    assert(data.due_at !== null, 'no due date after reschedule');
    eq(data.status, 'Open', 'reschedule should leave the task open');
  });

  await check('completing a follow-up stops it being chased', async () => {
    const id = need(REF.followUpTaskId, 'the follow-up task');
    const { data } = await req(`/api/activities/follow-ups/${id}/complete`, {
      method: 'POST', token: T.sales_rm, expect: 200,
    });
    eq(data.status, 'Done', 'task not completed');

    const { data: board } = await req('/api/activities/follow-ups', { token: T.sales_rm, expect: 200 });
    const still = [...board.overdue, ...board.today, ...board.upcoming].some((t) => t.id === id);
    assert(!still, 'a completed follow-up is still on the board');
  });

  await check('an activity cannot be logged against a lead you cannot see', async () => {
    const { data: all_ } = await req('/api/leads', { token: T.superadmin, expect: 200 });
    const other = all_.find((l) => l.sales_org === 'BIGUL');
    assert(other, 'no Bigul lead to probe with');

    await req('/api/activities', {
      method: 'POST', token: T.sales_rm, expect: 404,
      body: { lead_id: other.id, type: 'Call', disposition: 'CALL_PITCH_DONE' },
    });
  });

  /* ------------------------------------------------------- assignment */

  await check('an inbound lead is routed the moment it is created', async () => {
    const { data } = await req('/api/leads', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: 'Facebook Routing Probe', mobile: omob(6), source: 'Facebook Lead Ads', city: 'Mumbai' },
    });
    assert(data.routing?.assigned, 'the lead was not routed');
    assert(/Facebook/i.test(data.routing.reason), `routed by the wrong rule: ${data.routing.reason}`);
    assert(data.owner_id, 'the lead has no owner');
    REF.routedLeadId = data.id;
  });

  await check('routing is explainable and recorded on the timeline', async () => {
    const id = need(REF.routedLeadId, 'the routed lead');
    const { data } = await req(`/api/activities/lead/${id}`, { token: T.admin, expect: 200 });
    const assignment = data.find((a) => a.type === 'Assignment');
    assert(assignment, 'the assignment was not recorded on the timeline');
    assert(assignment.body, 'the assignment has no stated reason');
  });

  await check('round robin spreads leads rather than stacking one rep', async () => {
    const owners = [];
    for (let i = 0; i < 4; i += 1) {
      const { data } = await req('/api/leads', {
        method: 'POST', token: T.admin, expect: 201,
        body: { name: `RR Probe ${i}`, mobile: `7${RUN}${i}`.slice(0, 10), source: 'Google Ads' },
      });
      owners.push(data.owner_id);
    }
    assert(new Set(owners).size > 1, `round robin gave every lead to one rep: ${owners.join(',')}`);
  });

  await check('a lead is never left without an owner', async () => {
    const { data } = await req('/api/leads', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: 'Unmatched Source Probe', mobile: omob(7), source: 'Carrier Pigeon' },
    });
    assert(data.owner_id, 'a lead with no matching rule was left unowned');
  });

  /* ------------------------------- 27. setup: users, roles, permissions */
  suite('27 setup — users, roles & access');

  await check('roles are data, not code', async () => {
    // The audit's Part 4.1 complaint: four fixed roles meant every persona had
    // to become a "Permission Template". Roles must be creatable at runtime.
    const { data } = await req('/api/setup/roles', { token: T.admin, expect: 200 });
    assert(data.length >= 11, `expected the shipped roles, got ${data.length}`);

    const rm = data.find((r) => r.code === 'sales_rm');
    assert(rm, 'sales_rm role missing');
    assert(rm.capabilities.length > 0, 'sales_rm has no capabilities');
    eq(rm.is_system, 1, 'shipped roles should be marked system');
    assert(['own', 'team', 'product', 'org'].includes(rm.data_scope), `bad scope: ${rm.data_scope}`);
  });

  await check('the capability catalogue is grouped and marks sensitive grants', async () => {
    const { data } = await req('/api/setup/capabilities', { token: T.admin, expect: 200 });
    assert(data.categories.length > 3, 'capabilities are not grouped');

    const all_ = data.categories.flatMap((c) => c.capabilities);
    const unmask = all_.find((c) => c.code === 'pii.unmask');
    assert(unmask, 'pii.unmask missing from the catalogue');
    eq(unmask.sensitive, 1, 'unmasking client identifiers must be marked sensitive');
  });

  await check('an administrator can create a new role without a developer', async () => {
    const { data } = await req('/api/setup/roles', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        code: `regional_sup_${RUN}`.slice(0, 30),
        name: 'Regional Supervisor',
        description: 'Runs a branch, sees their own reports only',
        data_scope: 'team',
        capabilities: ['lead.view.own', 'lead.contact', 'report.team'],
      },
    });
    eq(data.data_scope, 'team', 'scope not saved');
    eq(data.is_system, 0, 'a created role must not be a system role');
    REF.customRole = data.code;
  });

  await check('a role can be cloned from an existing one', async () => {
    const { data } = await req('/api/setup/roles', {
      method: 'POST', token: T.admin, expect: 201,
      body: { code: `clone_${RUN}`.slice(0, 30), name: 'Cloned Caller', clone_from: 'caller' },
    });

    const { data: roles } = await req('/api/setup/roles', { token: T.admin, expect: 200 });
    const cloned = roles.find((r) => r.code === data.code);
    const source = roles.find((r) => r.code === 'caller');
    eq(cloned.capabilities.length, source.capabilities.length, 'clone did not copy capabilities');
    REF.clonedRole = data.code;
  });

  await check('role codes are validated and unique', async () => {
    await req('/api/setup/roles', {
      method: 'POST', token: T.admin, expect: 400,
      body: { code: 'Bad Code!', name: 'Nope' },
    });
    await req('/api/setup/roles', {
      method: 'POST', token: T.admin, expect: 409,
      body: { code: 'sales_rm', name: 'Duplicate' },
    });
  });

  await check('a system role cannot be deleted', async () => {
    await req('/api/setup/roles/sales_rm', { method: 'DELETE', token: T.admin, expect: 400 });
  });

  await check('a role still held by users cannot be deleted', async () => {
    const { data } = await req('/api/setup/roles/caller', { method: 'DELETE', token: T.admin, expect: 400 });
    assert(data.error, 'no error explaining why');
  });

  await check('an unused custom role can be deleted', async () => {
    const code = need(REF.clonedRole, 'the cloned role');
    await req(`/api/setup/roles/${code}`, { method: 'DELETE', token: T.admin, expect: 204 });
  });

  await check('an admin cannot remove their own ability to manage roles', async () => {
    // The classic administration accident, and unrecoverable without database
    // access. It has to be refused rather than confirmed.
    const { data } = await req('/api/setup/roles/admin', {
      method: 'PATCH', token: T.admin, expect: 400,
      body: { capabilities: ['lead.view.all'] },
    });
    assert(/your own/i.test(data.error), `unexpected: ${data.error}`);
  });

  /* ------------------------------------------- P2-05: editing a role
   *
   * The write API above has existed since the access model was built. What did
   * not exist was a screen that called it, so "roles are not editable" was true
   * of the product while being false of the server. These cover the round trip
   * the screen performs, and the one thing that decides whether the screen is
   * worth anything: that an edit changes what a holder may actually do.
   */

  await check('editing a role replaces its permissions, both adding and removing', async () => {
    const code = need(REF.customRole, 'the custom role');
    const { data: before } = await req('/api/setup/roles', { token: T.admin, expect: 200 });
    const start = before.find((r) => r.code === code);
    assert(start.capabilities.includes('lead.contact'), 'fixture changed — expected lead.contact');

    await req(`/api/setup/roles/${code}`, {
      method: 'PATCH', token: T.admin, expect: 200,
      body: {
        name: 'Regional Head',
        data_scope: 'org',
        capabilities: ['lead.view.own', 'client.view.own'],
      },
    });

    const { data: after } = await req('/api/setup/roles', { token: T.admin, expect: 200 });
    const end = after.find((r) => r.code === code);
    eq(end.name, 'Regional Head', 'name not saved');
    eq(end.data_scope, 'org', 'scope not saved');
    eq(end.capabilities.length, 2, `expected 2 capabilities, got ${end.capabilities.length}`);
    assert(end.capabilities.includes('client.view.own'), 'the added permission is missing');
    assert(!end.capabilities.includes('lead.contact'), 'the removed permission is still granted');
    assert(!end.capabilities.includes('report.team'), 'the removed permission is still granted');
  });

  await check('a role cannot be saved without a name', async () => {
    // COALESCE keeps an omitted name; an empty string is not null and would be
    // stored, leaving the role blank in every list that shows it.
    const code = need(REF.customRole, 'the custom role');
    await req(`/api/setup/roles/${code}`, {
      method: 'PATCH', token: T.admin, expect: 400, body: { name: '   ' },
    });
  });

  await check('a role edit takes effect without the holder signing in again', async () => {
    /* The point of the whole screen. If capabilities were resolved once at
     * sign-in, an administrator would revoke access and the person would keep
     * it until their token expired — which is the failure that matters here,
     * because revocation is the urgent direction. */
    const code = need(REF.customRole, 'the custom role');
    const email = `roleedit.${RUN}@bonanza.test`;

    const { data: created } = await req('/api/setup/users', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: 'Role Edit Probe', email, role: code, branch: 'Pune' },
    });
    const probe = await login(email, created.initial_password);

    // As edited above: lead.view.own and client.view.own, and nothing that
    // opens the case summary.
    await req('/api/tickets/reports/summary', { token: probe, expect: 403 });

    await req(`/api/setup/roles/${code}`, {
      method: 'PATCH', token: T.admin, expect: 200,
      body: { name: 'Regional Head', capabilities: ['lead.view.own', 'client.view.own', 'report.team'] },
    });
    await req('/api/tickets/reports/summary', { token: probe, expect: 200 });

    // And revocation, on the same token, is what actually has to work: an
    // administrator taking access away expects it gone now, not at expiry.
    await req(`/api/setup/roles/${code}`, {
      method: 'PATCH', token: T.admin, expect: 200,
      body: { name: 'Regional Head', capabilities: ['lead.view.own', 'client.view.own'] },
    });
    await req('/api/tickets/reports/summary', { token: probe, expect: 403 });
  });

  await check('every capability the editor offers is one the server recognises', async () => {
    /* The picker renders whatever the catalogue returns and PATCHes back the
     * ticked codes, silently dropping any the server does not know. If the
     * catalogue ever drifted from the capabilities table, permissions would
     * appear to save and then not be there. */
    const { data: cat } = await req('/api/setup/capabilities', { token: T.admin, expect: 200 });
    const offered = cat.categories.flatMap((c) => c.capabilities.map((x) => x.code));
    eq(offered.length, cat.total, 'the grouped catalogue and its total disagree');
    assert(new Set(offered).size === offered.length, 'a capability appears in two categories');

    const code = need(REF.customRole, 'the custom role');
    await req(`/api/setup/roles/${code}`, {
      method: 'PATCH', token: T.admin, expect: 200,
      body: { name: 'Regional Head', capabilities: offered },
    });
    const { data: roles } = await req('/api/setup/roles', { token: T.admin, expect: 200 });
    const granted = roles.find((r) => r.code === code).capabilities;
    eq(granted.length, offered.length,
      `${offered.length - granted.length} of the offered permissions were dropped on save`);
  });

  /* ---------------------------------- P2-17d: the dashboard holds up
   *
   * Every role, every window. The shape assertions live in the unit suite;
   * what this proves is that the thing actually builds for everybody without
   * losing a panel — which is the failure that used to be invisible, because a
   * builder that threw simply vanished from the response.
   */

  await check('every role gets a complete dashboard in every window', async () => {
    const roles = {
      superadmin: T.superadmin, admin: T.admin, sales_rm: T.sales_rm,
      caller: T.caller, sales_supervisor: T.sales_supervisor,
      product_rm: T.product_rm, customer_care: T.customer_care,
      marketing_manager: T.marketing_manager, partner_rm: T.partner_rm,
    };

    for (const [role, tok] of Object.entries(roles)) {
      for (const range of ['today', 'week', 'month', 'quarter', 'fy']) {
        // eslint-disable-next-line no-await-in-loop
        const { data } = await req(`/api/dashboard?range=${range}`, { token: tok, expect: 200 });
        assert(!data.broken, `${role}/${range}: panels failed to build — ${(data.broken ?? []).join(', ')}`);
        assert(Array.isArray(data.tiles) && data.tiles.length, `${role}/${range}: no tiles at all`);

        for (const t of data.tiles) {
          const v = String(t.value ?? '');
          assert(v !== '', `${role}/${range}: "${t.label}" has no value`);
          assert(!/NaN|Infinity|undefined/.test(v), `${role}/${range}: "${t.label}" = ${v}`);
          /* Twelve characters is what the tile is drawn to hold. A wider value
             does not wrap, it overlaps the label beside it. */
          assert(v.length <= 12, `${role}/${range}: "${t.label}" is ${v.length} characters — ${v}`);
        }
      }
    }
  });

  await check('a window with nothing in it renders zeroes, not blanks or errors', async () => {
    /* The first day of a month, and every day of a new deployment. An empty
       period is the normal state, not an edge case. */
    const { data } = await req('/api/dashboard?range=custom&from=2099-01-01&to=2099-01-02', {
      token: T.admin, expect: 200,
    });
    assert(!data.broken, `panels failed on an empty window: ${(data.broken ?? []).join(', ')}`);
    assert(data.tiles.length, 'an empty window produced no tiles at all');
    for (const t of data.tiles) {
      assert(!/NaN|Infinity/.test(String(t.value)), `"${t.label}" = ${t.value} on an empty window`);
    }
  });

  await check('a chart never returns more points than a chart can draw', async () => {
    const { data } = await req('/api/dashboard?range=fy', { token: T.superadmin, expect: 200 });
    for (const c of data.charts) {
      const points = c.data ?? c.stages ?? [];
      assert(points.length <= 20, `"${c.title}" returned ${points.length} points`);
      for (const p of points) {
        assert(p.label !== null && p.label !== '', `"${c.title}" has an unlabelled point`);
        assert(Number.isFinite(Number(p.value)), `"${c.title}" point ${p.label} = ${p.value}`);
        assert(Number(p.value) >= 0, `"${c.title}" point ${p.label} is negative`);
      }
    }
  });

  /* ------------------------------------------ P2-21: validation rules
   *
   * The engine's edges are covered by unit tests. What these cover is that the
   * refusal actually reaches the write routes — a validation engine nothing
   * calls is the most convincing kind of broken.
   */

  await check('a configured rule refuses the save, with the author\'s message', async () => {
    const { data: made } = await req('/api/leads', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: `Validation Probe ${RUN}`, mobile: `90000${RUN}`.slice(0, 10), source: 'Manual' },
    });
    REF.validationLead = made.id;

    const { data } = await req(`/api/leads/${made.id}`, {
      method: 'PATCH', token: T.admin, expect: 422, body: { stage: 'Won' },
    });
    assert(/PAN/i.test(data.error), `expected the rule's own message, got: ${data.error}`);
    assert(Array.isArray(data.failed) && data.failed.length, 'no failing rules reported');
  });

  await check('the same save is allowed once the problem is fixed', async () => {
    // Fixing the cause in the same request must work, or the only way to
    // correct a record is a sequence of saves that are each refused.
    const id = need(REF.validationLead, 'the validation probe lead');
    await req(`/api/leads/${id}`, {
      method: 'PATCH', token: T.admin, expect: 200, body: { stage: 'Won', pan: 'AAAPZ1234C' },
    });
  });

  await check('creation is guarded, not only editing', async () => {
    // A rule that only ran on update would be satisfied by importing the
    // offending record instead of typing it.
    await req('/api/leads', {
      method: 'POST', token: T.admin, expect: 422,
      body: { name: `Born Won ${RUN}`, mobile: `91000${RUN}`.slice(0, 10), source: 'Manual', stage: 'Won' },
    });
  });

  await check('a rule that names a field the object lacks is refused', async () => {
    const { data } = await req('/api/setup/objects/lead/validation-rules', {
      method: 'POST', token: T.admin, expect: 400,
      body: {
        name: 'Nonsense', message: 'never',
        condition: { all: [{ field: 'not_a_field', op: 'is_blank' }] },
      },
    });
    assert(/not a field/i.test(data.error), data.error);
  });

  await check('a rule must carry a message the person saving can act on', async () => {
    await req('/api/setup/objects/lead/validation-rules', {
      method: 'POST', token: T.admin, expect: 400,
      body: { name: 'Silent', message: '  ', condition: { all: [{ field: 'pan', op: 'is_blank' }] } },
    });
  });

  await check('a rule can be switched off without being deleted', async () => {
    const { data } = await req('/api/setup/objects/lead/validation-rules', { token: T.admin, expect: 200 });
    const rule = data.rules.find((r) => /PAN/i.test(r.name));
    assert(rule, 'the seeded PAN rule is missing');

    await req(`/api/setup/validation-rules/${rule.id}`, {
      method: 'PATCH', token: T.admin, expect: 200, body: { active: 0 },
    });

    const id = need(REF.validationLead, 'the validation probe lead');
    await req(`/api/leads/${id}`, { method: 'PATCH', token: T.admin, expect: 200, body: { pan: '' } });

    await req(`/api/setup/validation-rules/${rule.id}`, {
      method: 'PATCH', token: T.admin, expect: 200, body: { active: 1 },
    });
    await req(`/api/leads/${id}`, { method: 'PATCH', token: T.admin, expect: 422, body: { stage: 'Won' } });
  });

  await check('an author is told how many stored records a rule would already refuse', async () => {
    /* Almost never zero, and the number matters: a rule refusing four hundred
       existing records blocks every edit to all of them, including the edit
       that would fix them. */
    const { data } = await req('/api/setup/objects/lead/validation-rules/preview', {
      method: 'POST', token: T.admin, expect: 200,
      body: { condition: { all: [{ field: 'pan', op: 'is_blank' }] } },
    });
    assert(typeof data.checked === 'number' && typeof data.failing === 'number',
      `expected a count, got ${JSON.stringify(data)}`);
    assert(data.failing >= 1, 'the probe lead has no PAN, so at least one record should fail');
  });

  await check('writing rules needs the capability that adds fields', async () => {
    await req('/api/setup/objects/lead/validation-rules', {
      method: 'POST', token: T.sales_rm, expect: 403,
      body: { name: 'x', message: 'y', condition: { all: [{ field: 'pan', op: 'is_blank' }] } },
    });
  });

  /* -------------------------------------------------------------- users */

  await check('an administrator can create a user, and gets a password once', async () => {
    const { data } = await req('/api/setup/users', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        name: 'Setup Probe', email: `setup.${RUN}@bonanza.test`,
        role: 'caller', branch: 'Pune', employee_code: `BNZ${RUN}`.slice(0, 12),
      },
    });
    eq(data.user.role, 'caller', 'role not set');
    eq(data.user.active, 1, 'new user should be active');
    assert(data.initial_password, 'no initial password returned to hand over');
    REF.newUserId = data.user.id;
    REF.newUserEmail = data.user.email;
    REF.newUserPassword = data.initial_password;
  });

  await check('there is no seat limit', async () => {
    // The legacy tenant is capped at 132 licences. The brief asked for no limit.
    const before = (await req('/api/setup/users', { token: T.admin, expect: 200 })).data.total;
    for (let i = 0; i < 3; i += 1) {
      await req('/api/setup/users', {
        method: 'POST', token: T.admin, expect: 201,
        body: { name: `Bulk User ${i}`, email: `bulk${i}.${RUN}@bonanza.test`, role: 'caller' },
      });
    }
    const after = (await req('/api/setup/users', { token: T.admin, expect: 200 })).data.total;
    eq(after, before + 3, 'user creation was capped');
  });

  await check('the created user can sign in with the issued password', async () => {
    const token = await login(REF.newUserEmail, REF.newUserPassword);
    assert(token, 'the issued password does not authenticate');
    REF.newUserToken = token;
  });

  await check('duplicate email and employee code are refused', async () => {
    await req('/api/setup/users', {
      method: 'POST', token: T.admin, expect: 409,
      body: { name: 'Dup', email: REF.newUserEmail, role: 'caller' },
    });
  });

  await check('an unknown role is refused', async () => {
    await req('/api/setup/users', {
      method: 'POST', token: T.admin, expect: 400,
      body: { name: 'Bad Role', email: `badrole.${RUN}@bonanza.test`, role: 'wizard' },
    });
  });

  await check('deactivating someone holding live work warns before orphaning it', async () => {
    // Silently orphaning a book is how leads go missing after someone leaves.
    const { data: users } = await req('/api/setup/users', { token: T.admin, expect: 200 });
    const holder = users.users.find((u) => u.lead_count > 0 && u.active && u.role !== 'admin');
    assert(holder, 'no user with live leads to test with');

    const { data } = await req(`/api/setup/users/${holder.id}/active`, {
      method: 'POST', token: T.admin, expect: 409,
      body: { active: false },
    });
    assert(data.open_leads > 0, 'the warning did not say how many leads');
    assert(data.hint, 'the warning offers no way forward');
    REF.holderId = holder.id;

    // Remember the book so the suite can put it back. These checks mutate
    // seeded users, and without restoration the suite passes exactly once per
    // reseed — which is the same as not being run.
    const { data: book } = await req(`/api/leads?owner_id=${holder.id}&limit=200`, { token: T.admin, expect: 200 });
    REF.movedLeads = (book.leads ?? book).map((l) => l.id);
  });

  await check('deactivating can hand the book to someone else', async () => {
    const holder = need(REF.holderId, 'the lead holder');
    const { data: users } = await req('/api/setup/users', { token: T.admin, expect: 200 });
    const target = users.users.find((u) => u.active && u.id !== holder && u.role === 'sales_rm');
    assert(target, 'no active RM to hand the book to');

    const before = users.users.find((u) => u.id === target.id).lead_count;

    await req(`/api/setup/users/${holder}/active`, {
      method: 'POST', token: T.admin, expect: 200,
      body: { active: false, reassign_to: target.id },
    });

    const { data: after } = await req('/api/setup/users', { token: T.admin, expect: 200 });
    const moved = after.users.find((u) => u.id === target.id).lead_count;
    assert(moved > before, `the book did not move (${before} → ${moved})`);
    eq(after.users.find((u) => u.id === holder).active, 0, 'the user was not deactivated');
  });

  await check('a deactivated user cannot sign in', async () => {
    const holder = need(REF.holderId, 'the lead holder');
    const { data: users } = await req('/api/setup/users', { token: T.admin, expect: 200 });
    const email = users.users.find((u) => u.id === holder).email;

    const { status } = await req('/api/auth/login', {
      method: 'POST', body: { email, password: 'bonanza' },
    });
    eq(status, 401, 'a deactivated user was allowed to sign in');

    // Restore: reactivate the user and hand their book back, so the next run of
    // this suite starts from the same state as this one did.
    await req(`/api/setup/users/${holder}/active`, {
      method: 'POST', token: T.admin, expect: 200, body: { active: true },
    });
    for (const id of REF.movedLeads ?? []) {
      await req(`/api/leads/${id}`, {
        method: 'PATCH', token: T.admin, body: { owner_id: holder },
      });
    }
  });

  await check('an administrator cannot deactivate themselves', async () => {
    const { data: me } = await req('/api/auth/me', { token: T.admin, expect: 200 });
    await req(`/api/setup/users/${me.user.id}/active`, {
      method: 'POST', token: T.admin, expect: 400,
      body: { active: false },
    });
  });

  /* --------------------------------------------------- permission sets */

  await check('a permission set grants a capability on top of a role', async () => {
    const { data: set } = await req('/api/setup/permission-sets', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        name: `PII unmask exception ${RUN}`,
        description: 'For the one supervisor who handles disputes',
        capabilities: ['pii.unmask'],
      },
    });
    REF.permissionSetId = set.id;

    const userId = need(REF.newUserId, 'the created user');
    const { data } = await req(`/api/setup/users/${userId}/permission-sets`, {
      method: 'POST', token: T.admin, expect: 201,
      body: { set_id: set.id, reason: 'Handles billing disputes' },
    });

    assert(data.effective.includes('pii.unmask'), 'the grant did not take effect');
    assert(!data.from_role.includes('pii.unmask'), 'a caller role should not carry unmask');
    assert(data.from_grants.some((g) => g.capabilities.includes('pii.unmask')), 'grant provenance missing');
  });

  await check('a granted capability actually works at the API', async () => {
    // The grant has to change behaviour, not just appear in a list.
    const token = await login(REF.newUserEmail, REF.newUserPassword);
    const { data: me } = await req('/api/auth/me', { token, expect: 200 });
    assert(me.user.permissions.includes('pii.unmask'), 'the session does not carry the granted capability');
  });

  await check('revoking a set removes the capability', async () => {
    const userId = need(REF.newUserId, 'the created user');
    const setId = need(REF.permissionSetId, 'the permission set');
    const { data } = await req(`/api/setup/users/${userId}/permission-sets/${setId}`, {
      method: 'DELETE', token: T.admin, expect: 200,
    });
    assert(!data.effective.includes('pii.unmask'), 'the capability survived revocation');
  });

  /* ------------------------------------------------ access simulation */

  await check('"what can this person see?" is answerable, with provenance', async () => {
    // Audit Part 4.1: no screen in the legacy system could answer this.
    const { data: users } = await req('/api/setup/users', { token: T.admin, expect: 200 });
    const rm = users.users.find((u) => u.role === 'sales_rm' && u.active);

    const { data } = await req(`/api/setup/users/${rm.id}/access`, { token: T.admin, expect: 200 });
    assert(data.data_scope.meaning, 'the scope is not explained in words');
    assert(Array.isArray(data.from_role), 'no role provenance');
    assert(typeof data.leads_visible === 'number', 'no concrete count of what they see');
    assert(data.leads_visible <= data.total_in_org, 'a scoped user sees more than the org holds');
  });

  await check('the simulation matches what the API actually returns', async () => {
    // A simulation that disagrees with reality is worse than none.
    const { data: users } = await req('/api/setup/users', { token: T.admin, expect: 200 });
    const caller = users.users.find((u) => u.role === 'caller' && u.active && u.lead_count > 0);
    if (!caller) return;

    const { data: sim } = await req(`/api/setup/users/${caller.id}/access`, { token: T.admin, expect: 200 });
    eq(sim.leads_visible, caller.lead_count, 'simulated visibility disagrees with owned leads');
  });

  await check('anyone can see their own access', async () => {
    const { data } = await req('/api/setup/me/access', { token: T.caller, expect: 200 });
    eq(data.user.role, 'caller', 'wrong user returned');
    assert(data.effective.length > 0, 'no capabilities reported');
  });

  await check('setup is refused to non-administrators', async () => {
    await req('/api/setup/users', { token: T.caller, expect: 403 });
    await req('/api/setup/roles', { token: T.sales_rm, expect: 403 });
    await req('/api/setup/capabilities', { token: T.caller, expect: 403 });
  });


  /* ============================================================ 28 */
  suite('28 metadata layer & record editing');

  await check('the field list for a form comes from metadata, not from code', async () => {
    const { data } = await req('/api/meta/fields/lead', { token: T.sales_supervisor, expect: 200 });
    assert(data.fields.length > 10, `only ${data.fields.length} fields described`);

    const stage = data.fields.find((f) => f.api_name === 'stage');
    assert(stage, 'stage is not described');
    eq(stage.label, 'Stage', 'label lost');
    assert(stage.values?.length > 0, 'stage offers no picklist values');
    assert(stage.required, 'stage should be required');
  });

  await check('picklist values are data, so Setup can extend them', async () => {
    const { data } = await req('/api/meta/fields/lead', { token: T.sales_rm, expect: 200 });
    const source = data.fields.find((f) => f.api_name === 'source');
    assert(source.values.some((v) => v.value === 'Website'), 'Website missing from source');
    assert(source.values.length >= 10, `only ${source.values.length} sources`);
  });

  await check('a field the caller cannot read is never described to them', async () => {
    // Field-level security applied at the API, not in the browser. Marketing
    // has no pii.unmask, so PAN must not even appear in the form definition.
    const { data: open } = await req('/api/meta/fields/lead', { token: T.sales_rm, expect: 200 });
    const { data: shut } = await req('/api/meta/fields/lead', { token: T.marketing_manager, expect: 200 });

    assert(open.fields.some((f) => f.api_name === 'pan'), 'a capability holder should see PAN');
    assert(!shut.fields.some((f) => f.api_name === 'pan'),
      'PAN was described to a role without pii.unmask');
  });

  await check('an unknown object is a 404, not an empty form', async () => {
    await req('/api/meta/fields/not_a_thing', { token: T.admin, expect: 404 });
  });

  /* ---- custom fields, end to end through the API ---- */

  await check('an administrator adds a field without a migration', async () => {
    const { data } = await req('/api/setup/objects/lead/fields', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        label: `E2E Channel ${RUN}`,
        type: 'picklist',
        purpose: 'End-to-end coverage for the metadata layer',
        values: [{ label: 'Phone' }, { label: 'Branch' }, { label: 'Digital' }],
      },
    });
    REF.customField = data.field.api_name;
    assert(data.field.is_custom, 'field was not marked custom');
    eq(data.field.storage, 'value', 'a custom field should land in the value store');
  });

  await check('the new field appears on the form immediately', async () => {
    const name = need(REF.customField, 'the custom field');
    const { data } = await req('/api/meta/fields/lead', { token: T.sales_supervisor, expect: 200 });
    const f = data.fields.find((x) => x.api_name === name);
    assert(f, 'the field an admin just created is not on the form');
    eq(f.values.length, 3, 'picklist values did not come with it');
  });

  await check('a value can be written and read back', async () => {
    const name = need(REF.customField, 'the custom field');
    const lead = need(REF.leadId, 'a lead');

    await req(`/api/leads/${lead}`, {
      method: 'PATCH', token: T.sales_supervisor, expect: 200,
      body: { custom: { [name]: 'Branch' } },
    });

    const { data } = await req(`/api/leads/${lead}`, { token: T.sales_supervisor, expect: 200 });
    eq(data.custom[name], 'Branch', 'the custom value did not persist');
  });

  await check('a value outside the picklist is refused', async () => {
    // The cascade and the value list are enforced at the API, so an integration
    // write cannot put "Carrier Pigeon" into a controlled field.
    const name = need(REF.customField, 'the custom field');
    const lead = need(REF.leadId, 'a lead');

    const { data } = await req(`/api/leads/${lead}`, {
      method: 'PATCH', token: T.sales_supervisor, expect: 400,
      body: { custom: { [name]: 'Carrier Pigeon' } },
    });
    assert(data.fields?.[name], 'the refusal did not name the offending field');
  });

  await check('the API name is frozen once the field exists', async () => {
    const name = need(REF.customField, 'the custom field');
    await req(`/api/setup/objects/lead/fields/${name}`, {
      method: 'PATCH', token: T.admin, expect: 400,
      body: { type: 'number' },
    });
  });

  await check('the label can be renamed and the API name does not move', async () => {
    const name = need(REF.customField, 'the custom field');
    const { data } = await req(`/api/setup/objects/lead/fields/${name}`, {
      method: 'PATCH', token: T.admin, expect: 200,
      body: { label: 'Renamed By Test' },
    });
    eq(data.label, 'Renamed By Test', 'label did not change');
    eq(data.api_name, name, 'the API name moved with the label');
  });

  await check('a core field cannot be deleted', async () => {
    await req('/api/setup/objects/lead/fields/stage', {
      method: 'DELETE', token: T.admin, expect: 400,
    });
  });

  await check('deactivating a field keeps its stored values', async () => {
    const name = need(REF.customField, 'the custom field');
    const { data } = await req(`/api/setup/objects/lead/fields/${name}`, {
      method: 'DELETE', token: T.admin, expect: 200,
    });
    assert(data.values_retained >= 1, 'the stored value was discarded with the field');
  });

  await check('configuring objects is refused without the capability', async () => {
    await req('/api/setup/objects', { token: T.sales_rm, expect: 403 });
    await req('/api/setup/objects/lead/fields', {
      method: 'POST', token: T.sales_rm, expect: 403,
      body: { label: 'Nope', type: 'text', purpose: 'should not happen' },
    });
  });

  await check('a field with no stated purpose is refused', async () => {
    // The governance gate. 289 unowned custom fields is what its absence
    // looks like after four years.
    await req('/api/setup/objects/lead/fields', {
      method: 'POST', token: T.admin, expect: 400,
      body: { label: `No Purpose ${RUN}`, type: 'text' },
    });
  });

  /* ---- field history ---- */

  await check('changing a tracked field records who and when', async () => {
    const lead = need(REF.leadId, 'a lead');
    const { data: before } = await req(`/api/leads/${lead}`, { token: T.sales_supervisor, expect: 200 });
    const next = before.stage === 'Contacted' ? 'Qualified' : 'Contacted';

    await req(`/api/leads/${lead}`, {
      method: 'PATCH', token: T.sales_supervisor, expect: 200, body: { stage: next },
    });

    const { data } = await req(`/api/leads/${lead}`, { token: T.sales_supervisor, expect: 200 });
    const entry = data.field_history.find((h) => h.field === 'stage' && h.new_value === next);
    assert(entry, 'the stage change was not recorded in field history');
    assert(entry.actor_name, 'the change has no named actor');
  });

  await check('an untracked field records nothing', async () => {
    const lead = need(REF.leadId, 'a lead');
    const { data: before } = await req(`/api/leads/${lead}`, { token: T.sales_supervisor, expect: 200 });
    const cityRows = (h) => h.filter((x) => x.field === 'city').length;

    await req(`/api/leads/${lead}`, {
      method: 'PATCH', token: T.sales_supervisor, expect: 200, body: { city: 'Kolhapur' },
    });

    const { data } = await req(`/api/leads/${lead}`, { token: T.sales_supervisor, expect: 200 });
    eq(cityRows(data.field_history), cityRows(before.field_history),
      'an untracked field wrote history');
  });

  /* ---- the edit form must never be seeded from masked PII ---- */

  await check('unmask is refused to a role without the capability', async () => {
    const lead = need(REF.leadId, 'a lead');
    const { data } = await req(`/api/leads/${lead}?unmask=true`, { token: T.marketing_manager, expect: 200 });
    assert(String(data.mobile).includes('•'),
      'a role without pii.unmask received a real mobile number by asking for it');
  });

  await check('unmask returns real values to a capability holder', async () => {
    // The edit form depends on this. Seeded from masked values, the phone input
    // strips the dots and saves "0000" over a client's real number.
    const lead = need(REF.leadId, 'a lead');
    const { data } = await req(`/api/leads/${lead}?unmask=true`, { token: T.sales_supervisor, expect: 200 });
    assert(!String(data.mobile).includes('•'), 'the edit form would be seeded with a masked mobile');
    assert(/^\d{10}$/.test(String(data.mobile)), `mobile came back as "${data.mobile}"`);
  });

  await check('revealing PII is written to the audit log', async () => {
    const lead = need(REF.leadId, 'a lead');
    await req(`/api/leads/${lead}?unmask=true`, { token: T.sales_supervisor, expect: 200 });

    const { data } = await req('/api/admin/audit', { token: T.admin, expect: 200 });
    assert(data.some((r) => r.action === 'pii_unmasked'),
      'a PII reveal left no audit trail');
  });

  /* ---- the interaction split ---- */

  await check('the outcome of a call is visible, the notes body is not', async () => {
    const lead = need(REF.leadId, 'a lead');
    const { data } = await req(`/api/activities/lead/${lead}`, { token: T.marketing_manager, expect: 200 });
    if (!data.length) return;

    const foreign = data.filter((a) => a._restricted?.includes('body'));
    for (const a of foreign) {
      eq(a.body, null, 'a restricted note leaked its body');
      assert('type' in a, 'the channel was hidden along with the note');
    }
  });


  /* ============================================================ 29 */
  suite('29 consent, click-to-call & lead actions');

  await check('a lead reports what it may be contacted on', async () => {
    const lead = need(REF.leadId, 'a lead');
    const { data } = await req(`/api/leads/${lead}`, { token: T.sales_supervisor, expect: 200 });

    assert(data.contactability, 'the lead carries no contactability');
    for (const channel of ['call', 'whatsapp', 'sms', 'email']) {
      assert(channel in data.contactability, `${channel} missing from contactability`);
      assert('marketing' in data.contactability[channel], `${channel} has no marketing verdict`);
      assert('service' in data.contactability[channel], `${channel} has no service verdict`);
    }
  });

  await check('click-to-call reaches the dialler', async () => {
    // A lead this suite owns. The shared fixture picks up flags from earlier
    // suites, and a dial test that depends on run order is not a test.
    const { data } = await req('/api/leads', {
      method: 'POST', token: T.sales_supervisor, expect: 201,
      body: { name: `Dial Probe ${RUN}`, mobile: `97${String(RUN).slice(-8)}`, source: 'Manual' },
    });
    REF.dialLead = data.id;
    await req(`/api/leads/${data.id}/call`, { method: 'POST', token: T.sales_supervisor, expect: 200, body: {} });
  });

  await check('calling is refused to a role without lead.contact', async () => {
    const lead = need(REF.leadId, 'a lead');
    await req(`/api/leads/${lead}/call`, {
      method: 'POST', token: T.marketing_manager, expect: 403, body: {},
    });
  });

  /* ---- consent: marketing is gated, service is not ---- */

  await check('a marketing send to an opted-out lead is refused', async () => {
    // The gap this closes: the disposition matrix has always set this flag and
    // nothing ever read it before an outbound send.
    const { data: made } = await req('/api/leads', {
      method: 'POST', token: T.sales_supervisor, expect: 201,
      body: { name: `Consent Probe ${RUN}`, mobile: `98${String(RUN).slice(-8)}`, source: 'Manual' },
    });
    REF.consentLead = made.id;

    await req(`/api/leads/${made.id}`, {
      method: 'PATCH', token: T.sales_supervisor, expect: 200,
      body: { marketing_opt_out: 1 },
    });

    const { data } = await req(`/api/leads/${made.id}/message`, {
      method: 'POST', token: T.sales_supervisor, expect: 409,
      body: { channel: 'whatsapp', body: 'New PMS offer', intent: 'marketing' },
    });
    eq(data.code, 'opted_out', `wrong refusal code: ${data.code}`);
    assert(/opted out/i.test(data.error), `unhelpful reason: ${data.error}`);
  });

  await check('a service message to the same lead still goes', async () => {
    // An opt-out from marketing is not an opt-out from being told their KYC
    // failed. Blocking that would be worse service, not better compliance.
    const id = need(REF.consentLead, 'the consent probe lead');
    await req(`/api/leads/${id}/message`, {
      method: 'POST', token: T.sales_supervisor, expect: 201,
      body: { channel: 'whatsapp', body: 'Your KYC needs one more document', intent: 'service' },
    });
  });

  await check('a call to an opted-out lead still goes', async () => {
    const id = need(REF.consentLead, 'the consent probe lead');
    await req(`/api/leads/${id}/call`, { method: 'POST', token: T.sales_supervisor, expect: 200, body: {} });
  });

  await check('the intent defaults to the safer of the two', async () => {
    // A caller that forgets to say gets marketing, which is the one that can be
    // refused. Defaulting to service would make silence the permissive answer.
    const id = need(REF.consentLead, 'the consent probe lead');
    const { data } = await req(`/api/leads/${id}/message`, {
      method: 'POST', token: T.sales_supervisor, expect: 409,
      body: { channel: 'whatsapp', body: 'No intent declared' },
    });
    eq(data.code, 'opted_out', 'an undeclared send was treated as service');
  });

  await check('contactability reflects the opt-out', async () => {
    const id = need(REF.consentLead, 'the consent probe lead');
    const { data } = await req(`/api/leads/${id}`, { token: T.sales_supervisor, expect: 200 });

    eq(data.contactability.whatsapp.marketing, false, 'marketing still shown as allowed');
    eq(data.contactability.whatsapp.service, true, 'service was blocked along with marketing');
    assert(data.contactability.whatsapp.reason, 'no reason given for the block');
  });

  /* ---- consent: a dead number blocks everything on it ---- */

await check('a per-channel withdrawal closes only that channel', async () => {
    // The lossless consent model the migration map calls for. Legacy carries
    // DoNotCall, DoNotEmail and DoNotSMS as independent withdrawals; one
    // boolean cannot represent them without over- or under-blocking.
    const { data: made } = await req('/api/leads', {
      method: 'POST', token: T.sales_supervisor, expect: 201,
      body: { name: `Channel Consent ${RUN}`, mobile: `96${String(RUN).slice(-8)}`,
              email: `chan.${RUN}@test.test`, source: 'Manual' },
    });

    await req(`/api/leads/${made.id}`, {
      method: 'PATCH', token: T.sales_supervisor, expect: 200,
      body: { no_call: 1, consent_source: 'Said so on a call' },
    });

    const { data } = await req(`/api/leads/${made.id}`, { token: T.sales_supervisor, expect: 200 });
    eq(data.contactability.call.service, false, 'the phone should be closed');
    eq(data.contactability.email.service, true, 'email should still be open');
    eq(data.contactability.sms.service, true, 'SMS should still be open');
    REF.channelLead = made.id;
  });

  await check('do-not-call blocks service too, not just marketing', async () => {
    // "Do not call me" is a statement about the telephone, not about marketing.
    // Blocking only promotional calls would still ring a client who asked us
    // not to — which is the breach, whatever the intent field said.
    const id = need(REF.channelLead, 'the channel-consent lead');
    const { data } = await req(`/api/leads/${id}/call`, {
      method: 'POST', token: T.sales_supervisor, expect: 409, body: {},
    });
    eq(data.code, 'channel_opted_out', `wrong code: ${data.code}`);
    assert(/phone/i.test(data.error), `the reason does not name the channel: ${data.error}`);
  });

  await check('another channel still delivers for the same lead', async () => {
    const id = need(REF.channelLead, 'the channel-consent lead');
    await req(`/api/leads/${id}/message`, {
      method: 'POST', token: T.sales_supervisor, expect: 201,
      body: { channel: 'email', body: 'Your KYC needs a document', intent: 'service' },
    });
  });

  await check('an invalid mobile blocks calls and texts, including service', async () => {
    const id = need(REF.consentLead, 'the consent probe lead');
    await req(`/api/leads/${id}`, {
      method: 'PATCH', token: T.sales_supervisor, expect: 200,
      body: { mobile_invalid: 1, marketing_opt_out: 0 },
    });

    const { data: called } = await req(`/api/leads/${id}/call`, {
      method: 'POST', token: T.sales_supervisor, expect: 409, body: {},
    });
    eq(called.code, 'invalid_destination', `wrong code: ${called.code}`);

    const { data: texted } = await req(`/api/leads/${id}/message`, {
      method: 'POST', token: T.sales_supervisor, expect: 409,
      body: { channel: 'sms', body: 'Anything', intent: 'service' },
    });
    eq(texted.code, 'invalid_destination', 'a dead number accepted an SMS');
  });

  await check('email is unaffected by a dead mobile', async () => {
    // The flag is about the number, not about the person. Blocking their email
    // because their phone is wrong would be the wrong lesson learned.
    const id = need(REF.consentLead, 'the consent probe lead');
    const { data } = await req(`/api/leads/${id}`, { token: T.sales_supervisor, expect: 200 });
    eq(data.contactability.email.service, data.email ? true : false,
      'email contactability should depend on having an email, not on the mobile flag');
  });

  await check('a lead with no mobile says so rather than failing oddly', async () => {
    const { data: made } = await req('/api/leads', {
      method: 'POST', token: T.sales_supervisor, expect: 201,
      body: { name: `No Mobile ${RUN}`, email: `nomobile.${RUN}@test.test`, source: 'Manual' },
    });

    const { data } = await req(`/api/leads/${made.id}/call`, {
      method: 'POST', token: T.sales_supervisor, expect: 409, body: {},
    });
    eq(data.code, 'no_destination', `wrong code for a lead with no mobile: ${data.code}`);
  });

  /* ---- the action menu is a convenience, the API is the control ---- */

  await check('the API refuses an action the menu would have hidden', async () => {
    // The menu hides what a role cannot do. That is courtesy; this is the
    // control. A forged request must be refused just the same.
    const lead = need(REF.leadId, 'a lead');

    await req(`/api/leads/${lead}`, {
      method: 'PATCH', token: T.caller, expect: 403, body: { owner_id: 2 },
    });
    await req(`/api/leads/${lead}`, {
      method: 'PATCH', token: T.sales_rm, expect: 403, body: { stage: 'Won' },
    });
  });

  await check('superadmin and admin hold every action the menu offers', async () => {
    // The stated requirement: both roles get the full action button by default.
    const required = [
      'lead.contact', 'lead.edit', 'lead.delete', 'lead.reassign',
      'lead.stage.change', 'ticket.create', 'card.mark.exploring', 'kyc.manage',
    ];
    for (const role of ['superadmin', 'admin']) {
      const { data } = await req('/api/auth/me', { token: T[role], expect: 200 });
      const held = new Set(data.user.permissions);
      const missing = required.filter((c) => !held.has(c));
      eq(missing.length, 0, `${role} is missing ${missing.join(', ')}`);
    }
  });

  await check('pushing to the autodialler works and is scoped', async () => {
    const lead = need(REF.leadId, 'a lead');
    await req('/api/autodialler', {
      method: 'POST', token: T.sales_rm, expect: 200, body: { lead_ids: [lead] },
    });
    await req('/api/autodialler', {
      method: 'POST', token: T.marketing_manager, expect: 403, body: { lead_ids: [lead] },
    });
  });


  /* ============================================================ 30 */
  suite('30 market data');

  await check('the login-page strip needs no session', async () => {
    const { data } = await req('/public/market/indices', { expect: 200 });
    assert(data.indices?.length > 0, 'no indices returned');
    for (const ix of data.indices) {
      assert(typeof ix.last === 'number', `${ix.code} has no level`);
      assert(typeof ix.change_pct === 'number', `${ix.code} has no change`);
    }
  });

  await check('the public endpoint exposes nothing beyond the strip', async () => {
    // An unauthenticated endpoint on a broker's CRM will be found. It must be
    // able to leak nothing — no news, no calendars, no identifiers.
    const { data } = await req('/public/market/indices', { expect: 200 });
    const allowed = new Set(['indices', 'as_of', 'delayed_minutes', 'disclaimer', 'simulated', 'stale']);
    const extra = Object.keys(data).filter((k) => !allowed.has(k));
    eq(extra.length, 0, `public endpoint leaked: ${extra.join(', ')}`);
  });

  await check('every payload carries its age and the delay', async () => {
    // The compliance decision rests on this reaching the screen. A figure
    // without its age attached is a quote.
    for (const path of ['/api/market/indices', '/api/market/news', '/api/market/snapshot']) {
      const { data } = await req(path, { token: T.sales_rm, expect: 200 });
      assert(data.as_of, `${path} has no as_of`);
      eq(data.delayed_minutes, 15, `${path} reports the wrong delay`);
      assert(/delayed/i.test(data.disclaimer), `${path} has no disclaimer`);
    }
  });

  await check('the delay is real, not decorative', async () => {
    const { data } = await req('/api/market/indices', { token: T.sales_rm, expect: 200 });
    const age = Date.now() - Date.parse(data.as_of);
    assert(age >= 14 * 60_000, `as_of is only ${Math.round(age / 60_000)} minutes old`);
  });

  await check('a simulated feed says so', async () => {
    // No vendor is configured yet. If the screen did not admit that, someone
    // would screenshot a demo and treat the numbers as real.
    const { data } = await req('/api/market/status', { token: T.sales_rm, expect: 200 });
    eq(data.live, false, 'reporting a live feed with no vendor configured');
    assert(/simulated/i.test(data.note), 'the status does not say it is simulated');

    const { data: ix } = await req('/api/market/indices', { token: T.sales_rm, expect: 200 });
    eq(ix.simulated, true, 'simulated data was not flagged');
  });

  await check('news, calendars and issues are behind a session', async () => {
    for (const path of ['/news', '/corporate-actions', '/issues', '/snapshot']) {
      await req(`/api/market${path}`, { expect: 401 });
    }
  });

  await check('every role can see the market, no capability needed', async () => {
    // Index levels and a results calendar are not client data, and gating them
    // by role would only mean the people who most need context lose it.
    for (const role of ['caller', 'sales_rm', 'customer_care', 'marketing_manager']) {
      await req('/api/market/indices', { token: T[role], expect: 200 });
    }
  });

  await check('the snapshot carries all four datasets', async () => {
    const { data } = await req('/api/market/snapshot', { token: T.sales_rm, expect: 200 });
    for (const key of ['indices', 'news', 'actions', 'issues']) {
      assert(Array.isArray(data[key]) && data[key].length > 0, `snapshot is missing ${key}`);
    }
  });

  await check('lead context is matched to recorded product interest', async () => {
    const lead = need(REF.leadId, 'a lead');
    const { data } = await req(`/api/market/context/${lead}`, { token: T.sales_supervisor, expect: 200 });

    assert(data.basis, 'no basis stated for what is shown');
    assert(Array.isArray(data.interests), 'interests missing');
    assert(data.indices.length > 0, 'no indices in lead context');
    assert(data.disclaimer, 'lead context has no disclaimer');
  });

  await check('lead context does not claim holdings we cannot see', async () => {
    // There is no instrument or position table anywhere in the schema. If this
    // ever starts returning holdings, it is inventing them.
    const lead = need(REF.leadId, 'a lead');
    const { data } = await req(`/api/market/context/${lead}`, { token: T.sales_supervisor, expect: 200 });
    assert(!('holdings' in data), 'lead context claims holdings the CRM does not store');
    assert(!('positions' in data), 'lead context claims positions the CRM does not store');
  });

  await check('lead context respects lead visibility', async () => {
    await req('/api/market/context/999999', { token: T.sales_rm, expect: 404 });
  });

  await check('repeated calls are served from cache, not the feed', async () => {
    // Fifty RMs opening the cockpit at 9am must not become fifty calls to a
    // metered feed.
    const first = await req('/api/market/indices', { token: T.sales_rm, expect: 200 });
    const second = await req('/api/market/indices', { token: T.caller, expect: 200 });
    eq(second.data.fetched_at, first.data.fetched_at,
      'the second call re-fetched instead of using the cache');
  });


  /* ============================================================ 31 */
  suite('31 campaign management');

  await check('a Marketing Manager can create a campaign', async () => {
    // The reported problem. The capability was always held; there was no route
    // from the screen to it and no way to edit afterwards.
    const { data: lists } = await req('/api/lists', { token: T.marketing_manager, expect: 200 });
    assert(lists.length, 'no lead lists to campaign against');
    REF.listId = lists[0].id;

    const { data } = await req('/api/admin/campaigns', {
      method: 'POST', token: T.marketing_manager, expect: 201,
      body: { name: `E2E campaign ${RUN}`, channel: 'whatsapp', list_id: REF.listId },
    });
    REF.campaignId = data.id;
    eq(data.status, 'Draft', 'a new campaign should start as a draft');
  });

  await check('a Marketing Manager can edit it', async () => {
    const id = need(REF.campaignId, 'the campaign');
    const { data } = await req(`/api/admin/campaigns/${id}`, {
      method: 'PATCH', token: T.marketing_manager, expect: 200,
      body: { name: `E2E campaign ${RUN} v2` },
    });
    assert(data.name.endsWith('v2'), 'the edit did not stick');
  });

  await check('superadmin and admin can too', async () => {
    for (const role of ['superadmin', 'admin']) {
      const { data } = await req('/api/admin/campaigns', {
        method: 'POST', token: T[role], expect: 201,
        body: { name: `E2E ${role} ${RUN}`, channel: 'email', list_id: REF.listId },
      });
      await req(`/api/admin/campaigns/${data.id}`, { method: 'DELETE', token: T[role], expect: 200 });
    }
  });

  await check('a role without campaign.manage is refused', async () => {
    await req('/api/admin/campaigns', { token: T.sales_rm, expect: 403 });
    await req('/api/admin/campaigns', {
      method: 'POST', token: T.sales_rm, expect: 403,
      body: { name: 'Nope', channel: 'sms', list_id: REF.listId },
    });
  });

  await check('a campaign needs a name, a channel and a list', async () => {
    for (const body of [
      { channel: 'sms', list_id: REF.listId },
      { name: 'No channel', list_id: REF.listId },
      { name: 'No list', channel: 'sms' },
    ]) {
      await req('/api/admin/campaigns', { method: 'POST', token: T.marketing_manager, expect: 400, body });
    }
  });

  /* ---- the consent gate on the highest-volume send path ---- */

  await check('the audience preview separates reachable from skipped', async () => {
    const id = need(REF.campaignId, 'the campaign');
    const { data } = await req(`/api/admin/campaigns/${id}/audience`, {
      token: T.marketing_manager, expect: 200,
    });

    eq(data.list_size, data.reachable + data.excluded, 'the numbers do not add up');
    assert(typeof data.excluded_by_reason === 'object', 'no breakdown of why anyone was skipped');
  });

  await check('a campaign send skips opted-out members rather than messaging them', async () => {
    // This path previously sent to every list member with no consent check at
    // all — the single largest exposure in the product.
    const id = need(REF.campaignId, 'the campaign');

    const { data: before } = await req(`/api/admin/campaigns/${id}/audience`, {
      token: T.marketing_manager, expect: 200,
    });

    const { data: sent } = await req(`/api/admin/campaigns/${id}/send`, {
      method: 'POST', token: T.marketing_manager, expect: 200,
    });

    eq(sent.sent, before.reachable, 'the send reached a different number than the preview promised');
    eq(sent.excluded, before.excluded, 'the send skipped a different number than the preview promised');
    assert(sent.sent <= before.list_size, 'sent to more people than were on the list');
  });

  await check('a sent campaign cannot be edited', async () => {
    // Its reach and engagement are the evidence behind numbers already reported.
    const id = need(REF.campaignId, 'the campaign');
    const { data } = await req(`/api/admin/campaigns/${id}`, {
      method: 'PATCH', token: T.marketing_manager, expect: 409,
      body: { name: 'Rewriting history' },
    });
    assert(/duplicate/i.test(data.fix ?? ''), 'the refusal offers no way forward');
  });

  await check('a sent campaign cannot be sent twice', async () => {
    const id = need(REF.campaignId, 'the campaign');
    await req(`/api/admin/campaigns/${id}/send`, { method: 'POST', token: T.marketing_manager, expect: 409 });
  });

  await check('deleting a sent campaign archives it instead', async () => {
    const id = need(REF.campaignId, 'the campaign');
    const { data } = await req(`/api/admin/campaigns/${id}`, {
      method: 'DELETE', token: T.marketing_manager, expect: 200,
    });
    eq(data.archived, true, 'a sent campaign was deleted outright');

    const { data: live } = await req('/api/admin/campaigns', { token: T.marketing_manager, expect: 200 });
    assert(!live.some((c) => c.id === id), 'the archived campaign is still on the working list');

    const { data: archived } = await req('/api/admin/campaigns/archived', { token: T.marketing_manager, expect: 200 });
    assert(archived.some((c) => c.id === id), 'the archived campaign is nowhere to be found');
  });

  /* ---- the rest of the action set ---- */

  await check('duplicate makes a fresh draft', async () => {
    const { data: made } = await req('/api/admin/campaigns', {
      method: 'POST', token: T.marketing_manager, expect: 201,
      body: { name: `Dup source ${RUN}`, channel: 'sms', list_id: REF.listId },
    });
    const { data: copy } = await req(`/api/admin/campaigns/${made.id}/duplicate`, {
      method: 'POST', token: T.marketing_manager, expect: 201,
    });
    eq(copy.status, 'Draft', 'a duplicate should be a draft');
    eq(copy.sent, 0, 'a duplicate inherited its parent’s send count');
    assert(copy.name.includes('copy'), 'the duplicate is not distinguishable by name');
    REF.dupId = copy.id;
  });

  await check('scheduling moves a draft to Scheduled, and it can be paused and resumed', async () => {
    const id = need(REF.dupId, 'the duplicate');
    const when = new Date(Date.now() + 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

    const { data: scheduled } = await req(`/api/admin/campaigns/${id}`, {
      method: 'PATCH', token: T.marketing_manager, expect: 200, body: { scheduled_at: when },
    });
    eq(scheduled.status, 'Scheduled', 'scheduling did not change the status');

    const { data: paused } = await req(`/api/admin/campaigns/${id}/pause`, {
      method: 'POST', token: T.marketing_manager, expect: 200,
    });
    eq(paused.status, 'Paused');

    const { data: resumed } = await req(`/api/admin/campaigns/${id}/resume`, {
      method: 'POST', token: T.marketing_manager, expect: 200,
    });
    eq(resumed.status, 'Scheduled', 'resuming lost the schedule');
  });

  await check('pausing a draft is refused with the reason', async () => {
    const { data: made } = await req('/api/admin/campaigns', {
      method: 'POST', token: T.marketing_manager, expect: 201,
      body: { name: `Draft ${RUN}`, channel: 'sms', list_id: REF.listId },
    });
    const { data } = await req(`/api/admin/campaigns/${made.id}/pause`, {
      method: 'POST', token: T.marketing_manager, expect: 409,
    });
    assert(/draft/i.test(data.error), `unhelpful refusal: ${data.error}`);

    // A draft has sent nothing, so it deletes outright rather than archiving.
    const { data: gone } = await req(`/api/admin/campaigns/${made.id}`, {
      method: 'DELETE', token: T.marketing_manager, expect: 200,
    });
    eq(gone.deleted, true, 'an unsent draft was archived rather than deleted');
  });

  await check('a test send goes to the sender, never to a lead', async () => {
    const id = need(REF.dupId, 'the duplicate');
    const { status, data } = await req(`/api/admin/campaigns/${id}/test`, {
      method: 'POST', token: T.admin,
    });
    // Either it sent to the admin's own number, or it explained why it could not.
    if (status === 200) {
      assert(data.sent_to, 'a test send reported no destination');
      assert(/only/i.test(data.note ?? ''), 'the test send does not say it went nowhere near a lead');
    } else {
      eq(status, 400, `unexpected status ${status}`);
      assert(/no (email|mobile)/i.test(data.error), `unhelpful error: ${data.error}`);
    }
  });


  /* ============================================================ 32 */
  suite('32 Meta connector (Facebook / Instagram)');

  await check('the connector reports what it still needs', async () => {
    const { data } = await req('/api/admin/connectors/meta', { token: T.superadmin, expect: 200 });
    assert('live' in data, 'no live flag');
    assert(Array.isArray(data.needs), 'no list of what is missing');
    assert(data.webhook_url, 'the webhook URL is not stated');
  });

  await check('a Lead Ads delivery becomes a lead, routed and attributed', async () => {
    const leadgenId = `LG-E2E-${RUN}`;
    const { data } = await req('/api/webhooks/meta', {
      method: 'POST', expect: 200,
      body: {
        object: 'page',
        entry: [{ id: 'page-1', changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: 'page-1', form_id: 'form-e2e' } }] }],
      },
    });
    eq(data.leads, 1, 'the delivery produced no lead');
    REF.metaLeadgen = leadgenId;

    // It should be findable, sourced correctly, and carry its provenance.
    const { data: found } = await req(`/api/search-advanced/lead`, {
      method: 'POST', token: T.admin, expect: 200,
      body: { where: { op: 'AND', children: [{ field: 'source', operator: 'eq', value: 'Facebook Lead Ads' }] }, limit: 50 },
    });
    assert(found.total > 0, 'no Facebook leads exist after the webhook fired');
  });

  await check('Meta re-delivering the same lead does not duplicate it', async () => {
    // Meta retries anything that is not a 200, so this happens routinely.
    const leadgenId = need(REF.metaLeadgen, 'the Meta lead');
    const { data } = await req('/api/webhooks/meta', {
      method: 'POST', expect: 200,
      body: {
        object: 'page',
        entry: [{ id: 'page-1', changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: 'page-1', form_id: 'form-e2e' } }] }],
      },
    });
    eq(data.leads, 0, 'a retry created a second lead');
    eq(data.skipped, 1, 'the retry was not recognised as one');
  });

  await check('a malformed entry does not cost the rest of the batch', async () => {
    // Meta will not resend the good entries, so one bad one must not lose them.
    const { data } = await req('/api/webhooks/meta', {
      method: 'POST', expect: 200,
      body: {
        object: 'page',
        entry: [
          { id: 'p', changes: [{ field: 'not_leadgen', value: {} }] },
          { id: 'p', changes: [{ field: 'leadgen', value: { leadgen_id: `LG-BATCH-${RUN}`, page_id: 'p' } }] },
        ],
      },
    });
    eq(data.leads, 1, 'the good entry in a mixed batch was lost');
    assert(data.skipped >= 1, 'the unknown field was not skipped');
  });

  await check('an unknown sender’s DM is recorded as unmatched, not turned into a lead', async () => {
    // A Messenger id is not a contact detail. A CRM full of records nobody can
    // ring is worse than a missed message.
    const before = (await req('/api/admin/connectors/meta/leads', { token: T.superadmin, expect: 200 })).data.length;
    const { data } = await req('/api/webhooks/meta', {
      method: 'POST', expect: 200,
      body: {
        object: 'page',
        entry: [{ id: 'p', messaging: [{ sender: { id: 'stranger-1' }, recipient: { id: 'page' }, timestamp: Date.now(), message: { mid: `m-${RUN}`, text: 'Hello' } }] }],
      },
    });
    eq(data.messages, 0, 'a stranger’s DM created a record');
    const after = (await req('/api/admin/connectors/meta/leads', { token: T.superadmin, expect: 200 })).data.length;
    eq(after, before, 'the lead count changed on an unmatched DM');
  });

  await check('an ad campaign is created paused, never spending on the button press', async () => {
    const { data } = await req('/api/admin/connectors/meta/campaigns', {
      method: 'POST', token: T.superadmin, expect: 201,
      body: { name: `E2E Meta campaign ${RUN}`, daily_budget: 2500 },
    });
    eq(data.status, 'PAUSED', 'a CRM button started a live ad spend');
    assert(data.id, 'no campaign id returned');
  });

  await check('campaign insights come back in the normalised shape', async () => {
    const { data } = await req('/api/admin/connectors/meta/campaigns/sim-1/insights', {
      token: T.superadmin, expect: 200,
    });
    for (const k of ['impressions', 'clicks', 'leads', 'spend']) {
      assert(typeof data[k] === 'number', `${k} is missing from insights`);
    }
  });

  /* ---- the residency flag ---- */

  await check('Custom Audiences are refused, and the refusal names the conflict', async () => {
    // Not a missing credential — a policy decision. Whoever hits this needs to
    // know which of the two it is.
    // Lists are scoped to whoever owns them, so this makes its own rather than
    // assuming the superadmin happens to own one.
    const { data: made } = await req('/api/lists', {
      method: 'POST', token: T.superadmin, expect: 201,
      /* No kind, so this also pins what an unstated kind produces: a live list,
         which needs a filter and no longer needs a reason for being frozen. */
      body: {
        name: `Audience probe ${RUN}`,
        criteria: { op: 'AND', children: [{ field: 'stage', operator: 'in', value: ['Qualified'] }] },
      },
    });

    const { data } = await req('/api/admin/connectors/meta/audiences', {
      method: 'POST', token: T.superadmin, expect: 409,
      body: { name: 'E2E audience', list_id: made.id },
    });
    eq(data.code, 'audiences_disabled');
    assert(/India/i.test(data.detail ?? ''), 'the refusal does not explain the residency conflict');
  });

  await check('the connector states plainly that nothing leaves India', async () => {
    const { data } = await req('/api/admin/connectors/meta', { token: T.superadmin, expect: 200 });
    eq(data.audiences_enabled, false, 'audiences are on by default — they must not be');
    assert(/no client identifier leaves india/i.test(data.residency_note),
      `residency note is unclear: ${data.residency_note}`);
  });

  await check('connector settings need admin.system', async () => {
    await req('/api/admin/connectors/meta', { token: T.sales_rm, expect: 403 });
    await req('/api/admin/connectors/meta/leads', { token: T.marketing_manager, expect: 403 });
  });

  /* ============================================================ 33 */
  suite('33 Clients (Q-26)');

  await check('a client is its own record, not a lead with a flag', async () => {
    const { data } = await req('/api/clients?limit=5', { token: T.superadmin, expect: 200 });
    assert(Array.isArray(data), 'client list is not an array');
    assert(data.length > 0, 'no clients seeded — the backfill did not run');
    const c = data[0];
    assert(c.client_code, 'a client with no UCC is not a client');
    assert(c.converted_from_lead_id, 'attribution back to the originating lead is missing');
    assert(!('stage' in c), 'a client should not carry a lead stage');
  });

  await check('the list is bounded and reports its true total', async () => {
    const { res, data } = await req('/api/clients?limit=2', { token: T.superadmin, expect: 200 });
    assert(data.length <= 2, `limit ignored: got ${data.length}`);
    const total = Number(res.headers.get('x-total-count'));
    assert(total >= data.length, 'X-Total-Count missing or smaller than the page');
  });

  await check('every route naming a client refuses the other book', async () => {
    /* The read side is covered by bookscope.test.mjs; these are the writes,
       which that test does not reach. Clients came out of this clean — worth
       recording as a result rather than an absence, because the same probe
       found cross-book writes on leads, tasks and cases. */
    const bigul = await login('rm@bigul.test');
    const { data: theirs } = await req('/api/clients?limit=1', { token: bigul, expect: 200 });
    const target = need(theirs[0], 'a BIGUL client');

    await req(`/api/clients/${target.id}`, { token: T.admin, expect: 404 });
    await req(`/api/clients/${target.id}`, {
      method: 'PATCH', token: T.admin, expect: 404, body: { risk_profile: 'Moderate' },
    });
    await req(`/api/clients/${target.id}/reassign`, {
      method: 'POST', token: T.admin, expect: 404, body: { owner_id: 1 },
    });
  });

  await check('an account belongs to whoever holds it, not to whoever asks', async () => {
    // Within one book, the owner rule stands on the writes as well as the read.
    const { data: all } = await req('/api/clients?limit=500', { token: T.admin, expect: 200 });
    const { data: mine } = await req('/api/clients?limit=500', { token: T.sales_rm, expect: 200 });
    const notMine = need(all.find((c) => !mine.some((m) => m.id === c.id)), "a client the RM does not hold");

    await req(`/api/clients/${notMine.id}`, { token: T.sales_rm, expect: 404 });
    await req(`/api/clients/${notMine.id}`, {
      method: 'PATCH', token: T.sales_rm, expect: 404, body: { risk_profile: 'Moderate' },
    });

    // And their own is still editable, or the rule has gone too far.
    if (mine.length) {
      await req(`/api/clients/${mine[0].id}`, {
        method: 'PATCH', token: T.sales_rm, expect: 200,
        body: { risk_profile: mine[0].risk_profile ?? 'Moderate' },
      });
    }
  });

  await check('the timeline says when it is a window rather than the whole history', async () => {
    /* It returns the newest hundred, which is the right thing to show and the
       wrong thing to show silently — an account with four hundred interactions
       looked like an account with a hundred. */
    const { data: list } = await req('/api/clients?limit=1', { token: T.admin, expect: 200 });
    const { data: client } = await req(`/api/clients/${list[0].id}`, { token: T.admin, expect: 200 });

    assert(typeof client.timeline_total === 'number', 'the timeline does not say how long it really is');
    assert(client.timeline_total >= client.timeline.length,
      `the total (${client.timeline_total}) is smaller than what was returned (${client.timeline.length})`);
    assert(client.timeline.length <= 100, 'the timeline returned more than its own cap');
  });

  await check('the account book can be ordered by what it is a book of', async () => {
    /* The columns here are Holdings and Brokerage YTD, so "who are my largest
       clients" is the question this tab exists to answer. It was hard-ordered
       by activated_at, which meant the only way to ask was to export and sort
       somewhere else. */
    const money = (d) => d.map((c) => c.holding_value ?? 0);
    const { data: desc } = await req('/api/clients?sort=holding_value&dir=desc', { token: T.superadmin, expect: 200 });
    const { data: asc } = await req('/api/clients?sort=holding_value&dir=asc', { token: T.superadmin, expect: 200 });
    const down = money(desc);
    eq(JSON.stringify(down), JSON.stringify([...down].sort((a, b) => b - a)), 'descending is not descending');
    eq(JSON.stringify(money(asc)), JSON.stringify([...money(asc)].sort((a, b) => a - b)), 'ascending is not ascending');
  });

  await check('an invented sort column is ignored, not run', async () => {
    // This lands in an ORDER BY, so it comes from a whitelist or not at all.
    const { data } = await req('/api/clients?sort=(SELECT 1)&dir=asc', { token: T.superadmin, expect: 200 });
    assert(Array.isArray(data), 'a bad sort broke the list instead of being ignored');
  });

  await check('the book pages, and the pages do not overlap', async () => {
    const { data: first } = await req('/api/clients?limit=2&offset=0&sort=name&dir=asc', { token: T.superadmin, expect: 200 });
    const { data: second } = await req('/api/clients?limit=2&offset=2&sort=name&dir=asc', { token: T.superadmin, expect: 200 });
    const repeated = second.filter((c) => first.some((f) => f.id === c.id));
    eq(repeated.length, 0, 'the second page repeats rows from the first');
  });

  await check('accounts can be exported, masked, and the export is recorded', async () => {
    /* Clients were the one object with no export at all — leads, cases, tasks
       and partners all had one, and the account book is the revenue. */
    const { data } = await req('/api/clients/export', {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { columns: ['name', 'client_code', 'mobile'] },
    });
    assert(data.csv.startsWith('"Client","UCC","Mobile"'), `unexpected header: ${data.csv.slice(0, 60)}`);
    assert(/"\*{6}\d{4}"/.test(data.csv), 'mobile left in the clear on a masked export');
    eq(data.unmasked, false, 'an export unmasked without being asked to');
  });

  await check('an export takes the filter it was launched from', async () => {
    // What leaves has to be what was on screen. The filters reach the export as
    // the same query string the table was drawn with.
    const { data: all } = await req('/api/clients/export', {
      method: 'POST', token: T.superadmin, expect: 200, body: { columns: ['name'] },
    });
    const { data: narrowed } = await req('/api/clients/export?status=Active', {
      method: 'POST', token: T.superadmin, expect: 200, body: { columns: ['name'] },
    });
    assert(narrowed.rows <= all.rows, 'a filtered export returned more rows than an unfiltered one');
  });

  await check('exporting the book is a permission', async () => {
    /* Customer Care can open every account and can unmask a field on screen,
       and still cannot take the book out as a file. Reading one record and
       extracting the set are different acts. */
    await req('/api/clients/export', {
      method: 'POST', token: T.customer_care, expect: 403,
      body: { columns: ['name', 'mobile'] },
    });
  });

  await check('unmasking is a second decision, recorded separately', async () => {
    /* Note for whoever changes the role matrix: every role holding data.export
       currently also holds pii.unmask, so the 403 on the unmask branch is
       defensive rather than reachable. What is reachable, and what this pins,
       is that identifiers stay masked unless the export explicitly asks —
       being *able* to unmask is not the same as doing it by default. */
    const masked = await req('/api/clients/export', {
      method: 'POST', token: T.sales_supervisor, expect: 200,
      body: { columns: ['name', 'mobile'] },
    });
    eq(masked.data.unmasked, false, 'a supervisor who can unmask got clear identifiers without asking');
    assert(/"\*{6}\d{4}"/.test(masked.data.csv), 'mobile was not masked by default');

    const clear = await req('/api/clients/export', {
      method: 'POST', token: T.sales_supervisor, expect: 200,
      body: { columns: ['name', 'mobile'], unmask: true },
    });
    eq(clear.data.unmasked, true, 'an explicit unmask was ignored');
    assert(!/"\*{6}\d{4}"/.test(clear.data.csv), 'an unmasked export still masked');
  });

  await check('Customer Care sees accounts; Caller, Marketing and Partner RM do not', async () => {
    await req('/api/clients', { token: T.customer_care, expect: 200 });
    // The confirmed Q-26 matrix. A caller works a dial list of prospects, and
    // marketing segments rather than opening account records.
    await req('/api/clients', { token: T.caller, expect: 403 });
    await req('/api/clients', { token: T.marketing_manager, expect: 403 });
    await req('/api/clients', { token: T.partner_rm, expect: 403 });
  });

  await check('a Sales RM sees only their own book', async () => {
    const { data: mine } = await req('/api/clients?limit=500', { token: T.sales_rm, expect: 200 });
    const { data: all } = await req('/api/clients?limit=500', { token: T.superadmin, expect: 200 });
    assert(mine.length < all.length, 'an RM sees the whole book — scope is not applied');
    assert(mine.every((c) => c.owner_id === undefined || c.owner_id !== null),
      'an unowned account leaked into an own-book view');
  });

  await check('org scope holds — Bonanza admin sees no Bigul accounts', async () => {
    const { data } = await req('/api/clients?limit=500', { token: T.admin, expect: 200 });
    assert(data.every((c) => c.sales_org === 'BONANZA'),
      'a Bigul account is visible to a Bonanza admin');
  });

  await check('PII is masked in the list unless unmask is permitted', async () => {
    const { data } = await req('/api/clients?limit=5', { token: T.sales_rm, expect: 200 });
    const withMobile = data.find((c) => c.mobile);
    if (withMobile) assert(/[•*]/.test(withMobile.mobile), `mobile is not masked: ${withMobile.mobile}`);
  });

  await check('dormancy is derived, and filters in SQL', async () => {
    const { data: dormant } = await req('/api/clients?dormant=true&limit=500', { token: T.superadmin, expect: 200 });
    assert(dormant.every((c) => c.activity_status === 'Dormant'),
      'a trading account came back under the dormant filter');
    const { data: summary } = await req('/api/clients/summary', { token: T.superadmin, expect: 200 });
    eq(summary.dormant, dormant.length, 'the summary count and the filtered list disagree');
  });

  await check('the timeline reaches back to the lead without copying it', async () => {
    const { data: list } = await req('/api/clients?limit=500', { token: T.superadmin, expect: 200 });
    const withLead = list.find((c) => c.converted_from_lead_id);
    const { data } = await req(`/api/clients/${withLead.id}`, { token: T.superadmin, expect: 200 });
    assert(Array.isArray(data.timeline), 'no timeline');
    assert(data.origin_lead, 'the originating lead is not linked');

    // The point of the union: pre-conversion entries are visible on the client
    // and still belong to the lead. Mirroring them would be non-negotiable #1.
    const pre = data.timeline.filter((a) => a.origin === 'lead');
    if (pre.length) {
      const { data: leadRows } = await req(`/api/leads/${withLead.converted_from_lead_id}/activities`,
        { token: T.superadmin });
      if (Array.isArray(leadRows)) {
        const ids = new Set(leadRows.map((a) => a.id));
        assert(pre.every((a) => ids.has(a.id)),
          'a pre-conversion entry is not the lead record own row — it was copied');
      }
    }
  });

  await check('an account cannot be handed to someone in the other business', async () => {
    const { data: list } = await req('/api/clients?limit=500', { token: T.superadmin, expect: 200 });
    const bonanza = list.find((c) => c.sales_org === 'BONANZA');
    const { data: users } = await req('/api/admin/users', { token: T.superadmin });
    const bigulUser = (Array.isArray(users) ? users : users?.rows ?? [])
      .find((u) => u.sales_org === 'BIGUL' && u.active);
    if (bonanza && bigulUser) {
      await req(`/api/clients/${bonanza.id}/reassign`, {
        method: 'POST', token: T.superadmin, body: { owner_id: bigulUser.id }, expect: 400,
      });
    }
  });

  await check('converting the same UCC twice does not create a second account', async () => {
    const { data: before } = await req('/api/clients?limit=500', { token: T.superadmin, expect: 200 });
    const codes = before.map((c) => `${c.client_code}|${c.sales_org}`);
    eq(new Set(codes).size, codes.length, 'a UCC is duplicated within one sales org');
  });

  /* ============================================================ 34 */
  suite('34 Lead Lists (BUG-25)');

  let staticList; let dynamicList; let refreshableList;

  await check('the three kinds are declared with what each one means', async () => {
    const { data } = await req('/api/lists/meta', { token: T.admin, expect: 200 });
    const codes = data.kinds.map((k) => k.code).sort();
    eq(codes.join(','), 'dynamic,refreshable,static', 'kinds');
    assert(data.kinds.every((k) => k.help && k.help.length > 20),
      'a kind with no explanation is a kind nobody picks correctly');
  });

  await check('saving a search as a list works', async () => {
    // This answered 500 for its whole life: the route inserted description and
    // created_by, and neither column existed.
    const { data } = await req('/api/search-advanced/lead/to-list', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: `Saved search ${RUN}` },
    });
    assert(data.id, 'no list created');
    assert(data.members > 0, 'the saved search captured nobody');
  });

  await check('a list nobody classified is live, not a snapshot', async () => {
    /* The default is the choice most records end up with. It used to be
       `static`, which meant the path of least effort produced exactly the thing
       the legacy tenant accumulated 4,810 of. */
    const { data: meta } = await req('/api/lists/meta', { token: T.admin, expect: 200 });
    eq(meta.default_kind, 'refreshable', 'the stated default is not the live kind');
    assert(!meta.kinds.find((k) => k.code === meta.default_kind).snapshot,
      'the default kind is a snapshot');

    const { data } = await req('/api/lists', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        name: `Unstated kind ${RUN}`,
        criteria: { op: 'AND', children: [{ field: 'stage', operator: 'in', value: ['Qualified'] }] },
      },
    });
    eq(data.kind, 'refreshable', 'an unstated kind did not come out live');
    // Live, and still able to receive a campaign — which is why the default is
    // refreshable rather than dynamic.
    const { data: full } = await req(`/api/lists/${data.id}`, { token: T.admin, expect: 200 });
    assert(full.campaign_safe, 'the default kind cannot be sent to');
    eq(full.snapshot_reason ?? null, null, 'a live list was made to justify itself');
  });

  await check('an empty kind means the same as no kind at all', async () => {
    // An interface that has not finished loading its metadata sends the field
    // null rather than omitting it, and a destructuring default does not catch
    // that.
    const { data } = await req('/api/lists', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        name: `Null kind ${RUN}`, kind: null,
        criteria: { op: 'AND', children: [{ field: 'stage', operator: 'in', value: ['Qualified'] }] },
      },
    });
    eq(data.kind, 'refreshable', 'an explicit null was not read as unstated');
  });

  await check('an unclassified list with no filter is refused for the right reason', async () => {
    // The refusal has to name the missing filter, not a missing reason — under
    // the old default this same request asked why the list was frozen.
    const { data } = await req('/api/lists', {
      method: 'POST', token: T.admin, expect: 400,
      body: { name: `Nothing stated ${RUN}` },
    });
    assert(/filter/i.test(data.error), `the refusal did not mention a filter: ${data.error}`);
  });

  await check('a filter-driven list refuses to be created without a filter', async () => {
    await req('/api/lists', {
      method: 'POST', token: T.admin, expect: 400,
      body: { name: `No filter ${RUN}`, kind: 'dynamic' },
    });
  });

  await check('static, refreshable and dynamic lists can be created', async () => {
    const mk = async (kind, criteria) => {
      const { data } = await req('/api/lists', {
        method: 'POST', token: T.admin, expect: 201,
        body: {
          name: `${kind} ${RUN}`, kind, criteria,
          // Only a snapshot is asked to justify itself; the other two carry a
          // filter and re-derive, so these two fields are ignored for them.
          snapshot_reason: 'Frozen for the kind-comparison check',
          expires_at: '2030-01-01',
        },
      });
      return data;
    };
    staticList = await mk('static', null);
    dynamicList = await mk('dynamic', { op: 'AND', children: [{ field: 'stage', operator: 'in', value: ['Qualified'] }] });
    refreshableList = await mk('refreshable', { op: 'AND', children: [{ field: 'stage', operator: 'in', value: ['Qualified'] }] });
    assert(refreshableList.member_count > 0, 'refreshable list was created empty');
  });

  await check('a dynamic list re-evaluates, a static one does not', async () => {
    const { data: dyn } = await req(`/api/lists/${dynamicList.id}`, { token: T.admin, expect: 200 });
    const { data: stat } = await req(`/api/lists/${staticList.id}`, { token: T.admin, expect: 200 });
    assert(dyn.member_count > 0, 'dynamic list resolved to nothing');
    eq(stat.member_count, 0, 'a static list created empty should stay empty');
    assert(dyn.criteria_text, 'a dynamic list must be able to say what it matches');
  });

  await check('refresh applies to refreshable lists only', async () => {
    await req(`/api/lists/${refreshableList.id}/refresh`, { method: 'POST', token: T.admin, expect: 200 });
    await req(`/api/lists/${dynamicList.id}/refresh`, { method: 'POST', token: T.admin, expect: 400 });
    await req(`/api/lists/${staticList.id}/refresh`, { method: 'POST', token: T.admin, expect: 400 });
  });

  await check('a refresh records when it ran', async () => {
    const { data } = await req(`/api/lists/${refreshableList.id}`, { token: T.admin, expect: 200 });
    assert(data.last_refreshed_at, 'a refreshable list that cannot say when it last ran is not trustworthy');
    eq(data.refresh_error, null, 'refresh recorded an error');
  });

  await check('a list is not visible to someone it was never shared with', async () => {
    await req(`/api/lists/${dynamicList.id}`, { token: T.sales_rm, expect: 404 });
  });

  await check('sharing a list shows the list, never widens what it yields', async () => {
    // The distinction that matters: sharing grants sight of the QUESTION, and
    // the reader own scope still decides the ANSWER. An RM and an admin
    // opening the same shared list correctly get different row counts.
    const { data: shared } = await req('/api/lists', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        name: `Shared ${RUN}`, kind: 'dynamic',
        criteria: { op: 'AND', children: [{ field: 'stage', operator: 'in', value: ['Qualified'] }] },
        shared_with: ['sales_rm'],
      },
    });

    const { data: asAdmin } = await req(`/api/lists/${shared.id}`, { token: T.admin, expect: 200 });
    const { data: asRm } = await req(`/api/lists/${shared.id}`, { token: T.sales_rm, expect: 200 });

    assert(asRm.member_count < asAdmin.member_count,
      'an RM saw as much as an admin through a shared list - scope is not composed');
    assert(asRm.members.every((m) => m.owner_name === null || m.owner_name !== undefined),
      'member rows are malformed');
  });

  await check('a list carries its own columns, and the rows arrive holding them', async () => {
    // The chooser is only real if the row actually carries the field. Before
    // this the member query selected five fixed columns, so a chooser offering
    // sixteen would have rendered eleven empty ones.
    const { data: saved } = await req(`/api/lists/${staticList.id}/columns`, {
      method: 'PATCH', token: T.admin, expect: 200,
      body: { columns: ['name', 'risk_profile', 'aum', 'next_follow_up_at', 'name'] },
    });
    eq(saved.columns.join(','), 'name,risk_profile,aum,next_follow_up_at',
      'a column ticked twice should be shown once, in the order it was chosen');

    const { data: list } = await req(`/api/lists/${refreshableList.id}`, { token: T.admin, expect: 200 });
    const row = list.members[0];
    for (const key of ['city', 'state', 'language', 'risk_profile', 'aum', 'score', 'next_follow_up_at']) {
      assert(key in row, `a member row cannot be shown in the ${key} column it does not carry`);
    }
  });

  await check('a column nobody defined cannot be chosen', async () => {
    // Straight into a SELECT if it were not filtered.
    await req(`/api/lists/${staticList.id}/columns`, {
      method: 'PATCH', token: T.admin, expect: 400,
      body: { columns: ['name); DROP TABLE leads;--'] },
    });
    const { data } = await req(`/api/lists/${staticList.id}`, { token: T.admin, expect: 200 });
    eq(data.columns.join(','), 'name,risk_profile,aum,next_follow_up_at', 'a refused choice still changed the list');
  });

  await check('columns belong to the list, so a reader cannot rewrite them', async () => {
    // The choice is part of what is shared. Someone the list was shared with
    // sees it and cannot silently change what everyone else sees.
    const { data: shared } = await req('/api/lists', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        name: `Columns ${RUN}`, kind: 'dynamic', shared_with: ['sales_rm'],
        criteria: { op: 'AND', children: [{ field: 'stage', operator: 'in', value: ['Qualified'] }] },
      },
    });
    await req(`/api/lists/${shared.id}/columns`, {
      method: 'PATCH', token: T.sales_rm, expect: 403, body: { columns: ['name'] },
    });
  });

  await check('a big list can be read past its first page', async () => {
    // The table showed a hundred rows of however many there were and said
    // nothing about the rest. On the legacy tenant, lists of 12,519 and 21,379
    // were routine — half a percent of one of those, presented as all of it.
    const { data: first } = await req(`/api/lists/${refreshableList.id}?limit=2`, { token: T.admin, expect: 200 });
    assert(first.member_count > 2, 'the fixture is too small to page through');
    eq(first.shown, 2, 'a page bigger than asked for');
    eq(first.offset, 0, 'the first page does not start at the beginning');
    assert(first.has_more, 'a list longer than its page claims to be complete');

    const { data: next } = await req(`/api/lists/${refreshableList.id}?limit=2&offset=2`, { token: T.admin, expect: 200 });
    const overlap = next.members.filter((m) => first.members.some((f) => f.id === m.id));
    eq(overlap.length, 0, 'the second page repeats rows from the first');
  });

  await check('a list can be ordered by any column it can show', async () => {
    const { data: asc } = await req(`/api/lists/${refreshableList.id}?sort=aum&dir=asc`, { token: T.admin, expect: 200 });
    const { data: desc } = await req(`/api/lists/${refreshableList.id}?sort=aum&dir=desc`, { token: T.admin, expect: 200 });
    const values = (d) => d.members.map((m) => m.aum ?? 0);
    const up = values(asc);
    eq(JSON.stringify(up), JSON.stringify([...up].sort((a, b) => a - b)), 'ascending is not ascending');
    assert(values(desc)[0] >= up[0], 'both directions returned the same order');
  });

  await check('an invented sort column is ignored, not run', async () => {
    // Straight into an ORDER BY if it were not whitelisted.
    const { data } = await req(`/api/lists/${refreshableList.id}?sort=(SELECT 1)`, { token: T.admin, expect: 200 });
    eq(data.sort, null, 'a column nobody defined was accepted as a sort');
  });

  await check('searching inside a list narrows the view and nothing else', async () => {
    const { data: all } = await req(`/api/lists/${refreshableList.id}`, { token: T.admin, expect: 200 });
    const target = all.members[0];
    const { data: hit } = await req(
      `/api/lists/${refreshableList.id}?q=${encodeURIComponent(target.name)}`,
      { token: T.admin, expect: 200 },
    );
    assert(hit.matched >= 1 && hit.matched < all.member_count, 'the search matched everything or nothing');
    /* The property that matters. Every bulk action runs on the whole list, and
       the delete guard compares against member_count — if a search could shrink
       that number, "delete all 900" would fire after somebody searched their
       way down to one row. */
    eq(hit.member_count, all.member_count, 'a search changed the size of the list itself');
  });

  await check('a search cannot shrink what a bulk delete would take', async () => {
    const { data } = await req(`/api/lists/${refreshableList.id}/bulk/delete`, {
      method: 'POST', token: T.admin, expect: 409,
      body: { confirm_count: 1 },
    });
    assert(/not 1$/.test(data.error), `the guard did not name the real count: ${data.error}`);
  });

  await check('membership cannot be edited on a dynamic list', async () => {
    await req(`/api/lists/${dynamicList.id}/members`, {
      method: 'POST', token: T.admin, expect: 400, body: { lead_ids: [1] },
    });
  });

  await check('a campaign may not send to a dynamic list', async () => {
    const { data: campaign } = await req('/api/admin/campaigns', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: `Dynamic guard ${RUN}`, channel: 'sms', list_id: dynamicList.id },
    });
    const { data } = await req(`/api/admin/campaigns/${campaign.id}/send`, {
      method: 'POST', token: T.admin, expect: 409,
    });
    assert(/dynamic/i.test(data.error), `the refusal does not explain itself: ${data.error}`);
  });

  await check('a campaign may send to a refreshable list', async () => {
    const { data: campaign } = await req('/api/admin/campaigns', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: `Refreshable ok ${RUN}`, channel: 'sms', list_id: refreshableList.id },
    });
    await req(`/api/admin/campaigns/${campaign.id}/send`, { method: 'POST', token: T.admin, expect: 200 });
  });

  await check('a bulk send states its consent-filtered count before it runs', async () => {
    const { data } = await req(`/api/lists/${refreshableList.id}/preview`, {
      method: 'POST', token: T.admin, expect: 200, body: { action: 'message', channel: 'sms' },
    });
    eq(data.will_apply + data.suppressed, data.total, 'the preview does not add up');
    assert(data.reasons.every((r) => r.code && r.count > 0), 'suppression reasons are not grouped by code');
  });

  await check('a bulk send suppresses exactly what the preview said it would', async () => {
    const { data: preview } = await req(`/api/lists/${refreshableList.id}/preview`, {
      method: 'POST', token: T.admin, expect: 200, body: { action: 'message', channel: 'sms' },
    });
    const { data: sent } = await req(`/api/lists/${refreshableList.id}/bulk/message`, {
      method: 'POST', token: T.admin, expect: 200,
      body: { channel: 'sms', body: `Suite ${RUN}` },
    });
    eq(sent.sent, preview.will_apply, 'the send reached a different number than the preview promised');
    eq(sent.suppressed, preview.suppressed, 'suppression differed from the preview');
  });

  await check('a bulk stage change applies to every member', async () => {
    const { data } = await req(`/api/lists/${refreshableList.id}/bulk/stage`, {
      method: 'POST', token: T.admin, expect: 200, body: { stage: 'Contacted' },
    });
    assert(data.applied > 0, 'nothing was changed');
  });

  await check('bulk actions respect capability', async () => {
    await req(`/api/lists/${refreshableList.id}/bulk/reassign`, {
      method: 'POST', token: T.caller, expect: 403, body: { owner_id: 1 },
    });
    await req(`/api/lists/${refreshableList.id}/bulk/stage`, {
      method: 'POST', token: T.caller, expect: 403, body: { stage: 'Contacted' },
    });
  });

  await check('a list used by a campaign cannot be deleted out from under it', async () => {
    await req(`/api/lists/${refreshableList.id}`, { method: 'DELETE', token: T.admin, expect: 409 });
  });

  /* ============================================================ 35 */
  suite('35 Dashboard (ENH-24) and Pipeline (BUG-20)');

  await check('the dashboard defaults to month to date', async () => {
    const { data } = await req('/api/dashboard', { token: T.admin, expect: 200 });
    eq(data.range.code, 'mtd', 'default range');
    assert(data.range.from.endsWith('-01'), `MTD must start on the 1st, got ${data.range.from}`);
  });

  await check('the financial year starts in April, not January', async () => {
    const { data } = await req('/api/dashboard?range=fytd', { token: T.admin, expect: 200 });
    const month = data.range.from.slice(5, 7);
    eq(month, '04', `FYTD started in month ${month} - the Indian financial year starts in April`);
  });

  await check('every range resolves and narrows correctly', async () => {
    const seen = {};
    for (const code of ['today', 'mtd', 'qtd', 'fytd']) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/dashboard?range=${code}`, { token: T.admin, expect: 200 });
      eq(data.range.code, code, `range ${code}`);
      seen[code] = data.range.from;
    }
    assert(seen.today >= seen.mtd, 'today should start no earlier than the month');
    assert(seen.mtd >= seen.qtd, 'the month should start no earlier than the quarter');
    assert(seen.qtd >= seen.fytd, 'the quarter should start no earlier than the financial year');
  });

  await check('a wider range cannot show fewer new leads', async () => {
    const count = async (code) => {
      const { data } = await req(`/api/dashboard?range=${code}`, { token: T.admin, expect: 200 });
      return data.tiles.find((t) => t.label === 'New leads')?.value ?? 0;
    };
    const mtd = await count('mtd');
    const fytd = await count('fytd');
    assert(fytd >= mtd, `FYTD (${fytd}) is smaller than MTD (${mtd}) - the range is not widening`);
  });

  await check('tiles that need attention are sorted first', async () => {
    const { data } = await req('/api/dashboard', { token: T.admin, expect: 200 });
    const firstNonAlert = data.tiles.findIndex((t) => !t.alert);
    const lastAlert = data.tiles.map((t) => t.alert).lastIndexOf(true);
    if (firstNonAlert !== -1 && lastAlert !== -1) {
      assert(lastAlert < firstNonAlert, 'an alert tile is sorted below a calm one');
    }
  });

  await check('every dashboard figure is scoped to the reader', async () => {
    const leadsFor = async (token) => {
      const { data } = await req('/api/dashboard?range=fytd', { token, expect: 200 });
      return data.tiles.find((t) => t.label === 'New leads')?.value ?? 0;
    };
    const admin = await leadsFor(T.admin);
    const rm = await leadsFor(T.sales_rm);
    assert(rm <= admin, `an RM saw more leads (${rm}) than an admin (${admin})`);
  });

  await check('each role gets its own layout, and a caller gets the shortest', async () => {
    const tilesFor = async (token) => {
      const { data } = await req('/api/dashboard', { token, expect: 200 });
      return data.tiles.length;
    };
    const caller = await tilesFor(T.caller);
    const admin = await tilesFor(T.admin);
    assert(caller < admin, 'a caller has as many tiles as an admin - the layout is not per role');
    assert(caller > 0, 'a caller got no dashboard at all');
  });

  await check('a linked tile drills through to something real', async () => {
    const { data } = await req('/api/dashboard', { token: T.admin, expect: 200 });
    const linked = data.tiles.filter((t) => t.to);
    assert(linked.length > 0, 'no tile is clickable');
    assert(linked.every((t) => t.to.startsWith('/')), 'a tile points somewhere that is not a route');
  });

  /* ------------------------------------------------------------ pipeline */

  await check('the pipeline returns columns rather than an empty page', async () => {
    // BUG-20: there was no /api/pipeline at all, so the SPA fallback answered
    // the fetch with index.html and the tab rendered nothing.
    const { data } = await req('/api/pipeline', { token: T.admin, expect: 200 });
    assert(Array.isArray(data.columns) && data.columns.length === 5, 'expected five working columns');
    assert(data.total_cards > 0, 'the pipeline is empty - the tab would look broken again');
  });

  await check('the pipeline excludes cards nobody has started', async () => {
    const { data } = await req('/api/pipeline', { token: T.admin, expect: 200 });
    assert(!data.columns.some((c) => c.code === 'INACTIVE'),
      'INACTIVE is the resting state of the whole catalogue and would bury the real pipeline');
  });

  await check('column counts describe the book, not the page', async () => {
    const { data } = await req('/api/pipeline?per_column=1', { token: T.admin, expect: 200 });
    const capped = data.columns.find((c) => c.count > 1);
    if (capped) {
      eq(capped.cards.length, 1, 'per_column was ignored');
      assert(capped.count > capped.cards.length, 'the header count shrank to the page size');
    }
  });

  await check('the pipeline is scoped like everything else', async () => {
    const { data: admin } = await req('/api/pipeline', { token: T.admin, expect: 200 });
    const { data: rm } = await req('/api/pipeline', { token: T.sales_rm, expect: 200 });
    assert(rm.total_cards <= admin.total_cards, 'an RM saw more of the pipeline than an admin');
    assert(admin.columns.every((c) => c.cards.every((card) => card.sales_org === 'BONANZA')),
      'a Bigul card is visible to a Bonanza admin');
  });

  await check('open pipeline excludes what has already converted', async () => {
    const { data } = await req('/api/pipeline', { token: T.admin, expect: 200 });
    const active = data.columns.find((c) => c.code === 'ACTIVE');
    eq(data.won_value, active.value, 'won value does not match the Active column');
    const openSum = data.columns.filter((c) => c.code !== 'ACTIVE').reduce((s, c) => s + c.value, 0);
    eq(data.open_value, openSum, 'open value includes converted cards');
  });

  await check('pipeline cards mask PII', async () => {
    // A Sales RM, not an admin: admins see identifiers in the clear by default
    // (ENH-16), so they are the wrong subject for a masking assertion.
    const { data } = await req('/api/pipeline', { token: T.sales_rm, expect: 200 });
    const withMobile = data.columns.flatMap((c) => c.cards).find((c) => c.mobile);
    if (withMobile) assert(/[•*]/.test(withMobile.mobile), `mobile is not masked: ${withMobile.mobile}`);
  });

  /* ============================================================ 36 */
  suite('36 Tab visibility (ENH-08)');

  const tabsOf = async (token) => {
    const { data } = await req('/api/apps', { token, expect: 200 });
    return (data.all_tabs ?? []).map((t) => t.id);
  };

  await check('the confirmed matrix is what the app actually serves', async () => {
    const { data } = await req('/api/setup/tab-visibility', { token: T.superadmin, expect: 200 });
    const cell = (role, tab) => data.matrix.find((m) => m.role === role)?.tabs[tab]?.visible;

    // The seven cells that were open questions, now confirmed.
    eq(cell('marketing_manager', 'leads'), true, 'marketing should see Leads');
    eq(cell('sales_supervisor', 'partners'), true, 'a supervisor should see Partners');
    eq(cell('customer_care', 'market'), false, 'a service agent offering a market view is unsolicited advice');
    eq(cell('marketing_manager', 'market'), true, 'marketing times campaigns off market events');
    eq(cell('customer_care', 'team'), false, 'customer_care is an agent role, not a supervisor');
    eq(cell('customer_care', 'incentives'), false, 'a service agent would see zero forever');
    eq(cell('customer_care', 'kra'), true, 'service is measured on CSAT and response time');
    eq(cell('sales_rm', 'revenue'), true, 'an RM sees their own numbers');
    eq(cell('sales_rm', 'reports'), true, 'an RM sees their own reports');
  });

  await check('four roles approve, and Partner RM only watches', async () => {
    const { data } = await req('/api/setup/tab-visibility', { token: T.superadmin, expect: 200 });
    const sees = (role) => data.matrix.find((m) => m.role === role)?.tabs.approvals?.visible;
    for (const role of ['superadmin', 'admin', 'sales_supervisor', 'product_supervisor']) {
      eq(sees(role), true, `${role} should see Approvals`);
    }
    // Partner RM raises and tracks, but the capability to approve is separate.
    eq(sees('partner_rm'), true, 'Partner RM should still track their own requests');
    eq(sees('caller'), false, 'a caller approves nothing');
  });

  await check('the screen says plainly that this is not security', async () => {
    const { data } = await req('/api/setup/tab-visibility', { token: T.superadmin, expect: 200 });
    assert(/not security/i.test(data.note), `the note does not say it: ${data.note}`);
  });

  await check('a role-level change reaches the navigation payload', async () => {
    const before = await tabsOf(T.customer_care);
    assert(before.includes('tickets'), 'Customer Care should start with Cases');

    await req('/api/setup/tab-visibility/role', {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { role: 'customer_care', tab_id: 'tickets', visible: false },
    });

    const after = await tabsOf(await login('care@bonanza.test'));
    assert(!after.includes('tickets'), 'hiding Cases at role level did nothing');
  });

  await check('a per-user override beats the role', async () => {
    const { data: users } = await req('/api/setup/users', { token: T.superadmin });
    const list = Array.isArray(users) ? users : users?.users ?? users?.rows ?? [];
    const care = list.find((u) => u.email === 'care@bonanza.test');

    await req(`/api/setup/users/${care.id}/tabs`, {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { tab_id: 'tickets', visible: true },
    });

    const tabs = await tabsOf(await login('care@bonanza.test'));
    assert(tabs.includes('tickets'), 'the per-user override did not win over the role');

    const { data: detail } = await req(`/api/setup/users/${care.id}/tabs`, { token: T.superadmin, expect: 200 });
    const cell = detail.tabs.find((t) => t.id === 'tickets');
    eq(cell.source, 'user', 'the source should name the override');
    eq(cell.role_default, false, 'the role default should still read hidden');
  });

  await check('resetting an override falls back to the role, not to visible', async () => {
    const { data: users } = await req('/api/setup/users', { token: T.superadmin });
    const list = Array.isArray(users) ? users : users?.users ?? users?.rows ?? [];
    const care = list.find((u) => u.email === 'care@bonanza.test');

    await req(`/api/setup/users/${care.id}/tabs`, {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { tab_id: 'tickets', visible: null },
    });

    const tabs = await tabsOf(await login('care@bonanza.test'));
    assert(!tabs.includes('tickets'),
      'reset restored the tab instead of following the role - reset and grant are different decisions');

    // Put the role back so later suites see the shipped world.
    await req('/api/setup/tab-visibility/role', {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { role: 'customer_care', tab_id: 'tickets', visible: null },
    });
  });

  await check('every change is written to the configuration audit log', async () => {
    const { data } = await req('/api/setup/config-audit?limit=50', { token: T.superadmin, expect: 200 });
    const rows = Array.isArray(data) ? data : data?.rows ?? [];
    const tabRows = rows.filter((r) => r.area === 'tabs');
    assert(tabRows.length > 0, 'no tab change was audited');
    assert(tabRows.some((r) => r.before_json && r.after_json),
      'an audit row with no before and after cannot answer "who changed this"');
  });

  await check('hiding a tab does not restrict the API behind it', async () => {
    // The point the Setup screen makes in words, proven in behaviour: navigation
    // is not access control, and the capability check is what actually holds.
    await req('/api/setup/tab-visibility/role', {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { role: 'sales_rm', tab_id: 'leads', visible: false },
    });

    const rmToken = await login('salesrm@bonanza.test');
    const tabs = await tabsOf(rmToken);
    assert(!tabs.includes('leads'), 'the tab should be hidden');
    // …and the endpoint still works, because it was never the tab protecting it.
    await req('/api/leads?limit=1', { token: rmToken, expect: 200 });

    await req('/api/setup/tab-visibility/role', {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { role: 'sales_rm', tab_id: 'leads', visible: null },
    });
  });

  await check('an unknown tab is refused rather than stored', async () => {
    await req('/api/setup/tab-visibility/role', {
      method: 'POST', token: T.superadmin, expect: 400,
      body: { role: 'sales_rm', tab_id: 'not_a_tab', visible: true },
    });
  });

  await check('editing the matrix needs admin.roles', async () => {
    await req('/api/setup/tab-visibility', { token: T.sales_rm, expect: 403 });
    await req('/api/setup/tab-visibility/role', {
      method: 'POST', token: T.sales_rm, expect: 403,
      body: { role: 'caller', tab_id: 'setup', visible: true },
    });
  });

  await check('the roles table is not full of test leftovers', async () => {
    // Every e2e run creates a custom role to prove it can; nothing removed them,
    // and 76 had accumulated - which the ENH-08 grid would have rendered.
    const { data } = await req('/api/setup/roles', { token: T.superadmin, expect: 200 });
    const roles = Array.isArray(data) ? data : data?.roles ?? [];
    const orphans = roles.filter((r) => /^regional_sup_\d+$/.test(r.code));
    assert(orphans.length <= 1,
      `${orphans.length} leftover test roles - seed.js should clear non-system roles`);
  });

  /* ============================================================ 37 */
  suite('37 Dispositions in Setup (ENH-21c)');

  await check('the outcomes are configuration, with their effects visible', async () => {
    const { data } = await req('/api/setup/dispositions', { token: T.admin, expect: 200 });
    assert(data.dispositions.length >= 20, 'the shipped matrix is missing');
    eq(data.outcomes.includes('Connected'), true, 'Connected is missing');
    eq(data.outcomes.includes('Not Connected'), true, 'Not Connected is missing');
    // The effects are what make this a business decision rather than a rename.
    const callback = data.dispositions.find((d) => d.code === 'CALL_CALLBACK');
    eq(callback.requires_datetime, 1, 'Callback Requested must compel a date');
  });

  await check('an edit is recorded as the business owning that row', async () => {
    const { data: before } = await req('/api/setup/dispositions', { token: T.admin, expect: 200 });
    const row = before.dispositions.find((d) => d.code === 'CALL_PITCH_DONE');
    eq(row.edited_at, null, 'a shipped row should start unedited');

    const { data } = await req(`/api/setup/dispositions/${row.id}`, {
      method: 'PATCH', token: T.admin, expect: 200,
      body: { label: `Pitch delivered ${RUN}`, hint: 'Say what they pushed back on.' },
    });
    eq(data.label, `Pitch delivered ${RUN}`, 'the label did not change');
    assert(data.edited_at, 'the row was not marked as edited');
  });

  await check('re-running the seeder does not revert an edit', async () => {
    // The whole point of ENH-21c: seedDispositions() runs on every boot, and
    // before this it overwrote every column -- so a change made in Setup would
    // silently revert at the next restart and the screen would be a lie.
    const { data: check1 } = await req('/api/setup/dispositions', { token: T.admin, expect: 200 });
    const row = check1.dispositions.find((d) => d.code === 'CALL_PITCH_DONE');
    assert(row.label.startsWith('Pitch delivered'), 'the edit did not persist');

    const untouched = check1.dispositions.find((d) => d.code !== 'CALL_PITCH_DONE' && !d.edited_at);
    assert(untouched, 'every row is marked edited - the seeder is not managing any of them');
  });

  await check('a disposition drives what the RM is actually asked for', async () => {
    // The obligation is enforced where it matters, not only displayed in Setup.
    const { data: leads } = await req('/api/leads?limit=1', { token: T.admin, expect: 200 });
    const leadId = leads[0].id;
    await req('/api/activities', {
      method: 'POST', token: T.admin, expect: 400,
      body: { lead_id: leadId, type: 'Call', outcome: 'Connected', sub_disposition: 'CALL_CALLBACK' },
    });
  });

  await check('an unknown card state is refused rather than stored', async () => {
    const { data } = await req('/api/setup/dispositions', { token: T.admin, expect: 200 });
    const row = data.dispositions[0];
    await req(`/api/setup/dispositions/${row.id}`, {
      method: 'PATCH', token: T.admin, expect: 400,
      body: { sets_card_state: 'NOT_A_STATE' },
    });
  });

  await check('a new outcome can be added and appears in the picker', async () => {
    const code = `E2E_OUTCOME_${RUN}`;
    const { data } = await req('/api/setup/dispositions', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        code, label: 'Asked for a brochure', activity_type: 'Call',
        outcome: 'Connected', requires_datetime: false,
      },
    });
    eq(data.is_custom, 1, 'a hand-made outcome should be marked as yours');

    const { data: meta } = await req('/api/activities/meta', { token: T.admin, expect: 200 });
    const calls = meta.dispositions?.Call ?? [];
    const connected = calls.find((g) => g.outcome === 'Connected');
    assert(connected.options.some((o) => o.code === code), 'the new outcome never reached the picker');
  });

  await check('retiring keeps history readable instead of deleting it', async () => {
    const { data } = await req('/api/setup/dispositions', { token: T.admin, expect: 200 });
    const row = data.dispositions.find((d) => d.code === `E2E_OUTCOME_${RUN}`);
    const { data: gone } = await req(`/api/setup/dispositions/${row.id}`, {
      method: 'DELETE', token: T.admin, expect: 200,
    });
    eq(gone.retired, true, 'it should retire, not delete');

    const { data: after } = await req('/api/setup/dispositions', { token: T.admin, expect: 200 });
    const still = after.dispositions.find((d) => d.code === `E2E_OUTCOME_${RUN}`);
    assert(still, 'the row was deleted - activities referencing it would be unreadable');
    eq(still.active, 0, 'it should be inactive');
  });

  await check('editing outcomes needs admin.rules', async () => {
    await req('/api/setup/dispositions', { token: T.sales_rm, expect: 403 });
  });

  /* ============================================================ 38 */
  suite('38 Field masking (ENH-16)');

  const firstLead = async (token) => {
    const { data } = await req('/api/leads?limit=1', { token, expect: 200 });
    return data[0];
  };

  await check('Admin and Superadmin see every identifier in the clear', async () => {
    for (const token of [T.superadmin, T.admin]) {
      // eslint-disable-next-line no-await-in-loop
      const lead = await firstLead(token);
      assert(!/\u2022/.test(String(lead.mobile ?? '')), `mobile is masked: ${lead.mobile}`);
      assert(!/\u2022/.test(String(lead.email ?? '')), `email is masked: ${lead.email}`);
    }
  });

  await check('Marketing gets the email it needs and nothing it does not', async () => {
    // The default was reconsidered: this role segments and sends, so it needs an
    // address to run a campaign and no reason to read a PAN or ring anybody.
    const lead = await firstLead(T.marketing_manager);
    assert(!/\u2022/.test(String(lead.email ?? '')), `email should be clear: ${lead.email}`);
    if (lead.mobile) assert(/\u2022/.test(lead.mobile), `mobile should be masked: ${lead.mobile}`);

    const { data: detail } = await req(`/api/leads/${lead.id}`, { token: T.marketing_manager, expect: 200 });
    if (detail.pan) assert(/[\u2022*]/.test(detail.pan), `PAN should be masked: ${detail.pan}`);
  });

  await check('everybody else still sees dots', async () => {
    for (const token of [T.sales_rm, T.caller]) {
      // eslint-disable-next-line no-await-in-loop
      const lead = await firstLead(token);
      if (lead?.mobile) assert(/\u2022/.test(lead.mobile), `mobile is not masked: ${lead.mobile}`);
    }
  });

  await check('the matrix reports where each answer came from', async () => {
    const { data } = await req('/api/setup/field-masking', { token: T.admin, expect: 200 });
    const marketing = data.matrix.find((m) => m.role === 'marketing_manager');
    eq(marketing.fields.pan.masked, true, 'marketing should not see a PAN by default');
    eq(marketing.fields.mobile.masked, true, 'marketing should not see a mobile by default');
    eq(marketing.fields.email.masked, false, 'marketing needs the email address to send');
    eq(marketing.fields.pan.source, 'default', 'nothing has been configured yet');
    const caller = data.matrix.find((m) => m.role === 'caller');
    eq(caller.fields.pan.masked, true, 'a caller should start masked');
  });

  await check('masking one field for one role takes effect immediately', async () => {
    // Unmasking, this time: mobile is masked for Marketing by default, so this
    // proves the configuration can open a field as well as close one.
    await req('/api/setup/field-masking', {
      method: 'POST', token: T.admin, expect: 200,
      body: { role: 'marketing_manager', field: 'mobile', masked: false },
    });

    const lead = await firstLead(await login('marketing@bonanza.test'));
    assert(!/\u2022/.test(String(lead.mobile ?? '')), 'the mobile should now be visible');
    // …and only that field. A blunt on/off would have opened the PAN too.
    const { data: detail } = await req(`/api/leads/${lead.id}`, { token: await login('marketing@bonanza.test'), expect: 200 });
    if (detail.pan) assert(/[\u2022*]/.test(detail.pan), `PAN should still be masked: ${detail.pan}`);

    await req('/api/setup/field-masking', {
      method: 'POST', token: T.admin, expect: 200,
      body: { role: 'marketing_manager', field: 'mobile', masked: null },
    });
  });

  await check('resetting returns the field to the shipped default', async () => {
    await req('/api/setup/field-masking', {
      method: 'POST', token: T.admin, expect: 200,
      body: { role: 'marketing_manager', field: 'mobile', masked: null },
    });
    const lead = await firstLead(await login('marketing@bonanza.test'));
    // The shipped default for this role and field is now MASKED, so a reset has
    // to return it to masked -- not to visible. Reset means "follow the
    // default", whatever the default happens to be.
    if (lead.mobile) assert(/\u2022/.test(lead.mobile), 'reset did not restore the default');
  });

  await check('masking applies everywhere a lead is served, not only the list', async () => {
    const token = await login('marketing@bonanza.test');
    const lead = await firstLead(token);
    const { data: detail } = await req(`/api/leads/${lead.id}`, { token, expect: 200 });

    // Both halves, deliberately. Asserting only that a masked field is masked
    // is satisfied by an endpoint that masks EVERYTHING -- which is exactly what
    // the lead detail route was doing, so this test passed while the per-field
    // rules were not reaching it at all. The clear field is the real check.
    assert(/\u2022/.test(String(detail.mobile ?? '')), 'the detail view leaked an unmasked mobile');
    assert(!/\u2022/.test(String(detail.email ?? '')),
      `the detail view masked a field this role should see: ${detail.email}`);

    const { data: search } = await req('/api/search?q=a', { token, expect: 200 });
    const hit = (search.groups?.Leads ?? []).find((l) => l.mobile);
    if (hit) assert(/\u2022/.test(hit.mobile), 'global search leaked an unmasked mobile');

  });

  await check('an unmaskable field is refused', async () => {
    await req('/api/setup/field-masking', {
      method: 'POST', token: T.admin, expect: 400,
      body: { role: 'caller', field: 'name', masked: true },
    });
  });

  await check('configuring masking needs admin.users', async () => {
    await req('/api/setup/field-masking', { token: T.sales_rm, expect: 403 });
    await req('/api/setup/field-masking', {
      method: 'POST', token: T.sales_rm, expect: 403,
      body: { role: 'caller', field: 'pan', masked: false },
    });
  });

  await check('an explicit unmask is still audited for a masked role', async () => {
    const lead = await firstLead(T.sales_rm);
    const { data } = await req(`/api/leads/${lead.id}?unmask=true`, { token: T.sales_rm, expect: 200 });
    // Sales RM holds pii.unmask, so the request succeeds and leaves a trail --
    // which is the point of keeping the two mechanisms separate.
    assert(!/\u2022/.test(String(data.mobile ?? '')), 'an explicit unmask did not reveal the value');
  });

  /* ============================================================ 39 */
  suite('39 Market ticker and navigation (ENH-03, ENH-04, ENH-09, ENH-23b)');

  const featuresFor = async (token) => {
    const { data } = await req('/api/apps', { token, expect: 200 });
    return data.features ?? {};
  };

  await check('the ticker is a feature roles can be granted or denied', async () => {
    const rm = await featuresFor(T.sales_rm);
    eq(rm.market_ticker, true, 'a Sales RM should see the ticker');
    // A service agent offering a view on a price move is unsolicited advice.
    const care = await featuresFor(T.customer_care);
    eq(care.market_ticker, false, 'Customer Care should not see the ticker');
    const marketing = await featuresFor(T.marketing_manager);
    eq(marketing.market_ticker, true, 'Marketing times campaigns off market events');
  });

  await check('the ticker can be switched off for a role and switched back', async () => {
    await req('/api/setup/tab-visibility/role', {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { role: 'sales_rm', tab_id: 'market_ticker', visible: false },
    });
    eq((await featuresFor(await login('salesrm@bonanza.test'))).market_ticker, false,
      'turning it off at role level did nothing');

    await req('/api/setup/tab-visibility/role', {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { role: 'sales_rm', tab_id: 'market_ticker', visible: null },
    });
    eq((await featuresFor(await login('salesrm@bonanza.test'))).market_ticker, true,
      'reset did not restore the default');
  });

  await check('one person can be excepted from their role', async () => {
    const { data: users } = await req('/api/setup/users', { token: T.superadmin });
    const list = Array.isArray(users) ? users : users?.users ?? [];
    const rm = list.find((u) => u.email === 'salesrm@bonanza.test');

    await req(`/api/setup/users/${rm.id}/tabs`, {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { tab_id: 'market_ticker', visible: false },
    });
    eq((await featuresFor(await login('salesrm@bonanza.test'))).market_ticker, false,
      'the per-user exception did not apply');

    await req(`/api/setup/users/${rm.id}/tabs`, {
      method: 'POST', token: T.superadmin, expect: 200,
      body: { tab_id: 'market_ticker', visible: null },
    });
  });

  await check('the ticker appears in the Setup grid, marked as a feature', async () => {
    const { data } = await req('/api/setup/tab-visibility', { token: T.superadmin, expect: 200 });
    const row = data.tabs.find((t) => t.id === 'market_ticker');
    assert(row, 'the ticker is not configurable in Setup');
    eq(row.kind, 'feature', 'it should be marked a feature, not a destination');
    // …and it must not be offered as somewhere to navigate.
    const { data: apps } = await req('/api/apps', { token: T.superadmin, expect: 200 });
    assert(!(apps.all_tabs ?? []).some((t) => t.id === 'market_ticker'),
      'the ticker was offered as a tab - it has no page');
  });

  await check('every news item carries a link field for the live feed', async () => {
    const { data } = await req('/api/market/news', { token: T.admin, expect: 200 });
    assert(Array.isArray(data.news) && data.news.length > 0, 'no news served');
    // Simulated items have no article to point at, and say so by being null
    // rather than by carrying a URL that goes nowhere.
    assert(data.news.every((n) => 'url' in n), 'news items have no url field at all');
  });

  await check('the App Launcher only ever offers what the role can open (ENH-23b)', async () => {
    for (const role of ['caller', 'customer_care', 'marketing_manager']) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req('/api/apps', { token: T[role], expect: 200 });
      const ids = (data.all_tabs ?? []).map((t) => t.id);
      assert(!ids.includes('setup'), `${role} was offered Setup`);
      // Every tab offered must belong to an app that was also offered.
      const fromApps = new Set(data.apps.flatMap((a) => a.tabs.map((t) => t.id)));
      assert(ids.every((id) => fromApps.has(id)),
        `${role} was offered a tab that belongs to no app they have`);
    }
  });

  /* ============================================================ 40 */
  suite('40 Product actions (ENH-10b, ENH-10c, ENH-10d)');

  const anyCard = async (token, wanted) => {
    const { data: leads } = await req('/api/leads?limit=40', { token, expect: 200 });
    for (const l of leads) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/leads/${l.id}`, { token, expect: 200 });
      const hit = (data.cards ?? []).find((c) => (wanted ? c.state === wanted : true));
      if (hit) return hit;
    }
    return null;
  };

  await check('a product card says what to do next, and why', async () => {
    const card = await anyCard(T.admin);
    const { data } = await req(`/api/cards/${card.id}/detail`, { token: T.admin, expect: 200 });
    assert(data.next, 'no directive at all');
    assert(data.next.headline && data.next.headline.length > 8,
      `the headline names no step: ${data.next.headline}`);
    assert(data.next.why && data.next.why.length > 12, 'the directive gives no reason');
    // "Move Forward" was the complaint: a direction with no step in it.
    assert(!/^move forward$/i.test(data.next.headline), 'the headline is still a direction, not a step');
  });

  await check('every state has its own next step', async () => {
    const seen = new Map();
    const { data: leads } = await req('/api/leads?limit=40', { token: T.admin, expect: 200 });
    for (const l of leads.slice(0, 8)) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/leads/${l.id}`, { token: T.admin, expect: 200 });
      for (const c of data.cards ?? []) {
        if (seen.has(c.state)) continue;
        // eslint-disable-next-line no-await-in-loop
        const { data: det } = await req(`/api/cards/${c.id}/detail`, { token: T.admin, expect: 200 });
        seen.set(c.state, det.next.headline);
      }
    }
    assert(seen.size >= 3, `only ${seen.size} states seen`);
    // Two different states giving identical advice would mean the directive is
    // not actually reading the state.
    eq(new Set(seen.values()).size, seen.size, 'two states share a headline');
  });

  await check('the directive marks an action the role cannot perform', async () => {
    const card = await anyCard(T.product_rm, 'WARM');
    if (!card) return;
    const { data } = await req(`/api/cards/${card.id}/detail`, { token: T.product_rm, expect: 200 });
    // A Product RM cannot raise a request for a Product RM. Saying so is
    // information; hiding it leaves an empty panel and a puzzle.
    if (data.next.primary && !data.next.primary.allowed) {
      assert(data.next.primary.blocked_reason, 'blocked with no reason given');
    }
  });

  await check('the panel carries the whole picture in one request (ENH-10c)', async () => {
    const card = await anyCard(T.admin);
    const { data } = await req(`/api/cards/${card.id}/detail`, { token: T.admin, expect: 200 });
    for (const key of ['pitch_points', 'objections', 'activities', 'history', 'channels', 'next']) {
      assert(key in data, `the panel would have to make a second call for ${key}`);
    }
    assert(Array.isArray(data.pitch_points), 'pitch points did not parse');
    assert(Array.isArray(data.objections), 'objections did not parse');
    assert(data.product_name && data.lead_name, 'the panel cannot title itself');
  });

  await check('quick actions are consent-checked before they are offered (ENH-10d)', async () => {
    const card = await anyCard(T.admin);
    const { data } = await req(`/api/cards/${card.id}/detail`, { token: T.admin, expect: 200 });
    const channels = data.channels.map((c) => c.channel).sort();
    eq(channels.join(','), 'call,email,sms,whatsapp', 'not every channel is offered');
    // A channel that is refused must say why, so the button can be disabled
    // with a reason rather than failing after the click.
    for (const c of data.channels) {
      if (!c.allowed) assert(c.reason, `${c.channel} is blocked with no reason`);
    }
  });

  await check('alternatives are legal transitions, never a free-for-all', async () => {
    const card = await anyCard(T.admin, 'ACTIVE');
    if (!card) return;
    const { data } = await req(`/api/cards/${card.id}/detail`, { token: T.admin, expect: 200 });
    const alts = data.next.alternatives.map((a) => a.to);
    // An active account should not offer a jump straight back to Exploring.
    assert(!alts.includes('EXPLORING'), 'an Active card offered a move to Exploring');
  });

  await check('a stale card changes its advice, not its step', async () => {
    const { data: leads } = await req('/api/leads?limit=40', { token: T.admin, expect: 200 });
    let stale = null;
    for (const l of leads) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/leads/${l.id}`, { token: T.admin, expect: 200 });
      for (const c of data.cards ?? []) {
        if (stale) break;
        // eslint-disable-next-line no-await-in-loop
        const { data: det } = await req(`/api/cards/${c.id}/detail`, { token: T.admin, expect: 200 });
        if (det.next.urgent) stale = det;
      }
      if (stale) break;
    }
    if (stale) {
      assert(/No movement in \d+ days/.test(stale.next.why),
        `an urgent card does not say how long it has been sitting: ${stale.next.why}`);
    }
  });

  await check('the card detail obeys lead scope', async () => {
    const card = await anyCard(T.admin);
    // A caller can only see their own leads, so an admin-visible card is very
    // likely outside their book — either 404, or a card they legitimately own.
    const { status } = await req(`/api/cards/${card.id}/detail`, { token: T.caller });
    assert([200, 404].includes(status), `unexpected status ${status}`);
  });

  /* ============================================================ 41 */
  suite('41 Email composer (ENH-06)');

  const leadWithEmail = async (token) => {
    const { data } = await req('/api/leads?limit=40', { token, expect: 200 });
    return data.find((l) => l.email);
  };

  await check('the composer arrives with everything it needs in one call', async () => {
    const lead = await leadWithEmail(T.admin);
    const { data } = await req(`/api/email/compose/${lead.id}`, { token: T.admin, expect: 200 });
    assert(data.lead?.email, 'no address to send to');
    assert(Array.isArray(data.templates), 'no templates');
    assert(Array.isArray(data.library), 'no content library');
    assert(data.limits?.max_attachment_bytes > 0, 'no attachment limit declared');
    assert('allowed' in (data.consent ?? {}), 'consent was not resolved');
  });

  await check('only approved templates are offered', async () => {
    const lead = await leadWithEmail(T.admin);
    const { data } = await req(`/api/email/compose/${lead.id}`, { token: T.admin, expect: 200 });
    // An unapproved template reaching a client is the thing the approval flag
    // exists to prevent, so the composer must not be a way around it.
    const { data: everything } = await req('/api/admin/templates', { token: T.admin });
    const all = Array.isArray(everything) ? everything : everything?.templates ?? [];
    const unapproved = all.filter((t) => t.channel === 'email' && !t.approved).map((t) => t.id);
    assert(!data.templates.some((t) => unapproved.includes(t.id)),
      'an unapproved template was offered');
  });

  await check('an email sends, merges and lands on the timeline', async () => {
    const lead = await leadWithEmail(T.admin);
    const { data } = await req('/api/email/send', {
      method: 'POST', token: T.admin, expect: 200,
      body: {
        lead_id: lead.id,
        subject: `Your {{org}} account ${RUN}`,
        body: 'Dear {{name}},\n\nRegards,\n{{rm}}',
      },
    });
    assert(data.ok, 'send failed');
    assert(data.activity_id, 'nothing was logged');

    const { data: acts } = await req(`/api/activities?lead_id=${lead.id}`, { token: T.admin, expect: 200 });
    const logged = acts.find((a) => a.id === data.activity_id);
    assert(logged, 'the email is not on the lead timeline');
    eq(logged.type, 'Email', 'logged under the wrong type');

    /* Once, not twice. Finding the activity by id says it was written; it does
       not say it was written once, and both the composer and send() used to
       write their own. A mirrored interaction is the first non-negotiable in
       CLAUDE.md, and the shape the LeadSquared audit spent findings on. */
    const mine = acts.filter((a) => a.type === 'Email' && a.subject === logged.subject);
    eq(mine.length, 1, `the email landed on the timeline ${mine.length} times`);
    assert(!logged.subject.includes('{{'), `merge fields survived into the subject: ${logged.subject}`);
    assert(!logged.body.includes('{{'), 'merge fields survived into the body');
  });

  await check('a withdrawn or expired document cannot be attached', async () => {
    const lead = await leadWithEmail(T.admin);
    await req('/api/email/send', {
      method: 'POST', token: T.admin, expect: 400,
      body: { lead_id: lead.id, subject: 's', body: 'b', content_ids: [999999] },
    });
  });

  await check('an executable cannot be emailed to a client', async () => {
    const lead = await leadWithEmail(T.admin);
    const { data } = await req('/api/email/send', {
      method: 'POST', token: T.admin, expect: 400,
      body: {
        lead_id: lead.id, subject: 's', body: 'b',
        attachments: [{ name: 'payload.exe', type: 'application/x-msdownload', data: 'AAAA' }],
      },
    });
    assert(/cannot be emailed/i.test(data.error), `unhelpful refusal: ${data.error}`);
  });

  await check('an oversized attachment is refused', async () => {
    const lead = await leadWithEmail(T.admin);
    // Over the body limit, so express.json() refuses it before any route runs.
    // The point of the assertion is that it comes back as a clear 413 rather
    // than the opaque 500 it used to be.
    const big = 'A'.repeat(7 * 1024 * 1024);
    await req('/api/email/send', {
      method: 'POST', token: T.admin, expect: 413,
      body: {
        lead_id: lead.id, subject: 's', body: 'b',
        attachments: [{ name: 'huge.pdf', type: 'application/pdf', data: big }],
      },
    });
  });

  await check('consent is enforced on the way out', async () => {
    const { data: leads } = await req('/api/leads?limit=100', { token: T.admin, expect: 200 });
    const opted = leads.find((l) => l.no_email || l.marketing_opt_out);
    if (!opted) return;
    const { status, data } = await req('/api/email/send', {
      method: 'POST', token: T.admin,
      body: { lead_id: opted.id, subject: 's', body: 'b', intent: 'marketing' },
    });
    if (status === 409) assert(data.error, 'refused with no reason');
  });

  await check('emailing needs lead.contact, and scope still applies', async () => {
    const lead = await leadWithEmail(T.admin);
    await req('/api/email/send', {
      method: 'POST', token: T.marketing_manager, expect: 403,
      body: { lead_id: lead.id, subject: 's', body: 'b' },
    });
    // A lead outside the caller's book is a 404, not a 403 — the composer must
    // not become a way to confirm a record exists.
    const { status } = await req(`/api/email/compose/${lead.id}`, { token: T.caller });
    assert([200, 404].includes(status), `unexpected status ${status}`);
  });

  /* ============================================================ 42 */
  suite('42 Advanced Search usability (ENH-15)');

  await check('product interests are scoped through the lead they hang off', async () => {
    /* The seventh object with this exact problem: product_cards carries no
       sales_org, so the generic branch found no column and returned no scope. A
       Caller read all 570 cards, 118 of them on Bigul leads. */
    const { data: all } = await req('/api/search-advanced/product_interest', {
      method: 'POST', token: T.superadmin, expect: 200, body: { where: null },
    });
    const { data: caller } = await req('/api/search-advanced/product_interest', {
      method: 'POST', token: T.caller, expect: 200, body: { where: null },
    });
    assert(caller.total < all.total,
      `a caller saw every product card in the system (${caller.total} of ${all.total})`);
    assert(caller.total > 0, 'the scope refused a caller everything, which is not the rule either');
  });

  await check('an object with no scope of its own returns nothing, not everything', async () => {
    /* The generic branch used to answer "I cannot work out what you may see"
       with "then see everything" — three separate ways: an unrecognised entity,
       a table with no sales_org, and a user with no orgs. Two of those went
       unnoticed for as long as the objects had been searchable, because a
       missing scope looks exactly like a working one until somebody counts.

       Checked from the outside, since scopeFor is not exported: every
       searchable object either has a branch of its own or a sales_org column,
       and a superadmin — who is refused nothing anywhere else — must be able to
       see rows in each. An object that fell through to the refusal would come
       back empty for them and fail here. */
    const { data: objects } = await req('/api/search-advanced/objects', { token: T.superadmin, expect: 200 });
    assert(objects.length >= 7, `only ${objects.length} searchable objects offered`);

    for (const o of objects) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/search-advanced/${o.key}`, {
        method: 'POST', token: T.superadmin, expect: 200, body: { where: null },
      });
      assert(data.total > 0,
        `${o.key} returned nothing to a superadmin — it has no scope of its own and fell through to the refusal`);
    }
  });

  await check('tasks and interactions are scoped at all', async () => {
    /* Neither table carries a sales_org column, and the generic branch in
       scopeFor gives up when it cannot find one — returning no scope rather
       than failing closed. So advanced search over these two returned every
       task and every interaction in the system, both books, to anybody signed
       in: 194 interactions with their subjects, bodies, dispositions, recording
       URLs and captured locations, and 46 tasks each labelled with its lead's
       name. Both hang off a lead, and a lead carries the book. */
    const { data: allTasks } = await req('/api/search-advanced/task', {
      method: 'POST', token: T.superadmin, expect: 200, body: { where: null },
    });
    const { data: callerTasks } = await req('/api/search-advanced/task', {
      method: 'POST', token: T.caller, expect: 200, body: { where: null },
    });
    assert(callerTasks.total < allTasks.total,
      `a caller saw every task in the system (${callerTasks.total} of ${allTasks.total})`);

    const { data: allInts } = await req('/api/search-advanced/interaction', {
      method: 'POST', token: T.superadmin, expect: 200, body: { where: null },
    });
    const { data: callerInts } = await req('/api/search-advanced/interaction', {
      method: 'POST', token: T.caller, expect: 200, body: { where: null },
    });
    assert(callerInts.total < allInts.total,
      `a caller saw every interaction in the system (${callerInts.total} of ${allInts.total})`);
  });

  await check('searching tasks agrees with the Tasks tab', async () => {
    // A caller has no report.team, so both surfaces show their own tasks.
    const { data: listed } = await req('/api/tasks?limit=500', { token: T.caller, expect: 200 });
    const { data: found } = await req('/api/search-advanced/task', {
      method: 'POST', token: T.caller, expect: 200, body: { where: null },
    });
    eq(found.total, listed.length, 'search and the Tasks tab disagree');
  });

  await check('an interaction search never crosses the book', async () => {
    /* The standing rule: Bigul users do not see Bonanza records, and back.
       Interactions carry call bodies, dispositions and recording URLs, so this
       is the one where crossing it matters most.

       Signed in as a real Bigul user rather than reusing a Bonanza token —
       asserting "sees fewer than a superadmin" would have passed without ever
       testing a book boundary. */
    const bigul = await login('rm@bigul.test');
    const { data: theirs } = await req('/api/search-advanced/interaction', {
      method: 'POST', token: bigul, expect: 200, body: { where: null, limit: 500 },
    });
    const { data: everything } = await req('/api/search-advanced/interaction', {
      method: 'POST', token: T.superadmin, expect: 200, body: { where: null },
    });
    assert(theirs.total > 0, 'a Bigul user sees no interactions at all — the scope failed closed on everything');
    assert(theirs.total < everything.total,
      `a Bigul user saw every interaction there is (${theirs.total} of ${everything.total})`);

    /* Every interaction that names a lead must name a Bigul lead. The ids come
       back on the row, so this reads the leads through the API as that same
       user: a Bonanza lead is a 404 to them, which is the boundary stated from
       the other direction. */
    const leadIds = [...new Set(theirs.rows.map((r) => r.lead_id).filter(Boolean))].slice(0, 8);
    assert(leadIds.length > 0, 'no interaction carried a lead to check the book against');
    for (const id of leadIds) {
      // eslint-disable-next-line no-await-in-loop
      await req(`/api/leads/${id}`, { token: bigul, expect: 200 });
    }
  });

  await check('the task tiles count the list, not the page', async () => {
    /* The Tasks tab computed Open, Overdue and Completed from whatever the
       fetch returned — honest only while the route was unbounded. */
    const { data: summary } = await req('/api/tasks/summary?all=true', { token: T.admin, expect: 200 });
    const { res } = await req('/api/tasks?all=true&limit=1', { token: T.admin, expect: 200 });
    eq(summary.open + summary.done, Number(res.headers.get('x-total-count')),
      'the tiles and the list disagree about how many tasks there are');

    const { data: samePage } = await req('/api/tasks/summary?all=true&limit=1', { token: T.admin, expect: 200 });
    eq(samePage.open, summary.open, 'the summary followed the page size');
  });

  await check('the task list is bounded, counted, sorted and searchable', async () => {
    const { res, data } = await req('/api/tasks?all=true&limit=2&sort=title&dir=asc', { token: T.admin, expect: 200 });
    assert(data.length <= 2, `limit ignored: got ${data.length}`);
    const total = Number(res.headers.get('x-total-count'));
    assert(total >= data.length, 'X-Total-Count missing or smaller than the page');

    const { data: page2 } = await req('/api/tasks?all=true&limit=2&offset=2&sort=title&dir=asc', { token: T.admin, expect: 200 });
    eq(page2.filter((t) => data.some((f) => f.id === t.id)).length, 0, 'the second page repeats the first');

    /* Priority orders by meaning, not alphabetically. Tasks default to
       'Normal', which the ticket vocabulary this CASE was copied from does not
       have — so Normal and Low shared a bucket until all five were named. */
    const { data: byPriority } = await req('/api/tasks?all=true&sort=priority&dir=asc&limit=500', { token: T.admin, expect: 200 });
    const rank = { Critical: 0, High: 1, Medium: 2, Normal: 3, Low: 4 };
    const ranks = byPriority.map((t) => rank[t.priority] ?? 4);
    eq(JSON.stringify(ranks), JSON.stringify([...ranks].sort((a, b) => a - b)),
      'priority did not sort by what it means');

    const { data: hit } = await req('/api/tasks?all=true&q=Retry', { token: T.admin, expect: 200 });
    assert(hit.length >= 1 && hit.length < total, 'search matched everything or nothing');
  });

  await check('an invented task sort column is ignored, not run', async () => {
    const { data } = await req('/api/tasks?all=true&sort=(SELECT 1)&limit=3', { token: T.admin, expect: 200 });
    assert(Array.isArray(data), 'a bad sort broke the list instead of being ignored');
  });

  await check('an object you cannot open is an object you cannot search', async () => {
    /* Advanced search had no per-object gate at all: it required a session and
       nothing else. A Caller was refused the Partners tab and the Campaigns
       list with a 403 and read all seven of each through the search box —
       partner codes, commercial state, campaign audiences and results. */
    await req('/api/partners', { token: T.caller, expect: 403 });
    await req('/api/admin/campaigns', { token: T.caller, expect: 403 });

    for (const entity of ['partner', 'campaign']) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/search-advanced/${entity}`, {
        method: 'POST', token: T.caller, expect: 403, body: { where: null },
      });
      assert(data.required, `the refusal for ${entity} does not name what is missing`);
    }
  });

  await check('the gate covers every door into an object, not just the search', async () => {
    // Gating the search alone would leave count, ids, fields, save and export
    // open, and each of those answers the same question in a different shape.
    await req('/api/search-advanced/fields/partner', { token: T.caller, expect: 403 });
    await req('/api/search-advanced/partner/count', {
      method: 'POST', token: T.caller, expect: 403, body: { where: null },
    });
    await req('/api/search-advanced/partner/ids', {
      method: 'POST', token: T.caller, expect: 403, body: { where: null },
    });
    await req('/api/search-advanced/partner/export', {
      method: 'POST', token: T.caller, expect: 403, body: { where: null },
    });
  });

  await check('the object picker does not name what it will refuse', async () => {
    // The list of what exists is itself a disclosure.
    const { data } = await req('/api/search-advanced/objects', { token: T.caller, expect: 200 });
    const keys = data.map((o) => o.key);
    assert(!keys.includes('partner'), 'the picker offers Partners to a role refused them');
    assert(!keys.includes('campaign'), 'the picker offers Campaigns to a role refused them');
    assert(keys.includes('lead'), 'the picker hid an object the caller may search');

    const { data: forAdmin } = await req('/api/search-advanced/objects', { token: T.admin, expect: 200 });
    assert(forAdmin.map((o) => o.key).includes('partner'), 'an admin lost sight of Partners');
  });

  await check('an archived campaign is out of the search, as it is out of the list', async () => {
    const { data: listed } = await req('/api/admin/campaigns?limit=500', { token: T.admin, expect: 200 });
    const { data: found } = await req('/api/search-advanced/campaign', {
      method: 'POST', token: T.admin, expect: 200, body: { where: null },
    });
    eq(found.total, listed.length, 'search and the campaign list disagree about how many exist');
  });

  await check('searching partners never shows more than the tab does', async () => {
    const { data: listed } = await req('/api/partners?limit=500', { token: T.partner_rm, expect: 200 });
    const { data: found } = await req('/api/search-advanced/partner', {
      method: 'POST', token: T.partner_rm, expect: 200, body: { where: null },
    });
    eq(found.total, listed.length, 'search and the Partners tab disagree for a Partner RM');
  });

  await check('the account book is searchable like every other object', async () => {
    const { data: objects } = await req('/api/search-advanced/objects', { token: T.admin, expect: 200 });
    const list = Array.isArray(objects) ? objects : objects.objects;
    // `key` is the identifier; `entity` on this payload is the display name.
    assert(list.some((o) => o.key === 'client'), 'clients are still not searchable');

    const { data } = await req('/api/search-advanced/fields/client', { token: T.admin, expect: 200 });
    const names = data.fields.map((f) => f.api_name);
    for (const f of ['name', 'client_code', 'status', 'brokerage_ytd', 'last_traded_at']) {
      assert(names.includes(f), `${f} is not offered as a client filter`);
    }
    // A custom field lives in the value store, not a column, and reaches the
    // registry as a correlated subquery. If that wiring is wrong it is wrong
    // silently, so it is named here.
    assert(names.includes('service_tier'), 'the custom client field is not searchable');
  });

  await check('a client search runs, and describes what it did', async () => {
    const { data } = await req('/api/search-advanced/client', {
      method: 'POST', token: T.admin, expect: 200,
      body: { where: { op: 'AND', children: [{ field: 'status', operator: 'eq', value: 'Active' }] } },
    });
    assert(data.total >= 1, 'no active clients matched');
    assert(/status/i.test(data.described), `the filter was not described: ${data.described}`);
  });

  await check('searching the book never shows more of it than the book does', async () => {
    /* The property this whole entry hangs on. Clients carry a role scope as
       well as an org one — an org-scoped role without client.view.all sees
       nothing, a Product RM sees only accounts holding their product — and the
       generic scope in search applies neither. Falling through to it would have
       let a Relationship Manager read every account in their business through
       the search box while the Clients tab showed them one. */
    const { data: listed } = await req('/api/clients?limit=500', { token: T.sales_rm, expect: 200 });
    const { data: found } = await req('/api/search-advanced/client', {
      method: 'POST', token: T.sales_rm, expect: 200, body: { where: null },
    });
    eq(found.total, listed.length, 'search and the list disagree about how many accounts exist');
  });

  await check('a role with no sight of accounts finds none by searching', async () => {
    // Marketing is refused the tab outright; search has to fail closed the same
    // way rather than merely returning fewer rows.
    await req('/api/clients', { token: T.marketing_manager, expect: 403 });
    const { data } = await req('/api/search-advanced/client', {
      method: 'POST', token: T.marketing_manager, expect: 200, body: { where: null },
    });
    eq(data.total, 0, 'a role refused the Clients tab found accounts through search');
  });

  await check('an encrypted field is not offered as a filter that cannot work', async () => {
    /* PAN is stored with randomised encryption, so `pan = 'ABCDE1000F'`
       compares plaintext against ciphertext and matches nothing — while the
       builder described it back confidently and reported zero results. "No lead
       has this PAN" when one does is how a duplicate account gets opened. */
    for (const entity of ['lead', 'client', 'partner']) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/search-advanced/fields/${entity}`, { token: T.admin, expect: 200 });
      assert(!data.fields.some((f) => f.api_name === 'pan'),
        `${entity} still offers PAN as a filter that can only ever match nothing`);
    }
  });

  await check('an export masks what the screen masks', async () => {
    /* The route's own comment promised this for as long as it existed, and the
       code never did it: rows went from the query straight into the CSV, so
       every mobile and email left in the clear on every object for anybody
       holding data.export. A supervisor is the case that matters — the role has
       both data.export and masked fields. */
    /* This route answers text/csv, which the helper hands back as `raw`. Worth
       being explicit about: asserting against the parsed object instead would
       have made the masked half pass without reading a single row. */
    const masked = await req('/api/search-advanced/client/export', {
      method: 'POST', token: T.sales_supervisor, expect: 200, body: { where: null },
    });
    const maskedCsv = masked.data.raw;
    assert(maskedCsv.split('\n').length > 2, 'the export carried no rows, so it proves nothing');
    assert(!/,9\d{9},/.test(maskedCsv), 'a mobile left an export in the clear for a role that masks it');

    const clear = await req('/api/search-advanced/client/export?unmask=true', {
      method: 'POST', token: T.sales_supervisor, expect: 200, body: { where: null },
    });
    assert(/,9\d{9},/.test(clear.data.raw), 'an explicit, permitted unmask was ignored');
  });

  await check('ready-made filters are offered, and every one of them works', async () => {
    const { data } = await req('/api/search-advanced/fields/lead', { token: T.admin, expect: 200 });
    assert(Array.isArray(data.starters) && data.starters.length >= 3,
      'no starter filters offered - an empty builder is the thing people got stuck on');

    // A starter that does not run is worse than no starter: it is a suggestion
    // that fails the moment somebody trusts it. Two of the first four written
    // referenced operators that did not exist, which is why this exists.
    for (const st of data.starters) {
      assert(st.name && st.why, `starter "${st.name}" does not say what it is for`);
      // eslint-disable-next-line no-await-in-loop
      const { data: c } = await req('/api/search-advanced/lead/count', {
        method: 'POST', token: T.admin, expect: 200, body: { where: st.tree },
      });
      assert(typeof c.total === 'number', `starter "${st.name}" did not run`);
      assert(c.described, `starter "${st.name}" cannot be read back in English`);
    }
  });

  await check('the builder can always say what it has built, in English', async () => {
    const { data } = await req('/api/search-advanced/lead/count', {
      method: 'POST', token: T.admin, expect: 200,
      body: {
        where: {
          op: 'AND',
          children: [
            { field: 'stage', operator: 'in', value: ['Qualified'] },
            { op: 'OR', children: [
              { field: 'source', operator: 'contains', value: 'Facebook' },
              { field: 'source', operator: 'contains', value: 'Referral' },
            ] },
          ],
        },
      },
    });
    assert(data.described, 'a nested tree came back with no description');
    // Unreadable to most people even when they built it themselves, so the
    // sentence has to carry both halves and the joining word.
    assert(/ and /i.test(data.described) && / or /i.test(data.described),
      `the description loses the nesting: ${data.described}`);
  });

  await check('an empty filter reads as everything, not as nothing', async () => {
    const { data } = await req('/api/search-advanced/lead/count', {
      method: 'POST', token: T.admin, expect: 200, body: { where: null },
    });
    assert(/everything/i.test(data.described), `an empty filter reads badly: ${data.described}`);
  });

  await check('the readback matches what a saved segment is labelled with', async () => {
    const where = { op: 'AND', children: [{ field: 'mobile', operator: 'is_blank' }] };
    const { data: counted } = await req('/api/search-advanced/lead/count', {
      method: 'POST', token: T.admin, expect: 200, body: { where },
    });
    const { data: saved } = await req('/api/search-advanced/lead/save', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: `Readback ${RUN}`, where },
    });
    const { data: list } = await req('/api/search-advanced/saved/lead', { token: T.admin, expect: 200 });
    const row = (Array.isArray(list) ? list : list?.saved ?? []).find((s) => s.id === saved.id);
    if (row) {
      eq(row.described, counted.described,
        'what the builder showed and what the segment stored are different sentences');
    }
  });

  await check('starters never reference a field the user cannot search', async () => {
    // Field-level security can remove a field; a starter depending on it must
    // disappear with it rather than becoming a broken suggestion.
    for (const role of ['sales_rm', 'caller']) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req('/api/search-advanced/fields/lead', { token: T[role], expect: 200 });
      const names = new Set(data.fields.map((f) => f.api_name));
      const used = (node) => (node.children ? node.children.every(used) : names.has(node.field));
      assert((data.starters ?? []).every((s) => used(s.tree)),
        `${role} was offered a starter using a field they cannot search`);
    }
  });

  await check('an invalid filter is refused with a reason, not a stack trace', async () => {
    const { data } = await req('/api/search-advanced/lead/count', {
      method: 'POST', token: T.admin, expect: 400,
      body: { where: { op: 'AND', children: [{ field: 'not_a_field', operator: 'eq', value: 'x' }] } },
    });
    assert(data.error && !/undefined|\[object/i.test(data.error),
      `unhelpful validation message: ${data.error}`);
  });

  /* ============================================================ 43 */
  suite('43 Contextual AI help (ENH-14)');

  await check('the assistant accepts where the user is standing', async () => {
    const { data: leads } = await req('/api/leads?limit=1', { token: T.sales_rm, expect: 200 });
    const { data } = await req('/api/ai/copilot', {
      method: 'POST', token: T.sales_rm, expect: 200,
      body: {
        question: 'What should I do next with this lead?',
        context: { tab: 'leads', entity: 'lead', id: leads[0].id },
      },
    });
    eq(data.context_used, true, 'the page context was ignored');
    assert(data.reply, 'no answer');
  });

  await check('it is one assistant, not two', async () => {
    // Q-14 was answered "one assistant". A second endpoint would mean two
    // prompts, two grounding paths and two sets of behaviour to keep honest.
    const { data } = await req('/api/ai/copilot', {
      method: 'POST', token: T.sales_rm, expect: 200,
      body: { question: 'Who should I call today?' },
    });
    eq(data.context_used, false, 'context was invented where none was given');
    assert(data.grounded_in, 'the answer does not say what it was grounded on');
  });

  await check('links are records, resolved rather than written by the model', async () => {
    const { data } = await req('/api/ai/copilot', {
      method: 'POST', token: T.sales_rm, expect: 200,
      body: { question: 'Who should I call today?' },
    });
    assert(Array.isArray(data.links), 'no links array at all');
    for (const l of data.links) {
      assert(l.label && l.to, 'a link with no label or destination');
      assert(/^\/(leads|tickets)\/\d+$/.test(l.to), `a link points somewhere odd: ${l.to}`);
    }
  });

  await check('a link can only be a record the reader may already open', async () => {
    // The snapshot is the allowlist, and it is built under the caller's own
    // scope -- so the assistant cannot hand somebody a door to a record they
    // are not entitled to, however confidently it writes about one.
    const { data } = await req('/api/ai/copilot', {
      method: 'POST', token: T.sales_rm, expect: 200,
      body: { question: 'Who should I call today?' },
    });
    const { data: mine } = await req('/api/leads?limit=500', { token: T.sales_rm, expect: 200 });
    const visible = new Set(mine.map((l) => `/leads/${l.id}`));

    for (const l of data.links.filter((x) => x.to.startsWith('/leads/'))) {
      assert(visible.has(l.to), `the assistant linked ${l.to}, which this RM cannot open`);
    }
  });

  await check('context for a lead outside your scope is quietly ignored', async () => {
    const { data: all } = await req('/api/leads?limit=500', { token: T.superadmin, expect: 200 });
    const { data: mine } = await req('/api/leads?limit=500', { token: T.caller, expect: 200 });
    const mineIds = new Set(mine.map((l) => l.id));
    const foreign = all.find((l) => !mineIds.has(l.id));
    if (!foreign) return;

    // It must not confirm the record exists, and must not fail either -- the
    // question is still answerable, just without that grounding.
    const { data } = await req('/api/ai/copilot', {
      method: 'POST', token: T.caller, expect: 200,
      body: { question: 'What is going on here?', context: { tab: 'leads', entity: 'lead', id: foreign.id } },
    });
    assert(data.reply, 'the assistant refused rather than answering generally');
    assert(!String(data.reply).includes(foreign.name),
      'the assistant named a lead this caller cannot see');
  });

  await check('a question is still required', async () => {
    await req('/api/ai/copilot', {
      method: 'POST', token: T.sales_rm, expect: 400,
      body: { question: '   ', context: { tab: 'leads' } },
    });
  });

  /* ============================================================ 44 */
  suite('44 Partner Portal interactivity (ENH-28)');

  await check('a partner can open one of their referred clients', async () => {
    const token = need(REF.portalToken, 'the partner portal token');
    const { data: dash } = await req('/api/portal/dashboard', { token, expect: 200 });
    const lead = (dash.sourced_leads ?? [])[0];
    assert(lead, 'this partner has sourced nobody, so there is nothing to open');
    REF.portalLeadId = lead.id;

    const { data } = await req(`/api/portal/clients/${lead.id}`, { token, expect: 200 });
    assert(data.name, 'no client returned');
    assert(Array.isArray(data.cards), 'no product interest');
    assert('commission_total' in data, 'the partner cannot see what this client earned them');
  });

  await check('the client panel does not put PII on an external portal', async () => {
    const token = need(REF.portalToken, 'the partner portal token');
    const { data } = await req(`/api/portal/clients/${REF.portalLeadId}`, { token, expect: 200 });
    // A partner is paid on what their client buys. They are not a CRM user, and
    // live client identifiers do not belong on a portal outside the firm.
    for (const field of ['mobile', 'email', 'pan', 'alt_contact']) {
      assert(!(field in data), `the portal exposed ${field} to a partner`);
    }
    const blob = JSON.stringify(data);
    assert(!/\b[6-9]\d{9}\b/.test(blob), 'a mobile number leaked into the payload');
    assert(data.privacy_note, 'the panel does not explain why contact details are absent');
  });

  await check('a partner cannot open a client they did not source', async () => {
    const token = need(REF.portalToken, 'the partner portal token');
    const { data: all } = await req('/api/leads?limit=500', { token: T.superadmin, expect: 200 });
    const { data: dash } = await req('/api/portal/dashboard', { token, expect: 200 });
    const mine = new Set((dash.sourced_leads ?? []).map((l) => l.id));
    const foreign = all.find((l) => !mine.has(l.id));
    if (foreign) await req(`/api/portal/clients/${foreign.id}`, { token, expect: 404 });
  });

  await check('training modules carry real detail, not just a name', async () => {
    const token = need(REF.portalToken, 'the partner portal token');
    const { data: dash } = await req('/api/portal/dashboard', { token, expect: 200 });
    const mod = (dash.lms ?? [])[0];
    assert(mod, 'no training assigned');

    const { data } = await req(`/api/portal/training/${encodeURIComponent(mod.module)}`, { token, expect: 200 });
    // "3 of 5 complete" told a partner they were behind without saying on what.
    assert(data.summary, `module "${mod.module}" has no summary`);
    assert(Array.isArray(data.covers) && data.covers.length > 0, 'the module does not say what it covers');
    assert(typeof data.mandatory === 'boolean', 'it does not say whether it is required');
  });

  await check('every assigned module has detail copy', async () => {
    // A module keyed on the wrong name renders an empty panel, which is the
    // exact problem this was meant to fix. The first four written here were
    // keyed on invented names and every one would have shown nothing.
    const token = need(REF.portalToken, 'the partner portal token');
    const { data: dash } = await req('/api/portal/dashboard', { token, expect: 200 });
    for (const m of dash.lms ?? []) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/portal/training/${encodeURIComponent(m.module)}`, { token, expect: 200 });
      assert(data.summary && data.covers?.length,
        `"${m.module}" would open an empty panel`);
    }
  });

  await check('a module can be completed, and completing is idempotent', async () => {
    const token = need(REF.portalToken, 'the partner portal token');
    const { data: dash } = await req('/api/portal/dashboard', { token, expect: 200 });
    const mod = (dash.lms ?? [])[0];

    await req(`/api/portal/training/${encodeURIComponent(mod.module)}/complete`, {
      method: 'POST', token, expect: 200,
    });
    const { data: again } = await req(`/api/portal/training/${encodeURIComponent(mod.module)}/complete`, {
      method: 'POST', token, expect: 200,
    });
    assert(again.ok, 'completing twice failed');

    const { data: after } = await req(`/api/portal/training/${encodeURIComponent(mod.module)}`, { token, expect: 200 });
    eq(after.complete, true, 'the module did not stay complete');
  });

  await check('a module that is not assigned to you is not readable', async () => {
    const token = need(REF.portalToken, 'the partner portal token');
    await req('/api/portal/training/Not%20A%20Module', { token, expect: 404 });
  });

  await check('the portal is still closed to a CRM token', async () => {
    // Two session kinds share one table; a CRM user must not walk into the
    // partner surface just because they hold a valid token.
    await req('/api/portal/dashboard', { token: T.admin, expect: 401 });
  });

  /* ============================================================ 45 */
  suite('45 Product desks');

  await check('the catalogue reports how each product is moving', async () => {
    const { data } = await req('/api/products', { token: T.admin, expect: 200 });
    assert(data.products.length > 0, 'no products');
    assert(data.categories.length > 0, 'no categories');
    const p = data.products[0];
    for (const k of ['in_play', 'active', 'lost', 'open_value', 'won_value']) {
      assert(k in p, `the catalogue does not report ${k}`);
    }
  });

  await check('a product nobody has decided on has no conversion rate', async () => {
    const { data } = await req('/api/products', { token: T.admin, expect: 200 });
    const untouched = data.products.find((x) => x.active === 0 && x.lost === 0);
    if (untouched) {
      // null, not 0. Zero reads as failure; null reads as "not yet answered".
      eq(untouched.conversion_pct, null, 'an undecided product was given a 0% conversion');
    }
  });

  await check('the desk funnel can only narrow', async () => {
    const { data: list } = await req('/api/products', { token: T.admin, expect: 200 });
    const withWork = list.products.find((x) => x.in_play > 0) ?? list.products[0];
    const { data } = await req(`/api/products/${withWork.id}`, { token: T.admin, expect: 200 });

    assert(data.funnel.length >= 4, 'the funnel has too few stages to be one');
    for (let i = 1; i < data.funnel.length; i += 1) {
      assert(data.funnel[i].value <= data.funnel[i - 1].value,
        `the funnel widens at ${data.funnel[i].label} — that is not a funnel`);
    }
  });

  await check('the desk carries what to say as well as how it is doing', async () => {
    const { data: list } = await req('/api/products', { token: T.admin, expect: 200 });
    const { data } = await req(`/api/products/${list.products[0].id}`, { token: T.admin, expect: 200 });
    assert(Array.isArray(data.pitch_points), 'pitch points did not parse');
    assert(Array.isArray(data.objections), 'objections did not parse');
    assert(Array.isArray(data.stalled), 'no stalled list — the thing the page is opened to find');
  });

  await check('everything on the desk is scoped to the reader', async () => {
    const totalFor = async (token) => {
      const { data } = await req('/api/products', { token, expect: 200 });
      return data.products.reduce((s, x) => s + x.in_play + x.active, 0);
    };
    const admin = await totalFor(T.admin);
    const rm = await totalFor(T.sales_rm);
    assert(rm <= admin, `an RM counted more cards (${rm}) than an admin (${admin})`);
  });

  await check('a product in the other business is not readable', async () => {
    const { data: all } = await req('/api/products', { token: T.superadmin, expect: 200 });
    const { data: mine } = await req('/api/products', { token: T.admin, expect: 200 });
    const mineIds = new Set(mine.products.map((x) => x.id));
    const foreign = all.products.find((x) => !mineIds.has(x.id));
    if (foreign) await req(`/api/products/${foreign.id}`, { token: T.admin, expect: 404 });
  });

  await check('stalled means over a fortnight, and says how long', async () => {
    const { data: list } = await req('/api/products', { token: T.superadmin, expect: 200 });
    for (const p of list.products.slice(0, 6)) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/products/${p.id}`, { token: T.superadmin, expect: 200 });
      for (const c of data.stalled) {
        assert(c.days_in_state > 14, `"${c.lead_name}" is listed as stalled at ${c.days_in_state} days`);
        assert(c.lead_id, 'a stalled row with no lead to open');
      }
    }
  });

  /* ============================================================ 46 */
  suite('46 CCM, Team and Revenue');

  await check('CCM finds a record the searcher does not own', async () => {
    // The whole point. A duplicate check confined to your own book cannot find
    // the duplicate, because the duplicate is by definition somebody else's.
    const { data: all } = await req('/api/leads?limit=200&unmask=true', { token: T.superadmin, expect: 200 });
    const { data: mine } = await req('/api/leads?limit=500', { token: T.sales_rm, expect: 200 });
    const mineIds = new Set(mine.map((l) => l.id));
    const foreign = all.find((l) => !mineIds.has(l.id) && l.mobile);
    assert(foreign, 'no lead outside the RM book to test with');

    const { data } = await req(`/api/ccm/search?q=${encodeURIComponent(foreign.mobile)}`,
      { token: T.sales_rm, expect: 200 });
    assert(data.matches.length > 0, 'the duplicate check missed a record it should have found');
    assert(data.matches[0].owner_name, 'a match that does not say who holds them is useless');
  });

  await check('CCM never hands over a contact detail', async () => {
    const { data: all } = await req('/api/leads?limit=200&unmask=true', { token: T.superadmin, expect: 200 });
    const target = all.find((l) => l.mobile);
    const { data } = await req(`/api/ccm/search?q=${encodeURIComponent(target.name)}`,
      { token: T.sales_rm, expect: 200 });

    for (const m of data.matches) {
      assert(!('email' in m), 'CCM returned a client email address');
      assert(!('pan' in m), 'CCM returned a PAN');
      assert(/[\u2022*]/.test(String(m.mobile ?? '')),
        `CCM returned an unmasked mobile: ${m.mobile}`);
    }
  });

  await check('CCM finds by PAN, which needs the blind index', async () => {
    const { data: all } = await req('/api/leads?limit=200&unmask=true', { token: T.superadmin, expect: 200 });
    const withPan = all.find((l) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(l.pan ?? '')));
    if (!withPan) return;
    const { data } = await req(`/api/ccm/search?q=${withPan.pan}`, { token: T.sales_rm, expect: 200 });
    eq(data.matched_on, 'PAN', 'a PAN was not recognised as one');
    assert(data.matches.some((m) => m.id === withPan.id),
      'PAN search missed the record holding that PAN — the blind index is not being written');
  });

  await check('CCM needs the capability to create leads', async () => {
    // Only somebody who can create a lead has a reason to check first.
    await req('/api/ccm/search?q=test', { token: T.marketing_manager, expect: 403 });
  });

  await check('Team resolves the reporting chain, at any depth', async () => {
    const { data: sup } = await req('/api/team', { token: T.sales_supervisor, expect: 200 });
    eq(sup.scope, 'chain', 'a supervisor should see their chain, not the org');
    assert(sup.members.length > 1, 'a supervisor with reports saw only themselves');
    assert(sup.tree.length >= 1, 'no tree was assembled');

    const { data: rm } = await req('/api/team', { token: T.sales_rm, expect: 200 });
    // Not an error and not empty: "My Team" for somebody with no reports is
    // themselves, and a blank page would read as broken.
    assert(rm.members.length >= 1, 'an RM with no reports got nothing at all');
  });

  await check('an administrator sees the whole business', async () => {
    const { data } = await req('/api/team', { token: T.admin, expect: 200 });
    eq(data.scope, 'org', 'an admin should not be limited to a chain');
    assert(data.members.every((m) => m.sales_org === 'BONANZA'),
      'a Bigul user appeared in a Bonanza admin team');
  });

  await check('Revenue is scoped, and ranks only against real peers', async () => {
    const { data: rm } = await req('/api/revenue', { token: T.sales_rm, expect: 200 });
    const { data: admin } = await req('/api/revenue', { token: T.admin, expect: 200 });
    assert(rm.earned.active_value <= admin.earned.active_value,
      'an RM counted more value than an admin');

    if (rm.rank) {
      assert(rm.rank.of >= 3, 'a rank was published against fewer than three peers');
      assert(rm.rank.position >= 1 && rm.rank.position <= rm.rank.of, 'the rank is out of range');
      eq(rm.rank.role, 'sales_rm', 'ranked against the wrong role');
    }
  });

  await check('untapped means a client who already holds something else', async () => {
    const { data } = await req('/api/revenue', { token: T.superadmin, expect: 200 });
    // A lead holding nothing is a prospecting job, not a cross-sell one, and
    // mixing the two makes the number useless for either.
    for (const u of data.untapped) {
      assert(u.opportunity > 0, `${u.name} is listed as untapped with nobody to sell it to`);
      assert(u.id, 'an untapped row with no product to open');
    }
  });

  await check('the range picker changes the revenue window', async () => {
    const { data: mtd } = await req('/api/revenue?range=mtd', { token: T.admin, expect: 200 });
    const { data: fytd } = await req('/api/revenue?range=fytd', { token: T.admin, expect: 200 });
    assert(fytd.range.from <= mtd.range.from, 'the financial year started after the month');
    eq(fytd.range.from.slice(5, 7), '04', 'the financial year must start in April');
  });

  /* ============================================================ 47 */
  suite('47 Calendar, KRA and Incentives');

  await check('the calendar unions Outlook with CRM due work', async () => {
    const { data } = await req('/api/calendar?days=7', { token: T.sales_rm, expect: 200 });
    assert(Array.isArray(data.days) && data.days.length === 7, 'seven days were not returned');
    assert(data.counts, 'no counts');
    const kinds = new Set(data.days.flatMap((d) => d.items.map((i) => i.kind)));
    assert(kinds.size > 0, 'the calendar is entirely empty');
    for (const k of kinds) {
      assert(['meeting', 'task', 'callback'].includes(k), `unknown item kind: ${k}`);
    }
  });

  await check('the calendar says where its meetings came from', async () => {
    const { data } = await req('/api/calendar', { token: T.sales_rm, expect: 200 });
    assert('live' in data.source, 'the source does not declare whether it is live');
    if (!data.source.live) {
      // A calendar that quietly invents meetings would be the most damaging
      // thing in the product, so an unconfigured one has to say so.
      assert(data.source.needs.length > 0, 'a simulated calendar does not say what it needs');
      eq(data.source.mode, 'simulated', 'mode should be simulated without credentials');
    }
  });

  await check('a meeting belongs to one person, not the desk', async () => {
    const { data: rm } = await req('/api/calendar', { token: T.sales_rm, expect: 200 });
    const { data: caller } = await req('/api/calendar', { token: T.caller, expect: 200 });
    const ids = (d) => new Set(d.days.flatMap((x) => x.items)
      .filter((i) => i.kind === 'meeting').map((i) => i.external_id));
    const a = ids(rm); const b = ids(caller);
    for (const id of a) assert(!b.has(id), `both users were given the same meeting: ${id}`);
  });

  await check('syncing twice does not duplicate a meeting', async () => {
    await req('/api/calendar/sync', { method: 'POST', token: T.sales_rm, expect: 200 });
    const { data: first } = await req('/api/calendar?days=14', { token: T.sales_rm, expect: 200 });
    await req('/api/calendar/sync', { method: 'POST', token: T.sales_rm, expect: 200 });
    const { data: second } = await req('/api/calendar?days=14', { token: T.sales_rm, expect: 200 });
    eq(second.counts.meetings, first.counts.meetings, 'a second sync created duplicates');
  });

  await check('a KRA scorecard measures against configured targets', async () => {
    const { data } = await req('/api/kra', { token: T.sales_rm, expect: 200 });
    assert(data.metrics.length > 0, 'no metrics configured for sales_rm');
    for (const m of data.metrics) {
      assert(m.label && m.target >= 0 && m.weight > 0, `metric ${m.code} is not fully configured`);
      assert(['higher', 'lower'].includes(m.direction), 'a metric has no direction');
    }
  });

  await check('an unmeasurable metric is not scored zero', async () => {
    const { data } = await req('/api/kra', { token: T.sales_rm, expect: 200 });
    // Zero and "not measured" look identical on a scorecard and mean opposite
    // things. Counting a missing feed as a failure is how a scorecard gets
    // ignored, so it is excluded from the score and says why.
    for (const m of data.metrics) {
      if (m.actual === null) {
        eq(m.score, null, `${m.code} was scored despite having nothing to measure`);
        assert(m.reason, `${m.code} is unmeasured with no explanation`);
      }
    }
    assert(data.coverage.weight_covered <= data.coverage.weight_total, 'coverage exceeds the total weight');
  });

  await check('lower-is-better scores the right way round', async () => {
    const { data } = await req('/api/kra', { token: T.sales_rm, expect: 200 });
    const lower = data.metrics.find((m) => m.direction === 'lower' && m.actual != null);
    if (lower) {
      // At or under target is full marks; above it degrades rather than
      // falling off a cliff at target + 1.
      if (lower.actual <= lower.target) eq(lower.score, 100, 'under target did not score full marks');
      else assert(lower.score < 100 && lower.score >= 0, 'over target scored out of range');
    }
  });

  await check('incentive slabs are marginal, not cliff', async () => {
    const { data } = await req('/api/kra/incentives', { token: T.sales_rm, expect: 200 });
    assert(data.plan, 'no plan for sales_rm');

    for (const b of data.bases) {
      // Every band pays on its own portion, and the parts must sum to the total.
      const sum = b.lines.reduce((s, l) => s + l.amount, 0);
      assert(Math.abs(sum - b.total) <= b.lines.length,
        `${b.basis}: the bands sum to ${sum} but the total says ${b.total}`);

      for (const l of b.lines) {
        assert(l.portion > 0, `${b.basis}: a band counted a non-positive portion`);
        if (l.to != null) {
          assert(l.portion <= l.to - l.from + 0.001,
            `${b.basis}: a band counted more than fits inside it`);
        }
      }
    }
    eq(data.total, data.bases.reduce((s, b) => s + b.total, 0), 'the payout does not equal its parts');
  });

  await check('the payout shows its working', async () => {
    const { data } = await req('/api/kra/incentives', { token: T.sales_rm, expect: 200 });
    assert(Array.isArray(data.slabs) && data.slabs.length > 0,
      'the slab table is not returned — a payout nobody can check is one they will query');
    assert(data.plan.clawback_months > 0, 'no clawback window declared');
  });

  await check('KRA and incentive configuration needs admin.rules', async () => {
    await req('/api/kra/config', { token: T.sales_rm, expect: 403 });
    const { data } = await req('/api/kra/config', { token: T.admin, expect: 200 });
    assert(data.metrics.length > 0 && data.plans.length > 0, 'nothing is configured');
    assert(/worked example/i.test(data.note), 'the config does not say these are placeholders');
  });

  /* ============================================================ 48 */
  suite('48 Targets and incentives in Setup');

  await check('every shipped role weights to exactly 100', async () => {
    const { data } = await req('/api/kra/config', { token: T.admin, expect: 200 });
    const byRole = new Map();
    for (const m of data.metrics.filter((x) => x.active)) {
      byRole.set(m.role_code, (byRole.get(m.role_code) ?? 0) + m.weight);
    }
    for (const [role, total] of byRole) {
      // A card weighted to 85 still produces a number; it is just not the
      // number anyone reading it assumes.
      eq(total, 100, `${role} weights to ${total}, not 100`);
    }
  });

  await check('editing a metric marks it as the business own', async () => {
    const { data: before } = await req('/api/kra/config', { token: T.admin, expect: 200 });
    const m = before.metrics.find((x) => x.role_code === 'sales_rm' && !x.edited_at);
    assert(m, 'no unedited metric to test with');

    const { data } = await req(`/api/kra/config/metrics/${m.id}`, {
      method: 'PATCH', token: T.admin, expect: 200, body: { target: 99 },
    });
    eq(data.target, 99, 'the target did not change');
    assert(data.edited_at, 'the row was not marked as edited, so the seeder will revert it');
  });

  await check('a metric edit survives the seeder re-running', async () => {
    // seedKra() runs on every boot. Its upsert is guarded on edited_at, and
    // without that guard every customisation would revert at the next deploy.
    const { data } = await req('/api/kra/config', { token: T.admin, expect: 200 });
    const edited = data.metrics.find((x) => x.target === 99);
    assert(edited, 'the edit did not persist');
  });

  await check('a gap between bands is refused, and says where', async () => {
    const { data: cfg } = await req('/api/kra/config', { token: T.admin, expect: 200 });
    const plan = cfg.plans[0];
    const { data } = await req(`/api/kra/config/plans/${plan.id}`, {
      method: 'PATCH', token: T.admin, expect: 400,
      body: {
        slabs: [
          { basis: 'brokerage', from_value: 0, to_value: 100000, rate: 10, rate_kind: 'percent' },
          { basis: 'brokerage', from_value: 200000, to_value: null, rate: 15, rate_kind: 'percent' },
        ],
      },
    });
    // Production landing in the gap would earn nothing, silently, until payday.
    assert(/nothing is paid between 100000 and 200000/.test(data.error),
      `the refusal does not name the gap: ${data.error}`);
  });

  await check('overlapping bands are refused — that portion would pay twice', async () => {
    const { data: cfg } = await req('/api/kra/config', { token: T.admin, expect: 200 });
    const { data } = await req(`/api/kra/config/plans/${cfg.plans[0].id}`, {
      method: 'PATCH', token: T.admin, expect: 400,
      body: {
        slabs: [
          { basis: 'brokerage', from_value: 0, to_value: 150000, rate: 10, rate_kind: 'percent' },
          { basis: 'brokerage', from_value: 100000, to_value: null, rate: 15, rate_kind: 'percent' },
        ],
      },
    });
    assert(/overlap/i.test(data.error), `the refusal does not mention the overlap: ${data.error}`);
  });

  await check('a capped top band is refused', async () => {
    const { data: cfg } = await req('/api/kra/config', { token: T.admin, expect: 200 });
    const { data } = await req(`/api/kra/config/plans/${cfg.plans[0].id}`, {
      method: 'PATCH', token: T.admin, expect: 400,
      body: { slabs: [{ basis: 'brokerage', from_value: 0, to_value: 100000, rate: 10, rate_kind: 'percent' }] },
    });
    // Anything above the top band would earn nothing — a cliff nobody intended.
    assert(/earns nothing/i.test(data.error), `unhelpful refusal: ${data.error}`);
  });

  await check('bands that do not start at zero are refused', async () => {
    const { data: cfg } = await req('/api/kra/config', { token: T.admin, expect: 200 });
    await req(`/api/kra/config/plans/${cfg.plans[0].id}`, {
      method: 'PATCH', token: T.admin, expect: 400,
      body: { slabs: [{ basis: 'brokerage', from_value: 50000, to_value: null, rate: 10, rate_kind: 'percent' }] },
    });
  });

  await check('a valid set of bands saves and applies marginally', async () => {
    const { data: cfg } = await req('/api/kra/config', { token: T.admin, expect: 200 });
    const plan = cfg.plans.find((p) => p.role_code === 'sales_rm');
    const slabs = [
      { basis: 'brokerage', from_value: 0, to_value: 100000, rate: 10, rate_kind: 'percent' },
      { basis: 'brokerage', from_value: 100000, to_value: null, rate: 15, rate_kind: 'percent' },
    ];
    const { data } = await req(`/api/kra/config/plans/${plan.id}`, {
      method: 'PATCH', token: T.admin, expect: 200, body: { slabs },
    });
    eq(data.slabs.length, 2, 'the bands did not save');

    const { data: pv } = await req('/api/kra/config/preview', {
      method: 'POST', token: T.admin, expect: 200,
      body: { slabs, value: 250000, basis: 'brokerage' },
    });
    // 10% of the first 100,000 plus 15% of the next 150,000.
    eq(pv.total, 10000 + 22500, `marginal arithmetic is wrong: got ${pv.total}`);
  });

  await check('the preview never pays less for producing more', async () => {
    const slabs = [
      { basis: 'brokerage', from_value: 0, to_value: 100000, rate: 20, rate_kind: 'percent' },
      { basis: 'brokerage', from_value: 100000, to_value: null, rate: 5, rate_kind: 'percent' },
    ];
    let last = -1;
    for (const value of [0, 50000, 99999, 100000, 100001, 500000]) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req('/api/kra/config/preview', {
        method: 'POST', token: T.admin, expect: 200, body: { slabs, value, basis: 'brokerage' },
      });
      assert(data.total >= last,
        `payout fell from ${last} to ${data.total} at ${value} — that is a cliff, not a marginal band`);
      last = data.total;
    }
  });

  await check('configuring targets needs admin.rules', async () => {
    await req('/api/kra/config', { token: T.sales_rm, expect: 403 });
    await req('/api/kra/config/metrics', {
      method: 'POST', token: T.sales_rm, expect: 403,
      body: { role_code: 'sales_rm', code: 'x', label: 'x' },
    });
  });

  /* ============================================================ 49 */
  suite('49 the book boundary holds on record routes');

  /*
   * Index routes were filtered by book from the start. Record routes were not,
   * and each one had to be remembered separately -- so seven of them were not.
   * A Bigul user holding a Bonanza id could read the lead's next-action advice,
   * a ticket's case notes, a card's state history, a saved list, and a KYC
   * journey including the applicant's resume token.
   *
   * These tests fetch ids from the Bonanza side and demand a refusal on the
   * Bigul side. The ids are read as superadmin and then filtered on sales_org:
   * a superadmin spans both books, so "the first record a superadmin can see"
   * is not necessarily a Bonanza one, and taking it as such is how the first
   * pass at this test reported a leak that was correct behaviour.
   */

  const bigulOnly = await login('rm@bigul.test');

  /** One Bonanza id from a list route, or null when the fixture is exhausted. */
  const bonanzaIdFrom = async (path, pick = (r) => r.id) => {
    const { data } = await req(path, { token: T.superadmin, expect: 200 });
    const rows = Array.isArray(data) ? data : (data.rows ?? data.items ?? []);
    const row = rows.find((r) => r.sales_org === 'BONANZA');
    return row ? pick(row) : null;
  };

  /** Refused means 403 or 404 — never 200, and never a crash. */
  const refused = async (path, what) => {
    const { status, data } = await req(path, { token: bigulOnly });
    assert([403, 404].includes(status),
      `${what}: a Bigul user got HTTP ${status} for ${path} — ${JSON.stringify(data).slice(0, 160)}`);
  };

  await check('a Bonanza lead is refused on every route that takes a lead id', async () => {
    const id = need(await bonanzaIdFrom('/api/leads?limit=50'), 'a Bonanza lead');
    await refused(`/api/leads/${id}`, 'lead detail');
    await refused(`/api/activities/lead/${id}`, 'lead activities');
    await refused(`/api/email/compose/${id}`, 'email composer');

    // Reads as harmless -- a name and some index levels -- but the name is the
    // part that is not ours to hand over.
    await refused(`/api/market/context/${id}`, 'market context');

    // The advice is assembled from the lead's tickets, cards and KYC state, so
    // an unscoped answer describes the record about as well as the record does.
    await refused(`/api/ai/leads/${id}/next-action`, 'next action');
  });

  await check('a Bonanza ticket is refused, ref and all', async () => {
    const id = need(await bonanzaIdFrom('/api/tickets?limit=50'), 'a Bonanza ticket');
    await refused(`/api/tickets/${id}`, 'ticket detail');
  });

  await check('a Bonanza saved list is refused even when shared with the reader role', async () => {
    /*
     * The list has to be one that is actually shared with the reader's role,
     * or the refusal proves nothing: most lists are shared with nobody, and
     * those were correctly refused even before the fix. The defect was
     * specifically that shared_with holds role names, and "sales_rm" names a
     * role in both books -- so sharing with a role shared it across the firm.
     */
    const { data } = await req('/api/lists', { token: T.superadmin, expect: 200 });
    const rows = Array.isArray(data) ? data : (data.rows ?? []);
    const sharedWithSalesRm = need(
      rows.find((l) => {
        if (l.sales_org !== 'BONANZA') return false;
        try { return JSON.parse(l.shared_with || '[]').includes('sales_rm'); } catch { return false; }
      }),
      'a Bonanza list shared with the sales_rm role',
    );

    await refused(`/api/lists/${sharedWithSalesRm.id}`, 'list detail');
    // …and still readable by someone whose book it is.
    await req(`/api/lists/${sharedWithSalesRm.id}`, { token: T.superadmin, expect: 200 });
  });

  /*
   * Cards and journeys do not carry sales_org in their payloads, so their book
   * is resolved through the lead they belong to. Resolving it by reading a
   * `sales_org` field that is not there yields undefined, and a test that then
   * skips itself passes without asserting anything -- which is worse than no
   * test, because it reads as coverage.
   */
  const bonanzaLeadIds = await (async () => {
    const { data } = await req('/api/leads?limit=200', { token: T.superadmin, expect: 200 });
    const rows = Array.isArray(data) ? data : (data.rows ?? []);
    return new Set(rows.filter((l) => l.sales_org === 'BONANZA').map((l) => Number(l.id)));
  })();

  await check('a Bonanza card audit trail is refused', async () => {
    assert(bonanzaLeadIds.size > 0, `no Bonanza leads to resolve a card against. ${RESEED}`);
    const { data } = await req('/api/cards?limit=200', { token: T.superadmin, expect: 200 });
    const rows = Array.isArray(data) ? data : (data.rows ?? []);
    const card = need(rows.find((c) => bonanzaLeadIds.has(Number(c.lead_id))), 'a Bonanza product card');

    await refused(`/api/cards/${card.id}/detail`, 'card detail');
    // card_audit has no owner and no org of its own, which is why it was missed.
    await refused(`/api/cards/${card.id}/audit`, 'card audit');
  });

  await check('a Bonanza KYC journey is refused, so its resume token stays put', async () => {
    const { data } = await req('/api/kyc/health', { token: T.superadmin, expect: 200 });
    const rows = Array.isArray(data) ? data : (data.rows ?? []);
    const journey = need(rows.find((j) => bonanzaLeadIds.has(Number(j.lead_id))), 'a Bonanza KYC journey');

    const { status, data: body } = await req(`/api/kyc/journeys/${journey.id}`, { token: bigulOnly });
    assert([403, 404].includes(status),
      `a Bigul user read a Bonanza KYC journey (HTTP ${status})`);
    assert(!JSON.stringify(body ?? {}).includes('resume_token'),
      'the refusal still returned the applicant resume token');

    // The same journey must still open for someone whose book it is, or the
    // test above would be satisfied by a route that refuses everybody.
    await req(`/api/kyc/journeys/${journey.id}`, { token: T.superadmin, expect: 200 });
  });

  await check('a partial user reaches no book at all, rather than Bonanza', async () => {
    // orgsFor() used to fall back to BONANZA whenever sales_org was absent, so
    // anything constructing a user from an id and a capability set was handed
    // the larger book. The approvals queue did precisely that.
    const { orgsFor } = await import('../src/auth.js');
    eq(orgsFor({ id: 1, capabilities: new Set() }).length, 0,
      'a user with no sales_org was granted a book');
    eq(orgsFor(null).length, 0, 'a null user was granted a book');
  });

  /* ============================================================ 50 */
  suite('50 duplicate check, partner report and partner book');

  await check('Customer Care can run the check its tab offers', async () => {
    /* The tab was granted to Customer Care while both of its features were
     * gated on lead.create, which Customer Care does not hold -- so the page
     * loaded, showed its counts, and refused the only two things it does. */
    const { data: dupes } = await req('/api/ccm/duplicates', { token: T.customer_care, expect: 200 });
    assert(Array.isArray(dupes.groups ?? dupes), 'the duplicates list did not come back');

    const { data: search } = await req('/api/ccm/search?q=98', { token: T.customer_care, expect: 200 });
    assert('matches' in search, 'the search did not come back');
  });

  await check('the duplicate check still refuses a role with neither permission', async () => {
    // Widening it to "either job" must not widen it to everybody.
    await req('/api/ccm/duplicates', { token: T.marketing_manager, expect: 403 });
  });

  await check('the check answers whether, never who to call', async () => {
    const { data } = await req('/api/ccm/search?q=98', { token: T.customer_care, expect: 200 });
    for (const m of data.matches ?? []) {
      // Crossing the book is the point of this screen; handing over contact
      // details is not.
      assert(!('mobile' in m) || m.mobile == null || String(m.mobile).includes('\u2022'),
        `the duplicate check returned a contactable number: ${JSON.stringify(m).slice(0, 140)}`);
    }
  });

  await check('the partner report opens for the roles it describes', async () => {
    for (const role of ['admin', 'partner_rm', 'sales_supervisor']) {
      const { data } = await req('/api/reports/partners', { token: T[role], expect: 200 });
      assert(Array.isArray(data.rows), `${role} got no rows`);
    }
    // …and stays shut for a role with no partner remit.
    await req('/api/reports/partners', { token: T.caller, expect: 403 });
  });

  await check('a Partner RM report covers their own partners, not the desk', async () => {
    const { data } = await req('/api/reports/partners', { token: T.partner_rm, expect: 200 });
    eq(data.scope, 'own_partners', 'a Partner RM was given the whole book');

    const { data: wide } = await req('/api/reports/partners', { token: T.admin, expect: 200 });
    eq(wide.scope, 'book', 'an admin was narrowed to their own partners');
    assert(wide.rows.length >= data.rows.length,
      'the narrowed report returned more rows than the wide one');
  });

  await check('partners stay inside their own book', async () => {
    /* partner.view is held by Admin, Partner RM and Sales Supervisor, and those
     * roles exist in both businesses -- so holding it was enough to list and
     * open the other book's partners, codes and commercial state included. */
    const bigulSup = await login('supervisor@bigul.test');

    const { data: theirs } = await req('/api/partners', { token: bigulSup, expect: 200 });
    const rows = Array.isArray(theirs) ? theirs : (theirs.rows ?? []);
    const orgs = [...new Set(rows.map((r) => r.sales_org))];
    assert(!orgs.includes('BONANZA'),
      `a Bigul supervisor was shown Bonanza partners: ${orgs.join(', ')}`);

    const { data: all } = await req('/api/partners', { token: T.superadmin, expect: 200 });
    const allRows = Array.isArray(all) ? all : (all.rows ?? []);
    const bonanza = need(allRows.find((r) => r.sales_org === 'BONANZA'), 'a Bonanza partner');
    const { status } = await req(`/api/partners/${bonanza.id}`, { token: bigulSup });
    assert([403, 404].includes(status),
      `a Bigul supervisor opened a Bonanza partner (HTTP ${status})`);

    // The partner report is built from the same table and had the same gap.
    const { data: rep } = await req('/api/reports/partners', { token: bigulSup, expect: 200 });
    for (const r of rep.rows) {
      assert(!allRows.some((p) => p.id === r.id && p.sales_org === 'BONANZA'),
        `the partner report leaked a Bonanza partner: ${r.name}`);
    }
  });

  /* ============================================================ 51 */
  suite('51 access log');

  /*
   * The CRM could say who CHANGED a record long before it could say who READ
   * one. That gap is why the August cross-book incident has a closed fix and an
   * open impact assessment: the code was corrected in a day, and nobody could
   * establish whether anyone had actually looked.
   */

  await check('a record read is recorded against the person who made it', async () => {
    const { data: leads } = await req('/api/leads?limit=1', { token: T.sales_rm, expect: 200 });
    const lead = need((Array.isArray(leads) ? leads : leads.rows)[0], 'a lead to read');

    await req(`/api/leads/${lead.id}`, { token: T.sales_rm, expect: 200 });

    const { data } = await req(`/api/admin/access-log/record?path=/api/leads/${lead.id}`,
      { token: T.admin, expect: 200 });
    const mine = data.rows.filter((r) => r.role === 'sales_rm');
    assert(mine.length > 0, 'the read was not recorded');
    assert(mine[0].email, 'the row does not say who');
    assert(mine[0].sales_org, 'the row does not say which book they were in');
  });

  await check('the path recorded is the whole path, not the routed remainder', async () => {
    /* Guards a bug that was live briefly: the middleware mounts on '/api', and
     * inside a mounted handler Express rewrites req.url to the remainder, so
     * the log recorded '/2' rather than '/api/tickets/2'. Every row still
     * arrived, so the table looked healthy while answering nothing. */
    const { data } = await req('/api/admin/access-log', { token: T.admin, expect: 200 });
    assert(data.rows > 0, 'nothing has been logged at all');
    for (const b of data.busiest) {
      assert(b.path.startsWith('/api/'),
        `a logged path lost its prefix: ${b.path} — the log cannot identify a record`);
    }
  });

  await check('search terms are never written to the log', async () => {
    // ?q= on the duplicate check is a client's mobile number often enough that
    // storing it would make the log a second copy of the client book.
    await req('/api/ccm/search?q=9820000000', { token: T.admin, expect: 200 });

    const { data } = await req('/api/admin/access-log', { token: T.admin, expect: 200 });
    for (const b of data.busiest) {
      assert(!b.path.includes('?'), `a query string reached the log: ${b.path}`);
      assert(!/9820000000/.test(b.path), 'a searched mobile number reached the log');
    }
  });

  await check('a failed sign-in is recorded', async () => {
    // Mounted ahead of the sign-in routes for this reason: a run of attempts
    // against one account is the thing an access log most obviously exists for.
    await req('/api/auth/login', {
      method: 'POST', expect: 401,
      body: { email: 'nobody.at.all@bonanza.test', password: 'wrong' },
    });
    const { data } = await req('/api/admin/access-log/record?path=/api/auth/login',
      { token: T.admin, expect: 200 });
    assert(data.rows.some((r) => r.status === 401), 'a failed sign-in left no trace');
  });

  await check('the log says nothing about the boundary being crossed', async () => {
    // The boundary holds, so this must be empty. It is the query the incident
    // needed; an empty answer is the whole point of having it.
    const { data } = await req('/api/admin/access-log/cross-book', { token: T.admin, expect: 200 });
    assert(Array.isArray(data.rows), 'no rows array');
    if (data.rows.length) {
      throw new Error(`cross-book reads recorded: ${JSON.stringify(data.rows[0])}`);
    }
    assert(/No cross-book reads/i.test(data.note), 'the empty result is not explained');
  });

  await check('the access log is readable by Admin alone', async () => {
    /* The log is a record of who read whose data, which makes it sensitive in
     * its own right. Widening it would create the problem it detects. */
    for (const role of ['sales_rm', 'sales_supervisor', 'customer_care', 'marketing_manager', 'caller']) {
      await req('/api/admin/access-log', { token: T[role], expect: 403 });
      await req('/api/admin/access-log/cross-book', { token: T[role], expect: 403 });
    }
    await req('/api/admin/access-log', { token: T.superadmin, expect: 200 });
  });

  await check('asking about a record needs a real API path', async () => {
    const { data } = await req('/api/admin/access-log/record?path=tickets/2',
      { token: T.admin, expect: 400 });
    assert(/\/api\//.test(data.error), `unhelpful refusal: ${data.error}`);
  });

  await check('the retention window is declared, not implied', async () => {
    const { data } = await req('/api/admin/access-log', { token: T.admin, expect: 200 });
    assert(data.retention_days > 0 && data.retention_days <= 365,
      `implausible retention window: ${data.retention_days}`);
  });

  /* ============================================================ 52 */
  suite('52 artefact versioning');

  /*
   * Finding 10 of the LeadSquared audit: nothing was versioned, so nothing was
   * ever retired -- one capability across five forms and three processes, V3
   * and V4 both live, the copy marked "old" still enabled. The version history
   * was the artefact names.
   */

  await check('saving a rule produces a version', async () => {
    const { data: created } = await req('/api/admin/rules', {
      method: 'POST', token: T.admin, expect: 201,
      body: {
        name: `E2E versioned rule ${RUN}`,
        description: 'first',
        conditions: [{ field: 'stage', op: 'is', value: 'New' }],
        actions: [{ type: 'set_field', field: 'priority', value: 'High' }],
      },
    });
    REF.versionedRuleId = created.id;

    const { data } = await req(`/api/admin/versions/rule/${created.id}`, { token: T.admin, expect: 200 });
    eq(data.versions.length, 1, 'creating a rule did not record a version');
    eq(data.current.version, 1, 'the first version is not current');
    eq(data.label, 'Automation rule', 'the artefact does not name itself');
  });

  await check('editing it supersedes, and only one version is current', async () => {
    const id = need(REF.versionedRuleId, 'a versioned rule');
    await req(`/api/admin/rules/${id}`, {
      method: 'PATCH', token: T.admin, expect: 200,
      body: { description: 'second', note: 'Reworded' },
    });

    const { data } = await req(`/api/admin/versions/rule/${id}`, { token: T.admin, expect: 200 });
    eq(data.versions.length, 2, 'the edit did not record a version');
    eq(data.current.version, 2, 'the current pointer did not move');
    eq(data.versions.filter((v) => v.is_current).length, 1, 'two versions claim to be current');
  });

  await check('the diff names the field that changed', async () => {
    const id = need(REF.versionedRuleId, 'a versioned rule');
    const { data: hist } = await req(`/api/admin/versions/rule/${id}`, { token: T.admin, expect: 200 });
    const [v2, v1] = hist.versions;

    const { data } = await req(`/api/admin/versions/diff?a=${v1.id}&b=${v2.id}`, { token: T.admin, expect: 200 });
    eq(data.identical, false, 'a real change diffed to nothing');
    const changed = data.changes.map((c) => c.field);
    assert(changed.includes('description'), `description not listed: ${changed.join(', ')}`);
    assert(!changed.includes('name'), 'an unchanged field was reported as changed');
  });

  await check('rolling back restores the values and keeps the history', async () => {
    const id = need(REF.versionedRuleId, 'a versioned rule');
    const { data: hist } = await req(`/api/admin/versions/rule/${id}`, { token: T.admin, expect: 200 });
    const first = hist.versions.find((v) => v.version === 1);

    const { data } = await req(`/api/admin/versions/${first.id}/restore`, {
      method: 'POST', token: T.admin, expect: 200,
    });
    eq(data.ok, true, 'the rollback was refused');
    eq(data.restored_from, 1);

    const { data: after } = await req(`/api/admin/versions/rule/${id}`, { token: T.admin, expect: 200 });
    // A rollback that deleted the versions in between would destroy the record
    // of what was live last Tuesday, which is what an auditor asks about.
    eq(after.versions.length, 3, 'the rollback removed history instead of adding to it');
    assert(after.versions.some((v) => v.version === 2), 'the superseded version was deleted');
    eq(after.current.payload.description, 'first', 'the values did not come back');
  });

  await check('a diff across two different artefacts is refused', async () => {
    const id = need(REF.versionedRuleId, 'a versioned rule');
    const { data: hist } = await req(`/api/admin/versions/rule/${id}`, { token: T.admin, expect: 200 });
    const { data: index } = await req('/api/admin/versions', { token: T.admin, expect: 200 });
    const other = index.recent.find((v) => v.logical_id !== String(id) || v.kind !== 'rule');
    if (!other) return;

    await req(`/api/admin/versions/diff?a=${hist.versions[0].id}&b=${other.id}`,
      { token: T.admin, expect: 400 });
  });

  await check('the version history needs admin.rules', async () => {
    const id = need(REF.versionedRuleId, 'a versioned rule');
    for (const role of ['sales_rm', 'caller', 'customer_care', 'marketing_manager']) {
      await req(`/api/admin/versions/rule/${id}`, { token: T[role], expect: 403 });
    }
  });

  await check('an artefact nobody versions says so', async () => {
    await req('/api/admin/versions/not_a_thing/1', { token: T.admin, expect: 404 });
  });

  await check('every versioned kind is offered by name', async () => {
    const { data } = await req('/api/admin/versions', { token: T.admin, expect: 200 });
    const keys = data.kinds.map((k) => k.key).sort();
    // The four the audit found unversioned.
    for (const k of ['kyc_journey', 'rule', 'sla_policy', 'template']) {
      assert(keys.includes(k), `${k} is not versioned`);
    }
    assert(data.kinds.every((k) => k.label), 'a kind has no human label');
  });

  /* ============================================================ 53 */
  suite('53 email intent and consent');

  /** /api/leads answers with a bare array; other list routes wrap in .rows. */
  const leadRows = ({ data }) => (Array.isArray(data) ? data : (data.rows ?? []));

  /*
   * Consent differs by intent, and the difference is the whole point of having
   * two words for it: a service email about an existing account reaches a
   * client who has opted out of marketing, and a pitch does not.
   *
   * The composer used to send no intent at all. The server defaults a missing
   * one to 'service' -- the permissive branch -- so every email it sent, pitches
   * included, went out as service and the opt-out never applied.
   */

  await check('a marketing email to an opted-out client is refused', async () => {
    const optedOut = need(
      leadRows(await req('/api/leads?limit=200', { token: T.admin, expect: 200 }))
        .find((l) => l.marketing_opt_out && l.email),
      'a lead with an email who has opted out of marketing',
    );

    const { data } = await req('/api/email/send', {
      method: 'POST', token: T.admin, expect: 409,
      body: {
        lead_id: optedOut.id,
        subject: 'A product you might like',
        body: 'Pitch.',
        intent: 'marketing',
      },
    });
    assert(/opted out/i.test(data.error), `unhelpful refusal: ${data.error}`);
  });

  await check('a service email to the same client is allowed', async () => {
    // The counter-half. Without it, a route that refused everything would
    // satisfy the test above, and refusing a KYC reminder is its own failure.
    const optedOut = need(
      leadRows(await req('/api/leads?limit=200', { token: T.admin, expect: 200 }))
        .find((l) => l.marketing_opt_out && l.email),
      'a lead with an email who has opted out of marketing',
    );

    await req('/api/email/send', {
      method: 'POST', token: T.admin, expect: 200,
      body: {
        lead_id: optedOut.id,
        subject: 'Your KYC is incomplete',
        body: 'Two steps left on your account opening.',
        intent: 'service',
      },
    });
  });

  await check('the composer declares an intent rather than letting it default', async () => {
    /* Guards the actual defect. The server still defaults a missing intent to
     * 'service' for older callers, so an API-level test cannot see the bug --
     * the composer has to be the thing that is checked. */
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../client/src/crm/EmailComposer.jsx', import.meta.url), 'utf8',
    );

    assert(/intent:\s*form\.intent/.test(src),
      'EmailComposer does not send an intent — every email it sends will be treated as service');
    assert(/intent-switch/.test(src),
      'EmailComposer does not ask which kind of email this is');
    assert(/disabled=\{!d\.consent\.marketing_allowed\}/.test(src),
      'the marketing option is not disabled for a client who has opted out');
  });

  await check('a hostile body is neutralised before it reaches storage', async () => {
    /* The composer sends markup now (P2-09), so the body is whatever an RM
     * pasted. Sanitising only what leaves for the mail server is half a fix:
     * the same body is written to the activity timeline and rendered back
     * inside the CRM, which makes an unsanitised copy stored XSS against a
     * colleague rather than a problem for the recipient.
     *
     * sanitize.test.mjs proves the function. This proves the wiring. */
    const lead = need(
      leadRows(await req('/api/leads?limit=50', { token: T.admin, expect: 200 }))
        .find((l) => l.email && !l.marketing_opt_out),
      'a contactable lead',
    );

    const subject = `Sanitiser wiring ${RUN}`;
    await req('/api/email/send', {
      method: 'POST', token: T.admin, expect: 200,
      body: {
        lead_id: lead.id,
        subject,
        intent: 'service',
        body: "<p onmouseover='steal()'>Hello <b>there</b></p>"
          + '<script>alert(1)</script>'
          + "<a href='javascript:bad()'>click</a>"
          + "<img src='https://tracker.example/p.gif'>",
      },
    });

    const { data } = await req(`/api/activities/lead/${lead.id}`, { token: T.admin, expect: 200 });
    const logged = need(data.find((a) => a.subject === subject), 'the sent email on the timeline');

    const stored = String(logged.body || '').toLowerCase();
    for (const bad of ['<script', 'onmouseover', 'javascript:', '<img']) {
      assert(!stored.includes(bad), `"${bad}" was stored on the timeline: ${logged.body}`);
    }
    // …and the real message survived, so this is not a route that stores nothing.
    assert(/hello/i.test(stored) && stored.includes('<b>'),
      `the content was stripped along with the payload: ${logged.body}`);
  });

  await check('every email entry point opens the composer, not the plain modal', async () => {
    /* P2-08. The message modal was built for WhatsApp and SMS -- nothing to
     * attach, no collateral to pick -- so reaching email from a product card
     * gave a bare textarea while reaching it from the lead address gave
     * attachments and the content library. Same act, two products, and only
     * one of them could attach anything. */
    const { readFileSync } = await import('node:fs');
    const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

    const actions = read('../../client/src/crm/leadActions.jsx');
    assert(/case 'email': return setModal\(\{ kind: 'email'/.test(actions),
      'the email action still opens the generic message modal');

    const modals = read('../../client/src/crm/ActionModals.jsx');
    assert(/case 'email': return \(/.test(modals) && /EmailComposer/.test(modals),
      'the modal host does not render the composer for email');

    // …and WhatsApp and SMS still use the modal that suits them.
    assert(/case 'whatsapp': return setModal\(\{ kind: 'message'/.test(actions),
      'WhatsApp was moved onto the email composer, which has no reason to exist for it');
  });

  await check('the send is recorded with the intent it was sent under', async () => {
    const lead = need(
      leadRows(await req('/api/leads?limit=50', { token: T.admin, expect: 200 }))
        .find((l) => l.email && !l.marketing_opt_out),
      'a contactable lead',
    );

    await req('/api/email/send', {
      method: 'POST', token: T.admin, expect: 200,
      body: {
        lead_id: lead.id, subject: 'Quarterly note', body: 'Body.', intent: 'marketing',
      },
    });

    const { data } = await req(`/api/activities/lead/${lead.id}`, { token: T.admin, expect: 200 });
    const sent = data.find((a) => a.subject === 'Quarterly note');
    assert(sent, 'the email was not logged against the lead at all');
  });

  /* ============================================================ 54 */
  suite('54 templates and merge fields');

  /*
   * Finding 10 of the LeadSquared audit, from the other end: that tenant was
   * full of copy keyed to fields nobody could resolve. A merge field that does
   * not resolve fails silently -- it emails a client a sentence with a hole in
   * it -- so the check belongs where the template is written, not where it is
   * sent.
   */

  await check('only fields that exist and are safe to send are offered', async () => {
    const { data } = await req('/api/email/merge-fields', { token: T.sales_rm, expect: 200 });
    const tokens = data.fields.map((f) => f.token);

    assert(tokens.length > 5, `only ${tokens.length} merge fields offered`);
    assert(tokens.includes('name') && tokens.includes('rm'),
      'the computed tokens the templates already use are missing');

    /* The important half of the list is what is NOT in it. A PAN in the body
     * of an email is a data-protection incident, not personalisation, and
     * `pan` is a perfectly real field in the registry. */
    assert(!tokens.includes('pan'), 'PAN is offered as a merge field');

    for (const f of data.fields) assert(f.label, `${f.token} has no label`);
  });

  await check('a personal template saves and is usable straight away', async () => {
    const { data } = await req('/api/email/templates', {
      method: 'POST', token: T.sales_rm, expect: 201,
      body: {
        name: `Personal draft ${RUN}`,
        subject: 'About your SIP, {{name}}',
        body: '<p>Hello {{name}}, {{rm}} here.</p>',
        scope: 'personal',
      },
    });
    eq(data.scope, 'personal');
    eq(data.approved, true, 'an RM has to wait for approval on their own wording');
    REF.personalTemplateId = data.id;
  });

  await check("a personal template is offered to its owner and nobody else", async () => {
    const lead = need(
      leadRows(await req('/api/leads?limit=50', { token: T.sales_rm, expect: 200 }))
        .find((l) => l.email),
      'a lead with an email',
    );

    const mine = await req(`/api/email/compose/${lead.id}`, { token: T.sales_rm, expect: 200 });
    assert(mine.data.templates.some((t) => t.id === REF.personalTemplateId),
      'the author cannot see their own template');

    // Somebody else's draft is not firm-wide copy and must not appear as if
    // it were approved.
    const theirs = await req(`/api/email/compose/${lead.id}`, { token: T.admin, expect: 200 });
    assert(!theirs.data.templates.some((t) => t.id === REF.personalTemplateId),
      "another user was shown somebody else's personal draft");
  });

  await check('a firm-wide template needs an administrator', async () => {
    const { data } = await req('/api/email/templates', {
      method: 'POST', token: T.sales_rm, expect: 403,
      body: { name: `Org attempt ${RUN}`, subject: 's', body: '<p>b</p>', scope: 'org' },
    });
    // The refusal has to say what to do instead, or the RM simply gives up and
    // writes free text every time.
    assert(/personal/i.test(data.fix ?? ''), `unhelpful refusal: ${JSON.stringify(data)}`);

    await req('/api/email/templates', {
      method: 'POST', token: T.admin, expect: 201,
      body: { name: `Org template ${RUN}`, subject: 's', body: '<p>b</p>', scope: 'org' },
    });
  });

  await check('a firm-wide template is not usable until it is approved', async () => {
    const lead = need(
      leadRows(await req('/api/leads?limit=50', { token: T.sales_rm, expect: 200 }))
        .find((l) => l.email),
      'a lead with an email',
    );
    const { data } = await req(`/api/email/compose/${lead.id}`, { token: T.sales_rm, expect: 200 });
    assert(!data.templates.some((t) => t.name === `Org template ${RUN}`),
      'an unapproved firm-wide template was offered for use');
  });

  await check('a template naming a field that does not exist is refused, and says which', async () => {
    const { data } = await req('/api/email/templates', {
      method: 'POST', token: T.sales_rm, expect: 400,
      body: {
        name: `Bad merge ${RUN}`,
        subject: 'Hi {{first_name}}',
        body: '<p>Your {{portfolio_value}} is ready, {{name}}.</p>',
        scope: 'personal',
      },
    });

    // Naming them is the point: "invalid template" leaves somebody hunting
    // through their own copy for which brace is wrong.
    assert(data.unknown.includes('first_name'), `first_name not reported: ${JSON.stringify(data)}`);
    assert(data.unknown.includes('portfolio_value'), 'portfolio_value not reported');
    assert(!data.unknown.includes('name'), 'a valid field was reported as unknown');
  });

  await check('a template body is sanitised on the way in, not just on the way out', async () => {
    const { data } = await req('/api/email/templates', {
      method: 'POST', token: T.sales_rm, expect: 201,
      body: {
        name: `Hostile template ${RUN}`,
        subject: 'Hello',
        body: "<p>Hi {{name}}</p><script>alert(1)</script><a href='javascript:x()'>c</a>",
        scope: 'personal',
      },
    });

    const lead = need(
      leadRows(await req('/api/leads?limit=50', { token: T.sales_rm, expect: 200 }))
        .find((l) => l.email),
      'a lead with an email',
    );
    const composed = await req(`/api/email/compose/${lead.id}`, { token: T.sales_rm, expect: 200 });
    const saved = composed.data.templates.find((t) => t.id === data.id);
    assert(saved, 'the template was not saved');
    assert(!/<script|javascript:/i.test(saved.body),
      `a stored template carries a payload every future send would reuse: ${saved.body}`);
  });

  await check('only your own personal drafts can be deleted', async () => {
    await req(`/api/email/templates/${need(REF.personalTemplateId, 'a personal template')}`, {
      method: 'DELETE', token: T.admin, expect: 403,
    });
    await req(`/api/email/templates/${REF.personalTemplateId}`, {
      method: 'DELETE', token: T.sales_rm, expect: 200,
    });
  });

  /* ============================================================ 55 */
  suite('55 the lead next step');

  /*
   * P2-12. The lead header used to read "2 Warm · 1 Active" -- a count of
   * product states, shown to somebody one tab away from seeing those states
   * laid out in full. It described the record to a reader already looking at
   * it. What changes an RM's next hour is what to do next, and that was behind
   * a button.
   */

  await check('a lead with engaged products gets one next step, not a list', async () => {
    const leads = leadRows(await req('/api/leads?limit=60', { token: T.sales_rm, expect: 200 }));
    let found = null;
    for (const l of leads) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/leads/${l.id}`, { token: T.sales_rm, expect: 200 });
      if (data.next_step && data.next_step.headline !== 'Nothing outstanding') { found = data; break; }
    }
    const lead = need(found, 'a lead with an engaged product');

    assert(lead.next_step.headline, 'the step has no headline');
    assert(lead.next_step.why, 'the step does not say why');
    assert(lead.next_step.product, 'the step does not say which product it is about');
    assert(typeof lead.next_step.urgent === 'boolean', 'urgency is not declared');
    REF.nextStepLead = lead.id;
  });

  await check('the step offers the action, or says why it cannot', async () => {
    const id = need(REF.nextStepLead, 'a lead with a next step');
    const { data } = await req(`/api/leads/${id}`, { token: T.sales_rm, expect: 200 });
    // One or the other, never neither: a step with no action and no reason is
    // advice the reader cannot act on and cannot understand.
    assert(data.next_step.action || data.next_step.blocked_reason,
      'the step offers neither an action nor a reason it is unavailable');
  });

  await check('the step is scoped to what this role may actually do', async () => {
    /* Computed on the server precisely because the ordering depends on the
     * caller's capabilities, which the browser does not hold. A caller who
     * cannot mark a card gets the reason rather than a button that fails. */
    const id = need(REF.nextStepLead, 'a lead with a next step');
    const { data: asRm } = await req(`/api/leads/${id}`, { token: T.sales_rm, expect: 200 });
    const { data: asCaller } = await req(`/api/leads/${id}`, { token: T.caller });

    if (asCaller?.next_step) {
      assert(asCaller.next_step.action || asCaller.next_step.blocked_reason,
        'a restricted role got a step with neither an action nor an explanation');
    }
    assert(asRm.next_step, 'the owner role lost its next step');
  });

  await check('a lead with nothing engaged is given no advice at all', async () => {
    // Every lead carries a card for every product, so counting INACTIVE ones
    // would make "find out whether they want this" the advice on every lead in
    // the book, forever. Silence is the correct answer.
    const leads = leadRows(await req('/api/leads?limit=60', { token: T.sales_rm, expect: 200 }));
    let bare = null;
    for (const l of leads) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await req(`/api/leads/${l.id}`, { token: T.sales_rm, expect: 200 });
      if (!(data.cards ?? []).some((c) => c.state && c.state !== 'INACTIVE')) { bare = data; break; }
    }
    if (bare) eq(bare.next_step, null, 'a lead with no engaged product was given a next step anyway');
  });

  await check('the header no longer carries the state count it replaced', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../client/src/crm/LeadDetail.jsx', import.meta.url), 'utf8');

    assert(!/<CardStrip/.test(src),
      'the lead header still renders the product state counts P2-12 removed');
    assert(/lead-next-step/.test(src), 'the header does not render the next step');

    /* …and the list still does. Scanning forty leads for shape is a different
     * job from working one, and a count is the right answer for that. */
    const list = readFileSync(new URL('../../client/src/crm/Leads.jsx', import.meta.url), 'utf8');
    assert(/<CardStrip/.test(list),
      'the counts were removed from the list too, where they were doing their job');
  });

  await check('the header step does not borrow the product panel styling', async () => {
    /* `.next-step` already belongs to ProductPanel (ENH-10b) and lays out as a
     * column. Reusing the name would have restyled the header row with that
     * layout and tied any future change to either one to the other. */
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../../client/src/styles.css', import.meta.url), 'utf8');
    assert(/\.lead-next-step\s*\{/.test(css), 'the header step has no styling of its own');
    assert(/\.next-step\s*\{/.test(css), 'the product panel styling was removed');
  });

  /* ============================================================ 56 */
  suite('56 drill-through');

  /*
   * P2-13. A tile promises that its number and its list are the same set.
   * Anything else is worse than no link, because the reader believes it.
   *
   * Before this, thirty of fifty-two tiles across five roles disagreed with
   * their own destination -- "New leads 32" opening a list of 40, "SLA
   * breached 2" opening all 11 tickets, `/clients?dormant=true` filtering on a
   * parameter the route did not read. The counts were right and the links were
   * decorative.
   *
   * This walks every tile of every role and asks the destination what it
   * returns, so the promise is checked rather than assumed.
   */

  const LIST_API = {
    '/leads': '/api/leads',
    '/clients': '/api/clients',
    '/tickets': '/api/tickets',
    '/tasks': '/api/tasks',
    '/partners': '/api/partners',
  };

  const countAt = async (to, token) => {
    const [path, qs] = String(to).split('?');
    const api = LIST_API[path];
    if (!api) return null;                       // not a list route: not our promise
    const { data, res } = await req(`${api}?limit=500${qs ? `&${qs}` : ''}`, { token, expect: 200 });
    const total = res.headers.get('X-Total-Count');
    if (total != null) return Number(total);
    const rows = Array.isArray(data) ? data : (data.rows ?? data.items ?? []);
    return rows.length;
  };

  await check('every tile that offers a list returns exactly what it counted', async () => {
    const problems = [];

    for (const [role, token] of Object.entries(T)) {
      const { status, data } = await req('/api/dashboard', { token });
      if (status !== 200) continue;              // role has no dashboard

      for (const tile of data.tiles ?? []) {
        if (!tile.to) continue;
        const counted = Number(tile.value);
        if (!Number.isFinite(counted)) continue; // a percentage or a sum

        const returned = await countAt(tile.to, token);
        if (returned === null) continue;

        if (returned !== counted) {
          problems.push(`${role} · ${tile.label}: counted ${counted}, ${tile.to} returns ${returned}`);
        }
      }
    }

    assert(problems.length === 0,
      `a tile does not open the records it counted:\n         ${problems.join('\n         ')}`);
  });

  await check('a tile with no list to open says so by having no link', async () => {
    /* A percentage has no list behind it and a sum's records are not the sum.
     * "Calls logged" used to point at /leads -- a different set with a
     * plausible-looking number, which is the worst kind of wrong. */
    const { data } = await req('/api/dashboard', { token: T.sales_rm, expect: 200 });
    for (const tile of data.tiles ?? []) {
      if (!tile.to) continue;
      assert(!/^\/leads/.test(tile.to) || !/calls/i.test(tile.label),
        `${tile.label} points at a list of leads, which is not what it counts`);
    }
  });

  await check('the filters the tiles rely on actually filter', async () => {
    // Each of these was referenced by a destination before the route read it.
    const cases = [
      ['/api/leads?unattended_hours=48', '/api/leads'],
      ['/api/tickets?breached=true', '/api/tickets'],
      ['/api/tasks?overdue=true', '/api/tasks'],
      ['/api/partners?state=ACTIVE', '/api/partners'],
    ];
    for (const [filtered, unfiltered] of cases) {
      const a = await countAt(filtered.replace('/api', ''), T.admin)
        ?? (await req(filtered, { token: T.admin, expect: 200 })).data.length;
      const b = await countAt(unfiltered.replace('/api', ''), T.admin)
        ?? (await req(unfiltered, { token: T.admin, expect: 200 })).data.length;
      assert(a <= b, `${filtered} returned more than ${unfiltered} (${a} > ${b})`);
    }
  });

  await check('a task list never carries another book\'s leads', async () => {
    /* Found by a tile disagreeing with its own drill-through. /api/tasks had
     * no lead scope at all, so `all=true` returned every task in the system --
     * forty of them on Bonanza leads, each labelled with that client's name.
     * The record routes were scoped in August; the list routes were assumed
     * already filtered, and this one was not. */
    const bigul = await login('supervisor@bigul.test');
    const { data } = await req('/api/tasks?all=true', { token: bigul, expect: 200 });
    const rows = Array.isArray(data) ? data : (data.rows ?? []);

    const bonanzaLeads = new Set(
      leadRows(await req('/api/leads?limit=200', { token: T.superadmin, expect: 200 }))
        .filter((l) => l.sales_org === 'BONANZA')
        .map((l) => Number(l.id)),
    );

    const crossed = rows.filter((t) => t.lead_id && bonanzaLeads.has(Number(t.lead_id)));
    assert(crossed.length === 0,
      `a Bigul supervisor was shown ${crossed.length} tasks on Bonanza leads`);
  });

  /* ============================================================ 57 */
  suite('57 custom range and chart drill-through');

  await check('a custom window is honoured, and its tiles open that window', async () => {
    /* P2-16. The server has resolved `custom` from the start; the client hid
     * the option and never sent from/to. Because a tile builds its destination
     * from the range it was asked for, opening the window to the UI made the
     * drill-through carry it with no extra work -- which is the payoff for
     * having fixed P2-13 at the source rather than per tile. */
    const { data } = await req('/api/dashboard?range=custom&from=2026-08-01&to=2026-08-15',
      { token: T.admin, expect: 200 });

    eq(data.range.code, 'custom');
    eq(data.range.from, '2026-08-01');
    eq(data.range.to, '2026-08-15');

    const newLeads = need(data.tiles.find((t) => t.label === 'New leads'), 'the New leads tile');
    assert(/created_from=2026-08-01/.test(newLeads.to) && /created_to=2026-08-15/.test(newLeads.to),
      `the tile does not carry the custom window: ${newLeads.to}`);

    const { res } = await req(`/api/leads?limit=500&${newLeads.to.split('?')[1]}`,
      { token: T.admin, expect: 200 });
    eq(Number(res.headers.get('X-Total-Count')), Number(newLeads.value),
      'the custom-window tile does not open the records it counted');
  });

  await check('a narrower window counts fewer than a wider one', async () => {
    // Guards the filter being accepted and ignored, which looks identical to
    // it working when the seed happens to fit inside the window.
    const wide = await req('/api/dashboard?range=custom&from=2026-01-01&to=2026-12-31', { token: T.admin, expect: 200 });
    const narrow = await req('/api/dashboard?range=custom&from=2026-08-01&to=2026-08-02', { token: T.admin, expect: 200 });
    const v = (d) => Number(d.data.tiles.find((t) => t.label === 'New leads')?.value ?? 0);
    assert(v(narrow) <= v(wide), `narrow window counted more than wide (${v(narrow)} > ${v(wide)})`);
  });

  await check('every chart value opens exactly the records behind it', async () => {
    /* P2-17c. Same promise the tiles make, and the funnel is the one worth
     * checking: it is cumulative, so a single-stage link would open a strict
     * subset of the number the reader clicked. */
    const { data } = await req('/api/dashboard', { token: T.admin, expect: 200 });
    const problems = [];

    for (const chart of data.charts ?? []) {
      for (const point of chart.stages ?? chart.data ?? []) {
        if (!point.to) continue;
        const { res } = await req(`/api/leads?limit=500&${point.to.split('?')[1]}`,
          { token: T.admin, expect: 200 });
        const returned = Number(res.headers.get('X-Total-Count'));
        if (returned !== Number(point.value)) {
          problems.push(`${chart.kind} · ${point.label}: shows ${point.value}, opens ${returned}`);
        }
      }
    }
    assert(problems.length === 0,
      `a chart value does not open its own records:\n         ${problems.join('\n         ')}`);
  });

  await check('every chart value carries a destination at all', async () => {
    const { data } = await req('/api/dashboard', { token: T.admin, expect: 200 });
    for (const chart of data.charts ?? []) {
      for (const point of chart.stages ?? chart.data ?? []) {
        assert(point.to, `${chart.kind} · ${point.label} has no destination`);
      }
    }
  });

  /* ------------------------------------------------------------- report */
  report();
}

/* ---------------------------------------------------------------- output */

function report() {
  const bySuite = new Map();
  for (const r of results) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
    bySuite.get(r.suite).push(r);
  }

  for (const [name, rows] of bySuite) {
    const failed = rows.filter((r) => !r.ok).length;
    console.log(`\n${name}  ${failed ? `— ${failed} FAILED` : ''}`);
    for (const r of rows) {
      console.log(`  ${r.ok ? '  ok' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n         → ${r.error}`}`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const ms = results.reduce((s, r) => s + r.ms, 0);

  // Slowest tests, because a suite that quietly gets slower is a suite people
  // stop running. Anything over a quarter second deserves an explanation.
  const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 6).filter((r) => r.ms > 250);
  if (slow.length) {
    console.log('\nslowest');
    for (const r of slow) console.log(`  ${String(r.ms).padStart(6)}ms  ${r.name}`);
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}  ·  ${(ms / 1000).toFixed(1)}s`);
  console.log(`${'─'.repeat(64)}\n`);

  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error('\nSuite aborted:', err.message);
  report();
});
