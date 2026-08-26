/**
 * Test data — realistic volume, on top of the seed.
 *
 * WHY THIS IS SEPARATE FROM seed.js
 * ---------------------------------
 * `seed.js` builds a small, hand-curated fixture set that the e2e suite asserts
 * against by name and by position. Adding volume to it would break those tests
 * and make the failures look like product bugs.
 *
 * This is additive and disposable instead: it never touches a seeded row, marks
 * everything it creates, and can be removed in one command. Run it when you want
 * enough records to see whether a filter, a dashboard or a campaign behaves at
 * scale; leave it out when you want a clean fixture.
 *
 *   node src/testdata.js            add the default 500 leads
 *   node src/testdata.js 2000       add 2000
 *   node src/testdata.js --clear    remove everything this script ever made
 *
 * EVERY RECORD IS MARKED
 * ----------------------
 * Test leads carry `client_code` beginning `TEST-`, which no real record uses.
 * That is what `--clear` keys on, and it is why this cannot delete real data
 * even if someone runs it against a populated database by mistake.
 *
 * THE DATA IS SYNTHETIC AND LOOKS IT
 * ----------------------------------
 * Mobile numbers are drawn from the 9999xxxxxx block, emails all resolve to
 * example.test, and PANs follow the format but are not issuable. Nobody should
 * be able to mistake a test record for a client, and nothing here would reach a
 * real person if an integration were accidentally switched live.
 */

/* dotenv first: security.js reads CRM_MASTER_KEY at module load, and ES
   imports are hoisted — so without this the script encrypts under the
   development key while the server decrypts under the real one. */
import 'dotenv/config';
import { db, all, one, run, transact } from './db.js';
import { encryptField } from './security.js';

const MARK = 'TEST-';

/* ------------------------------------------------------------- clearing */

function clearTestData() {
  const leads = all("SELECT id FROM leads WHERE client_code LIKE ?", [`${MARK}%`]).map((r) => r.id);
  if (!leads.length) {
    console.log('No test data found. Nothing to remove.');
    return;
  }

  const list = leads.map(() => '?').join(',');
  transact(() => {
    // Children first, so nothing is orphaned if this is interrupted.
    for (const t of ['activities', 'tasks', 'tickets', 'product_cards', 'kyc_journeys', 'notes']) {
      try { run(`DELETE FROM ${t} WHERE lead_id IN (${list})`, leads); } catch { /* table may not carry lead_id */ }
    }
    run(`DELETE FROM lead_list_members WHERE lead_id IN (${list})`, leads);
    run(`DELETE FROM field_value WHERE entity = 'lead' AND record_id IN (${list})`, leads);
    run(`DELETE FROM field_history WHERE entity = 'lead' AND record_id IN (${list})`, leads);
    run(`DELETE FROM leads WHERE id IN (${list})`, leads);
    run("DELETE FROM lead_lists WHERE name LIKE ?", [`${MARK}%`]);
    run("DELETE FROM campaigns WHERE name LIKE ?", [`${MARK}%`]);
  });

  console.log(`Removed ${leads.length} test leads and everything attached to them.`);
}

/* ---------------------------------------------------------- ingredients */

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Reyansh', 'Krishna', 'Ishaan',
  'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Pari', 'Anika', 'Navya', 'Riya',
  'Rohan', 'Kabir', 'Advait', 'Dhruv', 'Meera', 'Kavya', 'Ira', 'Myra',
  'Farhan', 'Zoya', 'Imran', 'Ayesha', 'Rizwan', 'Nafisa'];

const LAST = ['Sharma', 'Verma', 'Patel', 'Shah', 'Mehta', 'Iyer', 'Nair', 'Rao',
  'Reddy', 'Kulkarni', 'Joshi', 'Desai', 'Gupta', 'Malhotra', 'Chawla', 'Bansal',
  'Qureshi', 'Ansari', 'Sheikh', 'Menon', 'Pillai', 'Bhat', 'Sinha', 'Chatterjee'];

const CITIES = [
  ['Mumbai', 'Maharashtra'], ['Pune', 'Maharashtra'], ['Nagpur', 'Maharashtra'],
  ['Ahmedabad', 'Gujarat'], ['Surat', 'Gujarat'], ['Rajkot', 'Gujarat'],
  ['Bengaluru', 'Karnataka'], ['Mysuru', 'Karnataka'],
  ['Chennai', 'Tamil Nadu'], ['Coimbatore', 'Tamil Nadu'],
  ['Hyderabad', 'Telangana'], ['Delhi', 'Delhi'], ['Jaipur', 'Rajasthan'],
  ['Kolkata', 'West Bengal'], ['Indore', 'Madhya Pradesh'], ['Lucknow', 'Uttar Pradesh'],
];

const LANGS = ['English', 'Hindi', 'Gujarati', 'Marathi', 'Tamil', 'Telugu', 'Kannada', 'Bengali'];
const RISKS = ['Conservative', 'Moderate', 'Aggressive'];
const STAGES = ['New', 'Contacted', 'Qualified', 'In Progress', 'Won', 'Lost'];

/**
 * Sources weighted the way a real book skews — most leads come from a handful
 * of channels, not evenly from all thirteen. A uniform spread would make every
 * source filter return the same count and hide exactly the bugs volume is
 * supposed to surface.
 */
const SOURCE_WEIGHTS = [
  ['Website', 22], ['Google Ads', 16], ['Facebook Lead Ads', 14], ['Bigul app', 12],
  ['Partner referral', 10], ['Referral — existing client', 7], ['DKYC Portal', 6],
  ['Campaign — WhatsApp', 5], ['Walk-in branch', 3], ['Webinar', 2],
  ['IPO enquiry', 2], ['Import', 1],
];

const DISPOSITIONS = [
  ['Connected', 'Interested'], ['Connected', 'Call back later'], ['Connected', 'Not interested'],
  ['Connected', 'Wrong number'], ['Not reachable', 'Ringing no answer'],
  ['Not reachable', 'Switched off'], ['Not reachable', 'Busy'],
];

/* A tiny deterministic PRNG, so two runs with the same seed match. */
let s = 20260822;
const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

function weighted(pairs) {
  const total = pairs.reduce((t, [, w]) => t + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[0][0];
}

const ago = (days, hours = 0) =>
  new Date(Date.now() - days * 86_400_000 - hours * 3_600_000)
    .toISOString().slice(0, 19).replace('T', ' ');

/* -------------------------------------------------------------- build */

function generate(count) {
  const orgs = all('SELECT code FROM sales_orgs WHERE active = 1').map((r) => r.code);
  if (!orgs.length) throw new Error('No sales orgs. Run `node src/seed.js` first.');

  const ownersByOrg = {};
  for (const org of orgs) {
    ownersByOrg[org] = all(
      "SELECT id FROM users WHERE active = 1 AND sales_org = ? AND role IN ('sales_rm','caller','dealer')",
      [org],
    ).map((r) => r.id);
  }

  const partnersByOrg = {};
  for (const org of orgs) {
    partnersByOrg[org] = all(
      "SELECT id FROM partners WHERE state_code = 'ACTIVE' AND sales_org = ?", [org],
    ).map((r) => r.id);
  }

  const productsByOrg = {};
  for (const org of orgs) {
    productsByOrg[org] = all(
      'SELECT id FROM product_types WHERE active = 1 AND sales_org = ?', [org],
    ).map((r) => r.id);
  }

  const start = one("SELECT COALESCE(MAX(CAST(SUBSTR(client_code, 6) AS INTEGER)), 0) n FROM leads WHERE client_code LIKE ?", [`${MARK}%`]).n;

  const made = { leads: 0, activities: 0, tasks: 0, tickets: 0, cards: 0, optedOut: 0, badMobile: 0 };

  transact(() => {
    for (let i = 1; i <= count; i += 1) {
      const n = start + i;
      const org = orgs[i % orgs.length];
      const owners = ownersByOrg[org];
      if (!owners.length) continue;

      const first = pick(FIRST);
      const last = pick(LAST);
      const [city, state] = pick(CITIES);
      const ageDays = int(0, 210);

      // A realistic minority are uncontactable. Without these, the consent
      // rules and the invalid-number handling never get exercised.
      const optOut = rnd() < 0.08;
      const badMobile = rnd() < 0.05;
      if (optOut) made.optedOut += 1;
      if (badMobile) made.badMobile += 1;

      const res = run(
        `INSERT INTO leads
           (sales_org, name, mobile, email, pan, city, state, language, risk_profile,
            source, stage, score, owner_id, partner_id, client_code,
            marketing_opt_out, mobile_invalid, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          org, `${first} ${last}`,
          // 9999xxxxxx — a block that is obviously synthetic at a glance.
          `9999${String(100000 + n).slice(-6)}`,
          `${first.toLowerCase()}.${last.toLowerCase()}${n}@example.test`,
          encryptField(`ZZ${String(n).padStart(3, '0').slice(-3)}PT${String(1000 + n).slice(-4)}Z`),
          city, state, pick(LANGS), pick(RISKS),
          weighted(SOURCE_WEIGHTS), pick(STAGES), int(5, 95),
          pick(owners),
          rnd() < 0.18 && partnersByOrg[org].length ? pick(partnersByOrg[org]) : null,
          `${MARK}${n}`,
          optOut ? 1 : 0, badMobile ? 1 : 0,
          ago(ageDays), ago(Math.floor(ageDays / 3)),
        ],
      );
      const leadId = Number(res.lastInsertRowid);
      made.leads += 1;

      // Product cards, a couple engaged so the pipeline is not all INACTIVE.
      const products = productsByOrg[org];
      products.forEach((pid, idx) => {
        const engaged = idx < int(0, 3);
        const stateCode = engaged
          ? pick(['EXPLORING', 'WARM', 'PRODUCT_RM_ENGAGED', 'ACTIVE', 'ON_HOLD'])
          : 'INACTIVE';
        run(
          `INSERT INTO product_cards (lead_id, product_type_id, state, value, last_state_at)
           VALUES (?,?,?,?,?)`,
          [leadId, pid, stateCode, stateCode === 'ACTIVE' ? int(25_000, 4_000_000) : 0, ago(int(0, ageDays))],
        );
        made.cards += 1;
      });

      // Interactions, thinning out the further back the lead goes.
      for (let a = 0; a < int(0, 6); a += 1) {
        const [disp, sub] = pick(DISPOSITIONS);
        const type = pick(['Call', 'Call', 'Call', 'WhatsApp', 'Email', 'SMS', 'Meeting']);
        run(
          `INSERT INTO activities
             (lead_id, type, direction, subject, body, disposition, sub_disposition,
              duration_s, user_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            leadId, type, 'outbound', `${type} — ${disp}`,
            `${sub}. Synthetic test record.`,
            type === 'Call' ? disp : null, type === 'Call' ? sub : null,
            type === 'Call' ? int(20, 600) : null,
            pick(owners), ago(int(0, ageDays), int(0, 23)),
          ],
        );
        made.activities += 1;
      }

      if (rnd() < 0.3) {
        run(
          `INSERT INTO tasks (lead_id, title, kind, due_at, priority, status, assignee_id, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            leadId, pick(['Call back', 'Send proposal', 'Collect documents', 'Follow up on KYC']),
            'Follow-up', ago(int(-14, 5)), pick(['High', 'Medium', 'Low']),
            rnd() < 0.6 ? 'Open' : 'Done', pick(owners), ago(int(0, ageDays)),
          ],
        );
        made.tasks += 1;
      }

      if (rnd() < 0.12) {
        run(
          `INSERT INTO tickets (lead_id, ref, subject, description, priority, status, assignee_id, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            leadId, `TST-${String(n).padStart(5, '0')}`,
            pick(['Cannot log in', 'Statement request', 'Brokerage query', 'Payout not received']),
            'Synthetic test record.', pick(['Critical', 'High', 'Medium', 'Low']),
            pick(['Open', 'In Progress', 'Resolved']), pick(owners), ago(int(0, 30)),
          ],
        );
        made.tickets += 1;
      }
    }
  });

  return made;
}

/**
 * A list and a campaign over the test leads, so the campaign screens have
 * something with real volume behind them.
 */
function buildListAndCampaign() {
  const existing = one('SELECT id FROM lead_lists WHERE name = ?', [`${MARK}All test leads`]);
  const listId = existing
    ? existing.id
    : Number(run('INSERT INTO lead_lists (name, kind) VALUES (?,?)',
      [`${MARK}All test leads`, 'static']).lastInsertRowid);

  run('DELETE FROM lead_list_members WHERE list_id = ?', [listId]);
  const leads = all('SELECT id FROM leads WHERE client_code LIKE ?', [`${MARK}%`]);
  transact(() => {
    for (const l of leads) {
      run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [listId, l.id]);
    }
  });

  if (!one('SELECT id FROM campaigns WHERE name = ?', [`${MARK}Diwali PMS push`])) {
    run(
      `INSERT INTO campaigns (name, channel, list_id, status, created_by)
       VALUES (?,?,?,'Draft',(SELECT id FROM users WHERE role='marketing_manager' LIMIT 1))`,
      [`${MARK}Diwali PMS push`, 'whatsapp', listId],
    );
  }

  return { listId, members: leads.length };
}

/* --------------------------------------------------------------- main */

const arg = process.argv[2];

if (arg === '--clear') {
  clearTestData();
} else {
  const count = Number(arg) || 500;
  if (!Number.isFinite(count) || count < 1 || count > 100_000) {
    console.error('Give a count between 1 and 100000.');
    process.exit(1);
  }

  console.log(`Generating ${count} test leads…`);
  const t0 = Date.now();
  const made = generate(count);
  const list = buildListAndCampaign();
  const ms = Date.now() - t0;

  const total = one('SELECT COUNT(*) n FROM leads').n;
  const test = one('SELECT COUNT(*) n FROM leads WHERE client_code LIKE ?', [`${MARK}%`]).n;

  console.log(`
Done in ${(ms / 1000).toFixed(1)}s

  leads created      ${made.leads}
    opted out        ${made.optedOut}   (marketing blocked, service allowed)
    invalid mobile   ${made.badMobile}   (call and SMS blocked)
  product cards      ${made.cards}
  interactions       ${made.activities}
  tasks              ${made.tasks}
  cases              ${made.tickets}

  campaign list      "${MARK}All test leads" — ${list.members} members
  draft campaign     "${MARK}Diwali PMS push"

  leads in database  ${total}  (${test} synthetic, ${total - test} seeded)

Remove all of it with:  node src/testdata.js --clear
`);
}

db.close();
