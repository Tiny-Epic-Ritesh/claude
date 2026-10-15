/**
 * Business policies: decisions the business makes and an administrator
 * changes in Setup, without a deploy (QA-13, QA-06).
 *
 * Each is a question the business answered in its own words, and the answer
 * can change -- "a Bonanza partner cannot refer Bigul products today, but we
 * want to be able to allow it" (Ritesh, 13 Oct 2026). A constant in the code
 * would make the next answer a release; a row here makes it a click, and the
 * configuration audit records who changed it and from what.
 *
 * Only Admins and Superadmins hold `admin.policies`. A policy nobody has set
 * reads as its default, and the screen says which ones are defaults.
 */

import { all, one, run, SALES_ORGS } from '../db.js';

const BOOK_NAME = { BONANZA: 'Bonanza', BIGUL: 'Bigul' };
const OTHER = { BONANZA: 'BIGUL', BIGUL: 'BONANZA' };

export const POLICIES = [
  {
    key: 'partner_referral_cross_book.BONANZA',
    area: 'Partners',
    label: 'Bonanza partners may refer Bigul products',
    help: 'Off: a Bonanza partner sees and refers Bonanza products only. On: Bigul products are offered too, '
      + 'labelled as Bigul, and a referral for one becomes a Bigul lead attributed to the partner.',
    type: 'bool',
    default: false,
  },
  {
    key: 'partner_referral_cross_book.BIGUL',
    area: 'Partners',
    label: 'Bigul partners may refer Bonanza products',
    help: 'Off: a Bigul partner sees and refers Bigul products only. On: Bonanza products are offered too, '
      + 'labelled as Bonanza, and a referral for one becomes a Bonanza lead attributed to the partner.',
    type: 'bool',
    default: false,
  },
  {
    /* QA-06 (Ritesh, 13 Oct): Marketing may export unmasked PII, and an Admin or
       Superadmin may hold its exports masked from here. */
    key: 'export_pii.marketing_manager',
    area: 'Exports',
    label: 'Marketing\'s exports carry personal data',
    help: 'Unmasked: a Marketing Manager may export mobile numbers, emails and PAN in the clear, as they see them on screen. '
      + 'Masked: their exported files are masked whatever they see on screen. Every unmasked export is audited.',
    type: 'choice',
    options: [{ value: 'unmasked', label: 'Unmasked' }, { value: 'masked', label: 'Masked' }],
    default: 'unmasked',
  },
  {
    /* QA-24. Off, because nothing records an account opening until the
       account-opening feed reaches the CRM, and the RM's own Won is the only
       signal there is. */
    key: 'lead_won_requires_account',
    area: 'Leads',
    label: 'A lead is marked Won only once its account is opened',
    help: 'On: nobody can set a lead to Won until it carries its UCC; an account opening sets Won by itself either way. '
      + 'Switch this on once the account-opening feed reaches the CRM. Until then RMs mark Won by hand.',
    type: 'bool',
    default: false,
  },

  /*
   * How a cross-business referral is paid (Ritesh, 14 Oct: "check the
   * standard across the industry, map it, keep it configurable").
   *
   * What the industry does, as published: an Authorised Person earns a
   * revenue share of the net brokerage on the clients mapped to them --
   * commonly 20 to 70 per cent, set in the agreement with the broker -- and
   * some brokers add an incentive per account opened; Bigul's own Ambassador
   * scheme pays both, monthly. A referral is paid by the business that earns
   * the revenue, on that business's terms; a referrer who is not an
   * Authorised Person is typically paid a fixed incentive, not a share of
   * brokerage. So the default here is the product's business's plan, and the
   * other three are the arrangements firms actually run.
   *
   * Applies only while the matching "may refer" policy above is on. The CRM
   * does not compute payouts -- they come from brokerage the back office
   * holds -- so the basis in force is recorded on each referral when it is
   * made, for the payout run and an auditor to read.
   */
  {
    key: 'referral_commission.cross_book',
    area: 'Partners',
    label: 'How a referral for the other business\'s product is paid',
    help: 'Applies when a partner refers a product of the other business (allowed by the two policies above). '
      + 'The basis in force is recorded on each referral as it is made.',
    type: 'choice',
    options: [
      { value: 'product_business_plan', label: 'Under the plan of the business whose product it is' },
      { value: 'referrer_plan', label: 'Under the referring partner\'s own plan' },
      { value: 'split', label: 'A share of the product business\'s plan (the percentage below)' },
      { value: 'incentive_only', label: 'A fixed incentive per account opened, no brokerage share (the amount below)' },
    ],
    default: 'product_business_plan',
  },
  {
    key: 'referral_commission.cross_book_split_pct',
    area: 'Partners',
    label: 'Share of the product business\'s plan, for a cross-business referral',
    help: 'Used only when referrals are paid "a share of the product business\'s plan". 50 means half of what that business would pay its own partner.',
    type: 'number', min: 1, max: 100, unit: '%',
    default: 50,
  },
  {
    key: 'referral_commission.cross_book_incentive_inr',
    area: 'Partners',
    label: 'Incentive per account opened, for a cross-business referral',
    help: 'Used only when referrals are paid "a fixed incentive per account opened". Set it before choosing that basis.',
    type: 'number', min: 0, max: 100000, unit: '₹',
    default: 0,
  },

  /*
   * How long personal data is kept (Ritesh, 14 Oct: "check the standard
   * industry practice, keep it as it suggests, keep it configurable").
   *
   *   Clients: the SEBI (Stock Brokers) Regulations, 2026 require books and
   *   records to be kept for at least eight years (regulation 16, up from
   *   five), and the PMLA five years from the end of the relationship; the
   *   longer governs. Eight is the floor, so this cannot be set lower.
   *
   *   Leads who never became clients: no regulation sets a number. The DPDP
   *   Act, 2023 says erase personal data once its purpose is served unless a
   *   law requires it kept (section 8(7)), and the DPDP Rules, 2025 put that
   *   at three years of inactivity for the classes they name. Three is the
   *   default here, for the same reason.
   */
  {
    key: 'retention.lead_years',
    area: 'Retention',
    label: 'Leads that never became clients are erased after this long without activity',
    help: 'A deleted lead with no activity for this long, and no account, can be purged from the recycle bin. '
      + 'The DPDP Act asks for erasure once the purpose is served; the DPDP Rules, 2025 use three years of inactivity.',
    type: 'number', min: 1, max: 8, unit: 'years',
    default: 3,
  },
  {
    key: 'retention.client_years',
    area: 'Retention',
    label: 'Client records are kept for at least this long after the account closes',
    help: 'SEBI (Stock Brokers) Regulations, 2026, regulation 16: books and records for at least eight years. '
      + 'It can be longer, never shorter. A lead that became a client is never purged as a lead.',
    type: 'number', min: 8, max: 20, unit: 'years',
    default: 8,
  },

  /* QA-37, "KYC journey: Admin, with Compliance". Ritesh, 14 Oct: not now,
     but configurable by an Admin or Superadmin so it can be turned on if the
     rule changes. Off: an Admin's change applies at once. */
  {
    key: 'kyc_journey.compliance_approval',
    area: 'KYC',
    label: 'A change to a KYC journey waits for Compliance to approve it',
    help: 'Off: an Admin\'s change to a product\'s KYC journey applies at once. On: it waits in Approvals until a Compliance user '
      + 'approves it. Either way it applies only to journeys started afterwards; a journey already started keeps the steps it began with.',
    type: 'bool',
    default: false,
  },

  /* SEBI, May 2026, 10.2(a). Ritesh, 15 Oct: a switch per business, off until
     an Admin or Superadmin turns it on. A nomination made at the DP or on the
     trading platform is in the CRM only once staff record it, and the platform
     is taken to remind clients itself -- on by default, the CRM would tell
     clients who have a nominee that they have none, or tell them twice. */
  {
    key: 'nomination_reminders.BONANZA',
    area: 'Nominations',
    label: 'Bonanza: remind accounts without a nominee, twice a year',
    help: 'On: once each half-year, every open Bonanza account with no nomination recorded in the CRM, opt-outs included, '
      + 'is sent an SMS and an email asking for one. Off: none is sent. Turn it on once the CRM holds the nominations made '
      + 'at the DP and on the trading platform, and nobody else is sending the same reminder.',
    type: 'bool',
    default: false,
  },
  {
    key: 'nomination_reminders.BIGUL',
    area: 'Nominations',
    label: 'Bigul: remind accounts without a nominee, twice a year',
    help: 'On: once each half-year, every open Bigul account with no nomination recorded in the CRM, opt-outs included, '
      + 'is sent an SMS and an email asking for one. Off: none is sent. Turn it on once the CRM holds the nominations made '
      + 'at the DP and on the trading platform, and nobody else is sending the same reminder.',
    type: 'bool',
    default: false,
  },
];

export const policyDef = (key) => POLICIES.find((p) => p.key === key) ?? null;

/**
 * The business a policy belongs to, or null when it applies to both (OPS-43).
 *
 * A per-business switch carries its business in its key. Ritesh, 15 Oct: an
 * Admin changes only their own business's switches; a policy that applies to
 * both businesses is changed by a Superadmin, so a change made in one
 * business cannot silently apply to the other.
 */
export function policyBook(key) {
  const suffix = String(key).split('.').pop();
  return SALES_ORGS.includes(suffix) ? suffix : null;
}

/** The value in force: what an administrator set, or the default. */
export function policy(key) {
  const def = policyDef(key);
  if (!def) throw new Error(`policy: no policy "${key}"`);
  const row = one('SELECT value FROM business_policy WHERE key = ?', [key]);
  if (!row) return def.default;
  try { return JSON.parse(row.value); } catch { return def.default; }
}

/** Why a value is not one this policy accepts, or null. */
export function policyRefusal(key, value) {
  const def = policyDef(key);
  if (!def) return `There is no policy called ${key}`;
  if (def.type === 'bool' && typeof value !== 'boolean') return `${def.label}: choose on or off`;
  if (def.type === 'choice' && !def.options.some((o) => o.value === value)) {
    return `${def.label}: choose one of ${def.options.map((o) => o.label).join(', ')}`;
  }
  if (def.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${def.label}: give a number`;
    if (value < def.min || value > def.max) return `${def.label}: between ${def.min} and ${def.max}${def.unit ? ` ${def.unit}` : ''}`;
  }
  return null;
}

export function setPolicy(key, value, actorId) {
  const refusal = policyRefusal(key, value);
  if (refusal) return { error: refusal };
  const before = policy(key);
  run(
    `INSERT INTO business_policy (key, value, updated_by, updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), actorId],
  );
  /* The configuration audit, written here rather than through metadata.js so
     auth.js can read a policy without an import cycle. */
  run(
    'INSERT INTO config_audit (area, target, action, before_json, after_json, actor_id) VALUES (?,?,?,?,?,?)',
    ['policy', key, 'update', JSON.stringify({ value: before }), JSON.stringify({ value }), actorId],
  );
  return { key, value };
}

/** Every policy, with what is in force and who last changed it. */
export function listPolicies() {
  const set = new Map(all(
    `SELECT b.key, b.value, b.updated_at, u.name AS updated_by_name
       FROM business_policy b LEFT JOIN users u ON u.id = b.updated_by`,
  ).map((r) => [r.key, r]));
  return POLICIES.map((def) => ({
    ...def,
    book: policyBook(def.key),
    value: policy(def.key),
    is_default: !set.has(def.key),
    updated_at: set.get(def.key)?.updated_at ?? null,
    updated_by_name: set.get(def.key)?.updated_by_name ?? null,
  }));
}

/* ------------------------------------------------------------ QA-13 */

/**
 * The businesses whose products a partner of this business may refer: always
 * their own, and the other one only while the policy for their book says so.
 */
export function referrableBooks(org) {
  const books = [org];
  if (OTHER[org] && policy(`partner_referral_cross_book.${org}`)) books.push(OTHER[org]);
  return books;
}

export const bookName = (org) => BOOK_NAME[org] ?? org;

/**
 * The commission basis a referral is made under, as it stands right now.
 *
 * Recorded on the lead when a partner refers the other business's product,
 * so a later change to the policy does not rewrite what earlier referrals
 * were promised. A referral within the partner's own business is paid under
 * the partner's own plan and records nothing.
 */
export function referralCommissionBasis(partnerOrg, productOrg) {
  if (!productOrg || productOrg === partnerOrg) return null;
  const basis = policy('referral_commission.cross_book');
  const label = policyDef('referral_commission.cross_book').options.find((o) => o.value === basis)?.label ?? basis;
  return {
    basis,
    label,
    referrer_business: partnerOrg,
    product_business: productOrg,
    ...(basis === 'split' ? { split_pct: policy('referral_commission.cross_book_split_pct') } : {}),
    ...(basis === 'incentive_only' ? { incentive_inr: policy('referral_commission.cross_book_incentive_inr') } : {}),
    decided_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
}

/* ------------------------------------------------------------ QA-24 */

/**
 * Why these leads may not be set to Won, or null.
 *
 * Won means the account was opened. While the policy is on, a lead without its
 * UCC cannot be Won by anybody's hand; a bulk change carrying any such lead is
 * refused whole, naming how many, as a refused value is.
 */
export function wonRefusal(stage, leadIds) {
  if (stage !== 'Won' || !policy('lead_won_requires_account') || !leadIds.length) return null;
  const without = one(
    `SELECT COUNT(*) n FROM leads WHERE id IN (${leadIds.map(() => '?').join(',')})
       AND (client_code IS NULL OR TRIM(client_code) = '')`,
    leadIds,
  ).n;
  if (!without) return null;
  return without === 1 && leadIds.length === 1
    ? 'This lead has no account yet. A lead is Won when its account is opened, which records its UCC.'
    : `${without} of these leads have no account yet. A lead is Won when its account is opened, which records its UCC.`;
}

/* ------------------------------------------------------------ QA-06 */

/**
 * Why this role's export may not carry identifiers in the clear, or null.
 *
 * Asked by every export after its own unmask check: holding `pii.unmask` is
 * still required, and a policy can only take the clear export away.
 */
export function exportHeldMasked(role) {
  const key = `export_pii.${role}`;
  if (!policyDef(key) || policy(key) !== 'masked') return null;
  return 'Exports for your role are masked by a business policy (Setup → Business policies)';
}
