/**
 * Demo dataset — Bonanza Portfolio Ltd.
 *
 * Products and partner models are taken from bonanzaonline.com; the KYC journey
 * is Bonanza's published 16-step flow. Safe to re-run: it clears first.
 *
 *   npm run seed
 */

/* dotenv first: security.js reads CRM_MASTER_KEY at module load, and ES
   imports are hoisted — so without this the script encrypts under the
   development key while the server decrypts under the real one. */
import 'dotenv/config';
import { db, run, one, all } from './db.js';
import { MASTER_STEPS } from './engine/kyc.js';
import { ONBOARDING_STEPS, LMS_MODULES } from './routes/partners.js';
import { seedDispositions, applyEffects } from './engine/dispositions.js';
import { seedKra, seedIncentives } from './engine/kra.js';
import { syncDispositionPicklists } from './engine/metadata.js';
import { createFollowUp } from './engine/followups.js';
import { DEFAULT_SLA } from './engine/sla.js';
import { ticketSummary } from './ai/mock.js';
import { convertLead } from './engine/clients.js';
import { hashPassword, encryptField } from './security.js';

const ago = (d, h = 0) => new Date(Date.now() - d * 864e5 - h * 36e5).toISOString().slice(0, 19).replace('T', ' ');
const ahead = (d, h = 0) => new Date(Date.now() + d * 864e5 + h * 36e5).toISOString().slice(0, 19).replace('T', ' ');
const pick = (arr, i) => arr[i % arr.length];

console.log('Clearing…');
for (const t of [
  'sessions', 'notifications', 'audit_log', 'rule_runs', 'rules', 'campaigns', 'lead_list_members', 'lead_lists',
  'kyc_journey_progress', 'kyc_journeys', 'kyc_journey_steps', 'kyc_steps_master',
  'commissions', 'partner_lms', 'partner_steps', 'ticket_replies', 'tickets',
  // Clients before leads: converted_from_lead_id is ON DELETE SET NULL, so
  // clearing leads first would silently orphan every account instead of
  // removing it — and the next convert would then find the orphan, treat it as
  // already converted, and never restore the link.
  'client_segments', 'clients',
  'notes', 'tasks', 'activities', 'card_audit', 'product_cards', 'leads', 'partners',
  'content_items', 'content_library', 'templates', 'sla_policies', 'ticket_categories', 'product_types', 'users',
  'reminders', 'assignment_rules', 'team_members', 'teams', 'dialler_campaigns',
]) {
  db.exec(`DELETE FROM ${t}`);
  db.exec(`DELETE FROM sqlite_sequence WHERE name = '${t}'`);
}

/* Roles the test suite invented, and the tab choices attached to them.
 *
 * Every e2e run creates a `regional_sup_<n>` role to prove a custom role can be
 * built, and nothing ever removed it -- so the roles table had accumulated 76
 * of them. Harmless while nothing listed roles; not harmless now that the
 * ENH-08 matrix renders one row per role and would have shown a grid 87 rows
 * deep.
 *
 * System roles are re-seeded from code on boot, so only the custom ones are
 * cleared here, along with their grants.
 */
db.exec("DELETE FROM role_capabilities WHERE role_code IN (SELECT code FROM roles WHERE is_system = 0)");
db.exec("DELETE FROM roles WHERE is_system = 0");
db.exec("DELETE FROM tab_visibility");

/* The access log goes with the records it describes.
 *
 * Its rows identify a record by the id in the path, and a reseed recreates
 * every record with fresh ids and fresh business assignments. Left behind, a
 * row reading GET /api/leads/3 by a Bigul user resolves against whatever lead 3
 * happens to be now -- and the cross-book report invents a crossing that never
 * happened. False evidence in a security control is worse than none. */
db.exec('DELETE FROM request_log');

/* Version history goes with the artefacts it describes, for the same reason.
 *
 * A version is keyed on the artefact's id, and a reseed recreates every rule,
 * template and journey with ids that start over. Left behind, the history of a
 * deleted rule 12 attaches itself to whatever rule 12 becomes next — so a
 * freshly created rule opens on version 7, showing five edits made to something
 * else entirely. */
db.exec('DELETE FROM artefact_versions');
db.exec("DELETE FROM field_masking");

/* KRA targets and incentive plans reset to the shipped worked example.
 *
 * Same reasoning as the dispositions above: the edited_at guard deliberately
 * preserves customisations across a RESTART, and would otherwise preserve them
 * across a reseed too -- leaving every run starting from whatever the last one
 * happened to change. A restart keeps your edits; a reseed gives you the
 * example back. */
db.exec("DELETE FROM incentive_slabs");
db.exec("DELETE FROM incentive_plans");
db.exec("DELETE FROM kra_metrics");
for (const t of ['kra_metrics', 'incentive_plans', 'incentive_slabs']) {
  db.exec(`DELETE FROM sqlite_sequence WHERE name = '${t}'`);
}

/* Put the worked example back.
 *
 * seedKra() and seedIncentives() also run on boot, but the server under test --
 * and the one running on the UAT box -- is already up when a reseed happens. It
 * will not call them again, so clearing without reseeding here leaves every
 * scorecard and every payout plan empty until somebody restarts the process. */
seedKra();
seedIncentives();

/* ------------------------------------------------------------- products */

/**
 * Dialler queues, as CUBE would know them.
 *
 * Placeholders -- the real CampaignId strings are still outstanding from Cube,
 * and CUBE has no endpoint that lists them, so they can only be configured.
 * They are seeded anyway because the shape is the point: a queue per desk per
 * book, plus one book-wide default, which is what makes a call carry the right
 * campaign instead of the whole firm sharing one environment variable.
 *
 * Named per book deliberately. A Bigul desk dialling from a Bonanza queue
 * would put the two books' calls in one place in Cube's own reporting, which
 * is the same boundary failure as any cross-book query.
 */
function seedDiallerCampaigns() {
  const productId = (org, code) =>
    one('SELECT id FROM product_types WHERE sales_org = ? AND code = ?', [org, code])?.id ?? null;

  const queues = [
    ['BNZ_SALES_OUT', 'Bonanza — outbound sales', 'BONANZA', null, 1],
    ['BNZ_EQ_DESK', 'Bonanza — equity desk', 'BONANZA', productId('BONANZA', 'EQD'), 0],
    ['BGL_SALES_OUT', 'Bigul — outbound sales', 'BIGUL', null, 1],
  ];

  for (const [cubeId, label, org, ptId, isDefault] of queues) {
    run(
      `INSERT INTO dialler_campaigns (cube_campaign_id, label, sales_org, product_type_id, is_default)
       VALUES (?,?,?,?,?)`,
      [cubeId, label, org, ptId, isDefault],
    );
  }
}

const PRODUCTS = [
  ['EQD', 'Equity & Derivatives', 'Broking', 0, 'None', 'High',
    ['Zero brokerage on delivery with the Bigul flat plan', 'NSE, BSE cash and F&O in one account', 'Margin against approved securities', 'In-house research calls with entry, target and stop-loss'],
    [['Brokerage looks high', 'Compare the flat plan against a percentage plan on your actual monthly turnover — for most clients the flat plan is lower.'],
      ['I already have a demat account', 'You can keep it. Most clients run a second account for the research and the flat-fee trading.']]],
  ['DP', 'Demat / Depository', 'Broking', 0, 'None', 'Low',
    ['CDSL and NSDL both supported', 'Online account opening in 15 minutes with Aadhaar eSign', 'Consolidated holding statement', 'Instant pledge and margin against holdings'],
    [['Annual charges?', 'AMC is charged annually and is waived for the first year on most plans.']]],
  ['COM', 'Commodities', 'Broking', 0, 'None', 'High',
    ['MCX and NCDEX access', 'Gold, silver, crude and agri contracts', 'Hedging support for business clients', 'Dedicated commodity research desk'],
    [['Commodities feel risky', 'Position sizing and stop-loss discipline matter more than the asset. We start most clients on smaller contracts.']]],
  ['CUR', 'Currency Derivatives', 'Broking', 0, 'None', 'High',
    ['USDINR, EURINR, GBPINR and JPYINR', 'Useful hedge for importers and exporters', 'Lower margin requirement than equity F&O'],
    []],
  ['MF', 'Mutual Funds', 'Investment', 500, 'Varies by scheme', 'Moderate',
    ['SIP from ₹500 a month', 'Direct and regular plans', 'Goal-based portfolio construction', 'Single view of all folios'],
    [['Markets are high right now', 'That is exactly the case for a SIP rather than a lump sum — you average across levels instead of timing one.'],
      ['Lock-in?', 'Only ELSS has a 3-year lock-in. Every other open-ended scheme can be redeemed any time.']]],
  ['SMART', 'Smart Portfolios', 'Investment', 50000, 'None', 'Moderate',
    ['Ready-made thematic baskets of stocks', 'Rebalanced by the Bonanza research team', 'You own the stocks directly in your demat', 'Start from ₹50,000'],
    [['How is this different from a mutual fund?', 'You hold the shares directly, so you keep full transparency and control, and there is no fund expense ratio.']]],
  ['PMS', 'Portfolio Management Services', 'Advisory', 5000000, '3 years recommended', 'High',
    ['SEBI-registered discretionary PMS', 'Minimum ₹50 lakh as per SEBI norms', 'Dedicated portfolio manager', 'Detailed quarterly performance reporting'],
    [['The minimum is too high', 'That is a SEBI-mandated floor, not a Bonanza policy. Smart Portfolios start at ₹50,000 and follow a similar philosophy.']]],
  ['FI', 'Fixed Income & Bonds', 'Investment', 10000, 'To maturity', 'Low',
    ['Corporate bonds, NCDs, government securities', 'Predictable coupon income', 'Useful ballast alongside equity exposure', 'Held in the same demat account'],
    []],
  ['GLOBAL', 'Global Investing', 'Investment', 25000, 'None', 'High',
    ['US and international equities', 'Fractional investing in large-cap US names', 'LRS-compliant remittance support', 'Currency diversification'],
    [['Tax treatment?', 'Gains are taxable in India and TCS applies on remittance above the LRS threshold — our team shares the working before you invest.']]],
  ['INS', 'Insurance Solutions', 'Protection', 0, 'Policy term', 'Low',
    ['Term life and health cover via partner insurers', 'Bharti AXA Life and HDFC Life partnerships', 'Need-based cover calculation', 'Claims assistance desk'],
    []],
  ['RES', 'Research Subscription', 'Advisory', 2999, 'Monthly / annual', 'Moderate',
    ['Daily technical and fundamental calls', 'Entry, target and stop-loss on every call', 'Sector and thematic reports', 'Portfolio health check'],
    []],
];

/**
 * Bigul's catalogue.
 *
 * Bigul is not "Bonanza with a different logo" — it is a different business
 * model, and the product list is where that shows. Bonanza sells advice at a
 * high minimum through a relationship manager; Bigul sells self-serve tooling
 * at a flat fee. The CRM has to sell both without pretending they are the same,
 * which is why products carry a sales_org rather than a shared list with flags.
 *
 * Sourced from bigul.co: ₹0 account opening, ₹18 flat brokerage per order,
 * free AMC for the first year, Algos, Connect API, Baskets, Scanner, Stock SIP,
 * Easy Options, Portfolio Evaluator, JARVIS AI advisor and Global Investing.
 */
const BIGUL_PRODUCTS = [
  ['BG-TRADE', 'Trading & Demat Account', 'Broking', 0, 'None', 'Moderate',
    ['₹0 account opening and free AMC for the first year', '₹18 flat brokerage per order regardless of size', 'NSE, BSE cash, F&O and currency in one login', 'Digital onboarding with Aadhaar eSign'],
    [['I already trade somewhere', 'Run the numbers on your last month: at ₹18 a order, most active traders pay less here than on a percentage plan.'],
      ['Is a flat fee really cheaper?', 'Below roughly ₹36,000 of turnover per order a percentage plan wins; above it the flat fee does. We show the crossover on your own statement.']]],

  ['BG-ALGO', 'Bigul Algos', 'Advisory', 0, 'None', 'High',
    ['Ready-made strategy templates, no coding needed', 'Backtest before you deploy real capital', 'Execution algos run unattended during market hours', 'One-click F&O strategies'],
    [['Algo trading sounds risky', 'Every strategy is backtested and carries its own stop-loss. The risk is the strategy you pick, not the automation.'],
      ['Do I need to code?', 'No. The templates are configured from a form; Connect is there if you do want to write your own.']]],

  ['BG-CONNECT', 'Bigul Connect (API)', 'Broking', 0, 'None', 'High',
    ['Unified API for traders, developers and fintechs', 'Live market data across all exchanges', 'Bulk order management with pooled margin', 'Universal execution across segments'],
    [['We already built on another API', 'Connect can run alongside it — most developer clients start with one strategy before migrating.']]],

  ['BG-BASKET', 'Stock Baskets', 'Investment', 25000, 'None', 'Moderate',
    ['Thematic baskets built by the research desk', 'You hold the shares directly in your own demat', 'Rebalanced with alerts, you stay in control', 'Buy an entire basket in one click'],
    [['Why not just buy a mutual fund?', 'You own the shares outright, so there is no expense ratio and full transparency on every holding.']]],

  ['BG-SIP', 'Stock SIP', 'Investment', 500, 'None', 'Moderate',
    ['Fixed-amount investing into chosen stocks', 'Set the interval and the amount, then leave it', 'Averages your entry across market levels', 'Start from ₹500'],
    [['Markets look expensive', 'That is the argument for a SIP rather than a lump sum — you buy across levels instead of betting on one.']]],

  ['BG-OPT', 'Easy Options', 'Advisory', 0, 'None', 'High',
    ['Pre-built option strategies for beginners', 'Option chain with order placement built in', 'Payoff and risk shown before you place the trade', 'Basket orders for multi-leg strategies'],
    [['Options are too complex', 'The pre-built strategies show maximum loss up front, so the risk is bounded and visible before you commit.']]],

  ['BG-GLOBAL', 'Global Investing', 'Investment', 25000, 'None', 'High',
    ['10,000+ US stocks and ETFs', 'Fractional investing in large-cap US names', 'Seamless digital KYC for the US account', 'LRS-compliant remittance support'],
    [['Tax treatment?', 'Gains are taxable in India and TCS applies above the LRS threshold — we share the working before you remit.']]],

  ['BG-MF', 'Mutual Funds', 'Investment', 500, 'Varies by scheme', 'Moderate',
    ['Direct plans, so no distributor commission drag', 'SIP from ₹500 a month', 'All folios in one dashboard', 'Goal tracking built in'],
    [['Why direct plans?', 'You keep the commission that a regular plan pays away — typically 0.5 to 1% a year, compounded.']]],

  ['BG-JARVIS', 'JARVIS — AI Stock Advisor', 'Advisory', 0, 'Monthly / annual', 'Moderate',
    ['AI-built portfolio matched to your risk profile', 'Continuous rebalancing suggestions', 'Portfolio Evaluator scores what you already hold', 'Plain-English reasoning on every call'],
    [['Can I trust an algorithm with my money?', 'JARVIS proposes; you approve every trade. Nothing executes without your confirmation.']]],
];

const productIds = {};
/* Both catalogues are loaded, each stamped with the business that sells it. */
const CATALOGUE = [
  ...PRODUCTS.map((p) => ['BONANZA', ...p]),
  ...BIGUL_PRODUCTS.map((p) => ['BIGUL', ...p]),
];

CATALOGUE.forEach(([org, code, name, category, min, lockIn, risk, pitch, objections], i) => {
  const site = org === 'BIGUL' ? 'https://bigul.co' : 'https://www.bonanzaonline.com';
  const result = run(
    `INSERT INTO product_types (sales_org, code, name, category, min_investment, lock_in, risk_category, pitch_points, objections, brochure_url, apply_url, requires_kyc, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org, code, name, category, min, lockIn, risk,
      JSON.stringify(pitch),
      JSON.stringify(objections.map(([objection, response]) => ({ objection, response }))),
      `${site}/brochures/${code.toLowerCase()}.pdf`,
      org === 'BIGUL' ? `${site}/open-account` : `${site}/open-account`,
      ['INS', 'RES', 'BG-CONNECT'].includes(code) ? 0 : 1, i],
  );
  productIds[code] = Number(result.lastInsertRowid);
});

/* ----------------------------------------------------------------- users */

const U = {};
let empSeq = 0;

/**
 * `org` is the user's home business; `orgs` is what they may actually work in.
 * Most staff sit in one; the cross-org RMs exist because the KRA scorecard
 * genuinely mixes Bonanza and Bigul metrics for one person, and the demo should
 * show that rather than pretend the two books never meet.
 */
const addUser = (key, name, email, role, extra = {}) => {
  empSeq += 1;
  const org = extra.org ?? 'BONANZA';
  const prefix = org === 'BIGUL' ? 'BGL' : 'BNZ';

  const result = run(
    `INSERT INTO users (name, email, password, role, product_type_id, manager_id, phone,
                        sales_org, org_access, employee_code, branch, avatar_hue)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      name, email, hashPassword('bonanza'), role,
      extra.product_type_id ?? null, extra.manager_id ?? null, extra.phone ?? null,
      org,
      extra.orgs ? JSON.stringify(extra.orgs) : null,
      extra.employee_code ?? `${prefix}${String(1000 + empSeq)}`,
      extra.branch ?? 'Mumbai',
      (empSeq * 47) % 360,
    ],
  );

  /* The dialler identity, for the roles that actually call. CUBE knows an agent
     by its own id and its own extension, neither of which is our user id; the
     adapter sends no AgentID at all when this is unset rather than inventing
     one. Seeded from the email local part, which is the shape Cube's own
     samples use (`bsingh`). */
  if (['sales_rm', 'caller', 'dealer', 'sales_supervisor'].includes(role)) {
    run('UPDATE users SET cti_agent_id = ?, phone_extension = ? WHERE id = ?',
      [email.split('@')[0], String(5000 + empSeq), Number(result.lastInsertRowid)]);
  }
  U[key] = Number(result.lastInsertRowid);
  return U[key];
};

addUser('superadmin', 'Rohit Menon', 'superadmin@bonanza.test', 'superadmin');
addUser('admin', 'Kavita Iyer', 'admin@bonanza.test', 'admin');
addUser('sales_sup', 'Anil Deshpande', 'salessupervisor@bonanza.test', 'sales_supervisor');
addUser('prod_sup', 'Meera Nair', 'productsupervisor@bonanza.test', 'product_supervisor');

addUser('caller', 'Sneha Kulkarni', 'caller@bonanza.test', 'caller', { manager_id: U.sales_sup });
addUser('caller2', 'Imran Shaikh', 'caller2@bonanza.test', 'caller', { manager_id: U.sales_sup });
addUser('dealer', 'Vikram Rathore', 'dealer@bonanza.test', 'dealer', { manager_id: U.sales_sup });
addUser('sales_rm', 'Priya Sharma', 'salesrm@bonanza.test', 'sales_rm', { manager_id: U.sales_sup });
addUser('sales_rm2', 'Arjun Verma', 'salesrm2@bonanza.test', 'sales_rm', { manager_id: U.sales_sup });
addUser('partner_rm', 'Jimish Bhayani', 'partnerrm@bonanza.test', 'partner_rm', { manager_id: U.sales_sup });
addUser('product_rm_mf', 'Deepak Joshi', 'productrm@bonanza.test', 'product_rm', { product_type_id: productIds.MF, manager_id: U.prod_sup });
addUser('product_rm_eqd', 'Ritu Bansal', 'productrm2@bonanza.test', 'product_rm', { product_type_id: productIds.EQD, manager_id: U.prod_sup });
addUser('product_rm_pms', 'Sanjay Malhotra', 'productrm3@bonanza.test', 'product_rm', { product_type_id: productIds.PMS, manager_id: U.prod_sup });
addUser('care', 'Fatima Ansari', 'care@bonanza.test', 'customer_care', { manager_id: U.sales_sup });
addUser('care2', 'Nikhil Rao', 'care2@bonanza.test', 'customer_care', { manager_id: U.sales_sup });
addUser('marketing', 'Tanvi Mehta', 'marketing@bonanza.test', 'marketing_manager');

/* Cross-org: these two carry books in both businesses, so their KRA scorecard
   mixes Bonanza and Bigul metrics exactly as the reference scorecard does. */
addUser('sales_rm3', 'Rhea Kulkarni', 'salesrm3@bonanza.test', 'sales_rm', {
  manager_id: U.sales_sup, orgs: ['BONANZA', 'BIGUL'], branch: 'Pune',
});

/* Bigul-only staff. Same roles, different book. */
addUser('bigul_sup', 'Nakul Trivedi', 'supervisor@bigul.test', 'sales_supervisor', {
  org: 'BIGUL', branch: 'Bengaluru',
});
addUser('bigul_rm', 'Ananya Rao', 'rm@bigul.test', 'sales_rm', {
  org: 'BIGUL', manager_id: U.bigul_sup, branch: 'Bengaluru',
});
addUser('bigul_caller', 'Farhan Qureshi', 'caller@bigul.test', 'caller', {
  org: 'BIGUL', manager_id: U.bigul_sup, branch: 'Bengaluru',
});
addUser('bigul_care', 'Divya Menon', 'care@bigul.test', 'customer_care', {
  org: 'BIGUL', manager_id: U.bigul_sup, branch: 'Bengaluru',
});

/* ------------------------------------------------------------ ticket cfg */

const CATEGORIES = [
  ['SIP Failure / NACH', 'customer_care'],
  ['KYC Query', 'product_rm'],
  ['Trading Platform Issue', 'customer_care'],
  ['Payout / Withdrawal', 'customer_care'],
  ['Brokerage & Charges', 'customer_care'],
  ['Complaint', 'customer_care'],
  ['Partner Support', 'partner_rm'],
  ['Research / Advisory', 'customer_care'],
];
const catIds = {};
for (const [name, role] of CATEGORIES) {
  catIds[name] = Number(run('INSERT INTO ticket_categories (name, auto_assign_role) VALUES (?,?)', [name, role]).lastInsertRowid);
}

// Per-product SLA (OD-08). Broking products get tighter timers than advisory.
for (const code of ['EQD', 'DP', 'MF', 'PMS']) {
  for (const [priority, def] of Object.entries(DEFAULT_SLA)) {
    const tighten = ['EQD', 'DP'].includes(code) ? 0.5 : 1;
    run('INSERT INTO sla_policies (product_type_id, priority, response_mins, resolution_mins) VALUES (?,?,?,?)', [
      productIds[code], priority, Math.round(def.response_mins * tighten), Math.round(def.resolution_mins * tighten),
    ]);
  }
}

/* ------------------------------------------------------------- templates */

const TEMPLATES = [
  ['MF SIP intro', 'whatsapp', null, 'Hi {{name}}, thanks for your time. Here is the Bonanza mutual fund SIP note we discussed — you can start from ₹500 a month. Shall I send the onboarding link?', 'MF'],
  ['Account opening link', 'whatsapp', null, 'Hi {{name}}, you can open your Bonanza account online in about 15 minutes with Aadhaar and PAN. Here is your secure link.', 'DP'],
  ['KYC reminder — step pending', 'whatsapp', null, 'Hi {{name}}, your Bonanza account application is almost done. One step is pending. Reply HELP and we will complete it with you on a call.', null],
  ['Brokerage plan comparison', 'email', 'Your Bonanza brokerage options', 'Dear {{name}},\n\nAttached is the comparison between our flat and percentage brokerage plans against your indicated turnover.\n\nRegards,\nBonanza Portfolio Ltd', 'EQD'],
  ['PMS overview', 'email', 'Bonanza PMS — strategy note', 'Dear {{name}},\n\nPlease find the PMS strategy note and past performance disclosure attached. Minimum investment is ₹50 lakh as per SEBI norms.\n\nRegards,\nBonanza Portfolio Ltd', 'PMS'],
  ['Callback confirmation', 'sms', null, 'Bonanza: Thanks {{name}}, we have noted your callback request. Your RM will call at the agreed time.', null],
];
const templateIds = {};
for (const [name, channel, subject, body, product] of TEMPLATES) {
  templateIds[name] = Number(run('INSERT INTO templates (name, channel, subject, body, product_type_id, approved) VALUES (?,?,?,?,?,1)', [
    name, channel, subject, body, product ? productIds[product] : null,
  ]).lastInsertRowid);
}

/* --------------------------------------------------------------- content */

/* Three libraries, because the differences between them are the point.
 *
 * Client-facing collateral requires approval and expires in a year — a brochure
 * quoting last year's brokerage is a compliance problem, not stale content.
 * The KYC help material does not require approval: it explains a screen, and
 * putting a review between an admin and a screenshot is how review becomes a
 * rubber stamp. Regulatory documents require approval and never expire by
 * default, because their expiry is decided by the regulator, not by us. */
const LIBRARIES = [
  ['Client collateral', 'Brochures and explainers an RM may send to a client.',
   'marketing_manager', null, 1, 365],
  ['KYC help', 'What to show somebody stuck on a step. Internal-facing.',
   'admin', ['admin', 'customer_care', 'sales_rm', 'caller'], 0, null],
  ['Regulatory', 'Risk disclosures and anything a regulator expects to see.',
   'admin', null, 1, null],
];
const libraryIds = {};
for (const [name, description, owner, shared, approval, expiryDays] of LIBRARIES) {
  const r = run(
    `INSERT INTO content_library (name, description, owner_role, shared_with, requires_approval, default_expiry_days, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [name, description, owner, shared ? JSON.stringify(shared) : null, approval, expiryDays, U.admin ?? null],
  );
  libraryIds[name] = Number(r.lastInsertRowid);
}

const CONTENT = [
  ['Bonanza MF SIP brochure 2026', 'PDF', 'MF', null, ahead(120), 'Client collateral', 'approved'],
  ['Equity flat plan explainer', 'PDF', 'EQD', null, ahead(20), 'Client collateral', 'approved'],
  ['PMS strategy note Q3', 'PDF', 'PMS', null, ahead(15), 'Client collateral', 'pending'],
  ['How DigiLocker KYC works (video)', 'Video', null, 'AADHAAR_DIGILOCKER', ahead(300), 'KYC help', 'approved'],
  ['Penny drop failed — what next', 'Link', null, 'BANK', ahead(300), 'KYC help', 'approved'],
  ['Risk disclosure document', 'PDF', null, null, ahead(400), 'Regulatory', 'approved'],
  ['Smart Portfolios one-pager', 'PDF', 'SMART', null, ahead(60), 'Client collateral', 'draft'],
];
for (const [name, type, product, step, expiry, library, status] of CONTENT) {
  const lib = one('SELECT * FROM content_library WHERE id = ?', [libraryIds[library]]);
  run(
    `INSERT INTO content_items (name, type, url, product_type_id, kyc_step_code, expiry_date,
                                owner_role, library_id, status, created_by, send_count,
                                approved_by, approved_at, submitted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      name, type, 'https://www.bonanzaonline.com/content/demo',
      product ? productIds[product] : null, step, expiry,
      lib.owner_role, lib.id, status,
      /* Authored by the marketing manager so the approvals are demonstrably
         somebody else's — the reviewer must not be the author, and a fixture
         where they are the same person would let that rule pass untested. */
      U.marketing ?? U.admin ?? null,
      Math.floor(Math.random() * 40),
      status === 'approved' ? (U.admin ?? null) : null,
      status === 'approved' ? "datetime('now')" && new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      status === 'pending' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
    ],
  );
}

/* ------------------------------------------------------------ KYC master */

MASTER_STEPS.forEach((s, i) => {
  run('INSERT INTO kyc_steps_master (code, label, description, owner_type, default_timer_s, input_schema, sort_order) VALUES (?,?,?,?,?,?,?)', [
    s.code, s.label, s.note || null, s.owner_type, s.timer, JSON.stringify(s.fields || []), i,
  ]);
});

// Journey Composer: full 16 steps for broking/demat, a shorter set for MF.
for (const code of ['EQD', 'DP', 'COM', 'CUR', 'GLOBAL']) {
  MASTER_STEPS.forEach((s, i) => {
    run('INSERT INTO kyc_journey_steps (product_type_id, step_code, sort_order, conditional_on) VALUES (?,?,?,?)', [
      productIds[code], s.code, i, s.conditional_on || null,
    ]);
  });
}
const MF_STEPS = ['MOBILE', 'MOBILE_OTP', 'EMAIL', 'EMAIL_OTP', 'PAN', 'AADHAAR_DIGILOCKER', 'PERSONAL', 'FINANCIAL', 'BANK', 'BANK_PROOF', 'NOMINEE', 'ESIGN'];
for (const code of ['MF', 'SMART', 'FI']) {
  MF_STEPS.forEach((stepCode, i) => {
    const master = MASTER_STEPS.find((s) => s.code === stepCode);
    run('INSERT INTO kyc_journey_steps (product_type_id, step_code, sort_order, conditional_on) VALUES (?,?,?,?)', [
      productIds[code], stepCode, i, master?.conditional_on || null,
    ]);
  });
}
for (const stepCode of [...MF_STEPS, 'SEGMENTS', 'INCOME_PROOF', 'SELFIE', 'SIGNATURE']) {
  const master = MASTER_STEPS.find((s) => s.code === stepCode);
  run('INSERT INTO kyc_journey_steps (product_type_id, step_code, sort_order, conditional_on) VALUES (?,?,?,?)', [
    productIds.PMS, stepCode, MASTER_STEPS.findIndex((s) => s.code === stepCode), master?.conditional_on || null,
  ]);
}

/* -------------------------------------------------------------- partners */

const PARTNERS = [
  ['Girish Patel', 'Patel Investment Services', 'Associate', 'ACTIVE', 'Ahmedabad', 'Gujarat', 'AAAPP1234C', 'INZ000123456', 8, 8],
  ['Lakshmi Narayanan', 'LN Wealth', 'Remisier', 'ACTIVE', 'Coimbatore', 'Tamil Nadu', 'BBBPN5678D', null, 6, 8],
  ['Harpreet Singh', 'Singh Financial', 'Authorised Person', 'ONBOARDING', 'Ludhiana', 'Punjab', 'CCCPS9012E', 'INZ000987654', 5, 8],
  ['Ananya Bose', null, 'Agent', 'QUALIFYING', 'Kolkata', 'West Bengal', 'DDDPB3456F', null, 2, 8],
  ['Rakesh Yadav', 'Yadav Securities', 'Trainee Entrepreneur', 'PROSPECT', 'Jaipur', 'Rajasthan', null, null, 1, 8],
  ['Mohammed Faiz', 'Faiz Capital', 'Associate', 'SUSPENDED', 'Hyderabad', 'Telangana', 'EEEPF7890G', 'INZ000456789', 8, 8],
  ['Nithya Raman', 'Raman Digital', 'Associate', 'ACTIVE', 'Bengaluru', 'Karnataka', 'FFFPR2345H', 'INZ000112233', 8, 8, 'BIGUL'],
  ['Sameer Kaul', 'Kaul Trading Desk', 'Remisier', 'ACTIVE', 'Pune', 'Maharashtra', 'GGGPK6789J', null, 7, 8, 'BIGUL'],
];

const partnerIds = [];
PARTNERS.forEach(([name, business, model, state, city, st, pan, sebi, stepsDone, , org = 'BONANZA'], idx) => {
  const isActive = state === 'ACTIVE';
  const result = run(
    `INSERT INTO partners (sales_org, partner_code, name, business_name, partner_model, state_code, mobile, email, city, state, pan, sebi_reg_no,
      owner_id, commission_pct, portal_password, onboarded_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org,
      isActive || state === 'SUSPENDED'
        ? `${org === 'BIGUL' ? 'BGL' : 'BNZ'}-P${String(idx + 1).padStart(4, '0')}`
        : null,
      name, business, model, state,
      `98${String(20000000 + idx * 111111).slice(0, 8)}`,
      `${name.split(' ')[0].toLowerCase()}@partner.test`,
      city, st, encryptField(pan), sebi, U.partner_rm, [40, 30, 35, 25, 20, 40, 35, 30][idx] ?? 30,
      isActive || state === 'SUSPENDED' ? hashPassword('partner') : null,
      isActive || state === 'SUSPENDED' ? ago(120 - idx * 10) : null,
      ago(200 - idx * 25)],
  );
  const pid = Number(result.lastInsertRowid);
  partnerIds.push(pid);

  ONBOARDING_STEPS.forEach((s, i) => {
    const status = i < stepsDone ? 'done' : i === stepsDone ? 'active' : 'pending';
    run('INSERT INTO partner_steps (partner_id, code, label, status, completed_at, sort_order) VALUES (?,?,?,?,?,?)', [
      pid, s.code, s.label, status, status === 'done' ? ago(150 - i * 8) : null, i,
    ]);
  });

  LMS_MODULES.forEach((m, i) => {
    const done = isActive || (state === 'ONBOARDING' && i < 3);
    run('INSERT INTO partner_lms (partner_id, module, status, score, completed_at) VALUES (?,?,?,?,?)', [
      pid, m, done ? 'Completed' : i === 3 ? 'In Progress' : 'Not Started', done ? 70 + i * 5 : null, done ? ago(100 - i * 5) : null,
    ]);
  });

  if (isActive) {
    for (let m = 0; m < 4; m += 1) {
      const period = new Date(Date.now() - m * 30 * 864e5).toISOString().slice(0, 7);
      const gross = 40000 + idx * 12000 - m * 4000;
      run('INSERT INTO commissions (partner_id, product_type_id, period, gross, payout, status) VALUES (?,?,?,?,?,?)', [
        pid, productIds.EQD, period, gross, Math.round(gross * (([40, 30, 35, 25, 20, 40, 35, 30][idx] ?? 30) / 100)),
        m === 0 ? 'Accrued' : 'Paid',
      ]);
    }
  }
  run('INSERT INTO activities (partner_id, type, direction, subject, body, user_id, created_at) VALUES (?,?,?,?,?,?,?)', [
    pid, 'Partner Activity', 'outbound', 'Onboarding call', `Discussed ${model} model, commission structure and platform training.`, U.partner_rm, ago(idx * 7 + 3),
  ]);
});

/* ----------------------------------------------------------------- leads */

const CITIES = [['Mumbai', 'Maharashtra'], ['Pune', 'Maharashtra'], ['Ahmedabad', 'Gujarat'], ['Bengaluru', 'Karnataka'],
  ['Delhi', 'Delhi'], ['Jaipur', 'Rajasthan'], ['Kolkata', 'West Bengal'], ['Chennai', 'Tamil Nadu'],
  ['Hyderabad', 'Telangana'], ['Indore', 'Madhya Pradesh'], ['Surat', 'Gujarat'], ['Lucknow', 'Uttar Pradesh']];

const SOURCES = ['Website', 'Partner referral', 'Walk-in branch', 'Campaign — WhatsApp', 'IPO enquiry', 'Referral — existing client', 'Bigul app', 'Webinar'];
const NAMES = [
  'Aarav Malhotra', 'Diya Krishnan', 'Rohan Gupta', 'Ishita Reddy', 'Kabir Chawla', 'Ananya Pillai',
  'Vivaan Agarwal', 'Meera Kapoor', 'Aditya Bhatt', 'Saanvi Menon', 'Reyansh Jain', 'Kiara D\'Souza',
  'Arnav Sinha', 'Myra Choudhary', 'Vihaan Trivedi', 'Aisha Khan', 'Shaurya Nanda', 'Riya Balan',
  'Dhruv Saxena', 'Navya Rajan', 'Atharv Kulkarni', 'Pari Deshmukh', 'Krish Mehra', 'Zara Sheikh',
  'Yash Thakur', 'Anvi Ramesh', 'Ayaan Qureshi', 'Sara Joseph', 'Neil Fernandes', 'Tara Iyengar',
];

const OWNERS = [U.caller, U.caller2, U.dealer, U.sales_rm, U.sales_rm2];

/* Roughly a third of the book is Bigul, owned by Bigul staff, so the org
   switcher has something real to switch between. */
const BIGUL_OWNERS = [U.bigul_rm, U.bigul_caller, U.sales_rm3];
const orgFor = (i) => (i % 3 === 2 ? 'BIGUL' : 'BONANZA');
const RISK = ['Conservative', 'Moderate', 'Aggressive'];
const STAGES = ['New', 'Contacted', 'Qualified', 'In Progress', 'Won'];

const leadIds = [];
NAMES.forEach((name, i) => {
  const [city, st] = pick(CITIES, i);
  const org = orgFor(i);
  const ageDays = [2, 5, 9, 14, 22, 35, 48, 61, 75, 96, 120, 150][i % 12];
  const result = run(
    `INSERT INTO leads (sales_org, name, mobile, email, pan, city, state, language, risk_profile, source, stage, score, owner_id, partner_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org, name,
      `9${String(700000000 + i * 1234567).slice(0, 9)}`,
      `${name.split(' ')[0].toLowerCase()}${i}@example.com`,
      encryptField(`ABCDE${String(1000 + i)}${'FGHJK'[i % 5]}`),
      city, st, pick(['English', 'Hindi', 'Gujarati', 'Marathi', 'Tamil'], i), pick(RISK, i),
      pick(SOURCES, i), pick(STAGES, i), 10 + (i * 7) % 80,
      // Bigul leads all sit at i ≡ 2 (mod 3), so picking by `i` against a
      // three-element list would hand every one of them to the same RM.
      org === 'BIGUL' ? pick(BIGUL_OWNERS, Math.floor(i / 3)) : pick(OWNERS, i),
      // Same-org partners only: a Bigul lead attributed to a Bonanza partner
      // would pay the wrong commission out of the wrong book.
      i % 5 === 0 ? pick(org === 'BIGUL' ? partnerIds.slice(6, 8) : partnerIds.slice(0, 2), i) : null,
      ago(ageDays), ago(Math.floor(ageDays / 3))],
  );
  const id = Number(result.lastInsertRowid);
  leadIds.push(id);

  // Every lead gets a card for every active product IN ITS OWN ORG — the BRD's
  // core rule, scoped to the business that actually sells to this person.
  for (const pt of all('SELECT id FROM product_types WHERE active = 1 AND sales_org = ?', [org])) {
    run('INSERT INTO product_cards (lead_id, product_type_id, state) VALUES (?,?,?)', [id, pt.id, 'INACTIVE']);
  }
});

/* Move a realistic spread of cards off Inactive. */
const CARD_PLAN = [
  [0, 'MF', 'ACTIVE', 240000], [0, 'DP', 'ACTIVE', 0], [0, 'EQD', 'WARM', 0],
  [1, 'EQD', 'KYC_IN_PROGRESS', 0], [1, 'DP', 'KYC_IN_PROGRESS', 0],
  [2, 'MF', 'WARM', 0], [2, 'RES', 'EXPLORING', 0],
  [3, 'PMS', 'PRODUCT_RM_ENGAGED', 0], [3, 'EQD', 'ACTIVE', 1850000],
  [4, 'MF', 'EXPLORING', 0],
  [5, 'EQD', 'LOST', 0], [5, 'COM', 'EXPLORING', 0],
  [6, 'SMART', 'WARM', 0],
  [7, 'MF', 'ACTIVE', 96000], [7, 'INS', 'EXPLORING', 0],
  [8, 'GLOBAL', 'EXPLORING', 0],
  [9, 'EQD', 'ON_HOLD', 0],
  [10, 'MF', 'KYC_IN_PROGRESS', 0],
  [11, 'FI', 'WARM', 0],
  [12, 'EQD', 'EXPLORING', 0], [12, 'DP', 'EXPLORING', 0],
  [13, 'PMS', 'WARM', 0],
  [14, 'MF', 'LOST', 0],
  [15, 'EQD', 'ACTIVE', 420000], [15, 'MF', 'ACTIVE', 310000], [15, 'DP', 'ACTIVE', 0],
  [16, 'COM', 'WARM', 0],
  [17, 'RES', 'ACTIVE', 35988],
  [18, 'MF', 'EXPLORING', 0],
  [19, 'SMART', 'EXPLORING', 0],
  [21, 'EQD', 'WARM', 0],
  [23, 'MF', 'WARM', 0],
  [25, 'DP', 'KYC_IN_PROGRESS', 0],
];

/**
 * Bigul's pipeline. Separate because the catalogue is different — a Bigul lead
 * has no PMS card to move. Lead indices here are all ≡ 2 (mod 3), which is how
 * orgFor() assigns the Bigul book.
 */
const BIGUL_CARD_PLAN = [
  [2, 'BG-TRADE', 'ACTIVE', 340000], [2, 'BG-ALGO', 'WARM', 0],
  [5, 'BG-TRADE', 'ACTIVE', 128000], [5, 'BG-SIP', 'EXPLORING', 0],
  [8, 'BG-TRADE', 'KYC_IN_PROGRESS', 0],
  [11, 'BG-BASKET', 'WARM', 185000], [11, 'BG-TRADE', 'ACTIVE', 675000],
  [14, 'BG-OPT', 'EXPLORING', 0],
  [17, 'BG-TRADE', 'ACTIVE', 92000], [17, 'BG-JARVIS', 'PRODUCT_RM_ENGAGED', 0],
  [20, 'BG-GLOBAL', 'WARM', 420000],
  [23, 'BG-MF', 'EXPLORING', 0],
  [26, 'BG-CONNECT', 'PRODUCT_RM_ENGAGED', 0], [26, 'BG-TRADE', 'ACTIVE', 1450000],
  [29, 'BG-ALGO', 'LOST', 0],
];

for (const [leadIdx, code, state, value] of [...CARD_PLAN, ...BIGUL_CARD_PLAN]) {
  const card = one('SELECT * FROM product_cards WHERE lead_id = ? AND product_type_id = ?', [leadIds[leadIdx], productIds[code]]);
  if (!card) continue;

  const productRm = state === 'PRODUCT_RM_ENGAGED' || state === 'KYC_IN_PROGRESS'
    ? one('SELECT id FROM users WHERE role = ? AND product_type_id = ?', ['product_rm', productIds[code]])?.id ?? null
    : null;

  run('UPDATE product_cards SET state = ?, value = ?, product_rm_id = ?, contact_flag = ?, last_state_at = ? WHERE id = ?', [
    state, value, productRm,
    state === 'WARM' ? pick(['Direct Contact', 'No Direct Contact', 'Schedule Joint Call'], leadIdx) : null,
    ago(leadIdx % 9), card.id,
  ]);
  run('INSERT INTO card_audit (card_id, from_state, to_state, user_id, note, created_at) VALUES (?,?,?,?,?,?)', [
    card.id, 'INACTIVE', state, pick(OWNERS, leadIdx), 'Set during qualification call', ago(leadIdx % 9),
  ]);
}

/* ------------------------------------------------- sales execution */

/**
 * Dispositions, teams, routing rules and a worked set of activities.
 *
 * The activities below are not filler. Each one demonstrates a different branch
 * of the disposition matrix — a callback that had to name its time, a ringing
 * number that scheduled its own retry, a meeting that opened the scheduler, a
 * refusal that closed the card — so the demo shows the mechanism rather than a
 * list of identical rows.
 */

/* Reset outcomes to the shipped matrix.
 *
 * A seed restores a known state, and the edited_at guard in seedDispositions()
 * deliberately preserves customisations across a RESTART -- which would also
 * have preserved them across a reseed, leaving each run starting from whatever
 * the last one happened to change. Clearing first keeps those two things
 * separate: a restart keeps your edits, a reseed gives you the shipped set. */
db.exec('DELETE FROM dispositions');
db.exec("DELETE FROM sqlite_sequence WHERE name = 'dispositions'");
seedDispositions();
/* The interaction outcome picklists are a projection of the dispositions table,
   so they have to move when it is reseeded. Without this they keep whatever the
   last running server left them holding — including values retired by a test
   run, which then read as missing for outcomes that plainly exist. */
syncDispositionPicklists();
seedDiallerCampaigns();

/* ---------------------------------------------------- custom fields
 *
 * Custom fields are cleared on reseed, and three are then created properly.
 *
 * WHY CLEAR. A custom field is by definition not part of the shipped state, so
 * a reseed should not keep it. Nothing did, and the result was the exact
 * failure this product exists to prevent: the end-to-end suite adds a picklist
 * to Lead on every run and the API refuses to delete fields -- correctly, since
 * deleting one takes its data with it -- so they accumulated. 159 of 219
 * field_def rows were test residue by 31 August, built up over nine days. The
 * legacy audit's Finding 3 is 289 unowned custom fields after four years; we
 * managed 161 in nine days, in the tool built to stop it.
 *
 * WHY SEED THREE. The headline claim is that an administrator adds a field
 * without a developer. Three custom fields existed in the UAT database and
 * nothing in the codebase created them -- they were left behind by someone
 * clicking around, and would have vanished on any fresh install, taking the
 * demonstration with them. Now they are seeded, owned, and carry the purpose
 * the screen asks for.
 */
function seedCustomFields() {
  db.exec(`DELETE FROM field_value WHERE field_id IN (SELECT id FROM field_def WHERE is_custom = 1)`);
  db.exec(`DELETE FROM picklist_value WHERE field_id IN (SELECT id FROM field_def WHERE is_custom = 1)`);
  db.exec('DELETE FROM field_def WHERE is_custom = 1');

  const owner = U.admin ?? null;
  const add = (entity, apiName, label, type, purpose, values = []) => {
    const res = run(
      `INSERT INTO field_def
         (entity, api_name, label, type, storage, is_custom, active, owner_user_id, purpose, sort_order)
       VALUES (?,?,?,?,'value',1,1,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM field_def WHERE entity = ?))`,
      [entity, apiName, label, type, owner, purpose, entity],
    );
    const id = Number(res.lastInsertRowid);
    values.forEach((v, i) => {
      run('INSERT INTO picklist_value (field_id, value, label, sort_order) VALUES (?,?,?,?)', [id, v, v, i]);
    });
    return id;
  };

  add('lead', 'preferred_call_window', 'Preferred Call Window', 'picklist',
    'Callers waste attempts ringing people at work. Recorded once, honoured by the dialler list.',
    ['Morning (9-12)', 'Afternoon (12-4)', 'Evening (4-8)', 'Weekends only']);

  add('lead', 'expected_monthly_sip', 'Expected Monthly SIP', 'currency',
    'Sizes the mutual fund opportunity before the first meeting, so the desk prioritises correctly.');

  const tier = add('client', 'service_tier', 'Service Tier', 'picklist',
    'Which service promise this client was sold. Drives SLA and who picks up their call.',
    ['Standard', 'Priority', 'Wealth']);

  /* Give the custom fields values on real records.
   *
   * A seeded field that is empty on every record trips the screen's own
   * unused-field warning — "empty on every record, worth retiring" — which is
   * correct behaviour reading a bad fixture. Demonstrating that a custom field
   * works means demonstrating it holding something. */
  const tiers = ['Standard', 'Priority', 'Wealth'];
  all('SELECT id, brokerage_ytd FROM clients ORDER BY brokerage_ytd DESC').forEach((c, i) => {
    run('INSERT INTO field_value (entity, record_id, field_id, text_value) VALUES (?,?,?,?)',
      ['client', c.id, tier, tiers[Math.min(i < 3 ? 2 : i < 9 ? 1 : 0, 2)]]);
  });

  /* Numbers go in num_value, not text_value — a currency field filtered or
     summed as text sorts 9,000 above 10,000. */
  const sip = one("SELECT id FROM field_def WHERE entity = 'lead' AND api_name = 'expected_monthly_sip'").id;
  all("SELECT id FROM leads WHERE deleted_at IS NULL AND stage IN ('Qualified','In Progress','Won')").forEach((l, i) => {
    run('INSERT INTO field_value (entity, record_id, field_id, num_value) VALUES (?,?,?,?)',
      ['lead', l.id, sip, [2500, 5000, 10000, 15000, 25000][i % 5]]);
  });

  const windows = ['Morning (9-12)', 'Afternoon (12-4)', 'Evening (4-8)', 'Weekends only'];
  const callWindow = one("SELECT id FROM field_def WHERE entity = 'lead' AND api_name = 'preferred_call_window'").id;
  all('SELECT id FROM leads WHERE deleted_at IS NULL').forEach((l, i) => {
    // Not every lead has been asked, which is the honest shape for this field.
    if (i % 3 === 0) return;
    run('INSERT INTO field_value (entity, record_id, field_id, text_value) VALUES (?,?,?,?)',
      ['lead', l.id, callWindow, windows[i % windows.length]]);
  });
}


/* ------------------------------------------------------------- teams */

const teamIds = {};
const addTeam = (key, name, strategy, managerId, members, org = 'BONANZA') => {
  const r = run(
    'INSERT INTO teams (name, description, strategy, manager_id, sales_org) VALUES (?,?,?,?,?)',
    [name, `${strategy.replace('_', ' ')} routing`, strategy, managerId ?? null, org],
  );
  const id = Number(r.lastInsertRowid);
  teamIds[key] = id;
  members.forEach((userId, i) => {
    run('INSERT INTO team_members (team_id, user_id, sort_order) VALUES (?,?,?)', [id, userId, i]);
  });
  return id;
};

addTeam('digital', 'Digital Desk', 'round_robin', U.sales_sup, [U.caller, U.caller2, U.sales_rm]);
addTeam('hni', 'HNI Desk', 'least_loaded', U.sales_sup, [U.sales_rm, U.sales_rm2]);
addTeam('partner_desk', 'Partner Referrals', 'round_robin', U.sales_sup, [U.sales_rm2, U.dealer]);
addTeam('west', 'West Region', 'round_robin', U.sales_sup, [U.sales_rm, U.caller]);
addTeam('south', 'South Region', 'round_robin', U.sales_sup, [U.caller2, U.dealer]);
addTeam('bigul_digital', 'Bigul Digital Desk', 'round_robin', U.bigul_sup,
  [U.bigul_rm, U.bigul_caller], 'BIGUL');

/* --------------------------------------------------- assignment rules */

const addRule = (name, conditions, strategy, opts = {}) => run(
  `INSERT INTO assignment_rules
     (name, description, conditions, strategy, team_id, user_id, routing_map,
      fallback_team_id, priority, enabled, sales_org)
   VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
  [
    name, opts.description ?? null, JSON.stringify(conditions), strategy,
    opts.team_id ?? null, opts.user_id ?? null,
    opts.routing_map ? JSON.stringify(opts.routing_map) : null,
    opts.fallback_team_id ?? teamIds.digital,
    opts.priority ?? 100, opts.org ?? 'BONANZA',
  ],
);

// Lowest priority number wins, so the specific rules sit above the catch-all.
addRule('Facebook Lead Ads → Digital Desk',
  { op: 'AND', children: [{ field: 'source', operator: 'in', value: 'Facebook,Facebook Lead Ads,Instagram' }] },
  'team', { team_id: teamIds.digital, priority: 10,
    description: 'Paid social enquiries rotate across the digital calling desk.' });

addRule('Google / paid search → Digital Desk',
  { op: 'AND', children: [{ field: 'source', operator: 'in', value: 'Google,Google Ads,Search,Website' }] },
  'team', { team_id: teamIds.digital, priority: 20,
    description: 'Search and website enquiries rotate across the digital desk.' });

addRule('WhatsApp campaign → Digital Desk',
  { op: 'AND', children: [{ field: 'source', operator: 'contains', value: 'WhatsApp' }] },
  'team', { team_id: teamIds.digital, priority: 25,
    description: 'WhatsApp campaign responders, routed for a same-day call.' });

addRule('Partner-sourced → Partner Referrals',
  { op: 'AND', children: [{ field: 'partner_linked', operator: 'is_true' }] },
  'team', { team_id: teamIds.partner_desk, priority: 30,
    description: 'A partner introduction is serviced by the partner desk.' });

addRule('Territory routing (West / South)',
  { op: 'AND', children: [{ field: 'city', operator: 'is_set' }] },
  'territory', {
    routing_map: {
      Mumbai: teamIds.west, Pune: teamIds.west, Ahmedabad: teamIds.west, Indore: teamIds.west,
      Chennai: teamIds.south, Bengaluru: teamIds.south, Hyderabad: teamIds.south, Kochi: teamIds.south,
    },
    priority: 60,
    description: 'Falls back to the digital desk when the city is not mapped.',
  });

addRule('Everything else → Digital Desk', [], 'team',
  { team_id: teamIds.digital, priority: 999, description: 'Catch-all, so no lead is ever left unowned.' });

addRule('Bigul — all sources → Bigul Digital Desk', [], 'team',
  { team_id: teamIds.bigul_digital, fallback_team_id: teamIds.bigul_digital,
    priority: 100, org: 'BIGUL', description: 'Bigul is self-serve; the desk handles everything inbound.' });


/* ------------------------------------------------- worked activities */

/**
 * A worked example per branch of the matrix, so the demo shows the mechanism
 * rather than a list of identical rows. Each one is written through the same
 * helper the API uses, which means the follow-up tasks and reminders these
 * create are real — not seeded shortcuts that would drift from the live path.
 */
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
const hoursAhead = (h) => new Date(Date.now() + h * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

const logActivity = ({ leadIdx, type, code, body, userId, at, followUpAt, meetingAt, mode, reason, duration }) => {
  const leadId = leadIds[leadIdx];
  if (!leadId) return null;

  const d = one('SELECT * FROM dispositions WHERE code = ?', [code]);
  if (!d) return null;

  const lead = one('SELECT * FROM leads WHERE id = ?', [leadId]);
  const owner = userId ?? lead.owner_id;

  const r = run(
    `INSERT INTO activities
       (lead_id, type, direction, subject, body, outcome, duration_s, user_id,
        disposition, sub_disposition, follow_up_at, meeting_at, meeting_mode, reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      leadId, type, 'outbound', d.label, body, d.outcome, duration ?? 0, owner,
      d.outcome, d.label, followUpAt ?? null, meetingAt ?? null, mode ?? null, reason ?? null,
      at ?? hoursAgo(6),
    ],
  );
  const activityId = Number(r.lastInsertRowid);

  // The next step, created exactly as the live endpoint would create it.
  const due = meetingAt ?? followUpAt
    ?? (d.follow_up_hours != null ? hoursAhead(d.follow_up_hours) : null);

  if (d.next_step && d.next_step !== 'none' && due) {
    createFollowUp({
      leadId, userId: owner, activityId, kind: d.next_step, dueAt: due,
      note: body, respectHours: !d.requires_datetime,
    });
  }

  if (d.sets_card_state || d.flags_mobile_invalid || d.suppress_marketing) {
    applyEffects({ disposition: d, leadId, cardId: null, userId: owner, reason });
  }
  return activityId;
};

/* Connected — the happy paths */
logActivity({ leadIdx: 0, type: 'Call', code: 'CALL_PITCH_DONE', duration: 412,
  at: hoursAgo(30),
  body: 'Walked through the MF SIP proposal. Comfortable with ₹25,000/month, wants to discuss with spouse before starting.' });

logActivity({ leadIdx: 1, type: 'Call', code: 'CALL_CALLBACK', duration: 96,
  at: hoursAgo(20), followUpAt: hoursAhead(3),
  body: 'In a meeting. Asked to be called back this afternoon after 4pm.' });

logActivity({ leadIdx: 3, type: 'Call', code: 'CALL_MEETING_FIXED', duration: 530,
  at: hoursAgo(48), meetingAt: hoursAhead(26), mode: 'Virtual',
  body: 'Interested in PMS. Agreed to a video call to walk through the strategy deck and past performance.' });

logActivity({ leadIdx: 6, type: 'Call', code: 'CALL_NEEDS_INFO', duration: 275,
  at: hoursAgo(10),
  body: 'Asked for the AIF Category II one-pager and last three years of returns before deciding.' });

/* Connected — the negatives */
logActivity({ leadIdx: 5, type: 'Call', code: 'CALL_NOT_INTERESTED', duration: 88,
  at: hoursAgo(72), reason: 'Already invested through another broker, locked in for two years.',
  body: 'Polite but firm. Asked not to be contacted about equity products again.' });

logActivity({ leadIdx: 12, type: 'Call', code: 'CALL_WRONG_NUMBER', duration: 22,
  at: hoursAgo(54), body: 'Number belongs to someone else — no connection to the enquiry.' });

/* Not connected — the retries schedule themselves */
logActivity({ leadIdx: 2, type: 'Call', code: 'CALL_NO_ANSWER', at: hoursAgo(5),
  body: 'Rang out twice. Trying again tomorrow morning.' });

logActivity({ leadIdx: 4, type: 'Call', code: 'CALL_BUSY', at: hoursAgo(2),
  body: 'Engaged tone. Retrying this afternoon.' });

logActivity({ leadIdx: 7, type: 'Call', code: 'CALL_SWITCHED_OFF', at: hoursAgo(26),
  body: 'Phone switched off since yesterday.' });

/* Meetings */
logActivity({ leadIdx: 9, type: 'Meeting', code: 'MEET_HELD_POSITIVE', duration: 2700,
  at: hoursAgo(96),
  body: 'Branch meeting. Walked through PMS and AIF. Wants documentation to start with ₹50L in PMS.' });

logActivity({ leadIdx: 11, type: 'Meeting', code: 'MEET_NO_SHOW', at: hoursAgo(50),
  reason: 'Client had a family emergency, asked to reschedule next week.',
  body: 'Waited 20 minutes at the branch. Client called afterwards to apologise.' });

/* Messaging */
logActivity({ leadIdx: 8, type: 'WhatsApp', code: 'MSG_REPLIED', at: hoursAgo(1),
  body: 'Replied asking about minimum SIP amount and lock-in. Service window is open — call now.' });

/* An overdue follow-up, so the dashboard has something to escalate. */
logActivity({ leadIdx: 10, type: 'Call', code: 'CALL_CALLBACK', duration: 140,
  at: hoursAgo(50), followUpAt: hoursAgo(6),
  body: 'Asked for a call back yesterday evening about the bond issue closing this week.' });

/* Refresh lead AUM from the Active cards. */
for (const l of all("SELECT lead_id, SUM(value) v FROM product_cards WHERE state = 'ACTIVE' GROUP BY lead_id")) {
  run('UPDATE leads SET aum = ?, aum_as_of = date(\'now\') WHERE id = ?', [l.v, l.lead_id]);
}

/* Expected value on in-flight cards.
 *
 * A pipeline board is a forecasting tool, and every card that is not yet ACTIVE
 * was seeded at zero -- so the headline "open pipeline" figure was a confident
 * Rs 0 across a board with twenty-five live opportunities on it. That is not a
 * demo problem; it is what the number would do in production if nobody ever set
 * an expected value, and the board should show something worth forecasting.
 *
 * Sized off the product's own typical ticket, scaled by how far the card has
 * travelled: an Exploring card is worth less in expectation than one already in
 * KYC, which is the whole point of weighting a pipeline.
 */
const STATE_WEIGHT = {
  EXPLORING: 0.35, WARM: 0.6, PRODUCT_RM_ENGAGED: 0.75, KYC_IN_PROGRESS: 0.9,
};

const TYPICAL = {
  EQD: 850000, MF: 220000, PMS: 2500000, DP: 60000, INS: 140000, RES: 45000,
  COMM: 500000, 'BG-TRADE': 400000, 'BG-ALGO': 300000, 'BG-SIP': 90000,
  'BG-BASKET': 210000, 'BG-JARVIS': 260000, 'BG-CONNECT': 150000,
};

for (const card of all(`
  SELECT pc.id, pc.state, pt.code
    FROM product_cards pc
    JOIN product_types pt ON pt.id = pc.product_type_id
   WHERE pc.value = 0 AND pc.state IN ('EXPLORING','WARM','PRODUCT_RM_ENGAGED','KYC_IN_PROGRESS')`)) {
  const base = TYPICAL[card.code] ?? 200000;
  // Deterministic spread, so a reseed produces the same board rather than a
  // different one every run -- which would make any figure impossible to verify.
  const spread = 0.7 + ((card.id % 7) * 0.1);
  const value = Math.round((base * STATE_WEIGHT[card.state] * spread) / 1000) * 1000;
  run('UPDATE product_cards SET value = ? WHERE id = ?', [value, card.id]);
}

/* ---------------------------------------------------------------- clients
 *
 * A lead holding at least one ACTIVE product card is not a prospect any more --
 * the account is open and trading. That is the conversion trigger, so those
 * leads get a UCC and a client record, and the rest stay leads.
 *
 * Some are deliberately left cold, with no trade for months, so the Dormant
 * derivation has something real to find. A seed where every account looks
 * healthy tests nothing.
 */
const SEGMENT_FOR = {
  EQD: 'Derivatives', 'BG-TRADE': 'Equity', 'BG-ALGO': 'Derivatives',
  MF: 'Mutual Fund', 'BG-SIP': 'Mutual Fund', 'BG-BASKET': 'Equity',
  DP: 'Equity', PMS: 'Equity', RES: 'Equity', INS: 'Mutual Fund',
  'BG-JARVIS': 'Derivatives', 'BG-CONNECT': 'Equity', COMM: 'Commodity',
};

const convertedLeads = all(`
  SELECT l.id, l.sales_org, l.aum, GROUP_CONCAT(pt.code) AS codes
    FROM leads l
    JOIN product_cards pc ON pc.lead_id = l.id AND pc.state = 'ACTIVE'
    JOIN product_types pt ON pt.id = pc.product_type_id
   GROUP BY l.id
   ORDER BY l.id`);

convertedLeads.forEach((row, i) => {
  const prefix = row.sales_org === 'BIGUL' ? 'BG' : 'BZ';
  const code = prefix + String(100234 + i * 37).padStart(6, '0');

  const segments = [...new Set(
    String(row.codes || '').split(',').map((c) => SEGMENT_FOR[c]).filter(Boolean),
  )];
  if (!segments.includes('Equity')) segments.push('Equity');

  const openedDaysAgo = 40 + (i * 23) % 900;
  const dormant = i % 7 === 3;
  const lastTradedDaysAgo = dormant ? 130 + (i % 5) * 40 : (i * 3) % 25;

  const r = convertLead(row.id, {
    clientCode: code,
    dematId: 'IN30' + String(1000000 + i * 1237).slice(0, 8),
    activatedAt: new Date(Date.now() - openedDaysAgo * 864e5).toISOString().slice(0, 19).replace('T', ' '),
    segments,
  });
  if (!r.ok || !r.client) return;

  run(`UPDATE clients
          SET first_traded_at = datetime('now', ?),
              last_traded_at  = datetime('now', ?),
              trades_last_year = ?, brokerage_ytd = ?, ledger_balance = ?,
              holding_value = ?, margin_available = ?, nominee_name = ?
        WHERE id = ?`,
    [
      '-' + (openedDaysAgo - 5) + ' days',
      '-' + lastTradedDaysAgo + ' days',
      dormant ? (i % 4) : 40 + (i * 17) % 300,
      Math.round((row.aum || 50000) * 0.012),
      Math.round((row.aum || 0) * 0.05),
      row.aum || 0,
      Math.round((row.aum || 0) * 0.15),
      ['Meera Nair', 'Rohit Sharma', 'Anita Desai', 'Vikram Rao'][i % 4],
      r.client.id,
    ]);
});

console.log('  clients: ' + convertedLeads.length + ' accounts converted from leads with an ACTIVE card');


/* ------------------------------------------------------------ activities */

const CALL_NOTES = [
  ['Connected — Interested', 'Discussed the flat brokerage plan. Client trades about 15 lots a month, so the flat plan works out cheaper. Asked for a written comparison.'],
  ['Connected — Callback Requested', 'Client was driving. Asked to call back Monday morning after 11.'],
  ['Not Reachable', 'Rang out twice. No answer.'],
  ['Connected — Interested', 'Explained SIP from ₹500. Client wants to start with ₹5,000 a month in a flexi-cap fund. Asked about lock-in — clarified only ELSS has one.'],
  ['Connected — Not Interested', 'Already has an account with another broker and is not looking to move.'],
  ['Connected — Interested', 'Walked through Smart Portfolios. Client liked owning shares directly. Wants the one-pager on WhatsApp.'],
];

leadIds.forEach((id, i) => {
  const calls = 1 + (i % 4);
  for (let c = 0; c < calls; c += 1) {
    const [outcome, body] = pick(CALL_NOTES, i + c);
    run('INSERT INTO activities (lead_id, type, direction, subject, body, outcome, duration_s, ai_generated, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [
      id, c === 0 ? 'AI Call Summary' : 'Call', 'outbound', `Call — ${outcome}`, body, outcome,
      120 + (i * 37) % 400, c === 0 ? 1 : 0, pick(OWNERS, i), ago(i % 20 + c * 3),
    ]);
  }
  if (i % 3 === 0) {
    run('INSERT INTO activities (lead_id, type, direction, subject, body, user_id, created_at) VALUES (?,?,?,?,?,?,?)', [
      id, 'WhatsApp', 'outbound', 'Brochure sent', 'Sent the product brochure on WhatsApp.', pick(OWNERS, i), ago(i % 12),
    ]);
  }
});

/* ----------------------------------------------------------------- notes */

const NOTES = [
  [0, 'Client is a long-term SIP investor. Do not pitch F&O — he has said twice he is not interested in leverage.', 1],
  [3, 'PMS discussion is with the family CA involved. Any proposal must go to the CA first.', 1],
  [5, 'Lead has an open complaint about a failed payout. Do not pitch new products until it is resolved.', 1],
  [7, 'Prefers Gujarati. Vikram usually calls this one.', 0],
  [13, 'Corpus is from a property sale. Timeline is 3–4 weeks, not immediate.', 0],
];
for (const [idx, body, pinned] of NOTES) {
  run('INSERT INTO notes (lead_id, body, pinned, user_id, created_at) VALUES (?,?,?,?,?)', [
    leadIds[idx], body, pinned, pick(OWNERS, idx), ago(idx % 10),
  ]);
}

/* ----------------------------------------------------------------- tasks */

const TASKS = [
  ['Send brokerage comparison sheet', 0, U.sales_rm, ahead(0, 3), 'High'],
  ['Call back after 11 AM as promised', 1, U.caller, ahead(0, 1), 'High'],
  ['Share PMS strategy note with the CA', 3, U.sales_rm, ahead(1), 'Normal'],
  ['Follow up on stalled KYC', 10, U.product_rm_mf, ahead(0, 2), 'High'],
  ['Send Smart Portfolios one-pager', 6, U.dealer, ago(1), 'Normal'],
  ['Confirm nominee details before eSign', 25, U.product_rm_eqd, ahead(0, 5), 'Normal'],
  ['Quarterly review call', 15, U.sales_rm2, ahead(4), 'Low'],
  ['Re-engage — no contact in 40 days', 11, U.sales_rm2, ago(2), 'Normal'],
];
for (const [title, leadIdx, assignee, due, priority] of TASKS) {
  run('INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, priority, status) VALUES (?,?,?,?,?,?,?)', [
    title, leadIds[leadIdx], assignee, U.sales_sup, due, priority, 'Open',
  ]);
}

/* --------------------------------------------------------------- tickets */

const TICKETS = [
  ['SIP debit failed for March instalment', 'Client reports the ₹5,000 SIP did not debit on the 3rd. NACH mandate may not be registered.', 'High', 'SIP Failure / NACH', 0, 'MF', 'Open', 3, U.care, false],
  ['Unable to log in to MyEtrade', 'Password reset link is not arriving. Client has tried three times.', 'Critical', 'Trading Platform Issue', 3, 'EQD', 'Open', 1, U.care, true],
  ['Payout not credited after 3 days', 'Withdrawal request raised on the 12th, still not credited.', 'Critical', 'Payout / Withdrawal', 5, null, 'Pending', 2, U.care2, true],
  ['KYC stuck at DigiLocker step', 'Applicant says the Aadhaar OTP is not arriving.', 'Medium', 'KYC Query', 10, 'MF', 'Waiting on Client', 2, U.care, false],
  ['Brokerage charged higher than plan', 'Client on the flat plan was charged percentage brokerage for two trades.', 'High', 'Brokerage & Charges', 15, 'EQD', 'Open', 1, U.care2, false],
  ['Wrong contract note emailed', 'Contract note for a different client code was sent.', 'Medium', 'Complaint', 7, null, 'Resolved', 6, U.care, false],
  ['Research call not received on WhatsApp', 'Subscriber is not receiving the daily calls.', 'Low', 'Research / Advisory', 17, 'RES', 'Open', 4, U.care2, false],
  ['Commission statement mismatch', 'Partner reports a variance in the February payout.', 'Medium', 'Partner Support', null, null, 'Open', 2, U.care, false],
];

TICKETS.forEach(([subject, description, priority, category, leadIdx, productCode, status, ageDays, assignee, breached], i) => {
  const leadId = leadIdx !== null ? leadIds[leadIdx] : null;
  const card = leadId && productCode
    ? one('SELECT id FROM product_cards WHERE lead_id = ? AND product_type_id = ?', [leadId, productIds[productCode]])
    : null;

  const result = run(
    `INSERT INTO tickets (ref, subject, description, priority, category_id, status, channel, lead_id, card_id, partner_id, assignee_id, created_by,
       ai_summary, response_due, resolution_due, first_response_at, resolved_at, breached, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [`BNZ-${String(i + 1).padStart(5, '0')}`, subject, description, priority, catIds[category], status,
      pick(['CRM', 'WhatsApp', 'Email', 'Phone', 'Chat'], i),
      leadId, card?.id ?? null, leadIdx === null ? partnerIds[0] : null, assignee, U.care,
      null,
      ahead(0, priority === 'Critical' ? -2 : 4), ahead(0, priority === 'Critical' ? -1 : 20),
      status !== 'Open' ? ago(ageDays, -2) : null,
      status === 'Resolved' ? ago(1) : null,
      breached ? 1 : 0, ago(ageDays), ago(Math.max(0, ageDays - 1))],
  );
  const tid = Number(result.lastInsertRowid);

  run("INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, created_at) VALUES (?,?,?,?,?)", [
    tid, description, 'client', null, ago(ageDays),
  ]);
  if (status !== 'Open') {
    run("INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, created_at) VALUES (?,?,?,?,?)", [
      tid, 'Thank you for reporting this. We have raised it with the operations team and will revert shortly.', 'agent', assignee, ago(ageDays, -2),
    ]);
  }
  if (status === 'Resolved') {
    run("INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, created_at) VALUES (?,?,?,?,?)", [
      tid, 'Corrected contract note has been emailed. Apologies for the error.', 'agent', assignee, ago(1),
    ]);
    run('UPDATE tickets SET csat = ? WHERE id = ?', [4, tid]);
  }
  if (leadId) {
    run('INSERT INTO activities (lead_id, type, direction, subject, body, user_id, created_at) VALUES (?,?,?,?,?,?,?)', [
      leadId, 'Ticket Event', 'system', `Ticket raised: ${subject}`, description, U.care, ago(ageDays),
    ]);
  }
});

/* Backfill the 2-line AI gist on every seeded ticket (BRD §6.2). The offline
   provider is used here so seeding never needs an API key. */
for (const t of all(`
  SELECT t.*, pt.name AS product_name, u.name AS assignee_name
  FROM tickets t
  LEFT JOIN product_cards pc ON pc.id = t.card_id
  LEFT JOIN product_types pt ON pt.id = pc.product_type_id
  LEFT JOIN users u ON u.id = t.assignee_id`)) {
  const replies = all('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at', [t.id]);
  const s = ticketSummary(t, replies);
  run('UPDATE tickets SET ai_summary = ? WHERE id = ?', [`${s.line1}
${s.line2}`, t.id]);
}

/* ---------------------------------------------------------- KYC journeys */

/** Build a journey at a given point in the flow. */
function seedJourney({ leadIdx, productCode, stopAt, status, minutesOnStep = 5 }) {
  const leadId = leadIds[leadIdx];
  const productId = productIds[productCode];
  const card = one('SELECT * FROM product_cards WHERE lead_id = ? AND product_type_id = ?', [leadId, productId]);
  const lead = one('SELECT * FROM leads WHERE id = ?', [leadId]);

  const steps = all('SELECT * FROM kyc_journey_steps WHERE product_type_id = ? ORDER BY sort_order', [productId])
    .map((s) => MASTER_STEPS.find((m) => m.code === s.step_code))
    .filter(Boolean);

  const form = {
    mobile: lead.mobile, email: lead.email, pan: lead.pan, dob: '1988-06-14',
    gender: 'Male', marital_status: 'Married', father_spouse: 'Ramesh Kumar',
    address: '402, Sunrise Apartments, Linking Road', city: lead.city, state: lead.state, pincode: '400050',
    trading_experience: '1–3 years', education: 'Graduate', occupation: 'Private Sector',
    annual_income: '₹5–10 Lakh', politically_exposed: 'No',
    segments: ['Equity Cash'], depository: 'CDSL', plan: 'Bigul Flat ₹0 Delivery',
  };

  const token = `seed-${leadIdx}-${productCode}`.toLowerCase();
  const stopIdx = steps.findIndex((s) => s.code === stopAt);
  const complete = status === 'Complete';

  const result = run(
    `INSERT INTO kyc_journeys (lead_id, card_id, product_type_id, applicant_mobile, applicant_email, resume_token, status, current_step,
       segments, form_data, started_at, completed_at, stalled_at, abandoned_at, elapsed_s, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [leadId, card?.id ?? null, productId, lead.mobile, lead.email, token, status,
      complete ? null : stopAt,
      JSON.stringify(form.segments), encryptField(JSON.stringify(form)),
      ago(0, minutesOnStep / 60 + 0.3),
      complete ? ago(0, 0.2) : null,
      status === 'Stalled' || status === 'Abandoned' ? ago(0, minutesOnStep / 60) : null,
      status === 'Abandoned' ? ago(0, 0.5) : null,
      complete ? 1080 : Math.round(minutesOnStep * 60), ago(0, 1)],
  );
  const jid = Number(result.lastInsertRowid);

  steps.forEach((s, i) => {
    const done = complete || i < stopIdx;
    const active = !complete && i === stopIdx;
    run('INSERT INTO kyc_journey_progress (journey_id, step_code, status, entered_at, completed_at, seconds_on_step, payload) VALUES (?,?,?,?,?,?,?)', [
      jid, s.code,
      done ? 'done' : active ? (status === 'Stalled' || status === 'Abandoned' ? 'stalled' : 'active') : 'pending',
      done || active ? ago(0, (steps.length - i) * 0.05) : null,
      done ? ago(0, (steps.length - i) * 0.04) : null,
      done ? 40 + i * 9 : active ? Math.round(minutesOnStep * 60) : 0,
      done ? JSON.stringify({ seeded: true }) : null,
    ]);
  });

  // The lead's KYC status is derived from this journey — nothing to stamp.
  return jid;
}

seedJourney({ leadIdx: 1, productCode: 'EQD', stopAt: 'BANK', status: 'In Progress', minutesOnStep: 2 });
seedJourney({ leadIdx: 10, productCode: 'MF', stopAt: 'AADHAAR_DIGILOCKER', status: 'Stalled', minutesOnStep: 14 });
seedJourney({ leadIdx: 25, productCode: 'DP', stopAt: 'ESIGN', status: 'Abandoned', minutesOnStep: 75 });
seedJourney({ leadIdx: 0, productCode: 'MF', stopAt: 'ESIGN', status: 'Complete' });
seedJourney({ leadIdx: 15, productCode: 'EQD', stopAt: 'ESIGN', status: 'Complete' });

/* ----------------------------------------------------------------- rules */

const RULES = [
  ['Warm → notify Product RM', 'When a card is marked Warm with Direct Contact, alert the Product RM and create a 4-hour task.',
    [{ field: 'product_card_state', product_code: 'MF', op: 'eq', value: 'WARM' },
      { field: 'contact_flag', op: 'eq', value: 'Direct Contact', join: 'AND' }],
    [{ type: 'notify', params: { role_or_user: 'product_rm', message: 'Warm MF card with direct contact flag' } },
      { type: 'task', params: { title: 'Contact lead — warm MF card', assignee: 'owner', due_in_hours: 4 } }], 1, 10],

  ['KYC escalation waterfall', 'Stalled KYC: WhatsApp now, then SMS, then RM alert. The full waterfall from BRD §7.7.',
    [{ field: 'kyc_journey_status', op: 'eq', value: 'Stalled' }],
    [{ type: 'whatsapp', params: { message: 'Hi {{name}}, your Bonanza application is one step from done. Reply HELP and we will finish it with you.' } },
      { type: 'notify', params: { role_or_user: 'product_rm', message: 'KYC stalled — assisted completion may be needed' } }], 1, 20],

  ['Cold lead re-engagement', 'Leads with no contact for 30+ days get a re-engagement message and a task.',
    [{ field: 'days_since_contact', op: 'gt', value: 30 },
      { field: 'lead_stage', op: 'ne', value: 'Won', join: 'AND' }],
    [{ type: 'whatsapp', params: { message: 'Hi {{name}}, it has been a while. Would you like an updated view on your investments?' } },
      { type: 'task', params: { title: 'Re-engagement call — lead has gone cold', assignee: 'owner', due_in_hours: 48 } }], 0, 30],

  ['Complaint freeze', 'A lead with an open ticket should not receive sales outreach — flag the owner.',
    [{ field: 'has_open_ticket', op: 'is_true', value: true }],
    [{ type: 'notify', params: { role_or_user: 'sales_rm', message: 'Open ticket on this lead — hold sales outreach until resolved' } }], 0, 5],
];

for (const [name, description, conditions, actions, enabled, priority] of RULES) {
  run('INSERT INTO rules (name, description, conditions, actions, schedule, enabled, priority) VALUES (?,?,?,?,?,?,?)', [
    name, description, JSON.stringify(conditions), JSON.stringify(actions),
    JSON.stringify({ mode: 'immediate', business_hours: true, skip_weekends: true, max_per_day: 3 }), enabled, priority,
  ]);
}

/* ----------------------------------------------------- lists & campaigns */

const listId = Number(run('INSERT INTO lead_lists (name, kind, owner_id, shared_with) VALUES (?,?,?,?)', [
  'SIP prospects — Mumbai & Pune', 'static', U.marketing, JSON.stringify(['sales_rm', 'dealer']),
]).lastInsertRowid);

for (const l of all("SELECT id FROM leads WHERE city IN ('Mumbai','Pune') AND deleted_at IS NULL")) {
  run('INSERT OR IGNORE INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [listId, l.id]);
}

const newsletterId = Number(run('INSERT INTO lead_lists (name, kind, owner_id, shared_with) VALUES (?,?,?,?)', [
  'Newsletter subscribers', 'newsletter', U.marketing, JSON.stringify(['marketing_manager']),
]).lastInsertRowid);
leadIds.filter((_, i) => i % 3 === 0).forEach((id) => run('INSERT OR IGNORE INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [newsletterId, id]));

run('INSERT INTO campaigns (name, channel, template_id, list_id, status, sent, opened, clicked, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [
  'March SIP push', 'whatsapp', templateIds['MF SIP intro'], listId, 'Sent',
  one('SELECT COUNT(*) n FROM lead_list_members WHERE list_id = ?', [listId]).n, 6, 2, U.marketing, ago(9),
]);
run('INSERT INTO campaigns (name, channel, template_id, list_id, status, created_by) VALUES (?,?,?,?,?,?)', [
  'Quarterly research digest', 'email', templateIds['Brokerage plan comparison'], newsletterId, 'Draft', U.marketing,
]);

/* -------------------------------------------------------- notifications */

run('INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)', [
  U.product_rm_mf, 'KYC stalled', 'Reyansh Jain is stuck on DigiLocker verification for 14 minutes.', '/kyc',
]);
run('INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)', [
  U.sales_rm, 'Warm card', 'Rohan Gupta marked Warm on Mutual Funds.', '/leads',
]);
run('INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)', [
  U.care, 'SLA breach', 'BNZ-00002 has breached its resolution SLA.', '/tickets',
]);

/* -------------------------------------------------------------- summary */

const count = (t) => one(`SELECT COUNT(*) n FROM ${t}`).n;
/* Last, because it fills values on clients — which are converted from leads
   further down this file and do not exist any earlier. */
seedCustomFields();

/* Validation rules, as an administrator would write them.
 *
 * Each refuses a save when its condition matches — the condition describes what
 * is wrong, not what is required. All three are real desk rules rather than
 * demonstrations of the feature: a lead cannot be marked Won without the PAN
 * that opening an account needs, a client cannot be closed while it still holds
 * a balance, and a case cannot be resolved without saying what was done. */
/* Configuration history goes with the configuration. A reseed resets settings
   to the shipped state, so the record of changes to the old ones is not
   history, it is residue — 2,876 rows of it had built up in ten days, mostly
   from end-to-end runs, and nothing was clearing it. */
db.exec('DELETE FROM config_audit');
db.exec('DELETE FROM validation_rule');
for (const [entity, name, message, condition] of [
  ['lead', 'PAN before Won',
    'A lead cannot be marked Won without a PAN — the account cannot be opened without one.',
    { all: [{ field: 'stage', op: 'eq', value: 'Won' }, { field: 'pan', op: 'is_blank' }] }],
  ['client', 'No closing a funded account',
    'This client still holds a ledger balance. Settle it before closing the account.',
    { all: [{ field: 'status', op: 'eq', value: 'Closed' }, { field: 'ledger_balance', op: 'gt', value: '0' }] }],
  ['case', 'Say what was done',
    'Add a resolution before marking this case Resolved — the next person to read it needs to know what happened.',
    { all: [{ field: 'status', op: 'eq', value: 'Resolved' }, { field: 'description', op: 'shorter_than', value: '10' }] }],
]) {
  run('INSERT INTO validation_rule (entity, name, condition, message, created_by) VALUES (?,?,?,?,?)',
    [entity, name, JSON.stringify(condition), message, U.admin ?? null]);
}

console.log(`
Seeded Bonanza CRM
  users            ${count('users')}   (password for all: bonanza)
  product types    ${count('product_types')}
  leads            ${count('leads')}
  product cards    ${count('product_cards')}  (${one("SELECT COUNT(*) n FROM product_cards WHERE state != 'INACTIVE'").n} engaged)
  activities       ${count('activities')}
  tickets          ${count('tickets')}
  partners         ${count('partners')}
  KYC journeys     ${count('kyc_journeys')}
  rules            ${count('rules')}
  tasks            ${count('tasks')}

CRM logins       superadmin@bonanza.test · admin@bonanza.test · caller@bonanza.test
                 dealer@bonanza.test · salesrm@bonanza.test · salessupervisor@bonanza.test
                 partnerrm@bonanza.test · productrm@bonanza.test · productsupervisor@bonanza.test
                 care@bonanza.test · marketing@bonanza.test
Partner portal   girish@partner.test / partner   (Associate, active)
                 lakshmi@partner.test / partner  (Remisier, active)
`);
